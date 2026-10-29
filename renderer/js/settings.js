'use strict';
/* ============================================================
   settings.js —— 设置面板
   ------------------------------------------------------------
   纯界面设置。全部走既有的 settings:get / settings:set 通道，
   新增项只写 renderer 与主进程共用的 settings.json，主进程不需要
   为界面偏好增加任何分支逻辑（除窗口底色跟随主题这一处）。

   v10.11：全量文案走 i18n（T('key')）。面板是"按需重建"的——
   每次 open() 都重新生成 DOM，因此切换语言时只要 refresh() 重建
   一次，所有文案（含下拉选项、滑条标签）就会跟着换。
   ============================================================ */

const SettingsPanel = (() => {
  const el = document.getElementById('overlay-settings');

  /* ---------- 分类导航元数据（v10.9.2 双栏）：key 为 i18n 键 ---------- */
  const NAV = [
    {
      key: 'set.nav.appearance',
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.9-.9 1.9-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.9 1.9-1.9h1.6A4.8 4.8 0 0 0 21 9.8C21 6 17 3 12 3z"/><circle cx="8.3" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="7.3" r="1.1" fill="currentColor" stroke="none"/><circle cx="7.6" cy="13.6" r="1.1" fill="currentColor" stroke="none"/></svg>'
    },
    {
      key: 'set.nav.fl',
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="13" rx="2.5"/><path d="M7 9.5h10M7 13h6"/></svg>'
    },
    {
      key: 'set.nav.playback',
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.8l5 3.2-5 3.2z" fill="currentColor" stroke="none"/></svg>'
    },
    {
      key: 'set.nav.system',
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/></svg>'
    },
    {
      key: 'set.nav.keys',
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1.6M10.6 10h1.6M15.2 10h1.6M6.8 13.8h10.4"/></svg>'
    },
    {
      key: 'set.nav.about',
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v4.6"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/></svg>'
    }
  ];

  /** 当前所在分类页（重建面板时保持，不让改完语言被弹回第一页） */
  let activePage = 0;

  /** 主题名的当前语言版本（统一走 FlThemes.nameOf，缺省回退中文 name） */
  function themeName(def) {
    if (!def) return '';
    if (window.FlThemes && FlThemes.nameOf) return FlThemes.nameOf(def);
    return def.nameKey ? T(def.nameKey) : (def.name || '');
  }

  let data = {
    autoPlay: true,
    defaultVolume: 0.7,
    enginePreference: 'auto',
    ejectReturnToScene: true,
    smtcEnabled: true,
    theme: 'dark',
    tabAutoHide: true,
    visualFx: true,
    immersiveMode: false,
    splitView: false,
    libraryStyle: 'grid',
    lang: 'zh-CN'
  };

  async function open() {
    try { data = Object.assign(data, await window.cd.invoke('settings:get')); } catch (e) { /* 默认值 */ }
    if (App.state.settings) Object.assign(App.state.settings, data);
    el.innerHTML = '';
    el.classList.remove('hidden');

    const panel = document.createElement('div');
    panel.className = 'panel set-panel';

    const head = document.createElement('div');
    head.className = 'panel-head';
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = T('set.title');
    const close = document.createElement('button');
    close.className = 'panel-close';
    close.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener('click', closePanel);
    head.appendChild(title);
    head.appendChild(close);
    panel.appendChild(head);

    const body = document.createElement('div');
    body.className = 'panel-body';

    /* ---------- 外观 ---------- */
    body.appendChild(section('set.nav.appearance'));

    // 界面语言（v10.11）：紧跟主题之后，是"整窗观感"的一部分。
    // 选项一律用各语言自己的名字（简体中文 / 繁體中文 / English…），
    // 不翻译成当前语言——否则用户看不懂哪一项是自己要的。
    const rowLang = document.createElement('div');
    rowLang.className = 'set-row';
    rowLang.appendChild(labelBlock('set.appearance.lang.label', 'set.appearance.lang.desc'));
    const selLang = document.createElement('select');
    selLang.className = 'set-select';
    selLang.id = 'set-lang';
    for (const l of I18n.list()) {
      const op = document.createElement('option');
      op.value = l.id;
      op.textContent = l.name;
      selLang.appendChild(op);
    }
    selLang.value = I18n.get();
    selLang.addEventListener('change', () => {
      data.lang = selLang.value;
      if (App.setLang) App.setLang(selLang.value, true);
    });
    rowLang.appendChild(selLang);
    body.appendChild(rowLang);

    // 界面主题（深色 / 浅色）
    const rowTheme = document.createElement('div');
    rowTheme.className = 'set-row';
    rowTheme.appendChild(labelBlock('set.appearance.theme.label', 'set.appearance.theme.desc'));
    const seg = document.createElement('div');
    seg.className = 'seg-group';
    seg.setAttribute('role', 'radiogroup');
    const mkSeg = (value, text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (data.theme === value ? ' on' : '');
      b.dataset.theme = value;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(data.theme === value));
      const dot = document.createElement('span');
      dot.className = 'seg-dot';
      b.appendChild(dot);
      const t = document.createElement('span');
      t.textContent = text;
      b.appendChild(t);
      b.addEventListener('click', async () => {
        const btns = seg.querySelectorAll('.seg-btn');
        for (let i = 0; i < btns.length; i++) {
          const on = btns[i].dataset.theme === value;
          btns[i].classList.toggle('on', on);
          btns[i].setAttribute('aria-checked', String(on));
        }
        data.theme = value;
        if (App.setTheme) await App.setTheme(value);
      });
      return b;
    };
    seg.appendChild(mkSeg('dark', T('set.appearance.theme.dark')));
    seg.appendChild(mkSeg('light', T('set.appearance.theme.light')));
    rowTheme.appendChild(seg);
    body.appendChild(rowTheme);

    // 播放页标签栏自动隐藏
    const rowTab = document.createElement('div');
    rowTab.className = 'set-row';
    rowTab.appendChild(labelBlock('set.appearance.tabAuto.label', 'set.appearance.tabAuto.desc'));
    rowTab.appendChild(toggle(!!data.tabAutoHide, async (next) => {
      data.tabAutoHide = next;
      if (NowPlaying.setAutoHide) NowPlaying.setAutoHide(next);
    }));
    body.appendChild(rowTab);

    // 音画律动（背景 / 歌词随鼓点）
    const rowFx = document.createElement('div');
    rowFx.className = 'set-row';
    rowFx.appendChild(labelBlock('set.appearance.fx.label', 'set.appearance.fx.desc'));
    rowFx.appendChild(toggle(data.visualFx !== false, async (next) => {
      data.visualFx = next;
      // ★ 必须落盘（v10.5 修复）：原来只改内存 + 通知 Visualizer，
      //   重启后又回到默认"开"，用户反馈"音画律动设置没保存"。
      await window.cd.invoke('settings:set', { visualFx: next }).catch(() => { /* 忽略 */ });
      if (typeof Visualizer !== 'undefined') Visualizer.setEnabled(next);
    }));
    body.appendChild(rowFx);

    // 桌面悬浮歌词：浮动动画（很贵，默认关）
    const rowFloatAnim = document.createElement('div');
    rowFloatAnim.className = 'set-row';
    rowFloatAnim.appendChild(labelBlock('set.appearance.floatAnim.label', 'set.appearance.floatAnim.desc'));
    rowFloatAnim.appendChild(toggle(data.floatingFloat === true, async (next) => {
      data.floatingFloat = next;
      await window.cd.invoke('app:set-float-anim', { on: next }).catch(() => { /* 忽略 */ });
    }));
    body.appendChild(rowFloatAnim);

    /* 悬浮歌词的译 / 音显隐（v10.6）：悬浮窗点不到主界面歌词头部的
       「译 / 音」按钮，改为设置页开关；只影响悬浮窗，主界面照旧。 */
    const rowFloatTr = document.createElement('div');
    rowFloatTr.className = 'set-row';
    rowFloatTr.appendChild(labelBlock('set.appearance.floatTr.label', 'set.appearance.floatTr.desc'));
    rowFloatTr.appendChild(toggle(data.floatingShowTr !== false, async (next) => {
      data.floatingShowTr = next;
      await window.cd.invoke('app:set-float-show', { tr: next }).catch(() => { /* 忽略 */ });
    }));
    body.appendChild(rowFloatTr);

    const rowFloatRo = document.createElement('div');
    rowFloatRo.className = 'set-row';
    rowFloatRo.appendChild(labelBlock('set.appearance.floatRo.label', 'set.appearance.floatRo.desc'));
    rowFloatRo.appendChild(toggle(data.floatingShowRo !== false, async (next) => {
      data.floatingShowRo = next;
      await window.cd.invoke('app:set-float-show', { ro: next }).catch(() => { /* 忽略 */ });
    }));
    body.appendChild(rowFloatRo);

    // 歌词 / 唱片 / 翻译大小（带恢复默认）
    const rowLyr = document.createElement('div');
    rowLyr.className = 'set-row';
    rowLyr.appendChild(labelBlock('set.appearance.size.label', 'set.appearance.size.desc'));
    const sizeBox = document.createElement('div');
    sizeBox.className = 'size-box';
    // 滑条与设置键一一对应：恢复默认按 keys 遍历，别再写下标三元
    const sizeKeys = [
      { label: 'set.appearance.size.lyric', key: 'lyricScale' },
      { label: 'set.appearance.size.disc', key: 'discScale' },
      { label: 'set.appearance.size.tr', key: 'trScale' },
      { label: 'set.appearance.size.ro', key: 'roScale' }
    ];
    const mkSize = (label, key, min, max, getVal, setVal) => {
      const wrap = document.createElement('div');
      wrap.className = 'size-item';
      const lb = document.createElement('span');
      lb.className = 'size-label';
      lb.textContent = label;
      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'slider';
      input.min = String(min);
      input.max = String(max);
      input.step = '0.05';
      input.value = String(getVal());
      const val = document.createElement('span');
      val.className = 'size-value tabular';
      val.textContent = Math.round(getVal() * 100) + '%';
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        val.textContent = Math.round(v * 100) + '%';
        setVal(v);
      });
      wrap.appendChild(lb);
      wrap.appendChild(input);
      wrap.appendChild(val);
      return wrap;
    };
    const sizeRanges = {
      lyricScale: [0.7, 1.8],
      discScale: [0.6, 1.6],
      trScale: [0.6, 1.8],
      roScale: [0.6, 1.8]
    };
    sizeKeys.forEach(({ label, key }) => {
      sizeBox.appendChild(mkSize(T(label), key, sizeRanges[key][0], sizeRanges[key][1],
        () => data[key] || 1,
        (v) => Sizes.apply({ [key]: v }, true)));
    });
    const resetBtn = document.createElement('button');
    resetBtn.className = 'panel-btn';
    resetBtn.type = 'button';
    resetBtn.textContent = T('common.reset');
    resetBtn.addEventListener('click', () => {
      const d = Sizes.defaults();
      const inputs = sizeBox.querySelectorAll('input[type="range"]');
      const vals = sizeBox.querySelectorAll('.size-value');
      Sizes.reset();
      sizeKeys.forEach(({ key }, i) => {
        data[key] = d[key];
        if (inputs[i]) inputs[i].value = String(d[key]);
        if (vals[i]) vals[i].textContent = Math.round(d[key] * 100) + '%';
      });
      Toast(T('set.appearance.size.resetToast'));
    });
    sizeBox.appendChild(resetBtn);
    rowLyr.appendChild(sizeBox);
    body.appendChild(rowLyr);

    // 沉浸模式
    const rowImm = document.createElement('div');
    rowImm.className = 'set-row';
    rowImm.appendChild(labelBlock('set.appearance.immersive.label', 'set.appearance.immersive.desc'));
    rowImm.appendChild(toggle(data.immersiveMode === true, async (next) => {
      data.immersiveMode = next;
      if (Immersive) Immersive.set(next);
    }));
    body.appendChild(rowImm);

    // 封面与歌词并排
    const rowSplit = document.createElement('div');
    rowSplit.className = 'set-row';
    rowSplit.appendChild(labelBlock('set.appearance.split.label', 'set.appearance.split.desc'));
    rowSplit.appendChild(toggle(data.splitView === true, async (next) => {
      data.splitView = next;
      if (NowPlaying.setSplit) NowPlaying.setSplit(next, false);
      if (App.setSplitView) App.setSplitView(next, true);
    }));
    body.appendChild(rowSplit);

    // 音乐库样式
    const rowLib = document.createElement('div');
    rowLib.className = 'set-row';
    rowLib.appendChild(labelBlock('set.appearance.libStyle.label', 'set.appearance.libStyle.desc'));
    const segLib = document.createElement('div');
    segLib.className = 'seg-group';
    segLib.setAttribute('role', 'radiogroup');
    const mkLib = (value, text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (data.libraryStyle === value ? ' on' : '');
      b.dataset.style = value;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(data.libraryStyle === value));
      const t = document.createElement('span');
      t.textContent = text;
      b.appendChild(t);
      b.addEventListener('click', async () => {
        const btns = segLib.querySelectorAll('.seg-btn');
        for (let i = 0; i < btns.length; i++) {
          const on = btns[i].dataset.style === value;
          btns[i].classList.toggle('on', on);
          btns[i].setAttribute('aria-checked', String(on));
        }
        data.libraryStyle = value;
        if (Library.setStyle) Library.setStyle(value);
        if (App.setLibraryStyle) App.setLibraryStyle(value, true);
      });
      return b;
    };
    segLib.appendChild(mkLib('grid', T('set.appearance.libStyle.grid')));
    segLib.appendChild(mkLib('flow', T('set.appearance.libStyle.flow')));
    rowLib.appendChild(segLib);
    body.appendChild(rowLib);

    /* 播放页封面样式（v10.6）：旋转唱片（默认）/ 方形。
       方形下暂停缩小、播放放大，切换带非线性缓动。 */
    const rowCover = document.createElement('div');
    rowCover.className = 'set-row';
    rowCover.appendChild(labelBlock('set.appearance.cover.label', 'set.appearance.cover.desc'));
    const segCover = document.createElement('div');
    segCover.className = 'seg-group';
    segCover.setAttribute('role', 'radiogroup');
    const mkCover = (value, text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (data.coverStyle === value ? ' on' : '');
      b.dataset.cover = value;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(data.coverStyle === value));
      const t = document.createElement('span');
      t.textContent = text;
      b.appendChild(t);
      b.addEventListener('click', async () => {
        const btns = segCover.querySelectorAll('.seg-btn');
        for (let i = 0; i < btns.length; i++) {
          const on = btns[i].dataset.cover === value;
          btns[i].classList.toggle('on', on);
          btns[i].setAttribute('aria-checked', String(on));
        }
        data.coverStyle = value;
        if (App.setCoverStyle) App.setCoverStyle(value, true);
      });
      return b;
    };
    segCover.appendChild(mkCover('disc', T('set.appearance.cover.disc')));
    segCover.appendChild(mkCover('square', T('set.appearance.cover.square')));
    rowCover.appendChild(segCover);
    body.appendChild(rowCover);

    /* 唱片中心圆孔（v10.7）：CD 中心的小圆圈，默认显示。
       仅影响「唱片」样式；「方形」封面下本就没有中孔。 */
    const rowHole = document.createElement('div');
    rowHole.className = 'set-row';
    rowHole.appendChild(labelBlock('set.appearance.hole.label', 'set.appearance.hole.desc'));
    rowHole.appendChild(toggle(data.discHole !== false, async (next) => {
      data.discHole = next;
      if (App.setDiscHole) App.setDiscHole(next, true);
      else await window.cd.invoke('settings:set', { discHole: next }).catch(() => { /* 忽略 */ });
    }));
    body.appendChild(rowHole);

    /* ---------- 全屏歌词（v10.8 M4） ----------
       与演出层左上角主题面板同源：同一组持久化键（flTheme/flSize/
       flShowTr/flShowRo/flFont），两边改哪边最终都落 settings.json。
       主题/字号/译音直接调 FlStage 对外 API（它自己会钳制范围），
       字体走 FlFonts（注入 @font-face 后写 #fl-stage 的 --fl-font）。 */
    body.appendChild(section('set.nav.fl'));

    // 演出主题
    const rowFlTheme = document.createElement('div');
    rowFlTheme.className = 'set-row';
    rowFlTheme.appendChild(labelBlock('set.fl.theme.label', 'set.fl.theme.desc'));
    const selTheme = document.createElement('select');
    selTheme.className = 'set-select';
    const themes = (window.FlThemes && typeof FlThemes.list === 'function') ? FlThemes.list() : [];
    for (const def of themes) {
      const op = document.createElement('option');
      op.value = def.id;
      op.textContent = themeName(def) + (def.type === '3d' ? T('set.fl.theme.opt3d') : '');
      selTheme.appendChild(op);
    }
    selTheme.value = data.flTheme || 'lumen';
    selTheme.addEventListener('change', () => {
      data.flTheme = selTheme.value;
      if (window.FlStage && FlStage.setTheme) FlStage.setTheme(selTheme.value);
    });
    rowFlTheme.appendChild(selTheme);
    body.appendChild(rowFlTheme);

    // 歌词弹出方式（v10.9：所有主题可套用的揭示模式）
    const rowFlReveal = document.createElement('div');
    rowFlReveal.className = 'set-row';
    rowFlReveal.appendChild(labelBlock('set.fl.reveal.label', 'set.fl.reveal.desc'));
    const selReveal = document.createElement('select');
    selReveal.className = 'set-select';
    selReveal.id = 'set-fl-reveal';
    const revealOpts = (window.FlStage && FlStage.revealModes && FlStage.revealModes())
      ? FlStage.revealModes()
      : [{ id: 'all', name: 'all' }, { id: 'line', name: 'line' }, { id: 'word', name: 'word' }];
    for (const def of revealOpts) {
      const op = document.createElement('option');
      op.value = def.id;
      op.textContent = T('set.fl.reveal.' + def.id);
      selReveal.appendChild(op);
    }
    selReveal.value = ['all', 'line', 'word'].indexOf(data.flReveal) >= 0 ? data.flReveal : 'all';
    selReveal.addEventListener('change', () => {
      const v = ['all', 'line', 'word'].indexOf(selReveal.value) >= 0 ? selReveal.value : 'all';
      selReveal.value = v;
      data.flReveal = v;
      if (window.FlStage && FlStage.setReveal) FlStage.setReveal(v);
      window.cd.invoke('settings:set', { flReveal: v }).catch(() => { /* 忽略 */ });
    });
    rowFlReveal.appendChild(selReveal);
    body.appendChild(rowFlReveal);

    // 歌词字号（与面板同一区间 24~56）
    const rowFlSize = document.createElement('div');
    rowFlSize.className = 'set-row';
    rowFlSize.appendChild(labelBlock('set.fl.size.label', 'set.fl.size.desc'));
    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.className = 'slider';
    sizeInput.min = '24';
    sizeInput.max = '56';
    sizeInput.step = '1';
    const flSizeVal = (typeof data.flSize === 'number' && isFinite(data.flSize)) ? data.flSize : 34;
    sizeInput.value = String(flSizeVal);
    sizeInput.setAttribute('aria-label', T('set.fl.size.aria'));
    const sizeNum = document.createElement('span');
    sizeNum.className = 'size-value tabular';
    sizeNum.textContent = String(flSizeVal);
    sizeInput.addEventListener('input', () => {
      const v = Math.max(24, Math.min(56, parseInt(sizeInput.value, 10) || 34));
      data.flSize = v;
      sizeNum.textContent = String(v);
      if (window.FlStage && FlStage.setSize) FlStage.setSize(v);
      window.cd.invoke('settings:set', { flSize: v }).catch(() => { /* 忽略 */ });
    });
    rowFlSize.appendChild(sizeInput);
    rowFlSize.appendChild(sizeNum);
    body.appendChild(rowFlSize);

    // 翻译 / 罗马音显隐
    const rowFlTr = document.createElement('div');
    rowFlTr.className = 'set-row';
    rowFlTr.appendChild(labelBlock('set.fl.tr.label', 'set.fl.tr.desc'));
    rowFlTr.appendChild(toggle(data.flShowTr !== false, async (next) => {
      data.flShowTr = next;
      if (window.FlStage && FlStage.setShowTr) FlStage.setShowTr(next);
      await window.cd.invoke('settings:set', { flShowTr: next }).catch(() => { /* 忽略 */ });
    }));
    body.appendChild(rowFlTr);

    const rowFlRo = document.createElement('div');
    rowFlRo.className = 'set-row';
    rowFlRo.appendChild(labelBlock('set.fl.ro.label', 'set.fl.ro.desc'));
    rowFlRo.appendChild(toggle(data.flShowRo !== false, async (next) => {
      data.flShowRo = next;
      if (window.FlStage && FlStage.setShowRo) FlStage.setShowRo(next);
      await window.cd.invoke('settings:set', { flShowRo: next }).catch(() => { /* 忽略 */ });
    }));
    body.appendChild(rowFlRo);

    /* ---- 字体：系统字体下拉 + 自定义字体（上传/删除） ---- */
    const rowFlFont = document.createElement('div');
    rowFlFont.className = 'set-row';
    rowFlFont.appendChild(labelBlock('set.fl.font.label', 'set.fl.font.desc'));
    const fontBox = document.createElement('div');
    fontBox.className = 'set-font-box';
    const selFont = document.createElement('select');
    selFont.className = 'set-select';
    const btnUpload = document.createElement('button');
    btnUpload.className = 'panel-btn';
    btnUpload.type = 'button';
    btnUpload.textContent = T('set.fl.font.upload');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.ttf,.otf,.woff,.woff2';
    fileInput.style.display = 'none';
    fontBox.appendChild(selFont);
    fontBox.appendChild(btnUpload);
    fontBox.appendChild(fileInput);
    rowFlFont.appendChild(fontBox);
    body.appendChild(rowFlFont);

    // 已上传字体列表（每项：名称 + 体积 + 删除）
    const fontList = document.createElement('div');
    fontList.className = 'set-font-list';
    body.appendChild(fontList);

    /* 字体下拉与列表重建：
       - 「默认字体」= 系统字体链（FlFonts 内部 DEFAULT_CHAIN）
       - 系统字体组：canvas 探测命中的才列（探测不到说明没装）
       - 自定义组：userData/fonts 仓库条目，点选即 @font-face 注入 */
    function rebuildFontSelect() {
      const cur = window.FlFonts ? FlFonts.current() : null;
      selFont.innerHTML = '';
      const mkOpt = (value, text, group) => {
        const op = document.createElement('option');
        op.value = value;
        op.textContent = text;
        if (group) op.dataset.group = group;
        selFont.appendChild(op);
        return op;
      };
      mkOpt('@default', T('set.fl.font.default'));
      const sysGroup = document.createElement('optgroup');
      sysGroup.label = T('set.fl.font.system');
      const sysFonts = (window.FlFonts && FlFonts.detectSystem) ? FlFonts.detectSystem() : [];
      for (const name of sysFonts) {
        const op = document.createElement('option');
        op.value = '@sys:' + name;
        op.textContent = name;
        sysGroup.appendChild(op);
      }
      selFont.appendChild(sysGroup);
      const custom = (window.FlFonts && FlFonts.customList) ? FlFonts.customList() : [];
      if (custom.length) {
        const grp = document.createElement('optgroup');
        grp.label = T('set.fl.font.custom');
        for (const f of custom) {
          const op = document.createElement('option');
          op.value = '@custom:' + f.id;
          op.textContent = f.name + '（' + (f.size / 1048576).toFixed(1) + 'MB）';
          grp.appendChild(op);
        }
        selFont.appendChild(grp);
      }
      // 回显当前选择
      let want = '@default';
      if (cur && cur.kind === 'system') want = '@sys:' + cur.name;
      else if (cur && cur.kind === 'custom') want = '@custom:' + cur.id;
      selFont.value = want;
      // 探测列表里没有当前系统字体（极端：字体被卸载）→ 补一项保住显示
      if (selFont.value !== want) {
        const op = document.createElement('option');
        op.value = want;
        op.textContent = (cur && cur.name) || want;
        selFont.appendChild(op);
        selFont.value = want;
      }
    }

    function rebuildFontList() {
      fontList.innerHTML = '';
      const custom = (window.FlFonts && FlFonts.customList) ? FlFonts.customList() : [];
      if (!custom.length) return;
      const head = document.createElement('div');
      head.className = 'set-font-head';
      head.textContent = T('set.fl.font.uploadedCount', { n: custom.length });
      fontList.appendChild(head);
      for (const f of custom) {
        const item = document.createElement('div');
        item.className = 'set-font-item';
        const nm = document.createElement('span');
        nm.className = 'set-font-name';
        nm.textContent = f.name;
        const sz = document.createElement('span');
        sz.className = 'set-font-size tabular';
        sz.textContent = (f.size / 1048576).toFixed(1) + 'MB';
        const del = document.createElement('button');
        del.className = 'panel-btn';
        del.type = 'button';
        del.textContent = T('common.delete');
        del.addEventListener('click', async () => {
          if (window.FlFonts) {
            const r = await FlFonts.remove(f.id);
            if (!r.ok && r.error) Toast(T('set.fl.font.deleteFail', { err: r.error }));
          }
          rebuildFontSelect();
          rebuildFontList();
        });
        item.appendChild(nm);
        item.appendChild(sz);
        item.appendChild(del);
        fontList.appendChild(item);
      }
    }

    selFont.addEventListener('change', async () => {
      const v = selFont.value;
      if (!window.FlFonts) return;
      if (v === '@default') await FlFonts.apply(null);
      else if (v.indexOf('@sys:') === 0) await FlFonts.apply({ kind: 'system', name: v.slice(5) });
      else if (v.indexOf('@custom:') === 0) {
        const id = v.slice(8);
        const meta = FlFonts.customList().find((f) => f.id === id);
        const r = await FlFonts.apply({ kind: 'custom', id: id, name: (meta && meta.family) || ('FlFont-' + id) });
        if (!r.ok && r.error) Toast(T('set.fl.font.loadFail', { err: r.error }));
      }
    });

    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file || !window.FlFonts) return;
      btnUpload.disabled = true;
      btnUpload.textContent = T('set.fl.font.uploading');
      try {
        const r = await FlFonts.save(file);
        if (r.ok && r.font) {
          Toast(T('set.fl.font.uploaded', { name: r.font.name }));
          rebuildFontSelect();
          rebuildFontList();
          // 上传即选用，省得用户再拉一次下拉
          const r2 = await FlFonts.apply({ kind: 'custom', id: r.font.id, name: r.font.family });
          if (r2.ok) rebuildFontSelect();
          else if (r2.error) Toast(T('set.fl.font.loadFail', { err: r2.error }));
        } else if (r.error) {
          Toast(T('set.fl.font.uploadFail', { err: r.error }));
        }
      } finally {
        btnUpload.disabled = false;
        btnUpload.textContent = T('set.fl.font.upload');
      }
    });

    rebuildFontSelect();
    rebuildFontList();

    /* ---------- 播放 ---------- */
    body.appendChild(section('set.nav.playback'));

    // 读盘后行为
    const row1 = document.createElement('div');
    row1.className = 'set-row';
    row1.appendChild(labelBlock('set.play.afterRead.label', 'set.play.afterRead.desc'));
    const radios = document.createElement('div');
    radios.className = 'radio-group';
    const mkRadio = (value, text) => {
      const lab = document.createElement('label');
      lab.className = 'radio';
      const inp = document.createElement('input');
      inp.type = 'radio';
      inp.name = 'autoPlay';
      inp.value = String(value);
      inp.checked = data.autoPlay === value;
      inp.addEventListener('change', async () => {
        data.autoPlay = value;
        await window.cd.invoke('settings:set', { autoPlay: value });
      });
      const span = document.createElement('span');
      span.textContent = text;
      lab.appendChild(inp);
      lab.appendChild(span);
      return lab;
    };
    radios.appendChild(mkRadio(true, T('set.play.afterRead.auto')));
    radios.appendChild(mkRadio(false, T('set.play.afterRead.library')));
    row1.appendChild(radios);
    body.appendChild(row1);

    /* ---------- 播放引擎（v9：MCI / RAW 切换 + 默认引擎偏好） ---------- */
    const rowEng = document.createElement('div');
    rowEng.className = 'set-row';
    rowEng.appendChild(labelBlock('set.play.engine.label', 'set.play.engine.desc'));
    const segEng = document.createElement('div');
    segEng.className = 'seg-group';
    segEng.setAttribute('role', 'radiogroup');
    const engHint = document.createElement('div');
    engHint.className = 'set-hint';
    const engName = (e) => (e === 'raw' ? 'RAW' : e === 'mci' ? 'MCI'
      : e === 'demo' ? T('set.play.engine.demo') : T('set.play.engine.notStarted'));
    const refreshEngHint = () => {
      const cur = App.state && App.state.engine;
      engHint.textContent = cur ? T('set.play.engine.current', { name: engName(cur) }) : '';
    };
    const mkEng = (value, text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + ((data.enginePreference || 'auto') === value ? ' on' : '');
      b.dataset.eng = value;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String((data.enginePreference || 'auto') === value));
      const t = document.createElement('span');
      t.textContent = text;
      b.appendChild(t);
      b.addEventListener('click', async () => {
        const btns = segEng.querySelectorAll('.seg-btn');
        for (let i = 0; i < btns.length; i++) {
          const on = btns[i].dataset.eng === value;
          btns[i].classList.toggle('on', on);
          btns[i].setAttribute('aria-checked', String(on));
        }
        data.enginePreference = value;
        if (App.state.settings) App.state.settings.enginePreference = value;
        await window.cd.invoke('settings:set', { enginePreference: value });
        if (value === 'auto') {
          Toast(T('set.play.engine.toastAuto'));
          return;
        }
        // 立即切换（有碟在播时才可能成功；没碟时偏好已在下次读碟时生效）
        try {
          const r = await window.cd.invoke('cd:switch-engine', value);
          if (r && r.ok) {
            Toast(T('set.play.engine.toastSwitched', { name: value === 'raw' ? 'RAW' : 'MCI' }));
          } else if (r && r.error === 'no-disc') {
            Toast(T('set.play.engine.toastNoDisc'));
          } else if (r && r.error === 'start-failed') {
            Toast(T('set.play.engine.toastStartFail', { name: value === 'raw' ? 'RAW' : 'MCI' }));
          } else {
            Toast(T('set.play.engine.toastFail', { err: (r && r.error) }));
          }
        } catch (e) {
          Toast(T('set.play.engine.toastFail', { err: (e && e.message) }));
        }
        refreshEngHint();
      });
      return b;
    };
    segEng.appendChild(mkEng('auto', T('set.play.engine.auto')));
    segEng.appendChild(mkEng('raw', 'RAW'));
    segEng.appendChild(mkEng('mci', 'MCI'));
    const engCtl = document.createElement('div');
    engCtl.className = 'set-ctl';
    engCtl.appendChild(segEng);
    engCtl.appendChild(engHint);
    rowEng.appendChild(engCtl);
    refreshEngHint();
    body.appendChild(rowEng);

    // 默认音量
    const row2 = document.createElement('div');
    row2.className = 'set-row';
    row2.appendChild(labelBlock('set.play.volume.label', 'set.play.volume.desc'));
    const volWrap = document.createElement('div');
    volWrap.className = 'vol-wrap';
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'slider';
    vol.min = 0;
    vol.max = 100;
    vol.style.minWidth = '150px';
    vol.value = String(Math.round((data.defaultVolume || 0.7) * 100));
    vol.addEventListener('change', async () => {
      const v = parseInt(vol.value, 10) / 100;
      data.defaultVolume = v;
      await window.cd.invoke('settings:set', { defaultVolume: v });
      App.setVolume(v);
    });
    volWrap.appendChild(vol);
    row2.appendChild(volWrap);
    body.appendChild(row2);

    // 弹出光盘后的行为
    const rowEject = document.createElement('div');
    rowEject.className = 'set-row';
    const lEject = labelBlock('set.play.eject.label', 'set.play.eject.desc');
    rowEject.appendChild(lEject);
    const sw = document.createElement('button');
    sw.className = 'switch' + (data.ejectReturnToScene !== false ? ' on' : '');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(data.ejectReturnToScene !== false));
    sw.setAttribute('aria-label', T('set.play.eject.label'));
    sw.innerHTML = '<span class="switch-knob"></span>';
    sw.addEventListener('click', async () => {
      const next = !sw.classList.contains('on');
      sw.classList.toggle('on', next);
      sw.setAttribute('aria-checked', String(next));
      data.ejectReturnToScene = next;
      if (App.state.settings) App.state.settings.ejectReturnToScene = next;
      await window.cd.invoke('settings:set', { ejectReturnToScene: next });
    });
    rowEject.appendChild(sw);
    body.appendChild(rowEject);

    /* ---------- 系统 ---------- */
    body.appendChild(section('set.nav.system'));

    // 开机自动启动（默认关，v10.5）
    const rowLaunch = document.createElement('div');
    rowLaunch.className = 'set-row';
    rowLaunch.appendChild(labelBlock('set.sys.autoLaunch.label', 'set.sys.autoLaunch.desc'));
    rowLaunch.appendChild(toggle(data.autoLaunch === true, async (next) => {
      data.autoLaunch = next;
      if (App.state.settings) App.state.settings.autoLaunch = next;
      // 设置落盘（权威态）+ 同步 OS 启动项（即时生效）
      await window.cd.invoke('settings:set', { autoLaunch: next }).catch(() => { /* 忽略 */ });
      await window.cd.invoke('app:set-auto-launch', { on: next }).catch(() => { /* 忽略 */ });
    }));
    body.appendChild(rowLaunch);

    // 进入软件时自动全屏（默认关，v10.5）
    const rowAutoFs = document.createElement('div');
    rowAutoFs.className = 'set-row';
    rowAutoFs.appendChild(labelBlock('set.sys.autoFs.label', 'set.sys.autoFs.desc'));
    rowAutoFs.appendChild(toggle(data.autoFullscreen === true, async (next) => {
      data.autoFullscreen = next;
      if (App.state.settings) App.state.settings.autoFullscreen = next;
      await window.cd.invoke('settings:set', { autoFullscreen: next }).catch(() => { /* 忽略 */ });
    }));
    body.appendChild(rowAutoFs);

    // 系统媒体控件（SMTC）
    const rowSmtc = document.createElement('div');
    rowSmtc.className = 'set-row';
    rowSmtc.appendChild(labelBlock('set.sys.smtc.label', 'set.sys.smtc.desc'));
    const swSmtc = document.createElement('button');
    swSmtc.className = 'switch' + (data.smtcEnabled !== false ? ' on' : '');
    swSmtc.type = 'button';
    swSmtc.setAttribute('role', 'switch');
    swSmtc.setAttribute('aria-checked', String(data.smtcEnabled !== false));
    swSmtc.setAttribute('aria-label', T('set.sys.smtc.label'));
    swSmtc.innerHTML = '<span class="switch-knob"></span>';
    swSmtc.addEventListener('click', async () => {
      const next = !swSmtc.classList.contains('on');
      swSmtc.classList.toggle('on', next);
      swSmtc.setAttribute('aria-checked', String(next));
      data.smtcEnabled = next;
      if (App.setSmtcEnabled) App.setSmtcEnabled(next);
      await window.cd.invoke('settings:set', { smtcEnabled: next });
    });
    rowSmtc.appendChild(swSmtc);
    body.appendChild(rowSmtc);

    // 诊断日志（排查读盘/播放问题时把 debug.log 发回即可）
    const rowLog = document.createElement('div');
    rowLog.className = 'set-row';
    rowLog.appendChild(labelBlock('set.sys.log.label', 'set.sys.log.desc'));
    const openLog = document.createElement('button');
    openLog.className = 'panel-btn';
    openLog.type = 'button';
    openLog.textContent = T('set.sys.log.open');
    openLog.addEventListener('click', async () => {
      try { await window.cd.invoke('app:open-logs'); } catch (e) { /* 忽略 */ }
    });
    rowLog.appendChild(openLog);
    body.appendChild(rowLog);

    /* ---------- 快捷键 ---------- */
    body.appendChild(section('set.nav.keys'));
    const keys = [
      [T('set.keys.kbdPlay'), 'set.keys.playPause'],
      ['← / →', 'set.keys.prevNext'],
      ['↑ / ↓', 'set.keys.volume'],
      ['L', 'set.keys.tab']
    ];
    for (const k of keys) {
      const row = document.createElement('div');
      row.className = 'set-row';
      const kbd = document.createElement('kbd');
      kbd.className = 'kbd';
      kbd.textContent = k[0];
      const desc = document.createElement('div');
      desc.className = 'set-desc';
      desc.style.marginTop = '0';
      desc.textContent = T(k[1]);
      row.appendChild(kbd);
      row.appendChild(desc);
      body.appendChild(row);
    }
    const rowTip = document.createElement('div');
    rowTip.className = 'set-row';
    rowTip.appendChild(labelBlock('set.keys.flow.label', 'set.keys.flow.desc'));
    body.appendChild(rowTip);

    /* ---------- 关于 ---------- */
    body.appendChild(section('set.nav.about'));
    const row3 = document.createElement('div');
    row3.className = 'set-row';
    row3.appendChild(labelBlock('set.about.name', 'set.about.desc'));
    body.appendChild(row3);

    /* 协议行（v10.11）：GPLv3 要求在程序里给出显著声明，
       这里随界面语言本地化；协议全文随安装包一起分发（resources/LICENSE.txt） */
    const rowLic = document.createElement('div');
    rowLic.className = 'set-row';
    rowLic.appendChild(labelBlock('set.about.license.label', 'set.about.license.desc'));
    body.appendChild(rowLic);

    /* ---------- 双栏重组（v10.9.2）：左分类导航 + 右设置内容 ----------
       上面所有行的构建逻辑一行未动——body 里此时就是
       [.set-section 标题, 行, 行, …, .set-section 标题, …] 的顺序结构，
       这里按 .set-section 切分成若干分类页，套上左导航。
       新增分类 = 在上面加一个 section() + 在 NAV 里登记一行。 */
    const pages = [];
    let curPage = null;
    for (const node of Array.from(body.children)) {
      if (node.classList && node.classList.contains('set-section')) {
        curPage = document.createElement('div');
        curPage.className = 'set-page';
        curPage.appendChild(node);
        pages.push(curPage);
      } else if (curPage) {
        curPage.appendChild(node);
      }
    }

    const nav = document.createElement('div');
    nav.className = 'set-nav';
    const content = document.createElement('div');
    content.className = 'set-content';
    const navItems = [];

    function switchPage(i) {
      for (let k = 0; k < navItems.length; k++) navItems[k].classList.toggle('on', k === i);
      for (let k = 0; k < pages.length; k++) pages[k].classList.toggle('on', k === i);
      content.scrollTop = 0;
      activePage = i;
    }

    NAV.forEach((cat, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'set-nav-item' + (i === activePage ? ' on' : '');
      item.innerHTML = cat.icon;
      const t = document.createElement('span');
      t.textContent = T(cat.key);
      item.appendChild(t);
      item.addEventListener('click', () => switchPage(i));
      nav.appendChild(item);
      navItems.push(item);
      const page = pages[i];
      if (page) {
        page.classList.toggle('on', i === activePage);
        content.appendChild(page);
      }
    });

    const layout = document.createElement('div');
    layout.className = 'set-layout';
    layout.appendChild(nav);
    layout.appendChild(content);
    panel.appendChild(layout);
    el.appendChild(panel);
    if (navItems[activePage]) {
      for (let k = 0; k < navItems.length; k++) navItems[k].classList.toggle('on', k === activePage);
      for (let k = 0; k < pages.length; k++) pages[k].classList.toggle('on', k === activePage);
    }
  }

  /* ---------- 小组件 ---------- */

  /** 分类标题（传 i18n 键） */
  function section(key) {
    const d = document.createElement('div');
    d.className = 'set-section';
    d.textContent = T(key);
    return d;
  }

  /** 标题 + 说明（均传 i18n 键） */
  function labelBlock(labelKey, descKey) {
    const box = document.createElement('div');
    const l = document.createElement('div');
    l.className = 'set-label';
    l.textContent = T(labelKey);
    const d = document.createElement('div');
    d.className = 'set-desc';
    d.textContent = T(descKey);
    box.appendChild(l);
    box.appendChild(d);
    return box;
  }

  /** 外观/动效类开关（.toggle，与 .switch 同款外观） */
  function toggle(on, onChange) {
    const b = document.createElement('button');
    b.className = 'toggle' + (on ? ' on' : '');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', String(!!on));
    b.innerHTML = '<span class="toggle-knob"></span>';
    b.addEventListener('click', async () => {
      const next = !b.classList.contains('on');
      b.classList.toggle('on', next);
      b.setAttribute('aria-checked', String(next));
      if (typeof onChange === 'function') await onChange(next);
    });
    return b;
  }

  function closePanel() {
    el.innerHTML = '';
    el.classList.add('hidden');
  }

  /** 面板是否开着（语言切换 / 外部刷新时用） */
  function isOpen() {
    return !el.classList.contains('hidden');
  }

  /**
   * 语言切换后重建面板。
   * 保留当前所在分类页（activePage），否则用户改完语言会被弹回"外观"。
   */
  function refresh() {
    if (!isOpen()) return;
    open();
  }

  return { open, close: closePanel, refresh, isOpen };
})();

/* 语言切换时 relayoutLang 用 window 也拿得到（顶层 const 不会自动挂到 window） */
window.SettingsPanel = SettingsPanel;
