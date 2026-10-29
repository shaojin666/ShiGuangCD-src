'use strict';
/* ============================================================
   v10.7.test.js —— 用户实测反馈 + 新需求回归
   ------------------------------------------------------------
   覆盖（对应用户本轮反馈）：
     A. TTML 对唱/背景歌词排版（amll 风格）：含对唱→非对唱(主唱)靠右、
        对唱靠左、无居中；bg 跟随所属行；bg 字号跟随歌词缩放
     B. 悬浮歌词：移除整窗长按拖动；主对唱左右区分；bg 词级填充
     C. 专辑详情页：切歌后曲目高亮实时更新（订阅 Transport）
     D. 方形封面：真正方角化（限定 .np-disc）；唱片中心孔开关
     E. 音乐库：右键移除加确认；右下角退碟/弹托盘按钮；左下角搜索
   交付后实测两处小瑕疵的回归（同版本内修复）：
     F. 搜索空态：关闭搜索后残留、无结果反复触发会叠加
        （flow 模式 .lib-empty 挂 container，清理逻辑只清了 flowRow）
     G. 方形封面漏穿：.disc-face/.disc-spin/.disc-hole 是通用类，
        无作用域规则把传输条左下角迷你唱片（.np-mini-disc）也改成了
        "圆容器包方背景"——方形规则全部收窄到 .np-disc

   行为级验证（模型折叠 / 渲染类名 / 悬浮 DOM）分散在：
     - tests/lyrics-parse.test.js（含 v10.7 对唱折叠场景）
     - tests/floating-view.test.js（含 v10.7 duet 分类场景）
     - tests/v10.6.test.js（E/F 段已按 v10.7 反转：has-bg 废弃、
       长按拖动移除）
   本文件补静态契约与跨模块接线。
   ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lyricsModelJs = read('main/metadata/lyrics-model.js');
const lyricsViewJs = read('renderer/js/lyrics-view.js');
const constNowJs = read('renderer/js/nowplaying.js');
const floatRendJs = read('renderer/js/floating.js');
const mainFloatJs = read('main/floating.js');
const albumJs = read('renderer/js/album.js');
const libraryJs = read('renderer/js/library.js');
const appJs = read('renderer/js/app.js');
/* 文案改走 i18n：静态断言同时查「代码用对了键」与「词典里有对应中文」 */
const i18nJs = read('renderer/js/i18n.js');
const settingsJs = read('renderer/js/settings.js');
const mainIndex = read('main/index.js');
const preloadJs = read('preload.js');
const pagesCss = read('renderer/css/pages.css');
const floatCss = read('renderer/css/floating.css');

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n# ' + name); }

/* ================================================================
 * A. 对唱 / 背景歌词排版（amll 风格）
 * ================================================================ */
section('A. 对唱 amll 排版（主右对左 + bg 跟随 + 字号可调）');

/* 模型层：折叠 + 平铺 + 主 agent 判定 */
ok('lyrics-model.js：foldDuetLines 把对唱行折进宿主 bg 并盖 agent',
  /host\.bg\.push\(\{[\s\S]{0,200}?agent: line\.agent/.test(lyricsModelJs));
ok('lyrics-model.js：对唱行自带的 x-bg 平铺进宿主（同 agent，跟随对唱侧）',
  /对唱行自己的背景人声：紧随其后平铺/.test(lyricsModelJs) &&
  /for \(const sub of line\.bg\) \{[\s\S]{0,160}?agent: line\.agent/.test(lyricsModelJs));
ok('lyrics-model.js：analyzeDuet 导出（歌曲级 hasDuet / mainAgent）',
  /analyzeDuet,/.test(lyricsModelJs));
ok('lyrics-model.js：mainAgent 只按主线频次取（bg 不参与竞争，防左右颠倒）',
  /const lineCount = \{\}; \/\/ 仅主线 agent 频次/.test(lyricsModelJs) &&
  /let pool = lineCount;/.test(lyricsModelJs) &&
  /if \(!lineIds\.length\) pool = bgCount;/.test(lyricsModelJs));

/* 渲染层：类名链路 */
ok('lyrics-view.js：load 算 duet 并切换容器 .duet 类',
  /duet = analyzeDuetLocal\(m\);/.test(lyricsViewJs) &&
  /box\.classList\.toggle\('duet', duet\.hasDuet\);/.test(lyricsViewJs));
ok('lyrics-view.js：对唱主行 duet-line、bg 条目 bg-duet / bg-main',
  /if \(duet\.hasDuet && l\.agent && l\.agent !== duet\.mainAgent\)/.test(lyricsViewJs) &&
  /b\.agent !== duet\.mainAgent \? 'bg-duet' : 'bg-main'/.test(lyricsViewJs));
ok('lyrics-view.js：analyzeDuetLocal 与主进程同规则（主线频次定主唱）',
  /function analyzeDuetLocal\(m\) \{/.test(lyricsViewJs) &&
  /let pool = lineCount;/.test(lyricsViewJs));
ok('lyrics-view.js：导出 duetInfo（悬浮窗取对唱结构）',
  /duetInfo/.test(lyricsViewJs));

/* CSS：主右对左 + bg 跟随 */
ok('pages.css：duet 模式行默认靠右、duet-line 靠左（无居中）',
  /\.np-lyrics\.duet \.lrc-line \{ text-align: right; \}/.test(pagesCss) &&
  /\.np-lyrics\.duet \.lrc-line\.duet-line \{ text-align: left; \}/.test(pagesCss));
ok('pages.css：bg 默认靠右、bg-duet 靠左、对唱行的 bg 靠左',
  /\.np-lyrics\.duet \.lrc-line \.lrc-bg \{ text-align: right; \}/.test(pagesCss) &&
  /\.np-lyrics\.duet \.lrc-line \.lrc-bg\.bg-duet \{ text-align: left; \}/.test(pagesCss) &&
  /\.np-lyrics\.duet \.lrc-line\.duet-line \.lrc-bg \{ text-align: left; \}/.test(pagesCss));
ok('pages.css：v10.7 起不再有 has-bg 选择器规则（仅注释提及旧方案）',
  !/\.lrc-line\.has-bg/.test(pagesCss) && !/\.line\.has-bg/.test(floatCss));

/* bg 字号：跟随歌词缩放（v10.7 用户反馈"偏小且不受设置控制"） */
ok('pages.css：.lrc-bg 字号乘 --lyric-scale（0.78 档，比 0.62 大）',
  /\.lrc-bg \{[\s\S]{0,240}?calc\(var\(--lyric-base\) \* 0\.78 \* var\(--lyric-scale\)\)/.test(pagesCss));

/* ================================================================
 * B. 悬浮歌词：撤拖动 + 主对唱区分 + bg 填充
 * ================================================================ */
section('B. 悬浮歌词（v10.7）');

ok('floating.js：bg 词跑 bw-fill 补间（appendBgWords）',
  /function appendBgWords\(container, list, at\) \{/.test(floatRendJs) &&
  /span\.className = 'bw';/.test(floatRendJs));
ok('floating.js：duet-line / bg-duet / bg-main 分类',
  /if \(duet && info\.agent && info\.agent !== duet\.main\) line\.classList\.add\('duet-line'\);/.test(floatRendJs) &&
  /if \(duet\) blk\.classList\.add\(b\.agent && b\.agent !== duet\.main \? 'bg-duet' : 'bg-main'\);/.test(floatRendJs));
ok('floating.js：长按拖动全链路移除（DRAG_HOLD / beginDrag / plate 指针监听）',
  !/DRAG_HOLD_MS/.test(floatRendJs) &&
  !/function beginDrag/.test(floatRendJs) &&
  !/plate\.addEventListener/.test(floatRendJs));
ok('floating.css：duet-line / bg-duet 靠左、bg 默认靠右',
  /\.line\.duet-line \{ text-align: left; \}/.test(floatCss) &&
  /\.line \.bg\.bg-duet \{ text-align: left; \}/.test(floatCss));
ok('floating.css：bg 字号加大（0.72 档）且 bw 有填充动画',
  /\.line \.bg \{[\s\S]{0,200}?calc\(var\(--fs\) \* 0\.72\)/.test(floatCss) &&
  /@keyframes bw-fill/.test(floatCss));
ok('floating.css：body.dragging 已移除',
  !/body\.dragging/.test(floatCss));
ok('main/floating.js：float:move-* 三个 handler 已移除',
  !/ipcMain\.handle\('float:move/.test(mainFloatJs));
ok('preload.js：白名单不再放行 float:move-*',
  !/'float:move/.test(preloadJs));
ok('nowplaying.js：emitLine 带 agent 与 duet 信息',
  /if \(rec\.agent\) info\.agent = rec\.agent;/.test(constNowJs) &&
  /info\.duet = \{ has: true, main: d\.mainAgent \};/.test(constNowJs));
ok('main/floating.js：lastLyrics 白名单带 agent / duet',
  /agent: \(info && typeof info\.agent === 'string'\) \? info\.agent\.slice\(0, 32\) : ''/.test(mainFloatJs) &&
  /duet = \{ has: true, main:/.test(mainFloatJs));

/* ================================================================
 * C. 详情页曲目高亮实时更新
 * ================================================================ */
section('C. 专辑详情页高亮实时更新');

ok('album.js：订阅 Transport，track/status 变化才重建',
  /Transport\.subscribe\(\(\) => \{/.test(albumJs) &&
  /if \(Transport\.track === lastTrack && Transport\.status === lastStatus\) return;/.test(albumJs) &&
  /refreshCurrent\(\);/.test(albumJs));
ok('album.js：renderTracks 渲染时同步 lastTrack / lastStatus 缓存',
  /lastTrack = Transport\.track;/.test(albumJs) &&
  /lastStatus = Transport\.status;/.test(albumJs));
ok('album.js：页面隐藏 / 无 meta 时订阅直接返回（不白跑）',
  /if \(el\.classList\.contains\('hidden'\) \|\| !meta\) return;/.test(albumJs));

/* ================================================================
 * D. 方形封面 + 中心孔开关
 * ================================================================ */
section('D. 方形封面真方角化 + 中心孔开关');

ok('pages.css：方形下主唱片 .disc-face / .disc-spin 切 16px 方角（修"方包圆"）',
  /#page-nowplaying\.cover-square \.np-disc \.disc-spin,\s*\n#page-nowplaying\.cover-square \.np-disc \.disc-face \{\s*\n\s*border-radius: 16px;/.test(pagesCss));
ok('pages.css：方形下主唱片停转、藏中孔',
  /#page-nowplaying\.cover-square \.np-disc \.disc-spin \{ animation: none; \}/.test(pagesCss) &&
  /#page-nowplaying\.cover-square \.np-disc \.disc-hole \{ display: none; \}/.test(pagesCss));
ok('pages.css：.no-hole 只隐藏主唱片中孔',
  /#page-nowplaying\.no-hole \.np-disc \.disc-hole \{ display: none; \}/.test(pagesCss));
ok('pages.css：方形规则全部限定 .np-disc（不误伤传输条迷你唱片）',
  // .disc-face/.disc-spin/.disc-hole 是通用类，迷你唱片（.np-mini-disc 内）也消费；
  // 任何不带 .np-disc 作用域的 cover-square/no-hole 规则都会把迷你唱片改方。
  // 注意：658/666/670 行的 .np-disc-slot / .np-disc 是主唱片骨架本身，不算漏穿。
  !/#page-nowplaying\.(cover-square|no-hole) \.disc-(face|spin|hole)/.test(pagesCss) &&
  !/#page-nowplaying\.cover-square \.np-mini-disc/.test(pagesCss));
ok('nowplaying.js：导出 setDiscHole（切 #page-nowplaying 的 no-hole）',
  /function setDiscHole\(on\) \{[\s\S]{0,200}?el\.classList\.toggle\('no-hole', on === false\);/.test(constNowJs) &&
  /setCoverStyle, setDiscHole,/.test(constNowJs));
ok('app.js：设置默认值含 discHole（默认 true）',
  /discHole: true/.test(appJs));
ok('app.js：App.setDiscHole 应用 + 持久化 + init 时应用',
  /App\.setDiscHole = \(on, persist\) => \{/.test(appJs) &&
  /window\.cd\.invoke\('settings:set', \{ discHole: next \}\)/.test(appJs) &&
  /App\.setDiscHole\(App\.state\.settings\.discHole, false\);/.test(appJs));
ok('settings.js：唱片模式区域有「唱片中心圆孔」开关（默认开）',
  /labelBlock\('set\.appearance\.hole\.label'/.test(settingsJs) &&
  /'set\.appearance\.hole\.label': '唱片中心圆孔'/.test(i18nJs) &&
  /toggle\(data\.discHole !== false/.test(settingsJs));
ok('main/index.js：settings.data 默认值含 discHole',
  /discHole: true/.test(mainIndex));

/* ================================================================
 * E. 音乐库：移除确认 + 弹碟按钮 + 搜索
 * ================================================================ */
section('E. 音乐库角落工具与移除确认');

/* 移除确认 */
ok('library.js：confirmDialog 通用确认框（Esc 取消 / Enter 确认）',
  /function confirmDialog\(opts\) \{/.test(libraryJs) &&
  /e\.key === 'Escape'[\s\S]{0,80}?finish\(false\)/.test(libraryJs) &&
  /e\.key === 'Enter'[\s\S]{0,80}?finish\(true\)/.test(libraryJs));
ok('library.js：移除前确认，文案含"重新放入 CD 才能添加入库"',
  /const yes = await confirmDialog\(\{[\s\S]{0,400}?T\('library\.menu\.confirmMsg'\)/.test(libraryJs) &&
  /'library\.menu\.confirmMsg': '[^']*重新放入 CD 才能添加入库/.test(i18nJs));

/* 右下角弹碟按钮 */
ok('library.js：render 挂载角落工具（mountCornerTools）',
  /mountCornerTools\(\);/.test(libraryJs));
ok('library.js：弹碟按钮按 cd:get-state 分流（有碟 eject / 无碟 close-door）',
  /st = await window\.cd\.invoke\('cd:get-state'\);/.test(libraryJs) &&
  /window\.cd\.invoke\('cd:eject'\)/.test(libraryJs) &&
  /window\.cd\.invoke\('cd:close-door'\)/.test(libraryJs));
ok('library.js：demo 碟按无碟处理（弹托盘让用户放真碟）',
  /st\.signature !== '__demo__'/.test(libraryJs));

/* 左下角搜索 */
ok('library.js：搜索匹配全字段（专辑/歌曲/艺术家/年份/歌词含 bg）',
  /function matchMeta\(meta, q\) \{/.test(libraryJs) &&
  /if \(meta\.album\) hay\.push\(meta\.album\);/.test(libraryJs) &&
  /for \(const l of ld\.lines\) \{[\s\S]{0,300}?hay\.push\(b\.text\);/.test(libraryJs));
ok('library.js：rebuildItems 供 refresh 与搜索过滤共用（不重复走 IPC）',
  /function rebuildItems\(\) \{/.test(libraryJs) &&
  /_lastItems = items;\s*\n\s*rebuildItems\(\);/.test(libraryJs));
ok('library.js：搜索无匹配有空态提示',
  /T\('library\.empty\.noMatch', \{ q: q \}\)/.test(libraryJs) &&
  /'library\.empty\.noMatch': '没有匹配「\{q\}」的专辑'/.test(i18nJs));
ok('library.js：rebuildItems 先摘陈旧 .lib-empty（修关闭搜索后残留/叠加）',
  // flow 模式下空态挂 container（视口）而非 flowRow，只清 flowRow 会残留叠加。
  /const staleEmpties = container\.querySelectorAll\('\.lib-empty'\);[\s\S]{0,120}?staleEmpties\[i\]\.remove\(\);/.test(libraryJs) &&
  /staleEmpties\[i\]\.remove\(\);\s*\n\s*if \(flowRow\) flowRow\.innerHTML = ''; else container\.innerHTML = '';/.test(libraryJs));
ok('library.js：关闭搜索时清空查询词并重渲染（空态随之消失）',
  /if \(_query\) \{ _query = ''; applySearch\(\); \}/.test(libraryJs));
ok('library.js：靠近显现（FAB_NEAR_PX / FAB_FAR_PX 滞回）',
  /const FAB_NEAR_PX = 150;/.test(libraryJs) &&
  /const FAB_FAR_PX = 210;/.test(libraryJs) &&
  /function nearToggle\(btn, mx, my\) \{/.test(libraryJs));
ok('library.js：非音乐库页 / 有覆盖层时隐藏角落工具',
  /App\.state\.page !== 'library'/.test(libraryJs) &&
  /document\.querySelector\('\.overlay:not\(\.hidden\)'\)/.test(libraryJs));
ok('library.js：proximity 监听只注册一次（防 render 反复绑定）',
  /if \(!_cornerProximityWired\) \{/.test(libraryJs));

/* CSS */
ok('pages.css：.lib-fab 圆形按钮样式 + .near 淡入',
  /\.lib-fab \{[\s\S]{0,400}?border-radius: 50%;/.test(pagesCss) &&
  /\.lib-fab\.near \{[\s\S]{0,200}?opacity: 1;/.test(pagesCss));
ok('pages.css：搜索栏与确认框样式',
  /\.lib-search-panel \{/.test(pagesCss) &&
  /\.lib-confirm-card \{/.test(pagesCss));

console.log('\n' + (fails ? fails + ' 个断言未通过' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
