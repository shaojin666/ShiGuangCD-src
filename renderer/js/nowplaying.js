'use strict';
/* ============================================================
   nowplaying.js —— 正在播放页（自动隐藏标签页 · 并行视图 · 3D 律动歌词 · 传输条）
   ------------------------------------------------------------
   本模块只负责界面，所有行为仍走原有通道：
   1) DOM 只构建一次。切页不重建（旧实现每次 navigate 都 innerHTML=''，
      进度条被重置为 0、歌词滚动位置丢失）。
   2) 上半部舞台可在「标签页」与「封面 + 歌词并排」之间切换；
      标签栏可自动隐藏：静止一会儿后淡出，鼠标靠近即重新浮现（设置可关）。
      两种视图切换时，标签栏里的「唱片 / 歌词」会合并成一个再分开。
   3) 底部传输条常驻：主控绝对居中（1fr auto 1fr，任何窗口宽度都不偏），
      第二行是进度条 + 次级按钮（播放模式 / 并行视图 / 编辑信息 / 出舱）。
   4) 歌词是 3D 排布，并由 visualizer.js 写入的 --beat 驱动"随鼓点震动放大"；
      用户手动滚动时进入「浏览态」：停止自动跟随、自动居中与鼓点缩放，
      并让鼠标附近的歌词行放大，方便阅读；点击某行可跳转到对应时间。
   ============================================================ */

const NowPlaying = (() => {
  const el = document.getElementById('page-nowplaying');

  /** 标签页定义（顺序即显示顺序） */
  const TABS = [
    { id: 'cover', key: 'np.tab.cover' },
    { id: 'lyrics', key: 'np.tab.lyrics' },
    { id: 'tracks', key: 'np.tab.tracks' }
  ];
  const DEFAULT_TAB = 'cover';
  /** 鼠标进入标签栏该半径（px）内才淡入 */
  const REVEAL_RADIUS = 250;
  /** 静止多久后收起标签栏（ms） */
  const HIDE_DELAY = 2600;
  /** 手动滚动歌词后，停留多久回到自动跟随（ms） */
  const MANUAL_LYRIC_MS = 4200;
  /** 鼠标放大镜的影响半径（px） */
  const ZOOM_RADIUS = 150;

  let tabId = DEFAULT_TAB;
  let autoHide = true;
  /** 封面 + 歌词并排 */
  let splitView = false;

  let tabsEl = null;
  let stageEl = null;
  let npDisc = null;
  let npDiscSlot = null;
  let seekInput = null;
  let curTimeEl = null;
  let durTimeEl = null;
  let lyricsBox = null;
  let lrcLines = [];       // {time, el, inner}；逐字模式下由 LyricsView 生成（含 words）
  let trackListEl = null;
  let nowTitleEl = null;
  let nowArtistEl = null;
  /** 逐字模式：当前歌词来自统一模型（lyricsData），行切换/词填充交给 LyricsView */
  let wordMode = false;
  /** 歌词头部的「译 / 音」开关（仅当模型带对应轨时可见） */
  let trBtn = null;
  let roBtn = null;

  let dragging = false;
  let rendered = false;
  let lastTrack = -1;
  let lastLyricsKey = '';
  let activeIdx = -2;
  let hideTimer = null;
  /**
   * 需要持续重新居中的截止时间（Date.now 毫秒）。
   *
   * 为什么需要：标签页/并行切换是**宽度动画**，歌词行在宽度 0 时会按
   * "极窄的换行结果"排版，`offsetTop` 完全是错的。若只在切换瞬间居中一次，
   * 量到的就是窄排版下的偏移 —— 表现为"切过去看到的是当前行下面几句、
   * 且都因为远离 activeIdx 而显得很小"，还得等下一次换行才被拉回来。
   * 所以这里在动画期间每帧重算，宽度稳定后自然就对了。
   */
  let recenterUntil = 0;

  /* ---------- 歌词交互状态 ---------- */
  let manualLyrics = false;      // 浏览态：暂停自动跟随与鼓点缩放
  let manualTimer = null;
  let lrcDownAt = null;          // 区分"点击跳转"与"拖动滚动"
  let zoomY = null;              // 鼠标在歌词区内的 Y
  let zoomRaf = 0;
  let lineGeomCache = null;

  /* ---------- 图标 ---------- */

  function icPlay() {
    return '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
  }
  function icPause() {
    return '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z"/></svg>';
  }
  function icPrev() {
    return '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM20 6v12L9.5 12z"/></svg>';
  }
  function icNext() {
    return '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6v12l10.5-6z"/></svg>';
  }
  function icVol() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">' +
      '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>' +
      '</svg>';
  }
  function icDisc() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">' +
      '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="2.2"/>' +
      '</svg>';
  }
  /** 并行视图：左右两块并排 */
  function icSplit() {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">' +
      '<rect x="2.6" y="4.2" width="7.6" height="15.6" rx="1.4"/>' +
      '<rect x="13.8" y="4.2" width="7.6" height="15.6" rx="1.4"/>' +
      '</svg>';
  }
  /** 沉浸模式：向内收拢 */
  function icImmersive() {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2.6" y="4.2" width="18.8" height="15.6" rx="2"/>' +
      '<path d="M8.4 9.4L6 12l2.4 2.6M15.6 9.4L18 12l-2.4 2.6"/>' +
      '</svg>';
  }
  /** 桌面悬浮歌词：屏幕角上的小窗 */
  function icFloating() {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2.6" y="3.6" width="18.8" height="13" rx="2"/>' +
      '<path d="M8 20.4h8"/>' +
      '</svg>';
  }
  /** v10.8 全屏歌词演出：铺满的屏幕 + 三条歌词线 */
  function icStage() {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2.6" y="3.6" width="18.8" height="16.8" rx="2"/>' +
      '<path d="M7 9.2h10M7 12.6h6.4M7 16h8"/>' +
      '</svg>';
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  /* ---------- LRC 解析 ---------- */

  function parseLrc(text) {
    const out = [];
    if (!text) return out;
    const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const lines = text.split(/\r?\n/);
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
      for (const t of times) out.push({ time: t, text: content });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /* ---------- 标签栏 ---------- */

  function buildTabs() {
    tabsEl = document.createElement('div');
    tabsEl.className = 'np-tabs';
    tabsEl.id = 'np-tabs';
    tabsEl.setAttribute('role', 'tablist');
    tabsEl.setAttribute('aria-label', T('np.tabsAria'));

    // 收起时仍留一条淡提示，鼠标靠近它所在的区域即展开
    const grip = document.createElement('span');
    grip.className = 'np-tabs-grip';
    tabsEl.appendChild(grip);

    for (const t of TABS) {
      const b = document.createElement('button');
      b.className = 'np-tab' + (t.id === tabId ? ' active' : '');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.tab = t.id;
      b.textContent = T(t.key);
      b.addEventListener('click', () => setTab(t.id, true));
      tabsEl.appendChild(b);
    }

    // 并行视图时，"唱片 / 歌词" 合并成的这一个按钮（默认收起为 0 宽）
    const merge = document.createElement('button');
    merge.className = 'np-tab merge';
    merge.type = 'button';
    merge.setAttribute('role', 'tab');
    merge.dataset.tab = 'merge';
    merge.textContent = T('np.tab.merge');
    merge.title = T('np.merge.titleSplit');
    merge.addEventListener('click', () => setTab('merge', true));
    tabsEl.insertBefore(merge, tabsEl.querySelector('[data-tab="tracks"]'));

    return tabsEl;
  }

  /** 按当前 tabId / splitView 统一刷新标签高亮与面板显隐 */
  function applyPanels() {
    const panels = el.querySelectorAll('.np-panel');
    // 并行模式下"曲目"是第三个可切换的视图：此时只显示曲目表，
    // 并行偏好本身保留，切回「唱片 + 歌词」即可恢复并排。
    const showingTracks = tabId === 'tracks';
    for (let i = 0; i < panels.length; i++) {
      const id = panels[i].dataset.panel;
      const on = splitView
        ? (showingTracks ? (id === 'tracks') : (id === 'cover' || id === 'lyrics'))
        : (id === tabId);
      panels[i].classList.toggle('on', on);
    }
    if (!tabsEl) return;
    const btns = tabsEl.querySelectorAll('.np-tab');
    for (let i = 0; i < btns.length; i++) {
      const id = btns[i].dataset.tab;
      let on;
      if (id === 'merge') on = splitView && !showingTracks;
      else on = !splitView && id === tabId;
      btns[i].classList.toggle('active', on);
    }
  }

  /** 切换标签页 */
  function setTab(id, fromUser) {
    if (!rendered) return;
    // 并行模式下浮出的那颗合并按钮：
    //   在曲目页 → 回到「唱片 + 歌词」并排；
    //   已在并排 → 退回分开的标签页。
    if (id === 'merge') {
      if (splitView && tabId === 'tracks') {
        tabId = 'cover';
        applyPanels();
        syncViewChrome();
        lineGeomCache = null;
        requestRecenter();
        centerActiveLine(true);
      } else {
        setSplit(!splitView, fromUser);
      }
      return;
    }
    let found = false;
    for (const t of TABS) if (t.id === id) found = true;
    if (!found) return;
    tabId = id;
    // ★ 切标签不再顺手关掉并行：并行是"布局偏好"，标签是"看哪一块"，
    //   两者分开后，在并排状态下点「曲目」也能正常切换。
    applyPanels();
    syncViewChrome();
    if (id === 'lyrics' && !splitView) { requestRecenter(); centerActiveLine(true); }
    if (id === 'tracks') renderTracks();
    if (fromUser) showTabs();
  }

  /** 封面 / 歌词并排显示 */
  function setSplit(on, fromUser) {
    splitView = !!on;
    if (!rendered) return;
    tabsEl.classList.toggle('split', splitView);
    el.classList.toggle('split', splitView);
    applyPanels();
    syncViewChrome();
    if (splitView && tabId !== 'tracks') {
      requestRecenter();
      if (!manualLyrics) centerActiveLine(true);
      lineGeomCache = null;
    }
    if (fromUser) showTabs();
    if (App.setSplitView) App.setSplitView(splitView, true);
  }

  /** 并行视图按钮 / 合并按钮的文案与高亮跟随当前状态 */
  function syncViewChrome() {
    const btn = document.getElementById('np-split');
    if (btn) {
      btn.classList.toggle('on', splitView);
      btn.title = T(splitView ? 'np.split.titleOn' : 'np.split.titleOff');
    }
    const merge = tabsEl ? tabsEl.querySelector('[data-tab="merge"]') : null;
    if (merge) {
      merge.title = (splitView && tabId === 'tracks')
        ? T('np.merge.titleBack')
        : (splitView ? T('np.merge.titleSplit') : T('np.merge.titleJoin'));
    }
    if (!splitView && tabId === 'lyrics' && !manualLyrics) centerActiveLine(true);
  }

  /* ---------- 标签栏自动隐藏 ---------- */

  function showTabs() {
    if (!rendered) return;
    el.classList.remove('tabs-away');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (!autoHide) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (autoHide) el.classList.add('tabs-away');
    }, HIDE_DELAY);
  }

  function hideTabsNow() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    el.classList.add('tabs-away');
  }

  /** 用户在设置里切换"自动隐藏" */
  function setAutoHide(on) {
    autoHide = on !== false;
    if (!rendered) return;
    if (autoHide) showTabs();
    else {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      el.classList.remove('tabs-away');
    }
  }

  /** 鼠标移动 → 判断是否靠近标签栏 */
  function onMouseMove(e) {
    if (!rendered || !tabsEl) return;
    if (App.state.page !== 'nowplaying') return;
    if (!autoHide) return;
    const r = tabsEl.getBoundingClientRect();
    if (!r.width) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = Math.max(0, Math.abs(e.clientX - cx) - r.width / 2);
    const dy = Math.max(0, Math.abs(e.clientY - cy) - r.height / 2);
    if (Math.sqrt(dx * dx + dy * dy) <= REVEAL_RADIUS) showTabs();
  }

  function wireTabsMouse() {
    if (!tabsEl || tabsEl.dataset.wired === '1') return;
    tabsEl.dataset.wired = '1';
    document.addEventListener('mousemove', onMouseMove, { passive: true });
  }

  /* ---------- 渲染 ---------- */

  function render() {
    el.innerHTML = '';
    el.classList.toggle('split', splitView);

    const wrap = document.createElement('div');
    wrap.className = 'np-wrap';

    wrap.appendChild(buildTabs());

    /* ---- 舞台：标签页 / 并排视图共用 ---- */
    stageEl = document.createElement('div');
    stageEl.className = 'np-stage';

    /* 唱片页 */
    const pCover = document.createElement('section');
    pCover.className = 'np-panel np-panel-cover';
    pCover.dataset.panel = 'cover';

    npDiscSlot = document.createElement('div');
    npDiscSlot.className = 'np-disc-slot stopped';
    const glow = document.createElement('div');
    glow.className = 'np-disc-glow';
    npDisc = document.createElement('div');
    npDisc.className = 'np-disc';
    npDisc.innerHTML =
      '<div class="disc-spin">' +
      '<div class="disc-face"></div>' +
      '<div class="disc-hole"></div>' +
      '</div>';
    npDiscSlot.appendChild(glow);
    npDiscSlot.appendChild(npDisc);
    pCover.appendChild(npDiscSlot);
    npDiscSlot.addEventListener('click', () => App.togglePlay());

    const info = document.createElement('div');
    info.className = 'np-info';
    info.innerHTML =
      '<div class="np-title" id="np-title">—</div>' +
      '<div class="np-artist" id="np-artist"></div>' +
      '<div class="np-albumline" id="np-albumline"></div>' +
      '<div class="np-trackline" id="np-trackline"></div>';
    pCover.appendChild(info);
    stageEl.appendChild(pCover);

    /* 歌词页 */
    const pLyrics = document.createElement('section');
    pLyrics.className = 'np-panel np-panel-lyrics';
    pLyrics.dataset.panel = 'lyrics';
    const lHead = document.createElement('div');
    lHead.className = 'np-lyrics-head';
    const headText = document.createElement('span');
    headText.className = 'np-lyrics-head-text';
    headText.textContent = T('np.lyricsHead');
    const headToggles = document.createElement('span');
    headToggles.className = 'lrc-toggles';
    trBtn = document.createElement('button');
    trBtn.type = 'button';
    trBtn.className = 'lrc-tg on';
    trBtn.dataset.k = 'tr';
    trBtn.textContent = T('np.tr');
    trBtn.title = T('np.tr.show');
    roBtn = document.createElement('button');
    roBtn.type = 'button';
    roBtn.className = 'lrc-tg';
    roBtn.dataset.k = 'ro';
    roBtn.textContent = T('np.ro');
    roBtn.title = T('np.ro.show');
    headToggles.appendChild(trBtn);
    headToggles.appendChild(roBtn);
    lHead.appendChild(headText);
    lHead.appendChild(headToggles);
    lyricsBox = document.createElement('div');
    lyricsBox.className = 'np-lyrics no-ro';
    pLyrics.appendChild(lHead);
    pLyrics.appendChild(lyricsBox);
    stageEl.appendChild(pLyrics);

    /* 曲目页 */
    const pTracks = document.createElement('section');
    pTracks.className = 'np-panel np-panel-tracks';
    pTracks.dataset.panel = 'tracks';
    const tHead = document.createElement('div');
    tHead.className = 'np-lyrics-head';
    tHead.textContent = T('np.tracksHead');
    trackListEl = document.createElement('div');
    trackListEl.className = 'np-tracklist';
    pTracks.appendChild(tHead);
    pTracks.appendChild(trackListEl);
    stageEl.appendChild(pTracks);

    wireLyricsBox();
    wrap.appendChild(stageEl);

    /* ---- 传输条（常驻，不随标签页切换） ---- */
    const bar = document.createElement('div');
    bar.className = 'np-transport';

    /* 左：迷你唱片 + 曲目信息 */
    const nowBox = document.createElement('div');
    nowBox.className = 'np-now';
    const mini = document.createElement('div');
    mini.className = 'np-mini-disc';
    mini.innerHTML =
      '<div class="disc-spin">' +
      '<div class="disc-face"></div>' +
      '<div class="disc-hole"></div>' +
      '</div>';
    mini.addEventListener('click', () => App.togglePlay());
    const nowText = document.createElement('div');
    nowText.className = 'np-now-text';
    nowTitleEl = document.createElement('div');
    nowTitleEl.className = 'np-now-title';
    nowTitleEl.id = 'np-now-title';
    nowTitleEl.textContent = '—';
    nowArtistEl = document.createElement('div');
    nowArtistEl.className = 'np-now-artist';
    nowArtistEl.id = 'np-now-artist';
    nowText.appendChild(nowTitleEl);
    nowText.appendChild(nowArtistEl);
    nowBox.appendChild(mini);
    nowBox.appendChild(nowText);

    /* 中：主控（1fr auto 1fr 保证绝对居中） */
    const center = document.createElement('div');
    center.className = 'np-center';
    const controls = document.createElement('div');
    controls.className = 'np-controls';
    controls.innerHTML =
      '<button class="ctl-btn" id="np-prev" aria-label="' + T('np.aria.prev') + '">' + icPrev() + '</button>' +
      '<button class="ctl-btn primary" id="np-play" aria-label="' + T('np.aria.play') + '">' + icPlay() + '</button>' +
      '<button class="ctl-btn" id="np-next" aria-label="' + T('np.aria.next') + '">' + icNext() + '</button>';
    center.appendChild(controls);

    /* 右上：桌面悬浮歌词 + 音量 + 沉浸 */
    const tools = document.createElement('div');
    tools.className = 'np-tools';
    const btnFloat = document.createElement('button');
    btnFloat.className = 'mode-btn icon-only';
    btnFloat.type = 'button';
    btnFloat.id = 'np-floating';
    btnFloat.title = T('np.tip.floating');
    btnFloat.setAttribute('aria-label', T('np.aria.floating'));
    btnFloat.innerHTML = icFloating();
    btnFloat.addEventListener('click', () => {
      const on = App.state.settings.floatingLyrics === true;
      window.cd.invoke(on ? 'floating:close' : 'floating:open').catch(() => { /* 忽略 */ });
    });
    tools.appendChild(btnFloat);
    const volBox = document.createElement('div');
    volBox.className = 'vol-wrap';
    volBox.id = 'np-vol';
    volBox.innerHTML = icVol() +
      '<input type="range" class="slider" id="np-volume" min="0" max="100" value="70" />';
    tools.appendChild(volBox);
    const btnImm = document.createElement('button');
    btnImm.className = 'mode-btn icon-only';
    btnImm.type = 'button';
    btnImm.id = 'np-immersive';
    btnImm.title = T('np.tip.immersive');
    btnImm.setAttribute('aria-label', T('np.aria.immersive'));
    btnImm.innerHTML = icImmersive();
    btnImm.addEventListener('click', () => {
      if (Immersive) Immersive.toggle();
    });
    tools.appendChild(btnImm);

    /* v10.8：全屏歌词演出入口（铺满整个软件窗口，旧歌词界面停渲）。
       放在工具组最右（沉浸模式旁）——与"桌面悬浮歌词"同属"歌词
       呈现方式"一族。演出层自身负责一切交互，这里只发打开指令。 */
    const btnStage = document.createElement('button');
    btnStage.className = 'mode-btn icon-only';
    btnStage.type = 'button';
    btnStage.id = 'np-fl-stage';
    btnStage.title = T('np.tip.stage');
    btnStage.setAttribute('aria-label', T('np.aria.stage'));
    btnStage.innerHTML = icStage();
    btnStage.addEventListener('click', () => {
      if (window.FlStage && typeof FlStage.open === 'function') FlStage.open();
    });
    tools.appendChild(btnStage);

    /* 下：进度条 + 次级按钮 */
    const sub = document.createElement('div');
    sub.className = 'np-sub';
    const seek = document.createElement('div');
    seek.className = 'np-seek';
    curTimeEl = document.createElement('span');
    curTimeEl.className = 'np-time tabular';
    curTimeEl.textContent = '0:00';
    seekInput = document.createElement('input');
    seekInput.type = 'range';
    seekInput.className = 'slider';
    seekInput.min = 0;
    seekInput.max = 1000;
    // 默认 step=1 会让拖动只能整秒跳，且赋值 12.345 被静默截断
    seekInput.step = '0.05';
    seekInput.value = 0;
    durTimeEl = document.createElement('span');
    durTimeEl.className = 'np-time tabular';
    durTimeEl.textContent = '0:00';
    seek.appendChild(curTimeEl);
    seek.appendChild(seekInput);
    seek.appendChild(durTimeEl);

    const secondary = document.createElement('div');
    secondary.className = 'np-secondary';
    secondary.innerHTML =
      '<button class="mode-btn" id="np-mode">' + T('mode.normal') + '</button>' +
      '<button class="mode-btn" id="np-split" title="' + T('np.split.titleOff') + '">' + icSplit() + '<span>' + T('np.btn.split') + '</span></button>' +
      '<button class="mode-btn" id="np-edit">' + T('np.btn.edit') + '</button>' +
      '<button class="mode-btn" id="np-eject">' + icDisc() + T('np.btn.eject') + '</button>';
    sub.appendChild(seek);
    sub.appendChild(secondary);

    bar.appendChild(nowBox);
    bar.appendChild(center);
    bar.appendChild(tools);
    bar.appendChild(sub);
    wrap.appendChild(bar);
    el.appendChild(wrap);

    /* ---- 事件 ---- */
    document.getElementById('np-prev').addEventListener('click', () => App.prev());
    document.getElementById('np-next').addEventListener('click', () => App.next());
    document.getElementById('np-play').addEventListener('click', () => App.togglePlay());
    document.getElementById('np-mode').addEventListener('click', () => App.cycleMode());
    document.getElementById('np-split').addEventListener('click', () => setSplit(!splitView, true));
    document.getElementById('np-edit').addEventListener('click', () => Edit.open());
    document.getElementById('np-eject').addEventListener('click', () => App.eject());

    /* 进度条：拖动期间只更新预览，松手才提交定位 */
    seekInput.addEventListener('pointerdown', () => {
      dragging = true;
      Transport.beginSeek(parseFloat(seekInput.value));
    });
    seekInput.addEventListener('input', () => {
      const sec = parseFloat(seekInput.value);
      dragging = true;
      Transport.previewSeek(sec);
      if (curTimeEl) curTimeEl.textContent = fmt(sec);
      highlight(sec);
    });
    const commit = () => {
      if (!dragging) return;
      dragging = false;
      App.seek(parseFloat(seekInput.value));
    };
    seekInput.addEventListener('change', commit);
    seekInput.addEventListener('pointerup', commit);
    seekInput.addEventListener('pointercancel', () => {
      if (!dragging) return;
      dragging = false;
      Transport.cancelSeek();
    });
    seekInput.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End') {
        commit();
      }
    });

    const vol = document.getElementById('np-volume');
    vol.addEventListener('input', () => {
      App.setVolume(parseInt(vol.value, 10) / 100);
    });

    wireSliderHint();

    wireTabsMouse();
    rendered = true;
    lastTrack = -1;
    lastLyricsKey = '';
    activeIdx = -2;
    applyPanels();
    syncViewChrome();
    showTabs();
    syncState();
  }

  /**
   * 语言切换后整页重建（v10.11）。
   * 播放页 DOM 全是运行时生成的，改语言不能只改文本 —— 必须重建；
   * render() 末尾会 syncState()，把当前碟 / 曲目 / 歌词 / 播放态 / 音量
   * 全部回填，播放链路（Transport / 引擎）完全不参与，音乐不中断。
   */
  function rerender() {
    render();
  }

  /** 幂等渲染：只在首次构建 DOM，之后仅回填状态 */
  function ensureRendered() {
    if (!rendered) { render(); return; }
    syncState();
  }

  /* ---------- 滑块悬浮提示 + 音量滚轮（v10.6） ---------- */

  /** 取滑块横向比例（0~1），clamp 在轨道内 */
  function sliderRatio(input, clientX) {
    const r = input.getBoundingClientRect();
    if (!r.width) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }

  /**
   * 进度条 / 音量条的精准可视化（v10.6，用户需求第 3 条）：
   * 鼠标在条上移动时，光标上方实时显示对应位置的时间（进度）或
   * 音量百分比，随鼠标左右移动；音量条额外支持滚轮调速
   * （每格 ±4%，调完在当前位置浮一下读数）。
   */
  function wireSliderHint() {
    let hint = null;
    const show = (x, y, text) => {
      if (!text) return;
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'slider-hint';
        document.body.appendChild(hint);
      }
      hint.textContent = text;
      hint.style.left = x + 'px';
      hint.style.top = y + 'px';
      hint.classList.add('on');
    };
    const hide = () => { if (hint) hint.classList.remove('on'); };

    /* 进度条：提示目标时间（时长未知时不弹） */
    if (seekInput) {
      seekInput.addEventListener('mousemove', (e) => {
        const dur = parseFloat(seekInput.max) || 0;
        if (dur <= 0) { hide(); return; }
        const sec = sliderRatio(seekInput, e.clientX) * dur;
        const r = seekInput.getBoundingClientRect();
        show(e.clientX, r.top - 6, fmt(sec));
      });
      seekInput.addEventListener('mouseleave', hide);
    }

    /* 音量条：提示音量 + 滚轮调速 */
    const vol = document.getElementById('np-volume');
    if (vol) {
      const hintAt = (clientX, text) => {
        const r = vol.getBoundingClientRect();
        const x = clientX == null
          ? r.left + r.width * ((parseFloat(vol.value) || 0) / 100)
          : clientX;
        show(x, r.top - 6, text);
      };
      vol.addEventListener('mousemove', (e) => {
        if (vol.disabled) { hide(); return; }
        hintAt(e.clientX, Math.round(sliderRatio(vol, e.clientX) * 100) + '%');
      });
      vol.addEventListener('mouseleave', hide);
      vol.addEventListener('wheel', (e) => {
        if (vol.disabled) return;
        e.preventDefault();   // 别把页面滚动链走
        const cur = parseFloat(vol.value) || 0;
        const next = Math.max(0, Math.min(100, cur + (e.deltaY < 0 ? 4 : -4)));
        if (next === cur) return;
        vol.value = String(next);
        App.setVolume(next / 100);
        hintAt(null, next + '%');
        clearTimeout(vol._hintTimer);
        vol._hintTimer = setTimeout(hide, 900);
      }, { passive: false });
    }
  }

  /* 用当前状态回填整个正在播放页（构建后 / 切回本页时调用） */
  function syncState() {
    if (!rendered) return;
    if (App.state.metadata) {
      setDisc(App.state.metadata);
      setTrack(Transport.track, Transport.trackCount || App.state.metadata.trackCount || 1);
      setLyrics(App.state.metadata, Transport.track);
    }
    setPlayState(Transport.status);
    setVolumeEnabled(App.state.volumeSupported !== false);
    setVolumeValue(typeof App.state.volume === 'number' ? App.state.volume : 0.7);
    const snap = Transport.snapshot();
    tick(snap.positionSec, snap.durationSec);
    const modeBtn = document.getElementById('np-mode');
    if (modeBtn) {
      const label = App.modeLabel ? App.modeLabel() : '';
      if (label && modeBtn.textContent !== label) modeBtn.textContent = label;
    }
    if (tabId === 'tracks') renderTracks();
    syncImmersiveBtn();
    syncFloatingBtn();
    // 切回本页时先亮一下标签栏，随后按设置自动收起
    showTabs();
  }

  /* ---------- 歌词交互 ---------- */

  function wireLyricsBox() {
    if (!lyricsBox) return;

    /* 逐字渲染引擎：位置从 Transport 读，行切换时回调解耦给本模块 */
    if (window.LyricsView) {
      LyricsView.attach(lyricsBox, {
        getPos: () => Transport.positionSec(),
        onLine: (idx) => {
          activeIdx = idx;
          lineGeomCache = null;
          centerActiveLine(false);
          emitLine();
        }
      });
    }

    /* 「译 / 音」开关：只切容器 class，显隐规则全在 CSS 里 */
    const wireTg = (btn, cls) => {
      if (!btn) return;
      btn.addEventListener('click', () => {
        const on = !lyricsBox.classList.contains(cls);
        lyricsBox.classList.toggle(cls, on);
        btn.classList.toggle('on', !on);
        btn.title = T(btn.dataset.k === 'tr'
          ? (on ? 'np.tr.hide' : 'np.tr.show')
          : (on ? 'np.ro.hide' : 'np.ro.show'));
        // 行高变了，几何缓存作废；当前行动态跟随一次
        lineGeomCache = null;
        requestRecenter(400);
        centerActiveLine(true);
      });
    };
    wireTg(trBtn, 'no-tr');
    wireTg(roBtn, 'no-ro');

    // 用户自己滚动（滚轮 / 触摸 / 拖滚动条）→ 进入浏览态
    lyricsBox.addEventListener('wheel', () => setManualLyrics(true), { passive: true });
    lyricsBox.addEventListener('touchmove', () => setManualLyrics(true), { passive: true });
    lyricsBox.addEventListener('pointerdown', (e) => {
      lrcDownAt = { x: e.clientX, y: e.clientY, t: Date.now() };
      setManualLyrics(true);
    });
    // 点击某一行 → 跳转到该行时间（拖动滚动不算点击）
    lyricsBox.addEventListener('pointerup', (e) => {
      const down = lrcDownAt;
      lrcDownAt = null;
      if (!down) return;
      const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
      if (moved > 6 || Date.now() - down.t > 600) return;
      let line = e.target;
      while (line && line !== lyricsBox && !(line.classList && line.classList.contains('lrc-line'))) {
        line = line.parentElement;
      }
      if (!line || line === lyricsBox) return;
      let rec = null;
      for (let i = 0; i < lrcLines.length; i++) if (lrcLines[i].el === line) rec = lrcLines[i];
      if (!rec || rec.time == null) return;
      setManualLyrics(false);
      App.seek(rec.time);
      Toast(T('toast.jumpedTo', { time: fmt(rec.time) }));
    });

    // 鼠标放大镜：浏览态下让鼠标附近的歌词行更大
    lyricsBox.addEventListener('pointermove', (e) => {
      if (!manualLyrics) return;
      zoomY = e.clientY;
      scheduleZoom();
    }, { passive: true });
    lyricsBox.addEventListener('pointerleave', () => {
      zoomY = null;
      applyZoom();
    }, { passive: true });
  }

  function setManualLyrics(on) {
    manualLyrics = !!on;
    if (!lyricsBox) return;
    lyricsBox.classList.toggle('manual', manualLyrics);
    if (manualTimer) { clearTimeout(manualTimer); manualTimer = null; }
    if (manualLyrics) {
      manualTimer = setTimeout(() => setManualLyrics(false), MANUAL_LYRIC_MS);
    } else {
      zoomY = null;
      lineGeomCache = null;
      applyZoom();
      requestRecenter(700);
      centerActiveLine(true);
    }
  }

  function scheduleZoom() {
    if (zoomRaf) return;
    zoomRaf = requestAnimationFrame(applyZoom);
  }

  /** 歌词行的垂直位置（offsetTop 相对 .np-lyrics，与滚动无关） */
  function lineGeom() {
    if (lineGeomCache && lineGeomCache.length === lrcLines.length) return lineGeomCache;
    lineGeomCache = lrcLines.map((r) => ({
      el: r.el,
      mid: r.el.offsetTop + r.el.offsetHeight / 2
    }));
    return lineGeomCache;
  }

  function applyZoom() {
    zoomRaf = 0;
    const geom = lineGeom();
    if (!geom.length) return;
    const boxRect = lyricsBox.getBoundingClientRect();
    const y = (zoomY == null) ? null : (zoomY - boxRect.top + lyricsBox.scrollTop);
    for (let i = 0; i < geom.length; i++) {
      const el = geom[i].el;
      let mz = 0;
      if (y != null && manualLyrics) {
        mz = 1 - Math.abs(geom[i].mid - y) / ZOOM_RADIUS;
        mz = mz > 0 ? (mz > 1 ? 1 : mz) : 0;
      }
      const v = mz.toFixed(2);
      if (el.dataset.mz !== v) {
        el.dataset.mz = v;
        el.style.setProperty('--mz', v);
      }
    }
  }

  /* ---------- 歌词上下文（供桌面悬浮窗订阅）---------- */

  let lineListener = null;

  /** 注册"当前行变化"回调；桌面悬浮歌词用它更新自己 */
  function setLineListener(fn) {
    lineListener = typeof fn === 'function' ? fn : null;
  }

  function emitLine() {
    if (!lineListener) return;
    const at = activeIdx;
    const pick = (i) => (lrcLines[i] && lrcLines[i].inner ? lrcLines[i].inner.textContent : '');
    const rec = (at >= 0 && at < lrcLines.length) ? lrcLines[at] : null;
    const info = {
      index: at,
      text: rec ? pick(at) : '',
      prev: at > 0 ? pick(at - 1) : '',
      next: (at >= 0 && at + 1 < lrcLines.length) ? pick(at + 1) : '',
      total: lrcLines.length,
      playing: Transport.status === 'playing',
      // 推送时刻的播放位置：悬浮窗用它把词的绝对时间换算成 CSS 动画延迟
      at: (typeof Transport.positionSec === 'function') ? Transport.positionSec() : null
    };
    /* 逐字增强（悬浮窗用）：当前行的译文 + 罗马音 + 词级时间轴 +
       对唱（背景人声）行。悬浮窗拿 words/t/e 自己跑 CSS 补间动画做卡拉OK——
       不为逐字效果开一条高频 IPC（透明置顶窗口 + 跨进程推送，
       每帧一发会把 CPU 拖死，且动画本身不需要精确时钟）。
       v10.7：附带歌曲级对唱结构（duet）与行/条目的 agent，悬浮窗据此
       复刻主界面的 amll 排版（主唱靠右、对唱靠左、bg 跟随宿主）。 */
    if (rec) {
      if (rec.tr) info.tr = rec.tr;
      if (rec.ro) info.ro = rec.ro;
      if (rec.agent) info.agent = rec.agent;
      if (rec.words && rec.words.length) {
        info.t = rec.t;
        info.e = rec.e;
        info.words = rec.words.map((w) => ({ t: w.t, e: w.e, x: w.el.textContent }));
      }
      /* 对唱行（v10.6）：每条带给唱文本 + 词级时间轴 + agent（v10.7），
         悬浮窗按 agent 与 duet.mainAgent 的比较决定左右。 */
      if (rec.bgs && rec.bgs.length) {
        info.bg = rec.bgs.map((b) => ({
          text: b.el.textContent,
          t: b.t,
          e: b.e,
          agent: b.agent || '',
          words: (b.words && b.words.length)
            ? b.words.map((w) => ({ t: w.t, e: w.e, x: w.el.textContent }))
            : null
        }));
      }
    }
    if (window.LyricsView && typeof LyricsView.duetInfo === 'function') {
      const d = LyricsView.duetInfo();
      if (d && d.hasDuet) info.duet = { has: true, main: d.mainAgent };
    }
    try { lineListener(info); } catch (e) { /* 单个订阅者出错不影响其它 */ }
  }

  /* ---------- 数据 ---------- */

  function setDisc(meta) {
    if (!npDisc) return;
    const faces = el.querySelectorAll('.np-disc .disc-face, .np-mini-disc .disc-face');
    if (!faces.length) return;
    const url = (meta && meta.hasCover)
      ? `cover://${encodeURIComponent(meta.signature)}/`
      : '';
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i];
      if (url) {
        face.style.backgroundImage = `url("${url}")`;
        face.classList.add('has-cover');
      } else {
        face.style.backgroundImage = '';
        face.classList.remove('has-cover');
      }
    }
  }

  function setTrack(n, total) {
    if (!rendered) return;
    const md = App.state.metadata;
    const tr = md && md.tracks && md.tracks.find((t) => t.number === n);
    const title = document.getElementById('np-title');
    const artist = document.getElementById('np-artist');
    const albumline = document.getElementById('np-albumline');
    const line = document.getElementById('np-trackline');
    const nameText = (tr && tr.title) ? tr.title : (md ? (md.album || T('common.unknownAlbum')) : '—');
    const nameArtist = (tr && tr.artist) ? tr.artist : (md ? (md.artist || '') : '');
    const count = total || (md ? md.trackCount : 1) || 1;
    if (line) line.textContent = 'TRACK ' + n + ' / ' + count;
    if (title) title.textContent = nameText;
    if (artist) artist.textContent = nameArtist;
    if (nowTitleEl) nowTitleEl.textContent = nameText;
    if (nowArtistEl) nowArtistEl.textContent = nameArtist;
    if (albumline) {
      const parts = [];
      if (md && md.year) parts.push(String(md.year));
      if (md && md.album) parts.push(md.album);
      albumline.textContent = parts.join(' · ');
    }
    const changed = lastTrack !== n;
    lastTrack = n;
    if (changed && trackListEl) markCurrentTrack(n);
    if (changed) renderTracksIfEmpty();
  }

  /** 曲目页：只读展示 + 点击切轨，仍走原有 App.playTrack 通道 */
  function renderTracks() {
    if (!trackListEl) return;
    const md = App.state.metadata;
    const toc = App.state.toc;
    const rows = [];
    const count = (toc && toc.tracks && toc.tracks.length)
      ? toc.tracks.length
      : ((md && md.tracks && md.tracks.length) ? md.tracks.length : ((md && md.trackCount) || 0));
    for (let n = 1; n <= count; n++) {
      const t = (md && md.tracks) ? md.tracks.find((x) => x.number === n) : null;
      const tt = (toc && toc.tracks) ? toc.tracks.find((x) => x.number === n) : null;
      let dur = 0;
      if (tt && tt.endFrame > tt.startFrame) dur = (tt.endFrame - tt.startFrame) / 75;
      else if (t && t.durationSec > 0) dur = t.durationSec;
      rows.push({
        n: n,
        title: (t && t.title) ? t.title : T('common.trackNo', { n: n }),
        dur: dur,
        playable: !(tt && tt.audio === false)
      });
    }
    trackListEl.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'lrc-empty';
      empty.textContent = T('np.empty.noTracks');
      trackListEl.appendChild(empty);
      return;
    }
    for (const r of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'np-track';
      row.dataset.track = String(r.n);
      if (r.n === Transport.track) row.classList.add('current');
      const num = document.createElement('span');
      num.className = 'np-track-num tabular';
      num.textContent = String(r.n).padStart(2, '0');
      const name = document.createElement('span');
      name.className = 'np-track-name';
      name.textContent = r.title;
      const dur = document.createElement('span');
      dur.className = 'np-track-dur tabular';
      dur.textContent = r.dur > 0 ? fmt(r.dur) : '--:--';
      row.appendChild(num);
      row.appendChild(name);
      row.appendChild(dur);
      if (r.playable) {
        row.addEventListener('click', () => App.playTrack(r.n));
      } else {
        row.classList.add('disabled');
      }
      trackListEl.appendChild(row);
    }
  }

  function renderTracksIfEmpty() {
    if (!trackListEl) return;
    if (trackListEl.querySelector('.np-track') || trackListEl.querySelector('.lrc-empty')) return;
    renderTracks();
  }

  function markCurrentTrack(n) {
    if (!trackListEl) return;
    const rows = trackListEl.querySelectorAll('.np-track');
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('current', rows[i].dataset.track === String(n));
    }
  }

  /**
   * 渲染歌词。默认做"同轨不重渲染"保护：
   * 旧实现每次 cd:state 都重建歌词 DOM，导致滚动位置被反复拉回顶部。
   *
   * 两条路径：
   *   1) tr.lyricsData 存在（统一模型，主进程降级链产物）→ LyricsView 渲染：
   *      词级填充 / 翻译 / 罗马音 / 对唱 bg / 间奏占位全都有；
   *   2) 只有经典 LRC 字符串 → 旧 parseLrc 路径（行级，行为与以前完全一致）。
   */
  function setLyrics(meta, trackNumber, force) {
    if (!lyricsBox) return;
    const key = (meta && meta.signature ? meta.signature : '?') + '#' + trackNumber;
    if (!force && key === lastLyricsKey) return;
    lastLyricsKey = key;

    lyricsBox.innerHTML = '';
    if (window.LyricsView) LyricsView.clear();
    lrcLines = [];
    lineGeomCache = null;
    activeIdx = -2;
    wordMode = false;
    const tr = meta && meta.tracks && meta.tracks.find((t) => t.number === trackNumber);
    const data = tr && tr.lyricsData;
    if (window.LyricsView && data && Array.isArray(data.lines) && data.lines.length) {
      /* ---------- 路径 1：统一歌词模型（逐字） ---------- */
      lrcLines = LyricsView.load(data);
      wordMode = LyricsView.isWordMode();
      activeIdx = -1;
      applyLyricToggles(data);
      // 首帧之前先按当前位置画一次（RAF 下一帧也会画，幂等）
      try { LyricsView.update(Transport.positionSec()); } catch (e) { /* 忽略 */ }
      lyricsBox.scrollTop = 0;
      requestRecenter(1200);
      if (tabId === 'tracks') renderTracks();
      emitLine();
      return;
    }
    applyLyricToggles(null);

    const lrc = tr && tr.lyrics;
    if (!lrc) {
      const empty = document.createElement('div');
      empty.className = 'lrc-empty';
      empty.textContent = T('np.empty.noLyrics');
      lyricsBox.appendChild(empty);
      // ★ 换碟 / 重新加载歌词后必须通知一次（空的）。
      //   emitLine() 只在 highlight() 发现"行号变了"时才被调用，
      //   换碟时行号是从 -2 重置的，若不主动发一次，
      //   桌面悬浮歌词会一直停在这一首的旧歌词上，直到新歌唱到下一句。
      emitLine();
      return;
    }
    const mkLine = (text) => {
      const d = document.createElement('div');
      d.className = 'lrc-line';
      const inner = document.createElement('span');
      inner.className = 'lrc-inner';
      inner.textContent = text;
      d.appendChild(inner);
      lyricsBox.appendChild(d);
      return { el: d, inner: inner };
    };
    const parsed = parseLrc(lrc);
    if (tr.lyricsSynced && parsed.length) {
      for (const p of parsed) {
        const rec = mkLine(p.text || '·');
        rec.time = p.time;
        lrcLines.push(rec);
      }
    } else {
      // 纯文本歌词：没有时间轴，按序号给一个向后递减的景深
      let i = 0;
      for (const raw of lrc.split(/\r?\n/)) {
        const t = raw.replace(/\[[^\]]*\]/g, '').trim();
        if (!t) continue;
        const rec = mkLine(t);
        rec.time = null;
        const d = Math.min(8, i);
        rec.el.style.setProperty('--d', String(d));
        rec.el.style.setProperty('--ad', String(d));
        lrcLines.push(rec);
        i++;
      }
    }
    lyricsBox.scrollTop = 0;
    requestRecenter(1200);
    if (tabId === 'tracks') renderTracks();
    // 同上：歌词重新加载后先发一次空的，把桌面悬浮窗的旧内容清掉
    emitLine();
  }

  /**
   * 按模型内容刷新「译 / 音」开关的可见性。
   * 模型没有对应轨时按钮直接隐藏（不留给用户按了没反应的开关）。
   */
  function applyLyricToggles(data) {
    const hasTr = !!(window.LyricsView && LyricsView.hasTr(data));
    const hasRo = !!(window.LyricsView && LyricsView.hasRo(data));
    if (trBtn) trBtn.style.display = hasTr ? '' : 'none';
    if (roBtn) roBtn.style.display = hasRo ? '' : 'none';
    if (!hasTr && lyricsBox) lyricsBox.classList.remove('no-tr');
    if (!hasRo && lyricsBox) lyricsBox.classList.add('no-ro');
  }

  function tick(posSec, durSec) {
    /* v10.8：全屏歌词演出层打开时，本界面整体 display:none（见
       fl-stage.css 的 html.fl-active 规则）。这里再显式短路一次，
       避免 120ms 心跳继续驱动隐藏 DOM 的读写（双保险）。 */
    if (window.FlStage && FlStage.isOpen()) return;
    // 布局动画期间持续把当前行拉回中间（宽度变了 offsetTop 就变了）
    if (Date.now() < recenterUntil) {
      lineGeomCache = null;
      centerActiveLine(true);
    }
    if (!seekInput) return;
    const dur = Math.max(0, Number(durSec) || 0);
    const wantMax = dur > 0 ? String(dur) : '1';
    if (seekInput.max !== wantMax) seekInput.max = wantMax;

    if (!dragging) {
      const p = Math.max(0, Math.min(Number(posSec) || 0, dur || Number(posSec) || 0));
      if (Math.abs((parseFloat(seekInput.value) || 0) - p) > 0.02) seekInput.value = String(p);
      const label = fmt(p);
      if (curTimeEl && curTimeEl.textContent !== label) curTimeEl.textContent = label;
      highlight(p);
    }
    const d = fmt(dur);
    if (durTimeEl && durTimeEl.textContent !== d) durTimeEl.textContent = d;
  }

  /** 换行时才动 DOM：更新高亮 + 3D 景深 + 居中 */
  function highlight(posSec) {
    // v10.8：演出层接管期间，旧歌词引擎整段停跑（同 tick 守卫）
    if (window.FlStage && FlStage.isOpen()) return;
    if (!lrcLines.length || !lyricsBox) return;
    if (wordMode) {
      /* 逐字模式：行切换与词填充由 LyricsView 的 RAF 循环驱动（60fps），
       * 心跳（8fps）这里也调一次——update 对相同位置幂等，
       * 保证暂停后拖进度条能立刻刷新，双通道调用无副作用。 */
      if (window.LyricsView) LyricsView.update(posSec);
      return;
    }
    let idx = -1;
    for (let i = 0; i < lrcLines.length; i++) {
      if (lrcLines[i].time == null) break;
      if (lrcLines[i].time <= posSec + 0.05) idx = i;
      else break;
    }
    if (idx === activeIdx) return;
    activeIdx = idx;
    for (let i = 0; i < lrcLines.length; i++) {
      const el = lrcLines[i].el;
      const on = i === idx;
      if (el.classList.contains('active') !== on) el.classList.toggle('active', on);
      const d = Math.max(-6, Math.min(10, i - idx));
      el.style.setProperty('--d', String(d));
      el.style.setProperty('--ad', String(Math.min(8, Math.abs(d))));
    }
    lineGeomCache = null;
    centerActiveLine(false);
    emitLine();
  }

  function centerActiveLine(force) {
    if (activeIdx < 0 || !lrcLines[activeIdx] || !lyricsBox) return;
    // 浏览态（用户正在自己滚动）不抢滚动位置
    if (manualLyrics && !force) return;
    const activeEl = lrcLines[activeIdx].el;
    const box = lyricsBox;
    const h = box.clientHeight;
    // 宽度动画还没结束时，歌词区可能是 0 宽 / 0 高，此时量到的偏移没有意义
    if (h < 20) return;
    const target = activeEl.offsetTop - h / 2 + activeEl.clientHeight / 2;
    if (force || Math.abs(box.scrollTop - target) > 4) {
      try { box.scrollTo({ top: target, behavior: 'smooth' }); } catch (e) { /* 不支持则忽略 */ }
    }
  }

  /** 布局变动后的一段时间内持续重新居中（宽度动画约 0.5s） */
  function requestRecenter(ms) {
    recenterUntil = Math.max(recenterUntil, Date.now() + (ms || 900));
  }

  /* 一镜到底：从仪式场景接过唱片位置（先定格在原位，再由 settle 归位） */
  function handoffFromScene() {
    if (!npDisc) return;
    const rect = Scene.discRect();
    if (!rect || !rect.width) return;
    // 目标位置直接取唱片槽的真实矩形：布局怎么变都不会错位
    const slot = npDiscSlot ? npDiscSlot.getBoundingClientRect() : null;
    const targetSize = (slot && slot.width) ? slot.width : 340;
    const tx = slot ? (slot.left + slot.width / 2 - (rect.left + rect.width / 2)) : 0;
    const ty = slot ? (slot.top + slot.height / 2 - (rect.top + rect.height / 2)) : 0;
    const scale = targetSize / rect.width;
    npDisc.classList.add('handoff');
    npDisc.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  /* 仪式淡出后，唱片过渡到页面中心 */
  function settle() {
    if (!npDisc) return;
    npDisc.classList.remove('handoff');
    npDisc.style.transform = 'translate(0, 0) scale(1)';
  }

  function setPlayState(state) {
    if (!npDiscSlot) return;
    const cls = state === 'playing' ? 'playing' : state === 'paused' ? 'paused' : 'stopped';
    if (!npDiscSlot.classList.contains(cls)) {
      npDiscSlot.classList.remove('stopped', 'paused', 'playing');
      npDiscSlot.classList.add(cls);
    }
    const mini = el.querySelector('.np-mini-disc');
    if (mini) {
      mini.classList.remove('stopped', 'paused', 'playing');
      mini.classList.add(cls);
    }
    /**
     * 需求：专辑图片的转动随歌曲暂停而暂停。
     * 由播放态显式打标记（而不是只靠 CSS 选中器），暂停/停止即刻停转。
     */
    setSpin(state === 'playing');
    const btn = document.getElementById('np-play');
    if (btn) {
      const html = state === 'playing' ? icPause() : icPlay();
      if (btn.innerHTML !== html) btn.innerHTML = html;
    }
  }

  function setSpin(on) {
    const spins = el.querySelectorAll('.disc-spin');
    for (let i = 0; i < spins.length; i++) {
      spins[i].classList.toggle('is-spinning', !!on);
    }
  }

  /**
   * 封面样式（v10.6，设置页切换）：
   *   'disc'   —— 旋转唱片（默认，原样式）；
   *   'square' —— 方形专辑封面：停转、藏中孔、去光盘纹路，
   *                暂停缩小 / 播放放大（见 pages.css 的 cover-square 规则）。
   * 类挂在 #page-nowplaying 自身上：render() 只重建内部 DOM，
   * 这个类不受影响；未渲染时调用也安全（el 是常驻元素）。
   */
  function setCoverStyle(style) {
    const next = style === 'square' ? 'square' : 'disc';
    el.classList.toggle('cover-square', next === 'square');
  }

  /**
   * 唱片中心圆孔开关（v10.7，设置页切换，默认开）：
   * 关掉后 #page-nowplaying 加 .no-hole，CSS 隐藏 .disc-hole。
   * 方形封面下中孔本就隐藏（cover-square 规则），与此开关无关。
   */
  function setDiscHole(on) {
    el.classList.toggle('no-hole', on === false);
  }

  /** 沉浸模式按钮的高亮跟随全局状态 */
  function syncImmersiveBtn() {
    const btn = document.getElementById('np-immersive');
    if (!btn) return;
    const on = !!(Immersive && Immersive.isOn());
    btn.classList.toggle('on', on);
    btn.title = T(on ? 'np.tip.immersiveOff' : 'np.tip.immersive');
  }

  /** 悬浮歌词按钮的高亮跟随真实状态（用户可能在悬浮窗里用 ✕ 关掉） */
  function syncFloatingBtn() {
    const btn = document.getElementById('np-floating');
    if (!btn) return;
    const on = App.state.settings.floatingLyrics === true;
    btn.classList.toggle('on', on);
    btn.title = T(on ? 'np.tip.floatingOff' : 'np.tip.floating');
  }

  function setVolumeEnabled(ok) {
    const wrap = document.getElementById('np-vol');
    const input = document.getElementById('np-volume');
    if (!wrap) return;
    if (ok) {
      wrap.classList.remove('disabled');
      if (input) input.disabled = false;
    } else {
      wrap.classList.add('disabled');
      if (input) input.disabled = true;
      wrap.title = T('np.volDisabled');
    }
  }

  function setVolumeValue(v) {
    const input = document.getElementById('np-volume');
    if (input) input.value = String(Math.round(v * 100));
  }

  /**
   * 退碟 / 无碟：把播放页恢复成空状态（v10.4，用户反馈第 8 条）。
   *
   * 不清的话，光盘弹出后"正在播放"页还挂着上一张碟的封面、专辑名、
   * 曲目表与歌词 —— 用户看到的是一个"写着歌名却播不出声"的界面。
   * 播放链路的复位（Transport.resetAll / 引擎 stop）在 app.js onPhase
   * 里已经做了，这里只负责把**展示层**清干净。
   *
   * 时序保护：主进程启动即推 cd:phase(idle)，可能早于 ensureRendered，
   * 因此 rendered 为 false 时直接返回（那时本来也没有内容可清）。
   */
  function reset() {
    if (!rendered) return;
    lastTrack = -1;
    lastLyricsKey = null;
    // 封面（大唱片 + 迷你唱片的所有面）
    setDisc(null);
    // 标题区
    const title = document.getElementById('np-title');
    const artist = document.getElementById('np-artist');
    const albumline = document.getElementById('np-albumline');
    const line = document.getElementById('np-trackline');
    if (title) title.textContent = '—';
    if (artist) artist.textContent = '';
    if (albumline) albumline.textContent = '';
    if (line) line.textContent = T('np.tracklineEmpty');
    if (nowTitleEl) nowTitleEl.textContent = '—';
    if (nowArtistEl) nowArtistEl.textContent = '';
    // 曲目表：回到"尚未读取"的空态
    if (trackListEl) {
      trackListEl.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'lrc-empty';
      empty.textContent = T('np.empty.noTracks');
      trackListEl.appendChild(empty);
    }
    // 歌词区：清空 + 主动发一次空行（把桌面悬浮歌词的旧内容也清掉）
    if (lyricsBox) {
      lyricsBox.innerHTML = '';
      if (window.LyricsView) LyricsView.clear();
      lrcLines = [];
      lineGeomCache = null;
      activeIdx = -2;
      wordMode = false;
      const empty = document.createElement('div');
      empty.className = 'lrc-empty';
      empty.textContent = T('np.empty.waiting');
      lyricsBox.appendChild(empty);
      applyLyricToggles(null);
      try { emitLine(); } catch (e) { /* 忽略 */ }
    }
    setPlayState('stopped');
  }

  return {
    render, rerender, ensureRendered, syncState,
    setDisc, setTrack, setLyrics, tick,
    handoffFromScene, settle,
    setPlayState, setVolumeEnabled, setVolumeValue, fmt,
    setCoverStyle, setDiscHole,
    setTab, setAutoHide, showTabs, hideTabsNow, syncImmersiveBtn, syncFloatingBtn,
    setSplit, setLyricsManual: setManualLyrics, setLineListener, emitLine,
    reset,
    currentTab: () => tabId,
    isSplit: () => splitView
  };
})();