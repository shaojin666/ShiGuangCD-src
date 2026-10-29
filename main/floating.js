'use strict';
/*
 * floating.js —— 桌面悬浮歌词窗口（主进程侧）
 * ------------------------------------------------------------
 * 一个独立的无边框 / 透明 / 置顶窗口：
 *   - 只有歌词文字那一块有不透明底板，其余区域完全透明；
 *   - 可拖拽、可改颜色与字号（改动写回 settings.json）；
 *   - 鼠标中键切换"锁定"：
 *       未锁定 → 可拖拽、可改设置，控件在鼠标靠近时淡入；
 *       已锁定 → 整窗 setIgnoreMouseEvents(true, { forward: true })，
 *                 所有点击穿透到下面的窗口，鼠标移动仍然送达渲染端，
 *                 所以"靠近显示提示"依然可用，提示只写"按中键解锁"。
 *     ★ 锁定后若鼠标移进文字块，会临时"布防"（允许事件到达本窗），
 *       这样中键点击才收得到；一旦收到非中键按键立刻重新穿透。
 *       没有布防就没有中键可收 —— 这是 Electron 点击穿透的固有限制，
 *       所以布防范围严格限制在"可见文字块"之内，误吞点击的概率极低。
 */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const SIZE_MIN = 12;
const SIZE_MAX = 64;
const DEFAULTS = { color: '#e9e3d8', size: 22, x: null, y: null };
/** 首次打开时的默认窗口大小（之后完全由用户拖边缘决定） */
const INIT_W = 760;
const INIT_H = 132;
/** 窗口尺寸下限：太小就看不到字了 */
const WIN_MIN_W = 220;
const WIN_MIN_H = 56;
/** 相对工作区的尺寸上限，避免拖到屏幕外找不回来 */
const WIN_MAX_W_RATIO = 0.8;
const WIN_MAX_H_RATIO = 0.5;

function createFloating({ settings, log, getMainWindow }) {
  let win = null;
  let locked = false;
  let armed = false;
  let lastLyrics = { text: '', prev: '', next: '', index: -1, total: 0, playing: false, tr: '', ro: '', agent: '', duet: null, at: null, t: null, e: null, words: null, bg: null };
  let wired = false;

  // 拖动 / 缩放过程中的窗口几何。settings.update() 是**同步写文件**，
  // 一次拖动能产生上百个 mousemove —— 必须攒到停下来（或松手）再落盘，
  // 否则每个 mousemove 都阻塞一次磁盘 IO，手感会变成幻灯片。
  let pendingGeo = null;
  let geoTimer = null;
  // 拖动 / 缩放的锚点：按下那一刻的窗口几何 + 光标屏幕坐标。
  // 之后每次收到光标绝对坐标都用它重算目标位置（不做增量累加）。
  // （v10.7：整窗长按拖动已移除，只剩缩放锚点。）
  let resizeAnchor = null;
  /*
   * 几何审计：记录窗口尺寸变化，以及"是谁改的"。
   *
   * ★ 必须按"每次操作一行"来记，不能每次变化都记一行：
   *   缩放是逐帧 setBounds，一次两秒的拖动能产生上百行，
   *   写日志本身要拼字符串 + 走文件 IO，是纯粹的无谓开销，
   *   而且真正出问题时几百行几乎一样的记录反而把关键那行淹掉。
   * 所以：正常缩放在**松手时**汇总成一行；unexpected（不是我们发起的）
   * 才实时记，但限流到每秒一行，避免刷屏。
   */
  let lastSize = { w: 0, h: 0 };
  let lastNoteAt = 0;
  function noteGeo(who, final) {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    if (b.width === lastSize.w && b.height === lastSize.h) return;
    lastSize = { w: b.width, h: b.height };
    if (!final) {
      const now = Date.now();
      if (now - lastNoteAt < 1000) return;   // 限流：unexpected 最多每秒一行
      lastNoteAt = now;
    }
    log('[float] size ' + lastSize.w + 'x' + lastSize.h + ' by=' + who + ' at=' + b.x + ',' + b.y);
  }
  function flushGeo() {
    if (geoTimer) { clearTimeout(geoTimer); geoTimer = null; }
    if (!pendingGeo) return;
    const p = pendingGeo;
    pendingGeo = null;
    settings.update(p);
  }
  function stageGeo(x, y, w, h) {
    pendingGeo = { floatingX: x, floatingY: y, floatingW: w, floatingH: h };
    if (geoTimer) clearTimeout(geoTimer);
    geoTimer = setTimeout(flushGeo, 400);
  }

  /** 把"当前是否开着 / 是否锁定"告诉主窗口（它传输条上的按钮要跟着变） */
  function notifyMain() {
    const main = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (!main || main.isDestroyed()) return;
    const state = { open: isOpen(), locked: locked };
    if (state.open !== (settings.data.floatingLyrics === true)) {
      settings.update({ floatingLyrics: state.open });
    }
    try { main.webContents.send('floating:state', state); } catch (e) { /* 忽略 */ }
  }

  function clampSize(v) {
    const n = Number(v);
    if (!isFinite(n)) return DEFAULTS.size;
    return Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(n)));
  }

  function readCfg() {
    const d = settings.data;
    return {
      color: typeof d.floatingColor === 'string' ? d.floatingColor : DEFAULTS.color,
      size: clampSize(d.floatingSize),
      float: d.floatingFloat === true,
      // v10.6：悬浮窗的译/音显隐（默认显示；主界面有译/音按钮，悬浮窗没有）
      showTr: d.floatingShowTr !== false,
      showRo: d.floatingShowRo !== false,
      // 语言（v10.11）：悬浮窗独立渲染，语言由主进程推过去
      lang: typeof d.lang === 'string' ? d.lang : 'zh-CN',
      x: typeof d.floatingX === 'number' ? d.floatingX : null,
      y: typeof d.floatingY === 'number' ? d.floatingY : null,
      w: typeof d.floatingW === 'number' ? d.floatingW : null,
      h: typeof d.floatingH === 'number' ? d.floatingH : null
    };
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  /** 把当前译/音显隐偏好推给悬浮窗（设置页切换时调用） */
  function pushShowOpts() {
    const cfg = readCfg();
    send('float:opts', { float: cfg.float, showTr: cfg.showTr, showRo: cfg.showRo });
  }

  function pushInit() {
    const cfg = readCfg();
    send('float:init', {
      color: cfg.color,
      size: cfg.size,
      locked: locked,
      float: cfg.float,
      showTr: cfg.showTr,
      showRo: cfg.showRo,
      lang: cfg.lang,
      lyrics: lastLyrics
    });
    // 浮动动画是纯视觉开关，改了要立刻推给渲染端
    send('float:opts', { float: cfg.float, showTr: cfg.showTr, showRo: cfg.showRo });
  }

  /** 该点所在显示器的工作区（取不到就退回主屏） */
  function workAreaAt(x, y) {
    try {
      return screen.getDisplayNearestPoint({ x: x, y: y }).workArea;
    } catch (e) {
      return screen.getPrimaryDisplay().workArea;
    }
  }

  /**
   * 窗口在渲染端首帧排好之前不显示，避免先闪一个空底板再填字。
   * ★ 尺寸不再由程序决定（见 open() 的注释），所以这里没有"量完再撑大"的问题。
   */
  let revealed = false;
  function reveal() {
    if (revealed || !win || win.isDestroyed()) return;
    revealed = true;
    win.showInactive();
  }

  /** 锁定态：整窗穿透；未锁定：正常接收 */
  function applyPointerMode() {
    if (!win || win.isDestroyed()) return;
    try {
      win.setIgnoreMouseEvents(locked, { forward: locked });
    } catch (e) { /* 老版本无 forward 参数 */ }
  }

  /** 把尺寸夹进"当前显示器工作区"允许的范围 */
  function clampWinSize(w, h, at) {
    const wa = workAreaAt(at.x, at.y);
    return {
      w: Math.max(WIN_MIN_W, Math.min(Math.round(wa.width * WIN_MAX_W_RATIO), Math.round(w))),
      h: Math.max(WIN_MIN_H, Math.min(Math.round(wa.height * WIN_MAX_H_RATIO), Math.round(h)))
    };
  }

  /** 把左上角夹回工作区，保证窗口不会被拖到屏幕外找不回来 */
  function clampWinPos(x, y, w, h) {
    const wa = workAreaAt(x, y);
    return {
      x: Math.max(wa.x, Math.min(Math.round(x), wa.x + wa.width - w)),
      y: Math.max(wa.y, Math.min(Math.round(y), wa.y + wa.height - h))
    };
  }

  function open() {
    if (win && !win.isDestroyed()) {
      reveal();
      return true;
    }
    win = null;
    const cfg = readCfg();
    const wa = screen.getPrimaryDisplay().workArea;
    // 尺寸：先用上次用户拉的，没有就用默认值。
    // 首次之后每一次几何变化都来自用户拖动，程序不会再自己改窗口大小。
    let w = cfg.w || INIT_W;
    let h = cfg.h || INIT_H;
    const ax = cfg.x == null ? wa.x + wa.width - w - 80 : cfg.x;
    const ay = cfg.y == null ? wa.y + wa.height - h - 140 : cfg.y;
    const sz = clampWinSize(w, h, { x: ax, y: ay });
    w = sz.w; h = sz.h;
    const pos = clampWinPos(ax, ay, w, h);
    const x = pos.x;
    const y = pos.y;
    // 首次打开把几何写回设置，下次就是同一个位置与大小
    if (cfg.w == null || cfg.h == null || cfg.x == null || cfg.y == null) {
      settings.update({ floatingW: w, floatingH: h, floatingX: x, floatingY: y });
    }
    win = new BrowserWindow({
      width: w,
      height: h,
      // ★ 刻意**不**用 useContentSize。
      //   它会让构造函数的 width/height 变成"内容区尺寸"，而 getBounds() /
      //   setBounds() 用的是"窗口尺寸"（含不可见的系统边框）。两者混用时，
      //   存进设置的 floatingW 其实是窗口尺寸，下次又被当成内容尺寸喂回去 ——
      //   每开一次窗口就长一圈边框那么宽，是个稳定复现的"匀速变大"。
      //   统一按窗口尺寸走，语义就一致了。
      x: x,
      y: y,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      /* ★ resizable 必须 false。
         开了之后 Windows 会给无边框窗口套一圈**看不见的系统缩放边框**：
         拖动窗口时手指一旦落到那一圈，系统就接管去改尺寸 ——
         日志里抓到过 `by=native` 的尺寸增长，位置在 x=1214（屏幕最右侧），
         正是系统边框被误碰到的样子。缩放改由渲染端四个角的把手负责。 */
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    // ★ 不要 setVisibleOnAllWorkspaces：跨虚拟桌面的可见性会让合成器一直
    //   维护这个置顶透明层，实测是常驻开销的主要来源之一。
    win.removeMenu();
    applyPointerMode();
    win.webContents.on('did-finish-load', () => {
      pushInit();
      notifyMain();
      // 兜底：万一渲染端没量出尺寸就崩了（比如脚本异常），
      // 最多等 1.2s 也把窗口显示出来，不能让用户开了个"看不见的窗口"。
      setTimeout(reveal, 1200);
    });
    /*
     * 尺寸变化的兜底落盘。正常只有四个角把手会改尺寸（走 float:resize），
     * 这里再兜一层，保证任何来源的尺寸变化都被记住。
     * ★ 只在"尺寸真的变了"时才做事，否则拖动窗口（只改位置）会刷屏。
     */
    let lastW0 = w;
    let lastH0 = h;
    win.on('resize', () => {
      if (!win || win.isDestroyed() || locked) return;
      const b = win.getBounds();
      if (b.width === lastW0 && b.height === lastH0) return;
      lastW0 = b.width;
      lastH0 = b.height;
      noteGeo('native');
      stageGeo(b.x, b.y, b.width, b.height);
    });
    win.on('closed', () => {
      // 只清理"自己"那一个：迟到的 closed 事件不能把新开的窗口引用抹掉
      if (win === this) {
        win = null;
        locked = false;
        armed = false;
        revealed = false;
      }
      notifyMain();
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'floating.html'));
    noteGeo('open');
    return true;
  }

  function close() {
    resizeAnchor = null;
    if (win && !win.isDestroyed()) {
      const dying = win;
      win = null;
      // 用 destroy() 而不是 close()：close() 是异步销毁，紧接着的"重新打开"
      // 会拿到一个还没销毁的旧窗口，等旧窗口的 closed 事件迟到触发时，
      // 引用已经被赋成 null —— 结果是新窗口存在但主进程失去了句柄，
      // 之后就再也关不掉/打不开。destroy() 是同步的，没有这个竞态。
      try { dying.destroy(); } catch (e) { /* 忽略 */ }
    }
    win = null;
    locked = false;
    armed = false;
    revealed = false;
    flushGeo();          // 关闭前把几何写进设置，别丢掉用户摆的位置与大小
    return true;
  }

  function isOpen() {
    return !!(win && !win.isDestroyed());
  }

  /** 主渲染端 → 悬浮窗（只在有歌词变化时调用） */
  function setLyrics(info) {
    /*
     * 逐字增强字段（tr/ro/at/t/e/words/bg）：
     * 悬浮窗拿词的绝对时间轴自己跑 CSS 补间动画做卡拉OK —— 刻意不开
     * 高频 IPC。透明置顶窗口每帧跨进程推送会把 CPU 拖死，而 CSS 动画
     * 由合成器执行，不需要精确时钟，误差在一首歌里不可感知。
     * words / bg.words 必须过白名单：它们来自结构化克隆，字段坏了悬浮窗会整行不渲染。
     */
    const words = [];
    if (info && Array.isArray(info.words)) {
      for (let i = 0; i < info.words.length && i < 120; i++) {
        const w = info.words[i];
        if (!w) continue;
        const t = typeof w.t === 'number' && isFinite(w.t) ? w.t : null;
        const e = typeof w.e === 'number' && isFinite(w.e) ? w.e : null;
        const x = typeof w.x === 'string' ? w.x : '';
        if (t == null || e == null || !x) continue;
        words.push({ t: t, e: e, x: x });
      }
    }
    /* 对唱（背景人声）行：白名单字段与主线一致（v10.6）。
       v10.7：agent 进白名单 —— 悬浮窗据此把 bg 块分到左右两侧
       （与主界面 amll 排版一致：带 agent = 对唱侧靠左，无 agent 跟随宿主）。 */
    const bg = [];
    if (info && Array.isArray(info.bg)) {
      for (let i = 0; i < info.bg.length && i < 6; i++) {
        const b = info.bg[i];
        if (!b || typeof b.text !== 'string' || !b.text) continue;
        const bwords = [];
        if (Array.isArray(b.words)) {
          for (let j = 0; j < b.words.length && j < 120; j++) {
            const w = b.words[j];
            if (!w) continue;
            const t = typeof w.t === 'number' && isFinite(w.t) ? w.t : null;
            const e = typeof w.e === 'number' && isFinite(w.e) ? w.e : null;
            const x = typeof w.x === 'string' ? w.x : '';
            if (t == null || e == null || !x) continue;
            bwords.push({ t: t, e: e, x: x });
          }
        }
        bg.push({
          text: b.text,
          t: typeof b.t === 'number' && isFinite(b.t) ? b.t : null,
          e: typeof b.e === 'number' && isFinite(b.e) ? b.e : null,
          agent: (typeof b.agent === 'string' && b.agent) ? b.agent.slice(0, 32) : '',
          words: bwords.length ? bwords : null
        });
      }
    }
    /* v10.7 歌曲级对唱结构：has = 这首歌含对唱，main = 主唱 agent。
       只有含对唱时才带（undefined 时悬浮窗整行居中，与主界面一致）。 */
    let duet = null;
    if (info && info.duet && info.duet.has) {
      duet = { has: true, main: (typeof info.duet.main === 'string') ? info.duet.main.slice(0, 32) : '' };
    }
    lastLyrics = {
      text: (info && info.text) || '',
      prev: (info && info.prev) || '',
      next: (info && info.next) || '',
      index: info && typeof info.index === 'number' ? info.index : -1,
      total: info && typeof info.total === 'number' ? info.total : 0,
      playing: !!(info && info.playing),
      tr: (info && typeof info.tr === 'string') ? info.tr : '',
      ro: (info && typeof info.ro === 'string') ? info.ro : '',
      agent: (info && typeof info.agent === 'string') ? info.agent.slice(0, 32) : '',
      duet: duet,
      at: info && typeof info.at === 'number' && isFinite(info.at) ? info.at : null,
      t: info && typeof info.t === 'number' && isFinite(info.t) ? info.t : null,
      e: info && typeof info.e === 'number' && isFinite(info.e) ? info.e : null,
      words: words.length ? words : null,
      bg: bg.length ? bg : null
    };
    send('float:lyrics', lastLyrics);
  }

  function setLocked(next) {
    locked = !!next;
    armed = false;
    resizeAnchor = null;
    applyPointerMode();
    send('float:lock', { locked: locked });
    notifyMain();
    // 锁定时窗口不能改几何（会连带改位置），先把落点结账
    if (locked) flushGeo();
    return locked;
  }

  /* ---------- IPC ---------- */

  function wire() {
    if (wired) return;
    wired = true;

    // 主渲染端：开关 / 推送歌词
    ipcMain.handle('floating:toggle', () => {
      const next = !settings.data.floatingLyrics;
      settings.update({ floatingLyrics: next });
      if (next) open(); else close();
      return { open: next };
    });
    ipcMain.handle('floating:open', () => {
      settings.update({ floatingLyrics: true });
      open();
      return { open: true };
    });
    ipcMain.handle('floating:close', () => {
      settings.update({ floatingLyrics: false });
      close();
      return { open: false };
    });
    ipcMain.handle('floating:lyrics', (_e, info) => {
      setLyrics(info);
      return true;
    });

    // 悬浮窗自身
    ipcMain.handle('float:ready', () => {
      pushInit();
      return true;
    });
    ipcMain.handle('float:close', () => {
      settings.update({ floatingLyrics: false });
      close();
      return true;
    });
    ipcMain.handle('float:lock', (_e, next) => setLocked(next));
    ipcMain.handle('float:position', () => {
      if (!win || win.isDestroyed()) return null;
      const p = win.getPosition();
      return { x: p[0], y: p[1] };
    });
    /*
     * ★ 移动窗口只走 `-webkit-app-region: drag`（顶部拖动条），由
     *   Chromium/系统直接搬，和主窗口顶栏同一个原理。
     *   早年那套"mousemove + setPosition"的整窗自绘拖动已经整段删掉了：
     *   它不但每次事件要跨进程传坐标（可达 1000Hz/次），还因为坐标换算
     *   与手势状态的各种边界情况，出现过"拖着拖着窗口自己变形"。
     *   v10.6 曾在底板加"长按拖动"（float:move-*），用户实测拖中间
     *   仍会拉伸窗口，v10.7 已移除 —— 下面是仅剩的缩放（四角把手）。
     */
    ipcMain.handle('float:resize-start', (_e, arg) => {
      if (!win || win.isDestroyed() || locked) return false;
      const edge = String((arg && arg.edge) || '');
      if (edge !== 'nw' && edge !== 'ne' && edge !== 'sw' && edge !== 'se') return false;
      const cur = screen.getCursorScreenPoint();
      const b = win.getBounds();
      resizeAnchor = { edge: edge, x: b.x, y: b.y, w: b.width, h: b.height, sx: cur.x, sy: cur.y };
      return true;
    });
    ipcMain.handle('float:resize', (_e, arg) => {
      if (!win || win.isDestroyed() || locked) return false;
      if (!resizeAnchor) return false;
      const edge = String((arg && arg.edge) || '') || resizeAnchor.edge;
      if (edge !== resizeAnchor.edge) return false;
      const cur = screen.getCursorScreenPoint();
      const ddx = cur.x - resizeAnchor.sx;
      const ddy = cur.y - resizeAnchor.sy;
      const right = resizeAnchor.x + resizeAnchor.w;
      const bottom = resizeAnchor.y + resizeAnchor.h;
      /*
       * 四角缩放。每个角有"被拖动的两条边"和"被钉死的两条边"：
       *
       *          拖动的边          钉死的边
       *   se(右下)  right + bottom   left  + top
       *   sw(左下)  left  + bottom   right + top
       *   ne(右上)  right + top      left  + bottom
       *   nw(左上)  left  + top      right + bottom
       *
       * 角在**左**边时，往左拖是"把左边往外拉"= 变宽，所以宽的增量要反号；
       * 角在**上**边时同理。
       * 位置只由被钉死的那两条边决定 —— 这样尺寸被夹到上下限时对边也不会跑位。
       */
      const leftCorner = (edge === 'nw' || edge === 'sw');
      const topCorner = (edge === 'nw' || edge === 'ne');
      const sz = clampWinSize(
        resizeAnchor.w + (leftCorner ? -ddx : ddx),
        resizeAnchor.h + (topCorner ? -ddy : ddy),
        { x: resizeAnchor.x, y: resizeAnchor.y });
      const x = leftCorner ? right - sz.w : resizeAnchor.x;
      const y = topCorner ? bottom - sz.h : resizeAnchor.y;
      const pos = clampWinPos(x, y, sz.w, sz.h);
      try {
        win.setBounds({ x: pos.x, y: pos.y, width: sz.w, height: sz.h });
      } catch (e) {
        return false;
      }
      // 逐帧不记日志（一次拖动会刷上百行）；只 stageGeometry 攒着，松手时一起落盘 + 记一行
      stageGeo(pos.x, pos.y, sz.w, sz.h);
      return true;
    });
    ipcMain.handle('float:resize-end', () => {
      resizeAnchor = null;
      flushGeo();
      // 一次缩放只留一行日志（见 noteGeo 里的说明）
      noteGeo('resize', true);
      return true;
    });
    /*
     * 整窗长按拖动（v10.6，float:move-*）已在 v10.7 移除：
     * 用户实测拖窗口中间仍会把窗口拉伸（与旧版自绘拖动同样的病），
     * 决定放弃"任意位置拖动"，移动窗口只认顶部拖动条（app-region），
     * 缩放只认四角把手。主进程侧三个 handler、moveAnchor 与渲染端的
     * 长按手势代码已一并删除。
     */
    // 渲染端首帧排好之后才显示窗口：避免先闪一下空容器再填字。
    ipcMain.handle('float:reveal', () => {
      reveal();
      return true;
    });
    ipcMain.handle('float:save', (_e, patch) => {
      const p = patch || {};
      const out = {};
      if (typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color)) out.floatingColor = p.color;
      if (p.size != null) out.floatingSize = clampSize(p.size);
      if (typeof p.float === 'boolean') out.floatingFloat = p.float;
      if (Object.keys(out).length) {
        settings.update(out);
        // 浮动动画开关：立刻同步给悬浮窗
        if (typeof p.float === 'boolean') send('float:opts', { float: p.float });
      }
      return { color: settings.data.floatingColor, size: clampSize(settings.data.floatingSize) };
    });
    // 锁定态下的"布防"：只为了能收到中键，范围由渲染端限制在文字块内。
    // setIgnoreMouseEvents 每调一次都会让系统重建该窗口的输入接收状态，
    // 属于不便宜的调用，所以这里做幂等：状态没变就什么都不做。
    ipcMain.handle('float:arm', () => {
      if (!locked || !win || win.isDestroyed() || armed) return armed;
      armed = true;
      try { win.setIgnoreMouseEvents(false); } catch (e) { /* 忽略 */ }
      return true;
    });
    ipcMain.handle('float:rearm', () => {
      if (!locked || !win || win.isDestroyed() || !armed) return armed;
      armed = false;
      applyPointerMode();
      return true;
    });
  }

  wire();

  return {
    open,
    close,
    toggle() {
      if (isOpen()) close();
      else open();
      return isOpen();
    },
    isOpen,
    setLyrics,
    /** 切换歌词缓慢浮动（纯视觉，但要立刻推给渲染端） */
    setFloatAnim(on) {
      settings.update({ floatingFloat: !!on });
      const cfg = readCfg();
      send('float:opts', { float: !!on, showTr: cfg.showTr, showRo: cfg.showRo });
    },
    /**
     * 切换语言（v10.11）：设置页改语言后立刻推给悬浮窗。
     * 只推语言，不动颜色/字号/歌词 —— 悬浮窗正在显示的那一行不该被打断。
     */
    setLang(lang) {
      const next = typeof lang === 'string' && lang ? lang : 'zh-CN';
      send('float:lang', { lang: next });
      return next;
    },
    /** 切换悬浮歌词的译/音显隐（v10.6，设置页调用，立刻推给悬浮窗） */
    setShowOpts(p) {
      const patch = {};
      if (p && typeof p.tr === 'boolean') patch.floatingShowTr = p.tr;
      if (p && typeof p.ro === 'boolean') patch.floatingShowRo = p.ro;
      if (Object.keys(patch).length) settings.update(patch);
      pushShowOpts();
      return readCfg();
    },
    isLocked: () => locked
  };
}

module.exports = { createFloating, FLOAT_DEFAULTS: DEFAULTS };
