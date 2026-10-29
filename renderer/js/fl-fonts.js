'use strict';
/* ============================================================
   fl-fonts.js —— 全屏歌词演出层「字体管理」（渲染端）
   ------------------------------------------------------------
   职责：
   - 恢复持久化的字体偏好（settings.flFont）
   - 系统字体探测（canvas 宽度法 + document.fonts.check 双保险）
   - 自定义字体：上传（fl:save-font）/ 删除（fl:delete-font）/
     按需读取 dataURL（fl:read-font）并注入 @font-face
   - 把完整字体链写进 #fl-stage 的 --fl-font（fl-stage.css 的
     .fl-line font-family 消费它；删变量即回 CSS 默认链）

   字体链组装策略：用户选择永远排在默认链**前面**（拼写变异的
   字体名后面还有 MiSans/PingFang 等兜底），CSS 侧 var() 的
   回退值与 JS 侧 DEFAULT_CHAIN 保持一致。

   @font-face 的 font-family 用主进程下发的唯一族名
   （"FlFont-<id>"），与用户显示名解耦——两个文件都叫「思源黑体」
   也不会撞名。
   ============================================================ */

window.FlFonts = (function () {

  /* 与 fl-stage.css 中 var(--fl-font, ...) 的回退链逐字一致 */
  const DEFAULT_CHAIN = '"MiSans","HarmonyOS Sans SC","PingFang SC",'
    + '"Microsoft YaHei UI","Segoe UI Variable Display",system-ui,sans-serif';

  /* 系统字体候选（探测命中的才出现在设置下拉里）。
     顺序即下拉顺序：中文优先。 */
  const SYSTEM_CANDIDATES = [
    'MiSans', 'HarmonyOS Sans SC', 'PingFang SC', 'Microsoft YaHei UI',
    'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', 'SourceHanSansSC',
    'SimHei', 'SimSun', 'KaiTi', 'FangSong',
    'Segoe UI Variable Display', 'Segoe UI', 'Arial', 'Georgia', 'Verdana',
    'Tahoma', 'Consolas', 'Times New Roman'
  ];

  const S = {
    stage: null,          /* #fl-stage（可能尚未构建，延迟取） */
    custom: [],           /* [{id,name,family,ext,size}] */
    current: null,        /* null = 默认链 | {kind,name,id?} */
    faces: {},            /* family → 已注入的 <style>（避免重复读盘） */
    sysProbe: null,       /* 系统字体探测结果缓存 */
    listeners: []         /* 偏好变化订阅（设置面板刷新用） */
  };

  /* ---------- 基础 ---------- */

  function stageEl() {
    if (!S.stage) S.stage = document.getElementById('fl-stage');
    return S.stage;
  }

  function persist(spec) {
    try {
      if (window.cd && typeof window.cd.invoke === 'function') {
        window.cd.invoke('settings:set', { flFont: spec }).catch(() => { /* 忽略 */ });
      }
    } catch (e) { /* jsdom / 测试环境没有 cd */ }
  }

  function onChange() {
    for (const fn of S.listeners.slice()) {
      try { fn(S.current); } catch (e) { /* 忽略 */ }
    }
  }

  /** 族名净化：剥引号/反斜杠/换行，防 CSS 注入 */
  function safeName(name) {
    return String(name || '').replace(/["'\\<>\r\n]/g, '').trim().slice(0, 60);
  }

  /** 组装完整字体链：用户选择置前，默认链兜底 */
  function chainOf(spec) {
    if (!spec || !spec.name) return DEFAULT_CHAIN;
    return '"' + safeName(spec.name) + '",' + DEFAULT_CHAIN;
  }

  /* ---------- 系统字体探测 ---------- */

  /**
   * canvas 宽度法：同一串探针文本在 monospace 与「候选字体,monospace」
   * 下量宽，差异 >1px 视为命中。探针串带中文——纯 ASCII 串分不出
   * 中文字体（都会掉到同一个 fallback）。
   * document.fonts.check 作第二意见（对本地字体 Chromium 支持良好）。
   */
  function detectSystem() {
    if (S.sysProbe) return S.sysProbe;
    const out = [];
    try {
      const cv = document.createElement('canvas');
      const c2 = cv.getContext && cv.getContext('2d');
      if (c2) {
        const probe = '汉字测试字体 Wide 00Mmili';
        c2.font = '72px monospace';
        const base = c2.measureText(probe).width;
        for (const name of SYSTEM_CANDIDATES) {
          let hit = false;
          try {
            c2.font = '72px "' + name + '",monospace';
            hit = Math.abs(c2.measureText(probe).width - base) > 1;
          } catch (e) { /* 该次量宽失败，换下一种 */ }
          if (!hit && document.fonts && typeof document.fonts.check === 'function') {
            try { hit = document.fonts.check('72px "' + name + '"'); } catch (e2) { /* 忽略 */ }
          }
          if (hit) out.push(name);
        }
      }
    } catch (e) { /* 探测整体失败 → 空列表，下拉只剩默认项 */ }
    S.sysProbe = out;
    return out;
  }

  /* ---------- 自定义字体 ---------- */

  async function listCustom() {
    try {
      const r = await window.cd.invoke('fl:list-fonts');
      if (r && r.ok && Array.isArray(r.fonts)) S.custom = r.fonts;
    } catch (e) { /* 保持旧列表 */ }
    return S.custom;
  }

  /** dataURL → <style data-fl-font> 注入 @font-face（幂等） */
  function ensureFace(family, dataUrl, ext) {
    if (S.faces[family]) return true;
    const fmt = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[ext] || 'truetype';
    const st = document.createElement('style');
    st.setAttribute('data-fl-font', family);
    st.textContent = '@font-face{font-family:"' + family + '";'
      + 'src:url(' + dataUrl + ') format("' + fmt + '");font-display:swap}';
    document.head.appendChild(st);
    if (!st.sheet) { st.remove(); return false; }   /* CSP 拦下（理论不应发生） */
    S.faces[family] = st;
    return true;
  }

  /**
   * 上传字体文件（设置区「上传字体」按钮调用）。
   * @param {File} file
   * @returns {{ok:boolean, error?:string, font?:object}}
   */
  async function save(file) {
    if (!file) return { ok: false, error: 'no-file' };
    let b64;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      }
      b64 = btoa(bin);
    } catch (e) {
      return { ok: false, error: 'read-failed' };
    }
    try {
      const r = await window.cd.invoke('fl:save-font', {
        name: file.name,
        dataUrl: 'data:' + (file.type || 'font/ttf') + ';base64,' + b64
      });
      if (r && r.ok) {
        await listCustom();
        onChange();
        return r;
      }
      return { ok: false, error: (r && r.error) || 'save-failed' };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /** 删除自定义字体；删的是当前字体时先回默认链 */
  async function remove(id) {
    try {
      const r = await window.cd.invoke('fl:delete-font', { id: id });
      if (r && r.ok) {
        const fam = 'FlFont-' + id;
        if (S.faces[fam]) { S.faces[fam].remove(); delete S.faces[fam]; }
        await listCustom();
        if (S.current && S.current.kind === 'custom' && S.current.id === id) {
          await apply(null);
        }
        onChange();
        return { ok: true };
      }
      return { ok: false, error: (r && r.error) || 'delete-failed' };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /* ---------- 应用 ---------- */

  /**
   * 应用字体偏好。
   * @param {null|{kind:'system'|'custom', name:string, id?:string}} spec
   *        null / 无 name → 回默认链
   * @param {{persist?:boolean}} [opts]
   */
  async function apply(spec, opts) {
    const doPersist = !opts || opts.persist !== false;
    const st = stageEl();

    if (!spec || !spec.name) {
      S.current = null;
      if (st) st.style.removeProperty('--fl-font');
      if (doPersist) persist(null);
      onChange();
      return { ok: true };
    }

    if (spec.kind === 'custom' && spec.id) {
      /* 自定义字体：先拿 dataURL 注入 @font-face，失败则保持原状 */
      try {
        const r = await window.cd.invoke('fl:read-font', { id: spec.id });
        if (!(r && r.ok && r.dataUrl)) {
          return { ok: false, error: (r && r.error) || 'read-failed' };
        }
        const meta = S.custom.find((f) => f.id === spec.id);
        const family = (meta && meta.family) || ('FlFont-' + spec.id);
        if (!ensureFace(family, r.dataUrl, meta && meta.ext)) {
          return { ok: false, error: 'face-blocked' };
        }
        S.current = { kind: 'custom', id: spec.id, name: family };
        if (st) st.style.setProperty('--fl-font', chainOf(S.current));
        if (doPersist) persist(S.current);
        onChange();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    }

    /* 系统字体：直接写链（拼错也有默认链兜底） */
    S.current = { kind: 'system', name: safeName(spec.name) };
    if (st) st.style.setProperty('--fl-font', chainOf(S.current));
    if (doPersist) persist(S.current);
    onChange();
    return { ok: true };
  }

  /* ---------- 对外 ---------- */

  return {
    DEFAULT_CHAIN,
    /** 启动恢复：注入已记住的字体（渲染端 settings 已由 App.state.settings 带过来） */
    async restore(spec) {
      if (spec && typeof spec === 'object' && spec.name) {
        if (spec.kind === 'custom') await listCustom();
        return apply(spec, { persist: false });
      }
      return apply(null, { persist: false });
    },
    apply,
    save,
    remove,
    listCustom,
    detectSystem,
    current: () => S.current,
    customList: () => S.custom,
    onChange: (fn) => { S.listeners.push(fn); },
    safeName
  };
})();
