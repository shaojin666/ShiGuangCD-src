'use strict';
/* ============================================================
   library.js —— 主页：音乐管理面板
   ------------------------------------------------------------
  两种视图（在设置里切换）：
     grid —— 原版网格
     flow —— 模拟 Apple CoverFlow 的 3D 横向书架
  两种视图共用同一份卡片内容：
   - 单击：进入专辑详情页（选歌 / 专辑介绍，见 album.js）；
     详情页里点歌曲才会播放，不是当前碟时提示放碟/换碟
   - 右键：编辑信息 / 从音乐库移除
  CoverFlow 交互（v10.4 重写为 transform 驱动）：
   - 滚轮 / ← → / Home / End：**直接选中并居中**（不再拖动列表），
     任何专辑数量下选中项都居中正向；
   - 鼠标 / 触摸拖动：跟手移动，松口吸附到最近的一张；
   - Enter：打开当前选中项的专辑详情页；
   - 选中项封面下方有播放按钮（= 原版直接点专辑图的行为）；
   - 选中项的专辑名以大字显示在视图顶部，过长则滚动。
   ============================================================ */

const Library = (() => {
  const el = document.getElementById('page-library');
  /** 滚轮累计多少才挪动一格焦点（px） */
  const WHEEL_STEP = 42;
  /** 拖动超过该距离才算拖拽（否则视为点击，px） */
  const DRAG_SLOP = 6;

  let style = 'grid';
  let flowEl = null;          // .lib-flow（视口容器）
  let flowRow = null;         // .lib-flow-row（整体平移的行）
  let flowTop = null;         // 顶部大字专辑名
  let flowMeta = null;        // 专辑名下方的信息行（艺术家 · 年份 · 碟号 · 歌总数）
  let flowPlay = null;        // 选中项下方的播放按钮
  let flowRaf = 0;
  let flowIndex = -1;         // CoverFlow 当前焦点项（整数）
  let flowFocusEff = 0;       // 生效焦点（拖动时为小数，几何以它为准）
  let wheelAcc = 0;

  /* 拖动状态 */
  let dragging = false;
  /** 按下但还没越过拖动阈值（此时必须保留正常点击语义，不能捕获指针） */
  let pending = false;
  let dragStartX = 0;
  let dragStartRowX = 0;
  let dragRowX = 0;
  let dragMoved = 0;
  let dragPointer = null;

  /* ---------- 通用卡片内容（两种视图共用） ---------- */

  /** 多碟角标：贴在封面右下角 */
  function discBadge(meta) {
    const discTotal = Number(meta.discTotal) >= 1 ? Math.floor(Number(meta.discTotal)) : 0;
    const discNumber = Number(meta.discNumber) >= 1 ? Math.floor(Number(meta.discNumber)) : 1;
    if (!(discTotal > 1 || discNumber > 1)) return null;
    const badge = document.createElement('div');
    badge.className = 'lib-card-disc' + (meta.manual ? ' manual' : '');
    badge.textContent = discTotal > 1 ? `D${discNumber}/${discTotal}` : `D${discNumber}`;
    badge.title = discTotal > 1
      ? T('common.discOf', { n: discNumber, m: discTotal })
      : T('common.discOne', { n: discNumber });
    return badge;
  }

  function coverUrlOf(meta) {
    return meta && meta.hasCover ? `cover://${encodeURIComponent(meta.signature)}/` : '';
  }

  function bindCardActions(node, meta, indexFn) {
    node.addEventListener('click', () => {
      // 拖动甩动后不该触发点击（coverflow）
      if (style === 'flow' && dragMoved > DRAG_SLOP) return;
      // CoverFlow：单击先把目标碟对到正中（成为焦点），再打开详情页
      if (style === 'flow' && typeof indexFn === 'function') {
        setFlowFocus(indexFn(), true);
      }
      // ★ v10.4：点击专辑 = 进入选歌/专辑介绍页（一镜到底），
      //   不再直接播放。播放行为搬到详情页的曲目行与 CoverFlow 的播放按钮。
      if (window.Album) Album.open(meta, node);
    });
    /* 右键：直接编辑本地元数据（不需要光盘在光驱里） */
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();   // 否则冒泡到 document 的收起监听会立刻把菜单关掉
      if (style === 'flow' && typeof indexFn === 'function') {
        setFlowFocus(indexFn(), true);
      }
      showCardMenu(e.clientX, e.clientY, meta);
    });
  }

  function buildCard(meta) {
    const card = document.createElement('div');
    card.className = 'lib-card';
    card.dataset.sig = meta.signature || '';
    if (meta.signature && meta.signature === App.state.signature) card.classList.add('current');

    const cover = document.createElement('div');
    cover.className = 'lib-card-cover';
    if (meta.hasCover) {
      const img = document.createElement('img');
      img.src = coverUrlOf(meta);
      img.alt = '';
      cover.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'cover-fallback';
      cover.appendChild(fb);
    }
    const badge = discBadge(meta);
    if (badge) cover.appendChild(badge);
    card.appendChild(cover);

    const name = document.createElement('div');
    name.className = 'lib-card-name';
    name.textContent = meta.album || T('common.unknownAlbum');
    card.appendChild(name);

    const artist = document.createElement('div');
    artist.className = 'lib-card-artist';
    artist.textContent = meta.artist || T('common.unknownArtist');
    card.appendChild(artist);

    const metaLine = document.createElement('div');
    metaLine.className = 'lib-card-meta';
    const parts = [];
    if (meta.year) parts.push(String(meta.year));
    parts.push(T('common.tracks', { n: meta.trackCount || 0 }));
    metaLine.textContent = parts.join(' · ');
    card.appendChild(metaLine);

    bindCardActions(card, meta);
    return card;
  }

  /* ---------- CoverFlow 单项 ---------- */

  function buildFlowItem(meta) {
    const item = document.createElement('div');
    item.className = 'lib-flow-item';
    item.dataset.sig = meta.signature || '';
    if (meta.signature && meta.signature === App.state.signature) item.classList.add('current');
    // 信息行按焦点实时反查：把元数据挂在元素上，避免每帧扫 _lastItems
    item.__meta = meta;

    const cover = document.createElement('div');
    cover.className = 'lib-flow-cover';
    const url = coverUrlOf(meta);
    if (url) {
      cover.style.setProperty('--cover', `url("${url}")`);
      const reflect = document.createElement('div');
      reflect.className = 'lib-flow-reflect';
      reflect.style.setProperty('--cover', `url("${url}")`);
      cover.appendChild(reflect);
    } else {
      cover.classList.add('no-cover');
    }
    const badge = discBadge(meta);
    if (badge) cover.appendChild(badge);
    item.appendChild(cover);
    // 专辑名已移到视图顶部大字显示（v10.4），这里不再重复

    const selfIndex = () => {
      const kids = item.parentNode ? item.parentNode.children : [];
      return Array.prototype.indexOf.call(kids, item);
    };
    bindCardActions(item, meta, selfIndex);
    return item;
  }

  /* ---------- CoverFlow 几何（transform 驱动，v10.4 重写） ---------- */

  function flowItems() {
    if (!flowRow) return [];
    return Array.prototype.slice.call(flowRow.querySelectorAll('.lib-flow-item'));
  }

  /** 当前生效焦点下的整行平移量：让焦点项中心正对视口中线 */
  function rowTargetX() {
    const items = flowItems();
    const it = items[flowIndex];
    if (!it || !flowEl) return 0;
    return flowEl.clientWidth / 2 - (it.offsetLeft + it.offsetWidth / 2);
  }

  /** 把整行平移到目标位置（带动画；拖动中由调用方临时关掉 transition） */
  function placeRow(x, animate) {
    if (!flowRow) return;
    flowRow.style.transition = animate === false ? 'none' : '';
    flowRow.style.transform = `translate3d(${x}px, 0, 0)`;
  }

  /**
   * 按"离视口中线的距离"给每项写入两个变量：
   *   --pos   有符号位置（钳在 ±1.15，旋转最多约 64°，与 CoverFlow 一致）
   *   --adist 距离（钳在 0~4），负责 Z 轴后撤 / 缩放 / 淡出
   * 之所以要拆成两个：远处项不能无限旋转（否则会转成侧面看不见的一条线），
   * 但仍需要按距离后退与变淡。
   * 焦点由 flowFocusEff 决定（拖动时是小数，几何连续跟手）。
   */
  function updateFlow() {
    flowRaf = 0;
    if (!flowEl || !flowRow) return;
    const items = flowItems();
    if (!items.length) return;
    const step = items.length > 1
      ? Math.abs(items[1].offsetLeft - items[0].offsetLeft)
      : (items[0].offsetWidth || 224);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rel = (i - flowFocusEff) * (step ? 1 : 1);
      // 相邻项中心间距就是一格（布局上等距），直接用索引差即一格
      const r = i - flowFocusEff;
      const pos = Math.max(-1.15, Math.min(1.15, r));
      const adist = Math.max(0, Math.min(4, Math.abs(r)));
      const p = pos.toFixed(3);
      const d = adist.toFixed(3);
      if (it.dataset.pos !== p || it.dataset.adist !== d) {
        it.dataset.pos = p;
        it.dataset.adist = d;
        it.style.setProperty('--pos', p);
        it.style.setProperty('--adist', d);
      }
      it.classList.toggle('focus', i === flowIndex);
    }
  }

  function scheduleFlow() {
    if (flowRaf) return;
    flowRaf = requestAnimationFrame(updateFlow);
  }

  /** 设置焦点并（可选）居中动画；center=false 只换高亮不平移 */
  function setFlowFocus(i, center) {
    const items = flowItems();
    if (!items.length) return;
    const idx = Math.max(0, Math.min(items.length - 1, Number(i) || 0));
    const changed = flowIndex !== idx;
    flowIndex = idx;
    flowFocusEff = idx;
    if (changed || center !== false) {
      if (center !== false) placeRow(rowTargetX(), true);
      updateFlow();
      updateFlowChrome();
    }
  }

  /** 当前在播的那张碟作为初始焦点 */
  function focusCurrent() {
    const items = flowItems();
    if (!items.length) return;
    let idx = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].classList.contains('current')) { idx = i; break; }
    }
    flowIndex = -1;               // 让 setFlowFocus 视为"变了"，强制居中一次
    setFlowFocus(idx, true);
  }

  /** 顶部大字专辑名 + 播放按钮可见性跟随焦点 */
  function updateFlowChrome() {
    const items = flowItems();
    const it = items[flowIndex];
    if (flowTop) {
      const name = it ? (it.dataset.album || '') : '';
      setTopName(name);
    }
    if (flowMeta) {
      flowMeta.textContent = it ? flowMetaLine(it.__meta) : '';
      flowMeta.title = flowMeta.textContent;
    }
    if (flowPlay) {
      const on = !!it;
      flowPlay.classList.toggle('hidden', !on);
      const playing = App.state.signature && it && it.dataset.sig === App.state.signature &&
        App.state.phase === 'ready';
      flowPlay.classList.toggle('is-current', !!playing);
      flowPlay.title = T(playing ? 'library.flow.playHere' : 'library.flow.playRequest');
    }
  }

  /**
   * 封面下方信息行（v10.5）：艺术家 · 年份 · 碟号 · 歌总数。
   * 碟号只在元数据里有记录时显示（多碟专辑 D1/2，单碟 D1），
   * 手动补录没有碟号信息的条目自动省略这一段。
   */
  function flowMetaLine(meta) {
    if (!meta) return '';
    const parts = [];
    if (meta.artist) parts.push(meta.artist);
    if (meta.year) parts.push(String(meta.year));
    const discTotal = Number(meta.discTotal) >= 1 ? Math.floor(Number(meta.discTotal)) : 0;
    const discNumber = Number(meta.discNumber) >= 1 ? Math.floor(Number(meta.discNumber)) : 0;
    if (discNumber) parts.push(discTotal > 1 ? `D${discNumber}/${discTotal}` : `D${discNumber}`);
    parts.push(T('common.tracks', { n: meta.trackCount || (meta.tracks || []).length || 0 }));
    return parts.join(' · ');
  }

  /** 顶部专辑名：放得下静态显示，放不下 marquee 滚动（克隆一份无缝衔接） */
  function setTopName(name) {
    if (!flowTop) return;
    flowTop.classList.remove('marquee');
    flowTop.innerHTML = '';
    if (!name) return;
    const inner = document.createElement('span');
    inner.className = 'lib-flow-top-inner';
    const text = document.createElement('span');
    text.textContent = name;
    inner.appendChild(text);
    flowTop.appendChild(inner);
    requestAnimationFrame(() => {
      if (!flowTop || !flowTop.isConnected || !inner.isConnected) return;
      if (flowTop.textContent !== name) return;
      // 容器放得下就静态居中；放不下克隆一份，CSS 负责无缝滚动
      if (flowTop.scrollWidth <= flowTop.clientWidth + 1) return;
      const clone = document.createElement('span');
      clone.className = 'lib-flow-top-clone';
      clone.textContent = name;
      inner.appendChild(clone);
      flowTop.classList.add('marquee');
    });
  }

  /* ---------- 视图切换（样式只在设置里改）---------- */

  /** style: 'grid'（原版） / 'flow'（CoverFlow） */
  function setStyle(next) {
    style = (next === 'flow') ? 'flow' : 'grid';
    el.classList.toggle('flow', style === 'flow');
    if (App && App.setLibraryStyle) App.setLibraryStyle(style, false);
    render();
  }

  /* ---------- 右键菜单 ---------- */

  let ctxMenu = null;

  function ensureMenu() {
    if (ctxMenu) return ctxMenu;
    ctxMenu = document.createElement('div');
    ctxMenu.className = 'ctx-menu hidden';
    document.body.appendChild(ctxMenu);
    // 任何左键点击 / 滚动 / 失焦都收起菜单
    document.addEventListener('mousedown', (e) => {
      if (ctxMenu && !ctxMenu.contains(e.target)) hideMenu();
    }, true);
    document.addEventListener('contextmenu', (e) => {
      if (ctxMenu && !ctxMenu.contains(e.target)) hideMenu();
    });
    window.addEventListener('blur', hideMenu);
    window.addEventListener('resize', hideMenu);
    return ctxMenu;
  }

  function hideMenu() {
    if (ctxMenu) ctxMenu.classList.add('hidden');
  }

  function showCardMenu(x, y, meta) {
    const menu = ensureMenu();
    menu.innerHTML = '';
    const cur = !!(meta && meta.signature && meta.signature === App.state.signature);
    menu.appendChild(menuHint(T(cur ? 'library.menu.inDrive' : 'library.menu.notInDrive')));
    menu.appendChild(menuItem(T('library.menu.edit'), () => {
      hideMenu();
      Edit.open(meta && meta.signature);
    }));
    menu.appendChild(menuSep());
    menu.appendChild(menuItem(T('library.menu.remove'), async () => {
      hideMenu();
      if (!meta || !meta.signature) return;
      /* v10.7：移除前必须确认。用户反馈移除太容易误触，且不知道
         "移除"意味着本地元数据也没了——重新放入 CD 才会再次入藏。 */
      const yes = await confirmDialog({
        title: T('library.menu.confirmTitle', { album: meta.album || T('common.unknownAlbum') }),
        message: T('library.menu.confirmMsg'),
        okText: T('library.menu.confirmOk')
      });
      if (!yes) return;
      try {
        await window.cd.invoke('meta:remove', meta.signature);
        Toast(T('library.menu.removed'));
        Library.refresh();
      } catch (e) {
        Toast(T('library.menu.removeFail', { err: e.message }));
      }
    }, true));

    menu.classList.remove('hidden');
    // 先渲染再量尺寸，避免贴边溢出
    const r = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 8);
    const top = Math.min(y, window.innerHeight - r.height - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
  }

  function menuItem(text, onClick, danger) {
    const b = document.createElement('button');
    b.className = 'ctx-item' + (danger ? ' danger' : '');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function menuSep() {
    const d = document.createElement('div');
    d.className = 'ctx-sep';
    return d;
  }

  function menuHint(text) {
    const d = document.createElement('div');
    d.className = 'ctx-hint';
    d.textContent = text;
    return d;
  }

  /* ---------- v10.7：通用确认对话框 ---------- */

  let confirmEl = null;

  function ensureConfirm() {
    if (confirmEl && confirmEl.isConnected) return confirmEl;
    const wrap = document.createElement('div');
    wrap.className = 'lib-confirm hidden';
    wrap.innerHTML =
      '<div class="lib-confirm-mask"></div>' +
      '<div class="lib-confirm-card" role="dialog" aria-modal="true">' +
      '  <div class="lib-confirm-title"></div>' +
      '  <div class="lib-confirm-msg"></div>' +
      '  <div class="lib-confirm-btns">' +
      '    <button type="button" class="lib-confirm-cancel">' + T('common.cancel') + '</button>' +
      '    <button type="button" class="lib-confirm-ok">' + T('common.ok') + '</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap);
    confirmEl = wrap;
    return wrap;
  }

  /**
   * 通用确认框（v10.7）：返回 Promise<boolean>。
   * Esc = 取消、Enter = 确认、点遮罩 = 取消；
   * 默认焦点落在"取消"上——破坏性操作不能一个回车就执行。
   * 挂在 document.body 上，render() 重建 #page-library 不影响它。
   */
  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const wrap = ensureConfirm();
      const title = wrap.querySelector('.lib-confirm-title');
      const msg = wrap.querySelector('.lib-confirm-msg');
      const okBtn = wrap.querySelector('.lib-confirm-ok');
      const cancelBtn = wrap.querySelector('.lib-confirm-cancel');
      const mask = wrap.querySelector('.lib-confirm-mask');
      const o = opts || {};
      title.textContent = o.title || T('common.confirm');
      msg.textContent = o.message || '';
      okBtn.textContent = o.okText || T('common.ok');
      cancelBtn.textContent = o.cancelText || T('common.cancel');
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        wrap.classList.add('hidden');
        document.removeEventListener('keydown', onKey, true);
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        mask.removeEventListener('click', onCancel);
        resolve(v);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      mask.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey, true);
      wrap.classList.remove('hidden');
      cancelBtn.focus();
    });
  }

  /* ---------- 渲染 ---------- */

  function render() {
    el.innerHTML = '';
    /* v10.7：render() 也由切换视图触发，每次重建都回到"无搜索"状态，
       避免用户面对一份不知道何时被过滤掉的列表。 */
    _query = '';
    searchOpen = false;
    const header = document.createElement('div');
    header.className = 'lib-header';

    const title = document.createElement('div');
    title.className = 'lib-title';
    title.textContent = T('library.title');
    header.appendChild(title);

    const count = document.createElement('div');
    count.className = 'lib-count';
    count.id = 'lib-count';
    header.appendChild(count);

    const hint = document.createElement('div');
    hint.className = 'lib-hint';
    hint.textContent = T(style === 'flow' ? 'library.hint.flow' : 'library.hint.grid');
    header.appendChild(hint);

    el.appendChild(header);

    if (style === 'flow') {
      /* 顶部大字专辑名（选中项） */
      flowTop = document.createElement('div');
      flowTop.className = 'lib-flow-top';
      flowTop.id = 'lib-flow-top';
      el.appendChild(flowTop);

      /* 专辑名下方信息行：艺术家 · 年份 · 碟号 · 歌总数（v10.5） */
      flowMeta = document.createElement('div');
      flowMeta.className = 'lib-flow-meta';
      flowMeta.id = 'lib-flow-meta';
      el.appendChild(flowMeta);

      const container = document.createElement('div');
      container.className = 'lib-flow';
      container.id = 'lib-flow';
      flowEl = container;
      flowIndex = -1;
      flowFocusEff = 0;
      wheelAcc = 0;
      pending = false;
      dragging = false;
      dragMoved = 0;
      dragPointer = null;
      flowRow = document.createElement('div');
      flowRow.className = 'lib-flow-row';
      container.appendChild(flowRow);

      /* 选中项封面下方的播放按钮（= 原版点专辑图的行为） */
      flowPlay = document.createElement('button');
      flowPlay.type = 'button';
      flowPlay.className = 'lib-flow-play hidden';
      flowPlay.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<path d="M8 5.5v13l11-6.5z"/></svg><span>' + T('library.flow.play') + '</span>';
      flowPlay.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const items = flowItems();
        const it = items[flowIndex];
        if (!it) return;
        const sig = it.dataset.sig;
        const meta = _lastItems.find((m) => m.signature === sig);
        if (meta) App.requestDisc(meta);
      });
      container.appendChild(flowPlay);

      wireFlowPointer(container);
      container.addEventListener('wheel', onFlowWheel, { passive: false });
      el.appendChild(container);
    } else {
      const container = document.createElement('div');
      container.className = 'lib-grid';
      container.id = 'lib-grid';
      flowEl = null;
      flowRow = null;
      flowTop = null;
      flowMeta = null;
      flowPlay = null;
      flowIndex = -1;
      el.appendChild(container);
    }
    /* v10.7：右下角弹出按钮 + 左下角搜索（默认隐藏，鼠标靠近显现） */
    mountCornerTools();
    refresh();
  }

  /** 最近一次 refresh 拿到的元数据列表（播放按钮按 sig 反查） */
  let _lastItems = [];

  /* ================================================================
   * v10.7：音乐库角落工具
   *   - 右下角圆形按钮：有碟 → 退碟（cd:eject）；无碟 → 弹出托盘
   *     （cd:close-door）。默认隐藏，鼠标靠近半径内淡入。
   *   - 左下角放大镜：点开搜索栏，对每张专辑的元数据做全字段匹配
   *     （专辑名 / 歌曲名 / 艺术家 / 年份 / 歌词正文，含背景人声），
   *     实时过滤显示。同样默认隐藏、靠近显现。
   * 两个按钮都挂在 #page-library 里，render() 每次重建时重新挂载。
   * ================================================================ */

  /** 靠近按钮中心多少 px 内开始淡入 */
  const FAB_NEAR_PX = 150;
  /** 离开多少 px 才淡出（滞回，防止在边界上来回抖） */
  const FAB_FAR_PX = 210;

  /** 当前搜索词（空 = 不过滤） */
  let _query = '';
  let searchPanelEl = null;
  let searchInputEl = null;
  let searchCountEl = null;
  let searchOpen = false;
  /** 靠近显现的 document 级监听是否已注册（render() 反复重建，只绑一次） */
  let _cornerProximityWired = false;

  const ICON_EJECT =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
    '<path d="M6 18h12v1.6H6zM12 4l7 9H5z"/></svg>';                       // 退碟：▲ 出盘
  const ICON_TRAY =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
    '<path d="M4 5h16v10H4zM2 17h20v2H2z"/><path d="M11 7l4 4h-8z"/></svg>'; // 弹托盘

  function fabButton(id, cls, title, icon) {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = 'lib-fab ' + cls;
    b.title = title;
    b.innerHTML = icon;
    return b;
  }

  function mountCornerTools() {
    /* ---- 右下角：退碟 / 弹托盘 ---- */
    const ejectBtn = fabButton('lib-fab-eject', 'lib-fab-eject', T('library.fab.eject'), ICON_EJECT);
    ejectBtn.addEventListener('mouseenter', () => syncFabEject(ejectBtn));
    ejectBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      let st = null;
      try { st = await window.cd.invoke('cd:get-state'); } catch (err) { /* 忽略 */ }
      // demo 碟没有物理光盘，按"无碟"处理（弹托盘让用户放真碟）
      const hasDisc = !!(st && st.signature && st.signature !== '__demo__');
      syncFabEject(ejectBtn, hasDisc);
      if (hasDisc) {
        Toast(T('library.fab.ejecting'));
        window.cd.invoke('cd:eject').catch(() => Toast(T('library.fab.ejectFail')));
      } else {
        Toast(T('library.fab.opening'));
        window.cd.invoke('cd:close-door').catch(() => Toast(T('library.fab.openFail')));
      }
    });
    el.appendChild(ejectBtn);

    /* ---- 左下角：搜索 ---- */
    const searchWrap = document.createElement('div');
    searchWrap.className = 'lib-search';
    searchWrap.id = 'lib-search';

    const searchBtn = fabButton('lib-fab-search', 'lib-fab-search', T('library.search.title'),
      '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>');
    searchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSearch(!searchOpen);
    });
    searchWrap.appendChild(searchBtn);

    const panel = document.createElement('div');
    panel.className = 'lib-search-panel hidden';
    panel.id = 'lib-search-panel';

    const input = document.createElement('input');
    input.id = 'lib-search-input';
    input.type = 'text';
    input.placeholder = T('library.search.placeholder');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', () => {
      _query = input.value;
      applySearch();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleSearch(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // 只有一个匹配时回车直接打开详情页
        const items = filteredItems();
        if (items.length === 1 && window.Album) {
          toggleSearch(false);
          Album.open(items[0], null);
        }
      }
      e.stopPropagation();
    });
    panel.appendChild(input);

    const count = document.createElement('span');
    count.className = 'lib-search-count';
    count.id = 'lib-search-count';
    panel.appendChild(count);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'lib-search-close';
    closeBtn.title = T('library.search.close');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSearch(false);
    });
    panel.appendChild(closeBtn);

    searchWrap.appendChild(panel);
    el.appendChild(searchWrap);

    searchPanelEl = panel;
    searchInputEl = input;
    searchCountEl = count;

    /* 靠近显现：一个 document 级 mousemove 同时照看两个按钮。
       render() 会反复重建页面 DOM，监听器只注册一次（元素用 id 现取）。 */
    if (!_cornerProximityWired) {
      _cornerProximityWired = true;
      document.addEventListener('mousemove', onCornerProximity, { passive: true });
      document.addEventListener('mouseleave', onCornerProximityLeave);
      // 点页面空白处收起搜索（不拦输入框内的点击）；el 是常驻元素，只绑一次
      el.addEventListener('mousedown', (e) => {
        if (!searchOpen) return;
        const wrap = document.getElementById('lib-search');
        if (wrap && wrap.contains(e.target)) return;
        toggleSearch(false);
      });
    }
  }

  /** 按当前光驱状态刷新弹出钮的图标 / 提示（hasDisc 缺省时现场查一次） */
  async function syncFabEject(btn, hasDisc) {
    if (hasDisc === undefined) {
      let st = null;
      try { st = await window.cd.invoke('cd:get-state'); } catch (err) { /* 忽略 */ }
      hasDisc = !!(st && st.signature && st.signature !== '__demo__');
    }
    btn.classList.toggle('has-disc', hasDisc);
    btn.innerHTML = hasDisc ? ICON_EJECT : ICON_TRAY;
    btn.title = T(hasDisc ? 'library.fab.ejectTitle' : 'library.fab.trayTitle');
  }

  function onCornerProximity(e) {
    // 非音乐库页 / 有覆盖层（详情页、设置页等）时不响应
    if (!e || App.state.page !== 'library') { hideCornerTools(); return; }
    if (document.querySelector('.overlay:not(.hidden)')) { hideCornerTools(); return; }
    const ejectBtn = document.getElementById('lib-fab-eject');
    const searchBtn = document.getElementById('lib-fab-search');
    if (ejectBtn) nearToggle(ejectBtn, e.clientX, e.clientY);
    // 搜索栏展开期间放大镜常亮（否则输入时鼠标稍远就消失，很违和）
    if (searchBtn) {
      if (searchOpen) searchBtn.classList.add('near');
      else nearToggle(searchBtn, e.clientX, e.clientY);
    }
  }

  function onCornerProximityLeave() {
    hideCornerTools();
  }

  function hideCornerTools() {
    const ejectBtn = document.getElementById('lib-fab-eject');
    const searchBtn = document.getElementById('lib-fab-search');
    if (ejectBtn) ejectBtn.classList.remove('near');
    if (searchBtn && !searchOpen) searchBtn.classList.remove('near');
  }

  function nearToggle(btn, mx, my) {
    const r = btn.getBoundingClientRect();
    if (!r.width) { btn.classList.remove('near'); return; }   // 页面不可见
    const dx = mx - (r.left + r.width / 2);
    const dy = my - (r.top + r.height / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    const near = btn.classList.contains('near');
    if (!near && d <= FAB_NEAR_PX) btn.classList.add('near');
    else if (near && d > FAB_FAR_PX) btn.classList.remove('near');
  }

  /* ---- 搜索 ---- */

  function toggleSearch(on) {
    searchOpen = !!on;
    if (!searchPanelEl) return;
    searchPanelEl.classList.toggle('hidden', !searchOpen);
    const wrap = document.getElementById('lib-search');
    if (wrap) wrap.classList.toggle('open', searchOpen);
    const btn = document.getElementById('lib-fab-search');
    if (btn) btn.classList.toggle('near', searchOpen);
    if (searchOpen) {
      if (searchInputEl) { searchInputEl.value = _query; searchInputEl.focus(); searchInputEl.select(); }
    } else {
      // 收起即清空：避免下次进来看到一份"不知道什么时候过滤掉"的列表
      if (searchInputEl) searchInputEl.value = '';
      if (_query) { _query = ''; applySearch(); }
    }
  }

  /** 一张专辑是否匹配搜索词（全字段：专辑 / 歌曲 / 艺术家 / 年份 / 歌词正文） */
  function matchMeta(meta, q) {
    if (!meta) return false;
    const low = q.toLowerCase();
    const hay = [];
    if (meta.album) hay.push(meta.album);
    if (meta.artist) hay.push(meta.artist);
    if (meta.year != null && meta.year !== '') hay.push(String(meta.year));
    const tracks = Array.isArray(meta.tracks) ? meta.tracks : [];
    for (const tr of tracks) {
      if (!tr) continue;
      if (tr.title) hay.push(tr.title);
      if (tr.artist) hay.push(tr.artist);
    }
    // 歌词正文：统一模型 lines（含背景人声条目）的 text
    const ld = meta.lyricsData;
    if (ld && Array.isArray(ld.lines)) {
      for (const l of ld.lines) {
        if (!l) continue;
        if (l.text) hay.push(l.text);
        if (Array.isArray(l.bg)) {
          for (const b of l.bg) { if (b && b.text) hay.push(b.text); }
        }
      }
    }
    return hay.some((v) => v.toLowerCase().indexOf(low) >= 0);
  }

  function filteredItems() {
    const q = _query.trim();
    if (!q) return _lastItems;
    return _lastItems.filter((m) => matchMeta(m, q));
  }

  /** 搜索词变化：只重建列表内容，不重新走 IPC */
  function applySearch() {
    if (searchCountEl) {
      const q = _query.trim();
      const n = filteredItems().length;
      searchCountEl.textContent = q ? T('library.search.matches', { n: n }) : '';
    }
    rebuildItems();
  }

  /* ---------- CoverFlow 滚轮：直接切换焦点 ---------- */

  function onFlowWheel(e) {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    wheelAcc += d;
    if (Math.abs(wheelAcc) >= WHEEL_STEP) {
      setFlowFocus(flowIndex + (wheelAcc > 0 ? 1 : -1), true);
      wheelAcc = 0;
    }
  }

  /* ---------- CoverFlow 拖动（鼠标 / 触摸） ---------- */

  function wireFlowPointer(container) {
    container.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;      // 只响应左键
      const items = flowItems();
      if (!items.length) return;
      // ★ 关键：pointerdown 时绝不能 setPointerCapture ——
      //   指针捕获会把随后的 mousedown/mouseup/click 一并重定向到容器，
      //   子元素（封面 / 播放按钮）的 click 永远不触发（v10.5 修复）。
      //   现在只记录"待定"状态，等指针移动真的超过拖动阈值、
      //   确定这是拖动而不是点击之后，才捕获指针进入拖动。
      pending = true;
      dragging = false;
      dragMoved = 0;
      dragStartX = e.clientX;
      dragStartRowX = currentRowX();
      dragRowX = dragStartRowX;
      dragPointer = e.pointerId;
    });
    container.addEventListener('pointermove', (e) => {
      if (!pending || (dragPointer != null && e.pointerId !== dragPointer)) return;
      const dx = e.clientX - dragStartX;
      if (!dragging) {
        // 阈值内：可能是点击，不捕获、不位移，保留正常点击语义
        if (Math.abs(dx) <= DRAG_SLOP) return;
        dragging = true;
        try { container.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        container.classList.add('flow-dragging');
      }
      dragMoved = Math.max(dragMoved, Math.abs(dx));
      dragRowX = dragStartRowX + dx;
      placeRow(dragRowX, false);
      // 跟手几何：把像素偏移换算成生效焦点的小数部分
      const items = flowItems();
      if (items.length > 1) {
        const step = Math.abs(items[1].offsetLeft - items[0].offsetLeft) || 1;
        flowFocusEff = flowIndex - dx / step;
        scheduleFlow();
      }
    });
    const endDrag = (e) => {
      const wasDragging = dragging;
      pending = false;
      if (dragPointer != null) {
        try { container.releasePointerCapture(dragPointer); } catch (err) { /* 忽略 */ }
        dragPointer = null;
      }
      dragging = false;
      // 先恢复过渡，再吸附，松口才有一段平滑的归位动画
      container.classList.remove('flow-dragging');
      if (!wasDragging) return;   // 没进入拖动：这次交互是点击，什么都不做
      // 松口吸附到最近的一张
      const items = flowItems();
      if (!items.length) return;
      const nearest = Math.max(0, Math.min(items.length - 1, Math.round(flowFocusEff)));
      setFlowFocus(nearest, true);
      // 下一次点击若发生在拖动后，dragMoved 仍在（点击处理里判断），
      // 这里延后清零，保证"拖动后那次 click"被抑制
      setTimeout(() => { dragMoved = 0; }, 0);
    };
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);
  }

  /** 当前整行的实际平移量（从 transform 矩阵里读出来，拖动续接用） */
  function currentRowX() {
    if (!flowRow) return 0;
    const t = getComputedStyle(flowRow).transform;
    if (!t || t === 'none') return 0;
    const m = new DOMMatrixReadOnly(t);
    return m.m41;
  }

  /* ---------- 数据 ---------- */

  async function refresh() {
    let items = [];
    try {
      items = await window.cd.invoke('meta:list');
    } catch (e) { items = []; }
    _lastItems = items;
    rebuildItems();
  }

  /**
   * 按 _lastItems（可能被搜索词过滤）重建列表内容。
   * refresh() 取数后、搜索输入时都走这里——只重建 DOM，不再走 IPC。
   */
  function rebuildItems() {
    const grid = document.getElementById('lib-grid');
    const flow = document.getElementById('lib-flow');
    const container = grid || flow;
    const count = document.getElementById('lib-count');
    if (!container) return;
    const q = _query.trim();
    const items = q ? _lastItems.filter((m) => matchMeta(m, q)) : _lastItems;
    if (count) {
      count.textContent = q
        ? T('library.countFiltered', { n: items.length, total: _lastItems.length })
        : (_lastItems.length ? T('library.count', { n: _lastItems.length }) : '');
    }
    // 空态 .lib-empty 是挂在 container（视口）上的，而 flowRow 只是它的子元素。
    // 只清 flowRow 会留下上一次的空态：关闭搜索后残留不消失，且每触发一次
    // 无结果就多叠一个（v10.7 用户实测 bug）。这里先把陈旧空态全部摘掉。
    const staleEmpties = container.querySelectorAll('.lib-empty');
    for (let i = 0; i < staleEmpties.length; i++) staleEmpties[i].remove();
    if (flowRow) flowRow.innerHTML = ''; else container.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'lib-empty';
      const mark = document.createElement('div');
      mark.className = 'lib-empty-mark';
      mark.textContent = T(q ? 'library.empty.noMatchMark' : 'library.empty.emptyMark');
      const p1 = document.createElement('p');
      p1.textContent = q
        ? T('library.empty.noMatch', { q: q })
        : T('library.empty.none');
      const p2 = document.createElement('p');
      p2.textContent = q
        ? T('library.empty.noMatchSub')
        : T('library.empty.noneSub');
      empty.appendChild(mark);
      empty.appendChild(p1);
      empty.appendChild(p2);
      container.appendChild(empty);
      if (flowPlay) flowPlay.classList.add('hidden');
      if (flowTop) setTopName('');
      if (flowMeta) { flowMeta.textContent = ''; flowMeta.title = ''; }
      flowIndex = -1;
      flowFocusEff = 0;
      return;
    }
    if (flowRow) {
      for (const item of items) {
        const node = buildFlowItem(item);
        node.dataset.album = item.album || T('common.unknownAlbum');
        flowRow.appendChild(node);
      }
      // 首帧先算一次几何，再把焦点（默认当前在播的那张）滚到中间
      flowIndex = -1;
      flowFocusEff = 0;
      updateFlow();
      focusCurrent();
      // 封面异步解码后尺寸会变，下一帧再校准一次
      requestAnimationFrame(scheduleFlow);
    } else {
      for (const item of items) container.appendChild(buildCard(item));
    }
  }

  /* ---------- CoverFlow 键盘导航 ---------- */

  function onFlowKey(e) {
    if (style !== 'flow' || !flowRow) return;
    if (App.state.page !== 'library') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    const tag = (t && t.tagName ? t.tagName.toLowerCase() : '');
    if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
    if (document.querySelector('.overlay:not(.hidden)')) return;

    const items = flowItems();
    if (!items.length) return;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        setFlowFocus(flowIndex - 1, true);
        break;
      case 'ArrowRight':
        e.preventDefault();
        setFlowFocus(flowIndex + 1, true);
        break;
      case 'Home':
        e.preventDefault();
        setFlowFocus(0, true);
        break;
      case 'End':
        e.preventDefault();
        setFlowFocus(items.length - 1, true);
        break;
      case 'Enter': {
        e.preventDefault();
        const it = items[flowIndex];
        if (it && window.Album) {
          const sig = it.dataset.sig;
          const meta = _lastItems.find((m) => m.signature === sig);
          if (meta) Album.open(meta, it);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    render, refresh, setStyle, getStyle: () => style, onFlowKey,
    /** 窗口尺寸变化：重新居中当前焦点 */
    onResize() {
      if (style === 'flow' && flowRow) {
        placeRow(rowTargetX(), false);
        scheduleFlow();
      }
    }
  };
})();
