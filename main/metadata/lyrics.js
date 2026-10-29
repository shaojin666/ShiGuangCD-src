'use strict';
/*
 * lyrics.js —— 歌词源编排（逐字歌词第一棒 · 降级链）。
 *
 * ============ 两个入口 ============
 *   fetchLyricsFromLrclib  旧行为：行级 LRC（LRCLIB），原样保留，海外碟兜底。
 *   fetchLyricsRich        单发模式：按源顺序尝试，命中即返回（冒烟工具/单测用）。
 *   fetchLyricsRichAll     全收集模式：跑完所有源，返回 {best, candidates}。
 *                          编辑面板的"歌词源管理"用它——用户要看到所有获取到的源
 *                          并手动挑一个（见 main/metadata/lyrics-select.js）。
 *
 * ============ 降级链 ============
 * 源表（SOURCES）顺序即优先级，同质量分时先到者胜：
 *   1) AMLL TTML DB   ncmMusicId / qqMusicId；无 ID 时按 曲名+歌手 搜索反查
 *   2) 网易云         yrc 逐字优先，lrc 行级兜底（两者都作为候选返回）
 *   3) QQ 音乐        QRC 逐字 / lrc 兜底（需 qqMid）
 *   4) 酷狗           KRC 逐字 / lrc 兜底（关键词搜索 + 时长/名称匹配）
 *   5) LRCLIB         行级 LRC，海外碟兜底
 * 任一源失败/超时都不阻塞后续源；全部失败返回 null。
 *
 * ★ 匹配纪律（沿用原项目的严格哲学，宁缺毋滥）：
 *   - 有 neteaseSongId（专辑详情精确对应）时绝不搜索，直接用 ID；
 *   - 搜索反查的候选必须 标题命中 且（歌手命中或时长差 ≤3s）才采用；
 *   - 单行歌词（lines < 2）视为脏数据丢弃（精确 ID 源放行）。
 */

const { getJson, qs, withTimeout } = require('./http');
const netease = require('./netease');
const amll = require('./amll');
const qqMusic = require('./qq-music');
const kugou = require('./kugou');
const {
  parseTTML, parseNeteaseYrc, parseQrc, parseKrc, parseLrcText,
  finalizeModel
} = require('./lyrics-model');

const LRCLIB_TIMEOUT_MS = 6000;
/** 搜索反查候选的最小可信分（标题必须命中，且歌手或时长佐证） */
const CANDIDATE_MIN_SCORE = 2;

/**
 * 取单曲歌词。
 * @param {{artist:string,title:string,album:string,durationSec:number}} o
 * @returns {Promise<{lyrics:string,synced:boolean,source:string}|null>}
 */
async function fetchLyrics({ artist, title, album, durationSec }) {
  if (!title) return null;
  const base = { artist_name: artist, track_name: title, album_name: album };

  // 1) 精确匹配 /api/get（带时长命中率最高）
  try {
    const url = 'https://lrclib.net/api/get?' +
      qs(Object.assign({}, base, { duration: Math.round(durationSec || 0) }));
    const res = await withTimeout(getJson(url, { browser: true }), LRCLIB_TIMEOUT_MS, 'LRCLIB');
    if (res && (res.syncedLyrics || res.plainLyrics)) {
      return {
        lyrics: res.syncedLyrics || res.plainLyrics,
        synced: !!res.syncedLyrics,
        source: 'lrclib'
      };
    }
  } catch (e) { /* 落到搜索 */ }

  // 2) 模糊搜索 /api/search
  try {
    const url = 'https://lrclib.net/api/search?' + qs(base);
    const list = await withTimeout(getJson(url, { browser: true }), LRCLIB_TIMEOUT_MS, 'LRCLIB');
    if (Array.isArray(list) && list.length) {
      let best = list.find((it) => it.duration && durationSec &&
        Math.abs(it.duration - durationSec) <= 3);
      if (!best) {
        best = list.find((it) => it.albumName && album &&
          String(it.albumName).toLowerCase() === String(album).toLowerCase());
      }
      if (!best) best = list[0];
      if (best && (best.syncedLyrics || best.plainLyrics)) {
        return {
          lyrics: best.syncedLyrics || best.plainLyrics,
          synced: !!best.syncedLyrics,
          source: 'lrclib'
        };
      }
    }
  } catch (e) { /* 忽略 */ }

  return null;
}

/* ================================================================
 * 多源逐字歌词降级链（fetchLyricsRich）
 * ================================================================ */

/** 归一化比较用（与 netease.norm 同口径） */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_·、，,。.（）()\[\]【】'"“”‘’:：/\\|]/g, '');
}

/**
 * 搜索候选打分：标题命中是硬条件，歌手/时长作佐证。
 * @returns {{score:number, titleHit:boolean, artistHit:boolean, durHit:boolean}}
 */
function scoreCandidate(target, cand) {
  const t = norm(target.title);
  const a = norm(target.artist);
  const ct = norm(cand.name || cand.musicNames && cand.musicNames[0] || cand.song);
  const ca = norm(cand.artist || (cand.artistNames && cand.artistNames[0]) || cand.singer);
  const dur = cand.durationSec != null ? cand.durationSec
    : (cand.duration != null ? cand.duration / 1000 : null);
  let score = 0;
  let titleHit = false;
  let artistHit = false;
  if (t && ct) {
    if (ct === t) { score += 3; titleHit = true; }
    else if (ct.indexOf(t) >= 0 || t.indexOf(ct) >= 0) { score += 2; titleHit = true; }
  }
  if (a && ca) {
    if (ca === a) { score += 2; artistHit = true; }
    else if (ca.indexOf(a) >= 0 || a.indexOf(ca) >= 0) { score += 1; artistHit = true; }
  }
  let durHit = false;
  if (target.durationSec && dur) {
    const diff = Math.abs(dur - target.durationSec);
    if (diff <= 3) { score += 2; durHit = true; }
    else if (diff <= 8) { score += 1; }
  }
  return { score, titleHit, artistHit, durHit };
}

/** 从候选列表里挑最可信的一个；没有合格者返回 null */
function pickBestCandidate(cands, target) {
  if (!cands || !cands.length) return null;
  const scored = cands.map((c) => ({ c, d: scoreCandidate(target, c) }));
  scored.sort((x, y) => y.d.score - x.d.score);
  const best = scored[0];
  if (!best.d.titleHit) return null;
  if (best.d.score < CANDIDATE_MIN_SCORE) return null;
  if (!best.d.artistHit && !best.d.durHit) return null;
  return best.c;
}

/**
 * 单源尝试：失败/超时/空结果都返回 null，不抛异常。
 * ★ 只有**抛异常**（超时/网络错误/解析崩了）才记失败 —— 返回 null 表示
 *   源可达但没数据，静默跳过。这样"没收录"和"连不上"在日志里可区分。
 */
async function trySource(label, fn, log) {
  try {
    return await fn();
  } catch (e) {
    if (log) log('lyrics[' + label + '] 失败：' + (e && e.message ? e.message : e));
    return null;
  }
}

/**
 * 命中某源时记一行结果日志（带上曲名，多轨时能看出是谁）。
 * 这是用户判断"为什么还是 LRC"的主要依据：逐字/行级、行数、质量分、
 * 有没有译/音/对唱轨，一行说清。
 */
function won(label, title, model, log) {
  if (log && model && model.lines && model.lines.length) {
    const tags = [];
    if (model.lines.some((l) => l && l.tr)) tags.push('译');
    if (model.lines.some((l) => l && l.ro)) tags.push('音');
    if (model.lines.some((l) => l && l.bg && l.bg.length)) tags.push('对唱');
    const inst = model.lines.filter((l) => l && l.instrumental).length;
    if (inst) tags.push('间奏×' + inst);
    log('lyrics[' + clip(title) + '] ' + label + ' ' +
      (model.isWordByWord ? '逐字' : '行级') + ' ' + model.lines.length + '行' +
      ' 质量' + Math.round(model.quality || 0) +
      (tags.length ? ' ' + tags.join('/') : ''));
  }
  return model;
}

/** 日志里的曲名截断（CD 曲名可能很长，一行日志要塞下源信息） */
function clip(s, n = 10) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 模型合法性校验。
 * 默认要求至少两行——搜索匹配到的单行结果多为脏数据（关键词撞车、
 * 接口返回占位符）。但**精确 ID 源**（专辑曲目表直接给的 neteaseSongId /
 * qqMid）不存在匹配歧义，单行也是真实歌词（前奏曲、独白曲常见），放行。
 * @param {object|null} model
 * @param {boolean} [exact] true = 来源是精确 ID，无搜索歧义
 */
function accept(model, exact) {
  if (!model || !model.lines || !model.lines.length) return null;
  return exact || model.lines.length >= 2 ? model : null;
}

/* ================================================================
 * 各源尝试函数
 * ------------------------------------------------------------
 * 每个函数返回 **Model[]**（不是单个模型）：同一个源可能同时产出
 * 逐字与行级两种结果（网易云 yrc 失败时 lrc 仍可用），编辑面板的
 * "歌词源管理"要把它们作为不同选项呈现给用户，所以这里不提前
 * 剪掉，由驱动决定取第一个还是全收。
 * ================================================================ */

/** 1) AMLL TTML DB：ncmMusicId / qqMusicId 直查，无 ID 时搜索反查 */
async function srcAmll(o, target) {
  const ids = [];
  if (o.neteaseSongId) ids.push({ platform: 'ncm', id: String(o.neteaseSongId) });
  if (o.qqMid) ids.push({ platform: 'qq', id: String(o.qqMid) });
  if (!ids.length) {
    // 无平台 ID：按 曲名+歌手 搜索反查（同一首歌可能登记多个 ID，逐个试）
    const items = await amll.search({ musicName: o.title, artistName: o.artist }, 8);
    if (!items) return [];
    for (const it of items) {
      if (scoreCandidate(target, it).score < CANDIDATE_MIN_SCORE) continue;
      for (const id of (it.ncmMusicIds || [])) ids.push({ platform: 'ncm', id });
      for (const id of (it.qqMusicIds || [])) ids.push({ platform: 'qq', id });
      if (ids.length >= 4) break;
    }
  }
  const out = [];
  for (const { platform, id } of ids.slice(0, 4)) {
    const ttml = await amll.getLyric(platform, id);
    if (!ttml) continue;
    const model = accept(finalizeModel(parseTTML(ttml)), !!(o.neteaseSongId || o.qqMid));
    if (model) { out.push(model); break; }
  }
  return out;
}

/** 2) 网易云：yrc 逐字优先，lrc 行级兜底（两者都收，供用户选择） */
async function srcNetease(o, target) {
  let songId = o.neteaseSongId || null;
  let exact = !!o.neteaseSongId;
  if (!songId) {
    const songs = await netease.searchSongs([o.title, o.artist].filter(Boolean).join(' '), 5);
    const pick = pickBestCandidate(songs, target);
    if (pick) songId = pick.id;
  }
  if (!songId) return [];
  const ly = await netease.getLyric(songId);
  if (!ly) return [];
  const out = [];
  if (ly.yrc) {
    const model = accept(finalizeModel(parseNeteaseYrc(ly.yrc, {
      translation: ly.yrcTranslation || ly.translation,
      romanization: ly.yrcRomanization || ly.romanization
    })), exact);
    if (model) out.push(model);
  }
  if (ly.lyrics) {
    const model = accept(finalizeModel(parseLrcText(ly.lyrics, {
      translation: ly.translation, source: 'netease'
    })), exact);
    if (model) out.push(model);
  }
  return out;
}

/** 3) QQ 音乐：QRC 逐字优先，lrc 兜底（需 qqMid，CD 场景极少有） */
async function srcQq(o) {
  if (!o.qqMid) return [];
  const q = await qqMusic.getLyric({ mid: o.qqMid });
  if (!q) return [];
  const out = [];
  if (q.qrc) {
    const model = accept(finalizeModel(parseQrc(q.qrc, {
      translation: q.trans, romanization: q.roma
    })), true);
    if (model) out.push(model);
  }
  if (q.lyric) {
    const model = accept(finalizeModel(parseLrcText(q.lyric, { source: 'qq' })), true);
    if (model) out.push(model);
  }
  return out;
}

/**
 * 4) 酷狗：songsearch 拿 hash → krcs hash 直查候选，KRC 逐字优先，lrc 兜底。
 *
 * 新路径（mineradio 配方）：
 *   searchSongs → pickBestCandidate 选中歌曲 → lyricCandidates(hash 直查)
 *   → 候选逐个顺延下载 KRC（封顶 3 个）→ 命中后再向同一候选补一份行级 LRC。
 * KRC 全部失败才退而求其次试 LRC（封顶 2 个）。
 *
 * 逐个顺延是必须的：candidates[0] 是"官方推荐"但个别版本只有 LRC 无 KRC，
 * 或下载失败 —— 酷狗上逐字歌词覆盖率很高，多试两个候选命中率差别巨大。
 *
 * 旧 keyword 直查入口（lyrics.kugou.com/search?keyword=…）2026-11 起恒 404，
 * 仅当新路径完全无果时花一发兜底，不再主动依赖。
 */
async function srcKugou(o, target) {
  const out = [];
  const keyword = [o.title, o.artist].filter(Boolean).join(' ');

  /* ---- 新路径：songsearch 拿 hash → krcs hash 直查 ---- */
  // 不设 try/catch：songsearch/krcs 异常直接传播给 trySource（记一行
  // 「lyrics[kugou] 失败」并中止本源）。两个入口同属酷狗，一个炸另一个
  // 大概率也炸，静默重试会搅浑诊断日志。
  {
    const songs = await kugou.searchSongs(keyword);
    const song = songs && songs.length ? pickBestCandidate(songs, target) : null;
    if (song) {
      const cands = await kugou.lyricCandidates(song) || [];
      let used = null;
      for (const cand of cands.slice(0, 3)) {          // KRC 逐个顺延，封顶 3
        const krc = await kugou.download(cand, 'krc');
        if (!krc) continue;
        const model = accept(finalizeModel(parseKrc(krc)));
        if (model) { out.push(model); used = cand; break; }
      }
      if (used) {
        // 同候选补一份行级 LRC（同一版本通常两种格式都有，成本一次请求）
        const lrc = await kugou.download(used, 'lrc');
        if (lrc) {
          const model = accept(finalizeModel(parseLrcText(lrc, { source: 'kugou' })));
          if (model) out.push(model);
        }
      } else {
        // KRC 全失败 → LRC 兜底，封顶 2
        for (const cand of cands.slice(0, 2)) {
          const lrc = await kugou.download(cand, 'lrc');
          if (!lrc) continue;
          const model = accept(finalizeModel(parseLrcText(lrc, { source: 'kugou' })));
          if (model) { out.push(model); break; }
        }
      }
    }
  }

  /* ---- 旧 keyword 路径兜底（新路径无果时才花这一发） ---- */
  if (!out.length) {
    try {
      const cands = await kugou.search(keyword, o.durationSec);
      if (cands && cands.length) {
        const pick = pickBestCandidate(cands, target);
        if (pick) {
          const krc = await kugou.download(pick, 'krc');
          if (krc) {
            const model = accept(finalizeModel(parseKrc(krc)));
            if (model) out.push(model);
          }
          if (!out.length) {
            const lrc = await kugou.download(pick, 'lrc');
            if (lrc) {
              const model = accept(finalizeModel(parseLrcText(lrc, { source: 'kugou' })));
              if (model) out.push(model);
            }
          }
        }
      }
    } catch (e) { /* 酷狗整体不可达，静默让位给后续源 */ }
  }
  return out;
}

/** 5) LRCLIB：行级 LRC，海外碟兜底（旧逻辑原样保留） */
async function srcLrclib(o) {
  const res = await fetchLyrics({ artist: o.artist, title: o.title, album: o.album, durationSec: o.durationSec });
  if (!res || !res.lyrics) return [];
  const model = accept(finalizeModel(parseLrcText(res.lyrics, { source: 'lrclib' })));
  return model ? [model] : [];
}

/** 源表：顺序即优先级（同质量分时先到者胜） */
const SOURCES = [
  ['amll', srcAmll],
  ['netease', srcNetease],
  ['qq', srcQq],
  ['kugou', srcKugou],
  ['lrclib', srcLrclib]
];

/**
 * 多源逐字歌词降级链（单发模式：命中即返回）。
 *
 * 保持旧行为——按源表顺序尝试，第一个有结果的源胜出，
 * 不再继续问后续源。冒烟工具与既有单测都走这条。
 *
 * @param {{title:string, artist:string, album:string, durationSec:number,
 *          neteaseSongId?:number, qqMid?:string, log?:Function}} o
 * @returns {Promise<object|null>} 统一歌词模型（含 quality 分），失败返回 null
 */
async function fetchLyricsRich(o) {
  const ctx = prep(o);
  if (!ctx) return null;
  const { target, log } = ctx;

  for (const [label, fn] of SOURCES) {
    const list = await trySource(label, () => fn(o, target), log);
    if (list && list.length) return won(label, o.title, list[0], log);
  }
  if (log) log('lyrics[' + clip(o.title) + '] 六源均未命中（可能未收录或网络不可达）');
  return null;
}

/**
 * 多源逐字歌词降级链（全收集模式：跑完所有源，一个都不提前剪）。
 *
 * 这是编辑面板"歌词源管理"的数据来源——用户要能看到**所有获取到的源**
 * 并手动挑一个。代价是每首歌都会问完全部源（酷狗搜索与 LRCLIB 是主要
 * 增量，约 1~3s/首），由 attachLyrics 的整体 deadline 兜底。
 *
 * @returns {Promise<{best:object, candidates:object[]}|null>}
 *          best 为质量分最高者（同分取源表在后者），candidates 为全部候选
 */
async function fetchLyricsRichAll(o) {
  const ctx = prep(o);
  if (!ctx) return null;
  const { target, log } = ctx;

  const candidates = [];
  for (const [label, fn] of SOURCES) {
    const list = await trySource(label, () => fn(o, target), log);
    if (!list || !list.length) continue;
    for (const m of list) {
      candidates.push(m);
      won(label, o.title, m, log);
    }
  }
  if (!candidates.length) {
    if (log) log('lyrics[' + clip(o.title) + '] 六源均未命中（可能未收录或网络不可达）');
    return null;
  }
  // 质量分降序；sort 稳定，同分时源表在前的（更可靠的源）保持在前
  candidates.sort((a, b) => (b.quality || 0) - (a.quality || 0));
  return { best: candidates[0], candidates };
}

/** 入参归一化：两个驱动共用。无曲名直接放弃 */
function prep(o) {
  o.title = (o.title || '').trim();
  o.artist = (o.artist || '').trim();
  o.album = (o.album || '').trim();
  o.durationSec = o.durationSec > 0 ? o.durationSec : 0;
  if (!o.title) return null;
  return { target: { title: o.title, artist: o.artist, durationSec: o.durationSec }, log: o.log || null };
}

/** 并发受限地批量获取歌词（结果数组与 tracks 一一对应） */
async function fetchLyricsForTracks(tracks, { concurrency = 3, gapMs = 200, onProgress } = {}) {
  const results = new Array(tracks.length).fill(null);
  let index = 0;
  let done = 0;
  const worker = async () => {
    while (index < tracks.length) {
      const i = index++;
      const tr = tracks[i];
      if (tr.title && tr.title !== '') {
        try {
          results[i] = await fetchLyrics({
            artist: tr.artist || '',
            title: tr.title,
            album: tr.album || '',
            durationSec: tr.durationSec
          });
        } catch (e) { /* 单曲失败不阻塞 */ }
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      }
      done++;
      if (onProgress) onProgress(done, tracks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, tracks.length)) }, worker));
  return results;
}

module.exports = {
  fetchLyrics,
  fetchLyricsForTracks,
  fetchLyricsFromLrclib: fetchLyrics,
  fetchLyricsRich,
  fetchLyricsRichAll
};
