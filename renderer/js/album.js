'use strict';
/* ============================================================
   album.js —— 专辑详情页（选歌 / 专辑介绍，一镜到底）
   ------------------------------------------------------------
   从音乐库（原版网格 / CoverFlow）点专辑图进入，覆盖整个窗口。

   设计语言（对应用户 v10.4 需求）：
     - 背景：按封面取色的模糊渐变（拿不到主色时退化为封面自身高斯模糊），
       加暗色 scrim 保证文字可读；
     - 左侧专辑图：3D 倾斜（曲目页偏向右侧），非线性缓动入场（FLIP：
       从音乐库里那张卡片的真实矩形缩放平移过来，一镜到底）；
     - 右侧曲目列表：点哪首播哪首。没放碟 / 当前不是这张碟 →
       提示放碟，换碟后自动切到点的目标歌曲；
     - 列表上方大字专辑名：过长先两行截断，仍然放不下则滚动（marquee）；
     - 底部升起胶囊：两个选项「专辑 / 曲目」，曲目在右且默认选中；
       切到「专辑」：专辑图移到右侧并偏向左侧，左侧显示专辑介绍，
       专辑名移到介绍上方 —— 全部是同一批元素的位移，不做页面重建。

   颜色提取依赖 cover 协议的 CORS 头（main/index.js 注册时带
   Access-Control-Allow-Origin），canvas 取色失败时静默退化。
   ============================================================ */

const Album = (() => {
  const el = document.getElementById('overlay-album');

  /** 当前展示的元数据 */
  let meta = null;
  /** 'tracks'（曲目，默认） | 'album'（专辑介绍） */
  let tab = 'tracks';
  /** 打开时来自哪张卡片（关闭时飞回去，一镜到底） */
  let originEl = null;
  let built = false;
  /** 关闭动画进行中：避免重复触发 */
  let closing = false;
  /**
   * 打开代次（v10.6 修复「详情页只能第一次打开」）：
   * 每次 open() 自增。关闭动画的 finish() 只对归属自己那一次打开生效——
   * 关闭动画还没收尾用户就又打开时，旧 finish 作废，否则它会把
   * 刚打开的页面重新盖上 .hidden（表现为"闪一下消失"）。
   */
  let epoch = 0;
  /**
   * v10.7 实时高亮缓存：renderTracks 渲染时记下所依据的 Transport
   * track / status，订阅回调比对到变化才重建（详见下方订阅处）。
   */
  let lastTrack = -1;
  let lastStatus = '';

  /* DOM 引用 */
  let bgArt = null;
  let artSlot = null;
  let artFace = null;
  let artGlow = null;
  let titleBox = null;
  let titleInner = null;
  let subLine = null;
  let tracksPanel = null;
  let trackListEl = null;
  let introPanel = null;
  let albumIntroEl = null;
  let artistIntroEl = null;
  let capsule = null;
  let closeBtn = null;

  /* ---------- 工具 ---------- */

  function coverUrl(sig) {
    return sig ? `cover://${encodeURIComponent(sig)}/` : '';
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  /** 轨时长：当前碟用 TOC（物理精确），否则用元数据记录 */
  function trackDuration(tr) {
    if (App.state.signature === meta.signature && App.state.toc && App.state.toc.tracks) {
      const t = App.state.toc.tracks.find((x) => x.number === tr.number);
      if (t && t.endFrame > t.startFrame) return (t.endFrame - t.startFrame) / 75;
    }
    return (tr && tr.durationSec) || 0;
  }

  function trackTitle(tr) {
    return (tr && tr.title) || T('common.trackNo', { n: (tr ? tr.number : '?') });
  }

  /* ---------- 封面取色 ---------- */

  /**
   * 从封面提取两个颜色（主色 + 次级色），用于背景渐变。
   * 失败（跨域污染 / 图片不存在 / 无封面）一律 resolve(null)，
   * 由调用方退化到"封面自身模糊"方案。
   */
  function extractColors(url) {
    return new Promise((resolve) => {
      if (!url) { resolve(null); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const S = 28;
          const c = document.createElement('canvas');
          c.width = S; c.height = S;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, S, S);
          const data = ctx.getImageData(0, 0, S, S).data;
          // 16 级量化桶计数，跳过过暗/过淡的像素（它们只是背景噪点）
          const buckets = new Map();
          let rSum = 0, gSum = 0, bSum = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            rSum += r; gSum += g; bSum += b; n++;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max < 26 || min > 235) continue;
            const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            const rec = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
            rec.r += r; rec.g += g; rec.b += b; rec.n++;
            buckets.set(key, rec);
          }
          const mean = n ? { r: Math.round(rSum / n), g: Math.round(gSum / n), b: Math.round(bSum / n) } : null;
          let top = null;
          for (const rec of buckets.values()) {
            if (!top || rec.n > top.n) top = rec;
          }
          const dominant = top ? {
            r: Math.round(top.r / top.n),
            g: Math.round(top.g / top.n),
            b: Math.round(top.b / top.n)
          } : null;
          resolve({ mean, dominant });
        } catch (e) {
          resolve(null);   // 画布被污染 / 其它异常：静默退化
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function rgb(c, alpha) {
    if (!c) return 'transparent';
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha == null ? 1 : alpha})`;
  }

  /* ---------- 可读性：取色亮度压制 + 智能文字色（v10.6） ---------- */

  /** 感知亮度（线性 RGB 加权，0~1） */
  function lumOf(c) {
    return c ? (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 : 0;
  }

  /**
   * 把过亮的取色压进可读区（线性缩放，保色相）。
   * 亮封面（如纯白/亮黄）若不压，径向渐变核心会亮到把文字吞掉；
   * 压到 0.22 后配合暗色 scrim，文字对比度全程可保。
   */
  function clampForText(c, maxLum) {
    if (!c) return null;
    const l = lumOf(c);
    if (l <= maxLum) return c;
    const k = maxLum / l;
    return { r: Math.round(c.r * k), g: Math.round(c.g * k), b: Math.round(c.b * k) };
  }

  /**
   * 智能文字色：文字区的有效背景 ≈ 暗色 scrim（0.72 权重的 #08080a）
   * 与提取色（0.28）的合成，按它的感知亮度在亮/暗两套文字色间选择。
   *
   * 背景（用户实测）：浅色主题下 --text 是深色，而本页的 scrim 恒为暗色，
   * 黑色封面 → 深色文字糊进暗背景完全看不见。压制 + 自适应文字色后，
   * 任何封面、任何主题下文字都看得清。
   */
  function applyTextPalette(c1, c2) {
    const eff = 0.72 * lumOf({ r: 8, g: 8, b: 10 }) +
      0.28 * ((lumOf(c1) + lumOf(c2)) / 2 || 0);
    const light = eff < 0.4;
    el.style.setProperty('--al-fg', light ? '#f6f1e7' : '#23201c');
    el.style.setProperty('--al-fg-dim', light ? 'rgba(246, 241, 231, 0.8)' : 'rgba(35, 32, 28, 0.84)');
    el.style.setProperty('--al-fg-faint', light ? 'rgba(246, 241, 231, 0.56)' : 'rgba(35, 32, 28, 0.62)');
    el.style.setProperty('--al-hover', light ? 'rgba(255, 255, 255, 0.09)' : 'rgba(0, 0, 0, 0.07)');
    el.style.setProperty('--al-line', light ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.16)');
    el.classList.toggle('fg-light', light);
    el.classList.toggle('fg-dark', !light);
  }

  /** 把取色结果写进背景层；无取色时用封面自身模糊 */
  async function paintBackground() {
    const url = coverUrl(meta.signature);
    const colors = meta.hasCover ? await extractColors(url) : null;
    if (meta !== Album._current) return;   // 取色期间换了碟/关了页面
    if (colors && (colors.dominant || colors.mean)) {
      // 先压亮度再下发：亮封面的渐变核心不会吞掉文字（v10.6）
      const c1 = clampForText(colors.dominant || colors.mean, 0.22);
      const c2 = clampForText(colors.mean || colors.dominant, 0.22);
      el.style.setProperty('--al-c1', rgb(c1));
      el.style.setProperty('--al-c2', rgb(c2));
      el.style.removeProperty('--al-scrim-a');
      el.style.removeProperty('--al-scrim-b');
      el.classList.add('has-colors');
      applyTextPalette(c1, c2);
    } else {
      el.classList.remove('has-colors');
      // 无取色：只剩"暗 scrim + 封面模糊"。浅色主题的封面模糊很亮，
      // 这里把 scrim 加到最实，保证暗底 + 亮文字（v10.6）
      el.style.setProperty('--al-scrim-a', 'rgba(8, 8, 10, 0.86)');
      el.style.setProperty('--al-scrim-b', 'rgba(8, 8, 10, 0.95)');
      applyTextPalette(null, null);
    }
    if (meta.hasCover) {
      bgArt.style.backgroundImage = `url("${url}")`;
      el.classList.add('has-art');
    } else {
      bgArt.style.backgroundImage = '';
      el.classList.remove('has-art');
    }
  }

  /* ---------- 构建 DOM（只建一次） ---------- */

  function build() {
    el.innerHTML = '';

    /* 背景层 */
    const bg = document.createElement('div');
    bg.className = 'al-bg';
    bgArt = document.createElement('div');
    bgArt.className = 'al-bg-art';
    const tint = document.createElement('div');
    tint.className = 'al-bg-tint';
    bg.appendChild(bgArt);
    bg.appendChild(tint);
    el.appendChild(bg);

    /* 舞台 */
    const stage = document.createElement('div');
    stage.className = 'al-stage';

    closeBtn = document.createElement('button');
    closeBtn.className = 'al-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', T('common.close'));
    closeBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    closeBtn.addEventListener('click', () => close());
    stage.appendChild(closeBtn);

    /* 专辑图：外层槽位负责 Tab 位移，内层负责 FLIP 入场缩放 */
    artSlot = document.createElement('div');
    artSlot.className = 'al-art-slot';
    const art = document.createElement('div');
    art.className = 'al-art';
    artFace = document.createElement('div');
    artFace.className = 'al-art-face';
    artGlow = document.createElement('div');
    artGlow.className = 'al-art-glow';
    art.appendChild(artFace);
    art.appendChild(artGlow);
    artSlot.appendChild(art);
    stage.appendChild(artSlot);

    /* 大字专辑名（曲目页在右侧上方，专辑页在左侧上方） */
    titleBox = document.createElement('div');
    titleBox.className = 'al-title';
    titleInner = document.createElement('div');
    titleInner.className = 'al-title-inner';
    titleBox.appendChild(titleInner);
    subLine = document.createElement('div');
    subLine.className = 'al-sub';
    titleBox.appendChild(subLine);
    stage.appendChild(titleBox);

    /* 曲目面板（右） */
    tracksPanel = document.createElement('section');
    tracksPanel.className = 'al-panel al-tracks';
    trackListEl = document.createElement('div');
    trackListEl.className = 'al-tracklist';
    tracksPanel.appendChild(trackListEl);
    stage.appendChild(tracksPanel);

    /* 介绍面板（左） */
    introPanel = document.createElement('section');
    introPanel.className = 'al-panel al-intro';
    albumIntroEl = document.createElement('div');
    albumIntroEl.className = 'al-intro-text';
    artistIntroEl = document.createElement('div');
    artistIntroEl.className = 'al-intro-text al-artist-intro';
    introPanel.appendChild(albumIntroEl);
    introPanel.appendChild(artistIntroEl);
    stage.appendChild(introPanel);

    /* 底部胶囊 */
    capsule = document.createElement('div');
    capsule.className = 'al-capsule';
    const btnAlbum = document.createElement('button');
    btnAlbum.type = 'button';
    btnAlbum.className = 'al-cap-btn';
    btnAlbum.dataset.tab = 'album';
    btnAlbum.textContent = T('album.tab.album');
    const btnTracks = document.createElement('button');
    btnTracks.type = 'button';
    btnTracks.className = 'al-cap-btn';
    btnTracks.dataset.tab = 'tracks';
    btnTracks.textContent = T('album.tab.tracks');
    btnAlbum.addEventListener('click', () => setTab('album'));
    btnTracks.addEventListener('click', () => setTab('tracks'));
    capsule.appendChild(btnAlbum);
    capsule.appendChild(btnTracks);
    stage.appendChild(capsule);

    el.appendChild(stage);
    built = true;
  }

  /* ---------- 内容回填 ---------- */

  function fillContent() {
    const url = coverUrl(meta.signature);
    if (meta.hasCover) {
      artFace.style.backgroundImage = `url("${url}")`;
      artFace.classList.add('has-cover');
    } else {
      artFace.style.backgroundImage = '';
      artFace.classList.remove('has-cover');
    }
    // 碟号角标（多碟专辑）
    const discTotal = Number(meta.discTotal) >= 1 ? Math.floor(Number(meta.discTotal)) : 0;
    const discNumber = Number(meta.discNumber) >= 1 ? Math.floor(Number(meta.discNumber)) : 1;
    let badge = artSlot.querySelector('.al-art-badge');
    if (discTotal > 1 || discNumber > 1) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'al-art-badge';
        artSlot.appendChild(badge);
      }
      badge.textContent = discTotal > 1 ? `D${discNumber}/${discTotal}` : `D${discNumber}`;
    } else if (badge) {
      badge.remove();
    }

    titleInner.textContent = meta.album || T('common.unknownAlbum');
    fitTitle();
    const parts = [];
    if (meta.artist) parts.push(meta.artist);
    if (meta.year) parts.push(String(meta.year));
    parts.push(T('common.tracks', { n: meta.trackCount || (meta.tracks || []).length || 0 }));
    subLine.textContent = parts.join(' · ');

    renderTracks();
    renderIntro();
    setTab(tab, true);
  }

  /**
   * 大字标题排版：默认静态（可两行）；
   * 两行还放不下 → 切换 marquee 滚动模式（无缝循环）。
   */
  function fitTitle() {
    titleBox.classList.remove('marquee');
    titleInner.textContent = meta.album || T('common.unknownAlbum');
    // 先撤掉上一轮 marquee 留下的克隆，保证量到的是自然宽度
    const clones = titleBox.querySelectorAll('.al-title-clone');
    for (const c of clones) c.remove();
    const style = getComputedStyle(titleInner);
    const lineH = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 40;
    const twoLineH = lineH * 2 + 4;
    requestAnimationFrame(() => {
      if (titleInner.scrollHeight <= twoLineH) return;   // 两行内放得下
      // 放不下：单行 + 滚动。克隆一份做无缝衔接
      titleBox.classList.add('marquee');
      const clone = document.createElement('span');
      clone.className = 'al-title-clone';
      clone.textContent = titleInner.textContent;
      titleInner.appendChild(clone);
    });
  }

  function renderTracks() {
    /* 记录本次渲染所依据的 Transport 状态（供订阅比对，见下方
       v10.7 实时高亮逻辑）——放在最前面，空列表的早退也覆盖到。 */
    lastTrack = Transport.track;
    lastStatus = Transport.status;
    trackListEl.innerHTML = '';
    const tracks = (meta && meta.tracks) || [];
    if (!tracks.length) {
      const empty = document.createElement('div');
      empty.className = 'al-empty';
      empty.textContent = T('album.noTracks');
      trackListEl.appendChild(empty);
      return;
    }
    const isCurrentDisc = App.state.signature === meta.signature && App.state.phase === 'ready';
    for (const tr of tracks) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'al-track';
      row.dataset.number = String(tr.number);
      if (isCurrentDisc && tr.number === Transport.track &&
          Transport.status !== 'stopped') {
        row.classList.add('current');
      }
      const num = document.createElement('span');
      num.className = 'al-track-num tabular';
      num.textContent = String(tr.number).padStart(2, '0');
      const name = document.createElement('span');
      name.className = 'al-track-name';
      name.textContent = trackTitle(tr);
      const dur = document.createElement('span');
      dur.className = 'al-track-dur tabular';
      dur.textContent = fmt(trackDuration(tr));
      row.appendChild(num);
      row.appendChild(name);
      row.appendChild(dur);
      row.addEventListener('click', () => playFrom(tr.number));
      trackListEl.appendChild(row);
    }
  }

  function renderIntro() {
    const aIntro = (meta.albumIntro || '').trim();
    const arIntro = (meta.artistIntro || '').trim();
    if (aIntro) {
      albumIntroEl.textContent = aIntro;
      albumIntroEl.classList.remove('empty');
    } else {
      albumIntroEl.textContent = T('album.noIntro');
      albumIntroEl.classList.add('empty');
    }
    if (arIntro) {
      artistIntroEl.innerHTML = '';
      const h = document.createElement('div');
      h.className = 'al-intro-head';
      h.textContent = T('album.aboutArtist', { name: meta.artist || '' });
      artistIntroEl.appendChild(h);
      const p = document.createElement('div');
      p.className = 'al-intro-text';
      p.textContent = arIntro;
      artistIntroEl.appendChild(p);
      artistIntroEl.classList.remove('empty');
    } else {
      artistIntroEl.innerHTML = '';
      const h = document.createElement('div');
      h.className = 'al-intro-head';
      h.textContent = T('album.aboutArtist', { name: meta.artist || '' });
      const p = document.createElement('div');
      p.className = 'al-intro-text empty';
      p.textContent = T('album.noArtistIntro');
      artistIntroEl.appendChild(h);
      artistIntroEl.appendChild(p);
    }
  }

  /* ---------- Tab 切换（一镜到底：同一批元素位移） ---------- */

  function setTab(next, silent) {
    tab = (next === 'album') ? 'album' : 'tracks';
    el.classList.toggle('tab-album', tab === 'album');
    el.classList.toggle('tab-tracks', tab === 'tracks');
    const btns = capsule.querySelectorAll('.al-cap-btn');
    for (const b of btns) b.classList.toggle('on', b.dataset.tab === tab);
    if (!silent) {
      // 切 tab 时重排标题 marquee 状态（宽度变了，两行容量也变了）
      fitTitle();
    }
  }

  /* ---------- 播放 / 换碟 ---------- */

  /**
   * 点曲目播放。三种情况：
   *   1) 当前碟正是这张 → 直接播；
   *   2) 光驱里是别的碟 / 没碟 → 记下目标歌曲，提示放碟，
   *      换碟后由 app.js 的 onMetadata 自动切到目标歌曲；
   *   3) 正在读盘 → 交给 needDisc 机制等落地。
   */
  function playFrom(number) {
    if (!meta) return;
    if (App.state.signature === meta.signature && App.state.phase === 'ready') {
      App.playTrack(number);
      return;
    }
    App.requestDiscTrack(meta, number);
  }

  /* ---------- 打开 / 关闭 ---------- */

  /**
   * @param {object} m 元数据（音乐库卡片上的完整记录）
   * @param {HTMLElement} [fromEl] 来源卡片元素：FLIP 入场用
   */
  function open(m, fromEl) {
    if (!m || !m.tracks || !m.tracks.length) {
      Toast(T('album.toast.none'));
      return;
    }
    epoch++;
    meta = m;
    Album._current = m;
    originEl = fromEl || null;
    tab = 'tracks';
    closing = false;
    if (!built) build();
    /* ★ v10.6 修复「详情页只能第一次打开」：
       上一次关闭可能留下两类残留，不清掉就会复现bug——
       (1) .closing 类：它的 albumout 动画带 forwards，会把整个页面
           钉在 opacity:0（不显示却能点击的元凶）；
       (2) .al-art 上的行内样式：关闭 FLIP 的终点态 opacity:0/位移；
       (3) 上一张碟的取色变量：不清则渐变还挂在上一次的封面色上。 */
    el.classList.remove('closing', 'has-colors', 'has-art');
    el.style.removeProperty('--al-c1');
    el.style.removeProperty('--al-c2');
    el.style.removeProperty('--al-scrim-a');
    el.style.removeProperty('--al-scrim-b');
    resetArtInline();
    el.classList.remove('hidden');
    fillContent();
    paintBackground();
    flipIn();
    // 打开后屏蔽背景滚动
    document.documentElement.classList.add('album-open');
  }

  /** 清掉 FLIP 动画留在 .al-art 上的行内样式（上次关闭的终点态） */
  function resetArtInline() {
    const slot = artSlot && artSlot.querySelector('.al-art');
    if (!slot) return;
    slot.style.transition = '';
    slot.style.transform = '';
    slot.style.opacity = '';
  }

  /** FLIP：专辑图从来源卡片的矩形缩放平移到位 */
  function flipIn() {
    if (!originEl || !artSlot.isConnected) return;
    const slot = artSlot.querySelector('.al-art');
    const from = originEl.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    if (!from.width || !to.width) return;
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    const scale = from.width / to.width;
    slot.style.transition = 'none';
    slot.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    slot.style.opacity = '0.55';
    // 强制回流后放开，让 transition 接管
    void slot.offsetWidth;
    requestAnimationFrame(() => {
      slot.style.transition = '';
      slot.style.transform = '';
      slot.style.opacity = '';
    });
  }

  function close() {
    if (closing) return;
    closing = true;
    const myEpoch = epoch;   // 本次关闭归属的打开代次（v10.6）
    const slot = artSlot && artSlot.querySelector('.al-art');
    let done = false;
    const finish = () => {
      if (done) return;
      /* 关闭动画没收尾用户就又打开了详情页：旧 finish 作废。
         没有这道防线，旧 finish 会在 430ms 后把新打开的页面重新
         盖上 .hidden —— 就是用户看到的"闪一下消失"（v10.6）。 */
      if (myEpoch !== epoch) { closing = false; return; }
      done = true;
      el.classList.add('hidden');
      /* ★ 必须移除 .closing：它的 albumout 动画带 forwards  fill-mode，
         留着会让下次打开时页面停在被钉死的 opacity:0 —— 不显示、
         却能点击（v10.6 修复「只能第一次打开"的另一半根因）。 */
      el.classList.remove('closing', 'tab-album', 'tab-tracks', 'has-colors', 'has-art');
      el.style.removeProperty('--al-c1');
      el.style.removeProperty('--al-c2');
      el.style.removeProperty('--al-scrim-a');
      el.style.removeProperty('--al-scrim-b');
      resetArtInline();
      document.documentElement.classList.remove('album-open');
      meta = null;
      Album._current = null;
      closing = false;
    };
    if (slot && originEl && originEl.isConnected) {
      // 飞回来源卡片（找不到卡片就直接淡出）
      const from = slot.getBoundingClientRect();
      const to = originEl.getBoundingClientRect();
      if (from.width && to.width) {
        const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
        const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
        const scale = to.width / from.width;
        el.classList.add('closing');
        slot.style.transition = 'transform 0.42s var(--ease-cam), opacity 0.42s ease';
        slot.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
        slot.style.opacity = '0';
        setTimeout(finish, 430);
        return;
      }
    }
    el.classList.add('closing');
    setTimeout(finish, 260);
  }

  /** Esc 关闭（由 app.js 的快捷键路由进来） */
  function onKey(e) {
    if (el.classList.contains('hidden')) return false;
    if (e.key === 'Escape') { close(); return true; }
    return false;
  }

  /** 当前碟的曲目/状态变化后刷新高亮（播放中从音乐库打开时） */
  function refreshCurrent() {
    if (el.classList.contains('hidden') || !meta) return;
    renderTracks();
  }

  /**
   * v10.7：详情页打开期间，切歌 / 播放态变化实时刷新曲目高亮。
   * 旧行为：只有打开瞬间按 Transport 状态渲染一次，之后点别的曲目、
   * 自动下一曲、从别处换碟，高亮都停在旧行——要关掉详情页重开才更新
   * （用户实测反馈）。这里订阅 Transport，只在 track / status 真正
   * 变化时重建（notify 也会被拖动进度条等触发，白跑没必要）。
   * renderTracks 顶部会同步 lastTrack / lastStatus 缓存，两边保持一致。
   */
  Transport.subscribe(() => {
    if (el.classList.contains('hidden') || !meta) return;
    if (Transport.track === lastTrack && Transport.status === lastStatus) return;
    lastTrack = Transport.track;
    lastStatus = Transport.status;
    refreshCurrent();
  });

  /**
   * 语言切换后重排详情页（v10.11）：
   * fillContent() 会把封面、标题、信息行、曲目表、介绍全部重建一遍，
   * 页面开着才做；关着就等下次 open() 自然用新语言。
   */
  function applyLang() {
    if (el.classList.contains('hidden') || !meta) return;
    fillContent();
  }

  /**
   * 窗口尺寸变化时重排大字标题（v10.4）：
   * 窗口变窄可能让"两行静态放得下"变成"放不下需要滚动"（或反之）。
   * fitTitle 自己会先撤掉旧克隆再量自然宽度，可以直接重入。
   */
  function refitTitle() {
    if (el.classList.contains('hidden') || !meta) return;
    fitTitle();
  }

  return {
    open, close, onKey, refreshCurrent, refitTitle, applyLang,
    isOpen: () => !el.classList.contains('hidden'),
    currentMeta: () => meta,
    currentTab: () => tab,
    _current: null
  };
})();
/*
 * ★ 必须挂到 window（v10.5 修复）：
 * 顶层 const 只进全局词法环境，不产生 window 属性 —— library.js / app.js
 * 里都是 `if (window.Album)` 守卫，不挂的话封面点击、回车打开、Esc 关闭
 * 全部静默失效（用户实测"点封面没任何反应"的根因之一）。
 * 与 lyrics-view.js 的 window.LyricsView 模式保持一致。
 */
window.Album = Album;
