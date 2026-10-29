'use strict';
/* ============================================================
   fl-tracks.js —— 全屏歌词演出层「选歌」面板（v10.9.1）
   ------------------------------------------------------------
   顶栏列表按钮（或快捷键 L）唤出，列出当前专辑全部可播放曲目：
   曲目号 / 歌名 / 时长，当前曲目高亮；点哪行播哪首。
   切歌走 App.playTrack（主界面同一条链路：乐观切轨 + IPC），
   本模块只管"选"，不管"怎么播"。

   数据来源：TOC 为准（曲目数与时长权威），元数据补标题/艺术家；
   两者都没有时显示空态。列表身份（曲目号拼接）不变不重建，
   只更新高亮——换歌是高频操作，不能整表重建。
   ============================================================ */

window.FlTracks = (function () {

  /* ---------- 模块状态 ---------- */
  const S = {
    stage: null, panel: null, listEl: null, countEl: null, emptyEl: null,
    sig: '',            // 列表身份（曲目号拼接）：不变不重建
    cur: -1             // 当前高亮曲目号
  };

  /* ---------- 工具 ---------- */

  function el(tag, cls, html) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  /** 汇总曲目表：TOC 定数与时长，元数据定标题/艺术家 */
  function gather() {
    const out = [];
    let md = null, toc = null;
    try { md = (typeof App !== 'undefined' && App.state) ? App.state.metadata : null; } catch (e) { /* 忽略 */ }
    try { toc = (typeof App !== 'undefined' && App.state) ? App.state.toc : null; } catch (e) { /* 忽略 */ }
    const mdTracks = (md && Array.isArray(md.tracks)) ? md.tracks : [];
    const tocTracks = (toc && Array.isArray(toc.tracks)) ? toc.tracks : [];
    const byNum = {};
    for (const t of mdTracks) if (t && typeof t.number === 'number') byNum[t.number] = t;
    if (tocTracks.length) {
      for (const t of tocTracks) {
        if (!t || t.audio === false) continue;
        const m = byNum[t.number] || {};
        out.push({
          number: t.number,
          title: m.title || T('common.trackNo', { n: t.number }),
          artist: m.artist || '',
          dur: (t.durationSec > 0 ? t.durationSec : (m.durationSec || 0))
        });
      }
    } else if (mdTracks.length) {
      for (const t of mdTracks) {
        if (!t || t.audio === false) continue;
        out.push({ number: t.number, title: t.title || T('common.trackNo', { n: t.number }), artist: t.artist || '', dur: t.durationSec || 0 });
      }
    }
    out.sort((a, b) => a.number - b.number);
    return out;
  }

  function currentTrack() {
    try { return (typeof Transport !== 'undefined') ? (Number(Transport.track) || 1) : 1; } catch (e) { return 1; }
  }

  /* ---------- 构建 ---------- */

  function buildRow(t) {
    const row = el('button', 'fl-track-row');
    row.type = 'button';
    row.dataset.track = String(t.number);

    row.appendChild(el('span', 'fl-track-no', String(t.number).padStart(2, '0')));
    const mid = el('span', 'fl-track-mid');
    mid.appendChild(el('span', 'fl-track-title', t.title));
    if (t.artist) mid.appendChild(el('span', 'fl-track-artist', t.artist));
    row.appendChild(mid);
    row.appendChild(el('span', 'fl-track-dur', t.dur > 0 ? fmt(t.dur) : ''));

    row.addEventListener('click', () => {
      try { if (typeof App !== 'undefined' && typeof App.playTrack === 'function') App.playTrack(t.number); } catch (e) { /* 忽略 */ }
      closePanel();
    });
    return row;
  }

  function build() {
    const panel = el('div', 'fl-tracks hidden');
    panel.id = 'fl-tracks';

    const head = el('div', 'fl-tracks-head');
    head.appendChild(el('span', '', T('fl.tracks')));
    S.countEl = el('span', 'fl-tracks-count', '');
    head.appendChild(S.countEl);
    const close = el('button', 'fl-btn', '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>');
    close.id = 'fl-tracks-close';
    close.type = 'button';
    close.title = T('fl.tracks.close');
    close.setAttribute('aria-label', T('fl.tracks.closeAria'));
    close.addEventListener('click', () => closePanel());
    head.appendChild(close);
    panel.appendChild(head);

    const body = el('div', 'fl-tracks-body');
    S.listEl = el('div', 'fl-track-list');
    body.appendChild(S.listEl);
    S.emptyEl = el('div', 'fl-track-empty', T('np.empty.noTracks'));
    body.appendChild(S.emptyEl);
    panel.appendChild(body);

    return panel;
  }

  /* ---------- 同步 ---------- */

  /** 重建列表（仅在曲目表身份变化时） */
  function rebuild(list) {
    S.listEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const t of list) frag.appendChild(buildRow(t));
    S.listEl.appendChild(frag);
    if (S.countEl) S.countEl.textContent = list.length ? T('fl.tracks.count', { n: list.length }) : '';
    S.emptyEl.classList.toggle('hidden', list.length > 0);
  }

  /** 高亮当前曲目（滚入视野） */
  function markCur() {
    const n = currentTrack();
    if (n === S.cur) return;
    S.cur = n;
    const rows = S.listEl.querySelectorAll('.fl-track-row');
    for (const r of rows) {
      const on = Number(r.dataset.track) === n;
      r.classList.toggle('on', on);
      if (on) {
        try { r.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 忽略 */ }
      }
    }
  }

  function sync() {
    const list = gather();
    const sig = list.map((t) => t.number).join(',');
    if (sig !== S.sig) {
      S.sig = sig;
      S.cur = -1;          // 身份变了：高亮重算
      rebuild(list);
    }
    markCur();
  }

  /* ---------- 开合 ---------- */

  function openPanel() {
    if (!S.panel) return;
    sync();
    S.panel.classList.remove('hidden');
  }
  function closePanel() {
    if (S.panel) S.panel.classList.add('hidden');
  }
  function togglePanel() {
    if (!S.panel) return;
    if (S.panel.classList.contains('hidden')) openPanel();
    else closePanel();
  }
  function isOpen() { return !!S.panel && !S.panel.classList.contains('hidden'); }

  /** 面板外点击关闭（capture，与主题面板 / 播控菜单同名处理器互斥判断） */
  function onDocDown(e) {
    if (!isOpen()) return;
    if (S.panel.contains(e.target)) return;
    const btn = S.stage && S.stage.querySelector('#fl-tracks-btn');
    if (btn && btn.contains(e.target)) return;   // 选歌按钮自己 toggle
    closePanel();
  }

  /**
   * 语言切换后重建（v10.11）：面板骨架与曲目行都含文案，
   * 直接整块重来最省事；S.sig 一并清空，让 sync() 强制重建曲目表。
   */
  function applyLang() {
    if (!S.panel || !S.stage) return;
    const wasOpen = isOpen();
    const fresh = build();
    S.panel.replaceWith(fresh);
    S.panel = fresh;
    S.sig = '';
    S.cur = -1;
    sync();
    if (wasOpen) fresh.classList.remove('hidden');
  }

  /* ---------- 对外 ---------- */

  /**
   * @param {HTMLElement} stage #fl-stage
   */
  function mount(stage) {
    S.stage = stage;
    S.panel = build();
    stage.appendChild(S.panel);
    document.addEventListener('pointerdown', onDocDown, true);
    sync();
    return { toggle: togglePanel, close: closePanel, isOpen, sync, applyLang };
  }

  return { mount, toggle: togglePanel, close: closePanel, isOpen, sync, applyLang };
})();
