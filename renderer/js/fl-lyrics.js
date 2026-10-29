'use strict';
/* ============================================================
   fl-lyrics.js —— 全屏歌词演出层的「模型 → DOM」构建器
   ------------------------------------------------------------
   * 刻意独立于 lyrics-view.js（原版正在播放页的渲染引擎）：
     原版文件的任何改动都有回归风险，而演出层需要不同的 DOM 结构
     （行绝对定位、类名前缀 fl-、可被主题自由改写类与变量）。
     两个引擎消费的是**同一份主进程统一歌词模型**，互不影响。

   输入模型（main/metadata/lyrics-model.js 产物）：
     { v, source, isWordByWord, agents?,
       lines: [{ t, e, text, tr?, ro?, agent?, instrumental?,
                 words?: [{t,e,x}], bg?: [{t,e,text,tr?,agent?,words?}] }] }

   输出（FlLyrics.build 返回值）：
     { recs, wordMode, duet, hasTr, hasRo, count }
       recs[i] = { el, t, e, tr, ro, agent, inst, time,
                   words: [{el,t,e,wp}], bgs: [{el,words,t,e,agent}] }
     DOM 分层（v10.9）：.fl-line > .fl-in > (.fl-w / .fl-bg / .fl-tr / .fl-ro)
       .fl-line 定位链、.fl-in 揭示链（弹出动画与 3D 变换的专属层）。

   两个从 lyrics-view.js 沿用的已验证行为（附原因，避免"重新发明轮子"）：
     1) 英文词间补空格（needsSpace）：词 span 是独立元素，浏览器不会替
        我们补空格 —— "I love you" 会渲染成 "Iloveyou"。
     2) 歌曲级对唱判定（analyzeDuet）：含对唱的歌整首按 agent 分左右，
        与主进程 lyrics-model.js 的 analyzeDuet 同规则。
   ============================================================ */

window.FlLyrics = (function () {

  /* ---------- 工具 ---------- */

  function el(tag, cls, text) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  /** 英文词间补空格（与 lyrics-view.js 同规则，见文件头注释） */
  function needsSpace(prev, cur) {
    if (!prev || !cur) return false;
    if (/\s$/.test(prev) || /^\s/.test(cur)) return false;
    if (/-$/.test(prev) || /^-/.test(cur)) return false;
    return /[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]$/.test(prev) &&
           /^[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]/.test(cur);
  }

  /** 把词级 span 逐个插入容器，相邻拉丁词之间补空格 */
  function appendWords(container, list) {
    const out = [];
    let prev = '';
    for (const w of list) {
      if (!w || typeof w.x !== 'string' || !w.x) continue;
      const ws = el('span', 'fl-w', w.x);
      ws.dataset.t = String(w.t);
      ws.dataset.e = String(w.e);
      if (prev && needsSpace(prev, w.x)) container.appendChild(document.createTextNode(' '));
      container.appendChild(ws);
      out.push({ el: ws, t: w.t, e: w.e, wp: -1, on: false });
      prev = w.x;
    }
    return out;
  }

  /* ---------- 对唱判定（与 lyrics-view.js / 主进程 analyzeDuet 同规则） ---------- */

  function analyzeDuetLocal(m) {
    const lineCount = {};   // 仅主线 agent 频次（决定谁是主唱）
    const bgCount = {};     // bg 条目 agent 频次（退化兜底）
    let hasAgentBg = false;
    for (const l of m.lines) {
      if (!l) continue;
      if (Array.isArray(l.bg)) {
        for (const b of l.bg) {
          if (b && b.agent) { hasAgentBg = true; bgCount[b.agent] = (bgCount[b.agent] || 0) + 1; }
        }
      }
      if (l.agent) lineCount[l.agent] = (lineCount[l.agent] || 0) + 1;
    }
    const lineIds = Object.keys(lineCount);
    if (!hasAgentBg && lineIds.length < 2) return { hasDuet: false, mainAgent: '' };
    let pool = lineCount;
    if (!lineIds.length) pool = bgCount;
    let mainAgent = '';
    let best = -1;
    for (const id of Object.keys(pool)) {
      if (pool[id] > best) { best = pool[id]; mainAgent = id; }
    }
    return { hasDuet: true, mainAgent: mainAgent };
  }

  /* ---------- 行构建 ---------- */

  /**
   * 一行 = .fl-line（定位链：--d/--ad → transform/opacity，归基础规则）
   *        > .fl-in（揭示链：弹出动画 / 3D 变换，v10.9 起）。
   * 分层的理由：orbit/chorus/prism 等主题直接占用 .fl-line 的
   * translate/rotate/scale 独立属性，whisper 占用 .fl-w 的 translate——
   * 揭示动画若也写在这些属性上就会和主题打架。.fl-in 是专属层，
   * 基础 reveal 规则与 3D 主题都只动它，互不侵占。
   */
  function buildLine(l, i, duet) {
    const line = el('div', 'fl-line');
    line.dataset.i = String(i);
    const inner = el('div', 'fl-in');

    const words = [];
    if (l.instrumental) {
      // 间奏行：整行同亮（呼吸动画），不参与词填充 → fl-solid
      line.classList.add('fl-inst');
      const w = el('span', 'fl-w fl-solid', l.text || '♪');
      inner.appendChild(w);
    } else if (Array.isArray(l.words) && l.words.length) {
      const got = appendWords(inner, l.words);
      for (const g of got) words.push(g);
      // 词级数据全部无效时的回退：整行同亮 → fl-solid
      if (!words.length) inner.appendChild(el('span', 'fl-w fl-solid', l.text));
    } else {
      // 行级模型（LRCLIB 等）：整行一个 span，无词级填充 → fl-solid
      inner.appendChild(el('span', 'fl-w fl-solid', l.text));
    }

    // 背景人声（对唱）：每条一个块，词级时间独立
    const bgs = [];
    if (Array.isArray(l.bg) && l.bg.length) {
      for (const b of l.bg) {
        if (!b || typeof b.text !== 'string' || !b.text) continue;
        const blk = el('span', 'fl-bg');
        if (duet.hasDuet && b.agent) blk.classList.add(b.agent !== duet.mainAgent ? 'bg-duet' : 'bg-main');
        let bwords = [];
        if (Array.isArray(b.words) && b.words.length) bwords = appendWords(blk, b.words);
        else blk.textContent = b.text;
        inner.appendChild(blk);
        bgs.push({ el: blk, words: bwords, t: b.t, e: b.e, agent: b.agent || '' });
      }
    }
    // 对唱主行（自身 agent 且不是主唱）：群唱主题据此分左右
    if (duet.hasDuet && l.agent && l.agent !== duet.mainAgent) {
      line.classList.add('duet-line');
      line.dataset.agent = l.agent;
    } else if (l.agent) {
      line.dataset.agent = l.agent;
    }

    if (l.tr) inner.appendChild(el('span', 'fl-tr', l.tr));
    if (l.ro) inner.appendChild(el('span', 'fl-ro', l.ro));

    line.appendChild(inner);

    return {
      el: line,
      t: l.t, e: l.e,
      tr: l.tr || '', ro: l.ro || '',
      agent: l.agent || '',
      words: words, bgs: bgs,
      inst: !!l.instrumental,
      time: l.t
    };
  }

  /* ---------- LRC 兜底解析（无统一模型时的行级歌词） ---------- */

  function parseLrc(text) {
    const out = [];
    if (!text) return out;
    const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const lines = String(text).split(/\r?\n/);
    for (const line of lines) {
      const times = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        const frac = m[3] ? parseFloat('0.' + m[3].padEnd(3, '0')) : 0;
        times.push(min * 60 + sec + frac);
      }
      if (!times.length) continue;
      const content = line.replace(re, '').trim();
      for (const t of times) out.push({ t: t, text: content });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /* ---------- 对外 ---------- */

  /**
   * 用统一模型构建全部行（一次构建，之后每帧只写变量）。
   * @param {HTMLElement} container .fl-lyrics 容器
   * @param {object} m 统一歌词模型
   */
  function build(container, m) {
    const recs = [];
    if (!container) return { recs, wordMode: false, duet: { hasDuet: false, mainAgent: '' }, hasTr: false, hasRo: false, count: 0 };
    container.innerHTML = '';
    if (!m || !Array.isArray(m.lines) || !m.lines.length) return { recs, wordMode: false, duet: { hasDuet: false, mainAgent: '' }, hasTr: false, hasRo: false, count: 0 };

    const duet = analyzeDuetLocal(m);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < m.lines.length; i++) {
      const l = m.lines[i];
      if (!l || typeof l.text !== 'string' || !l.text) continue;
      const rec = buildLine(l, i, duet);
      recs.push(rec);
      frag.appendChild(rec.el);
    }
    container.appendChild(frag);

    const hasTr = recs.some((r) => !!r.tr);
    const hasRo = recs.some((r) => !!r.ro);
    return { recs, wordMode: !!m.isWordByWord, duet, hasTr, hasRo, count: recs.length };
  }

  /** 用经典 LRC 文本构建（无统一模型时的兜底） */
  function buildFromLrc(container, text) {
    const parsed = parseLrc(text);
    if (!parsed.length) return build(container, null);
    const model = {
      v: 1, source: 'lrc', isWordByWord: false,
      lines: parsed.map((p) => ({ t: p.t, e: p.t + 5, text: p.text }))
    };
    return build(container, model);
  }

  /** 写入空态提示 */
  function showEmpty(container, text) {
    if (!container) return;
    container.innerHTML = '';
    const d = el('div', 'fl-empty', text || T('fl.empty.noLyrics'));
    container.appendChild(d);
  }

  return { build, buildFromLrc, showEmpty, parseLrc };
})();
