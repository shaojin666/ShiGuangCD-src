'use strict';
/*
 * ipc.js —— 主进程 IPC 注册。
 */

const { ipcMain, shell, app } = require('electron');

/** 当前窗口状态（供渲染端切换自绘按钮图标） */
function winStateOf(win) {
  if (!win || win.isDestroyed()) return null;
  return {
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
    minimized: win.isMinimized()
  };
}

function registerIpc({ service, store, settings, flFonts, logPath, log, getWindow, getFloating }) {
  /* ---------- 诊断 ---------- */
  ipcMain.handle('app:open-logs', () => {
    if (!logPath) return false;
    try {
      shell.showItemInFolder(logPath);
      return true;
    } catch (e) {
      return false;
    }
  });
  // 渲染端写诊断日志（用于排查 SMTC 之类"看不见"的问题，写入同一个 debug.log）
  ipcMain.handle('app:log', (_e, msg) => {
    if (typeof log === 'function' && msg != null) {
      try { log('[renderer] ' + String(msg)); } catch (e) { /* 忽略 */ }
    }
    return true;
  });
  // 用系统默认浏览器打开外部链接（编辑面板的"打开 AMLL TTML Tool"用）。
  // 只放行 http/https，其它一律拒绝——渲染端不可借这个接口启动任意协议。
  ipcMain.handle('app:open-external', (_e, p) => {
    const url = p && typeof p.url === 'string' ? p.url.trim() : '';
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return false;
    try {
      shell.openExternal(url);
      return true;
    } catch (e) {
      return false;
    }
  });
  /* ---------- 无边框窗口的自绘控件 ----------
     只做窗口管理，不触碰任何播放逻辑。 */
  ipcMain.handle('app:win-state', () => winStateOf(getWindow()));
  ipcMain.handle('app:win-minimize', () => {
    const w = getWindow();
    if (!w || w.isDestroyed()) return false;
    w.minimize();
    return true;
  });
  ipcMain.handle('app:win-toggle-maximize', () => {
    const w = getWindow();
    if (!w || w.isDestroyed()) return false;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return true;
  });
  ipcMain.handle('app:win-close', () => {
    const w = getWindow();
    if (!w || w.isDestroyed()) return false;
    w.close();
    return true;
  });
  ipcMain.handle('app:win-fullscreen', () => {
    const w = getWindow();
    if (!w || w.isDestroyed()) return false;
    w.setFullScreen(!w.isFullScreen());
    return true;
  });
  // 开机自启开关（设置页，v10.5）：设置落盘由渲染端走 settings:set，
  // 这里只负责把 OS 启动项状态切到与设置一致。
  ipcMain.handle('app:set-auto-launch', (_e, opts) => {
    const on = !!(opts && opts.on);
    try {
      app.setLoginItemSettings({ openAtLogin: on });
      return true;
    } catch (e) {
      return false;
    }
  });
  // 渲染端切主题时同步窗口底色：无边框窗口下避免未绘制区域露白
  ipcMain.handle('app:set-theme', (_e, theme) => {
    const w = getWindow();
    if (!w || w.isDestroyed()) return false;
    try {
      w.setBackgroundColor(theme === 'light' ? '#f2efe7' : '#0c0c0e');
    } catch (e) { /* 老版本无此 API */ }
    return true;
  });

  /* ---------- CD 控制 ---------- */
  ipcMain.handle('cd:get-state', () => service.getState());
  ipcMain.handle('cd:get-metadata', () => service.getMetadata());
  ipcMain.handle('cd:get-toc', () => service.getToc());
  ipcMain.handle('cd:play-track', (_e, n, fromSec) => service.playTrack(n, fromSec));
  // 渲染端会把"真实听感位置"一并送过来（只有它知道音频播到了哪），
  // 主进程的墙钟与真实听感之间隔着一个预读缓冲，不能反过来当权威。
  ipcMain.handle('cd:pause', (_e, opts) => service.pause(opts));
  ipcMain.handle('cd:resume', (_e, opts) => service.resume(opts));
  ipcMain.handle('cd:stop', () => service.stopPlayback());
  ipcMain.handle('cd:seek', (_e, seconds) => service.seekTo(seconds));
  ipcMain.handle('cd:set-mode', (_e, mode) => {
    const next = service.setPlayMode(mode);
    /* ★ 播放顺序持久化（v10.5 修复）：原来只改 CdService 内存，
       重启后回到"顺序播放"，用户反馈"播放顺序没保存"。
       启动链路：settings.playMode → CdService 构造 → cd:get-state
       → 渲染端 restoreState → 按钮标签。 */
    settings.update({ playMode: next });
    return next;
  });
  ipcMain.handle('cd:eject', () => service.eject());
  ipcMain.handle('cd:close-door', () => service.closeDoor());
  ipcMain.handle('cd:use-demo', () => service.useDemo());

  /* 运行时切换播放引擎（设置页的 MCI / RAW 切换）。
     成功时 service.switchEngine 会续播当前曲目当前位置；
     失败（如 RAW 起播失败）返回 { ok:false, error }，渲染端保持原引擎。 */
  ipcMain.handle('cd:switch-engine', (_e, engine) => service.switchEngine(engine));

  // 重新获取在线元数据。
  // 现在支持传入 hint（专辑名/歌手），用于冷门碟 / 翻录碟 / MusicBrainz 无收录的碟：
  // 渲染端的编辑面板提供关键词输入框，人工指定后由网易云等源按名称匹配。
  // 编排逻辑集中在 service.refetchMetadata（含缓存忽略、manual 保护、换碟竞态处理）。
  ipcMain.handle('cd:refetch-metadata', (_e, opts) => service.refetchMetadata(opts || {}));

  /* ---------- 音乐库 / 元数据 ---------- */
  ipcMain.handle('meta:list', () => store.list());
  ipcMain.handle('meta:get', (_e, sig) => store.get(sig));
  ipcMain.handle('meta:save', (_e, payload) => {
    const sig = payload && payload.sig;
    const data = payload && payload.data;
    if (!sig || !data) return null;
    const prev = store.get(sig) || {};
    const merged = Object.assign({}, prev, data, {
      signature: sig,
      /**
       * ★ manual 存**编辑内容快照**（对象），不是 true。
       * cd-service 的 _applyManualOverrides 按这个快照在"重新获取在线信息"后
       * 把用户改过的字段盖回去（含逐轨歌词/歌词模型/候选源列表）——
       * 旧实现写的是布尔 true，_applyManualOverrides 首行就 return，
       * "已编辑"徽章上承诺的"在线刷新不会覆盖"实际从未生效。
       */
      manual: data,
      fetchedAt: prev.fetchedAt || new Date().toISOString()
    });
    store.save(merged);
    if (service.signature === sig) service.metadata = merged;
    return store.get(sig);
  });
  ipcMain.handle('meta:remove', (_e, sig) => {
    store.remove(sig);
    return true;
  });
  ipcMain.handle('meta:save-cover', (_e, payload) => {
    const sig = payload && payload.sig;
    const dataUrl = payload && payload.dataUrl;
    if (!sig || !dataUrl) return null;
    const m = /^data:image\/[^;]+;base64,(.*)$/.exec(dataUrl);
    if (!m) return null;
    try {
      store.saveCover(sig, Buffer.from(m[1], 'base64'));
      const meta = store.get(sig);
      if (meta) {
        meta.hasCover = true;
        store.save(meta);
        if (service.signature === sig) service.metadata = meta;
      }
      return store.get(sig);
    } catch (e) {
      return null;
    }
  });

  /* ---------- 歌词源管理（编辑面板） ----------
     选源 / 粘贴 TTML / 删手动候选。逻辑在 metadata/lyrics-select.js，
     这里只做"读缓存 → 操作 → 落盘 → 回传"的管道。 */
  const lyricsSelect = require('./metadata/lyrics-select');

  /**
   * 歌词操作的公共管道：改完必须落盘，并同步当前光驱的内存态。
   * 同时刷新 manual 快照的 tracks —— 否则用户挑好的歌词源会在
   * "重新获取在线信息"后被新鲜抓取结果盖掉。
   *
   * ★ 整体 try/catch 兜底：管道任何一环抛异常（store.get 读盘失败、
   *   selectSource 内部意外、返回值序列化问题）都必须转成
   *   {ok:false, error} 返回，**绝不 reject** —— 渲染端 catch 到 reject
   *   只能显示"未知错误"，真实原因被 IPC 边界吞掉。这是用户侧
   *   "切换歌词源报未知错误"的直接根因。
   */
  const withLyrics = (sig, number, fn) => {
    try {
      let meta = null;
      try { meta = store.get(sig); } catch (e) {
        return { ok: false, error: 'store-read-failed: ' + (e && e.message ? e.message : e) };
      }
      if (!meta) return { ok: false, error: 'no-meta' };
      let r;
      try { r = fn(meta); } catch (e) {
        return { ok: false, error: 'internal: ' + (e && e.message ? e.message : e) };
      }
      if (!r || !r.ok) return r || { ok: false, error: 'failed' };
      const snap = (meta.manual && typeof meta.manual === 'object') ? meta.manual : {};
      meta.manual = Object.assign({}, snap, { tracks: meta.tracks });
      try {
        store.save(meta);
      } catch (e) {
        return { ok: false, error: 'save-failed: ' + (e && e.message ? e.message : e) };
      }
      if (service.signature === sig) service.metadata = meta;
      let fresh = null;
      try { fresh = store.get(sig); } catch (e) { fresh = meta; }
      return { ok: true, meta: fresh };
    } catch (e) {
      return { ok: false, error: 'unexpected: ' + (e && e.message ? e.message : e) };
    }
  };

  ipcMain.handle('lyrics:select-source', (_e, p) => {
    const sig = p && p.sig;
    const number = p && p.number;
    if (!sig || number == null) return { ok: false, error: 'bad-args' };
    return withLyrics(sig, number, (meta) => lyricsSelect.selectSource(meta, number, p.index));
  });
  ipcMain.handle('lyrics:add-ttml', (_e, p) => {
    const sig = p && p.sig;
    const number = p && p.number;
    if (!sig || number == null) return { ok: false, error: 'bad-args' };
    return withLyrics(sig, number, (meta) => lyricsSelect.addTtml(meta, number, p.ttml));
  });
  ipcMain.handle('lyrics:remove-source', (_e, p) => {
    const sig = p && p.sig;
    const number = p && p.number;
    if (!sig || number == null) return { ok: false, error: 'bad-args' };
    return withLyrics(sig, number, (meta) => lyricsSelect.removeSource(meta, number, p.index));
  });

  /* ---------- 全屏歌词字体仓库（v10.8 M4） ----------
     用户上传的字体（ttf/otf/woff/woff2）存 userData/fonts/，
     渲染端经 fl:read-font 拿 dataURL 注入 @font-face。
     所有失败都以 {ok:false, error} 返回，绝不 reject —— 与歌词源
     管道同一条纪律：IPC 边界吞异常会让渲染端只看到"未知错误"。 */
  ipcMain.handle('fl:list-fonts', () => {
    try { return { ok: true, fonts: flFonts.list() }; }
    catch (e) { return { ok: false, error: 'list-failed: ' + (e && e.message ? e.message : e) }; }
  });
  ipcMain.handle('fl:save-font', (_e, p) => {
    try { return flFonts.save(p || {}); }
    catch (e) { return { ok: false, error: 'save-failed: ' + (e && e.message ? e.message : e) }; }
  });
  ipcMain.handle('fl:delete-font', (_e, p) => {
    try { return flFonts.remove(p && p.id); }
    catch (e) { return { ok: false, error: 'delete-failed: ' + (e && e.message ? e.message : e) }; }
  });
  ipcMain.handle('fl:read-font', (_e, p) => {
    try { return flFonts.read(p && p.id); }
    catch (e) { return { ok: false, error: 'read-failed: ' + (e && e.message ? e.message : e) }; }
  });

  /* ---------- 设置 ---------- */
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = settings.update(patch);
    if (typeof next.autoPlay === 'boolean') service.autoPlay = next.autoPlay;
    if (typeof next.ejectReturnToScene === 'boolean') service.ejectReturnToScene = next.ejectReturnToScene;
    /* 语言（v10.11）：悬浮窗是独立渲染进程，收不到主界面的 I18n 广播，
       由这里把新语言推过去。只在真的改了这一项时才推，避免每次存设置都打扰它。 */
    if (patch && typeof patch.lang === 'string') {
      const f = typeof getFloating === 'function' ? getFloating() : null;
      if (f && typeof f.setLang === 'function') f.setLang(patch.lang);
    }
    return next;
  });
  // 桌面悬浮歌词的浮动动画开关（视觉偏好，要立刻推给悬浮窗）
  ipcMain.handle('app:set-float-anim', (_e, p) => {
    const on = !!(p && p.on);
    settings.update({ floatingFloat: on });
    const f = typeof getFloating === 'function' ? getFloating() : null;
    if (f && typeof f.setFloatAnim === 'function') f.setFloatAnim(on);
    return { floatingFloat: on };
  });
  // 桌面悬浮歌词的译/音显隐开关（v10.6，设置页调用，立刻推给悬浮窗）
  ipcMain.handle('app:set-float-show', (_e, p) => {
    const f = typeof getFloating === 'function' ? getFloating() : null;
    if (f && typeof f.setShowOpts === 'function') return f.setShowOpts(p);
    return null;
  });
}

module.exports = { registerIpc, winStateOf };
