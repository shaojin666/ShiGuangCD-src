'use strict';
/* ============================================================
   fl-capsule.js —— 全屏歌词演出层「底部小胶囊 + 播控菜单」
   ------------------------------------------------------------
   与原版的关系：完全不碰 nowplaying.js 的播放控件。这里自建一套
   迷你控件，挂在 fl-stage.js 构建的 .fl-bottom 铬件里，随演出层
   一起自动隐藏（默认隐藏 → 鼠标靠近出现）。

   交互约定（与设计方案一致）：
     轻点（<250ms 且位移 <8px）   播放 / 暂停
     长按（≥200ms）后横拖          进度预览（松手提交定位）
         1px ≈ 0.35s，拖动中气泡显示 目标时间 / 总时长
     滚轮（杯体上）                音量 ±4%
   右下圆形按钮 → 弹出播控菜单。v10.9.1 起菜单内部自带
   **大号专辑封面**（播控/切歌按钮上方，封面下方是歌名与艺术家），
   播放顺序与弹出光盘并排在菜单最下方——封面不再是按钮上方的独立件。

   性能纪律：tick() 每帧被调用，只写 transform:scaleX 与
   "整秒才变"的时间文本；状态类信息走 sync()（事件驱动，不每帧）。
   ============================================================ */

window.FlCapsule = (function () {

  /* ---------- 常量 ---------- */
  const TAP_MS = 250;          // 轻点判定：按住时长
  const TAP_SLOP = 8;          // 轻点判定：位移容差（px）
  const HOLD_MS = 200;         // 长按进入拖进度的阈值
  const SEC_PER_PX = 0.35;     // 拖动灵敏度：1px ≈ 0.35s
  const VOL_STEP = 0.04;       // 滚轮音量步长
  const MOVE_CANCEL = 10;      // 未进入长按就移动超过此距离 → 取消长按

  /* ---------- 图标 ---------- */
  const IC = {
    prev: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h2.4v14H6zM19 5.5v13a.8.8 0 0 1-1.24.67l-9.2-6.5a.8.8 0 0 1 0-1.34l9.2-6.5A.8.8 0 0 1 19 5.5z"/></svg>',
    next: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.6 5H18v14h-2.4zM5 5.5v13a.8.8 0 0 0 1.24.67l9.2-6.5a.8.8 0 0 0 0-1.34l-9.2-6.5A.8.8 0 0 0 5 5.5z"/></svg>',
    play: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.6 4.8v14.4a.7.7 0 0 0 1.07.6l11.2-7.2a.7.7 0 0 0 0-1.2L8.67 4.2a.7.7 0 0 0-1.07.6z"/></svg>',
    pause: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.6h3.6v14.8H7zM13.4 4.6H17v14.8h-3.6z"/></svg>',
    vol: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h3.2L12 18.6V5.4L7.2 9.5z"/><path d="M15.6 9a4.4 4.4 0 0 1 0 6M18.2 6.4a8 8 0 0 1 0 11.2"/></svg>',
    dots: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>',
    /* 弹出光盘（与读盘场景的弹出托盘按钮同形：上三角 + 托条） */
    eject: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.4 21.4 16.2H2.6z"/><rect x="4" y="18.6" width="16" height="2.3" rx="1.15"/></svg>',
    /* 播放顺序（模式）：循环箭头 + 短横（顺序/随机/循环共用一个形，文字标签区分） */
    mode: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2.5l3.2 3.2L17 8.9"/><path d="M20.2 5.7H7.6a4.2 4.2 0 0 0-4.2 4.2v1.4"/><path d="M7 21.5L3.8 18.3 7 15.1"/><path d="M3.8 18.3h12.6a4.2 4.2 0 0 0 4.2-4.2v-1.4"/></svg>',
    /* 无封面时的占位：一张简笔光盘 */
    disc: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/><circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="12" r="0.4" fill="currentColor" stroke="none"/></svg>'
  };

  /* ---------- 模块状态 ---------- */
  const S = {
    bottom: null,        // .fl-bottom 容器（控制器构建）
    capsule: null, disc: null, cover: null,
    menuCover: null, menuCoverImg: null,   // 菜单内大号专辑封面（v10.9.1）
    menuTitle: null, menuArtist: null,     // 菜单内歌名 / 艺术家
    titleEl: null, artistEl: null, curEl: null, durEl: null, fillEl: null, bubbleEl: null,
    menuBtn: null, menu: null, mPlay: null, mModeLabel: null, mVol: null, mVolNum: null,
    poke: null,          // 控制器注入：交互时重置自动隐藏计时
    lastCur: -1, lastDur: -1, lastPct: -1,
    // 指针交互
    down: false, pid: null, x0: 0, y0: 0, t0: 0, pos0: 0, holdTimer: null, seeking: false, moved: false
  };

  /* ---------- 工具 ---------- */

  function fmt(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function el(tag, cls, html) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }

  /** 封面 URL：与 nowplaying.setDisc / fl-stage.setCoverFromMeta 同一个 cover:// 规则。
   *  signature 缺失时返回空串——绝不能拼出 cover://undefined/ 这种坏 URL。 */
  function coverUrlOf(md) {
    return (md && md.hasCover && md.signature)
      ? 'cover://' + encodeURIComponent(md.signature) + '/'
      : '';
  }

  /** 气泡：拖动时显示进度，滚轮时显示音量 */
  function showBubble(text) {
    if (!S.bubbleEl) return;
    S.bubbleEl.textContent = text;
    S.bubbleEl.classList.add('show');
  }
  function hideBubble() {
    if (S.bubbleEl) S.bubbleEl.classList.remove('show');
  }

  function poke() { if (S.poke) S.poke(); }

  /* ---------- 构建 ---------- */

  function buildCapsule() {
    const cap = el('div', 'fl-capsule');
    cap.id = 'fl-capsule';

    S.disc = el('div', 'fl-cap-disc');
    S.disc.id = 'fl-cap-disc';
    S.cover = el('div', 'fl-cap-cover');
    S.cover.id = 'fl-cap-cover';
    S.disc.appendChild(S.cover);
    cap.appendChild(S.disc);

    const info = el('div', 'fl-cap-info');
    S.titleEl = el('div', 'fl-cap-title', '—');
    S.artistEl = el('div', 'fl-cap-artist', '—');
    info.appendChild(S.titleEl);
    info.appendChild(S.artistEl);
    cap.appendChild(info);

    const time = el('div', 'fl-cap-time');
    S.curEl = el('span', '', '0:00');
    S.durEl = el('span', '', '0:00');
    time.appendChild(S.curEl);
    time.appendChild(document.createTextNode(' / '));
    time.appendChild(S.durEl);
    cap.appendChild(time);

    const prog = el('div', 'fl-cap-prog');
    S.fillEl = el('div', 'fl-cap-prog-fill');
    S.fillEl.id = 'fl-cap-fill';
    prog.appendChild(S.fillEl);
    cap.appendChild(prog);

    S.bubbleEl = el('div', 'fl-cap-bubble');
    cap.appendChild(S.bubbleEl);

    wireCapsule(cap);
    return cap;
  }

  function buildMenuBtn() {
    const btn = el('button', 'fl-menu-btn');
    btn.id = 'fl-menu-btn';
    btn.type = 'button';
    btn.title = T('fl.capsule.controls');
    btn.setAttribute('aria-label', T('fl.capsule.controls'));
    btn.innerHTML = IC.dots;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
      poke();
    });
    return btn;
  }

  /** 菜单内大号专辑封面：播控按钮上方，封面下方跟歌名 / 艺术家（v10.9.1） */
  function buildMenuCover() {
    const box = el('div', 'fl-menu-cover');
    S.menuCoverImg = el('div', 'fl-cover-img');
    box.appendChild(S.menuCoverImg);
    box.appendChild(el('div', 'fl-cover-fb', IC.disc));
    return box;
  }

  function buildMenu() {
    const menu = el('div', 'fl-menu hidden');
    menu.id = 'fl-menu';

    /* 封面 + 曲目信息（菜单最顶部） */
    menu.appendChild(buildMenuCover());
    const meta = el('div', 'fl-menu-meta');
    S.menuTitle = el('div', 'fl-menu-title', '—');
    S.menuArtist = el('div', 'fl-menu-artist', '—');
    meta.appendChild(S.menuTitle);
    meta.appendChild(S.menuArtist);
    menu.appendChild(meta);

    menu.appendChild(el('div', 'fl-menu-sep'));

    /* 播放 / 切歌 */
    const row1 = el('div', 'fl-menu-row');
    const bPrev = el('button', 'fl-menu-item icon', IC.prev);
    bPrev.id = 'fl-m-prev';
    bPrev.type = 'button';
    bPrev.title = T('fl.capsule.prev');
    bPrev.setAttribute('aria-label', T('fl.capsule.prev'));
    bPrev.addEventListener('click', () => { App.prev(); poke(); });
    S.mPlay = el('button', 'fl-menu-item icon', IC.play);
    S.mPlay.id = 'fl-m-play';
    S.mPlay.type = 'button';
    S.mPlay.title = T('fl.capsule.playPause');
    S.mPlay.setAttribute('aria-label', T('fl.capsule.playPause'));
    S.mPlay.addEventListener('click', () => { App.togglePlay(); poke(); });
    const bNext = el('button', 'fl-menu-item icon', IC.next);
    bNext.id = 'fl-m-next';
    bNext.type = 'button';
    bNext.title = T('fl.capsule.next');
    bNext.setAttribute('aria-label', T('fl.capsule.next'));
    bNext.addEventListener('click', () => { App.next(); poke(); });
    row1.appendChild(bPrev);
    row1.appendChild(S.mPlay);
    row1.appendChild(bNext);
    menu.appendChild(row1);

    menu.appendChild(el('div', 'fl-menu-sep'));

    const vol = el('div', 'fl-menu-vol');
    vol.appendChild(el('span', '', IC.vol));
    S.mVol = document.createElement('input');
    S.mVol.type = 'range';
    S.mVol.id = 'fl-m-vol';
    S.mVol.min = '0';
    S.mVol.max = '100';
    S.mVol.value = '70';
    S.mVol.setAttribute('aria-label', T('fl.capsule.volume'));
    S.mVol.addEventListener('input', () => {
      App.setVolume((parseInt(S.mVol.value, 10) || 0) / 100);
      syncVol();
      poke();
    });
    vol.appendChild(S.mVol);
    S.mVolNum = el('span', 'fl-vol-num', '70');
    vol.appendChild(S.mVolNum);
    menu.appendChild(vol);

    menu.appendChild(el('div', 'fl-menu-sep'));

    /* 最下方并排：播放顺序 + 弹出光盘（v10.9.1 用户反馈） */
    const row2 = el('div', 'fl-menu-row');
    const bMode = el('button', 'fl-menu-item half', IC.mode);
    bMode.id = 'fl-m-mode';
    bMode.type = 'button';
    bMode.title = T('fl.capsule.mode');
    S.mModeLabel = el('span', '', App.modeLabel ? App.modeLabel() : '');
    bMode.appendChild(S.mModeLabel);
    bMode.addEventListener('click', () => { App.cycleMode(); sync(); poke(); });

    /* 弹出光盘（v10.9）：演出层必须先整体撤下——cd:eject 的相位回传前
       有一瞬，舞台 z-index 60 会盖住随后的出舱场景（与 app.js onPhase
       对 idle/eject 的 forceClose 同一原则，这里提前一帧做，视觉无缝） */
    const bEject = el('button', 'fl-menu-item half', '');
    bEject.id = 'fl-m-eject';
    bEject.type = 'button';
    bEject.title = T('fl.capsule.eject');
    bEject.innerHTML = IC.eject + '<span>' + T('fl.capsule.eject') + '</span>';
    bEject.addEventListener('click', () => {
      if (window.FlStage && FlStage.isOpen()) FlStage.forceClose();
      App.eject();
    });
    row2.appendChild(bMode);
    row2.appendChild(bEject);
    menu.appendChild(row2);

    return menu;
  }

  /* ---------- 胶囊指针交互 ---------- */

  function wireCapsule(cap) {
    cap.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      S.down = true;
      S.pid = e.pointerId;
      try { cap.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      S.x0 = e.clientX;
      S.y0 = e.clientY;
      S.t0 = Date.now();
      S.pos0 = Transport.positionSec();
      S.moved = false;
      S.seeking = false;
      poke();
      S.holdTimer = setTimeout(() => {
        S.holdTimer = null;
        if (!S.down) return;
        // 进入拖进度：先问 Transport 要预览值（拖动期间 positionSec() 返回它）
        S.seeking = true;
        cap.classList.add('seeking');
        Transport.beginSeek(S.pos0);
        showBubble(fmt(S.pos0) + ' / ' + fmt(Transport.durationSec));
      }, HOLD_MS);
    });

    cap.addEventListener('pointermove', (e) => {
      if (!S.down) return;
      const dx = e.clientX - S.x0;
      const dy = e.clientY - S.y0;
      if (!S.seeking) {
        // 长按确认前就大幅度移动 → 用户不是来拖进度的，取消长按
        if (Math.abs(dx) > MOVE_CANCEL || Math.abs(dy) > MOVE_CANCEL) {
          S.moved = true;
          if (S.holdTimer) { clearTimeout(S.holdTimer); S.holdTimer = null; }
        }
        return;
      }
      const dur = Transport.durationSec;
      let target = S.pos0 + dx * SEC_PER_PX;
      if (target < 0) target = 0;
      if (dur > 0 && target > dur) target = dur;
      Transport.previewSeek(target);
      showBubble(fmt(target) + ' / ' + fmt(dur));
      poke();
    });

    function endPointer(e, cancelled) {
      if (!S.down) return;
      if (S.holdTimer) { clearTimeout(S.holdTimer); S.holdTimer = null; }
      const held = Date.now() - S.t0;
      const dx = e ? (e.clientX - S.x0) : 0;
      const dy = e ? (e.clientY - S.y0) : 0;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (S.seeking && !cancelled) {
        // 提交定位：Transport 的预览值即目标（App.seek 内部 commitSeek + IPC）
        const target = Transport.seeking ? Transport.positionSec() : S.pos0;
        App.seek(target);
      }
      if (S.seeking || cancelled) {
        if (cancelled) Transport.cancelSeek();
        S.seeking = false;
        cap.classList.remove('seeking');
        hideBubble();
      } else if (!S.moved && held < TAP_MS && dist < TAP_SLOP) {
        App.togglePlay();   // 轻点：播放 / 暂停
      }
      S.down = false;
      S.pid = null;
      try { if (e) cap.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }

    cap.addEventListener('pointerup', (e) => endPointer(e, false));
    cap.addEventListener('pointercancel', (e) => endPointer(e, true));

    // 滚轮音量（必须非 passive 才能 preventDefault）
    cap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const v = Math.max(0, Math.min(1, App.state.volume + dir * VOL_STEP));
      App.setVolume(v);
      showBubble(T('fl.capsule.volumeToast', { n: Math.round(v * 100) }));
      clearTimeout(S._volBubble);
      S._volBubble = setTimeout(hideBubble, 900);
      syncVol();
      poke();
    }, { passive: false });
  }

  /* ---------- 菜单开合 ---------- */

  function toggleMenu(force) {
    if (!S.menu) return;
    const show = force != null ? force : S.menu.classList.contains('hidden');
    S.menu.classList.toggle('hidden', !show);
    if (show) { sync(); poke(); }
  }

  function closeMenu() { toggleMenu(false); }

  /** 点击菜单外关闭（挂在 document，stage 打开期间常驻） */
  function onDocDown(e) {
    if (!S.menu || S.menu.classList.contains('hidden')) return;
    if (S.menu.contains(e.target)) return;
    if (S.menuBtn && S.menuBtn.contains(e.target)) return;
    closeMenu();
  }

  /* ---------- 状态同步 ---------- */

  function syncVol() {
    const v = Math.round((App.state.volume || 0) * 100);
    if (S.mVol && parseInt(S.mVol.value, 10) !== v) S.mVol.value = String(v);
    if (S.mVolNum) S.mVolNum.textContent = String(v);
  }

  function syncPlay() {
    const playing = Transport.status === 'playing';
    if (S.mPlay) S.mPlay.innerHTML = playing ? IC.pause : IC.play;
    if (S.disc) S.disc.classList.toggle('spin', playing);
  }

  function syncInfo() {
    const md = App.state.metadata;
    const n = Transport.track;
    const tr = md && md.tracks ? md.tracks.find((t) => t.number === n) : null;
    const title = (tr && tr.title) ? tr.title : (md ? (md.album || T('common.unknownAlbum')) : '—');
    const artist = (tr && tr.artist) ? tr.artist : (md ? (md.artist || '') : '');
    if (S.titleEl && S.titleEl.textContent !== title) S.titleEl.textContent = title;
    if (S.artistEl) {
      const a = artist || (md && md.album) || '';
      if (S.artistEl.textContent !== a) S.artistEl.textContent = a;
    }
    // 胶囊小封面：与 nowplaying.setDisc 同一个 cover:// 规则
    const url = coverUrlOf(md);
    if (S.cover) {
      const want = url ? 'url("' + url + '")' : '';
      if (S.cover.style.backgroundImage !== want) S.cover.style.backgroundImage = want;
    }
    // 菜单内大号封面（v10.9.1）：同一 URL；无封面时露出占位光盘（.has-cover 控制显隐）
    if (S.menuCoverImg) {
      const want = url ? 'url("' + url + '")' : '';
      if (S.menuCoverImg.style.backgroundImage !== want) S.menuCoverImg.style.backgroundImage = want;
      S.menuCoverImg.parentElement.classList.toggle('has-cover', !!url);
    }
    // 菜单内歌名 / 艺术家（与胶囊信息同源，大字号展示）
    if (S.menuTitle && S.menuTitle.textContent !== title) S.menuTitle.textContent = title;
    if (S.menuArtist) {
      const a = artist || (md && md.album) || '';
      if (S.menuArtist.textContent !== a) S.menuArtist.textContent = a;
    }
  }

  function syncMode() {
    if (!S.mModeLabel) return;
    // 播放模式文案统一由 app.js 的 modeLabel() 提供（含翻译），
    // 万一拿不到就退回 i18n 键，绝不硬编码中文。
    let label = T('mode.normal');
    try {
      if (typeof App.modeLabel === 'function') label = App.modeLabel();
    } catch (e) { /* 忽略 */ }
    if (S.mModeLabel.textContent !== label) S.mModeLabel.textContent = label;
  }

  /** 离散状态（换歌 / 播放态 / 模式 / 音量变化时调用） */
  function sync() {
    syncPlay();
    syncInfo();
    syncMode();
    syncVol();
  }

  /** 每帧调用：进度条 + 时间文本（控制器位置时钟驱动） */
  function tick(pos, dur) {
    const pct = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
    if (pct !== S.lastPct) {
      // scaleX 而非 width：走合成器，不触发布局（CSS 已设 transform-origin:left）
      S.fillEl.style.transform = 'scaleX(' + pct.toFixed(4) + ')';
      S.lastPct = pct;
    }
    const cs = Math.floor(pos);
    if (cs !== S.lastCur) {
      S.lastCur = cs;
      S.curEl.textContent = fmt(pos);
    }
    const ds = Math.floor(dur);
    if (ds !== S.lastDur) {
      S.lastDur = ds;
      S.durEl.textContent = fmt(dur);
    }
  }

  /* ---------- 对外 ---------- */

  /**
   * 语言切换：原地改 title / aria-label 与含文案的按钮内容。
   * 不重建 DOM —— 胶囊上挂着指针捕获逻辑，重建会丢监听器。
   */
  function applyLang() {
    if (S.menuBtn) {
      S.menuBtn.title = T('fl.capsule.controls');
      S.menuBtn.setAttribute('aria-label', T('fl.capsule.controls'));
    }
    const tagged = [
      ['#fl-m-prev', 'fl.capsule.prev'],
      ['#fl-m-play', 'fl.capsule.playPause'],
      ['#fl-m-next', 'fl.capsule.next'],
      ['#fl-m-mode', 'fl.capsule.mode'],
      ['#fl-m-eject', 'fl.capsule.eject']
    ];
    for (const [sel, key] of tagged) {
      const b = S.menu && S.menu.querySelector(sel);
      if (!b) continue;
      b.title = T(key);
      b.setAttribute('aria-label', T(key));
    }
    if (S.mVol) S.mVol.setAttribute('aria-label', T('fl.capsule.volume'));
    // 弹出按钮带文字标签：图标保留，只换 <span>
    const ej = S.menu && S.menu.querySelector('#fl-m-eject span');
    if (ej) ej.textContent = T('fl.capsule.eject');
    syncInfo();
    syncMode();
  }

  /**
   * 挂载到 .fl-bottom 铬件。
   * @param {HTMLElement} bottom .fl-bottom 元素
   * @param {{poke:Function}} opts poke：交互时重置自动隐藏计时
   */
  function mount(bottom, opts) {
    S.bottom = bottom;
    S.poke = opts && opts.poke;
    bottom.appendChild(buildCapsule());
    /* 右下角只剩播控菜单按钮（v10.9.1：专辑封面移入菜单内部）——
       .fl-bottom 的 space-between 天然把它推到右边。 */
    S.menuBtn = buildMenuBtn();
    bottom.appendChild(S.menuBtn);
    S.menu = buildMenu();
    // 菜单挂在 stage 上（不是 bottom 里）：bottom 自动隐藏时菜单要能留在原位上方
    const stage = bottom.closest('#fl-stage');
    (stage || bottom).appendChild(S.menu);
    document.addEventListener('pointerdown', onDocDown, true);
    sync();
    return { sync, tick, closeMenu, applyLang };
  }

  return { mount, sync, tick, closeMenu, applyLang };
})();
