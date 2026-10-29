'use strict';
/* ============================================================
   app.js —— 应用主控：事件路由 / 播放控制 / 页面导航 / 一镜到底
   ------------------------------------------------------------
   播放控件重构要点：
   1) 播放状态（曲目 / 传输状态 / 位置 / 时长）统一由 Transport 持有，
      界面只读 Transport.snapshot()，不再散落在 App.state / _mci / mciFrame 多处。
   2) 所有播放指令只发 IPC，由主进程回权威 cd:state 收敛——不做会撒谎的乐观更新
      （旧实现 togglePlay 先改界面再发命令，命令失败时界面与实际永久脱节）。
   3) 唯一的例外是"定位"和"切轨"，它们允许乐观更新，但会进入短暂保护期，
      期间忽略来自轮询的软校正，避免进度条先跳过去再被拉回。
   ============================================================ */

const App = {
  state: {
    phase: 'idle',
    page: 'library',
    signature: null,
    toc: null,
    metadata: null,
    engine: null,
    volumeSupported: true,
    currentTrack: 1,
    trackCount: 1,
    mode: 'normal',
    volume: 0.7,
    settings: {
      autoPlay: true,
      defaultVolume: 0.7,
      smtcEnabled: true,
      theme: 'dark',
      tabAutoHide: true,
      visualFx: true,
      immersiveMode: false,
      splitView: false,
      libraryStyle: 'grid',
      lyricScale: 1,
      discScale: 1,
      trScale: 1,
      roScale: 1,
      floatingLyrics: false,
      /* v10.5 新增（均默认关） */
      autoLaunch: false,
      autoFullscreen: false,
      /* v10.6 新增 */
      coverStyle: 'disc',          // 播放页封面：disc 旋转唱片（默认）/ square 方形
      floatingShowTr: true,        // 悬浮歌词显示翻译
      floatingShowRo: true,        // 悬浮歌词显示罗马音
      /* v10.7 新增 */
      discHole: true,               // 唱片模式中心圆孔（CD 中心孔）开关，默认开
      /* v10.8 新增：全屏歌词演出层（fl-stage.js）。
         主题少而精，默认「流光」；字号 24~56px；译/音显隐与主界面独立 */
      flTheme: 'lumen',
      flSize: 34,
      flShowTr: true,
      flShowRo: true,
      /* 各主题的参数现值（{ 主题id: { 参数key: 值 } }），缺省回主题默认 */
      flParams: {},
      /* 演出层字体偏好（v10.8 M4）：null = 系统默认字体链；
         {kind:'system'|'custom', name, id?} —— 与主进程 settings 同键 */
      flFont: null,
      /* v10.9：歌词弹出方式（全局，所有主题可套用）：
         all 全部显示（默认，v10.8 行为）/ line 整行弹出 / word 逐字弹出 */
      flReveal: 'all',
      /* v10.11：界面语言（i18n.js）。zh-CN | zh-TW | en | ja | ru */
      lang: 'zh-CN'
    }
  },
  engine: null,          // AudioEngine 或 DemoAudio（MCI 路径不需要渲染端引擎）
  needDisc: null,        // 等待放入的目标 {sig, meta}
  tickTimer: null,
  chipTimer: null,
  _volSaveTimer: null,
  /**
   * 最近一次来自主进程的 cd:position（MCI 轮询回读的设备真实位置）。
   * MCI 路径下渲染端没有本地音频，这是唯一能拿到的真实位置；
   * 用它当"听感位置"，暂停点与续播点才不会落在墙钟的超前位置上。
   */
  lastMainPos: null,
  /** 防止同一轨在 1.5s 内被重复判定为播完（主进程事件 + 本地墙钟会同时到达） */
  _endGuard: { track: 0, at: 0 }
};

/* ---------- 尺寸缩放（歌词 / 唱片大小）---------- */

/**
 * 只写 <html> 上的几个 scale 变量，CSS 里各处（普通 / 并行 / 全屏 / 矮窗口）
 * 只改 base，因此一次赋值全局生效，无需重渲染。
 *   --lyric-scale    歌词主文字
 *   --disc-scale     唱片（封面）大小
 *   --lyric-tr-scale 译文小字（ .lrc-tr 单独消费，主字号不牵连 ）
 *   --lyric-ro-scale 罗马音小字（ .lrc-ro 单独消费，v10.5 新增 ）
 */
const Sizes = (() => {
  const LYRIC_MIN = 0.7, LYRIC_MAX = 1.8;
  const DISC_MIN = 0.6, DISC_MAX = 1.6;
  const TR_MIN = 0.6, TR_MAX = 1.8;
  const RO_MIN = 0.6, RO_MAX = 1.8;
  const DEFAULTS = { lyricScale: 1, discScale: 1, trScale: 1, roScale: 1 };

  function clamp(v, min, max, fallback) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function apply(patch, persist) {
    const s = App.state.settings;
    if (patch && patch.lyricScale != null) s.lyricScale = clamp(patch.lyricScale, LYRIC_MIN, LYRIC_MAX, DEFAULTS.lyricScale);
    if (patch && patch.discScale != null) s.discScale = clamp(patch.discScale, DISC_MIN, DISC_MAX, DEFAULTS.discScale);
    if (patch && patch.trScale != null) s.trScale = clamp(patch.trScale, TR_MIN, TR_MAX, DEFAULTS.trScale);
    if (patch && patch.roScale != null) s.roScale = clamp(patch.roScale, RO_MIN, RO_MAX, DEFAULTS.roScale);
    const root = document.documentElement.style;
    root.setProperty('--lyric-scale', String(s.lyricScale));
    root.setProperty('--disc-scale', String(s.discScale));
    root.setProperty('--lyric-tr-scale', String(s.trScale));
    root.setProperty('--lyric-ro-scale', String(s.roScale));
    if (persist) {
      const out = {};
      if (patch && patch.lyricScale != null) out.lyricScale = s.lyricScale;
      if (patch && patch.discScale != null) out.discScale = s.discScale;
      if (patch && patch.trScale != null) out.trScale = s.trScale;
      if (patch && patch.roScale != null) out.roScale = s.roScale;
      window.cd.invoke('settings:set', out).catch(() => { /* 忽略 */ });
    }
  }

  return {
    apply,
    defaults: () => Object.assign({}, DEFAULTS),
    ranges: { lyric: [LYRIC_MIN, LYRIC_MAX], disc: [DISC_MIN, DISC_MAX], tr: [TR_MIN, TR_MAX], ro: [RO_MIN, RO_MAX] },
    reset() { apply(Object.assign({}, DEFAULTS), true); }
  };
})();

/* ---------- 播放页快捷键 ---------- */

const Shortcuts = (() => {
  /** 正在输入（编辑面板 / 滑块）时不抢按键 */
  function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return !!t.isContentEditable;
  }

  /** 浮层或读盘场景在前时，快捷键让位 */
  function blocked() {
    const overlay = document.querySelector('.overlay:not(.hidden)');
    if (overlay) return true;
    const ceremony = document.getElementById('ceremony');
    if (ceremony && ceremony.classList.contains('shown')) return true;
    return App.state.page !== 'nowplaying';
  }

  const VOL_STEP = 0.05;

  function onKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    /**
     * 全屏歌词演出层打开期间，播放快捷键整体让位给它（Esc/F/T/
     * 空格/方向键由 FlStage 自己处理，见 fl-stage.js 的 onKey）。
     * 否则两层会同时响应一个按键（例如空格被处理两遍）。
     */
    if (window.FlStage && FlStage.isOpen()) return;
    /**
     * 专辑详情页（v10.4）：Esc 一镜到底飞回音乐库。
     * 放在最前面：详情页开着时，它的 Esc 优先级最高，
     * 且此时 blocked() 本来就会挡掉播放快捷键，互不冲突。
     */
    if (window.Album && typeof Album.onKey === 'function' && Album.onKey(e)) return;
    // 音乐库 CoverFlow 的方向键归它自己（把焦点在专辑间挪动）
    if (App.state.page === 'library' && Library && Library.getStyle && Library.getStyle() === 'flow') {
      Library.onFlowKey(e);
      return;
    }
    if (isTyping(e) || blocked()) return;
    switch (e.key) {
      case ' ':
      case 'Spacebar':
      case 'k':
      case 'K':
        // preventDefault 同时挡住"空格触发刚点过的按钮"这一下重复操作
        e.preventDefault();
        App.togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        App.prev();
        break;
      case 'ArrowRight':
        e.preventDefault();
        App.next();
        break;
      case 'ArrowUp':
        e.preventDefault();
        App.setVolume(App.state.volume + VOL_STEP);
        break;
      case 'ArrowDown':
        e.preventDefault();
        App.setVolume(App.state.volume - VOL_STEP);
        break;
      case 'l':
      case 'L':
        e.preventDefault();
        NowPlaying.setTab(NowPlaying.currentTab() === 'lyrics' ? 'cover' : 'lyrics', true);
        break;
      default:
        break;
    }
  }

  return {
    start() {
      document.addEventListener('keydown', onKey);
    },
    onKey
  };
})();

/* ---------- 沉浸模式（隐藏顶栏与传输条，鼠标一动就回来）---------- */

const Immersive = (() => {
  /** 无操作多久后收起（ms） */
  const IDLE_MS = 2600;
  let on = false;
  let timer = null;

  function overChrome(e) {
    // 指针停在顶栏或传输条上时不收起（否则会在光标底下消失）
    const bar = document.getElementById('topbar');
    const foot = document.querySelector('.np-transport');
    for (const el of [bar, foot]) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return true;
    }
    return false;
  }

  /**
   * 只把光标放回来，外壳不一定现身。
   *
   * ★ 必须和外壳分开：onMove 里只有"靠近上下驻留带"才会 reveal()，
   *   在画面中间移动只会重新计时、外壳保持隐藏。若把光标跟着外壳一起管，
   *   用户在中间晃鼠标就会看到"鼠标明明在动、屏幕上却没有指针"。
   */
  function showCursor() {
    document.documentElement.classList.remove('cursor-away');
    arm();
  }

  function reveal() {
    document.documentElement.classList.remove('immersive-away');
    showCursor();
  }

  function arm() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!on) return;
      document.documentElement.classList.add('immersive-away');
      // 外壳退场时一并收掉鼠标指针：此时屏幕上只剩唱片与歌词，
      // 留一个光标杵在画面中间很突兀，全屏播放时尤其明显。
      document.documentElement.classList.add('cursor-away');
    }, IDLE_MS);
  }

  function set(next, persist) {
    on = !!next;
    document.documentElement.classList.toggle('immersive', on);
    if (!on) {
      if (timer) { clearTimeout(timer); timer = null; }
      // 关掉沉浸模式一定要把 cursor-away 也摘掉，
      // 否则光标会一直消失、而界面并没有进入沉浸态
      document.documentElement.classList.remove('immersive-away', 'cursor-away');
    } else {
      reveal();
    }
    if (App.state.settings) App.state.settings.immersiveMode = on;
    if (NowPlaying && NowPlaying.syncImmersiveBtn) NowPlaying.syncImmersiveBtn();
    if (persist !== false) {
      try { window.cd.invoke('settings:set', { immersiveMode: on }); } catch (e) { /* 忽略 */ }
    }
    return on;
  }

  function toggle() { return set(!on); }

  /** 鼠标靠近上下两条"驻留带"（顶栏 / 传输条所在的位置）就重新现身 */
  function nearChrome(e) {
    const topBand = Math.max(70, (App.state.page === 'nowplaying' ? 150 : 96));
    const bottomBand = (App.state.page === 'nowplaying') ? 190 : 96;
    return e.clientY <= topBand || e.clientY >= window.innerHeight - bottomBand || overChrome(e);
  }

  function onMove(e) {
    if (!on) return;
    // 光标先回来（无论外壳是否重新现身），再判断要不要唤回外壳。
    // 顺序很重要：showCursor() 内部会 arm()，这里再 arm() 只是把计时重置一次。
    if (document.documentElement.classList.contains('cursor-away')) showCursor();
    if (nearChrome(e)) reveal();
    else arm();
  }

  let wired = false;
  function ensureWired() {
    if (wired) return;
    wired = true;
    document.addEventListener('mousemove', onMove, { passive: true });
    // 打开面板时保持可见，避免用户在设置里找不到出口
    document.addEventListener('mousedown', () => { if (on) reveal(); }, { passive: true });
  }

  return {
    set,
    toggle,
    isOn: () => on,
    start() {
      ensureWired();
      return set(App.state.settings.immersiveMode === true, false);
    }
  };
})();

/* ---------- 主题（深色 / 浅色）---------- */

const Theme = (() => {
  let current = 'dark';

  function apply(name) {
    current = name === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', current);
    return current;
  }

  return { apply, get: () => current };
})();

/* ---------- 全局工具 ---------- */

function Toast(text, ms) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = text;
  t.classList.remove('hidden');
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(Toast._timer);
  Toast._timer = setTimeout(() => t.classList.add('hidden'), ms || 3200);
}

function pageEl() {
  return document.getElementById(App.state.page === 'nowplaying' ? 'page-nowplaying' : 'page-library');
}

function navigate(page) {
  App.state.page = page;
  const a = document.getElementById('page-library');
  const b = document.getElementById('page-nowplaying');
  const navLib = document.getElementById('nav-library');
  const navNp = document.getElementById('nav-nowplaying');
  a.classList.toggle('visible', page === 'library');
  b.classList.toggle('visible', page === 'nowplaying');
  if (navLib) navLib.classList.toggle('active', page === 'library');
  if (navNp) navNp.classList.toggle('active', page === 'nowplaying');
  if (page === 'nowplaying') {
    // 不再无条件重建 DOM：重建会丢掉进度条/滚动位置，是"切页后进度条错乱"的元凶之一
    NowPlaying.ensureRendered();
    NowPlaying.syncState();
    pushTransport();
  }
}

/** 曲目时长：优先 TOC（物理精确），缺失时回退元数据 */
function trackDuration(n) {
  const toc = App.state.toc;
  if (toc && toc.tracks) {
    const t = toc.tracks.find((x) => x.number === n);
    if (t && t.endFrame > t.startFrame) return (t.endFrame - t.startFrame) / 75;
  }
  const md = App.state.metadata;
  if (md && md.tracks) {
    const t = md.tracks.find((x) => x.number === n);
    if (t && t.durationSec > 0) return t.durationSec;
  }
  return 0;
}

function trackFrames(n) {
  const toc = App.state.toc;
  if (!toc || !toc.tracks) return null;
  const t = toc.tracks.find((x) => x.number === n);
  if (!t) return null;
  return { start: t.startFrame, end: t.endFrame };
}

/** 可播放曲目数：以 TOC 为准（元数据曲目数可能与实际不符） */
function trackCount() {
  const toc = App.state.toc;
  if (toc && toc.tracks && toc.tracks.length) return toc.tracks.filter((t) => t.audio !== false).length;
  const md = App.state.metadata;
  if (md && md.trackCount) return md.trackCount;
  return 1;
}

/* ---------- 系统媒体控件（SMTC）---------- */

/** 把当前曲目元数据推给 Windows 系统媒体控件（歌曲名 + 专辑图片） */
function syncSmtc() {
  if (!Smtc.supported) return;
  const md = App.state.metadata;
  const playing = Transport.status === 'playing';
  if (!md) {
    // 无元数据：清空系统控件（同时释放静音锚定音频）
    Smtc.clear();
    return;
  }
  const track = Transport.track;
  Smtc.update({
    track: track,
    metadata: md,
    cover: md.hasCover ? coverUrl(md.signature) : null,
    playing: playing
  });
  Smtc.setPlaybackState(Transport.status);
  const dur = Transport.durationSec || trackDuration(track);
  if (dur > 0) Smtc.setPosition(dur, Transport.positionSec());
}

/* ---------- IPC 事件 ---------- */

function wireIpc() {
  window.cd.on('cd:phase', (ev) => onPhase(ev));
  window.cd.on('cd:land', (ev) => onLand(ev));
  window.cd.on('cd:metadata', (ev) => onMetadata(ev));
  window.cd.on('cd:metadata-progress', (ev) => onMetaProgress(ev));
  window.cd.on('cd:state', (ev) => onState(ev));
  window.cd.on('cd:engine', (ev) => onEngine(ev));
  window.cd.on('cd:audio', (ev) => {
    if (App.engine instanceof AudioEngine) App.engine.feed(ev);
  });
  window.cd.on('cd:position', (ev) => {
    // MCI 轮询位置：只作为软校正源（带死区），不直接驱动进度条
    if (!ev || typeof ev.sec !== 'number') return;
    if (ev.track != null && ev.track !== Transport.track) return;
    /**
     * ★ 这是 MCI 路径上**唯一**来自设备的真实位置。
     *   MCI 由系统直接出声，渲染端没有本地音频可测，墙钟只会跑得更快 ——
     *   所以这里要记下它，audibleSec() 会优先采用（暂停点/续播点才不会偏后）。
     *
     * 死区从 0.8 收到 0.3：主进程侧的校正死区已从 0.45 收紧到 0.15，
     * 渲染端若仍留 0.8 就把这份精度又丢掉了。视觉抖动由 easeTo() 的
     * 渐进消化（每步 ≤0.25s）负责，不需要靠大死区来压。
     */
    App.state.lastMainPos = { sec: ev.sec, at: Date.now(), track: ev.track };
    Transport.correctFrom(ev.sec, 0.3);
  });
  window.cd.on('cd:track-end', (ev) => onTrackEnd(ev && ev.track));
  /* 主进程提示：有 key 就按当前语言取词（text 只是中文兜底），
     没有 key 的（大多是带原始错误串的动态文案）原样显示。 */
  window.cd.on('cd:notice', (ev) => {
    if (!ev) return;
    Toast(ev.key ? T(ev.key, ev.vars) : ev.text);
  });
  window.cd.on('cd:demo-play', (ev) => {
    if (App.engine instanceof DemoAudio) {
      App.engine.play(ev.track, trackDuration(ev.track), ev.seconds || 0);
    }
  });
  window.cd.on('cd:demo-seek', (ev) => {
    if (App.engine instanceof DemoAudio) App.engine.seek(ev.seconds || 0);
  });
}

function onPhase(ev) {
  if (!ev) return;
  App.state.phase = ev.phase;
  updateChip();
  switch (ev.phase) {
    case 'no-drive':
      Scene.show();
      Scene.setPhase('idle');
      Scene.setCover(null);
      Scene.setText(T('scene.noDriveTitle'), T('scene.noDriveSub'));
      ensureDemoButton();
      break;
    case 'idle':
      // 无碟：把所有播放控件复位
      // 演出层（若开着）必须先整体撤下：它 z:60 会盖住随后的读盘场景
      if (window.FlStage && FlStage.isOpen()) FlStage.forceClose();
      Transport.resetAll(1);
      if (App.engine) App.engine.stop();
      App.state.currentTrack = 1;
      /**
       * ★ 退碟后清空"上一张碟"的痕迹（v10.4，用户反馈第 8 条）。
       *
       * App.state.metadata/signature/toc 不清的话：NowPlaying 的 setTrack
       * 会继续从 App.state.metadata 找曲目名（界面还挂着上张碟的歌名），
       * reveal 分支也会把旧封面/旧专辑名当"光盘就绪"展示出来。
       * needDisc 一并取消：碟都出来了，等待提示没有意义。
       */
      App.state.metadata = null;
      App.state.signature = null;
      App.state.toc = null;
      App.state.trackCount = 1;
      App.needDisc = null;
      hideNeedDisc();
      NowPlaying.reset();
      NowPlaying.setPlayState('stopped');
      Visualizer.setCover(null);
      Smtc.clear();
      clearReadingProgress();
      // 外部弹出时若正停在"正在播放"页，退回音乐库，避免看着空界面
      if (ev.external && App.state.page === 'nowplaying') navigate('library');
      // 是否回退到读盘界面：
      //   软件内主动出舱 / 启动初始化 → 总是回退
      //   用户在机箱上物理弹出 → 由设置 ejectReturnToScene 决定
      if (ev.returnToScene !== false) {
        Scene.show();
        Scene.setPhase('idle');
        Scene.setText(T(ev.reason === 'removed' ? 'scene.removedTitle' : 'scene.waitTitle'), T('scene.waitSub'));
      } else {
        Scene.hide();
      }
      break;
    case 'insert':
      Scene.show();
      Scene.setPhase('insert');
      Scene.setText(T('scene.insertTitle'), T('scene.insertSub'));
      break;
    case 'reading':
      Scene.setPhase('reading');
      Scene.setReadingProgress(0.08);
      Scene.setText(T('scene.readingTitle'), '');
      startReadingProgress();
      break;
    case 'reveal':
      Scene.setPhase('reveal');
      Scene.setReadingProgress(1);
      clearReadingProgress();
      if (App.state.metadata) {
        const m = App.state.metadata;
        Scene.setCover(m.hasCover ? coverUrl(m.signature) : null);
        const parts = [];
        if (m.artist) parts.push(m.artist);
        if (m.year) parts.push(String(m.year));
        parts.push(T('common.tracks', { n: m.trackCount || 0 }));
        Scene.setText(m.album || T('scene.readyTitle'), parts.join(' · '));
      } else {
        Scene.setText(T('scene.readyTitle'), '');
      }
      break;
    case 'eject':
      // 同 idle：演出层不能盖住出舱 / 读盘场景
      if (window.FlStage && FlStage.isOpen()) FlStage.forceClose();
      Scene.show();
      Scene.setPhase('eject');
      Scene.setText(T('scene.ejectTitle'), T('scene.ejectSub'));
      Transport.resetAll(1);
      if (App.engine) App.engine.stop();
      // 同 idle：播放界面不再显示上张碟的信息（v10.4）
      App.state.metadata = null;
      App.state.signature = null;
      App.state.toc = null;
      App.state.trackCount = 1;
      App.needDisc = null;
      hideNeedDisc();
      NowPlaying.reset();
      NowPlaying.setPlayState('stopped');
      Smtc.clear();
      break;
  }
}

function ensureDemoButton() {
  const wrap = document.getElementById('ceremony-text');
  if (!wrap || wrap.querySelector('.demo-entry')) return;
  const btn = document.createElement('button');
  btn.className = 'btn ghost demo-entry';
  btn.style.marginTop = '22px';
  btn.textContent = T('scene.demoBtn');
  btn.dataset.i18n = 'scene.demoBtn';
  btn.addEventListener('click', () => window.cd.invoke('cd:use-demo'));
  wrap.appendChild(btn);
}

function onLand(ev) {
  updateChip();
  if (ev && ev.autoplay) {
    navigate('nowplaying');
    NowPlaying.handoffFromScene();
    Scene.fadeOutQuick();
    setTimeout(() => NowPlaying.settle(), 520);
  } else {
    Scene.hide();
    navigate('library');
    Library.refresh();
  }
}

function onMetadata(ev) {
  if (!ev || !ev.metadata) {
    // 在线获取尚未完成：保留旧视图，等待后续事件
    if (App.state.phase === 'reading') {
      Scene.setCover(null);
      Scene.setText(T('scene.readingTitle'), T('scene.metaPending'));
    }
    return;
  }
  App.state.metadata = ev.metadata;
  App.state.signature = ev.metadata.signature;
  App.state.trackCount = ev.metadata.trackCount || App.state.trackCount;
  refreshToc().then(() => {
    Transport.setTrackCount(trackCount());
    const dur = trackDuration(Transport.track);
    if (dur > 0) Transport.setDuration(dur);
    pushTransport();
  });
  NowPlaying.setDisc(ev.metadata);
  NowPlaying.setTrack(Transport.track, trackCount());
  /**
   * ★ 歌词强制刷新判定（v10.4，修"拿到歌词却不自动应用"）：
   *
   * setLyrics 有"同碟同轨不重渲染"的保护（lastLyricsKey），用于避免
   * cd:state 每 250ms 把歌词 DOM 重建一遍。但这条保护会误伤
   * **新鲜抓取完的歌词**：缓存命中时先渲染过一次（key=sig#1，此时还没有
   * 歌词），随后后台补抓 / 用户点"重新获取"完成，推来的还是同一张碟同一轨
   * —— key 没变，setLyrics 直接返回，歌词界面停在"暂无歌词"，
   * 用户必须手动点一次保存（updateDiscViews 走 force）才刷新。
   *
   * 判定：只要不是"原样读缓存"（fromCache !== true），就是新数据，
   * 一律 force 重渲染。首次读碟自动抓取完成、重新获取、缓存补抓
   * （lyricsFilled）都走这条，自动生效。
   */
  NowPlaying.setLyrics(ev.metadata, Transport.track, ev.fromCache !== true);
  Library.refresh();
  // 同一张封面同时作为全窗模糊背景（纯视觉，不影响播放链路）
  Visualizer.setCover(ev.metadata.hasCover ? coverUrl(ev.metadata.signature) : null);
  // 若正在等待这张碟 → 直接开播
  if (App.needDisc && App.needDisc.sig === ev.metadata.signature) {
    const target = App.needDisc.track || null;
    App.needDisc = null;
    hideNeedDisc();
    /**
     * 带目标曲目（详情页点歌来的）：用户明确点了哪一首，换碟后自动切到
     * 那一首 —— 这是显式意图，无视 autoPlay 设置；
     * 不带（CoverFlow 播放按钮）：从第一首播，沿用 autoPlay 设置。
     */
    if (target) playTrack(target);
    else if (App.state.settings.autoPlay) playTrack(1);
  } else if (App.needDisc) {
    // 等待的碟与当前不同 → 提示放入
    showNeedDisc(App.needDisc.meta, App.needDisc.track);
  }
  if (App.state.phase === 'reveal' || App.state.phase === 'reading') {
    Scene.setCover(ev.metadata.hasCover ? coverUrl(ev.metadata.signature) : null);
    const parts = [];
    if (ev.metadata.artist) parts.push(ev.metadata.artist);
    if (ev.metadata.year) parts.push(String(ev.metadata.year));
    parts.push(T('common.tracks', { n: ev.metadata.trackCount || 0 }));
    Scene.setText(ev.metadata.album || T('scene.readyTitle'), parts.join(' · '));
  }
  syncSmtc();
}

function onMetaProgress(ev) {
  if (App.state.phase !== 'reading' && App.state.phase !== 'reveal') return;
  let frac = 0.08;
  let sub = '';
  if (ev.stage === 'toc') { frac = 0.12; sub = T('scene.toc'); }
  else if (ev.stage === 'musicbrainz') { frac = 0.38; sub = T('scene.musicbrainz'); }
  else if (ev.stage === 'cover') { frac = 0.62; sub = T('scene.cover'); }
  else if (ev.stage === 'lyrics') {
    frac = 0.62 + 0.38 * (ev.done / Math.max(1, ev.total));
    sub = T('scene.lyrics', { done: ev.done || 0, total: ev.total });
  }
  Scene.setReadingProgress(frac);
  Scene.setText(T('scene.readingTitle'), sub);
  startReadingProgress();
}

let _ringTimer = null;
function startReadingProgress() {
  if (_ringTimer) clearInterval(_ringTimer);
  const t0 = Date.now();
  const from = 0.08;
  _ringTimer = setInterval(() => {
    const frac = Math.min(0.92, from + (Date.now() - t0) / 2600 * 0.84);
    Scene.setReadingProgress(frac);
    if (frac >= 0.92) clearInterval(_ringTimer);
  }, 60);
}

function clearReadingProgress() {
  if (_ringTimer) { clearInterval(_ringTimer); _ringTimer = null; }
}

/**
 * 权威状态快照：界面所有播放控件都从这里收敛。
 * 旧实现在此处只更新 playState，位置另有一套 _mci 墙钟且只在部分分支维护，
 * 于是切歌 / 定位 / 切页之后进度条经常停在旧位置。
 */
function onState(ev) {
  if (!ev) return;
  const track = Number(ev.track) || Transport.track;
  const dur = ev.durationSec > 0 ? ev.durationSec : trackDuration(track);
  // 切轨/停止 → 丢弃上一轨残留的设备回读值，避免 audibleSec() 取到别的轨的位置
  if (!App.state.lastMainPos || App.state.lastMainPos.track !== track || ev.state === 'stopped') {
    App.state.lastMainPos = null;
  }
  Transport.applyMainState({
    state: ev.state,
    track: track,
    positionSec: ev.positionSec,
    durationSec: dur,
    engine: ev.engine,
    trackCount: ev.trackCount || trackCount()
  });
  App.state.currentTrack = Transport.track;
  syncEngineToTransport();
  updateChip();
  syncSmtc();
}

/** 让渲染端音频引擎跟随 Transport 的权威状态 */
function syncEngineToTransport() {
  const status = Transport.status;
  const track = Transport.track;
  const sec = Transport.positionSec();
  App.state.currentTrack = track;

  if (App.engine instanceof AudioEngine) {
    const frames = trackFrames(track);
    if (status === 'playing') {
      // 暂停→播放：resume() 负责撤静音并按暂停点继续；换轨才走 setTrack+play
      if (App.engine.state === 'paused' && App.engine.trackNumber === track) {
        App.engine.resume();
      } else if (frames) {
        App.engine.play(track, frames.start, frames.end);
      } else {
        App.engine.play();
      }
    } else if (status === 'paused') {
      App.engine.pause();
    } else {
      App.engine.stop();
    }
    return;
  }

  if (App.engine instanceof DemoAudio) {
    if (status === 'playing') {
      if (App.engine.state === 'paused' && App.engine.trackNumber === track) {
        App.engine.resume();                       // 从暂停处继续，位置由 AudioContext 冻结保证
      } else if (App.engine.state !== 'playing' || App.engine.trackNumber !== track) {
        App.engine.play(track, trackDuration(track) || 291, sec);
      }
    } else if (status === 'paused') {
      App.engine.pause();
    } else {
      App.engine.stop();
    }
  }
}

function onEngine(ev) {
  if (!ev) return;
  const prev = App.state.engine;
  App.state.engine = ev.engine;
  App.state.volumeSupported = ev.volumeSupported !== false;

  if (ev.engine !== prev && App.engine) {
    // 引擎切换（如 RAW 失败回退 MCI）：停掉旧引擎，避免两套声音叠加
    try { App.engine.stop(); } catch (e) { /* 忽略 */ }
  }
  /**
   * ★ MCI 路径必须把 App.engine 整个置空（v10.3 用户实测修复）。
   *   旧实现只在切到 raw/demo 时新建引擎，切到 mci 时**保留**已 stop 的
   *   AudioEngine 实例。它被 stop 后位置冻结在旧值（比如 11.8s），而
   *   tickLoop 仍然消费它：`Transport.easeTo(engine.positionSec(), 0.25)`
   *   与 cd:position 的 `Transport.correctFrom(ev.sec, 0.3)` 两个源互相
   *   拉扯，锚点在 11~12s 之间来回震荡 —— 正是"RAW 切 MCI 后进度条前后
   *   抖动、歌词跟着抖、点进度条也治不好、必须重启才恢复"的根因
   *   （重启后 restoreState 不会为 mci 建引擎，App.engine 天然为 null）。
   */
  if (ev.engine === 'mci') {
    App.engine = null;
  }
  if (ev.engine === 'raw' && !(App.engine instanceof AudioEngine)) App.engine = new AudioEngine();
  if (ev.engine === 'demo' && !(App.engine instanceof DemoAudio)) App.engine = new DemoAudio();
  if (App.engine instanceof DemoAudio) App.engine.onEnd = (t) => onTrackEnd(t);
  if (App.engine) App.engine.setVolume(App.state.volume);
  NowPlaying.setVolumeEnabled(App.state.volumeSupported);
  Transport.setEngine(ev.engine);
  syncEngineToTransport();
}

function coverUrl(sig) {
  return `cover://${encodeURIComponent(sig)}/`;
}

async function refreshToc() {
  try {
    const toc = await window.cd.invoke('cd:get-toc');
    if (toc && toc.tracks && toc.tracks.length) App.state.toc = toc;
  } catch (e) { /* 保留旧 TOC */ }
  return App.state.toc;
}

/* ---------- 播放控制 ---------- */

function playTrack(n, fromSec) {
  n = Number(n) || 1;
  App._endGuard = { track: 0, at: 0 };
  App.state.lastMainPos = null;      // 切轨：上一轨的设备回读值已失效
  // 乐观切轨：立刻把界面切到新曲目（主进程的权威快照随后会确认或纠正）
  Transport.optimisticTrack(n);
  App.state.currentTrack = n;
  NowPlaying.setTrack(n, trackCount());
  if (App.state.metadata) NowPlaying.setLyrics(App.state.metadata, n);
  const frames = trackFrames(n);
  if (App.engine instanceof AudioEngine && frames) {
    App.engine.setTrack(n, frames.start, frames.end);
  }
  updateChip();
  syncSmtc();
  window.cd.invoke('cd:play-track', n, fromSec || 0);
}

/**
 * 当前真实听感位置（秒）。
 *
 * 按引擎分流：
 *   RAW / Demo —— 渲染端握着 AudioContext 的调度队列，只有它知道音频播到了哪。
 *                 主进程手里是"已读游标"，比耳朵听到的最多超前整个预读缓冲。
 *   MCI        —— 声音由系统声卡直接输出，渲染端**没有任何本地音频**，
 *                 墙钟只会跑得更快。此时唯一可靠的听感来源是主进程
 *                 250ms 轮询 `status cd position` 回读到的设备真实位置
 *                 （记录在 App.state.lastMainPos）。
 *
 * 旧实现在 MCI 下无条件回落到 Transport 墙钟 —— 那是个超前量，
 * 把它当暂停点回传给主进程，暂停点就整体偏后，续播随之"往前跳几秒"。
 */
function audibleSec() {
  const eng = App.engine;
  if (eng instanceof AudioEngine || eng instanceof DemoAudio) {
    const sec = eng.positionSec();
    if (sec != null && isFinite(sec) && sec >= 0) return sec;
  }
  // MCI：优先用设备回读值，并按墙钟外推到"现在"（最多 250ms 的轮询间隔）
  if (Transport.engine === 'mci' && App.state.lastMainPos) {
    const lp = App.state.lastMainPos;
    if (lp.track == null || lp.track === Transport.track) {
      let s = lp.sec;
      if (Transport.status === 'playing') s += (Date.now() - lp.at) / 1000;
      const dur = Transport.durationSec;
      if (dur > 0) s = Math.min(s, dur);
      if (isFinite(s) && s >= 0) return s;
    }
  }
  return Transport.positionSec();
}

function togglePlay() {
  const s = Transport.status;
  if (s === 'playing') {
    // ★ 暂停三步，顺序不能换：
    //   1) 先问引擎"耳朵听到的是哪一秒"——此刻音频队列还在，答案最准；
    //   2) 让引擎立刻暂停（当帧把增益拉 0 并丢弃预读），先静音再谈别的；
    //   3) 再把界面数字钉到这同一个数，并回传主进程作为续读起点。
    // 旧实现先改 Transport 状态再取位置，中间隔着 IPC 与 suspend 的异步窗口，
    // 主进程与界面各算一套，于是出现"点了暂停还响一会儿 + 续播位置偏后"。
    const heard = audibleSec();
    // ★ 这里必须直接调引擎的 pause()，不能再走 syncEngineToTransport()：
    //   此刻 Transport.status 还是 'playing'，那条路只会把引擎"继续播放"，
    //   引擎永远进不了 paused，预读缓冲留在队列里 —— 症状就是"点了暂停还响一会儿"。
    if (App.engine && typeof App.engine.pause === 'function') App.engine.pause();
    App.state.currentTrack = Transport.track;
    Transport.setStatus('paused');
    Transport.setPosition(heard);      // 界面数字 = 耳朵听到的那一秒
    window.cd.invoke('cd:pause', { sec: heard });   // 主进程据此对齐续读起点
    syncSmtc();
  } else if (s === 'paused') {
    // 恢复：把暂停点同时交给引擎与主进程，两边从同一秒继续
    const at = Transport.positionSec();
    Transport.setStatus('playing');
    syncEngineToTransport();
    window.cd.invoke('cd:resume', { sec: at });
    syncSmtc();
  } else {
    // 停止态：从当前曲目开头起播
    playTrack(Transport.track, 0);
  }
}

/** 读盘界面右上角隐藏按钮：无光盘也能进入软件主页面 */
function exitCeremony() {
  Scene.hide();
  navigate('library');
  Library.refresh();
  Toast(T('toast.enteredLibrary'));
}

function seek(sec) {
  const dur = trackDuration(Transport.track);
  let s = Math.max(0, Number(sec) || 0);
  if (dur > 0) s = Math.min(s, Math.max(0, dur - 0.05));
  App._endGuard = { track: 0, at: 0 };
  App.state.lastMainPos = null;      // 定位前的设备回读值已失效，等定位后的新值
  const target = Transport.commitSeek(s);
  window.cd.invoke('cd:seek', target);
}

function stopAll(message) {
  // 注意：不要在这里清 _endGuard —— 否则"播完停止"之后紧接着到达的
  // 第二条轨末通知（主进程事件 + 本地墙钟）会再触发一次停止。
  App.state.lastMainPos = null;
  window.cd.invoke('cd:stop');
  if (App.engine) App.engine.stop();
  Transport.setStatus('stopped');
  NowPlaying.setPlayState('stopped');
  updateChip();
  syncSmtc();
  if (message) Toast(message);
}

function eject() {
  window.cd.invoke('cd:eject');
}

function setVolume(v) {
  App.state.volume = Math.max(0, Math.min(1, v));
  if (App.engine) App.engine.setVolume(App.state.volume);
  NowPlaying.setVolumeValue(App.state.volume);
  clearTimeout(App._volSaveTimer);
  App._volSaveTimer = setTimeout(() => {
    window.cd.invoke('settings:set', { defaultVolume: App.state.volume });
  }, 600);
}

/* ---------- 播放模式 / 切轨 ---------- */

/** 返回下一曲曲目号；返回 0 表示整碟播完应停止 */
function pickNext(n, count) {
  const mode = App.state.mode;
  if (mode === 'repeat-one') return n;
  if (mode === 'shuffle') {
    if (count > 1) {
      let pick = n;
      while (pick === n) pick = 1 + Math.floor(Math.random() * count);
      return pick;
    }
    return n;
  }
  if (n >= count) return mode === 'repeat-all' ? 1 : 0;
  return n + 1;
}

function pickPrev(n, count) {
  if (App.state.mode === 'shuffle' && count > 1) {
    let pick = n;
    while (pick === n) pick = 1 + Math.floor(Math.random() * count);
    return pick;
  }
  if (n > 1) return n - 1;
  if (App.state.mode === 'repeat-all' || App.state.mode === 'repeat-one') return count;
  return 1;
}

function nextTrack() {
  const count = trackCount();
  const n = Transport.track;
  const t = pickNext(n, count);
  if (!t) { stopAll(T('toast.discFinished')); return; }
  playTrack(t);
}

function prevTrack() {
  const count = trackCount();
  const n = Transport.track;
  playTrack(pickPrev(n, count));
}

const MODE_KEY = {
  normal: 'mode.normal',
  'repeat-one': 'mode.repeatOne',
  'repeat-all': 'mode.repeatAll',
  shuffle: 'mode.shuffle'
};
/** 播放模式当前语言下的文案（演出层播控菜单复用同一份） */
function modeLabel(mode) {
  const k = MODE_KEY[mode] || MODE_KEY.normal;
  return T(k);
}
const MODE_ORDER = ['normal', 'repeat-one', 'repeat-all', 'shuffle'];

function cycleMode() {
  const idx = MODE_ORDER.indexOf(App.state.mode);
  App.state.mode = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
  const label = modeLabel(App.state.mode);
  const btn = document.getElementById('np-mode');
  if (btn) btn.textContent = label;
  window.cd.invoke('cd:set-mode', App.state.mode);
  Toast(label);
}

function setMode(mode, quiet) {
  if (!MODE_KEY[mode]) return;
  App.state.mode = mode;
  const btn = document.getElementById('np-mode');
  if (btn) btn.textContent = modeLabel(mode);
  if (!quiet) window.cd.invoke('cd:set-mode', mode);
}

/* 编辑保存 / 元数据刷新后，重新回填当前正在播放页与音乐库（避免页面显示过期） */
function updateDiscViews() {
  if (App.state.metadata) {
    NowPlaying.setDisc(App.state.metadata);
    NowPlaying.setTrack(Transport.track, trackCount());
    NowPlaying.setLyrics(App.state.metadata, Transport.track, true);
    const dur = trackDuration(Transport.track);
    if (dur > 0) Transport.setDuration(dur);
  }
  Library.refresh();
  pushTransport();
}

function onTrackEnd(n) {
  n = Number(n) || Transport.track;
  const now = Date.now();
  if (App._endGuard.track === n && now - App._endGuard.at < 1500) return;
  if (Transport.status === 'stopped' && now - App._endGuard.at < 1500) return;
  App._endGuard = { track: n, at: now };
  const count = trackCount();
  const t = pickNext(n, count);
  if (!t) { stopAll(T('toast.discFinished')); return; }
  playTrack(t);
}

/* ---------- 音乐库点击 / 等待放入 ---------- */

function requestDisc(meta) {
  if (meta && meta.signature && meta.signature === App.state.signature && App.state.phase === 'ready') {
    playTrack(1);
    return;
  }
  if (App.state.phase === 'insert' || App.state.phase === 'reading' || App.state.phase === 'reveal') {
    // 正在读盘，交给 metadata 事件判断
    App.needDisc = { sig: meta && meta.signature, meta };
    return;
  }
  App.needDisc = { sig: meta && meta.signature, meta };
  showNeedDisc(meta);
}

/**
 * 专辑详情页点歌（v10.4）：当前碟不是目标碟时提示放碟 / 换碟，
 * 换碟完成后**自动切到用户点的那一首**（而不是从第一首播）。
 * 已在光驱里 → 直接播该曲。
 */
function requestDiscTrack(meta, track) {
  const n = Math.max(1, Number(track) || 1);
  if (meta && meta.signature && meta.signature === App.state.signature && App.state.phase === 'ready') {
    playTrack(n);
    return;
  }
  if (App.state.phase === 'insert' || App.state.phase === 'reading' || App.state.phase === 'reveal') {
    // 正在读盘，交给 metadata 事件判断
    App.needDisc = { sig: meta && meta.signature, meta, track: n };
    return;
  }
  App.needDisc = { sig: meta && meta.signature, meta, track: n };
  showNeedDisc(meta, n);
}

function showNeedDisc(meta, track) {
  const overlay = document.getElementById('need-disc');
  overlay.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'panel';

  const mark = document.createElement('div');
  mark.className = 'nd-mark';

  const title = document.createElement('div');
  title.className = 'nd-title';
  title.textContent = (meta && meta.album) || T('needDisc.title');

  const sub = document.createElement('div');
  sub.className = 'nd-sub';
  // 带目标曲目（详情页点歌来的）：提示读完自动播那一首
  sub.textContent = track
    ? T('needDisc.subTrack', { n: track })
    : T('needDisc.subPlay');

  const foot = document.createElement('div');
  foot.className = 'panel-foot';
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const cancel = document.createElement('button');
  cancel.className = 'btn ghost';
  cancel.textContent = T('common.cancel');
  cancel.addEventListener('click', () => {
    App.needDisc = null;
    hideNeedDisc();
  });
  foot.appendChild(spacer);
  foot.appendChild(cancel);

  panel.appendChild(mark);
  panel.appendChild(title);
  panel.appendChild(sub);
  panel.appendChild(foot);
  overlay.appendChild(panel);
  overlay.classList.remove('hidden');
}

function hideNeedDisc() {
  document.getElementById('need-disc').classList.add('hidden');
}

/* ---------- 顶栏 / 芯片 ---------- */

function updateChip() {
  clearTimeout(App.chipTimer);
  App.chipTimer = setTimeout(() => {
    const chip = document.getElementById('drive-chip');
    if (!chip) return;
    let text = T('chip.idle');
    if (App.state.engine === 'demo') text = T('chip.demo');
    else {
      switch (App.state.phase) {
        case 'no-drive': text = T('chip.noDrive'); break;
        case 'insert': text = T('chip.reading'); break;
        case 'reading': text = T('chip.reading'); break;
        case 'reveal': text = T('chip.ready'); break;
        case 'ready':
          text = Transport.status === 'playing' ? T('chip.playing', { n: Transport.track })
            : Transport.status === 'paused' ? T('chip.paused') : T('chip.idle');
          break;
        case 'eject': text = T('chip.eject'); break;
      }
    }
    chip.textContent = text;
  }, 120);
}

/* ---------- 界面刷新 ---------- */

/** 把 Transport 当前快照推给界面（状态变化 / 切页 / 重渲染时调用） */
function pushTransport() {
  const snap = Transport.snapshot();
  NowPlaying.setPlayState(snap.status);
  NowPlaying.setTrack(snap.track, snap.trackCount || trackCount());
  NowPlaying.tick(snap.positionSec, snap.durationSec);
  updateChip();
}

/* ---------- 心跳 ---------- */

function tickLoop() {
  const snap = Transport.snapshot();
  let dur = snap.durationSec;
  if (!(dur > 0)) {
    dur = trackDuration(snap.track);
    if (dur > 0) Transport.setDuration(dur);
  }

  // 引擎自身位置是最精确的位置来源，用它软校正墙钟
  if (!snap.seeking && snap.status === 'playing') {
    if (App.engine instanceof AudioEngine && App.engine.trackNumber === snap.track) {
      // TOC 到达较晚时补设轨道边界（未设边界不能用引擎位置换算，否则进度会飙到几千秒）
      if (!App.engine.hasTrackBounds()) {
        const f = trackFrames(snap.track);
        if (f) App.engine.setTrack(snap.track, f.start, f.end);
      }
      // 渐进校正：有偏差就一小步一小步拉近，避免进度条"跳变"或"加速追赶"
      if (App.engine.hasTrackBounds()) {
        const sec = App.engine.positionSec();
        if (sec != null) Transport.easeTo(sec, 0.25);
      }
    } else if (App.engine instanceof DemoAudio && App.engine.trackNumber === snap.track) {
      Transport.easeTo(App.engine.positionSec(), 0.25);
    }
  }

  const pos = Transport.positionSec();
  NowPlaying.tick(pos, dur);

  // 同步系统媒体控件的进度条（约每 1s 一次即可，避免过于频繁）
  if (snap.status === 'playing' && dur > 0) {
    App._smtcPosAt = App._smtcPosAt || 0;
    const t = Date.now();
    if (t - App._smtcPosAt > 1000) {
      App._smtcPosAt = t;
      Smtc.setPosition(dur, pos);
    }
  }

  // 轨末判定：所有引擎统一由 Transport 的位置裁决，避免各自为政
  if (snap.status === 'playing' && !snap.seeking && dur > 0 && pos >= dur - 0.3) {
    onTrackEnd(snap.track);
  }
}

/* ---------- 初始化 ---------- */

async function restoreState() {
  const st = await window.cd.invoke('cd:get-state');
  if (!st) {
    onPhase({ phase: 'idle', reason: 'init' });
    return;
  }
  App.state.phase = st.phase || 'idle';
  App.state.engine = st.engine || null;
  App.state.volumeSupported = st.volumeSupported !== false;
  App.state.signature = st.signature || null;
  App.state.mode = st.mode || 'normal';
  App.state.trackCount = st.trackCount || 1;

  onPhase({ phase: App.state.phase, reason: 'init' });

  if (st.engine === 'raw' && !(App.engine instanceof AudioEngine)) App.engine = new AudioEngine();
  if (st.engine === 'demo' && !(App.engine instanceof DemoAudio)) App.engine = new DemoAudio();
  if (App.engine instanceof DemoAudio) App.engine.onEnd = (t) => onTrackEnd(t);
  if (App.engine) App.engine.setVolume(App.state.volume);
  NowPlaying.setVolumeEnabled(App.state.volumeSupported);
  NowPlaying.setVolumeValue(App.state.volume);
  Transport.setEngine(st.engine);

  if (st.signature) {
    try {
      const md = await window.cd.invoke('cd:get-metadata');
      if (md) onMetadata({ metadata: md });
    } catch (e) { /* 忽略 */ }
  }
  await refreshToc();

  // 用权威快照初始化传输状态：位置/曲目/状态/时长一次到位
  Transport.setTrackCount(st.trackCount || trackCount());
  Transport.applyMainState({
    state: st.playState || 'stopped',
    track: st.track || 1,
    positionSec: st.positionSec || 0,
    durationSec: st.durationSec || trackDuration(st.track || 1),
    trackCount: st.trackCount || trackCount(),
    engine: st.engine
  });
  App.state.currentTrack = Transport.track;
  setMode(App.state.mode, true);
  syncEngineToTransport();
  pushTransport();
}

/* ---------- 读盘界面：右上角隐藏退出按钮 ---------- */

/** 鼠标进入该半径（px）内才淡入显示，避免误触也保持界面干净 */
const CER_EXIT_RADIUS = 170;
/** 弹出托盘按钮的感应半径（比退出按钮小，它嵌在文案区里） */
const CER_EJECT_RADIUS = 110;

function wireCeremonyExit() {
  const btn = document.getElementById('ceremony-exit');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    exitCeremony();
  });
  // 用距离判定而不是 :hover：按钮本体很小，靠 hover 根本摸不到
  document.addEventListener('mousemove', (e) => {
    const r = btn.getBoundingClientRect();
    if (!r.width) return;                       // 读盘界面未显示
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const near = Math.sqrt(dx * dx + dy * dy) <= CER_EXIT_RADIUS;
    if (near !== btn.classList.contains('near')) btn.classList.toggle('near', near);
  }, { passive: true });
}

/**
 * 读盘界面"等待光盘"下方的弹出托盘按钮（v10.5）：
 * 默认隐藏，鼠标靠近 CER_EJECT_RADIUS 半径后淡入，点击走 cd:eject。
 * 非待机阶段按钮被 CSS display:none，getBoundingClientRect 宽度为 0，
 * 距离判定自动跳过。
 */
function wireCeremonyEject() {
  const btn = document.getElementById('ceremony-eject');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.cd.invoke('cd:eject').catch(() => { /* 忽略 */ });
  });
  document.addEventListener('mousemove', (e) => {
    const r = btn.getBoundingClientRect();
    if (!r.width) return;                       // 按钮当前不可见（非待机阶段）
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const near = Math.sqrt(dx * dx + dy * dy) <= CER_EJECT_RADIUS;
    if (near !== btn.classList.contains('near')) btn.classList.toggle('near', near);
  }, { passive: true });
}

/* ---------- 主题切换 ---------- */

/** 应用主题并持久化（设置面板与顶栏快切共用同一条路径） */
async function setTheme(name) {
  const t = Theme.apply(name);
  App.state.settings.theme = t;
  try {
    await window.cd.invoke('settings:set', { theme: t });
    // 通知主进程同步窗口底色，无边框窗口下可避免切主题瞬间露白
    await window.cd.invoke('app:set-theme', t);
  } catch (e) { /* 忽略 */ }
  return t;
}

/* ---------- 多语言（i18n）---------- */

/**
 * 读盘场景的文案按当前阶段重新生成一遍。
 * 语言切换时读盘场景可能正停在任何阶段（等待 / 读取 / 就绪 / 出舱），
 * 不能靠"下次事件"来刷新 —— 用户会立刻看到旧语言残留。
 */
function refreshSceneText() {
  const ph = App.state.phase;
  const md = App.state.metadata;
  if (ph === 'no-drive') { Scene.setText(T('scene.noDriveTitle'), T('scene.noDriveSub')); return; }
  if (ph === 'insert') { Scene.setText(T('scene.insertTitle'), T('scene.insertSub')); return; }
  if (ph === 'reading') { Scene.setText(T('scene.readingTitle'), ''); return; }
  if (ph === 'eject') { Scene.setText(T('scene.ejectTitle'), T('scene.ejectSub')); return; }
  if (ph === 'reveal' && md) {
    const parts = [];
    if (md.artist) parts.push(md.artist);
    if (md.year) parts.push(String(md.year));
    parts.push(T('common.tracks', { n: md.trackCount || 0 }));
    Scene.setText(md.album || T('scene.readyTitle'), parts.join(' · '));
    return;
  }
  if (ph === 'reveal') { Scene.setText(T('scene.readyTitle'), ''); return; }
  Scene.setText(T('scene.waitTitle'), T('scene.waitSub'));
}

/**
 * 语言切换后的整体重排：静态节点由 I18n.apply() 回填，
 * 动态面板（播放页 / 音乐库 / 详情页 / 设置 / 编辑 / 演出层）各自重建。
 * 只动文本与 DOM，不碰播放链路 —— 切换过程中音乐不中断。
 */
function relayoutLang() {
  I18n.apply();
  refreshSceneText();
  updateChip();
  try {
    window.cd.invoke('app:win-state').then((st) => applyWinState(st)).catch(() => { /* 忽略 */ });
  } catch (e) { /* 忽略 */ }
  // 各模块都是顶层 const（不挂 window），这里用词法引用 + typeof 守卫
  if (typeof NowPlaying !== 'undefined' && NowPlaying.rerender) NowPlaying.rerender();
  if (typeof Library !== 'undefined' && Library.render) Library.render();
  if (typeof Album !== 'undefined' && Album.applyLang) Album.applyLang();
  if (typeof SettingsPanel !== 'undefined' && SettingsPanel.refresh) SettingsPanel.refresh();
  if (typeof Edit !== 'undefined' && Edit.refresh) Edit.refresh();
  if (typeof FlStage !== 'undefined' && FlStage.applyLang) FlStage.applyLang();
}

/**
 * 切换界面语言（设置面板调用）。
 * 立即生效 + 落盘 settings.json，重启后保持。
 */
function setLang(lang, persist) {
  const next = I18n.setLang(lang);   // 内部 apply + 广播（relayoutLang 由订阅者执行）
  App.state.settings.lang = next;
  if (persist !== false) {
    try { window.cd.invoke('settings:set', { lang: next }).catch(() => { /* 忽略 */ }); } catch (e) { /* 忽略 */ }
  }
  return next;
}

/* ---------- 无边框窗口：自绘控件 ---------- */

function wireWindowControls() {
  const bind = (id, channel) => {
    const b = document.getElementById(id);
    if (!b || b.dataset.wired === '1') return;
    b.dataset.wired = '1';
    b.addEventListener('click', () => {
      window.cd.invoke(channel).catch(() => { /* 忽略 */ });
    });
  };
  bind('win-min', 'app:win-minimize');
  bind('win-max', 'app:win-toggle-maximize');
  bind('win-full', 'app:win-fullscreen');
  bind('win-close', 'app:win-close');

  // 顶栏主题快切
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn && themeBtn.dataset.wired !== '1') {
    themeBtn.dataset.wired = '1';
    themeBtn.addEventListener('click', () => {
      setTheme(Theme.get() === 'dark' ? 'light' : 'dark');
    });
  }
}

/** 窗口状态（最大化 / 全屏）驱动自绘按钮的图标与提示 */
function applyWinState(st) {
  if (!st) return;
  const max = document.getElementById('win-max');
  const full = document.getElementById('win-full');
  if (max) {
    max.classList.toggle('on', !!st.maximized);
    max.title = T(st.maximized ? 'app.win.restore' : 'app.win.max');
    max.setAttribute('aria-label', max.title);
  }
  if (full) {
    full.classList.toggle('on', !!st.fullScreen);
    full.title = T(st.fullScreen ? 'common.exitFullscreen' : 'common.fullscreen');
    full.setAttribute('aria-label', full.title);
  }
  document.documentElement.classList.toggle('is-fullscreen', !!st.fullScreen);
}

let _inited = false;
async function init() {
  // 幂等保护：重复初始化会重复订阅 IPC，导致一条 cd:track-end 被处理两次（重复切歌）
  if (_inited) return;
  _inited = true;

  // 1) 先订阅 IPC：主进程一启动就会发阶段事件，晚订阅会漏掉初始事件（导致没有"放入光盘"提示）
  wireIpc();
  window.cd.on('app:win-state', (st) => applyWinState(st));
  // 悬浮歌词可能在悬浮窗里被 ✕ 关掉，这里跟着真实状态更新按钮与设置
  window.cd.on('floating:state', (st) => {
    if (!st) return;
    App.state.settings.floatingLyrics = !!st.open;
    if (NowPlaying.syncFloatingBtn) NowPlaying.syncFloatingBtn();
  });

  /* 2) 语言：必须早于任何渲染 —— 首屏就应该是用户选的那门语言，
        否则会先闪一下简体中文再跳变。设置只在这里读一次，后面复用。 */
  let bootSettings = null;
  try { bootSettings = await window.cd.invoke('settings:get'); } catch (e) { bootSettings = null; }
  I18n.setLang((bootSettings && bootSettings.lang) || 'zh-CN', { silent: true });
  I18n.onChange(() => { relayoutLang(); });

  // 3) 顶栏与页面（含无边框窗口自绘控件）
  document.getElementById('nav-library').addEventListener('click', () => navigate('library'));
  document.getElementById('nav-nowplaying').addEventListener('click', () => navigate('nowplaying'));
  document.getElementById('btn-settings').addEventListener('click', () => SettingsPanel.open());
  wireWindowControls();
  wireCeremonyExit();
  wireCeremonyEject();
  NowPlaying.ensureRendered();
  Library.render();

  // 4) 设置（语言已在上面读过，这里复用同一份，避免重复 IPC）
  try {
    const s = bootSettings || await window.cd.invoke('settings:get');
    App.state.settings = Object.assign(App.state.settings, s);
    App.state.volume = s.defaultVolume != null ? s.defaultVolume : 0.7;
    // 系统媒体控件开关（默认开启）
    Smtc.setEnabled(s.smtcEnabled !== false);
  } catch (e) { /* 默认 */ }
  Theme.apply(App.state.settings.theme);
  Sizes.apply({ lyricScale: App.state.settings.lyricScale, discScale: App.state.settings.discScale, trScale: App.state.settings.trScale, roScale: App.state.settings.roScale }, false);
  NowPlaying.setAutoHide(App.state.settings.tabAutoHide);
  Visualizer.setEnabled(App.state.settings.visualFx);
  NowPlaying.setSplit(App.state.settings.splitView === true, false);
  Library.setStyle(App.state.settings.libraryStyle);
  App.setCoverStyle(App.state.settings.coverStyle, false);
  App.setDiscHole(App.state.settings.discHole, false);
  // v10.8：全屏歌词演出层（只构建外壳与偏好，不开 RAF；点击入口按钮才打开）
  if (window.FlStage && typeof FlStage.init === 'function') {
    FlStage.init(App.state.settings);
  }
  // v10.8 M4：恢复上次选择的演出层字体（异步；失败静默保持默认链）
  if (window.FlFonts && typeof FlFonts.restore === 'function') {
    try { FlFonts.restore(App.state.settings.flFont); } catch (e) { /* 忽略 */ }
  }

  // 5) 恢复播放状态
  try {
    await restoreState();
  } catch (e) {
    onPhase({ phase: 'idle', reason: 'init' });
  }
  // 早到的 cd:phase 事件可能发生在语言确定之前，这里按当前语言重刷一次
  refreshSceneText();

  // 6) 心跳：位置变化时刷新界面
  Transport.subscribe(() => pushTransport());
  App.tickTimer = setInterval(tickLoop, 120);

  /* 6.5) 窗口尺寸变化：CoverFlow 的居中完全靠量出来的 offset 算平移量，
     窗口一变，原来的 translate 就不再居中了 —— 必须重算（v10.4）。
     专辑详情页的大标题也可能从"两行静态"变成"需要滚动"，一并重排。 */
  let _resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (_resizeRaf) return;
    _resizeRaf = requestAnimationFrame(() => {
      _resizeRaf = 0;
      if (window.Library && Library.onResize) Library.onResize();
      if (window.Album && Album.isOpen && Album.isOpen() && Album.refitTitle) {
        Album.refitTitle();
      }
    });
  });

  // 7) 系统媒体控件（SMTC）：挂载媒体键处理，并广播当前状态
  Smtc.bindActions();
  syncSmtc();

  // 8) 界面动效层（背景 / 歌词随鼓点）、沉浸模式与窗口状态首帧同步
  Visualizer.start();
  Immersive.start();
  Shortcuts.start();

  /* 桌面悬浮歌词：订阅"当前行变化"，只有换行时才发 IPC（不做每帧推送）。
     没有歌词时也发一次空串，悬浮窗据此显示空闲态。 */
  NowPlaying.setLineListener((info) => {
    if (!window.cd || typeof window.cd.invoke !== 'function') return;
    window.cd.invoke('floating:lyrics', info).catch(() => { /* 未开启时静默 */ });
  });
  if (App.state.settings.floatingLyrics) {
    window.cd.invoke('floating:open').then(() => NowPlaying.emitLine()).catch(() => { /* 忽略 */ });
  }
  try {
    const st = await window.cd.invoke('app:win-state');
    if (st) applyWinState(st);
  } catch (e) { /* 忽略 */ }
}

/* ---------- 把控制函数挂到 App（供 nowplaying / library / settings 等模块通过 App.xxx 调用） ---------- */
App.playTrack = playTrack;
App.togglePlay = togglePlay;
App.seek = seek;
App.eject = eject;
App.setVolume = setVolume;
App.cycleMode = cycleMode;
/** 封面 URL（cover:// 协议）：全屏演出层与原版播放页共用同一规则 */
App.coverUrl = coverUrl;
/** 当前播放模式的中文名（演出层播控菜单复用，避免两处文案分叉） */
App.modeLabel = () => modeLabel(App.state.mode);
App.requestDisc = requestDisc;
/** 专辑详情页点歌：当前碟不是目标碟时提示放碟/换碟，换碟后自动切到目标曲目 */
App.requestDiscTrack = requestDiscTrack;
App.prev = prevTrack;
App.next = nextTrack;
App.exitCeremony = exitCeremony;
App.updateDiscViews = updateDiscViews;
App.stop = () => stopAll(null);
App.seekBy = (delta) => seek(Transport.positionSec() + (Number(delta) || 0));
App.seekTo = (sec) => seek(sec);
App.syncSmtc = syncSmtc;
/** 界面语言：切换 + 落盘（设置面板调用） */
App.setLang = setLang;
/** 当前语言 id */
App.getLang = () => I18n.get();
/** 主题：深色 / 浅色（设置面板与顶栏快切共用） */
App.setTheme = setTheme;
App.toggleTheme = () => setTheme(Theme.get() === 'dark' ? 'light' : 'dark');
/** 封面与歌词并排显示（persist=false 时只更新内存态，用于启动恢复） */
App.setSplitView = (on, persist) => {
  App.state.settings.splitView = !!on;
  if (persist) {
    window.cd.invoke('settings:set', { splitView: !!on }).catch(() => { /* 忽略 */ });
  }
};
/** 音乐库样式：grid（原版） / flow（CoverFlow） */
App.setLibraryStyle = (style, persist) => {
  App.state.settings.libraryStyle = style;
  if (persist) {
    window.cd.invoke('settings:set', { libraryStyle: style }).catch(() => { /* 忽略 */ });
  }
};
/**
 * 播放页封面样式（v10.6）：disc 旋转唱片（默认）/ square 方形。
 * 方形样式下暂停缩小、播放放大（动画在 CSS，见 pages.css 的
 * #page-nowplaying.cover-square 规则）。
 */
App.setCoverStyle = (style, persist) => {
  const next = style === 'square' ? 'square' : 'disc';
  App.state.settings.coverStyle = next;
  if (NowPlaying.setCoverStyle) NowPlaying.setCoverStyle(next);
  if (persist) {
    window.cd.invoke('settings:set', { coverStyle: next }).catch(() => { /* 忽略 */ });
  }
};
/**
 * 唱片中心圆孔开关（v10.7）：true 显示 CD 中心孔（默认），false 隐藏。
 * 方形封面下中孔本就隐藏，与此开关无关。
 */
App.setDiscHole = (on, persist) => {
  const next = on !== false;
  App.state.settings.discHole = next;
  if (NowPlaying.setDiscHole) NowPlaying.setDiscHole(next);
  if (persist) {
    window.cd.invoke('settings:set', { discHole: next }).catch(() => { /* 忽略 */ });
  }
};
/** 切换系统媒体控件开关：即时生效，并立即按当前播放态重推一次 */
App.setSmtcEnabled = (on) => {
  Smtc.setEnabled(on);
  if (App.state.settings) App.state.settings.smtcEnabled = on !== false;
  syncSmtc();
};

document.addEventListener('DOMContentLoaded', init);
