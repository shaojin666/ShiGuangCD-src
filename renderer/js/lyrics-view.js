'use strict';
/* ============================================================
 * lyrics-view.js —— 统一歌词模型的逐字渲染引擎（主播放页歌词面板）
 * ------------------------------------------------------------
 * 输入：主进程 lyrics-model.js 产出的统一模型
 *   { v, source, isWordByWord, agents?, quality,
 *     lines: [{ t, e, text, tr?, ro?, agent?, part?,
 *               words?: [{t,e,x}], bg?: [{t,e,text,tr?,agent?,words?}],
 *               instrumental? }] }
 *
 * v10.7 对唱排版（amll 风格）：load 时按整首歌判定 hasDuet / mainAgent
 *   （与主进程 analyzeDuet 同规则）——含对唱时容器加 .duet：
 *     非对唱行（含主唱）全部靠右、对唱行全部靠左、无任何居中；
 *     bg 条目带 agent（对唱侧）靠左，无 agent 的 x-bg 跟随宿主行。
 *
 * 输出：与旧 lrcLines 同构的行记录数组（el/inner/time 字段不变），
 *   因此 nowplaying.js 的点击跳转、浏览态、鼠标放大镜、3D 景深、
 *   居中逻辑全部原样复用，只把"行内多了一段词级 span"这件事交给这里。
 *
 * ============ 三个设计决策 ============
 * 1) **词级填充走 CSS 变量，不走 DOM 文本替换**。
 *    每帧只改当前行每个词 span 的一个 --wp（0~1），
 *    CSS 用 linear-gradient + background-clip:text 做"已唱部分亮、
 *    未唱部分暗"的卡拉OK效果。不重建文本节点，60fps 也无布局抖动。
 *
 * 2) **独立 RAF 循环，不搭 120ms 心跳的车**。
 *    主心跳 8fps，而一个词可能只有 150ms——搭心跳的话填充会一格一跳。
 *    这里自己跑 requestAnimationFrame，位置从 nowplaying 注入的
 *    getPos() 读；update(pos) 对相同位置幂等，所以心跳照常调用也无副作用。
 *
 * 3) **对唱/背景人声不抢主线**。bg 行按自己的时间轴独立填充，
 *    视觉上压暗一档、字号小一档，跟在主行下方——用户始终知道"该看哪行"。
 * ============================================================ */

window.LyricsView = (function () {
  /* ---------- 模块状态 ---------- */
  let box = null;          // .np-lyrics 容器
  let model = null;        // 当前模型
  let recs = [];           // 行记录：[{el, inner, t, e, tr, ro, agent, words, bgs, inst, time}]
  let active = -1;         // 当前行下标
  let lastPos = -1;        // 上次绘制的位置（相同位置直接跳过）
  let raf = 0;             // RAF 句柄
  let getPos = null;       // () => 当前播放位置（秒）
  let onLine = null;       // (idx) => void  行切换回调（居中 / 浮动条推送）
  let wordMode = false;    // 模型是否词级
  let running = false;
  /* v10.7 对唱排版（amll 风格）：load 时按整首歌算一次。
   *   hasDuet  —— 这首歌含不含对唱（含 → 无任何居中，主右对左）；
   *   mainAgent —— 主唱 agent（出现频次最高）；其余 agent 为对唱侧。
   * 行级/块级分类见 buildLine。 */
  let duet = { hasDuet: false, mainAgent: '' };

  /* ---------- 工具 ---------- */

  function el(tag, cls, text) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /**
   * 两个相邻词之间是否需要补一个空格文本节点（v10.5 修复英文空格被吞）：
   * 词级 span 是独立元素，浏览器不会替我们补空格 —— "I love you" 会渲染成
   * "Iloveyou"。规则：
   *   - 任一侧已经带空白（词文本自带空格）→ 不补；
   *   - 任一侧以连字符相接（singer- / -songwriter）→ 不补；
   *   - 仅当两侧都是拉丁字母/数字（含拉丁扩展区，覆盖法德西等变音）→ 补；
   *   - CJK 词之间不补（否则"遥远"会变成"遥 远"）。
   */
  function needsSpace(prev, cur) {
    if (!prev || !cur) return false;
    if (/\s$/.test(prev) || /^\s/.test(cur)) return false;
    if (/-$/.test(prev) || /^-/.test(cur)) return false;
    return /[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]$/.test(prev) &&
           /^[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]/.test(cur);
  }

  /** 把词级 span 逐个插入容器，相邻拉丁词之间补空格（见 needsSpace） */
  function appendWords(container, list) {
    const out = [];
    let prev = '';
    for (const w of list) {
      if (!w || typeof w.x !== 'string' || !w.x) continue;
      const ws = el('span', 'lrc-w', w.x);
      ws.dataset.t = String(w.t);
      ws.dataset.e = String(w.e);
      if (prev && needsSpace(prev, w.x)) container.appendChild(document.createTextNode(' '));
      container.appendChild(ws);
      out.push({ el: ws, t: w.t, e: w.e, wp: -1 });
      prev = w.x;
    }
    return out;
  }

  /* ---------- 生命周期 ---------- */

  /**
   * 绑定容器与依赖。
   * @param {HTMLElement} container .np-lyrics
   * @param {{getPos:Function, onLine:Function}} opts
   */
  function attach(container, opts) {
    box = container;
    getPos = opts && opts.getPos;
    onLine = opts && opts.onLine;
  }

  function clear() {
    stop();
    model = null;
    recs = [];
    active = -1;
    lastPos = -1;
    wordMode = false;
    duet = { hasDuet: false, mainAgent: '' };
    if (box) { box.innerHTML = ''; box.classList.remove('duet'); }
  }

  /* ---------- 渲染 ---------- */

  /**
   * 加载模型并渲染全部行。
   * @param {object} m 统一歌词模型（已过 schema 白名单）
   * @returns {Array} 行记录（交给 nowplaying 当 lrcLines 用）
   */
  function load(m) {
    clear();
    if (!box || !m || !Array.isArray(m.lines) || !m.lines.length) return recs;
    model = m;
    wordMode = !!m.isWordByWord;
    /* v10.7：先算整首歌的对唱结构（与主进程 lyrics-model.js 的 analyzeDuet
     *   同规则），再逐行打类。含对唱 → 容器加 .duet，CSS 把"居中"整体
     *   换成"主唱靠右 / 对唱靠左"；不含 → 一切照旧居中。 */
    duet = analyzeDuetLocal(m);
    box.classList.toggle('duet', duet.hasDuet);

    const frag = document.createDocumentFragment();
    for (let i = 0; i < m.lines.length; i++) {
      const l = m.lines[i];
      if (!l || typeof l.text !== 'string' || !l.text) continue;
      const rec = buildLine(l, i);
      recs.push(rec);
      frag.appendChild(rec.el);
    }
    box.appendChild(frag);
    start();
    return recs;
  }

  /**
   * 歌曲级对唱判定（与主进程 analyzeDuet 同规则，渲染端不跨进程取）：
   *   - 主行 bg 里有带 agent 的条目（折叠对唱），或
   *   - ≥2 个不同 agent 的主行（交替对唱）。
   * 主 agent 只按主线 agent 频次取（bg 条目不参与竞争，否则折叠对唱下
   * 对唱方会被误判成主唱，宿主行反而靠左，左右颠倒）。
   */
  function analyzeDuetLocal(m) {
    const lineCount = {}; // 仅主线 agent 频次（决定谁是主唱）
    const bgCount = {};   // bg 条目 agent 频次（退化兜底用）
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

  /** 渲染一行（主线 + 可选翻译/罗马音/背景人声） */
  function buildLine(l, i) {
    const line = el('div', 'lrc-line');
    line.dataset.i = String(i);

    const inner = el('span', 'lrc-inner');
    let words = [];
    if (l.instrumental) {
      line.classList.add('inst');
      inner.textContent = l.text || '♪';
    } else if (Array.isArray(l.words) && l.words.length) {
      words = appendWords(inner, l.words);
      if (!words.length) inner.textContent = l.text;
    } else {
      // 行级模型（LRCLIB 等）：整行一个 span，无词级填充
      inner.textContent = l.text;
    }
    line.appendChild(inner);

    // 背景人声（对唱）：每条一个块，词级时间独立
    const bgs = [];
    if (Array.isArray(l.bg) && l.bg.length) {
      for (const b of l.bg) {
        if (!b || typeof b.text !== 'string' || !b.text) continue;
        const blk = el('span', 'lrc-bg');
        /* v10.7 amll 排版分类：
         *   bg-duet —— 带 agent 的条目（折叠对唱条 / 对唱自带的 x-bg）→ 靠左；
         *   bg-main —— 无 agent 的 x-bg → 跟随宿主行（宿主对唱靠左、主唱靠右）。
         * 无对唱的歌两个类都不打，CSS 也不会启用左右规则（整体居中）。 */
        if (duet.hasDuet && b.agent) blk.classList.add(b.agent !== duet.mainAgent ? 'bg-duet' : 'bg-main');
        else if (duet.hasDuet) blk.classList.add('bg-main');
        let bwords = [];
        if (Array.isArray(b.words) && b.words.length) {
          bwords = appendWords(blk, b.words);
        } else {
          blk.textContent = b.text;
        }
        line.appendChild(blk);
        bgs.push({ el: blk, words: bwords, t: b.t, e: b.e, agent: b.agent || '' });
      }
    }
    /* v10.7：对唱主行（自身 agent 且不是主唱）整行靠左；
     *   非对唱行在 duet 模式下靠右、非 duet 模式居中（CSS 负责）。 */
    if (duet.hasDuet && l.agent && l.agent !== duet.mainAgent) {
      line.classList.add('duet-line');
    }

    // 翻译 / 罗马音：小字附行，显隐由容器 class 控制
    let trEl = null;
    let roEl = null;
    if (l.tr) { trEl = el('span', 'lrc-tr', l.tr); line.appendChild(trEl); }
    if (l.ro) { roEl = el('span', 'lrc-ro', l.ro); line.appendChild(roEl); }

    return {
      el: line, inner: inner,
      t: l.t, e: l.e,
      tr: l.tr || '', ro: l.ro || '',
      agent: l.agent || '',
      words: words, bgs: bgs,
      inst: !!l.instrumental,
      // 旧契约：点击跳转读 rec.time
      time: l.t
    };
  }

  /* ---------- 每帧绘制 ---------- */

  function start() {
    if (running) return;
    running = true;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function loop() {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (!recs.length || !getPos) return;
    // 面板不可见时跳过绘制（offsetParent 为 null = display:none 的祖先）
    if (box && box.offsetParent === null) return;
    let pos;
    try { pos = getPos(); } catch (e) { return; }
    if (typeof pos !== 'number' || !isFinite(pos)) return;
    update(pos);
  }

  /**
   * 绘制到指定位置。对相同位置幂等（心跳与 RAF 双通道调用安全）。
   */
  function update(pos) {
    if (!recs.length) return;
    if (pos === lastPos) return;
    lastPos = pos;

    // 1) 当前行（行按 t 升序；遇无时间行止步，与旧实现同语义）
    let idx = -1;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.t == null) break;
      if (r.t <= pos + 0.05) idx = i;
      else break;
    }
    if (idx !== active) switchLine(idx);

    // 2) 词级填充：当前行主线 + 背景人声各自的时间轴
    if (idx >= 0) {
      paintWords(recs[idx].words, pos);
      for (const b of recs[idx].bgs) paintWords(b.words, pos);
    }
  }

  /** 行切换：类名 + 3D 景深 + 几何缓存失效，全量只在这一步做 */
  function switchLine(idx) {
    active = idx;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const on = i === idx;
      if (r.el.classList.contains('active') !== on) r.el.classList.toggle('active', on);
      const d = Math.max(-6, Math.min(10, i - idx));
      r.el.style.setProperty('--d', String(d));
      r.el.style.setProperty('--ad', String(Math.min(8, Math.abs(d))));
    }
    if (onLine) { try { onLine(idx); } catch (e) { /* 单个订阅者出错不影响其它 */ } }
  }

  /** 词填充：只写变化过的 --wp */
  function paintWords(words, pos) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const span = w.e - w.t;
      const wp = span > 0.001 ? clamp01((pos - w.t) / span) : (pos >= w.e ? 1 : 0);
      if (wp === w.wp) continue;
      w.wp = wp;
      w.el.style.setProperty('--wp', wp.toFixed(3));
    }
  }

  /* ---------- 译 / 音显隐 ---------- */

  function hasTr(m) {
    return !!(m && Array.isArray(m.lines) && m.lines.some((l) => l && l.tr));
  }
  function hasRo(m) {
    return !!(m && Array.isArray(m.lines) && m.lines.some((l) => l && l.ro));
  }

  /** 模型里没有任何 bg 时为 false（用来决定要不要显示对唱提示） */
  function hasBg(m) {
    return !!(m && Array.isArray(m.lines) && m.lines.some((l) => l && Array.isArray(l.bg) && l.bg.length));
  }

  /* ---------- 对外查询 ---------- */

  function currentRec() { return active >= 0 ? recs[active] : null; }
  function recCount() { return recs.length; }
  function isWordMode() { return wordMode; }

  return {
    attach, load, clear, update,
    hasTr, hasRo, hasBg,
    currentRec, recCount, isWordMode,
    /** v10.7：当前歌曲的对唱结构（hasDuet / mainAgent），悬浮窗排版用 */
    duetInfo: () => ({ hasDuet: duet.hasDuet, mainAgent: duet.mainAgent }),
    /** 供测试/调试：当前行与词记录 */
    _state: () => ({ active: active, recs: recs.length, wordMode: wordMode })
  };
})();
