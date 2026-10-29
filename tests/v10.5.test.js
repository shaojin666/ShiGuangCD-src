'use strict';
/* ============================================================
   v10.5.test.js —— 用户实测反馈修复 + 新需求回归
   ------------------------------------------------------------
   覆盖（对应用户 2026-10-20 反馈）：
     A. CoverFlow 封面 / 播放按钮点击无响应（两个根因：
        pointerdown 即 setPointerCapture 吞掉子元素 click；
        album.js 用 const 定义导致 window.Album 恒 undefined）
     B. 逐字歌词英文空格被吞（词 span 之间无空格文本节点）
     C. CoverFlow 专辑名下移 + 信息行（艺术家 · 年份 · 碟号 · 歌总数）
     D. 播放顺序 / 音画律动设置持久化
     E. 读盘界面弹出托盘按钮（默认隐藏、靠近出现、点击出舱）
     F. 设置页：开机自启 / 进入时自动全屏（均默认关）

   行为级验证在 tests/renderer.test.js（#25 CoverFlow 点击、
   #26c 英文空格、#25 信息行），本文件补静态契约与主进程接线。
   ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const libraryJs = read('renderer/js/library.js');
const albumJs = read('renderer/js/album.js');
const lyricsViewJs = read('renderer/js/lyrics-view.js');
const appJs = read('renderer/js/app.js');
/* 文案改走 i18n：静态断言同时查「代码/HTML 用对了键」与「词典里有对应中文」 */
const i18nJs = read('renderer/js/i18n.js');
const settingsJs = read('renderer/js/settings.js');
const mainIndex = read('main/index.js');
const mainIpc = read('main/ipc.js');
const cdService = read('main/cd/cd-service.js');
const preloadJs = read('preload.js');
const indexHtml = read('renderer/index.html');
const pagesCss = read('renderer/css/pages.css');
const sceneCss = read('renderer/css/scene.css');

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ================================================================
 * A. CoverFlow 点击无响应（用户实测："点封面/播放按钮都没反应"）
 * ================================================================ */
console.log('\n# A. CoverFlow 点击链路（v10.5 双根因修复）');

/* 根因 1：pointerdown 里立即 setPointerCapture → mousedown/mouseup/click
   全部重定向到容器，子元素（封面项 / 播放按钮）的 click 永不触发。
   修复后：pointerdown 只记 pending；只有 pointermove 越过 DRAG_SLOP
   才捕获指针。断言捕获调用在源码里位于 pointermove 监听之后。 */
/* 注意：必须匹配 `container.setPointerCapture` 调用本身 ——
   pointerdown 的注释里也提到了 setPointerCapture 字样，用裸名字
   indexOf 会先命中注释（v10.5 测试修复教训）。 */
const capIdx = libraryJs.indexOf('container.setPointerCapture');
const moveIdx = libraryJs.indexOf("addEventListener('pointermove'");
ok('捕获指针的调用在 pointermove 处理器内（不在 pointerdown）',
  capIdx > 0 && moveIdx > 0 && capIdx > moveIdx, { capIdx, moveIdx });
ok('pointerdown 处理器不含 setPointerCapture', (() => {
  const downIdx = libraryJs.indexOf("addEventListener('pointerdown'");
  const downBlock = libraryJs.slice(downIdx, moveIdx);
  return downBlock.indexOf('container.setPointerCapture') < 0;
})(), 'pointerdown 代码段仍含捕获');
ok('未过拖动阈值时提前 return（保留点击语义）',
  /if \(!dragging\) \{[\s\S]{0,220}?if \(Math\.abs\(dx\) <= DRAG_SLOP\) return;/.test(libraryJs));
ok('进入拖动才加 flow-dragging 类并捕获',
  /dragging = true;[\s\S]{0,160}?setPointerCapture/.test(libraryJs));
ok('pointerup 后未拖动则直接返回（不抢焦点）',
  /if \(!wasDragging\) return;/.test(libraryJs));

/* 根因 2：album.js 用 const Album 定义，window.Album 恒 undefined，
   library.js / app.js 的 window.Album 守卫全部静默失败。 */
ok('album.js 挂载 window.Album（与 lyrics-view.js 的 window.LyricsView 同模式）',
  /window\.Album = Album;/.test(albumJs));
ok('封面点击仍走 Album.open（一镜到底入口）',
  /if \(window\.Album\) Album\.open\(meta, node\);/.test(libraryJs));
ok('回车打开详情页的守卫同时生效',
  /if \(it && window\.Album\) \{[\s\S]{0,200}?Album\.open\(meta, it\);/.test(libraryJs));
ok('app.js Esc 路由守卫生效',
  /if \(window\.Album && typeof Album\.onKey === 'function' && Album\.onKey\(e\)\) return;/.test(appJs));
ok('播放按钮 click → App.requestDisc（从第一首播）',
  /flowPlay\.addEventListener\('click'[\s\S]{0,400}?App\.requestDisc\(meta\)/.test(libraryJs));

/* ================================================================
 * B. 逐字歌词英文空格被吞（"I love you" → "Iloveyou"）
 * ================================================================ */
console.log('\n# B. 逐字歌词英文空格');
/* 用字符串 includes 断言字符类本体（含拉丁扩展/西里尔），避开正则
   转义陷阱：源码里 `\\u00C0` 是 6 个字符，正则匹配极易漏掉 `$` 与
   `.test` 之间的正则字面量右斜杠 `/`。 */
ok('needsSpace 启发式存在（拉丁词之间补、CJK 之间不补、连字符不补）',
  /function needsSpace\(prev, cur\) \{/.test(lyricsViewJs) &&
  lyricsViewJs.includes('[A-Za-z0-9\\u00C0-\\u024F\\u0400-\\u04FF]') &&
  lyricsViewJs.includes('if (/-$/.test(prev) || /^-/.test(cur)) return false;'),
  'needsSpace 或其字符类缺失');
ok('appendWords 在词 span 之间插入空格文本节点',
  /if \(prev && needsSpace\(prev, w\.x\)\) container\.appendChild\(document\.createTextNode\(' '\)\);/.test(lyricsViewJs));
ok('主词级渲染改走 appendWords',
  /words = appendWords\(inner, l\.words\);/.test(lyricsViewJs));
ok('背景人声（对唱）词渲染同样走 appendWords',
  /bwords = appendWords\(blk, b\.words\);/.test(lyricsViewJs));
ok('词 span 保留 white-space: pre-wrap（词内自带空格不被吞）',
  /\.lrc-w \{[\s\S]{0,80}?white-space: pre-wrap;/.test(pagesCss));

/* ================================================================
 * C. CoverFlow 专辑名下移 + 信息行
 * ================================================================ */
console.log('\n# C. CoverFlow 信息排版');
ok('专辑名容器下移（margin-top 16px，原 2px）',
  /\.lib-flow-top \{[\s\S]{0,120}?margin: 16px 44px 0;/.test(pagesCss));
ok('新增 .lib-flow-meta 信息行样式', /\.lib-flow-meta \{/.test(pagesCss));
ok('信息行位于专辑名下方（flex 列中 flowMeta 在 container 之前创建）',
  /flowTop = document\.createElement\('div'\);[\s\S]{0,400}?flowMeta = document\.createElement\('div'\);/.test(libraryJs));
/* 注意：`if (meta.year)` 到 `parts.join(' · ')` 之间隔着碟号计算与
   歌总数两段（约 400 字符），量程要够；String(...) 有两个右括号。 */
ok('flowMetaLine 拼装 艺术家 · 年份 · 碟号 · 歌总数',
  /function flowMetaLine\(meta\) \{[\s\S]{0,500}?if \(meta\.artist\) parts\.push\(meta\.artist\);[\s\S]{0,200}?if \(meta\.year\) parts\.push\(String\(meta\.year\)\);[\s\S]{0,600}?parts\.join\(' · '\);/.test(libraryJs));
ok('碟号格式：多碟 D1/2、单碟 D1、无碟号信息省略',
  /discTotal > 1 \? `D\$\{discNumber\}\/\$\{discTotal\}` : `D\$\{discNumber\}`/.test(libraryJs));
ok('焦点变化时同步刷新信息行', /flowMeta\.textContent = it \? flowMetaLine\(it\.__meta\) : '';/.test(libraryJs));
ok('空库时清空信息行', /if \(flowMeta\) \{ flowMeta\.textContent = ''; flowMeta\.title = ''; \}/.test(libraryJs));

/* ================================================================
 * D. 播放顺序 / 音画律动持久化
 * ================================================================ */
console.log('\n# D. 设置持久化');
/* 播放顺序：原来 cd:set-mode 只改 CdService 内存，重启回到 normal */
ok('cd:set-mode handler 落盘 settings.update({ playMode })',
  /const next = service\.setPlayMode\(mode\);[\s\S]{0,200}?settings\.update\(\{ playMode: next \}\);/.test(mainIpc));
ok('CdService 构造时从 settings.playMode 恢复',
  /this\.playMode = \(this\.settings && this\.settings\.playMode\) \|\| 'normal';/.test(cdService));
ok('settings 默认值声明 playMode: normal', /playMode: 'normal',/.test(mainIndex));
/* 音画律动：原来 toggle 只改内存 + 通知 Visualizer，不落盘 */
ok('音画律动 toggle 落盘 settings:set({ visualFx })',
  /data\.visualFx = next;[\s\S]{0,220}?settings:set', \{ visualFx: next \}/.test(settingsJs));
ok('settings 默认值声明 visualFx: true', /visualFx: true,/.test(mainIndex));
ok('启动时应用 visualFx（既有链路保持）',
  /Visualizer\.setEnabled\(App\.state\.settings\.visualFx\);/.test(appJs));

/* ================================================================
 * E. 读盘界面弹出托盘按钮
 * ================================================================ */
console.log('\n# E. 弹出托盘按钮');
ok('等待光盘文案下方有弹出托盘按钮（#ceremony-sub 之后）',
  /<div id="ceremony-sub"><\/div>[\s\S]{0,400}?id="ceremony-eject"/.test(indexHtml));
ok('按钮带 aria-label 与文字"弹出托盘"（i18n 键 scene.ejectTray）',
  /id="ceremony-eject" class="ceremony-eject"[\s\S]{0,200}?data-i18n-aria="scene\.ejectTray"/.test(indexHtml)
  && /data-i18n="scene\.ejectTray"/.test(indexHtml)
  && /'scene\.ejectTray': '\u5f39\u51fa\u6258\u76d8'/.test(i18nJs));
ok('CSS：默认隐藏（opacity 0），.near 时淡入',
  /#ceremony-eject \{[\s\S]{0,700}?opacity: 0;[\s\S]{0,400}?#ceremony-eject\.near \{[\s\S]{0,120}?opacity: 1;/.test(sceneCss));
ok('CSS：只在待机（ph-idle）阶段可用，其它阶段 display:none',
  /#ceremony:not\(\.ph-idle\) #ceremony-eject \{ display: none; \}/.test(sceneCss));
ok('app.js 接线 wireCeremonyEject 并在 init 调用',
  /function wireCeremonyEject\(\) \{/.test(appJs) && /wireCeremonyEject\(\);/.test(appJs));
ok('点击走 cd:eject IPC',
  /btn\.addEventListener\('click'[\s\S]{0,200}?window\.cd\.invoke\('cd:eject'\)/.test(appJs));
ok('鼠标靠近判定用独立感应半径（比退出按钮小）',
  /const CER_EJECT_RADIUS = 110;/.test(appJs) &&
  /CER_EJECT_RADIUS[\s\S]{0,120}?btn\.classList\.toggle\('near', near\)/.test(appJs));

/* ================================================================
 * F. 开机自启 / 进入时自动全屏
 * ================================================================ */
console.log('\n# F. 开机自启与自动全屏');
ok('settings 默认值：autoLaunch / autoFullscreen 均 false',
  /autoLaunch: false,/.test(mainIndex) && /autoFullscreen: false,/.test(mainIndex));
ok('渲染端默认值同步声明', /autoLaunch: false,\n\s+autoFullscreen: false/.test(appJs));
ok('设置面板有"开机自动启动"开关（默认关）',
  /labelBlock\('set\.sys\.autoLaunch\.label'[\s\S]{0,300}?toggle\(data\.autoLaunch === true/.test(settingsJs)
  && /'set\.sys\.autoLaunch\.label': '开机自动启动'/.test(i18nJs));
ok('设置面板有"进入时自动全屏"开关（默认关）',
  /labelBlock\('set\.sys\.autoFs\.label'[\s\S]{0,300}?toggle\(data\.autoFullscreen === true/.test(settingsJs)
  && /'set\.sys\.autoFs\.label': '进入时自动全屏'/.test(i18nJs));
ok('开机自启 toggle：落盘 + 同步 OS 启动项',
  /settings:set', \{ autoLaunch: next \}[\s\S]{0,160}?app:set-auto-launch', \{ on: next \}/.test(settingsJs));
ok('自动全屏 toggle 落盘', /settings:set', \{ autoFullscreen: next \}/.test(settingsJs));
ok('主进程注册 app:set-auto-launch（setLoginItemSettings）',
  /ipcMain\.handle\('app:set-auto-launch'[\s\S]{0,260}?app\.setLoginItemSettings\(\{ openAtLogin: on \}\)/.test(mainIpc));
ok('preload 白名单放行 app:set-auto-launch',
  /'app:set-auto-launch',/.test(preloadJs));
ok('ready-to-show 时按设置进入全屏',
  /win\.once\('ready-to-show', \(\) => \{[\s\S]{0,220}?settings\.data\.autoFullscreen === true[\s\S]{0,120}?win\.setFullScreen\(true\)/.test(mainIndex));
ok('启动时对齐开机自启（设置开着才确保 OS 项在，关着不擅自删）',
  /if \(settings\.data\.autoLaunch === true\) \{[\s\S]{0,160}?app\.setLoginItemSettings\(\{ openAtLogin: true \}\)/.test(mainIndex));

console.log('\n' + (fails ? fails + ' FAILED' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
