'use strict';
/*
 * main/index.js —— 应用入口。
 * Electron 22.3.27（Chromium 108 / Node 16.17.2）：最后一个支持 Windows 7 的主版本。
 *
 * Copyright (C) 2026 ShiGuang Studio
 * SPDX-License-Identifier: GPL-3.0-or-later
 * 本程序是自由软件：你可以依据 GNU 通用公共许可证（GPLv3 或更高版本）
 * 再分发和/或修改它。协议全文见项目根目录的 LICENSE。
 */

const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { registerIpc, winStateOf } = require('./ipc');
const { createFloating } = require('./floating');
const { createFlFonts } = require('./fl-fonts');
const { CdService } = require('./cd/cd-service');
const { MetadataStore } = require('./metadata/store');

// 允许无手势自动播放（读盘后直接播放）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Windows 7 稳定性：关闭与遮挡计算相关的实验特性
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cover',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

// 单实例锁：MCI cdaudio 是单占用设备，多个实例共存会互相冲突（探测/播放卡死）
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

let win = null;
let floating = null;
let service = null;
let store = null;

/* ---------- 诊断日志（写入 userData/debug.log，排查读盘问题时发回即可） ---------- */
/** 单次运行的日志体积上限。超过就截断 —— 宁可丢历史，也不要写满磁盘。 */
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const logger = {
  file: null,
  nlines: 0,
  bytes: 0,
  init(userData) {
    this.file = path.join(userData, 'debug.log');
    try { fs.writeFileSync(this.file, ''); } catch (e) { this.file = null; }
    this.nlines = 0;
    this.bytes = 0;
    this.w('app start: electron=' + process.versions.electron + ' node=' + process.versions.node +
      ' platform=' + process.platform + ' arch=' + process.arch +
      ' args=' + JSON.stringify(process.argv.slice(1)));
  },
  w(msg) {
    if (!this.file) return;
    const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg + '\n';
    try {
      /*
       * ★ 体积上限。日志是 append-only 且**没有轮转**，
       *   启动时清空只管单次运行 —— 用户挂机一周就能堆几十 MB；
       *   而且每行都是同步 appendFileSync，不设上限迟早出事。
       *   做法：每 200 行才 stat 一次（不给每行都加一次系统调用），超限就截断。
       */
      if ((this.nlines++ % 200) === 0) {
        try { this.bytes = fs.statSync(this.file).size; } catch (e) { this.bytes = 0; }
      }
      if (this.bytes > LOG_MAX_BYTES) {
        fs.writeFileSync(this.file, '=== debug.log 超过 ' +
          Math.round(LOG_MAX_BYTES / 1048576) + ' MB，已截断 ===\n');
        this.bytes = 0;
      }
      this.bytes += Buffer.byteLength(line);
      fs.appendFileSync(this.file, line);
    } catch (e) { /* 忽略 */ }
  }
};

/* ---------- 设置（主进程持久化，供读盘后行为使用） ---------- */
const settings = {
  file: null,
  data: {
    /* 界面语言（v10.11）：zh-CN | zh-TW | en | ja | ru。
       渲染端 App.state.settings.lang 有同名默认值，两处保持一致；
       这里存着是为了让悬浮窗这类独立窗口也能拿到同一份语言。 */
    lang: 'zh-CN',
    autoPlay: true,
    defaultVolume: 0.7,
    /* 播放引擎偏好：'auto' 能力测试驱动 | 'raw' 强制 RAW | 'mci' 跳过测试直接 MCI。
       raw 若起播失败仍会回退 MCI；'mci' 是 RAW 输出异常（白噪音）时的逃生门。 */
    enginePreference: 'auto',
    ejectReturnToScene: true,
    smtcEnabled: true,
    theme: 'dark',
    /* 播放顺序：normal | repeat-one | repeat-all | shuffle（v10.5 起持久化） */
    playMode: 'normal',
    /* 音画律动（背景/歌词随鼓点），默认开（v10.5 起持久化） */
    visualFx: true,
    /* 开机自启：登录 Windows 后自动启动（默认关，v10.5） */
    autoLaunch: false,
    /* 进入软件时自动全屏（默认关，v10.5） */
    autoFullscreen: false,
    floatingLyrics: false,
    floatingColor: '#e9e3d8',
    floatingSize: 22,
    /* 歌词缓慢上下浮动：很贵（透明置顶窗口每帧都要重混桌面），
       默认关闭，需要时在设置里打开 */
    floatingFloat: false,
    /* 悬浮歌词的译/音显隐（v10.6）：主界面有「译/音」按钮，悬浮窗
       改成设置页开关（悬浮窗点不到主界面那个按钮），默认都显示 */
    floatingShowTr: true,
    floatingShowRo: true,
    floatingX: null,
    floatingY: null,
    /* 悬浮歌词窗口的几何：由用户拖动决定，程序不自己改 */
    floatingW: null,
    floatingH: null,
    /* 播放页封面样式（v10.6）：disc 旋转唱片（默认）/ square 方形 */
    coverStyle: 'disc',
    /* 唱片中心圆孔（v10.7）：CD 中间的小圆圈，默认显示 */
    discHole: true,
    /* 罗马音小字缩放（v10.6，与 trScale 同架构，0.6~1.8） */
    roScale: 1,
    /* 全屏歌词演出层（v10.8）：主题 / 字号 / 译音显隐。
       渲染端 App.state.settings 有同组默认值，两处保持一致 */
    flTheme: 'lumen',
    flSize: 34,
    flShowTr: true,
    flShowRo: true,
    /* 演出层各主题参数现值（{ 主题id: { key: 值 } }），自由合并，零 schema 风险 */
    flParams: {},
    /* 全屏歌词字体偏好（v10.8 M4）：null = 系统默认字体链；
       {kind:'system'|'custom', name, id?}，id 仅自定义字体有值 */
    flFont: null,
    /* v10.9：歌词弹出方式（全局，所有主题可套用）。
       all = 全部显示（默认，v10.8 行为）/ line = 整行弹出 / word = 逐字弹出 */
    flReveal: 'all'
  },
  init() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      Object.assign(this.data, JSON.parse(raw));
    } catch (e) { /* 默认值 */ }
    return this.data;
  },
  get() {
    return Object.assign({}, this.data);
  },
  update(patch) {
    Object.assign(this.data, patch);
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
    return Object.assign({}, this.data);
  }
};

/** 主题对应的窗口底色（无边框窗口下避免露出未绘制区域） */
function themeBackgroundColor(theme) {
  return theme === 'light' ? '#f2efe7' : '#0c0c0e';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: themeBackgroundColor(settings.data.theme),
    title: '拾光 · CD',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    /* 无边框窗口：标题栏由渲染端自绘（含最小化 / 最大化 / 全屏 / 关闭）。
       resizable 保持默认 true，Windows 上仍可拖拽边缘缩放。 */
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => {
    // 设置项：进入软件时自动全屏（默认关）。全屏状态变化会经
    // enter-full-screen 事件推给渲染端，自绘按钮与 is-fullscreen 类自动跟上。
    if (settings.data.autoFullscreen === true) {
      try { win.setFullScreen(true); } catch (e) { /* 老版本 Electron 忽略 */ }
    }
    win.show();
  });
  win.on('closed', () => {
    win = null;
    // 主窗口没了，悬浮歌词没有存在意义，否则会挡住退出流程
    if (floating) floating.close();
  });

  // 窗口状态变化 → 通知渲染端切换自绘按钮（最大化 ⇄ 还原、全屏 ⇄ 退出全屏）
  //
  // ★ 全屏这一项必须"落定后核对"，不能只在事件里读一次就发。
  //   `enter-full-screen` / `leave-full-screen` 触发的那一刻，
  //   `win.isFullScreen()` 可能还返回**旧值**（切换带动画，状态尚未落定）。
  //   把这一读当结果发出去，渲染端自绘按钮的图标就会**慢一拍**：
  //   进全屏后仍显示"进入全屏"图标，退出全屏后又变成"退出全屏"图标，
  //   必须再点一次才恢复 —— 正是"图标状态对不上、还得再切换一下"的原因。
  //
  //   做法：事件里先发一次（保证不卡手），落定后再回读核对，
  //   **只在真的不一致时补发** —— 读对了就一次都不会多发。
  let lastFullScreen = null;
  let fsSettle = null;

  function sendWinState() {
    if (!win || win.isDestroyed()) return null;
    const st = winStateOf(win);
    if (!st) return null;
    win.webContents.send('app:win-state', st);
    return st;
  }

  /** 普通窗口事件：发一次就好（最大化/还原这些没有落定问题） */
  function pushWinState() {
    const st = sendWinState();
    if (st) lastFullScreen = st.fullScreen;
  }

  /**
   * 全屏事件：**无条件**安排一次落定核对。
   *
   * ⚠ 这里不能因为"这次读到的值和上次一样"就跳过核对 ——
   *   恰恰相反，那正是最容易漏的一种：事件瞬间读到的过期值如果刚好等于
   *   上次发出去的值，提前 return 就不安排核对，等动画落定后**没有人再发一次**，
   *   图标就永久停在旧状态（还是要点第二次才恢复）。
   *   而核对本身只在值真的变了时才发消息，所以无条件安排并不产生冗余 IPC。
   */
  function pushWinStateSettle() {
    pushWinState();
    if (fsSettle) clearTimeout(fsSettle);
    fsSettle = setTimeout(() => {
      fsSettle = null;
      if (!win || win.isDestroyed()) return;
      const now = win.isFullScreen();
      if (now !== lastFullScreen) {      // 事件瞬间读早了 → 补发一次正确的
        lastFullScreen = now;
        sendWinState();
      }
    }, 300);
  }

  if (typeof win.on === 'function') {
    for (const ev of ['maximize', 'unmaximize', 'minimize', 'restore']) {
      win.on(ev, pushWinState);
    }
    for (const ev of ['enter-full-screen', 'leave-full-screen']) {
      win.on(ev, pushWinStateSettle);
    }
  }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

if (gotSingleInstanceLock) app.whenReady().then(() => {
  const userData = app.getPath('userData');
  store = new MetadataStore(userData);
  settings.init();
  logger.init(userData);

  /* 开机自启对齐（v10.5）：设置开着就确保 OS 启动项在（用户可能在系统里
     手动删过，或搬家后丢了注册项）；设置关着则不碰 —— 关闭只由设置页
     的显式操作负责，启动时无权替用户删启动项。 */
  if (settings.data.autoLaunch === true) {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch (e) { /* 老版本忽略 */ }
  }

  const isDemo = process.argv.includes('--demo');
  const isSmoke = process.argv.includes('--smoke');

  // Electron 22 使用 registerFileProtocol（protocol.handle 需 Electron 25+）
  protocol.registerFileProtocol('cover', (request, callback) => {
    try {
      const url = new URL(request.url);
      const sig = decodeURIComponent(url.hostname);
      const file = path.join(userData, 'metadata', sig + '.jpg');
      if (fs.existsSync(file)) {
        /* CORS 头：渲染端 canvas 取色需要跨域读取 cover:// 图片
           （专辑详情页的背景渐变要从封面提取主色） */
        callback({
          path: file,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
        return;
      }
    } catch (e) { /* 落到 404 */ }
    callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
  });

  createWindow();

  service = new CdService({
    userData,
    autoPlay: settings.data.autoPlay,
    ejectReturnToScene: settings.data.ejectReturnToScene !== false,
    /* settings 必须是活引用：update() 是 Object.assign 原地改对象，
       传引用 cd-service 才能读到运行时改动的引擎偏好（引擎逃生门要在
       "正在白噪音"的那一刻就能用，不能等下次读碟）。 */
    settings: settings.data,
    demo: isDemo,
    log: (msg) => logger.w(msg),
    send: (channel, payload) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  });
  /* 全屏歌词字体仓库（v10.8 M4）：userData/fonts/ 下的用户上传字体 */
  const flFonts = createFlFonts(app.getPath('userData'));
  registerIpc({
    service,
    store,
    settings,
    flFonts,
    logPath: logger.file,
    log: (m) => logger.w(m),
    getWindow: () => win,
    getFloating: () => floating
  });

  /* ---------- 桌面悬浮歌词 ---------- */
  floating = createFloating({
    settings,
    log: (m) => logger.w(m),
    getMainWindow: () => win
  });
  if (settings.data.floatingLyrics === true) floating.open();

  service.start();

  /* ---------- 冒烟测试：截图各阶段后退出 ---------- */
  if (isSmoke) {
    const outDir = path.join(__dirname, '..', 'smoke-shots');
    fs.mkdirSync(outDir, { recursive: true });
    const capture = (name) => win.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
      console.log('[smoke] captured', name);
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      // 演示模式时间线：insert @~1.3s → reading @~2.2s → reveal @~3.0s → land @~4.1s
      await wait(1850); await capture('01-insert');
      await wait(700);  await capture('02-reading');
      await wait(900);  await capture('03-reveal');
      await wait(1000); await capture('04-landed');
      await wait(900);  await capture('05-nowplaying');
      await wait(300);
      await win.webContents.executeJavaScript('navigate("library")');
      await wait(800);
      await capture('06-library');
      // 面板验证：设置 + 编辑
      await win.webContents.executeJavaScript('SettingsPanel.open()');
      await wait(700);
      await capture('07-settings');
      await win.webContents.executeJavaScript('SettingsPanel.close(); Edit.open()');
      await wait(700);
      await capture('08-edit');
      // 播放页标签页（歌词 / 曲目）与浅色主题
      await win.webContents.executeJavaScript('Edit.close(); navigate("nowplaying"); NowPlaying.setTab("lyrics")');
      await wait(900);
      await capture('09-lyrics');
      await win.webContents.executeJavaScript('NowPlaying.setTab("tracks")');
      await wait(700);
      await capture('10-tracks');
      await win.webContents.executeJavaScript('App.setTheme("light"); navigate("library")');
      await wait(900);
      await capture('11-light');
      console.log('[smoke] done');
      app.exit(0);
    })();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  // 悬浮歌词是"无边框 + skipTaskbar"的独立窗口，退出前先收掉
  if (floating) floating.close();
  if (service) service.dispose();
});
