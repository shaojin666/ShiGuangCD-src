'use strict';
/* ============================================================
   fl-panel.js —— 全屏歌词演出层「主题选项面板」
   ------------------------------------------------------------
   左上角 ⌂ 按钮唤出（顶栏自动隐藏时鼠标靠近顶栏即可出现）。
   面板内容：
     1) 视觉主题卡（来自 FlThemes 注册表；M2 起带参数滑条）
     2) 歌词显示：弹出方式（v10.9：全部 / 整行 / 逐字）/ 字号 / 翻译 / 罗马音
        （M4 再加入字体选择）
     3) 恢复默认
   所有开关即时生效并走既有 settings:set 持久化（主进程是
   Object.assign 自由合并，零 schema 改动）。

   面板自身不管"怎么应用"——通过 mount 时注入的 hooks 交给
   fl-stage.js 执行，避免模块间循环依赖。
   ============================================================ */

window.FlPanel = (function () {

  const SIZE_MIN = 24;
  const SIZE_MAX = 56;

  const S = {
    stage: null, panel: null, listEl: null, paramBox: null,
    sizeInput: null, sizeNum: null, trBtn: null, roBtn: null,
    revealBtns: null,        // v10.9：弹出方式 chip 按钮组
    paramInputs: {},     // key → { input, num }（当前主题的滑条）
    hooks: null,       // { setTheme, setSize, setShowTr, setShowRo, setReveal, setThemeParam, reset }
    cur: { theme: 'lumen', size: 34, showTr: true, showRo: true, reveal: 'all', params: {} }
  };

  /* ---------- 工具 ---------- */

  function el(tag, cls, html) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }

  function persist(patch) {
    try {
      if (window.cd && typeof window.cd.invoke === 'function') {
        window.cd.invoke('settings:set', patch).catch(() => { /* 忽略 */ });
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 文案（统一走 FlThemes，避免与设置页分叉） ---------- */

  function themeName(def) {
    if (window.FlThemes && FlThemes.nameOf) return FlThemes.nameOf(def);
    return (def && def.name) || '';
  }

  function themeDesc(def) {
    if (window.FlThemes && FlThemes.descOf) return FlThemes.descOf(def);
    return (def && def.desc) || '';
  }

  function paramName(def, p) {
    if (window.FlThemes && FlThemes.paramLabel) return FlThemes.paramLabel(def, p);
    return (p && (p.label || p.key)) || '';
  }

  /* ---------- 主题卡 ---------- */

  function themeCard(def) {
    const card = el('button', 'fl-theme-card');
    card.type = 'button';
    card.dataset.theme = def.id;
    const tname = themeName(def);
    card.setAttribute('aria-label', T('fl.panel.themeAria', { name: tname }));

    const ico = el('span', 'fl-theme-ico', def.icon || '');
    const meta = el('span', 'fl-theme-meta');
    meta.appendChild(el('span', 'fl-theme-name', tname));
    meta.appendChild(el('span', 'fl-theme-desc', themeDesc(def)));
    card.appendChild(ico);
    card.appendChild(meta);

    const tag = def.type === '3d' ? T('fl.panel.tag3d')
      : (def.type === 'canvas' ? T('fl.panel.tagCanvas') : T('fl.panel.tag2d'));
    const tagEl = el('span', 'fl-theme-tag' + (def.type === '3d' ? ' d3' : ''), tag);
    card.appendChild(tagEl);

    card.addEventListener('click', () => {
      if (S.cur.theme === def.id) return;
      S.cur.theme = def.id;
      syncThemeCards();
      buildParams();          // 参数区跟随当前主题重建
      if (S.hooks && S.hooks.setTheme) S.hooks.setTheme(def.id);
      persist({ flTheme: def.id });
    });
    return card;
  }

  function syncThemeCards() {
    const cards = S.listEl.querySelectorAll('.fl-theme-card');
    for (const c of cards) c.classList.toggle('on', c.dataset.theme === S.cur.theme);
  }

  /* ---------- 主题参数区（M2：每个主题一组滑条） ---------- */

  /** 当前主题某参数的现值（面板记忆优先，否则主题默认） */
  function curParam(def, key) {
    const bag = S.cur.params && S.cur.params[def.id];
    const v = bag ? bag[key] : undefined;
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  function paramDefault(def, key) {
    if (!Array.isArray(def.params)) return 0;
    const p = def.params.find((x) => x && x.key === key);
    return p ? p.def : 0;
  }

  function buildParams() {
    if (!S.paramBox) return;
    S.paramBox.innerHTML = '';
    S.paramInputs = {};
    const def = FlThemes.get(S.cur.theme);
    const params = (def && Array.isArray(def.params)) ? def.params : [];
    if (!params.length) return;   // 无可调参数的主题：整段不出现

    const head = el('div', 'fl-panel-sec', T('fl.panel.params', { name: themeName(def) }));
    S.paramBox.appendChild(head);

    for (const p of params) {
      const row = el('div', 'fl-param-row');
      row.appendChild(el('label', '', paramName(def, p)));
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = String(p.step);
      const val = curParam(def, p.key);
      input.value = String(val == null ? p.def : val);
      input.setAttribute('aria-label', themeName(def) + ' ' + paramName(def, p));
      const num = el('span', 'fl-param-num', fmtParam(p, val == null ? p.def : val));
      input.addEventListener('input', () => {
        let v = parseFloat(input.value);
        if (!isFinite(v)) return;
        v = Math.max(p.min, Math.min(p.max, v));
        if (!S.cur.params[S.cur.theme]) S.cur.params[S.cur.theme] = {};
        S.cur.params[S.cur.theme][p.key] = v;
        num.textContent = fmtParam(p, v);
        if (S.hooks && S.hooks.setThemeParam) S.hooks.setThemeParam(p.key, v);
        persist({ flParams: S.cur.params });
      });
      row.appendChild(input);
      row.appendChild(num);
      S.paramBox.appendChild(row);
      S.paramInputs[p.key] = { input: input, num: num };
    }
  }

  function fmtParam(p, v) {
    const n = (p.step && p.step < 1) ? Number(v).toFixed(String(p.step).split('.')[1].length) : String(Math.round(v));
    return n + (p.unit || '');
  }

  /** 切主题后由外部调用：同步参数区（主题卡点击时已内联处理） */
  function syncParams() {
    // 程序化切主题（非面板点击）后，把面板的当前主题对齐到舞台实际主题
    if (S.stage && S.stage.dataset.theme && S.stage.dataset.theme !== S.cur.theme) {
      S.cur.theme = S.stage.dataset.theme;
      syncThemeCards();
    }
    // v10.9：弹出方式同样以舞台 data-reveal 为真相源（程序化切换后对齐 chip）
    if (S.stage && S.stage.dataset.reveal && S.stage.dataset.reveal !== S.cur.reveal) {
      S.cur.reveal = S.stage.dataset.reveal;
      syncReveal();
    }
    buildParams();
  }

  /** 舞台侧程序化改了弹出方式（FlStage.setReveal）→ chip 高亮对齐 */
  function syncRevealFromStage() {
    if (S.stage && S.stage.dataset.reveal && S.stage.dataset.reveal !== S.cur.reveal) {
      S.cur.reveal = S.stage.dataset.reveal;
    }
    syncReveal();
  }

  /* ---------- 歌词显示区 ---------- */

  /** v10.9 弹出方式三选一（全局，所有主题可套用） */
  const REVEAL_OPTS = [
    { id: 'all', label: 'fl.panel.reveal.all', tip: 'fl.panel.reveal.allTip' },
    { id: 'line', label: 'fl.panel.reveal.line', tip: 'fl.panel.reveal.lineTip' },
    { id: 'word', label: 'fl.panel.reveal.word', tip: 'fl.panel.reveal.wordTip' }
  ];

  function buildRevealRow() {
    const row = el('div', 'fl-param-row');
    row.appendChild(el('label', '', T('fl.panel.reveal')));
    const box = el('div', 'fl-reveal-box');
    S.revealBtns = {};
    for (const o of REVEAL_OPTS) {
      const tip = T(o.tip);
      const b = el('button', 'fl-reveal-chip', T(o.label));
      b.type = 'button';
      b.id = 'fl-reveal-' + o.id;
      b.title = tip;
      b.setAttribute('aria-label', tip);
      b.addEventListener('click', () => {
        if (S.cur.reveal === o.id) return;
        S.cur.reveal = o.id;
        syncReveal();
        if (S.hooks && S.hooks.setReveal) S.hooks.setReveal(o.id);
        persist({ flReveal: o.id });
      });
      S.revealBtns[o.id] = b;
      box.appendChild(b);
    }
    row.appendChild(box);
    return row;
  }

  function syncReveal() {
    for (const o of REVEAL_OPTS) {
      const b = S.revealBtns && S.revealBtns[o.id];
      if (b) b.classList.toggle('on', S.cur.reveal === o.id);
    }
  }

  function buildLyricSection() {
    const wrap = el('div', '');

    wrap.appendChild(el('div', 'fl-panel-sec', T('fl.panel.lyrics')));

    // v10.9：弹出方式（置于字号之前——它是更上位的显示模式）
    wrap.appendChild(buildRevealRow());

    // 字号
    const rowSize = el('div', 'fl-param-row');
    rowSize.appendChild(el('label', '', T('fl.panel.size')));
    S.sizeInput = document.createElement('input');
    S.sizeInput.type = 'range';
    S.sizeInput.min = String(SIZE_MIN);
    S.sizeInput.max = String(SIZE_MAX);
    S.sizeInput.step = '1';
    S.sizeInput.value = String(S.cur.size);
    S.sizeInput.setAttribute('aria-label', T('fl.panel.sizeAria'));
    S.sizeInput.addEventListener('input', () => {
      const v = Math.max(SIZE_MIN, Math.min(SIZE_MAX, parseInt(S.sizeInput.value, 10) || 34));
      S.cur.size = v;
      if (S.sizeNum) S.sizeNum.textContent = String(v);
      if (S.hooks && S.hooks.setSize) S.hooks.setSize(v);
      persist({ flSize: v });
    });
    rowSize.appendChild(S.sizeInput);
    S.sizeNum = el('span', 'fl-param-num', String(S.cur.size));
    rowSize.appendChild(S.sizeNum);
    wrap.appendChild(rowSize);

    // 翻译 / 罗马音开关
    const rowTr = el('div', 'fl-param-row');
    rowTr.appendChild(el('label', '', T('fl.panel.tr')));
    S.trBtn = el('button', 'fl-panel-btn', T('fl.panel.show'));
    S.trBtn.type = 'button';
    S.trBtn.style.flex = '1';
    S.trBtn.addEventListener('click', () => {
      S.cur.showTr = !S.cur.showTr;
      syncToggles();
      if (S.hooks && S.hooks.setShowTr) S.hooks.setShowTr(S.cur.showTr);
      persist({ flShowTr: S.cur.showTr });
    });
    rowTr.appendChild(S.trBtn);
    wrap.appendChild(rowTr);

    const rowRo = el('div', 'fl-param-row');
    rowRo.appendChild(el('label', '', T('fl.panel.ro')));
    S.roBtn = el('button', 'fl-panel-btn', T('fl.panel.show'));
    S.roBtn.type = 'button';
    S.roBtn.style.flex = '1';
    S.roBtn.addEventListener('click', () => {
      S.cur.showRo = !S.cur.showRo;
      syncToggles();
      if (S.hooks && S.hooks.setShowRo) S.hooks.setShowRo(S.cur.showRo);
      persist({ flShowRo: S.cur.showRo });
    });
    rowRo.appendChild(S.roBtn);
    wrap.appendChild(rowRo);

    return wrap;
  }

  function syncToggles() {
    if (S.trBtn) {
      S.trBtn.textContent = T(S.cur.showTr ? 'fl.panel.show' : 'fl.panel.hide');
      S.trBtn.classList.toggle('on', S.cur.showTr);
    }
    if (S.roBtn) {
      S.roBtn.textContent = T(S.cur.showRo ? 'fl.panel.show' : 'fl.panel.hide');
      S.roBtn.classList.toggle('on', S.cur.showRo);
    }
  }

  /* ---------- 面板骨架 ---------- */

  function build() {
    const panel = el('div', 'fl-panel hidden');
    panel.id = 'fl-panel';

    const head = el('div', 'fl-panel-head');
    head.appendChild(el('span', '', T('fl.panel.title')));
    const close = el('button', 'fl-btn', '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>');
    close.id = 'fl-panel-close';
    close.type = 'button';
    close.title = T('common.close');
    close.setAttribute('aria-label', T('fl.panel.closeAria'));
    close.addEventListener('click', () => closePanel());
    head.appendChild(close);
    panel.appendChild(head);

    const body = el('div', 'fl-panel-body');
    body.appendChild(el('div', 'fl-panel-sec', T('fl.panel.visual')));
    S.listEl = el('div', '');
    for (const def of FlThemes.list()) S.listEl.appendChild(themeCard(def));
    body.appendChild(S.listEl);
    S.paramBox = el('div', 'fl-param-box');
    body.appendChild(S.paramBox);
    body.appendChild(buildLyricSection());
    panel.appendChild(body);

    const foot = el('div', 'fl-panel-foot');
    const reset = el('button', 'fl-panel-btn', T('common.reset'));
    reset.id = 'fl-panel-reset';
    reset.type = 'button';
    reset.addEventListener('click', () => {
      S.cur = { theme: 'lumen', size: 34, showTr: true, showRo: true, reveal: 'all', params: {} };
      if (S.sizeInput) S.sizeInput.value = '34';
      if (S.sizeNum) S.sizeNum.textContent = '34';
      syncThemeCards();
      syncToggles();
      syncReveal();
      buildParams();
      if (S.hooks) {
        if (S.hooks.setTheme) S.hooks.setTheme('lumen');
        if (S.hooks.setSize) S.hooks.setSize(34);
        if (S.hooks.setShowTr) S.hooks.setShowTr(true);
        if (S.hooks.setShowRo) S.hooks.setShowRo(true);
        if (S.hooks.setReveal) S.hooks.setReveal('all');
        // 参数回默认：清空记忆后按默认值重写（fl-stage 侧负责钳制与落变量）
        if (S.hooks.resetParams) S.hooks.resetParams();
      }
      persist({ flTheme: 'lumen', flSize: 34, flShowTr: true, flShowRo: true, flReveal: 'all', flParams: {} });
    });
    foot.appendChild(reset);
    panel.appendChild(foot);

    return panel;
  }

  /* ---------- 开合 ---------- */

  function openPanel() {
    if (!S.panel) return;
    S.panel.classList.remove('hidden');
  }
  function closePanel() {
    if (S.panel) S.panel.classList.add('hidden');
  }
  function togglePanel() {
    if (!S.panel) return;
    if (S.panel.classList.contains('hidden')) openPanel();
    else closePanel();
  }
  function isOpen() { return !!S.panel && !S.panel.classList.contains('hidden'); }

  /** 面板外点击关闭（capture，先于菜单的同名处理器无妨——两者互斥判断） */
  function onDocDown(e) {
    if (!isOpen()) return;
    if (S.panel.contains(e.target)) return;
    const btn = S.stage && S.stage.querySelector('#fl-theme-btn');
    if (btn && btn.contains(e.target)) return;   // 主题按钮自己 toggle
    closePanel();
  }

  /* ---------- 对外 ---------- */

  /**
   * @param {HTMLElement} stage #fl-stage
   * @param {{setTheme:Function,setSize:Function,setShowTr:Function,setShowRo:Function,setReveal:Function,setThemeParam:Function}} hooks
   * @param {{theme:string,size:number,showTr:boolean,showRo:boolean,reveal:string,params:Object}} cur 当前值（来自设置）
   */
  function mount(stage, hooks, cur) {
    S.stage = stage;
    S.hooks = hooks || {};
    S.cur = {
      theme: (cur && cur.theme) || 'lumen',
      size: (cur && typeof cur.size === 'number') ? cur.size : 34,
      showTr: !(cur && cur.showTr === false),
      showRo: !(cur && cur.showRo === false),
      reveal: (cur && REVEAL_OPTS.some((o) => o.id === cur.reveal)) ? cur.reveal : 'all',
      params: (cur && cur.params && typeof cur.params === 'object' && !Array.isArray(cur.params)) ? cur.params : {}
    };
    S.panel = build();
    stage.appendChild(S.panel);
    syncThemeCards();
    syncToggles();
    syncReveal();
    buildParams();
    document.addEventListener('pointerdown', onDocDown, true);
    return { toggle: togglePanel, close: closePanel, isOpen, syncParams, syncReveal: syncRevealFromStage };
  }

  /**
   * 语言切换后重建面板（v10.11）。
   * 面板里除了骨架文案，主题卡与参数滑条的标签也都要换，
   * 整块 rebuild 比逐节点改写可靠；当前主题/字号/译音状态全部原样带入。
   */
  function applyLang() {
    if (!S.panel || !S.stage) return;
    const wasOpen = isOpen();
    const fresh = build();
    S.panel.replaceWith(fresh);
    S.panel = fresh;
    syncThemeCards();
    syncToggles();
    syncReveal();
    buildParams();
    if (wasOpen) fresh.classList.remove('hidden');
  }

  return {
    mount, toggle: togglePanel, close: closePanel, isOpen,
    syncParams, syncReveal: syncRevealFromStage, applyLang
  };
})();
