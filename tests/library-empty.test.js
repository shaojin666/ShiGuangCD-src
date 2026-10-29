'use strict';
/* ============================================================
   tests/library-empty.test.js —— 音乐库空态行为级自检（jsdom）
   ------------------------------------------------------------
   背景（v10.7 交付后用户实测瑕疵1）：
     搜索无结果时背景显示"无结果"空态，但关闭搜索后空态残留不消失，
     且每触发一次无结果就多叠一个空态，导致界面背景混乱。
   根因：rebuildItems() 里空态 .lib-empty 挂在 container（#lib-flow 视口）
     上，而清理逻辑只清 flowRow（container 的子元素），旧空态永驻。
   本测试驱动**真实的** renderer/js/library.js（setStyle→render→refresh
   →rebuildItems 全链路），断言：
     1. 有数据 → 无空态、条目正常渲染
     2. 空库 → 恰好 1 个空态
     3. 空库反复 refresh → 空态不叠加
     4. 搜索无匹配 → 1 个空态；再次无匹配 → 不叠加
     5. 关闭搜索（Esc）→ 空态消失、条目恢复、面板收起
     6. 有匹配 → 无空态且正确过滤
     7. grid 模式同样不叠加
   运行：node tests/library-empty.test.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

let JSDOM;
try { JSDOM = require('jsdom').JSDOM; } catch (e) {
  console.log('[skip] 需要 jsdom：npm i jsdom');
  process.exit(0);
}

const LIBRARY_JS = path.join(__dirname, '..', 'renderer', 'js', 'library.js');
/* library.js 的文案走 i18n（T()），词典必须先在同一作用域内求值 */
const I18N_JS = path.join(__dirname, '..', 'renderer', 'js', 'i18n.js');

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n# ' + name); }
const settle = (ms) => new Promise((r) => setTimeout(r, ms || 40));

/* ---------- 最小 window 环境 ---------- */
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="page-library" class="page"></div></body></html>',
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;

let CURRENT_ITEMS = [];
window.cd = {
  invoke: async (ch) => (ch === 'meta:list' ? CURRENT_ITEMS : null),
  on: () => {},
};
window.__toasts = [];
window.Toast = (msg) => { window.__toasts.push(msg); };
window.App = {
  state: { page: 'library', settings: {}, current: null },
  emit: () => {}, on: () => {}, requestDisc: () => {},
};
window.Album = null;

(async () => {
  const libSrc = fs.readFileSync(LIBRARY_JS, 'utf8');
  const i18nSrc = fs.readFileSync(I18N_JS, 'utf8');
  // Library 是模块级 const，补一句挂到 window 上取用。
  // i18n 与 library 合成一次 eval：T / I18n 是 const 声明，
  // 分开 eval 拿不到（与 fl-stage.test.js 同法）。
  window.eval(i18nSrc + '\n;\n' + libSrc + '\n;window.Library = Library;');
  const Library = window.Library;

  section('音乐库空态：创建 / 清理 / 不叠加（v10.7 瑕疵1 回归）');

  ok('library.js 导出 render / refresh / setStyle',
    !!Library && typeof Library.render === 'function' &&
    typeof Library.refresh === 'function' && typeof Library.setStyle === 'function');

  const DATA = () => ([
    { signature: 's1', album: 'A', artist: '甲', year: 2001, tracks: [{ title: 't1', artist: '甲' }] },
    { signature: 's2', album: 'B', artist: '乙', year: 2002, tracks: [] },
  ]);

  /* ---- 场景1：有数据 + flow 模式 ---- */
  CURRENT_ITEMS = DATA();
  Library.setStyle('flow');
  await settle(80); // render() 内的 refresh 是异步的，等它落盘

  const container = window.document.getElementById('lib-flow');
  ok('render 重建出 #lib-flow / .lib-flow-row',
    !!container && !!container.querySelector('.lib-flow-row'));
  const countEmpties = () => container.querySelectorAll('.lib-empty').length;
  const countCards = () => container.querySelectorAll('.lib-flow-item, .lib-card').length;

  ok('有数据 → 无空态', countEmpties() === 0, countEmpties());
  ok('有数据 → 渲染出 2 个条目', countCards() === 2, countCards());

  /* ---- 场景2/3：空库恰好一个空态、反复 refresh 不叠加 ---- */
  CURRENT_ITEMS = [];
  await Library.refresh();
  ok('空库 → 恰好 1 个空态', countEmpties() === 1, countEmpties());
  await Library.refresh();
  await Library.refresh();
  await Library.refresh();
  ok('空库重复 refresh → 仍只有 1 个空态（不叠加）', countEmpties() === 1, countEmpties());

  /* ---- 场景4：搜索无匹配 → 关闭搜索后空态消失 ---- */
  CURRENT_ITEMS = DATA();
  await Library.refresh();
  ok('恢复有数据 → 空态消失、条目回来', countEmpties() === 0 && countCards() === 2,
    { e: countEmpties(), c: countCards() });

  const input = window.document.getElementById('lib-search-input');
  ok('搜索输入框已挂载', !!input);
  if (!input) {
    console.log('\n' + (fails ? fails + ' 个断言未通过' : 'ALL PASS'));
    process.exit(fails ? 1 : 0);
  }

  const type = (v) => {
    input.value = v;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const esc = () => input.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  type('zzz-no-match');
  await settle();
  ok('无结果搜索 → 恰好 1 个空态', countEmpties() === 1, countEmpties());
  ok('无结果搜索 → 条目清空', countCards() === 0, countCards());
  ok('无结果搜索 → 计数显示 0 / 2',
    (window.document.getElementById('lib-count').textContent || '').indexOf('0 / 2') === 0);

  type('another-miss');
  await settle();
  ok('再次无结果 → 仍只有 1 个空态（不叠加）', countEmpties() === 1, countEmpties());

  esc();
  await settle();
  ok('关闭搜索 → 空态消失', countEmpties() === 0, countEmpties());
  ok('关闭搜索 → 条目恢复 2 张', countCards() === 2, countCards());
  ok('关闭搜索 → 搜索面板收起',
    window.document.getElementById('lib-search-panel').classList.contains('hidden'));

  type('甲');
  await settle();
  ok('有匹配 → 无空态且过滤出 1 张', countEmpties() === 0 && countCards() === 1,
    { e: countEmpties(), c: countCards() });

  esc();
  await settle();
  ok('再次关闭 → 无空态、恢复 2 张', countEmpties() === 0 && countCards() === 2);

  /* ---- 场景5：grid 模式同样不叠加 ---- */
  Library.setStyle('grid');
  await settle(80);
  const grid = window.document.getElementById('lib-grid');
  const gEmpty = () => grid.querySelectorAll('.lib-empty').length;
  CURRENT_ITEMS = [];
  await Library.refresh();
  ok('grid 空库 → 1 个空态', gEmpty() === 1, gEmpty());
  await Library.refresh();
  await Library.refresh();
  ok('grid 重复 refresh → 仍 1 个空态', gEmpty() === 1, gEmpty());

  console.log('\n' + (fails ? fails + ' 个断言未通过' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('  FAIL 脚本异常 → ' + (e && e.stack || e));
  process.exit(1);
});
