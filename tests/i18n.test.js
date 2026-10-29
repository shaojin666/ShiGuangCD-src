'use strict';
/* ============================================================
   tests/i18n.test.js —— 多语言（i18n）自检
   ------------------------------------------------------------
   覆盖：
     1) 五份词典的键完全对齐（数量 / 键集合 / 占位符 / 非空）
     2) 取词与回退链：当前语言 → 简体中文 → key 本身
     3) 语言 id 归一化（en-US / zh_CN / zh-Hant / 未知值）
     4) <html lang> 随语言切换（zh-TW → zh-Hant，给 CSS 与朗读器用）
     5) 静态 HTML 上的 data-i18n* 全部能在词典里查到（防拼错键）
     6) 切换语言后静态节点文案真的变了
     7) 订阅广播（onChange）只在该变的时候触发
     8) 静态契约：设置页有语言下拉、首屏渲染前定语言、切换后各面板重排

   运行：node tests/i18n.test.js（需要 jsdom，缺失自动跳过）
   ============================================================ */

const fs = require('fs');
const path = require('path');
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; } catch (e) {
  console.log('[skip] 需要 jsdom：npm i jsdom');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n# ' + name); }

const indexHtml = read('renderer/index.html');
const floatHtml = read('renderer/floating.html');
const i18nSrc = read('renderer/js/i18n.js');
const IDS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ru'];

/* ---------- 用 index.html 建真实 DOM，只注入 i18n.js ---------- */
const dom = new JSDOM(indexHtml, {
  url: 'file://' + path.join(ROOT, 'renderer', 'index.html'),
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const w = dom.window;
w.eval(i18nSrc);
const I18n = w.I18n;
const dict = I18n.dict;

/* ================================================================
 * 1. 词典对齐
 * ================================================================ */
section('词典对齐：五份词条必须一一对应');

const baseKeys = Object.keys(dict['zh-CN']);
ok('简体中文是基准语言且有词条', baseKeys.length > 400, baseKeys.length);
ok('五份词典都在', IDS.every((id) => dict[id] && typeof dict[id] === 'object'));

for (const id of IDS) {
  const keys = Object.keys(dict[id]);
  ok(id + ' 词条数与简体中文一致（' + baseKeys.length + '）', keys.length === baseKeys.length, keys.length);
  const missing = baseKeys.filter((k) => !(k in dict[id]));
  const extra = keys.filter((k) => !(k in dict['zh-CN']));
  ok(id + ' 无缺失键', missing.length === 0, missing.slice(0, 5));
  ok(id + ' 无多余键', extra.length === 0, extra.slice(0, 5));
}

for (const id of IDS) {
  const empty = baseKeys.filter((k) => typeof dict[id][k] !== 'string' || !dict[id][k].trim());
  ok(id + ' 所有词条非空', empty.length === 0, empty.slice(0, 5));
}

/* 占位符必须一致：某语言少了 {n}，界面上就会丢信息 */
const ph = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
const phBad = [];
for (const k of baseKeys) {
  const want = ph(dict['zh-CN'][k]);
  for (const id of IDS) {
    if (ph(dict[id][k]) !== want) phBad.push(id + ':' + k);
  }
}
ok('占位符 {x} 在各语言间一致', phBad.length === 0, phBad.slice(0, 8));

/* 键命名空间有序：不该出现空段或裸键 */
const weird = baseKeys.filter((k) => !/^[a-zA-Z][\w-]*(\.[\w-]+)+$/.test(k));
ok('键名都是 a.b.c 形式', weird.length === 0, weird.slice(0, 5));

/* ================================================================
 * 2. 取词与回退
 * ================================================================ */
section('取词 / 回退链');

I18n.setLang('zh-CN', { silent: true });
ok('T 取简体中文', w.T('common.cancel') === '取消', w.T('common.cancel'));
ok('占位符替换', w.T('common.tracks', { n: 12 }) === '12 首', w.T('common.tracks', { n: 12 }));
ok('多占位符替换',
  w.T('common.discOf', { n: 2, m: 3 }) === '第 2 碟，共 3 碟',
  w.T('common.discOf', { n: 2, m: 3 }));
ok('缺变量时保留 {x} 原样', w.T('common.tracks', {}) === '{n} 首', w.T('common.tracks', {}));
ok('未知键回退为键本身', w.T('no.such.key') === 'no.such.key', w.T('no.such.key'));
ok('null 键返回空串', w.T(null) === '', w.T(null));
ok('has() 对未知键为 false', I18n.has('no.such.key') === false);
ok('has() 对已知键为 true', I18n.has('common.cancel') === true);

/* 新增一门语言即使漏译了某键，也会回退到简体中文而不是显示键名 */
dict.en.__probe = undefined;
delete dict.en['fl.panel.title'];
I18n.setLang('en', { silent: true });
ok('某语言缺项 → 回退简体中文', w.T('fl.panel.title') === '歌词主题', w.T('fl.panel.title'));
dict.en['fl.panel.title'] = 'Lyric theme';
ok('补回后立刻生效', w.T('fl.panel.title') === 'Lyric theme', w.T('fl.panel.title'));

/* ================================================================
 * 3. 语言 id 归一化
 * ================================================================ */
section('语言 id 归一化');

const cases = [
  ['zh-CN', 'zh-CN'], ['zh_CN', 'zh-CN'], ['zh', 'zh-CN'], ['zh-Hans', 'zh-CN'],
  ['zh-TW', 'zh-TW'], ['zh-Hant', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh_MO', 'zh-TW'],
  ['en', 'en'], ['en-US', 'en'], ['EN-gb', 'en'],
  ['ja', 'ja'], ['ja-JP', 'ja'],
  ['ru', 'ru'], ['ru-RU', 'ru'],
  ['fr', 'zh-CN'], ['', 'zh-CN'], [null, 'zh-CN'], [123, 'zh-CN']
];
for (const [input, want] of cases) {
  const got = I18n.setLang(input, { silent: true });
  ok('normalize(' + JSON.stringify(input) + ') → ' + want, got === want, got);
}

/* ================================================================
 * 4. <html lang>
 * ================================================================ */
section('<html lang> 跟随语言');

const htmlLangWant = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-Hant', en: 'en', ja: 'ja', ru: 'ru' };
for (const id of IDS) {
  I18n.setLang(id, { silent: true });
  const got = w.document.documentElement.getAttribute('lang');
  ok(id + ' → html[lang]=' + htmlLangWant[id], got === htmlLangWant[id], got);
}

/* ================================================================
 * 5. 静态 HTML 上的 data-i18n* 必须都能查到
 * ================================================================ */
section('静态标注与词典一致（防拼错键）');

function collectAttrs(html) {
  const out = [];
  const re = /data-i18n(?:-title|-aria|-placeholder)?="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
const idxKeys = collectAttrs(indexHtml);
const floatKeys = collectAttrs(floatHtml);
ok('index.html 有静态标注', idxKeys.length >= 15, idxKeys.length);
ok('floating.html 有静态标注', floatKeys.length >= 8, floatKeys.length);
const badIdx = idxKeys.filter((k) => !I18n.has(k));
const badFloat = floatKeys.filter((k) => !I18n.has(k));
ok('index.html 的键全部存在', badIdx.length === 0, badIdx);
ok('floating.html 的键全部存在', badFloat.length === 0, badFloat);

/* ================================================================
 * 6. 切换语言后静态节点文案真的变了
 * ================================================================ */
section('切换语言后静态节点重排');

const navLib = w.document.getElementById('nav-library');
const navNp = w.document.getElementById('nav-nowplaying');

I18n.setLang('zh-CN', { silent: true });
const zhLib = navLib.textContent;
const zhNp = navNp.textContent;

I18n.setLang('en', { silent: true });
const enLib = navLib.textContent;
const enNp = navNp.textContent;
ok('导航按钮文案随语言变化', enLib !== zhLib && enNp !== zhNp, [zhLib, enLib]);
ok('英文导航文案正确', enLib === 'Library' && enNp === 'Now Playing', [enLib, enNp]);
ok('英文导航里不含中日韩字符', !/[\u4e00-\u9fff]/.test(enLib + enNp), [enLib, enNp]);

I18n.setLang('ja', { silent: true });
ok('日文导航文案正确', navLib.textContent === 'ライブラリ', navLib.textContent);

I18n.setLang('ru', { silent: true });
ok('俄文导航文案与英文不同', navLib.textContent !== enLib && navLib.textContent.length > 0, navLib.textContent);

I18n.setLang('zh-TW', { silent: true });
ok('繁体导航文案与简体不同', navLib.textContent !== zhLib, [zhLib, navLib.textContent]);

/* title / aria 也一起换 */
const btnSettings = w.document.getElementById('btn-settings');
I18n.setLang('en', { silent: true });
const enTitle = btnSettings.title;
I18n.setLang('zh-CN', { silent: true });
ok('按钮 title 随语言变化', enTitle && enTitle !== btnSettings.title, [enTitle, btnSettings.title]);
ok('按钮 aria-label 也在词典里', !!btnSettings.getAttribute('aria-label'));

/* ================================================================
 * 7. 订阅广播
 * ================================================================ */
section('onChange 广播');

let hits = 0;
let last = '';
I18n.onChange((id) => { hits++; last = id; });

I18n.setLang('en');
ok('切换语言触发一次广播', hits === 1 && last === 'en', [hits, last]);
I18n.setLang('en');
ok('同语言重复设置不广播', hits === 1, hits);
I18n.setLang('zh-TW');
ok('再次切换再广播一次', hits === 2 && last === 'zh-TW', [hits, last]);
I18n.setLang('ja', { silent: true });
ok('silent 不广播', hits === 2, hits);

/* ================================================================
 * 8. 静态契约：接入点是否都在
 * ================================================================ */
section('接入点静态契约');

const appJs = read('renderer/js/app.js');
const settingsJs = read('renderer/js/settings.js');
const flStageJs = read('renderer/js/fl-stage.js');
const floatingJs = read('renderer/js/floating.js');

ok('index.html 先加载 i18n.js（其余脚本之后）',
  indexHtml.indexOf('js/i18n.js') > 0 &&
  indexHtml.indexOf('js/i18n.js') < indexHtml.indexOf('js/audio.js'));
ok('floating.html 也加载 i18n.js', /js\/i18n\.js/.test(floatHtml));

ok('app.js 设置默认值含 lang',
  /lang: 'zh-CN'/.test(appJs));
ok('首屏渲染前就定语言（I18n.setLang 在 FlStage.init 之前）',
  appJs.indexOf('I18n.setLang(') > 0 &&
  appJs.indexOf('I18n.setLang(') < appJs.indexOf('FlStage.init('));
ok('App.setLang 落盘 lang', /settings:set', \{ lang: next \}|settings:set', \{ lang:/.test(appJs));
ok('relayoutLang 汇总各面板重排',
  /function relayoutLang\(\)/.test(appJs) &&
  /FlStage\.applyLang/.test(appJs) &&
  /NowPlaying\.rerender/.test(appJs) &&
  /Library\.render/.test(appJs) &&
  /Album\.applyLang/.test(appJs) &&
  /SettingsPanel\.refresh/.test(appJs) &&
  /Edit\.refresh/.test(appJs));

ok('设置页有语言下拉 #set-lang', /set-lang/.test(settingsJs) && /I18n\.list\(\)/.test(settingsJs));
ok('语言下拉选项用各语言自己的名字（不翻译）', /op\.textContent = l\.name/.test(settingsJs));
ok('选语言后即时生效并落盘', /App\.setLang\(selLang\.value, true\)/.test(settingsJs));
ok('设置面板重建时保持当前分类页', /activePage/.test(settingsJs));

ok('演出层外壳文案走 i18n（T(fl.backTitle) 等）', /T\('fl\.backTitle'\)/.test(flStageJs));
ok('演出层语言切换原地回填（applyShellText）', /function applyShellText\(\)/.test(flStageJs));
ok('演出层 applyLang 汇总子面板', /FlPanel\.applyLang/.test(flStageJs) && /FlCapsule\.applyLang/.test(flStageJs) && /FlTracks\.applyLang/.test(flStageJs));

ok('悬浮窗接收语言推送（float:lang / float:init.lang）',
  /float:lang/.test(floatingJs) && /applyLang\(cfg\.lang\)/.test(floatingJs));
ok('主进程把语言推给悬浮窗', /setLang\(lang\)/.test(read('main/floating.js')) &&
  /patch\.lang/.test(read('main/ipc.js')));
ok('preload 放行 float:lang', /'float:lang'/.test(read('preload.js')));
ok('主进程 settings 默认值含 lang', /lang: 'zh-CN'/.test(read('main/index.js')));

/* 主题名 / 参数名统一由 FlThemes 提供，避免三处文案分叉 */
const flThemesJs = read('renderer/js/fl-themes.js');
ok('每个主题都有 nameKey/descKey', /nameKey: 'theme\./.test(flThemesJs) && /descKey: 'theme\./.test(flThemesJs));
ok('参数都有 labelKey', /labelKey: 'theme\./.test(flThemesJs));
ok('FlThemes 暴露 nameOf/descOf/paramLabel',
  /nameOf/.test(flThemesJs) && /descOf/.test(flThemesJs) && /paramLabel/.test(flThemesJs));
const themeIds = ['lumen', 'whisper', 'orbit', 'chorus', 'prism', 'warp', 'halo', 'mirror'];
const missTheme = [];
for (const id of themeIds) {
  for (const k of ['name', 'desc']) {
    if (!I18n.has('theme.' + id + '.' + k)) missTheme.push('theme.' + id + '.' + k);
  }
}
ok('八个主题的名称/描述都在词典里', missTheme.length === 0, missTheme);
const paramKeys = baseKeys.filter((k) => /^theme\.[\w-]+\.p\./.test(k));
ok('主题参数词条齐备（≥ 17 条）', paramKeys.length >= 17, paramKeys.length);

/* 主进程提示（cd:notice）：key 必须都能查到，且都带中文兜底 text */
const cdServiceJs = read('main/cd/cd-service.js');
const noticeCalls = cdServiceJs.match(/_notice\('notice\.[\w.]+',[\s\S]*?\);/g) || [];
const noticeKeys = (cdServiceJs.match(/_notice\('(notice\.[\w.]+)'/g) || [])
  .map((m) => m.replace(/_notice\('/, '').replace(/'$/, ''));
ok('主进程有提示语调用', noticeKeys.length >= 15, noticeKeys.length);
const badNotice = noticeKeys.filter((k) => !I18n.has(k));
ok('主进程提示键全部有词条', badNotice.length === 0, badNotice);
ok('提示语都带中文兜底 text',
  noticeCalls.length === noticeKeys.length &&
  noticeCalls.every((c) => /[\u4e00-\u9fff]/.test(c)),
  noticeCalls.filter((c) => !/[\u4e00-\u9fff]/.test(c)).slice(0, 3));
ok('渲染端按 key 取词（无 key 才用 text）', /ev\.key \? T\(ev\.key, ev\.vars\) : ev\.text/.test(appJs));

/* 恢复简体，避免影响后续断言 */
I18n.setLang('zh-CN', { silent: true });

console.log('\n' + (fails ? fails + ' FAILED' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
