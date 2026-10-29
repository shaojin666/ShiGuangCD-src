'use strict';
/* ============================================================
   smtc.js —— Windows 系统媒体控件（SMTC）适配
   ------------------------------------------------------------
   目标：让 Windows 的"媒体弹窗 / 锁屏控制 / 键盘媒体键"显示本软件正在
   播放的歌曲名与专辑封面，并且能通过系统控件播放 / 暂停 / 上一首 / 下一首。

   ★ 核心难点（实测确认，见下）：
     Chromium **只为"页面上真正在播放的 <audio>/<video> 元素"注册 SMTC 会话**。
     仅设置 navigator.mediaSession.metadata / playbackState，在没有媒体元素播放时
     会被**静默忽略**（playbackState 恒为 'none'），系统弹窗里根本看不到本应用。

     而本播放器的声音不走 <audio>：
       · MCI 路径 —— 声音由 Windows mciSendString 直接输出，页面"一片寂静"；
       · RAW 路径 —— 用 WebAudio 播 PCM，Chromium 对纯 AudioContext 不做 SMTC 桥接；
       只有 Demo 路径接近标准媒体播放。
     => 因此仅调用 mediaSession API 在 MCI/RAW 下**必然不生效**。

   解决方案：**静音锚定音频（silent anchor）**
     在页面里放一个隐藏的 <audio>，循环播放一段**运行时生成的无声音频**
     （真正的静音来自"内容本身无声"，而不是 muted 属性 —— muted 的元素
      Chromium 不会授予音频焦点，同样不激活 SMTC）。
     播放时让它播、暂停时让它停，用它"占住"SMTC 会话；
     实际声音仍由 MCI / WebAudio 原样输出，两者互不干扰。

   Reference:
     Chromium issue 40619497 / 944538 —— "Media Session does not support WebAudio"
     Howler.js issue #1661 —— Web Audio 下 MediaSession 不显示，HTML5 Audio 正常
   ============================================================ */

const Smtc = (() => {
  /** 是否可用：非 Windows 或浏览器不支持时静默降级 */
  const supported = typeof navigator !== 'undefined' &&
    !!navigator.mediaSession &&
    typeof (typeof MediaMetadata !== 'undefined' ? MediaMetadata : undefined) === 'function';

  /**
   * 用户开关（设置面板可关）。关闭后：
   *   · 立即清空系统媒体控件；
   *   · 不再创建 / 启停静音锚定音频（彻底停用 SMTC，零开销）；
   *   · 后续 update / setPlaybackState 等调用全部变为空操作。
   * 注意：仅当 supported 为 true 时开关才有意义。
   */
  let enabled = true;

  const state = {
    ready: false,          // 是否已挂载 action handler
    signature: null,       // 当前封面所属光盘签名
    coverDataUrl: null,    // 封面 data URL 缓存
    coverPending: null,    // 正在抓取的 Promise（去重）
    lastMetaKey: ''        // 上次写入的元数据指纹（避免重复 set）
  };

  /** 当前是否真正在工作（支持 + 用户开启） */
  function active() {
    return supported && enabled;
  }

  /**
   * 写入主进程 debug.log（渲染端排查用，失败静默）。
   *
   * ★ 不做去重。debug.log 是**只追加、没有任何轮转**的，
   *   而 `app:log` 是同步 IPC（每条都要跨进程一次），
   *   所以调用频率必须由调用方自己克制 —— 见 diagOnce()。
   */
  function diag(msg) {
    try {
      if (typeof window !== 'undefined' && window.cd && typeof window.cd.invoke === 'function') {
        window.cd.invoke('app:log', '[smtc] ' + msg);
      }
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 同一个 key 的信息**只记一次**（之后静默）。
   *
   * 用途是那些"正常但会反复发生"的消息 —— 记一次足够说明"它工作正常"，
   * 反复记只会把日志撑爆、并且把真正出错的那几行埋掉。
   * 需要持续观察的诊断请走别的手段，不要靠重复刷日志。
   *
   * ⚠ 真正**罕见**的异常（play() 被拒、metadata 写入失败、音频元素报错）
   *   必须继续用 diag() 每次都记 —— 那恰恰是最该被看到的情况。
   */
  const loggedOnce = new Set();
  function diagOnce(key, msg) {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    diag(msg);
  }

  /** 隐藏的静音锚定 <audio>（用于激活并维持 SMTC 会话） */
  let anchor = null;
  let anchorUrl = null;
  let anchorWanted = false;   // 期望锚定音频处于播放态

  /* ---------- 静音锚定音频 ---------- */

  /**
   * 运行时生成一段无声音频（WAV，16bit 单声道 8kHz，约 1 秒），返回 Blob URL。
   * 用 Blob 而不是内联 base64，避免源码里塞一大串常量。
   */
  function makeSilentUrl(seconds, rate) {
    try {
      const samples = Math.max(1, Math.floor((seconds || 1) * rate));
      const dataSize = samples * 2;
      const buf = new ArrayBuffer(44 + dataSize);
      const dv = new DataView(buf);
      const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
      wstr(0, 'RIFF');
      dv.setUint32(4, 36 + dataSize, true);
      wstr(8, 'WAVE');
      wstr(12, 'fmt ');
      dv.setUint32(16, 16, true);          // fmt chunk size
      dv.setUint16(20, 1, true);           // PCM
      dv.setUint16(22, 1, true);           // mono
      dv.setUint32(24, rate, true);
      dv.setUint32(28, rate * 2, true);    // byte rate
      dv.setUint16(32, 2, true);           // block align
      dv.setUint16(34, 16, true);          // bits per sample
      wstr(36, 'data');
      dv.setUint32(40, dataSize, true);
      // 采样区保持 0（静音）
      const blob = new Blob([buf], { type: 'audio/wav' });
      return URL.createObjectURL(blob);
    } catch (e) {
      return null;
    }
  }

  /** 惰性创建隐藏的锚定 <audio>（loop + 非 muted） */
  function ensureAnchor() {
    if (anchor) return anchor;
    if (typeof document === 'undefined' || !document.body) return null;
    try {
      anchorUrl = anchorUrl || makeSilentUrl(1, 8000);
      // 这里返回 null 后 anchorTo() 会每次都重试，所以必须去重，
      // 否则"生成失败"这个持续状态会被记上千万条。
      if (!anchorUrl) { diagOnce('anchor-mksilent-fail', 'anchor: makeSilentUrl 失败'); return null; }
      const a = document.createElement('audio');
      a.setAttribute('data-smtc-anchor', '1');
      a.src = anchorUrl;
      a.loop = true;
      a.preload = 'auto';
      a.volume = 1;
      a.muted = false;                     // ★ 必须非静音，否则拿不到音频焦点
      a.style.display = 'none';
      a.setAttribute('aria-hidden', 'true');
      // 元素出错（极少数环境下 blob 播放被拒）时记录，便于排查
      a.addEventListener('error', () => {
        const m = a.error && a.error.message;
        diag('anchor audio error: ' + m);
        if (typeof console !== 'undefined' && console.warn) console.warn('[smtc] anchor audio error:', m);
      });
      /*
       * ★ 必须用 diagOnce。
       * 锚定音频是一段 1 秒的静音 WAV + loop，Chromium 在**每次循环重播**时
       * 都会再派发一次 `playing`（元素从 ended/间隙回到播放态）。
       * 也就是每秒一条、每天 86400 条 —— debug.log 没有轮转，
       * 跑久了会把它撑到几百 MB，也会把真正出错的那几行埋掉。
       * 而这条消息本身只是"会话已激活"的一次性确认，记一次就够。
       */
      a.addEventListener('playing', () => diagOnce('anchor-playing', 'anchor: playing（SMTC 会话应已激活）'));
      document.body.appendChild(a);
      anchor = a;
      diagOnce('anchor-created', 'anchor: created, src=' + anchorUrl.slice(0, 24));
    } catch (e) {
      // 同上：失败后 anchor 仍为 null，下次调用会重试，这里必须去重
      diagOnce('anchor-create-fail:' + (e && e.message), 'anchor: create failed: ' + (e && e.message));
      anchor = null;
    }
    return anchor;
  }

  /** 让锚定音频跟着真实播放状态启停 */
  function anchorTo(playing) {
    if (!active()) return;
    anchorWanted = !!playing;
    const a = ensureAnchor();
    if (!a) return;
    if (anchorWanted) {
      if (a.paused) {
        const p = a.play();
        /*
         * 自动播放被拦截时（理论上不会，主进程已放开 autoplay policy）记录并忽略。
         * ★ 去重的原因和上面一样：拦截是**持续状态**，a.paused 会一直是 true，
         *   于是每次 anchorTo(true) 都再 play() 一次、再拒一次 —— 不去重就是刷屏。
         *   key 里带上 message，不同原因各记一次。
         */
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            const m = err && err.message;
            diagOnce('anchor-play-reject:' + m, 'anchor: play() 被拒: ' + m);
          });
        }
      }
    } else if (!a.paused) {
      try { a.pause(); } catch (e) { /* 忽略 */ }
    }
  }

  /** 封面 URL：与 app.js 的 coverUrl 保持一致 */
  function coverUrl(sig) {
    return `cover://${encodeURIComponent(sig)}/`;
  }

  /**
   * 把 cover:// 封面抓成 data URL。
   * cover:// 已在主进程注册为 supportFetchAPI 的 standard/secure scheme，
   * 因此这里可以 fetch + FileReader 转 base64。
   */
  function loadCover(sig) {
    if (!sig) return Promise.resolve(null);
    if (state.signature === sig && state.coverDataUrl) return Promise.resolve(state.coverDataUrl);
    if (state.signature === sig && state.coverPending) return state.coverPending;

    state.signature = sig;
    state.coverDataUrl = null;
    state.coverPending = fetch(coverUrl(sig))
      .then((res) => {
        if (!res.ok) throw new Error('cover fetch ' + res.status);
        return res.blob();
      })
      .then((blob) => new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error || new Error('read cover failed'));
        fr.readAsDataURL(blob);
      }))
      .then((dataUrl) => {
        // 封面可能已切换：只保留仍是最新的那次结果
        if (state.signature !== sig) return state.coverDataUrl;
        state.coverDataUrl = dataUrl || null;
        state.coverPending = null;
        return state.coverDataUrl;
      })
      .catch((err) => {
        if (typeof console !== 'undefined' && console.warn) console.warn('[smtc] cover load failed:', err && err.message);
        if (state.signature === sig) state.coverPending = null;
        return null;
      });
    return state.coverPending;
  }

  /** 组装 MediaMetadata 并写入系统控件 */
  function applyMetadata(title, artist, album, artwork) {
    if (!active()) return;
    const key = [title, artist, album, artwork ? artwork.length : 0, artwork && artwork[0] ? artwork[0].src.length : 0].join('\u0001');
    if (key === state.lastMetaKey) return;
    state.lastMetaKey = key;

    const meta = { title: title || T('common.unknownTrack') };
    if (artist) meta.artist = artist;
    if (album) meta.album = album;
    if (artwork && artwork.length) meta.artwork = artwork;

    try {
      navigator.mediaSession.metadata = new MediaMetadata(meta);
      diag('metadata -> title=' + (meta.title || '') + ' | artist=' + (meta.artist || '') +
        ' | artwork=' + (artwork && artwork.length ? 'yes' : 'no'));
    } catch (e) {
      diag('metadata 写入失败: ' + (e && e.message));
    }
  }

  /**
   * 广播当前曲目的元数据到系统控件。
   * @param {{track?:number, metadata?:object, cover?:string, playing?:boolean}} opts
   *   metadata —— 应用保存的整碟元数据（含 tracks[] / album / artist）
   *   cover    —— 封面 URL（cover://...）；无封面传 null
   *   playing  —— 是否正在播放（据此启停静音锚定音频）
   */
  function update(opts) {
    if (!active()) return;
    const o = opts || {};
    const md = o.metadata;
    const trackNo = Number(o.track) || 0;

    // 锚定音频跟随播放状态（激活 / 释放 SMTC 会话的关键）
    if (typeof o.playing === 'boolean') anchorTo(o.playing);

    let title = '';
    let artist = '';
    const album = (md && md.album) || '';
    if (md && md.artist) artist = md.artist;

    if (md && Array.isArray(md.tracks)) {
      const t = md.tracks.find((x) => x.number === trackNo);
      if (t) {
        title = t.title || '';
        if (t.artist) artist = t.artist;
      }
    }
    if (!title && md && md.album) title = md.album;

    // 专辑名附加碟号与曲目号，便于在系统弹窗里辨认（多碟专辑尤其有用）
    let albumLabel = album;
    if (albumLabel) {
      if (md && md.discTotal > 1 && md.discNumber) albumLabel += ' · DISC ' + md.discNumber;
      if (trackNo > 0 && md && md.trackCount) albumLabel += ' · ' + trackNo + '/' + md.trackCount;
    }

    if (!o.cover) {
      applyMetadata(title || album || '拾光 CD', artist, albumLabel, null);
      return;
    }

    // 封面异步转 data URL，完成后重新写入一次
    const sig = md && md.signature;
    loadCover(sig).then((dataUrl) => {
      const artwork = dataUrl
        ? [{ src: dataUrl, sizes: '512x512', type: 'image/jpeg' }]
        : null;
      applyMetadata(title || album || '拾光 CD', artist, albumLabel, artwork);
    });
  }

  /** 同步系统控件的播放状态 */
  function setPlaybackState(s) {
    if (!active()) return;
    try {
      navigator.mediaSession.playbackState =
        (s === 'playing' || s === 'paused') ? s : 'none';
    } catch (e) { /* 忽略 */ }
    anchorTo(s === 'playing');
  }

  /** 设置系统控件里显示的时长 / 进度（让弹窗进度条可用） */
  function setPosition(duration, position) {
    if (!active() || !navigator.mediaSession.setPositionState) return;
    if (!(duration > 0)) return;
    const pos = Math.max(0, Math.min(Number(position) || 0, duration));
    try {
      navigator.mediaSession.setPositionState({
        duration: duration,
        playbackRate: 1,
        position: pos
      });
    } catch (e) { /* 参数越界等，忽略 */ }
  }

  /**
   * 清空系统控件（出舱 / 停止 / 无碟时）。
   * 注意：不受 enabled 开关限制 —— 即使已关闭也要确保控件被清干净、
   * 锚定音频被释放（幂等）。
   */
  function clear() {
    if (!supported) return;
    state.lastMetaKey = '';
    state.signature = null;
    state.coverDataUrl = null;
    state.coverPending = null;
    // 停锚：这里不能走 anchorTo（它会因 active() 为 false 而跳过），直接操作元素
    anchorWanted = false;
    if (anchor && !anchor.paused) {
      try { anchor.pause(); } catch (e) { /* 忽略 */ }
    }
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 打开 / 关闭 SMTC（设置面板开关）。
   * 关闭时会立刻清空系统控件并释放静音锚定音频，此后所有推送变为空操作。
   * @param {boolean} on
   */
  function setEnabled(on) {
    const next = on !== false;
    if (next === enabled) return;
    enabled = next;
    if (!enabled) {
      clear();
      diag('setEnabled: 已关闭（系统媒体控件不再显示，静音锚定音频已释放）');
    } else {
      diag('setEnabled: 已开启');
    }
  }

  /** 当前是否启用（供 UI / 测试查询） */
  function isEnabled() {
    return enabled;
  }

  /** 挂载系统控件按钮的处理函数（只需一次） */
  function bindActions() {
    if (!supported) { diag('不支持 mediaSession，SMTC 已禁用'); return; }
    if (state.ready) return;
    const ms = navigator.mediaSession;
    // app.js 以顶层 const 声明 App（脚本级绑定，不挂在 window 上）。
    // 本函数在 DOMContentLoaded 之后才被调用，此时 app.js 已求值，
    // 故可直接通过裸标识符访问；用 typeof 守卫避免未加载时报错。
    if (typeof App === 'undefined' || !App) return;
    state.ready = true;
    diag('bindActions: mediaSession 可用，开始挂载媒体键处理');

    const set = (action, fn) => {
      try { ms.setActionHandler(action, fn); } catch (e) { /* 不支持的动作忽略 */ }
    };

    // ★ 播放 / 暂停：先同步切换 playbackState（系统要求），再异步真正执行
    set('play', () => {
      if (App.togglePlay) { setPlaybackState('playing'); App.togglePlay(); }
    });
    set('pause', () => {
      if (App.togglePlay) { setPlaybackState('paused'); App.togglePlay(); }
    });
    set('previoustrack', () => { if (App.prev) App.prev(); });
    set('nexttrack', () => { if (App.next) App.next(); });
    set('stop', () => { setPlaybackState('none'); if (App.stop) App.stop(); });
    set('seekbackward', (d) => { if (App.seekBy) App.seekBy(-((d && d.seekOffset) || 10)); });
    set('seekforward', (d) => { if (App.seekBy) App.seekBy((d && d.seekOffset) || 10); });
    set('seekto', (d) => { if (App.seekTo && d && typeof d.seekTime === 'number') App.seekTo(d.seekTime); });
  }

  return {
    supported,
    bindActions,
    update,
    setPlaybackState,
    setPosition,
    clear,
    setEnabled,
    isEnabled,
    // 便于测试 / 排查
    _loadCover: loadCover,
    _ensureAnchor: ensureAnchor,
    _getAnchor: () => anchor,
    _makeSilentUrl: makeSilentUrl,
    _active: active
  };
})();
