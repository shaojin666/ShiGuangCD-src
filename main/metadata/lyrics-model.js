'use strict';
/*
 * lyrics-model.js —— 统一歌词模型与多源解析器（逐字歌词第一棒）。
 *
 * ============ 为什么要有这一层 ============
 * 各音乐平台的歌词格式互不兼容：
 *   - AMLL TTML DB   ：TTML XML，词级 <span>，带 ttm:agent（对唱）、x-translation / x-roman、x-bg（背景人声）
 *   - 网易云 yrc     ：[行起,行长](词起,词长,0)文本，绝对毫秒；另带 tlyric / romalrc 译文
 *   - QQ QRC         ：[行起,行长](词起,词长)文本，绝对毫秒；另带 trans / roma
 *   - 酷狗 KRC       ：[行起,行长]<词内偏移,词长>文本，**相对毫秒**；翻译内嵌 [language:base64]
 *   - 普通 LRC       ：[mm:ss.xx]文本，行级
 * 渲染端（nowplaying / 桌面悬浮窗）不该关心这些差异。本模块把五种格式
 * 归一化成同一个结构（见 MODEL 注释），并统一做后处理：
 * 间奏插入、对唱折叠、质量打分、降级为经典 LRC。
 *
 * ============ 模型 ============
 * {
 *   v: 1,
 *   source: 'amll'|'netease'|'qq'|'kugou'|'lrclib'|'manual',
 *   isWordByWord: bool,
 *   agents: { [id]: {id, name, type} },        // 对唱角色表
 *   lines: [{
 *     t, e,                    // 起止秒
 *     text,                    // 主行文本
 *     tr,                      // 可选：翻译
 *     ro,                      // 可选：罗马音
 *     agent,                   // 可选：对唱角色 id
 *     part,                    // 可选：'chorus' 等
 *     words: [{t,e,x}],        // 词级（逐字）
 *     bg: [{t,e,text,words,tr}],  // 可选：背景人声/和声
 *     instrumental: true       // 可选：间奏占位行
 *   }],
 *   quality: number            // 质量分
 * }
 *
 * 时间单位统一为**秒**（浮点）。各源毫秒在解析入口即除以 1000。
 */

/** 相邻行空隙超过该值 → 插入间奏行（秒） */
const INSTRUMENTAL_GAP_SEC = 8;
/** 单行最多保留的词数（防脏数据） */
const MAX_WORDS_PER_LINE = 400;
/** 最多保留的行数 */
const MAX_LINES = 800;

/* ================================================================
 * 公共小工具
 * ================================================================ */

function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/\r/g, '')
    .replace(/\u0000/g, '')
    .trim();
}

function attr(tag, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(tag);
  return m ? m[1] : null;
}

/** TTML 时间表达式 → 秒。支持 mm:ss.xxx / hh:mm:ss.xxx / 1.5s / 300ms / 12f / 10t */
function parseTtmlTime(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (clock) {
    const h = clock[1] ? parseInt(clock[1], 10) : 0;
    return h * 3600 + parseInt(clock[2], 10) * 60 + parseFloat(clock[3]);
  }
  const off = /^(-?\d+(?:\.\d+)?)(ms|s|f|t)$/.exec(s);
  if (off) {
    const n = parseFloat(off[1]);
    if (off[2] === 'ms') return n / 1000;
    if (off[2] === 's') return n;
    if (off[2] === 'f') return n / 25;      // 25fps 近似（CD 时代帧率）
    if (off[2] === 't') return n / 1000;    // tick 约定
  }
  const num = parseFloat(s);
  return isFinite(num) ? num : null;
}

/** LRC 时间标签 [mm:ss.xx] → 秒；返回 null 表示不是时间标签 */
function parseLrcTimeTag(min, sec, frac) {
  const m = parseInt(min, 10);
  const s = parseInt(sec, 10);
  if (!isFinite(m) || !isFinite(s) || s >= 60) return null;
  let f = 0;
  if (frac) {
    const digits = String(frac);
    f = parseInt(digits, 10) / Math.pow(10, digits.length);
  }
  return m * 60 + s + f;
}

const LRC_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * 解析一行（可能带多个时间标签）LRC。
 * @returns {{times:number[], text:string}}
 */
function parseLrcLine(raw, offsetSec) {
  const line = String(raw == null ? '' : raw);
  const times = [];
  let m;
  LRC_TAG_RE.lastIndex = 0;
  while ((m = LRC_TAG_RE.exec(line))) {
    const t = parseLrcTimeTag(m[1], m[2], m[3]);
    if (t != null) times.push(Math.max(0, t - offsetSec));
  }
  // 去掉所有时间标签后的正文（元数据标签 [ti:] [ar:] 等只剩方括号内容为空的行）
  let text = line.replace(LRC_TAG_RE, '');
  text = text.replace(/\[[a-zA-Z]+:[^\]]*\]/g, '');
  return { times, text: cleanText(text) };
}

/** 从 LRC 全文中提取 [offset:ms]（正数表示歌词整体后移，需从各时间减去） */
function lrcOffsetSec(text) {
  const m = /\[offset:\s*(-?\d+)\s*\]/i.exec(String(text || ''));
  return m ? parseInt(m[1], 10) / 1000 : 0;
}

/**
 * 把"另一份 LRC"（译文/罗马音轨）挂到主歌词行上。
 * 译文与主歌词通常行行对应：先按下标挂接（时间差 < 2.5s 才认），
 * 剩余行按"最近且时间接近"挂接。只填补空缺，不覆盖已有值。
 * @param {Array} mainLines 主歌词行（就地修改，写入 field 指定的字段）
 * @param {string} trackText 译文 LRC 全文
 * @param {'tr'|'ro'} field
 */
function attachLrcTrack(mainLines, trackText, field) {
  if (!trackText || !mainLines.length) return;
  const offsetSec = lrcOffsetSec(trackText);
  const entries = [];
  for (const raw of String(trackText).split(/\r?\n/)) {
    const { times, text } = parseLrcLine(raw, offsetSec);
    if (!times.length || !text) continue;
    for (const t of times) entries.push({ t, text });
  }
  entries.sort((a, b) => a.t - b.t);
  if (!entries.length) return;
  const n = Math.min(entries.length, mainLines.length);
  for (let i = 0; i < n; i++) {
    if (mainLines[i][field]) continue;
    if (Math.abs(entries[i].t - mainLines[i].t) < 2.5) mainLines[i][field] = entries[i].text;
  }
  // 下标没挂上的（译文行数少于主歌词）：按时间就近补
  let ei = 0;
  for (const line of mainLines) {
    if (line[field] || line.instrumental) continue;
    while (ei < entries.length && entries[ei].t < line.t - 1.5) ei++;
    if (ei < entries.length && Math.abs(entries[ei].t - line.t) <= 1.5) {
      line[field] = entries[ei].text;
      ei++;
    }
  }
}

/* ================================================================
 * 解析器 1：TTML（AMLL DB / Apple Music 风格）
 * ================================================================ */

/** 从 <head><metadata> 里提取 ttm:agent 表（对唱角色） */
function parseTtmlAgents(xml) {
  const agents = {};
  const head = /<metadata[\s\S]*?<\/metadata>/.exec(xml);
  if (!head) return agents;
  const re = /<ttm:agent\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(head[0]))) {
    const id = attr(m[1], 'xml:id');
    const type = attr(m[1], 'type');
    if (id) agents[id] = { id, name: '', type: type || '' };
  }
  return agents;
}

/** 拆出 body 内所有 <p>…</p>（TTML 歌词不会出现嵌套 <p>） */
function splitTtmlPElements(body) {
  const out = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>|<p\b([^>]*)\/>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[2] != null) out.push({ attrs: m[1], inner: m[2] });
    else out.push({ attrs: m[3], inner: '' });
  }
  return out;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '');
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/**
 * 从 openIdx（'<' 字符处）起，为 <span …> 找配对的 </span>，支持一层以上嵌套。
 * @returns {{contentStart:number, contentEnd:number, afterEnd:number}|null}
 */
function matchNestedSpan(s, openIdx) {
  const openEnd = s.indexOf('>', openIdx);
  if (openEnd < 0) return null;
  if (s[openEnd - 1] === '/') {
    // 自闭合标签：无内容
    return { contentStart: openEnd + 1, contentEnd: openEnd + 1, afterEnd: openEnd + 1 };
  }
  let depth = 1;
  const re = /<span\b[^>]*>|<\/span>/g;
  re.lastIndex = openEnd + 1;
  let m;
  while ((m = re.exec(s))) {
    if (m[0] === '</span>') {
      depth--;
      if (depth === 0) return { contentStart: openEnd + 1, contentEnd: m.index, afterEnd: m.index + 7 };
    } else if (!m[0].endsWith('/>')) {
      depth++;
    }
  }
  return null; // 未闭合
}

/** 把一个 <p> 的内容拆成 词级 span / 翻译 / 罗马音 / 背景人声 */
function parseTtmlP(inner) {
  const words = [];
  const bg = [];
  let translation = '';
  let romanization = '';
  let i = 0;
  while (i < inner.length) {
    const lt = inner.indexOf('<', i);
    if (lt < 0) break;
    if (!/^<span[\s/>]/.test(inner.slice(lt, lt + 6))) { i = lt + 1; continue; }
    const matched = matchNestedSpan(inner, lt);
    if (!matched) { i = lt + 1; continue; }
    const gt = inner.indexOf('>', lt);
    let attrs = inner.slice(lt + 5, gt);
    if (attrs.endsWith('/')) attrs = attrs.slice(0, -1);
    const content = inner.slice(matched.contentStart, matched.contentEnd);
    const role = attr(attrs, 'ttm:role') || '';
    const begin = parseTtmlTime(attr(attrs, 'begin'));
    const end = parseTtmlTime(attr(attrs, 'end'));
    if (role === 'x-translation') {
      const txt = cleanText(decodeXmlEntities(stripTags(content)));
      if (txt && !translation) translation = txt;
    } else if (role === 'x-roman') {
      const txt = cleanText(decodeXmlEntities(stripTags(content)));
      if (txt && !romanization) romanization = txt;
    } else if (role === 'x-bg') {
      // 背景人声：内容本身是一串词级子 span（matchNestedSpan 保证拿到完整嵌套）。
      // 子 span 里还可能嵌 x-translation / x-roman（背景人声自己的译/音），需分离。
      const bgWords = [];
      const sub = /<span\b([^>]*)>([\s\S]*?)<\/span>/g;
      let sm;
      let bgText = '';
      let bgTr = '';
      let bgRo = '';
      while ((sm = sub.exec(content))) {
        const sRole = attr(sm[1], 'ttm:role') || '';
        const txt = cleanText(decodeXmlEntities(stripTags(sm[2])));
        if (!txt) continue;
        if (sRole === 'x-translation') { if (!bgTr) bgTr = txt; continue; }
        if (sRole === 'x-roman') { if (!bgRo) bgRo = txt; continue; }
        const sb = parseTtmlTime(attr(sm[1], 'begin'));
        const se = parseTtmlTime(attr(sm[1], 'end'));
        bgText += txt;
        bgWords.push({ t: sb, e: se, x: txt });
      }
      if (!bgWords.length) {
        const txt = cleanText(decodeXmlEntities(stripTags(content)));
        if (txt) {
          bgText = txt;
          bgWords.push({ t: begin, e: end, x: txt });
        }
      }
      if (bgText) {
        const bgEntry = { t: begin, e: end, text: bgText, words: bgWords };
        if (bgTr) bgEntry.tr = bgTr;
        if (bgRo) bgEntry.ro = bgRo;
        bg.push(bgEntry);
      }
    } else {
      // 主词级 span（内容可能嵌 ruby 子 span，stripTags 已处理）
      const txt = cleanText(decodeXmlEntities(stripTags(content)));
      if (!txt) { i = matched.afterEnd; continue; }
      words.push({ t: begin, e: end, x: txt });
    }
    i = matched.afterEnd;
  }
  return { words, bg, translation, romanization };
}

/**
 * 解析 TTML（AMLL DB / Apple Music 风格）。
 * @param {string} xml
 * @returns {object|null} 未做后处理的模型
 */
function parseTTML(xml) {
  const text = String(xml || '').replace(/^\uFEFF/, '');
  if (!/<tt[\s>]/.test(text)) return null;
  const bodyM = /<body[^>]*>([\s\S]*)<\/body>/.exec(text);
  if (!bodyM) return null;
  const agents = parseTtmlAgents(text);
  const ps = splitTtmlPElements(bodyM[1]);
  if (!ps.length) return null;

  const lines = [];
  for (const p of ps) {
    const begin = parseTtmlTime(attr(p.attrs, 'begin'));
    const end = parseTtmlTime(attr(p.attrs, 'end'));
    const agent = attr(p.attrs, 'ttm:agent');
    const part = attr(p.attrs, 'songPart') || attr(p.attrs, 'ttm:role');
    const parsed = parseTtmlP(p.inner);
    if (!parsed.words.length && !parsed.bg.length) continue;
    const lineText = parsed.words.map((w) => w.x).join('');
    if (!lineText && !parsed.bg.length) continue;
    lines.push({
      t: begin != null ? begin : (parsed.words[0] ? parsed.words[0].t : 0),
      e: end != null ? end : (parsed.words.length ? parsed.words[parsed.words.length - 1].e : (begin != null ? begin : 0)),
      text: lineText,
      tr: parsed.translation || undefined,
      ro: parsed.romanization || undefined,
      agent: agent || undefined,
      part: part ? String(part).toLowerCase() : undefined,
      words: parsed.words.slice(0, MAX_WORDS_PER_LINE),
      bg: parsed.bg.length ? parsed.bg : undefined
    });
  }
  if (!lines.length) return null;
  return { v: 1, source: 'amll', isWordByWord: true, agents, lines };
}

/**
 * TTML 对唱折叠：时间重叠的不同 agent 行 → 折进主行的 bg（背景人声）。
 * 参考 folia ttmlConversion.ts 的 foldAgentOverlapHarmonyLines：
 * 主行仍保持"一条主线"，渲染端不会看到两条同时进行的主行。
 *
 * ★ v10.7：对唱行**自带的 x-bg**（背景人声套背景人声）随行平铺进宿主，
 *   每条盖上宿主的 agent —— 渲染端据此把"对唱的 bg"与"主唱的 bg"
 *   分到左右两侧（amll 排版：背景声跟随所属行）。
 *   平铺（而非嵌套 bg.bg）是为了兼容 schema 白名单：嵌套结构过不了
 *   lyricsDataModel 的收敛，落盘即丢。
 */
function foldDuetLines(lines) {
  const out = [];
  for (const line of lines) {
    if (!line.agent) { out.push(line); continue; }
    let host = null;
    for (let i = out.length - 1; i >= 0; i--) {
      const c = out[i];
      if (!c.agent || c.agent === line.agent) continue;
      if (line.t < c.e && line.e > c.t) { host = c; break; }
    }
    if (!host) { out.push(line); continue; }
    if (!host.bg) host.bg = [];
    host.bg.push({
      t: line.t, e: line.e, text: line.text,
      words: line.words, tr: line.tr, agent: line.agent
    });
    // 对唱行自己的背景人声：紧随其后平铺，同 agent（跟随对唱一侧）
    if (Array.isArray(line.bg)) {
      for (const sub of line.bg) {
        if (!sub || !sub.text) continue;
        host.bg.push({
          t: sub.t, e: sub.e, text: sub.text,
          words: sub.words, tr: sub.tr, agent: line.agent
        });
      }
    }
  }
  return out;
}

/**
 * 歌曲级对唱分析（v10.7，amll 排版用）。
 * 判据（覆盖两种对唱形态）：
 *   1) 折叠对唱：主行 bg 里出现带 agent 的条目（时间重叠的双声部）；
 *   2) 交替对唱：≥2 个不同 agent 的主行（不重叠，各自成行）。
 * 主 agent = 主行中出现频次最高的 agent（主唱）；其余为对唱侧。
 * @param {object} model finalizeModel 产物（或任意同构模型）
 * @returns {{hasDuet:boolean, mainAgent:string}}
 */
function analyzeDuet(model) {
  const empty = { hasDuet: false, mainAgent: '' };
  if (!model || !Array.isArray(model.lines) || !model.lines.length) return empty;
  const lineCount = {}; // 仅主线 agent 频次（决定谁是主唱）
  const bgCount = {};   // bg 条目 agent 频次（退化兜底用）
  let hasAgentBg = false;
  for (const l of model.lines) {
    if (!l) continue;
    if (Array.isArray(l.bg)) {
      for (const b of l.bg) {
        if (b && b.agent) { hasAgentBg = true; bgCount[b.agent] = (bgCount[b.agent] || 0) + 1; }
      }
    }
    if (l.agent) lineCount[l.agent] = (lineCount[l.agent] || 0) + 1;
  }
  const lineIds = Object.keys(lineCount);
  if (!hasAgentBg && lineIds.length < 2) return empty;
  // 主 agent 只按主线频次取；折叠对唱下对唱方主线已并入宿主 bg，
  // 若把 bg 也计入频次会把对唱方误判成主唱（宿主行反而靠左），方向颠倒。
  let pool = lineCount;
  if (!lineIds.length) pool = bgCount; // 极端：主线无 agent，退化到 bg 频次
  let mainAgent = '';
  let best = -1;
  for (const id of Object.keys(pool)) {
    if (pool[id] > best) { best = pool[id]; mainAgent = id; }
  }
  return { hasDuet: true, mainAgent: mainAgent };
}

/* ================================================================
 * 解析器 2：网易云 yrc（混合格式：JSON 元数据行 + 经典 yrc 文本行）
 * ================================================================ */

const YRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/;
const YRC_WORD_RE = /\((\d+),(\d+)(?:,\d+)?\)([^\(]*)/g;

/**
 * yrc 一行：`[行起ms,行长ms](词起ms,词长ms[,0])文本…`，词时间为**绝对毫秒**。
 * 文件头部可能有 `{"t":-1000,"c":[{"tx":"作词: "},…]}` 形式的制作信息行（JSON），
 * 没有逐字时间，直接跳过（与 folia neteaseProcessing 的处理一致）。
 */
function parseNeteaseYrc(yrcText, opts = {}) {
  const text = String(yrcText || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return null;
  const lines = [];
  let isSorted = true;
  let lastT = -Infinity;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const lm = YRC_LINE_RE.exec(line);
    if (!lm) continue;   // JSON 元数据行 / 杂音行
    const lineStart = parseInt(lm[1], 10) / 1000;
    const lineEnd = (parseInt(lm[1], 10) + parseInt(lm[2], 10)) / 1000;
    const words = [];
    let fullText = '';
    let wm;
    YRC_WORD_RE.lastIndex = 0;
    while ((wm = YRC_WORD_RE.exec(lm[3]))) {
      const ws = parseInt(wm[1], 10) / 1000;
      const wd = parseInt(wm[2], 10) / 1000;
      const wx = cleanText(wm[3]);
      if (!wx) continue;
      words.push({ t: ws, e: ws + wd, x: wx });
      fullText += wx;
    }
    if (!words.length) continue;
    if (lineStart < lastT - 0.001) isSorted = false;
    lastT = lineStart;
    lines.push({ t: lineStart, e: lineEnd, text: fullText, words: words.slice(0, MAX_WORDS_PER_LINE) });
  }
  if (!lines.length) return null;
  if (!isSorted) lines.sort((a, b) => a.t - b.t);
  attachLrcTrack(lines, opts.translation, 'tr');
  attachLrcTrack(lines, opts.romanization, 'ro');
  return { v: 1, source: 'netease', isWordByWord: true, lines };
}

/* ================================================================
 * 解析器 3：QQ QRC
 * ================================================================ */

const QRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/;
const QRC_TAG_RE = /\((\d+),(\d+)(?:,\d+)?\)/g;

/**
 * QRC 一行：`[行起ms,行长ms](词起ms,词长ms)文本…`，词时间绝对毫秒，**文本在标签之后**。
 * 与 yrc 的区别：yrc 一个 tag 后只跟一个词的文本；QRC 需要把
 * "标签之间的文本块"分配给 tag。采用 folia parseQRC 的**全局偏好**策略：
 * 先根据首/尾文本块判断整行是 leading 型还是 trailing 型，再统一分配，
 * 避免同一块文本被相邻两个 tag 同时认领造成重复拼接。
 */
function parseQrc(qrcText, opts = {}) {
  const text = String(qrcText || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return null;
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const lm = QRC_LINE_RE.exec(raw);
    if (!lm) continue;
    const lineStart = parseInt(lm[1], 10) / 1000;
    const lineEnd = (parseInt(lm[1], 10) + parseInt(lm[2], 10)) / 1000;
    const rest = lm[3];
    const tags = [];
    let tm;
    QRC_TAG_RE.lastIndex = 0;
    while ((tm = QRC_TAG_RE.exec(rest))) {
      tags.push({
        t: parseInt(tm[1], 10) / 1000,
        d: parseInt(tm[2], 10) / 1000,
        start: tm.index,
        end: tm.index + tm[0].length
      });
    }
    if (!tags.length) continue;
    // 切出每个 tag 前后的文本块
    const chunks = [];
    let cursor = 0;
    for (const tag of tags) {
      chunks.push(rest.slice(cursor, tag.start));
      cursor = tag.end;
    }
    chunks.push(rest.slice(cursor));
    // 全局偏好（folia parseQRC）：首块有文本且尾块空 → 所有词取 leading；
    // 首块空且尾块有文本 → 所有词取 trailing；否则逐词启发式。
    // 这解决了「同一块文本被相邻两个 tag 同时认领」导致的重复拼接。
    const prefersLeading = chunks[0].trim() && !chunks[chunks.length - 1].trim();
    const prefersTrailing = !chunks[0].trim() && chunks[chunks.length - 1].trim();
    const words = [];
    let fullText = '';
    for (let i = 0; i < tags.length; i++) {
      const leading = chunks[i] != null ? chunks[i] : '';
      const trailing = chunks[i + 1] != null ? chunks[i + 1] : '';
      let wx = '';
      if (prefersLeading) wx = leading;
      else if (prefersTrailing) wx = trailing;
      else if (trailing.trim() && !leading.trim()) wx = trailing;
      else if (leading.trim() && !trailing.trim()) wx = leading;
      else wx = trailing.length >= leading.length ? trailing : leading;
      wx = cleanText(wx);
      if (!wx) continue;
      words.push({ t: tags[i].t, e: tags[i].t + tags[i].d, x: wx });
      fullText += wx;
    }
    if (!words.length) continue;
    lines.push({ t: lineStart, e: lineEnd, text: fullText, words: words.slice(0, MAX_WORDS_PER_LINE) });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.t - b.t);
  attachLrcTrack(lines, opts.translation, 'tr');
  attachLrcTrack(lines, opts.romanization, 'ro');
  return { v: 1, source: 'qq', isWordByWord: true, lines };
}

/* ================================================================
 * 解析器 4：酷狗 KRC
 * ================================================================ */

const KRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/;
const KRC_WORD_RE = /<(\d+),(\d+)(?:,\d+)?>([^<]*)/g;

/** KRC 解密：去 'krc1' 头 → XOR 16 字节 key → zlib inflate */
function krcDecrypt(base64Content) {
  const zlib = require('zlib');
  const raw = Buffer.from(String(base64Content || ''), 'base64');
  if (raw.length <= 4) throw new Error('KRC 数据过短');
  const key = Buffer.from([64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]);
  const out = Buffer.allocUnsafe(raw.length - 4);
  for (let i = 4; i < raw.length; i++) out[i - 4] = raw[i] ^ key[(i - 4) % 16];
  return zlib.inflateSync(out).toString('utf8');
}

/** 解码 KRC 内嵌 [language:base64] 语言轨。type 0 = 罗马音，type 1 = 翻译 */
function decodeKrcLanguage(krcText) {
  const m = /\[language:([^\]]*)\]/.exec(krcText);
  if (!m) return { ro: null, tr: null };
  try {
    let b64 = m[1].trim();
    while (b64.length % 4 !== 0) b64 += '=';
    const obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const readTrack = (type) => {
      const tr = obj && Array.isArray(obj.content) && obj.content.find((c) => c && c.type === type);
      if (!tr || !Array.isArray(tr.lyricContent)) return null;
      return tr.lyricContent.map((l) => (Array.isArray(l) ? l.join('') : String(l || '')).trim());
    };
    return { ro: readTrack(0), tr: readTrack(1) };
  } catch (e) {
    return { ro: null, tr: null };
  }
}

/**
 * KRC 一行：`[行起ms,行长ms]<词内偏移ms,词长ms>文本…`。
 * ★ 词时间为**行起点的相对偏移**（与 yrc/QRC 的绝对毫秒相反，实测踩坑点）。
 */
function parseKrc(krcText, opts = {}) {
  const text = String(krcText || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return null;
  const embedded = decodeKrcLanguage(text);

  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const lm = KRC_LINE_RE.exec(raw);
    if (!lm) continue;
    const lineStartMs = parseInt(lm[1], 10);
    const lineStart = lineStartMs / 1000;
    const lineEnd = (lineStartMs + parseInt(lm[2], 10)) / 1000;
    const words = [];
    let fullText = '';
    let wm;
    KRC_WORD_RE.lastIndex = 0;
    while ((wm = KRC_WORD_RE.exec(lm[3]))) {
      const ws = (lineStartMs + parseInt(wm[1], 10)) / 1000;   // ★ 相对 → 绝对
      const wd = parseInt(wm[2], 10) / 1000;
      const wx = cleanText(wm[3]);
      if (!wx) continue;
      words.push({ t: ws, e: ws + wd, x: wx });
      fullText += wx;
    }
    if (!words.length) {
      const plain = cleanText(lm[3].replace(/<[^>]*>/g, ''));
      if (!plain) continue;
      lines.push({ t: lineStart, e: lineEnd, text: plain, words: [] });
      continue;
    }
    lines.push({ t: lineStart, e: lineEnd, text: fullText, words: words.slice(0, MAX_WORDS_PER_LINE) });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.t - b.t);

  // 内嵌轨与主歌词行一一对应（下标挂接）；外部译文轨按 LRC 时间挂接
  if (embedded.tr) {
    for (let i = 0; i < lines.length && i < embedded.tr.length; i++) {
      if (embedded.tr[i] && !lines[i].tr) lines[i].tr = embedded.tr[i];
    }
  }
  if (embedded.ro) {
    for (let i = 0; i < lines.length && i < embedded.ro.length; i++) {
      if (embedded.ro[i] && !lines[i].ro) lines[i].ro = embedded.ro[i];
    }
  }
  attachLrcTrack(lines, opts.translation, 'tr');
  attachLrcTrack(lines, opts.romanization, 'ro');
  return { v: 1, source: 'kugou', isWordByWord: true, lines };
}

/* ================================================================
 * 解析器 5：普通 LRC（行级；网易云/LRCLIB 兜底）
 * ================================================================ */

function parseLrcText(lrcText, opts = {}) {
  const text = String(lrcText || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return null;
  const offsetSec = lrcOffsetSec(text);
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const { times, text: body } = parseLrcLine(raw, offsetSec);
    if (!times.length || !body) continue;
    for (const t of times) entries.push({ t, text: body });
  }
  if (!entries.length) return null;
  entries.sort((a, b) => a.t - b.t);
  const lines = [];
  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i];
    const next = entries[i + 1];
    let dur = next ? next.t - cur.t : 5;
    const reading = cur.text.length * 0.5;
    if (dur > reading + 2 && dur > 5) dur = Math.min(dur, reading + 2);
    lines.push({ t: cur.t, e: cur.t + Math.max(dur, 0.5), text: cur.text, words: [] });
  }
  const model = { v: 1, source: opts.source || 'lrclib', isWordByWord: false, lines };
  attachLrcTrack(lines, opts.translation, 'tr');
  return model;
}

/* ================================================================
 * 后处理：间奏插入 / 质量分 / 降级
 * ================================================================ */

/**
 * 在相邻行的大空隙里插入间奏行（text 用 ♪ 占位）。
 * 各歌词源都没有显式间奏标记，靠空隙推断是最可靠的通用方案。
 */
function insertInstrumentals(model, gapSec = INSTRUMENTAL_GAP_SEC) {
  if (!model || !model.lines || !model.lines.length) return model;
  const out = [];
  const lines = model.lines;
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    out.push(cur);
    const next = lines[i + 1];
    if (!next) continue;
    const gap = next.t - Math.max(cur.t, cur.e);
    if (gap >= gapSec) {
      const from = Math.max(cur.t, cur.e) + 0.001;
      out.push({
        t: from,
        e: Math.max(next.t - 0.001, from + 0.002),
        text: '♪',
        instrumental: true,
        words: []
      });
    }
  }
  model.lines = out.slice(0, MAX_LINES);
  return model;
}

/** 质量分：词级 100 基，翻译 +10、罗马音 +5、对唱 +5、背景人声 +5、行数微调 */
function scoreLyrics(model) {
  if (!model || !model.lines || !model.lines.length) return 0;
  let s = model.isWordByWord ? 100 : 0;
  if (model.lines.some((l) => l.tr)) s += 10;
  if (model.lines.some((l) => l.ro)) s += 5;
  if (model.agents && Object.keys(model.agents).length > 1) s += 5;
  if (model.lines.some((l) => l.bg && l.bg.length)) s += 5;
  s += Math.min(model.lines.length, 60) * 0.1;
  model.quality = Math.round(s * 10) / 10;
  return model.quality;
}

/** 统一入口：解析 → 后处理 → 打分。调用方拿到的就是可缓存/可渲染的成品。 */
function finalizeModel(model, opts = {}) {
  if (!model) return null;
  if (!model.lines.length) return null;
  if (opts.foldDuet !== false) model.lines = foldDuetLines(model.lines);
  insertInstrumentals(model, opts.gapSec);
  scoreLyrics(model);
  return model;
}

/** 模型 → 经典 LRC 文本（词级信息丢弃；供旧渲染、导出、无逐字界面兜底）。
 *  对唱 bg 行按自身时间戳作为独立行输出（经典 LRC 无嵌套，这是唯一保真方式）。 */
function toLrc(model) {
  if (!model || !model.lines) return '';
  const out = [];
  for (const l of model.lines) {
    if (l.instrumental) continue;
    const tag = '[' + fmtLrcTime(l.t) + ']';
    out.push(tag + l.text);
    if (l.tr) out.push(tag + l.tr);
    if (l.bg && l.bg.length) {
      for (const b of l.bg) {
        if (!b.text) continue;
        const btag = '[' + fmtLrcTime(b.t) + ']';
        out.push(btag + b.text);
        if (b.tr) out.push(btag + b.tr);
      }
    }
  }
  return out.join('\n');
}

function fmtLrcTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

/**
 * 把统一歌词模型写进曲目对象（同时生成经典 LRC 与译文 LRC 兜底）。
 * fetch.js 的 attachLyrics 与 lyrics-select.js 的选源/贴 TTML 共用——
 * 模型应已过 schema.lyricsDataModel 白名单收敛，不信任任何外部结构。
 */
function applyModelToTrack(tr, model) {
  tr.lyricsData = model;
  tr.lyricsSynced = true;
  tr.lyricsSource = model.source || 'unknown';
  try {
    tr.lyrics = toLrc(model);
  } catch (e) {
    tr.lyrics = model.lines.map((l) => '[' + fmtLrcTime(l.t) + ']' + l.text).join('\n');
  }
  // 译文 LRC（旧消费者：浮动条/导出）。没有译文轨时为 null。
  const trLines = model.lines.filter((l) => l.tr && !l.instrumental);
  tr.lyricsTranslation = trLines.length
    ? trLines.map((l) => '[' + fmtLrcTime(l.t) + ']' + l.tr).join('\n')
    : null;
}

module.exports = {
  INSTRUMENTAL_GAP_SEC,
  krcDecrypt,
  decodeKrcLanguage,
  parseTTML,
  parseNeteaseYrc,
  parseQrc,
  parseKrc,
  parseLrcText,
  insertInstrumentals,
  foldDuetLines,
  analyzeDuet,
  scoreLyrics,
  finalizeModel,
  toLrc,
  fmtLrcTime,
  applyModelToTrack
};
