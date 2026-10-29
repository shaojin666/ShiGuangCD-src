'use strict';
/* ============================================================
   fl-stage.js —— 全屏歌词演出层主控（代号 Stage）
   ------------------------------------------------------------
   定位：同窗口覆盖层（z:60，挂在 #app 内，不开第二个窗口），
   复用 Transport / App / Visualizer 与主进程统一歌词模型。
   打开时 html.fl-active 让原版 #pages / #bg-stage / #topbar /
   #ceremony 整体 display:none —— 旧歌词界面（滚动 / 旋转 /
   过渡）被合成器整体停摆，这是"节约性能"的真正落点；
   另有 nowplaying.tick/highlight 的显式守卫兜底。

   每帧热路径（唯一 RAF，60fps 纪律）：
     1) 读 Transport.positionSec()（拖动时返回预览值，舞台跟手）
     2) 行定位：全部行一次构建，每帧只写 --d / --ad 两个变量，
        行通过 translateY 滑行；窗口（±8 行）外挂 .fl-out 不绘制
     3) 词级填充：只写当前行每个词 span 的 --wp（CSS 渐变填充）
     4) 鼓点：读 Visualizer.pulse() 写 --fl-beat（值不变不写）
     5) 小胶囊时间 / 进度（transform:scaleX，不触发布局）
   其余一切（主题切换 / 封面取色 / 歌词重建）都是事件驱动的一次性工作。

   与原版的边界：本文件只"读"原版状态（Transport / App.state /
   Visualizer）与"调"原版既有 IPC 通道，不改原版任何行为；
   原版对演出层一无所知（唯一触点：入口按钮与两处守卫，见
   nowplaying.js / app.js 的增量注释）。
   ============================================================ */

window.FlStage = (function () {

  /* ---------- 常量 ---------- */
  const CHROME_IDLE_MS = 2600;    // 无操作多久收起顶栏 / 底部铬件
  const CURSOR_IDLE_MS = 600;     // 铬件收起后再藏多久鼠标指针
  const WINDOW_LINES = 8;         // 行可视窗口（|d| 超过即不绘制）
  const POLL_MS = 400;            // 歌词重载兜底轮询（事件驱动为主）
  const SIZE_MIN = 24, SIZE_MAX = 56;
  /* v10.9 歌词弹出方式（全局，所有主题可套用）：
     all  全部显示（v10.8 行为，默认）
     line 整行弹出：只有唱到的那行以流畅动画落入画面，未唱的行不预显
     word 逐字弹出：行落入后，字到各自的时间才逐个浮现（folia 式） */
  const REVEAL_MODES = ['all', 'line', 'word'];
  const REVEAL_KEYS = {
    all: 'fl.panel.reveal.all', line: 'fl.panel.reveal.line', word: 'fl.panel.reveal.word'
  };
  /** 弹出方式的可读名（i18n；非法 id 原样返回） */
  function revealLabel(id) {
    const k = REVEAL_KEYS[id];
    return k ? T(k) : id;
  }

  /* ---------- 状态 ---------- */
  const S = {
    inited: false,
    open: false,
    stage: null, lyrics: null, fx: null, bgCover: null,
    built: null,            // FlLyrics.build 结果
    loadedKey: '',
    active: -1,
    raf: 0, lastT: 0,
    lastPoll: 0,
    reloadPending: false,
    theme: 'lumen',
    themeHandle: null,
    mountGen: 0,             // 主题挂载代次：作废迟到的异步 resolve（防篡位）
    closeTimer: 0,
    chromeTimer: 0, cursorTimer: 0,
    lastPulse: -1, lastBass: -1,
    coverUrl: '',
    pref: { theme: 'lumen', size: 34, showTr: true, showRo: true, reveal: 'all', params: {} }
  };

  /* ---------- 外壳 HTML（类名 / ID 契约见 fl-stage.css） ----------
     文案一律走 i18n：外壳只在首次打开时构建一次，语言切换后由
     applyShellText() 原地回填 title / aria-label（不重建 DOM，
     避免丢掉已绑定的监听器与主题挂载状态）。 */

  function shellHtml() {
    return '<div id="fl-bg" class="fl-layer" aria-hidden="true">'
      + '<div class="fl-bg-cover" id="fl-bg-cover"></div>'
      + '<div class="fl-blob b1"></div><div class="fl-blob b2"></div><div class="fl-blob b3"></div>'
      + '<div class="fl-bg-scrim"></div>'
      + '</div>'
      + '<div id="fl-fx" class="fl-layer" aria-hidden="true"></div>'
      + '<div id="fl-lyrics" class="fl-layer"></div>'
      + '<div class="fl-veil" aria-hidden="true"></div>'
      + '<header class="fl-chrome fl-top">'
      + '  <div class="fl-group">'
      + '    <button id="fl-back" class="fl-btn" type="button" title="' + esc(T('fl.backTitle')) + '" aria-label="' + esc(T('fl.back')) + '">'
      + '      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>'
      + '    </button>'
      + '    <button id="fl-tracks-btn" class="fl-btn" type="button" title="' + esc(T('fl.tracksTitle')) + '" aria-label="' + esc(T('fl.tracks')) + '">'
      + '      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
      + '    </button>'
      + '    <button id="fl-theme-btn" class="fl-btn" type="button" title="' + esc(T('fl.themeTitle')) + '" aria-label="' + esc(T('fl.theme')) + '">'
      + '      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.6l2.1 5.6 5.6 2.1-5.6 2.1L12 18l-2.1-5.6L4.3 10.3l5.6-2.1z"/><path d="M18.6 15.6l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/></svg>'
      + '    </button>'
      + '  </div>'
      + '  <div class="fl-group">'
      + '    <button id="fl-full" class="fl-btn win" type="button" title="' + esc(T('fl.fullTitle')) + '" aria-label="' + esc(T('common.fullscreen')) + '">'
      + '      <svg class="wi w-enter" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>'
      + '      <svg class="wi w-exit" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/></svg>'
      + '    </button>'
      + '    <span class="fl-sep" aria-hidden="true"></span>'
      + '    <button id="fl-min" class="fl-btn win" type="button" title="' + esc(T('fl.minimize')) + '" aria-label="' + esc(T('fl.minimize')) + '">'
      + '      <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><path d="M1 5.5h9" stroke="currentColor" stroke-width="1"/></svg>'
      + '    </button>'
      + '    <button id="fl-max" class="fl-btn win" type="button" title="' + esc(T('fl.maximize')) + '" aria-label="' + esc(T('fl.maximize')) + '">'
      + '      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><rect x="1" y="1" width="9" height="9"/></svg>'
      + '    </button>'
      + '    <button id="fl-close" class="fl-btn win close" type="button" title="' + esc(T('fl.close')) + '" aria-label="' + esc(T('fl.close')) + '">'
      + '      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" aria-hidden="true"><path d="M1 1l9 9M10 1l-9 9"/></svg>'
      + '    </button>'
      + '  </div>'
      + '</header>'
      + '<footer class="fl-chrome fl-bottom"></footer>';
  }

  /** HTML 属性值转义（词典是纯文本，但仍防住引号 / 尖括号） */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 语言切换：原地回填外壳按钮的 title / aria-label（不重建 DOM） */
  function applyShellText() {
    const st = S.stage;
    if (!st) return;
    const set = (id, titleKey, ariaKey) => {
      const b = st.querySelector('#' + id);
      if (!b) return;
      if (titleKey) b.title = T(titleKey);
      if (ariaKey) b.setAttribute('aria-label', T(ariaKey));
    };
    set('fl-back', 'fl.backTitle', 'fl.back');
    set('fl-tracks-btn', 'fl.tracksTitle', 'fl.tracks');
    set('fl-theme-btn', 'fl.themeTitle', 'fl.theme');
    set('fl-min', 'fl.minimize', 'fl.minimize');
    set('fl-max', 'fl.maximize', 'fl.maximize');
    set('fl-close', 'fl.close', 'fl.close');
    // 全屏按钮：title/aria 随窗口态变化，交给 onWinState 统一刷新
    const full = st.querySelector('#fl-full');
    if (full) onWinState({ fullScreen: full.classList.contains('on') });
  }

  /* ---------- 外壳构建 ---------- */

  function buildIfNeeded() {
    if (S.stage) return;
    const stage = document.createElement('div');
    stage.id = 'fl-stage';
    stage.className = 'hidden';
    stage.setAttribute('aria-hidden', 'true');
    stage.dataset.theme = 'lumen';
    stage.innerHTML = shellHtml();
    document.getElementById('app').appendChild(stage);
    S.stage = stage;
    S.lyrics = stage.querySelector('#fl-lyrics');
    S.fx = stage.querySelector('#fl-fx');
    S.bgCover = stage.querySelector('#fl-bg-cover');
    wireChrome();
  }

  /** 顶栏铬件：返回 / 主题 / 全屏 / Windows 三金刚（通道与主界面顶栏一致） */
  function wireChrome() {
    const st = S.stage;
    const bind = (id, fn) => {
      const b = st.querySelector('#' + id);
      if (b) b.addEventListener('click', (e) => { e.stopPropagation(); fn(); poke(); });
    };
    bind('fl-back', () => close());
    bind('fl-tracks-btn', () => { FlTracks.toggle(); });
    bind('fl-theme-btn', () => { FlPanel.toggle(); });
    bind('fl-full', () => invoke('app:win-fullscreen'));
    bind('fl-min', () => invoke('app:win-minimize'));
    bind('fl-max', () => invoke('app:win-toggle-maximize'));
    bind('fl-close', () => invoke('app:win-close'));
  }

  function invoke(channel) {
    try {
      if (window.cd && typeof window.cd.invoke === 'function') {
        window.cd.invoke(channel).catch(() => { /* 忽略 */ });
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 封面取色（色板 → CSS 变量） ---------- */

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h / 6, s: s, l: l };
  }

  function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const f = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      r = f(h + 1 / 3); g = f(h); b = f(h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  const rgbStr = (c) => 'rgb(' + c[0] + ', ' + c[1] + ', ' + c[2] + ')';

  /**
   * 从 48×48 缩略图数据里挑色板：
   *   c1/c2/c3  三个主色（光斑用，按饱和度×纯度加权取 top3 色相桶）
   *   scrim     压暗强度（封面越亮压得越狠，保证文字可读）
   *   accent    强调色（菜单 / 面板 / 滑条）
   * 灰度封面（没有彩色桶）时用平均色兜底，绝不返回 null 之外的异常。
   */
  function analyzePixels(data) {
    const buckets = [];
    for (let i = 0; i < 16; i++) buckets.push({ n: 0, r: 0, g: 0, b: 0, w: 0 });
    let ar = 0, ag = 0, ab = 0, an = 0, lumSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (data[i + 3] < 200) continue;
      ar += r; ag += g; ab += b; an++;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum;
      if (lum < 14 || lum > 246) continue;            // 近黑近白不参与彩色挑选
      const hsl = rgbToHsl(r, g, b);
      if (hsl.s < 0.12) continue;                     // 灰不参与
      const idx = Math.min(15, Math.max(0, Math.floor(hsl.h * 16)));
      const bk = buckets[idx];
      bk.n++; bk.r += r; bk.g += g; bk.b += b;
      bk.w += hsl.s * (1 - Math.abs(hsl.l - 0.5) * 0.6);
    }
    if (!an) return null;
    const avg = [Math.round(ar / an), Math.round(ag / an), Math.round(ab / an)];
    const avgLum = lumSum / an;

    // top3 色相桶 → 调到一个适合当光斑的明度 / 饱和度
    const picked = buckets
      .filter((b) => b.n >= 2)
      .sort((x, y) => y.w - x.w)
      .slice(0, 3)
      .map((b) => {
        const hsl = rgbToHsl(b.r / b.n, b.g / b.n, b.b / b.n);
        const s = Math.max(0.42, Math.min(0.85, hsl.s));
        const l = 0.52;
        return hslToRgb(hsl.h, s, l);
      });
    while (picked.length < 3) {
      // 不足三个主色：从平均色派生（错开色相），保证三层光斑都有颜色
      const hsl = rgbToHsl(avg[0], avg[1], avg[2]);
      const h = (hsl.h + 0.18 * (picked.length + 1)) % 1;
      picked.push(hslToRgb(h, Math.max(0.3, hsl.s), 0.5));
    }

    // 压暗：亮封面多压、暗封面少压（文字始终是浅色）
    const scrim = avgLum > 150 ? 0.72 : (avgLum > 90 ? 0.6 : 0.46);
    // 强调色：第一主色提亮
    const a = rgbToHsl(picked[0][0], picked[0][1], picked[0][2]);
    const accent = hslToRgb(a.h, Math.max(0.45, a.s), 0.62);
    const accentStrong = hslToRgb(a.h, Math.max(0.5, a.s), 0.78);

    return {
      c1: rgbStr(picked[0]), c2: rgbStr(picked[1]), c3: rgbStr(picked[2]),
      scrim: scrim.toFixed(2),
      accent: rgbStr(accent), accentStrong: rgbStr(accentStrong)
    };
  }

  function extractColors(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 48; c.height = 48;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, 48, 48);
          resolve(analyzePixels(g.getImageData(0, 0, 48, 48).data));
        } catch (e) {
          // canvas 被污染（协议无 CORS 头等）：静默保留默认色板
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function applyPalette(pal) {
    const st = S.stage;
    if (!st) return;
    if (!pal) {
      // 删掉自定义变量，让 CSS 默认值（金色 / 蓝 / 锈红）生效
      ['--fl-c1', '--fl-c2', '--fl-c3', '--fl-scrim', '--fl-accent', '--fl-accent-strong']
        .forEach((n) => st.style.removeProperty(n));
      return;
    }
    st.style.setProperty('--fl-c1', pal.c1);
    st.style.setProperty('--fl-c2', pal.c2);
    st.style.setProperty('--fl-c3', pal.c3);
    st.style.setProperty('--fl-scrim', pal.scrim);
    st.style.setProperty('--fl-accent', pal.accent);
    st.style.setProperty('--fl-accent-strong', pal.accentStrong);
  }

  function setCover(url) {
    url = url || '';
    if (url === S.coverUrl) return;
    S.coverUrl = url;
    if (S.bgCover) {
      if (url) {
        S.bgCover.style.backgroundImage = 'url("' + url + '")';
        S.bgCover.classList.add('on');
      } else {
        S.bgCover.classList.remove('on');
      }
    }
    if (!url) { applyPalette(null); return; }
    extractColors(url).then(applyPalette).catch(() => applyPalette(null));
  }

  function setCoverFromMeta() {
    const md = App.state.metadata;
    const url = (md && md.hasCover && md.signature)
      ? 'cover://' + encodeURIComponent(md.signature) + '/'
      : '';
    setCover(url);
  }

  /* ---------- 歌词装载 ---------- */

  function trackOf(n) {
    const md = App.state.metadata;
    return (md && md.tracks) ? md.tracks.find((t) => t.number === n) : null;
  }

  /** 装载键：碟签名 # 曲目号 + 数据形态（M 模型 / L 经典 / - 无）。
   *  带上形态是为了"歌词后到"（抓取完成补推）也能触发重建。 */
  function lyricsKey() {
    const md = App.state.metadata;
    const tr = trackOf(Transport.track);
    const hasModel = !!(tr && tr.lyricsData && Array.isArray(tr.lyricsData.lines) && tr.lyricsData.lines.length);
    const hasLrc = !!(tr && tr.lyrics);
    return (md && md.signature ? md.signature : '?') + '#' + Transport.track
      + ':' + (hasModel ? 'M' : (hasLrc ? 'L' : '-'));
  }

  function ensureLyrics(force) {
    const key = lyricsKey();
    if (!force && key === S.loadedKey) return;
    S.loadedKey = key;
    rebuild();
  }

  function rebuild() {
    const tr = trackOf(Transport.track);
    let built = null;
    if (tr && tr.lyricsData && Array.isArray(tr.lyricsData.lines) && tr.lyricsData.lines.length) {
      built = FlLyrics.build(S.lyrics, tr.lyricsData);
    } else if (tr && tr.lyrics) {
      /* 无统一模型时的经典 LRC 兜底。与原版的差异：原版对"无时间轴
         纯文本"也会渲染（可阅读但不高亮）；演出层的一切动效都挂在
         时间轴上，纯文本只会静止成一行 —— 因此只接受带时间戳的 LRC
         （parseLrc 解析不出内容时返回空，自然落入"暂无歌词"空态）。 */
      built = FlLyrics.buildFromLrc(S.lyrics, tr.lyrics);
    }
    if (!built || !built.count) {
      FlLyrics.showEmpty(S.lyrics, T('fl.empty.noLyrics'));
      built = null;
    }
    S.built = built;
    S.active = -1;
    S.stage.classList.toggle('word-mode', !!(built && built.wordMode));
    if (S.themeHandle && typeof S.themeHandle.onLyrics === 'function') {
      try { S.themeHandle.onLyrics(built); } catch (e) { /* 主题钩子异常不影响演出 */ }
    }
  }

  /* ---------- 每帧：行定位 + 词填充 ---------- */

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function updateLines(pos) {
    const recs = S.built && S.built.recs;
    if (!recs || !recs.length) return;

    // 当前行：最后一行 t <= pos
    let cur = -1;
    for (let i = recs.length - 1; i >= 0; i--) {
      if (pos >= recs[i].t - 0.0001) { cur = i; break; }
    }

    // 连续滑行：向下一行 smoothstep 插值 —— 行随播放进度平滑滑动，
    // 到下一行起点时恰好归位（folia 式手感，避免"到点跳一下"）
    let glide = 0;
    if (cur >= 0 && cur + 1 < recs.length) {
      const a = recs[cur].t, b = recs[cur + 1].t;
      if (b > a + 0.001) {
        const f = (pos - a) / (b - a);
        glide = f * f * (3 - 2 * f);
      }
    } else if (cur < 0 && recs[0].t > 0.001) {
      // 第一句之前：从画面外一格滑入
      const f = pos / recs[0].t;
      glide = f * f * (3 - 2 * f);
    }
    const curPos = cur + glide;

    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const d = i - curPos;
      const ad = d < 0 ? -d : d;
      if (ad > WINDOW_LINES) {
        if (!rec.out) {
          rec.el.classList.add('fl-out'); rec.out = true;
          /* 清掉窗口内残留的 --d/--ad：避免主题规则里以 --ad 计算的
             opacity/transform 在窗口外继续按陈旧距离取值（虽被 fl-out
             压掉，但清掉更干净，也让重新入场时从零写起） */
          rec.el.style.removeProperty('--d'); rec.el.style.removeProperty('--ad');
          rec.lastD = undefined; rec.lastAd = undefined;
        }
        continue;
      }
      if (rec.out) { rec.el.classList.remove('fl-out'); rec.out = false; }
      if (rec.lastD === undefined || Math.abs(d - rec.lastD) > 0.003) {
        rec.el.style.setProperty('--d', d.toFixed(4));
        rec.lastD = d;
      }
      if (rec.lastAd === undefined || Math.abs(ad - rec.lastAd) > 0.003) {
        rec.el.style.setProperty('--ad', ad.toFixed(4));
        rec.lastAd = ad;
      }
    }

    // 当前行切换
    if (cur !== S.active) {
      if (S.active >= 0 && recs[S.active]) recs[S.active].el.classList.remove('active');
      if (cur >= 0) recs[cur].el.classList.add('active');
      S.active = cur;
      if (S.themeHandle && typeof S.themeHandle.onLine === 'function') {
        try { S.themeHandle.onLine(cur >= 0 ? recs[cur] : null, cur); } catch (e) { /* 忽略 */ }
      }
    }

    /* v10.9 揭示状态机（line / word 模式）：无状态量，全部由 cur 推导 ——
       当前行落入画面（rv-on），已唱过的行向上淡出（rv-past），未唱的行
       藏在下方（不占空间也不预显，folia 式）。类只在跃迁时写一次；
       all 模式整个循环跳过（零成本）。 */
    if (S.pref.reveal !== 'all') {
      for (let i = 0; i < recs.length; i++) {
        const rec = recs[i];
        const wantRv = (i === cur);
        if (rec.rv !== wantRv) {
          rec.rv = wantRv;
          rec.el.classList.toggle('rv-on', wantRv);
        }
        const wantPast = (i < cur);
        if (rec.past !== wantPast) {
          rec.past = wantPast;
          rec.el.classList.toggle('rv-past', wantPast);
        }
      }
    }

    // 词级填充（仅当前行、仅词级模型）
    if (cur >= 0 && S.built.wordMode) {
      const rec = recs[cur];
      const words = rec.words;
      for (let k = 0; k < words.length; k++) {
        const w = words[k];
        const span = w.e - w.t;
        let wp = span > 0.001 ? (pos - w.t) / span : (pos >= w.t ? 1 : 0);
        wp = clamp01(wp);
        if (w.wp < 0 || Math.abs(wp - w.wp) > 0.004) {
          w.el.style.setProperty('--wp', wp.toFixed(3));
          w.wp = wp;
        }
        /* 逐字弹出（word 模式）：词到时间才浮现。门控走 w-on 类，
           CSS 只动 opacity/filter——whisper 在 .fl-w 上的 translate
           动画不受影响。类只在跃迁时写。 */
        if (S.pref.reveal === 'word') {
          const on = wp > 0.001;
          if (w.on !== on) { w.on = on; w.el.classList.toggle('w-on', on); }
        } else if (w.on) {
          w.on = false; w.el.classList.remove('w-on');
        }
      }
      // 对唱背景人声：按自己的时间轴独立填充
      const bgs = rec.bgs;
      for (let k = 0; k < bgs.length; k++) {
        const bw = bgs[k].words;
        if (!bw || !bw.length) continue;
        const bspan = bgs[k].e - bgs[k].t;
        for (let j = 0; j < bw.length; j++) {
          const w = bw[j];
          const span = w.e - w.t;
          let wp = span > 0.001 ? (pos - w.t) / span : (pos >= w.t ? 1 : 0);
          wp = clamp01(wp);
          if (w.wp < 0 || Math.abs(wp - w.wp) > 0.004) {
            w.el.style.setProperty('--wp', wp.toFixed(3));
            w.wp = wp;
          }
          if (S.pref.reveal === 'word') {
            const on = wp > 0.001;
            if (w.on !== on) { w.on = on; w.el.classList.toggle('w-on', on); }
          } else if (w.on) {
            w.on = false; w.el.classList.remove('w-on');
          }
        }
        void bspan;
      }
    }
  }

  /* ---------- 每帧：鼓点 / 胶囊 ---------- */

  function updateBeat() {
    if (!window.Visualizer) return;
    const pulse = Visualizer.pulse();
    if (Math.abs(pulse - S.lastPulse) > 0.004) {
      S.lastPulse = pulse;
      S.stage.style.setProperty('--fl-beat', pulse.toFixed(3));
    }
    const bass = Visualizer.bass();
    if (Math.abs(bass - S.lastBass) > 0.004) {
      S.lastBass = bass;
      S.stage.style.setProperty('--fl-bass', bass.toFixed(3));
    }
  }

  function frame(t) {
    if (!S.open) { S.raf = 0; return; }
    S.raf = requestAnimationFrame(frame);
    const dt = S.lastT ? Math.min(0.1, Math.max(0.001, (t - S.lastT) / 1000)) : 0.016;
    S.lastT = t;

    // 歌词重载：事件驱动（Transport / cd:metadata）为主，400ms 兜底
    if (S.reloadPending || t - S.lastPoll > POLL_MS) {
      ensureLyrics(false);
      S.reloadPending = false;
      S.lastPoll = t;
    }

    const pos = Transport.positionSec();
    updateLines(pos);
    updateBeat();
    FlCapsule.tick(pos, Transport.durationSec);

    if (S.themeHandle && typeof S.themeHandle.frame === 'function') {
      try {
        S.themeHandle.frame(dt, {
          pos: pos,
          pulse: window.Visualizer ? Visualizer.pulse() : 0,
          bass: window.Visualizer ? Visualizer.bass() : 0,
          level: window.Visualizer ? Visualizer.level() : 0
        });
      } catch (e) { /* 主题逐帧异常不影响其余演出 */ }
    }
  }

  /* ---------- 自动隐藏 + 指针隐身 ---------- */

  function menuOpen() {
    const m = S.stage && S.stage.querySelector('#fl-menu');
    return !!(m && !m.classList.contains('hidden'));
  }

  /** 面板 / 菜单开着时铬件不收起（用户正在里面操作） */
  function chromeHeld() {
    return FlPanel.isOpen() || FlTracks.isOpen() || menuOpen();
  }

  function armHide() {
    if (S.chromeTimer) { clearTimeout(S.chromeTimer); S.chromeTimer = 0; }
    S.chromeTimer = setTimeout(() => {
      S.chromeTimer = 0;
      if (!S.open) return;
      if (chromeHeld()) { armHide(); return; }
      S.stage.classList.add('fl-chrome-off');
      if (S.cursorTimer) clearTimeout(S.cursorTimer);
      S.cursorTimer = setTimeout(() => {
        S.cursorTimer = 0;
        if (!S.open || chromeHeld()) return;
        document.documentElement.classList.add('fl-idle');
      }, CURSOR_IDLE_MS);
    }, CHROME_IDLE_MS);
  }

  /** 有任何交互就重置计时（鼠标移动 / 点击 / 滚轮 / 按键） */
  function poke() {
    if (!S.open) return;
    S.stage.classList.remove('fl-chrome-off');
    document.documentElement.classList.remove('fl-idle');
    if (S.cursorTimer) { clearTimeout(S.cursorTimer); S.cursorTimer = 0; }
    armHide();
  }

  /* ---------- 主题 ---------- */

  function disposeTheme() {
    /* 代次自增：任何在途的异步 mount（镜台懒加载 three.js）resolve 后
       发现自己已过时 → 自行卸掉，不安装、不篡位 */
    S.mountGen++;
    const h = S.themeHandle;
    S.themeHandle = null;
    if (h && typeof h.dispose === 'function') {
      try { h.dispose(); } catch (e) { /* 忽略 */ }
    }
    if (S.fx) S.fx.innerHTML = '';   // canvas 主题的画布随主题一起清
  }

  function mountTheme() {
    const def = FlThemes.get(S.theme);
    if (!def || typeof def.mount !== 'function') { S.themeHandle = null; return; }
    let ctx;
    try { ctx = FlThemes.makeCtx(S.stage); } catch (e) { return; }
    ctx.data = S.built;
    const gen = S.mountGen;           // 本次挂载的代次快照
    let h = null;
    try { h = def.mount(ctx); } catch (e) { h = null; }
    if (h && typeof h.then === 'function') {
      // 异步主题（镜台懒加载 three.js）：就绪后再补一次歌词回调
      h.then((hh) => {
        if (gen !== S.mountGen) {
          // 切换已发生：迟到的挂载自行卸载（dispose 自管画布/监听器）
          if (hh && typeof hh.dispose === 'function') {
            try { hh.dispose(); } catch (e) { /* 忽略 */ }
          }
          return;
        }
        S.themeHandle = hh || null;
        if (S.themeHandle && typeof S.themeHandle.onLyrics === 'function') {
          try { S.themeHandle.onLyrics(S.built); } catch (e) { /* 忽略 */ }
        }
      }).catch(() => { /* 加载失败：保持在无 handle 的纯 CSS 形态 */ });
    } else {
      S.themeHandle = h || null;
      if (S.themeHandle && typeof S.themeHandle.onLyrics === 'function') {
        try { S.themeHandle.onLyrics(S.built); } catch (e) { /* 忽略 */ }
      }
    }
  }

  /**
   * 切换主题：veil 交叉淡入 → 换挂 → 淡出。
   * @param {string} id
   * @param {{persist?:boolean}} [opts]
   */
  function setTheme(id, opts) {
    if (!FlThemes.has(id)) return;
    const persist = !opts || opts.persist !== false;
    const apply = () => {
      disposeTheme();
      S.theme = id;
      S.stage.dataset.theme = id;
      S.pref.theme = id;
      applyThemeParams();
      mountTheme();
      // 面板参数区跟随（程序化切主题也保持同步）
      if (window.FlPanel && typeof window.FlPanel.syncParams === 'function') {
        try { window.FlPanel.syncParams(); } catch (e) { /* 忽略 */ }
      }
      S.stage.classList.remove('fl-switching');
    };
    if (id === S.theme && S.stage.dataset.theme === id) { apply(); return; }
    S.stage.classList.add('fl-switching');
    setTimeout(apply, 200);
    if (persist) {
      try { window.cd.invoke('settings:set', { flTheme: id }).catch(() => { /* 忽略 */ }); } catch (e) { /* 忽略 */ }
    }
    const def = FlThemes.get(id);
    if (def && typeof Toast === 'function') Toast(T('fl.toast.theme', { name: FlThemes.nameOf(def) }));
  }

  /* ---------- 歌词显示开关 / 字号 ---------- */

  function setSize(px) {
    const v = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Number(px) || 34));
    S.pref.size = v;
    S.stage.style.setProperty('--fl-size', v + 'px');
  }

  function setShowTr(on) {
    S.pref.showTr = on !== false;
    S.stage.classList.toggle('no-tr', !S.pref.showTr);
  }

  function setShowRo(on) {
    S.pref.showRo = on !== false;
    S.stage.classList.toggle('no-ro', !S.pref.showRo);
  }

  /** v10.9 弹出方式：all / line / word（非法值回落 all） */
  function setReveal(mode) {
    const m = REVEAL_MODES.indexOf(mode) >= 0 ? mode : 'all';
    S.pref.reveal = m;
    S.stage.dataset.reveal = m;
    if (m === 'all') clearRevealClasses();
    // 面板 chip 跟随（程序化切换也保持同步，与 setTheme→syncParams 同律）
    if (window.FlPanel && typeof window.FlPanel.syncReveal === 'function') {
      try { window.FlPanel.syncReveal(); } catch (e) { /* 忽略 */ }
    }
  }

  /** 回到 all：清掉所有揭示残留类（rv-on / rv-past / w-on），避免行卡在隐藏态 */
  function clearRevealClasses() {
    const recs = S.built && S.built.recs;
    if (!recs) return;
    for (const rec of recs) {
      rec.el.classList.remove('rv-on', 'rv-past');
      rec.rv = undefined; rec.past = undefined;
      for (const w of rec.words) { w.el.classList.remove('w-on'); w.on = false; }
      for (const b of rec.bgs) {
        for (const w of (b.words || [])) { w.el.classList.remove('w-on'); w.on = false; }
      }
    }
  }

  function applyPref(settings) {
    const s = settings || {};
    S.pref.theme = FlThemes.has(s.flTheme) ? s.flTheme : 'lumen';
    S.pref.size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Number(s.flSize) || 34));
    S.pref.showTr = s.flShowTr !== false;
    S.pref.showRo = s.flShowRo !== false;
    S.pref.reveal = REVEAL_MODES.indexOf(s.flReveal) >= 0 ? s.flReveal : 'all';
    /* 主题参数：{ <themeId>: { <key>: value } }，缺省值以主题 def.params 为准 */
    S.pref.params = (s.flParams && typeof s.flParams === 'object' && !Array.isArray(s.flParams)) ? s.flParams : {};
    S.theme = S.pref.theme;
    S.stage.dataset.theme = S.pref.theme;
    S.stage.dataset.reveal = S.pref.reveal;
    S.stage.style.setProperty('--fl-size', S.pref.size + 'px');
    S.stage.classList.toggle('no-tr', !S.pref.showTr);
    S.stage.classList.toggle('no-ro', !S.pref.showRo);
    applyThemeParams();
  }

  /* ---------- 主题参数（--fl-p-<key>） ---------- */

  /** 取某主题某参数的当前值（设置值优先，否则主题默认值） */
  function paramValue(themeId, key, def) {
    const bag = S.pref.params && S.pref.params[themeId];
    const v = bag ? bag[key] : undefined;
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  /** 把当前主题的全部参数写上台舞（--fl-p-<key>），并清掉别的主题残留 */
  function applyThemeParams() {
    const st = S.stage;
    for (let i = st.style.length - 1; i >= 0; i--) {
      const n = st.style.item(i);
      if (n && n.indexOf('--fl-p-') === 0) st.style.removeProperty(n);
    }
    const def = FlThemes.get(S.theme);
    if (!def || !Array.isArray(def.params)) return;
    for (const p of def.params) {
      if (!p || typeof p.key !== 'string') continue;
      st.style.setProperty('--fl-p-' + p.key, String(paramValue(def.id, p.key, p.def)));
    }
  }

  /**
   * 改一个主题参数（面板滑条调用）：即时生效 + 记忆（不落盘，落盘由面板负责）
   * @param {string} key 参数 key（对当前主题无效的 key 直接忽略）
   * @param {number} value
   */
  function setThemeParam(key, value) {
    const def = FlThemes.get(S.theme);
    if (!def || !Array.isArray(def.params)) return;
    const p = def.params.find((x) => x && x.key === key);
    if (!p) return;
    let v = Number(value);
    if (!isFinite(v)) return;
    v = Math.max(p.min, Math.min(p.max, v));
    if (!S.pref.params[S.theme]) S.pref.params[S.theme] = {};
    S.pref.params[S.theme][key] = v;
    S.stage.style.setProperty('--fl-p-' + key, String(v));
    /* 需要重算内部量的主题（如镜台按 density 调粒子数）：异步 handle
       就绪前 onParam 不存在，等 mount 的 Promise resolve 后由 onLyrics
       路径自然带上当期参数（GL/2D 分支每帧读 --fl-p-density） */
    const h = S.themeHandle;
    if (h && typeof h.onParam === 'function') {
      try { h.onParam(key, v); } catch (e) { /* 忽略 */ }
    }
  }

  /** 清空全部主题参数记忆并回到默认值（面板「恢复默认」） */
  function resetParams() {
    S.pref.params = {};
    applyThemeParams();
    /* 通知主题按默认值重算（镜台粒子密度等内部量依赖参数通知） */
    const def = FlThemes.get(S.theme);
    const h = S.themeHandle;
    if (def && Array.isArray(def.params) && h && typeof h.onParam === 'function') {
      for (const p of def.params) {
        if (p && typeof p.key === 'string') {
          try { h.onParam(p.key, p.def); } catch (e) { /* 忽略 */ }
        }
      }
    }
  }

  /* ---------- 键盘 ---------- */

  function onKey(e) {
    if (!S.open) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    const tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        if (FlPanel.isOpen()) FlPanel.close();
        else if (FlTracks.isOpen()) FlTracks.close();
        else if (menuOpen()) FlCapsule.closeMenu();
        else close();
        break;
      case 'f': case 'F':
        e.preventDefault();
        invoke('app:win-fullscreen');
        break;
      case 't': case 'T':
        e.preventDefault();
        FlPanel.toggle();
        break;
      case 'l': case 'L':
        e.preventDefault();
        FlTracks.toggle();
        break;
      case ' ':
      case 'Spacebar':
      case 'k': case 'K':
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
        App.setVolume(App.state.volume + 0.05);
        break;
      case 'ArrowDown':
        e.preventDefault();
        App.setVolume(App.state.volume - 0.05);
        break;
      default:
        break;
    }
    FlCapsule.sync();
    poke();
  }

  /* ---------- 窗口状态同步（全屏键图标） ---------- */

  function onWinState(st) {
    if (!st || !S.stage) return;
    const full = S.stage.querySelector('#fl-full');
    if (full) {
      const on = !!st.fullScreen;
      full.classList.toggle('on', on);
      full.title = T(on ? 'fl.exitFullTitle' : 'fl.fullTitle');
      full.setAttribute('aria-label', T(on ? 'common.exitFullscreen' : 'common.fullscreen'));
    }
  }

  /* ---------- 语言切换 ---------- */

  /**
   * 整体重刷演出层文案（播放状态 / 主题 / 歌词数据一律不动）：
   *   1) 外壳按钮 title / aria-label 原地回填
   *   2) 空态歌词文案（无歌词时才有）
   *   3) 三个子面板各自重建（主题面板 / 选歌 / 小胶囊）
   */
  function applyLang() {
    if (!S.stage) return;
    applyShellText();
    if (!S.built && S.open) {
      // 空态文案写在 DOM 里，需要重排一次（歌词本身不翻译）
      try { rebuild(); } catch (e) { /* 忽略 */ }
    }
    if (typeof FlPanel !== 'undefined' && typeof FlPanel.applyLang === 'function') {
      try { FlPanel.applyLang(); } catch (e) { /* 忽略 */ }
    }
    if (typeof FlTracks !== 'undefined' && typeof FlTracks.applyLang === 'function') {
      try { FlTracks.applyLang(); } catch (e) { /* 忽略 */ }
    }
    if (typeof FlCapsule !== 'undefined' && typeof FlCapsule.applyLang === 'function') {
      try { FlCapsule.applyLang(); } catch (e) { /* 忽略 */ }
    }
  }

  /* ---------- 生命周期 ---------- */

  function open() {
    if (S.open) return;
    buildIfNeeded();
    S.open = true;
    S.stage.classList.remove('hidden');
    S.stage.setAttribute('aria-hidden', 'false');
    void S.stage.offsetHeight;               // 强制回流：让 opacity 过渡生效
    S.stage.classList.add('fl-on');
    document.documentElement.classList.add('fl-active');

    // 数据就绪（歌词 / 胶囊 / 封面色板）
    ensureLyrics(true);
    FlCapsule.sync();
    setCoverFromMeta();

    // 主题挂载（每次打开挂、每次关闭卸 —— 3D 主题的 GL 上下文不常驻）
    if (!S.themeHandle) mountTheme();

    // 位置时钟
    S.lastT = 0;
    S.reloadPending = true;
    if (!S.raf) S.raf = requestAnimationFrame(frame);

    poke();
    document.addEventListener('keydown', onKey);
  }

  function cleanupAfterClose() {
    S.stage.classList.add('hidden');
    S.stage.setAttribute('aria-hidden', 'true');
    S.stage.classList.remove('fl-chrome-off');
    document.documentElement.classList.remove('fl-idle');
    if (S.chromeTimer) { clearTimeout(S.chromeTimer); S.chromeTimer = 0; }
    if (S.cursorTimer) { clearTimeout(S.cursorTimer); S.cursorTimer = 0; }
    FlPanel.close();
    FlTracks.close();
    FlCapsule.closeMenu();
    disposeTheme();
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    document.removeEventListener('keydown', onKey);
    if (S.closeTimer) { clearTimeout(S.closeTimer); S.closeTimer = 0; }
    S.stage.classList.remove('fl-on');
    // 旧界面立刻恢复渲染（演出层盖在上面淡出，看到的是音乐库）
    document.documentElement.classList.remove('fl-active');
    if (typeof App !== 'undefined' && App.state && App.state.page === 'nowplaying') {
      /* navigate 是 app.js 的顶层函数（挂全局），不是 App 的方法。
         曾误写成 App.navigate，TypeError 会在此抛出、把下面的 closeTimer
         整段跳过 → 舞台 opacity 淡到 0 却永远拿不到 .hidden，
         一层透明全屏 div 继续吃掉所有鼠标事件（键盘是 document 级所以照常）。
         双保险 + try/catch：导航失败也绝不能挡住关闭流程。 */
      try {
        if (typeof App.navigate === 'function') App.navigate('library');
        else if (typeof navigate === 'function') navigate('library');
      } catch (e) { /* 导航失败不影响关闭 */ }
    }
    S.closeTimer = setTimeout(() => {
      S.closeTimer = 0;
      if (S.open) return;
      cleanupAfterClose();
    }, 340);
  }

  /** 无动画立即关闭（退碟 / 出舱：演出层绝不能盖住读盘场景） */
  function forceClose() {
    if (!S.open) return;
    S.open = false;
    document.removeEventListener('keydown', onKey);
    if (S.closeTimer) { clearTimeout(S.closeTimer); S.closeTimer = 0; }
    S.stage.classList.remove('fl-on');
    document.documentElement.classList.remove('fl-active');
    cleanupAfterClose();
  }

  /* ---------- 初始化 ---------- */

  function init(settings) {
    if (S.inited) return;
    S.inited = true;
    buildIfNeeded();
    applyPref(settings);

    FlPanel.mount(S.stage, {
      setTheme: (id) => setTheme(id, { persist: false }),
      setSize: (px) => setSize(px),
      setShowTr: (on) => setShowTr(on),
      setShowRo: (on) => setShowRo(on),
      setReveal: (m) => setReveal(m),
      setThemeParam: (key, value) => setThemeParam(key, value),
      resetParams: resetParams
    }, S.pref);

    FlCapsule.mount(S.stage.querySelector('.fl-bottom'), { poke: poke });

    FlTracks.mount(S.stage);

    // 窗口状态（全屏键图标）+ 元数据 / 传输变化
    if (window.cd && typeof window.cd.on === 'function') {
      window.cd.on('app:win-state', onWinState);
      window.cd.on('cd:metadata', () => {
        S.reloadPending = true;
        if (S.open) {
          setCoverFromMeta();
          /* 胶囊也要同步：Transport.setTrackCount/setDuration 在值不变时
             早退不通知（同曲目数、同时长的纯元数据事件——如歌词后到补推），
             只靠 subscribe 链路封面会陈旧。 */
          FlCapsule.sync();
          FlTracks.sync();
        }
      });
    }
    if (typeof Transport !== 'undefined' && Transport.subscribe) {
      Transport.subscribe(() => {
        S.reloadPending = true;
        if (S.open) { FlCapsule.sync(); FlTracks.sync(); }
      });
    }

    // 指针活动 → 重置自动隐藏
    S.stage.addEventListener('pointermove', poke, { passive: true });
    S.stage.addEventListener('pointerdown', poke, { passive: true });
    S.stage.addEventListener('wheel', poke, { passive: true });

    // 初始窗口态（异步，失败无所谓——按钮标题有默认值）
    try {
      const p = window.cd.invoke('app:win-state');
      if (p && typeof p.then === 'function') p.then(onWinState).catch(() => { /* 忽略 */ });
    } catch (e) { /* 忽略 */ }
  }

  return {
    init, open, close, forceClose,
    isOpen: () => S.open,
    applyLang,
    setTheme,
    setSize, setShowTr, setShowRo, setReveal, setThemeParam, resetParams,
    currentTheme: () => S.theme,
    /** 当前弹出方式（面板 / 测试读取用） */
    currentReveal: () => S.pref.reveal,
    /** 弹出方式枚举（设置面板下拉 / 测试读取用） */
    revealModes: () => REVEAL_MODES.map((id) => ({ id, name: revealLabel(id) })),
    /** 当前主题的全部参数现值（面板读取用） */
    themeParams: () => {
      const out = {};
      const def = FlThemes.get(S.theme);
      if (def && Array.isArray(def.params)) {
        for (const p of def.params) out[p.key] = paramValue(def.id, p.key, p.def);
      }
      return out;
    },
    /** 测试 / 调试：当前演出层内部状态（歌词构建结果 + 重载链路） */
    debugState: () => ({
      built: S.built, active: S.active, theme: S.theme,
      themeMode: S.themeHandle ? (S.themeHandle.mode || '?') : null,
      loadedKey: S.loadedKey, reloadPending: S.reloadPending,
      raf: S.raf, open: S.open, reveal: S.pref.reveal,
      track: (typeof Transport !== 'undefined' ? Transport.track : '?')
    })
  };
})();
