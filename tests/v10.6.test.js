'use strict';
/* ============================================================
   v10.6.test.js —— 用户实测反馈修复 + 新需求回归
   ------------------------------------------------------------
   覆盖（对应用户本轮反馈）：
     A. 专辑详情页只在首次启动可用（Esc 退出后再开"闪一下消失"）
     B. 详情页可读性：背景按封面取色，黑封面下文字糊底 → 智能文字色
     C. 进度条 / 音量条悬浮精准提示（跟随鼠标）+ 音量滚轮调速
     D. 设置页新增罗马音歌词大小
     E. 对唱歌词左右分布（主界面 + 悬浮）——v10.7 起为 amll 排版：
        主唱(非对唱)靠右、对唱靠左、无居中，bg 跟随所属行；
        旧的"主左对右 + has-bg"断言已按 v10.7 反转
     F. 悬浮歌词译/音显隐开关（设置页）——整窗长按拖动在 v10.7
        已按用户反馈整体移除，断言反转为"通道/状态机/样式均不存在"
     G. 播放页方形封面样式（设置切换，默认旋转唱片；暂停缩小播放放大）

   行为级验证在 tests/renderer.test.js（歌词 DOM / 设置滑条等）、
   tests/floating-view.test.js（悬浮渲染 DOM），本文件补静态契约
   与主进程 / 预加载接线。
   ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const albumJs = read('renderer/js/album.js');
const lyricsViewJs = read('renderer/js/lyrics-view.js');
const constNowJs = read('renderer/js/nowplaying.js');
const appJs = read('renderer/js/app.js');
/* 文案改走 i18n：静态断言同时查「代码用对了键」与「词典里有对应中文」 */
const i18nJs = read('renderer/js/i18n.js');
const settingsJs = read('renderer/js/settings.js');
const floatRendJs = read('renderer/js/floating.js');
const mainFloatJs = read('main/floating.js');
const mainIpc = read('main/ipc.js');
const mainIndex = read('main/index.js');
const preloadJs = read('preload.js');
const pagesCss = read('renderer/css/pages.css');
const floatCss = read('renderer/css/floating.css');

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ================================================================
 * A. 详情页二次打开（"只能第一次打开"）
 * ================================================================ */
console.log('\n# A. 详情页二次打开（v10.6 三残留 + 一竞态）');

/* 残留 1：.closing 的 albumout 动画带 forwards，会把页面钉在 opacity:0。
   必须 open 与 finish 双向清理。 */
ok('open() 清理 .closing（forwards 会把页面钉死在 opacity:0）',
  /el\.classList\.remove\('closing', 'has-colors', 'has-art'\);/.test(albumJs));
ok('finish() 同样移除 .closing（旧 finish 跑到时也不能留）',
  /el\.classList\.remove\('closing', 'tab-album', 'tab-tracks', 'has-colors', 'has-art'\);/.test(albumJs));

/* 残留 2：关闭 FLIP 在 .al-art 上留下行内 opacity:0/位移 */
ok('resetArtInline() 清 slot 行内 transition/transform/opacity',
  /function resetArtInline\(\) \{[\s\S]{0,200}?slot\.style\.transition = '';[\s\S]{0,80}?slot\.style\.transform = '';[\s\S]{0,80}?slot\.style\.opacity = '';/.test(albumJs));
ok('open() 调用 resetArtInline()', /resetArtInline\(\);\s*\n\s*el\.classList\.remove\('hidden'\);/.test(albumJs));
ok('finish() 也调用 resetArtInline()',
  /el\.style\.removeProperty\('--al-scrim-b'\);\s*\n\s*resetArtInline\(\);/.test(albumJs));

/* 竞态：旧 finish 的 setTimeout(finish, 430) 可能在新 open 之后触发，
   把新页面重新盖 .hidden。epoch 代次守卫让旧 finish 作废。 */
ok('epoch 代次存在且 open 时自增',
  /let epoch = 0;/.test(albumJs) && /epoch\+\+;/.test(albumJs));
ok('close() 捕获本次关闭归属的代次',
  /const myEpoch = epoch;/.test(albumJs));
ok('finish() 校验代次：旧 finish 直接作废（不盖 .hidden）',
  /if \(myEpoch !== epoch\) \{ closing = false; return; \}/.test(albumJs));

/* 残留 3：上一张碟的取色变量不清，渐变还挂在上一次的封面色上 */
ok('open() 清 --al-c1/--al-c2 与 scrim 变量',
  /el\.style\.removeProperty\('--al-c1'\);\s*\n\s*el\.style\.removeProperty\('--al-c2'\);\s*\n\s*el\.style\.removeProperty\('--al-scrim-a'\);\s*\n\s*el\.style\.removeProperty\('--al-scrim-b'\);/.test(albumJs));
ok('finish() 同样清取色变量',
  /el\.classList\.remove\('closing', 'tab-album'[\s\S]{0,120}?el\.style\.removeProperty\('--al-c1'\);[\s\S]{0,200}?el\.style\.removeProperty\('--al-scrim-b'\);/.test(albumJs));

/* ================================================================
 * B. 详情页可读性（黑封面文字糊底 → 智能文字色）
 * ================================================================ */
console.log('\n# B. 详情页智能文字色（v10.6 可读性三件套）');

ok('lumOf：感知亮度（0.2126/0.7152/0.0722 加权）',
  /function lumOf\(c\) \{[\s\S]{0,120}?0\.2126 \* c\.r \+ 0\.7152 \* c\.g \+ 0\.0722 \* c\.b/.test(albumJs));
ok('clampForText：过亮取色线性压到 maxLum（保色相）',
  /function clampForText\(c, maxLum\) \{[\s\S]{0,160}?const k = maxLum \/ l;[\s\S]{0,120}?c\.r \* k/.test(albumJs));
ok('applyTextPalette：按有效背景亮度在亮/暗文字色板间切换',
  /function applyTextPalette\(c1, c2\) \{[\s\S]{0,220}?const light = eff < 0\.4;/.test(albumJs));
ok('文字色板写 --al-fg 系列 CSS 变量（fg-light/fg-dark 类）',
  /el\.style\.setProperty\('--al-fg', light \? '#f6f1e7' : '#23201c'\);/.test(albumJs) &&
  /el\.classList\.toggle\('fg-light', light\);/.test(albumJs) &&
  /el\.classList\.toggle\('fg-dark', !light\);/.test(albumJs));
ok('paintBackground 先压亮度（0.22）再下发取色',
  /clampForText\(colors\.dominant \|\| colors\.mean, 0\.22\)/.test(albumJs) &&
  /clampForText\(colors\.mean \|\| colors\.dominant, 0\.22\)/.test(albumJs));
ok('无取色时 scrim 加到 0.86/0.95 并套用暗底亮字',
  /el\.style\.setProperty\('--al-scrim-a', 'rgba\(8, 8, 10, 0\.86\)'\);/.test(albumJs) &&
  /el\.style\.setProperty\('--al-scrim-b', 'rgba\(8, 8, 10, 0\.95\)'\);/.test(albumJs) &&
  /applyTextPalette\(null, null\);/.test(albumJs));
ok('pages.css：.al-bg-tint 的 scrim 走 var() 兜底（无取色也有暗底）',
  /\.al-bg-tint \{[\s\S]{0,400}?var\(--al-scrim-a, rgba\(8, 8, 10, 0\.78\)\)/.test(pagesCss) &&
  /\.al-bg-tint \{[\s\S]{0,400}?var\(--al-scrim-b, rgba\(8, 8, 10, 0\.93\)\)/.test(pagesCss));
ok('pages.css：详情页 chrome 暗色化覆写（浅色主题不会亮色糊脸）',
  /\.album-overlay \{[\s\S]{0,800}?--glass: rgba\(16, 16, 20, 0\.58\);/.test(pagesCss) &&
  /\.album-overlay \{[\s\S]{0,800}?--accent-strong: #e0bc7c;/.test(pagesCss));
ok('pages.css：详情页文字元素消费 --al-fg 系列',
  /\.al-title-inner \{[\s\S]{0,200}?color: var\(--al-fg\);/.test(pagesCss) &&
  /\.al-track \{[\s\S]{0,200}?color: var\(--al-fg-dim\);/.test(pagesCss));

/* ================================================================
 * C. 进度条 / 音量条悬浮提示 + 音量滚轮
 * ================================================================ */
console.log('\n# C. 滑块悬浮可视化与滚轮调速');

ok('sliderRatio：按 clientX 与轨道矩形算比例（native range 无 hover 事件）',
  /function sliderRatio\(input, clientX\) \{/.test(constNowJs));
ok('wireSliderHint 存在并在 render 接线',
  /function wireSliderHint\(\) \{/.test(constNowJs) && /wireSliderHint\(\);/.test(constNowJs));
ok('进度条 mousemove → 光标上方显示目标时间',
  /seekInput\.addEventListener\('mousemove'[\s\S]{0,400}?show\(e\.clientX, r\.top - 6, fmt\(sec\)\);/.test(constNowJs));
ok('音量条 mousemove → 显示百分比',
  /vol\.addEventListener\('mousemove'[\s\S]{0,300}?hintAt\(e\.clientX, Math\.round\(sliderRatio\(vol, e\.clientX\) \* 100\) \+ '%'\);/.test(constNowJs));
ok('音量滚轮调速：passive:false 才能 preventDefault',
  /vol\.addEventListener\('wheel',[\s\S]{0,600}?\}, \{ passive: false \}\);/.test(constNowJs));
ok('滚轮每格 ±4% 并调完在滑块当前位置浮一下读数',
  /const next = Math\.max\(0, Math\.min\(100,[\s\S]{0,120}?App\.setVolume\(next \/ 100\)/.test(constNowJs) &&
  /hintAt\(null, next \+ '%'\);/.test(constNowJs));
ok('滚轮读数 900ms 自动隐藏（_hintTimer 防重入）',
  /vol\._hintTimer = setTimeout\(hide, 900\);/.test(constNowJs));
ok('pages.css：.slider-hint 悬浮气泡（fixed + 居中于光标上方）',
  /\.slider-hint \{[\s\S]{0,300}?position: fixed;[\s\S]{0,200}?transform: translate\(-50%, -100%\);/.test(pagesCss) &&
  /\.slider-hint \{[\s\S]{0,400}?pointer-events: none;/.test(pagesCss));

/* ================================================================
 * D. 罗马音歌词大小（设置页）
 * ================================================================ */
console.log('\n# D. 罗马音大小（roScale 全链路）');

ok('app.js：RO_MIN/RO_MAX 范围与 DEFAULTS 含 roScale',
  /const RO_MIN = 0\.6, RO_MAX = 1\.8;/.test(appJs) &&
  /const DEFAULTS = \{ lyricScale: 1, discScale: 1, trScale: 1, roScale: 1 \};/.test(appJs));
ok('app.js：apply 写 --lyric-ro-scale 并支持持久化',
  /root\.setProperty\('--lyric-ro-scale', String\(s\.roScale\)\);/.test(appJs) &&
  /if \(patch && patch\.roScale != null\) out\.roScale = s\.roScale;/.test(appJs));
ok('app.js：ranges 暴露 ro（设置页滑条取范围）',
  /ranges: \{ lyric: \[LYRIC_MIN, LYRIC_MAX\], disc: \[DISC_MIN, DISC_MAX\], tr: \[TR_MIN, TR_MAX\], ro: \[RO_MIN, RO_MAX\] \}/.test(appJs));
ok('app.js：设置默认值含 roScale / coverStyle / floatingShowTr / floatingShowRo',
  /roScale: 1,/.test(appJs) && /coverStyle: 'disc',/.test(appJs) &&
  /floatingShowTr: true,/.test(appJs) && /floatingShowRo: true/.test(appJs));
ok('settings.js：sizeKeys 增加罗马音滑条',
  /\{ label: 'set\.appearance\.size\.ro', key: 'roScale' \}/.test(settingsJs) &&
  /'set\.appearance\.size\.ro': '罗马音'/.test(i18nJs));
ok('settings.js：sizeRanges 增加 roScale 范围',
  /sizeRanges = \{[\s\S]{0,200}?roScale: \[0\.6, 1\.8\]/.test(settingsJs));
ok('main/index.js：settings.data 默认值同步',
  /roScale: 1/.test(mainIndex));
ok('pages.css：.lrc-ro 字号消费 --lyric-ro-scale',
  /\.lrc-ro \{[\s\S]{0,200}?calc\(var\(--lyric-base\) \* 0\.5 \* var\(--lyric-ro-scale, 1\)\)/.test(pagesCss));

/* ================================================================
 * E. 对唱歌词左右分布（主界面 + 悬浮）
 *    v10.7 起改为 amll 排版：含对唱→主唱(非对唱)全靠右、对唱全靠左、
 *    无居中；bg 跟随所属行（对唱下靠左、主唱下靠右）。
 *    旧的 has-bg（主左对右）方案整体废弃，以下断言随之更新。
 * ================================================================ */
console.log('\n# E. 对唱主右对左（v10.7 amll 排版）');

ok('lyrics-view.js：load 时算 duet 并给容器加 .duet 类',
  /duet = analyzeDuetLocal\(m\);/.test(lyricsViewJs) &&
  /box\.classList\.toggle\('duet', duet\.hasDuet\);/.test(lyricsViewJs));
ok('lyrics-view.js：对唱主行打 duet-line、bg 条目打 bg-duet/bg-main',
  /if \(duet\.hasDuet && l\.agent && l\.agent !== duet\.mainAgent\) \{\s*\n\s*line\.classList\.add\('duet-line'\);/.test(lyricsViewJs) &&
  /if \(duet\.hasDuet && b\.agent\) blk\.classList\.add\(b\.agent !== duet\.mainAgent \? 'bg-duet' : 'bg-main'\);/.test(lyricsViewJs) &&
  /else if \(duet\.hasDuet\) blk\.classList\.add\('bg-main'\);/.test(lyricsViewJs));
ok('lyrics-view.js：导出 duetInfo（悬浮窗取对唱结构）',
  /duetInfo: \(\) => \(\{ hasDuet, mainAgent \}\)/.test(lyricsViewJs) ||
  /duetInfo:/.test(lyricsViewJs));
ok('pages.css：duet 模式主唱行靠右、对唱行靠左',
  /\.np-lyrics\.duet \.lrc-line \{ text-align: right; \}/.test(pagesCss) &&
  /\.np-lyrics\.duet \.lrc-line\.duet-line \{ text-align: left; \}/.test(pagesCss));
ok('pages.css：duet 模式 bg 默认靠右、bg-duet 靠左、对唱行的 bg 靠左',
  /\.np-lyrics\.duet \.lrc-line \.lrc-bg \{ text-align: right; \}/.test(pagesCss) &&
  /\.np-lyrics\.duet \.lrc-line \.lrc-bg\.bg-duet \{ text-align: left; \}/.test(pagesCss) &&
  /\.np-lyrics\.duet \.lrc-line\.duet-line \.lrc-bg \{ text-align: left; \}/.test(pagesCss));
ok('floating.js：当前行构建 duet-line / bg-duet / bg-main',
  /function buildCurrentLine\(text, tr, ro, words, bg, info\) \{/.test(floatRendJs) &&
  /if \(duet && info\.agent && info\.agent !== duet\.main\) line\.classList\.add\('duet-line'\);/.test(floatRendJs) &&
  /if \(duet\) blk\.classList\.add\(b\.agent && b\.agent !== duet\.main \? 'bg-duet' : 'bg-main'\);/.test(floatRendJs));
ok('floating.js：bg 词跑 bw-fill 补间（appendBgWords，v10.7 起不再静态）',
  /function appendBgWords\(container, list, at\) \{/.test(floatRendJs) &&
  /span\.className = 'bw';/.test(floatRendJs));
ok('floating.css：duet-line / bg-duet 靠左、bg 默认靠右',
  /\.line\.duet-line \{ text-align: left; \}/.test(floatCss) &&
  /\.line\.duet-line \.bg \{ text-align: left; \}/.test(floatCss) &&
  /\.line \.bg\.bg-duet \{ text-align: left; \}/.test(floatCss));

/* ================================================================
 * F. 悬浮歌词管线：bg/ro/agent 推送 + 英文空格 + 译音开关
 *    （整窗长按拖动已于 v10.7 移除，见本节末尾的反转断言）
 * ================================================================ */
console.log('\n# F. 悬浮歌词管线（v10.6，v10.7 起 duet 增补）');

/* 推送侧：nowplaying.js emitLine 带上 ro 与 bg（含词级时间轴） */
ok('emitLine 推送 ro 与 bg',
  /if \(rec\.ro\) info\.ro = rec\.ro;/.test(constNowJs) &&
  /info\.bg = rec\.bgs\.map\(\(b\) => \(\{/.test(constNowJs));

/* 主进程白名单：bg ≤6 条、词 ≤120、字段逐个校验 */
ok('main/floating.js：setLyrics 白名单放行 ro / bg',
  /ro: \(info && typeof info\.ro === 'string'\) \? info\.ro : '',/.test(mainFloatJs) &&
  /if \(info && Array\.isArray\(info\.bg\)\) \{[\s\S]{0,120}?i < 6; i\+\+/.test(mainFloatJs) &&
  /if \(Array\.isArray\(b\.words\)\) \{[\s\S]{0,160}?j < 120; j\+\+/.test(mainFloatJs));
ok('main/floating.js：lastLyrics 默认形状含 ro / bg / agent / duet（v10.7 增补）',
  /let lastLyrics = \{ text: '', prev: '', next: '', index: -1, total: 0, playing: false, tr: '', ro: '', agent: '', duet: null, at: null, t: null, e: null, words: null, bg: null \};/.test(mainFloatJs));

/* 译/音显隐：设置页 → app:set-float-show → 主进程 pushShowOpts → 悬浮窗 */
ok('main/floating.js：readCfg 读 showTr/showRo（默认显示）',
  /showTr: d\.floatingShowTr !== false,/.test(mainFloatJs) &&
  /showRo: d\.floatingShowRo !== false,/.test(mainFloatJs));
ok('main/floating.js：pushShowOpts / pushInit 带译音偏好',
  /function pushShowOpts\(\) \{[\s\S]{0,160}?send\('float:opts', \{ float: cfg\.float, showTr: cfg\.showTr, showRo: cfg\.showRo \}\);/.test(mainFloatJs) &&
  /send\('float:init', \{[\s\S]{0,300}?showTr: cfg\.showTr,[\s\S]{0,120}?showRo: cfg\.showRo,/.test(mainFloatJs));
ok('main/floating.js：导出 setShowOpts（落盘 + 立刻推送）',
  /setShowOpts\(p\) \{[\s\S]{0,260}?pushShowOpts\(\);/.test(mainFloatJs));
ok('main/ipc.js：注册 app:set-float-show',
  /ipcMain\.handle\('app:set-float-show'[\s\S]{0,220}?f\.setShowOpts\(p\)/.test(mainIpc));
ok('preload.js：白名单放行 app:set-float-show',
  /'app:set-float-show',/.test(preloadJs));
ok('settings.js：悬浮歌词译/音两个开关（默认开）',
  /labelBlock\('set\.appearance\.floatTr\.label'[\s\S]{0,200}?toggle\(data\.floatingShowTr !== false/.test(settingsJs) &&
  /labelBlock\('set\.appearance\.floatRo\.label'[\s\S]{0,200}?toggle\(data\.floatingShowRo !== false/.test(settingsJs) &&
  /'set\.appearance\.floatTr\.label': '悬浮歌词显示翻译'/.test(i18nJs) &&
  /'set\.appearance\.floatRo\.label': '悬浮歌词显示罗马音'/.test(i18nJs));
ok('settings.js：开关走 app:set-float-show',
  /window\.cd\.invoke\('app:set-float-show', \{ tr: next \}\)/.test(settingsJs) &&
  /window\.cd\.invoke\('app:set-float-show', \{ ro: next \}\)/.test(settingsJs));

/* 悬浮渲染端：译/音开关消费 + bg/ro 渲染 */
ok('floating.js：float:init / float:opts 消费 showTr/showRo',
  /setShowOpts\(cfg\.showTr, cfg\.showRo\);/.test(floatRendJs) &&
  /setShowOpts\(o\.showTr, o\.showRo\);/.test(floatRendJs));
ok('floating.js：setShowOpts 只切 body 类（no-tr / no-ro）',
  /function setShowOpts\(showTr, showRo\) \{[\s\S]{0,260}?body\.classList\.toggle\('no-tr', !showTr\);[\s\S]{0,120}?body\.classList\.toggle\('no-ro', !showRo\);/.test(floatRendJs));
ok('floating.css：no-tr/no-ro 隐藏译/音',
  /body\.no-tr \.line \.tr,\s*\nbody\.no-ro \.line \.ro \{ display: none; \}/.test(floatCss));
ok('floating.js：渲染 ro 小字（.ro 块）',
  /r\.className = 'ro';/.test(floatRendJs));
ok('floating.css：.ro 小字样式（比译文再小一档）',
  /\.line \.ro \{[\s\S]{0,200}?calc\(var\(--fs\) \* 0\.46\)/.test(floatCss));

/* 英文空格：与主界面同规则（v10.5 修了主界面，v10.6 补悬浮） */
ok('floating.js：移植 needsSpace（拉丁词之间补空格）',
  /function needsSpace\(prev, cur\) \{/.test(floatRendJs) &&
  floatRendJs.includes('[A-Za-z0-9\\u00C0-\\u024F\\u0400-\\u04FF]'));
ok('floating.js：词 span 之间插入空格文本节点',
  /container\.appendChild\(document\.createTextNode\(' '\)\);/.test(floatRendJs));

/* 整窗长按拖动：v10.7 已按用户反馈整体移除（拖中间会被拉伸），
   只保留顶部拖动条。以下断言反转为"通道/状态机/样式均不存在"。 */
ok('main/floating.js：float:move-* 三个通道已移除（v10.7）',
  !/ipcMain\.handle\('float:move-start'/.test(mainFloatJs) &&
  !/ipcMain\.handle\('float:move'/.test(mainFloatJs) &&
  !/ipcMain\.handle\('float:move-end'/.test(mainFloatJs));
ok('main/floating.js：moveAnchor 代码已移除（v10.7，仅剩注释说明）',
  !/let moveAnchor/.test(mainFloatJs) &&
  !/moveAnchor = /.test(mainFloatJs));
ok('preload.js：白名单不再放行 float:move-*（v10.7）',
  !/'float:move-start', 'float:move', 'float:move-end',/.test(preloadJs));
ok('floating.js：长按拖动状态机已移除（v10.7）',
  !/DRAG_HOLD_MS/.test(floatRendJs) &&
  !/DRAG_SLOP_PX/.test(floatRendJs) &&
  !/let dragging/.test(floatRendJs) &&
  !/function beginDrag/.test(floatRendJs));
ok('floating.js：plate 长按拖动监听已移除；stage 只留四角缩放（v10.7）',
  !/plate\.addEventListener/.test(floatRendJs) &&
  /stage\.addEventListener\('pointerdown', \(e\) => \{/.test(floatRendJs) &&
  /const edge = e\.target && e\.target\.dataset \? \(e\.target\.dataset\.edge \|\| ''\) : '';/.test(floatRendJs));
ok('floating.css：body.dragging 样式已移除（v10.7）',
  !/body\.dragging/.test(floatCss));
ok('main/floating.js：close/setLocked 不再引用 moveAnchor（v10.7）',
  /function close\(\) \{\s*\n\s*resizeAnchor = null;/.test(mainFloatJs) &&
  !/moveAnchor = null/.test(mainFloatJs));

/* ================================================================
 * G. 方形封面样式
 * ================================================================ */
console.log('\n# G. 方形封面（设置切换 + 暂停/播放缩放）');

ok('nowplaying.js：导出 setCoverStyle（切 #page-nowplaying 的 cover-square）',
  /function setCoverStyle\(style\) \{[\s\S]{0,220}?el\.classList\.toggle\('cover-square', next === 'square'\);/.test(constNowJs) &&
  /setCoverStyle,/.test(constNowJs));
ok('app.js：App.setCoverStyle 落盘 + 启动时应用',
  /App\.setCoverStyle = \(style, persist\) => \{[\s\S]{0,260}?settings:set', \{ coverStyle: next \}/.test(appJs) &&
  /App\.setCoverStyle\(App\.state\.settings\.coverStyle, false\);/.test(appJs));
ok('settings.js：封面样式分段控件（唱片默认 / 方形）',
  /mkCover\('disc', T\('set\.appearance\.cover\.disc'\)\)/.test(settingsJs) &&
  /mkCover\('square', T\('set\.appearance\.cover\.square'\)\)/.test(settingsJs) &&
  /'set\.appearance\.cover\.disc': '唱片'/.test(i18nJs) &&
  /'set\.appearance\.cover\.square': '方形'/.test(i18nJs) &&
  /if \(App\.setCoverStyle\) App\.setCoverStyle\(value, true\);/.test(settingsJs));
ok('main/index.js：coverStyle 默认 disc（旋转唱片）',
  /coverStyle: 'disc',/.test(mainIndex));
ok('pages.css：方形槽位去俯仰、暂停 0.9 / 播放 1',
  /#page-nowplaying\.cover-square \.np-disc-slot \{[\s\S]{0,220}?transform: perspective\(1500px\) scale\(0\.9\);/.test(pagesCss) &&
  /#page-nowplaying\.cover-square \.np-disc-slot\.playing \{[\s\S]{0,120}?transform: perspective\(1500px\) scale\(1\);/.test(pagesCss));
ok('pages.css：缩放走非线性回弹曲线',
  /transform 0\.45s cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/.test(pagesCss));
ok('pages.css：方形封面方角 + 圆角过渡（切换时圆角长出来）',
  /#page-nowplaying\.cover-square \.np-disc \{[\s\S]{0,200}?border-radius: 16px;[\s\S]{0,400}?border-radius 0\.45s var\(--ease-cam\);/.test(pagesCss));
ok('pages.css：方形停转 + 藏中孔 + 去光盘纹路（均限定主唱片 .np-disc）',
  // v10.7 收窄作用域：.disc-face/.disc-spin/.disc-hole 是通用类，
  // 无作用域规则会误伤传输条迷你唱片（.np-mini-disc）。
  /#page-nowplaying\.cover-square \.np-disc \.disc-spin \{ animation: none; \}/.test(pagesCss) &&
  /#page-nowplaying\.cover-square \.np-disc \.disc-hole \{ display: none; \}/.test(pagesCss) &&
  /#page-nowplaying\.cover-square \.np-disc \.disc-face \{[\s\S]{0,200}?inset 0 0 0 2px var\(--sheen\),/.test(pagesCss));

console.log('\n' + (fails ? fails + ' FAILED' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
