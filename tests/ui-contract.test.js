'use strict';
/*
 * tests/ui-contract.test.js —— 前端契约静态测试（不启浏览器，直接读源码）。
 *
 * 锁两类容易在后续改动中悄悄回归、且肉眼难查的问题：
 *   1) 横向溢出防护（#18 页面右移修复）：
 *      .np-lyrics 必须显式 overflow-x:hidden（overflow-y:auto 会把 x 算成 auto），
 *      .lrc-line 必须 overflow-wrap:anywhere（长词断行）。
 *   2) 翻译字号设置（#19）：
 *      Sizes 必须认 trScale 并写 --lyric-tr-scale；.lrc-tr 必须消费该变量；
 *      设置面板必须有三个滑条且恢复默认不能写下标三元。
 *   3) 翻译开关纪律：无译文的歌词不显示「译」按钮。
 *
 * 运行：node tests/ui-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const pagesCss = read('renderer/css/pages.css');
const appJs = read('renderer/js/app.js');
const settingsJs = read('renderer/js/settings.js');
const nowplayingJs = read('renderer/js/nowplaying.js');
const mainIndexJs = read('main/index.js');
/* 多语言改造后，界面文案不再以中文字面量写在代码里，而是走 i18n 词典。
   静态契约测试因此改为「代码用对了 i18n 键 + 词典里确有对应中文」双查。 */
const i18nJs = read('renderer/js/i18n.js');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n---- ' + name + ' ----'); }

/** 取出某个 CSS 选择器规则体（花括号内原文，取首个匹配） */
function rule(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(esc + '\\s*\\{([^}]*)\\}').exec(css);
  return m ? m[1] : null;
}

function main() {

  /* ================================================================
   * 1) #18 横向溢出防护
   * ================================================================ */
  section('#18 逐字播放页面右移：横向溢出防护');

  {
    const npLyrics = rule(pagesCss, '.np-lyrics');
    ok(!!npLyrics, '.np-lyrics 规则存在');
    ok(npLyrics && /overflow-y:\s*auto/.test(npLyrics), '.np-lyrics 保留纵向滚动');
    ok(npLyrics && /overflow-x:\s*hidden/.test(npLyrics),
      '.np-lyrics 显式 overflow-x:hidden（否则 overflow-y:auto 会把 x 计算成 auto，'
      + '鼓点缩放/光晕撑出隐藏的横向滚动条，长句播放时整页右移）');
  }

  {
    const lrcLine = rule(pagesCss, '.lrc-line');
    ok(lrcLine && /overflow-wrap:\s*anywhere/.test(lrcLine),
      '.lrc-line overflow-wrap:anywhere（长词/外文条题断行，不撑横向溢出）');
  }

  {
    // 兜底层也必须有：html/body 与播放页容器本就 overflow:hidden，
    // 这里锁住它们不被后续改动拆掉
    const base = read('renderer/css/base.css');
    ok(/html,\s*body\s*\{[^}]*overflow:\s*hidden/s.test(base), 'html,body overflow:hidden 仍在');
    const page = rule(pagesCss, '#page-nowplaying');
    ok(page && /overflow:\s*hidden/.test(page), '#page-nowplaying overflow:hidden 仍在');
    const panel = rule(pagesCss, '.np-panel');
    ok(panel && /overflow:\s*hidden/.test(panel), '.np-panel overflow:hidden 仍在');
  }

  /* ================================================================
   * 2) #19 翻译字号设置
   * ================================================================ */
  section('#19 翻译字的大小设置：trScale → --lyric-tr-scale');

  {
    ok(/trScale:\s*1/.test(appJs), 'App 设置默认值含 trScale:1');
    ok(/TR_MIN\s*=\s*0\.6/.test(appJs) && /TR_MAX\s*=\s*1\.8/.test(appJs),
      'Sizes 定义了翻译字号范围 0.6~1.8');
    ok(/patch\.trScale != null\)\s*s\.trScale\s*=\s*clamp\(/.test(appJs.replace(/\n/g, ' ')),
      'Sizes.apply 接纳并钳制 trScale');
    ok(/setProperty\('--lyric-tr-scale'/.test(appJs), 'Sizes 写 --lyric-tr-scale 到 <html>');
    ok(/out\.trScale\s*=\s*s\.trScale/.test(appJs), 'Sizes 持久化 trScale（settings:set）');
    ok(/ranges:\s*\{[^}]*tr:/.test(appJs.replace(/\n/g, ' ')), 'Sizes.ranges 暴露 tr 范围');
  }

  {
    const tr = rule(pagesCss, '.lrc-tr');
    ok(tr && /--lyric-tr-scale/.test(tr),
      '.lrc-tr 字号消费 --lyric-tr-scale（主字号不牵连）');
    ok(tr && /var\(--lyric-tr-scale,\s*1\)/.test(tr),
      '.lrc-tr 带兜底默认值 1（变量未注入时退回原样式）');
  }

  {
    ok(/'set\.appearance\.size\.tr'/.test(settingsJs) && /trScale/.test(settingsJs)
      && /'set\.appearance\.size\.tr':\s*'翻译'/.test(i18nJs),
      '设置面板有「翻译」滑条（trScale，文案走 i18n）');
    const sliderCount = (settingsJs.match(/sizeBox\.appendChild\(mkSize\(/g) || []).length;
    ok(sliderCount === 0 || /sizeKeys\.forEach/.test(settingsJs),
      '滑条改为遍历 sizeKeys（不再逐个 appendChild 硬编码）');
    ok(!/i === 0 \? d\.lyricScale : d\.discScale/.test(settingsJs),
      '恢复默认不再用下标三元（三个滑条时会把翻译滑条改错）');
    ok(/data\[key\]\s*=\s*d\[key\]/.test(settingsJs), '恢复默认按键回写 data');
  }

  /* ================================================================
   * 2b) 播放引擎切换（v9：MCI / RAW 运行时切换 + 默认引擎偏好）
   * ================================================================ */
  section('播放引擎：设置页三选一切换');

  {
    ok(/enginePreference/.test(settingsJs), '设置面板读写 enginePreference');
    ok(/cd:switch-engine/.test(settingsJs),
      '选 raw/mci 时立即 invoke cd:switch-engine（不只存偏好）');
    ok(/mkEng\('auto'/.test(settingsJs) && /mkEng\('raw'/.test(settingsJs) && /mkEng\('mci'/.test(settingsJs),
      '三个分段按钮齐全：自动 / RAW / MCI');
    ok(/settings:set.*enginePreference|enginePreference.*settings:set/.test(settingsJs.replace(/\n/g, ' ')),
      '偏好经 settings:set 持久化');
    ok(/set\.play\.engine\.current/.test(settingsJs) && /App\.state\.engine/.test(settingsJs)
      && /'set\.play\.engine\.current':\s*'当前生效/.test(i18nJs),
      '显示当前生效引擎（App.state.engine）');
    ok(/labelBlock\('set\.play\.engine\.label'/.test(settingsJs)
      && /'set\.play\.engine\.label':\s*'播放引擎'/.test(i18nJs),
      '放在「播放」分区且标题为「播放引擎」');
  }

  /* ================================================================
   * 3) 翻译开关纪律（既有能力，锁回归）
   * ================================================================ */
  section('翻译开关：无译文不显示开关');

  {
    ok(/function applyLyricToggles/.test(nowplayingJs), 'nowplaying 仍有 applyLyricToggles');
    ok(/hasTr/.test(nowplayingJs) && /hasRo/.test(nowplayingJs),
      '按 hasTr/hasRo 控制译/音按钮显隐');
    ok(/style\.display\s*=\s*hasTr\s*\?\s*''\s*:\s*'none'/.test(nowplayingJs) &&
      /style\.display\s*=\s*hasRo\s*\?\s*''\s*:\s*'none'/.test(nowplayingJs),
      '无对应轨时按钮置 display:none（默认隐藏，有轨才显示）');
  }

  /* ================================================================
   * 4) IPC 通道契约：ipcMain.handle 注册的每个 invoke 通道都必须进
   *    preload 的 INVOKE_CHANNELS 白名单
   * ================================================================ */
  section('IPC 白名单契约：注册了就必须放行');

  {
    const ipcJs = read('main/ipc.js');
    const preloadJs = read('preload.js');
    // ipc.js 里 ipcMain.handle('xxx', ...) 的通道名
    const registered = new Set();
    const re = /ipcMain\.handle\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(ipcJs)) !== null) registered.add(m[1]);
    ok(registered.size > 0, 'ipc.js 里解析到 ipcMain.handle 注册', registered.size);
    // preload 的 INVOKE_CHANNELS 数组字面量
    const invMatch = /const INVOKE_CHANNELS\s*=\s*\[([\s\S]*?)\]/.exec(preloadJs);
    ok(!!invMatch, 'preload.js 里解析到 INVOKE_CHANNELS');
    const whitelisted = new Set();
    if (invMatch) {
      const sre = /'([^']+)'/g;
      while ((m = sre.exec(invMatch[1])) !== null) whitelisted.add(m[1]);
    }
    // ★ 逐通道核对：漏一个，渲染端 invoke 就被 preload 拒掉
    //   （lyrics:* 三个通道曾因此漏掉，用户侧表现为切换歌词源恒失败的"未知错误"）
    const missing = [...registered].filter((ch) => !whitelisted.has(ch));
    ok(missing.length === 0,
      '所有已注册通道都在 INVOKE_CHANNELS 白名单里', missing);
    // 渲染端实际在用的歌词通道必须放行（防呆：白名单被误删）
    for (const ch of ['lyrics:select-source', 'lyrics:add-ttml', 'lyrics:remove-source']) {
      ok(whitelisted.has(ch), '白名单包含 ' + ch);
    }
  }

  /* ================================================================
   * 5) v10.8 全屏歌词演出层契约（fl-stage）
   *    锁住"新旧共存"的四条红线：
   *    a. 演出层 CSS 必须挂载且自带停渲规则（旧界面 display:none）
   *    b. 入口按钮在原版传输条工具组（原版界面不被替换）
   *    c. nowplaying.tick/highlight 有显式停渲守卫（双保险）
   *    d. app.js 快捷键在演出层打开期间让位；退碟强制关闭
   *    e. 帧内写入白名单仍在（性能纪律）
   * ================================================================ */
  section('v10.8 全屏歌词演出层：新旧共存契约');

  {
    const indexHtml = read('renderer/index.html');
    ok(/css\/fl-stage\.css/.test(indexHtml), 'index.html 挂载 fl-stage.css');
    ok(/js\/fl-stage\.js/.test(indexHtml) && /js\/fl-lyrics\.js/.test(indexHtml), 'index.html 挂载演出层脚本');
    ok(/js\/tween\.js/.test(indexHtml), 'index.html 挂载 tween.js（自写补间，v10.12 起无 GSAP）');
    ok(!/<script[^>]+gsap/i.test(indexHtml), 'index.html 不再以 script 标签引入 GSAP');
    // three.js 必须懒加载：不进首屏（M3 镜台主题按需注入）
    ok(!/<script src="js\/vendor\/three\.min\.js"/.test(indexHtml), 'three.js 不进首屏（镜台主题懒加载）');

    const flCss = read('renderer/css/fl-stage.css');
    ok(/html\.fl-active\s+#pages/.test(flCss), 'html.fl-active 停渲 #pages');
    ok(/html\.fl-active\s+#topbar/.test(flCss), 'html.fl-active 停渲 #topbar');
    ok(/html\.fl-active\s+#ceremony/.test(flCss), 'html.fl-active 停渲 #ceremony');
    ok(/#fl-stage\s*\{[^}]*z-index:\s*60/.test(flCss), '#fl-stage z-index:60（覆盖 pages/topbar，低于 toast）');
    // 词填充渐变消费 var(--fl-ink)（无回退）——必须在 #fl-stage 有定义，
    // 否则整条 background-image 回退 none，叠加 color:transparent 后
    // 「唱到一半的词」直接消失（真浏览器验证过的坑，静态锁防回归）
    ok(/--fl-ink:\s*#/.test(flCss), '--fl-ink 在 #fl-stage 有定义（词填充渐变的前置条件）');
    ok(/--fl-w-dim:\s*rgba\(/.test(flCss), '--fl-w-dim 在 #fl-stage 有定义');
    ok(/word-mode .fl-line\.active .fl-w:not\(\.fl-solid\)/.test(flCss),
      '词填充门控 word-mode + fl-solid（行级 LRC 不会被渐变压暗）');
    ok(/帧内写入白名单/.test(flCss), '帧内写入白名单注释仍在（性能纪律锚点）');
    ok(/-webkit-app-region:\s*drag/.test(flCss), '演出层顶栏可拖窗（无边框窗口）');
  }

  {
    ok(/np-fl-stage/.test(nowplayingJs), 'nowplaying 工具组有演出层入口按钮（np-fl-stage）');
    ok(/FlStage\.open\(\)/.test(nowplayingJs), '入口按钮调用 FlStage.open()');
    // 双保险：tick 与 highlight 都要在演出层打开期间短路
    const guard = 'window.FlStage && FlStage.isOpen()';
    const tickIdx = nowplayingJs.indexOf('function tick(');
    const hlIdx = nowplayingJs.indexOf('function highlight(');
    ok(tickIdx > 0 && nowplayingJs.slice(tickIdx, tickIdx + 400).indexOf(guard) >= 0, 'tick() 有停渲守卫');
    ok(hlIdx > 0 && nowplayingJs.slice(hlIdx, hlIdx + 400).indexOf(guard) >= 0, 'highlight() 有停渲守卫');
  }

  {
    ok(/if \(window\.FlStage && FlStage\.isOpen\(\)\) return;/.test(appJs), 'Shortcuts 在演出层打开期间让位');
    ok(/FlStage\.forceClose\(\)/.test(appJs), '退碟/出舱强制关闭演出层（不盖住读盘场景）');
    ok(/FlStage\.init\(App\.state\.settings\)/.test(appJs), 'init 恢复演出层偏好');
    ok(/flTheme:\s*'lumen'/.test(appJs), 'App 设置默认值含 flTheme:lumen');
    ok(/flSize:\s*34/.test(appJs) && /flShowTr:\s*true/.test(appJs) && /flShowRo:\s*true/.test(appJs), 'App 设置默认值含 flSize/flShowTr/flShowRo');
    ok(/flParams:\s*\{\}/.test(appJs), 'App 设置默认值含 flParams（M2 主题参数）');
    ok(/App\.modeLabel/.test(appJs), 'App.modeLabel 暴露（播控菜单复用文案）');
  }

  /* ---- M2：三大主题 + 参数滑条契约 ---- */
  {
    const flThemes = read('renderer/js/fl-themes.js');
    ok(/id:\s*'whisper'/.test(flThemes) && /id:\s*'orbit'/.test(flThemes) && /id:\s*'chorus'/.test(flThemes),
      '三大主题已注册（倾诉 / 回环 / 群唱）');
    ok(/params:\s*\[/.test(flThemes), '主题带参数声明（面板滑条数据源）');
    const flCss2 = read('renderer/css/fl-stage.css');
    ok(/data-theme="whisper"/.test(flCss2) && /data-theme="orbit"/.test(flCss2) && /data-theme="chorus"/.test(flCss2),
      '三大主题 CSS 段就位');
    // 单写入纪律：主题只能用独立变换属性（translate/rotate/scale）做扇出/倾斜，
    // 不得另写 .fl-line 的 transform（定位链路独占）
    const themeBlocks = flCss2.split('data-theme="orbit"')[1] || '';
    ok(!/\.fl-line\s*\{[^}]*transform:/.test(themeBlocks.split('/* ----------')[0] || ''),
      'Orbit 主题不重写 .fl-line transform（用 translate/rotate/scale 独立属性）');
    ok(/fl-line\.fl-out\s*\{\s*opacity:\s*0\s*!important/.test(flCss2),
      '窗口剔除规则压过主题 opacity（真浏览器验证过的特异度修复）');
    const flPanel = read('renderer/js/fl-panel.js');
    ok(/buildParams/.test(flPanel) && /setThemeParam/.test(flPanel), '面板有主题参数区（M2）');
    const flStage = read('renderer/js/fl-stage.js');
    ok(/--fl-p-/.test(flStage) && /applyThemeParams/.test(flStage), 'fl-stage 写 --fl-p-* 主题参数变量');
    ok(/flParams/.test(mainIndexJs), '主进程设置默认值含 flParams');
  }

  /* ---- M3：镜台 3D + 降级链 + 画质自适应 + 凝彩 ---- */
  {
    const flThemes = read('renderer/js/fl-themes.js');
    ok(/id:\s*'prism'/.test(flThemes), '凝彩 Prism 已注册（fl-themes.js）');
    const mirror = read('renderer/js/fl-theme-mirror.js');
    ok(/id:\s*'mirror'/.test(mirror), '镜台 Mirror 已注册（fl-theme-mirror.js）');
    ok(/loadScript\('js\/vendor\/three\.min\.js'\)/.test(mirror), '镜台按需懒加载 three.min.js（不进首屏）');
    ok(/getContext\('2d'\)/.test(mirror) && /mode:\s*'2d'/.test(mirror), '镜台有 Canvas2D 星云降级分支');
    ok(/mode:\s*'css'/.test(mirror), '镜台有纯 CSS 最终降级分支');
    ok(/forceContextLoss/.test(mirror), '镜台 dispose 释放 GL 上下文（防上下文配额耗尽）');
    ok(/webglcontextlost/.test(mirror), '镜台监听上下文丢失（停渲不崩）');
    ok(/FPS_DOWN|FPS_UP/.test(mirror) && /setDrawRange/.test(mirror), '镜台有画质自适应（FPS 阈值 + drawRange 调档）');
    ok(!/style\.transform/.test(mirror), '镜台 JS 不写 DOM transform（单写入纪律）');
    ok(/onParam/.test(mirror) && /onParam/.test(read('renderer/js/fl-stage.js')), '主题参数变化通知钩子（onParam）接通');
    const flCss3 = read('renderer/css/fl-stage.css');
    ok(/data-theme="mirror"/.test(flCss3) && /data-theme="prism"/.test(flCss3), '镜台/凝彩 CSS 段就位');
    ok(/fl-prism-spin/.test(flCss3) && /--fl-p-stretch/.test(flCss3), '凝彩光锥动画 + 色散变量消费');
    ok(/--fl-mirror-ripple/.test(flCss3), '镜台 CSS 降级模式消费涟漪变量');
    // 纪律锁扩展到新主题：mirror/prism 块同样不得重写 .fl-line transform
    for (const id of ['mirror', 'prism']) {
      const blk = flCss3.split('data-theme="' + id + '"')[1] || '';
      ok(!/\.fl-line\s*\{[^}]*transform:/.test(blk.split('/* ----------')[0] || ''),
        id + ' 主题不重写 .fl-line transform（独立变换属性纪律）');
    }
    const indexHtml = read('renderer/index.html');
    ok(/js\/fl-theme-mirror\.js/.test(indexHtml), 'index.html 引入镜台注册器（three.js 本体仍懒加载）');
    ok(fs.existsSync(path.join(ROOT, 'renderer/js/vendor/three.min.js')), 'three.min.js 已内置 vendor');
    ok(/Three\.js/.test(read('renderer/js/vendor/THIRD-PARTY-LICENSES.md')), '第三方协议声明含 Three.js（MIT）');
  }

  /* ---- M4：字体仓库 + 设置区 + CSP ---- */
  {
    const flFontsJs = read('renderer/js/fl-fonts.js');
    ok(/window\.FlFonts/.test(flFontsJs), '渲染端字体管理器已注册（fl-fonts.js）');
    ok(/fl:save-font/.test(flFontsJs) && /fl:list-fonts/.test(flFontsJs)
      && /fl:delete-font/.test(flFontsJs) && /fl:read-font/.test(flFontsJs), '四个字体 IPC 都被调用');
    ok(/@font-face/.test(flFontsJs) && /data-fl-font/.test(flFontsJs), '自定义字体经 <style> 注入 @font-face');
    ok(/DEFAULT_CHAIN/.test(flFontsJs), '字体链常量存在（与 CSS 回退链同源）');
    ok(/detectSystem/.test(flFontsJs), '系统字体探测存在（canvas 宽度法）');

    const flFontsMain = read('main/fl-fonts.js');
    ok(/magicOk/.test(flFontsMain) && /extFromMagic/.test(flFontsMain), '主进程字体仓库有魔数校验');
    ok(/MAX_BYTES/.test(flFontsMain) && /MAX_COUNT/.test(flFontsMain), '主进程字体仓库有体积/容量上限');
    ok(/renameSync/.test(flFontsMain), 'index.json 原子写（tmp + rename）');

    const ipc = read('main/ipc.js');
    for (const ch of ['fl:save-font', 'fl:list-fonts', 'fl:delete-font', 'fl:read-font']) {
      ok(new RegExp("ipcMain\\.handle\\('" + ch + "'").test(ipc), ch + ' 已在主进程注册');
    }
    const preload = read('preload.js');
    for (const ch of ['fl:save-font', 'fl:list-fonts', 'fl:delete-font', 'fl:read-font']) {
      ok(preload.indexOf("'" + ch + "'") >= 0, ch + ' 在 preload 白名单');
    }
    ok(/createFlFonts/.test(mainIndexJs), '主进程入口创建字体仓库实例');

    const settings = read('renderer/js/settings.js');
    ok(/section\('set\.nav\.fl'\)/.test(settings) && /'set\.nav\.fl':\s*'全屏歌词'/.test(i18nJs),
      '设置面板有「全屏歌词」分区');
    ok(/FlFonts\.apply/.test(settings), '设置区接字体应用（FlFonts.apply）');
    ok(/FlFonts\.save/.test(settings), '设置区接字体上传（FlFonts.save）');
    ok(/set-font-box/.test(settings) && /set-font-list/.test(settings), '字体盒/列表结构类名就位');
    ok(/set-select/.test(read('renderer/css/panels.css')), '设置下拉样式已补（panels.css）');

    const indexHtml = read('renderer/index.html');
    ok(/js\/fl-fonts\.js/.test(indexHtml), 'index.html 引入 fl-fonts.js');
    ok(/font-src 'self' data:/.test(indexHtml), 'CSP 放行 data: 字体（font-src）');
    ok(/style-src 'self' 'unsafe-inline'/.test(indexHtml), 'CSP 放行 <style> 注入 @font-face（style-src unsafe-inline）');

    // 持久化键两处一致（主进程默认值 + 渲染端默认值）
    ok(/flFont/.test(mainIndexJs) && /flFont/.test(read('renderer/js/app.js')), 'flFont 默认值在主进程与渲染端都在');
  }

  /* ---- v10.9：退出修复 + 右下角封面 + 弹出光盘 ---- */
  {
    const flStage = read('renderer/js/fl-stage.js');
    const flCapsule = read('renderer/js/fl-capsule.js');
    const flCss = read('renderer/css/fl-stage.css');

    // 退出修复：navigate 双保险 + try/catch，closeTimer 绝不漏
    ok(/typeof App\.navigate === 'function'/.test(flStage) && /typeof navigate === 'function'/.test(flStage),
      'close() 导航双保险（App.navigate 缺失时回退全局 navigate）');
    ok(/导航失败不影响关闭/.test(flStage), '导航调用包 try/catch（失败绝不挡住关闭流程）');

    // 右下角播控菜单：内部大号封面 + 歌名/艺术家（v10.9.1 起封面在菜单里）
    ok(/fl-menu-cover/.test(flCapsule) && /fl-menu-title/.test(flCapsule) && /fl-menu-artist/.test(flCapsule),
      '菜单内大号封面 + 歌名 + 艺术家（封面在二级菜单内部，不再在按钮上方）');
    ok(/fl-cover-img/.test(flCapsule) && /has-cover/.test(flCapsule), '封面图与 has-cover 门控（无封面露占位光盘）');
    ok(/coverUrlOf/.test(flCapsule), '封面 URL 收敛到 coverUrlOf（signature 缺失不拼坏 URL）');
    ok(/fl-m-eject/.test(flCapsule) && /弹出光盘/.test(flCapsule), '播控菜单有「弹出光盘」项');
    ok(/forceClose/.test(flCapsule) && /App\.eject/.test(flCapsule), '弹出光盘先撤演出层再发 cd:eject');
    // 播放顺序与弹出光盘并排最下方（同一 row 内两个 half）
    ok(/const row2 = el\('div', 'fl-menu-row'\);[\s\S]{0,900}row2\.appendChild\(bMode\);[\s\S]{0,700}row2\.appendChild\(bEject\);/.test(flCapsule),
      '播放顺序与弹出光盘并排在菜单最下方（同一 row 两个 half）');
    ok(/\.fl-menu-cover\s*\{/.test(flCss) && /\.fl-menu-title\s*\{/.test(flCss) && /\.fl-menu-artist\s*\{/.test(flCss),
      '菜单封面样式就位（fl-stage.css：176px 方封面 + 标题/艺术家）');
    ok(/on\('cd:metadata'[\s\S]{0,400}FlCapsule\.sync/.test(flStage), '元数据事件同步胶囊（同曲目数/同时长不通知也有封面）');

    // 菜单底边必须高于右下角菜单钮顶沿（钮 46px + 20px 下内边距 ≈ 66px）
    const menuBottom = Number((/\.fl-menu\s*\{[^}]*bottom:\s*(\d+)px/.exec(flCss) || [])[1]);
    const menuWidth = Number((/\.fl-menu\s*\{[^}]*width:\s*(\d+)px/.exec(flCss) || [])[1]);
    const coverSize = Number((/\.fl-menu-cover\s*\{[^}]*width:\s*(\d+)px/.exec(flCss) || [])[1]);
    ok(menuBottom >= 72, '播控菜单底边高于右下角菜单钮顶沿（' + menuBottom + 'px ≥ 72px）');
    ok(menuWidth >= coverSize + 24, '菜单宽度装得下大号封面（' + menuWidth + 'px ≥ ' + (coverSize + 24) + 'px）');
  }

  /* ---- v10.9：全局歌词弹出方式（flReveal：all / line / word） ---- */
  {
    const flStage = read('renderer/js/fl-stage.js');
    const flLyrics = read('renderer/js/fl-lyrics.js');
    const flPanel = read('renderer/js/fl-panel.js');
    const flCss = read('renderer/css/fl-stage.css');
    const settingsJs = read('renderer/js/settings.js');
    const appJs = read('renderer/js/app.js');

    // DOM 分层：.fl-line 定位链 / .fl-in 揭示链（主题与弹出动画解耦的骨架）
    ok(/const inner = el\('div', 'fl-in'\)/.test(flLyrics) && /line\.appendChild\(inner\)/.test(flLyrics),
      'fl-lyrics：.fl-line > .fl-in 双层结构（揭示链专属层）');
    ok(/\.fl-in\s*\{/.test(flCss), 'fl-stage.css：.fl-in 基础规则在位');

    // 状态机：无状态量、每帧由 cur 推导；all 模式零成本跳过
    ok(/REVEAL_MODES = \['all', 'line', 'word'\]/.test(flStage), 'fl-stage：弹出方式枚举 all/line/word');
    ok(/const wantRv = \(i === cur\)/.test(flStage) && /const wantPast = \(i < cur\)/.test(flStage),
      'fl-stage：rv-on/rv-past 由 cur 推导（无状态量）');
    ok(/if \(S\.pref\.reveal !== 'all'\) \{[\s\S]{0,600}classList\.toggle\('rv-on', wantRv\)/.test(flStage),
      'fl-stage：all 模式整段跳过（零成本）');
    ok(/if \(S\.pref\.reveal === 'word'\) \{[\s\S]{0,300}classList\.toggle\('w-on', on\)/.test(flStage),
      'fl-stage：word 模式词门控走 w-on 类');
    ok(/const on = wp > 0\.001;/.test(flStage), 'fl-stage：词门控用 --wp 阈值（不引入新时间源）');
    ok(/setReveal[\s\S]{0,400}clearRevealClasses\(\)/.test(flStage), 'fl-stage：回落 all 时清揭示残留类');

    // CSS：未揭示行藏、当前行落入、过去行上飘；词门控只动 opacity/filter（不侵占主题 transform）
    ok(/data-reveal="line"[\s\S]{0,200}\.fl-line:not\(\.rv-on\):not\(\.rv-past\)\s+\.fl-in/.test(flCss),
      'fl-stage.css：line 模式未揭示行不预显');
    ok(/data-reveal="word"[\s\S]{0,200}\.fl-line\.rv-on\s+\.fl-w\s*\{[^}]*opacity:\s*0/.test(flCss),
      'fl-stage.css：word 模式未唱词默认隐藏');
    ok(/data-reveal="word"[\s\S]{0,400}\.w-on\s*\{[^}]*opacity:\s*1/.test(flCss), 'fl-stage.css：唱到的词浮现');

    // 控件两处：演出层面板 chip 组 + 设置窗口下拉（同键 flReveal）
    ok(/fl-reveal-chip/.test(flPanel) && /REVEAL_OPTS/.test(flPanel), 'fl-panel：弹出方式 chip 三选一');
    ok(/syncRevealFromStage/.test(flPanel), 'fl-panel：程序化切换后面板 chip 对齐（dataset.reveal 真相源）');
    ok(/set-fl-reveal/.test(settingsJs) && /FlStage\.setReveal/.test(settingsJs), 'settings.js：全屏歌词区「弹出方式」下拉');
    ok(/flReveal: 'all'/.test(appJs), 'app.js：渲染端默认 flReveal=all');
    ok(/flReveal: 'all'/.test(read('main/index.js')), '主进程默认 flReveal=all（持久化键两处一致）');
  }

  /* ---- v10.9：两个 3D 运镜主题（跃迁 Warp / 星环 Halo） ---- */
  {
    const flThemes = read('renderer/js/fl-themes.js');
    const flCss = read('renderer/css/fl-stage.css');

    // 注册：type '3d' + 各 3 个参数滑条（舞台级 --fl-p-* 唯一真相源）
    ok(/id: 'warp'[\s\S]{0,400}type: '3d'/.test(flThemes), 'fl-themes：跃迁注册为 3d 类型');
    ok(/id: 'halo'[\s\S]{0,400}type: '3d'/.test(flThemes), 'fl-themes：星环注册为 3d 类型');
    ok(/'depth'/.test(flThemes) && /'sway'/.test(flThemes) && /'push'/.test(flThemes) && /'dash'/.test(flThemes), '跃迁参数 depth/sway/push/dash');
    ok(/'radius'/.test(flThemes) && /'spread'/.test(flThemes) && /'dash'/.test(flThemes), '星环参数 radius/spread/dash');

    // 运镜 rig：唯一写入点是 #fl-lyrics 自身（不新增 DOM），定位链 transform 归舞台
    ok(/function makeCamRig\(ctx, opt\)/.test(flThemes), 'fl-themes：共用运镜 rig makeCamRig');
    ok(/lyrics\.style\.transform = 'rotateX\(' \+ pitch\.toFixed\(2\)/.test(flThemes),
      'rig 每帧写一次 #fl-lyrics transform（环绕 + 推轨 + 升降 + 穿梭合成）');
    ok(!/rec\.el\.style\.transform/.test(flThemes.slice(flThemes.indexOf('makeCamRig'))),
      'rig 绝不写 .fl-line 的 transform（定位链归舞台，纪律锁）');
    ok(/lyrics\.style\.transform = ''/.test(flThemes), 'rig dispose 清空 rig transform（切主题不留残镜）');
    ok(/tween\.stop\(cut\); tween\.stop\(intro\)/.test(flThemes) && /removeEventListener\('pointermove', onMove\)/.test(flThemes),
      'rig dispose 停止代理补间 + 移除指针监听');
    ok(/if \(k <= 0\.001 \|\| !tween\) return;/.test(flThemes), '补间缺失 / 强度为 0 时静默降级（穿梭可无）');
    ok(/tween\.fromTo\(cut/.test(flThemes) && /tween\.fromTo\(intro/.test(flThemes), '补间只做一次性编排（cut/intro 代理对象），不进逐帧热路径');
    ok(!/gsap/i.test(read('renderer/js/fl-themes.js')), 'fl-themes 已无 GSAP 引用');
    ok(!fs.existsSync(path.join(ROOT, 'renderer/js/vendor/gsap.min.js')), 'GSAP 文件已删除（专有许可与 GPLv3 冲突）');

    // 换行穿梭（v10.9.1）：Z 前冲 + 横向闪避，方向交替；强度读 --fl-p-dash
    ok(/dash\(dir\) \{[\s\S]{0,300}amp\('dash', 1\)/.test(flThemes), 'rig：换行穿梭 dash(dir)，强度读 --fl-p-dash');
    ok(/push: opt\.dashPush \* k, x: dir \* opt\.dashX \* k, y: -dir \* opt\.dashY \* k/.test(flThemes),
      '穿梭三通道：Z 前冲 + 横向闪避（方向交替编织）');
    ok(/dashPush:/.test(flThemes) && /dashX:/.test(flThemes) && /dashY:/.test(flThemes), '两个主题都声明了穿梭幅度（dashPush/dashX/dashY）');
    ok(/cut\.x\.toFixed\(1\)/.test(flThemes), 'rig frame 合成 cut.x 横移（translate3d 三通道齐全）');

    // 三维上下文：#fl-stage 出 perspective 当镜头；rig/行/词三层 preserve-3d
    ok(/#fl-stage\[data-theme="warp"\]\s*\{\s*\n\s*perspective: 1150px/.test(flCss) && /#fl-stage\[data-theme="halo"\]\s*\{\s*\n\s*perspective: 1150px/.test(flCss),
      'fl-stage.css：两个 3d 主题都出 perspective=1150px（摄影机镜头）');
    ok(/#fl-stage\[data-theme="warp"\] #fl-lyrics \{[^}]*transform-style: preserve-3d/.test(flCss)
      && /#fl-stage\[data-theme="halo"\] #fl-lyrics \{[^}]*transform-style: preserve-3d/.test(flCss),
      'fl-stage.css：#fl-lyrics preserve-3d（rig 是摄影机）');
    ok(/#fl-stage\[data-theme="warp"\] \.fl-in \{ transform-style: preserve-3d; \}/.test(flCss)
      && /#fl-stage\[data-theme="halo"\] \.fl-in \{ transform-style: preserve-3d; \}/.test(flCss),
      'fl-stage.css：.fl-in 也 preserve-3d（否则词的 translateZ 全废）');

    // 拍平纪律：opacity/filter 会 flatten 子树 3D——3d 主题把行 opacity 钉 1，景深改由 Z + 字色 alpha 承担
    ok(/#fl-stage\[data-theme="warp"\] \.fl-line \{[\s\S]{0,600}opacity: 1/.test(flCss),
      'fl-stage.css：3d 主题 .fl-line opacity 钉 1（保 3D 上下文，纪律锁）');
    ok(/max\(0\.24,/.test(flCss), 'fl-stage.css：距离衰减改由字色 alpha 承担（非 opacity）');

    // 行/词排布只动 translate/rotate 独立属性（--d/--ad 驱动），不碰 .fl-line 的 transform
    ok(/#fl-stage\[data-theme="warp"\] \.fl-line \{[\s\S]{0,700}translate: 0 0 calc\(var\(--ad, 0\) \* var\(--fl-p-depth, 1\) \* -64px\)/.test(flCss),
      'fl-stage.css：跃迁行按距离沉入 Z（translate 独立属性，v10.9.1 行距拉近到 64px）');
    ok(/#fl-stage\[data-theme="halo"\] \.fl-line \{[\s\S]{0,900}0\.0174533/.test(flCss),
      'fl-stage.css：星环圆环几何多项式近似（deg→rad + sin/cos 近似，Chromium 108 无 CSS sin/cos）');
    ok(/θ³\/6|θ³|var\(--fl-halo-t\) \* var\(--fl-halo-t\) \* var\(--fl-halo-t\) \/ 6/.test(flCss),
      'fl-stage.css：多项式系数在（θ - θ³/6 / -θ²/2 + θ⁴/24）');

    // word 联动：3d 主题的词级 Z 弹出（未唱沉深处，唱到归位）
    ok(/#fl-stage\[data-theme="warp"\]\[data-reveal="word"\] \.fl-line\.rv-on \.fl-w \{\s*translate: 0 0 -46px;/.test(flCss)
      && /#fl-stage\[data-theme="halo"\]\[data-reveal="word"\] \.fl-line\.rv-on \.fl-w \{\s*translate: 0 0 -40px;/.test(flCss),
      'fl-stage.css：两个 3d 主题 word 模式未唱词沉 Z 深处');
    ok(/#fl-stage\[data-theme="warp"\]\[data-reveal="word"\] \.fl-line\.rv-on \.fl-w\.w-on \{ translate: 0 0 0; \}/.test(flCss)
      && /#fl-stage\[data-theme="halo"\]\[data-reveal="word"\] \.fl-line\.rv-on \.fl-w\.w-on \{ translate: 0 0 0; \}/.test(flCss),
      'fl-stage.css：唱到的词弹出归位（w-on → z=0）');
  }

  /* ---- v10.9.1：选歌面板（fl-tracks） ---- */
  {
    const flTracks = read('renderer/js/fl-tracks.js');
    const flStage = read('renderer/js/fl-stage.js');
    const flCss = read('renderer/css/fl-stage.css');
    const indexHtml = read('renderer/index.html');

    ok(/window\.FlTracks/.test(flTracks) && /panel\.id = 'fl-tracks'/.test(flTracks), 'fl-tracks：选歌面板模块与容器');
    ok(/App\.playTrack/.test(flTracks), 'fl-tracks：点行走 App.playTrack（主界面同一切歌链路）');
    ok(/TOC 定数与时长|tocTracks/.test(flTracks) && /byNum\[t\.number\] = t/.test(flTracks), 'fl-tracks：TOC 定数定时长、元数据补标题/艺术家');
    ok(/sig !== S\.sig/.test(flTracks) && /S\.cur = -1;/.test(flTracks), 'fl-tracks：列表身份不变不重建，只更新高亮');
    ok(/scrollIntoView/.test(flTracks), 'fl-tracks：当前曲目滚入视野');
    // 接线：顶栏按钮 + 快捷键 L + Escape 层级 + chrome 保持 + 事件同步 + 关窗清理
    ok(/fl-tracks-btn/.test(flStage) && /FlTracks\.toggle\(\)/.test(flStage), 'fl-stage：顶栏选歌按钮接线');
    ok(/case 'l': case 'L':[\s\S]{0,200}FlTracks\.toggle/.test(flStage), 'fl-stage：快捷键 L 开合选歌');
    ok(/FlPanel\.isOpen\(\)\) FlPanel\.close\(\);[\s\S]{0,120}else if \(FlTracks\.isOpen\(\)\) FlTracks\.close\(\);/.test(flStage),
      'fl-stage：Escape 先关选歌面板（层级：主题面板 → 选歌 → 播控菜单 → 退出）');
    ok(/FlPanel\.isOpen\(\) \|\| FlTracks\.isOpen\(\) \|\| menuOpen\(\)/.test(flStage), 'fl-stage：选歌开着时铬件不收起');
    ok(/FlTracks\.mount\(S\.stage\)/.test(flStage) && /FlTracks\.sync\(\)/.test(flStage), 'fl-stage：挂载 + 元数据/传输变化时同步');
    ok(/FlTracks\.close\(\);/.test(flStage), 'fl-stage：关窗清理选歌面板');
    ok(/js\/fl-tracks\.js/.test(indexHtml), 'index.html：fl-tracks.js 引入');
    ok(/\.fl-tracks\s*\{/.test(flCss) && /\.fl-track-row\s*\{/.test(flCss) && /\.fl-track-empty/.test(flCss), 'fl-stage.css：选歌面板与行样式 + 空态');
  }

  /* ---- 多语言布局 + 开源协议（v10.12） ---- */
  {
    const panelsCss = read('renderer/css/panels.css');
    const pkg = JSON.parse(read('package.json'));

    /* 俄文设置分类：150px 侧栏下「Воспроизведение」实测文本 101px、
       可用宽度仅 69px，直接顶穿右边框（改前溢出 49px）。 */
    const navW = panelsCss.match(/\.set-nav\s*\{[^}]*?width:\s*(\d+)px/);
    ok(!!navW && Number(navW[1]) >= 176, '设置侧栏宽度 ≥176px（俄文长词不溢出）',
      navW && navW[1]);
    ok(/\.set-nav-item\s*>\s*span\s*\{[^}]*min-width:\s*0/.test(panelsCss),
      '侧栏标签 min-width:0（flex 项可缩，长词换行而不是顶穿）');
    ok(/html\[lang="ru"\]\s+\.set-nav-item\s*\{[^}]*(letter-spacing|font-size)/.test(panelsCss),
      '俄文侧栏单独收紧字距/字号');

    ok(pkg.license === 'GPL-3.0-or-later', 'package.json 声明 GPL-3.0-or-later', pkg.license);
    const lic = read('LICENSE');
    ok(/GNU GENERAL PUBLIC LICENSE/.test(lic) && /Version 3, 29 June 2007/.test(lic),
      'LICENSE 为 GPLv3 全文');
    ok(pkg.build && pkg.build.files.indexOf('LICENSE') >= 0, 'LICENSE 打进应用包');
    ok(!!pkg.build.extraResources && pkg.build.extraResources.some((r) => r.from === 'LICENSE'),
      '安装目录另附 LICENSE.txt（GPLv3 第 6 条随包附协议）');
    ok(/\.txt$/.test(pkg.build.nsis.license), 'NSIS 安装向导有协议页');
    ok(read('THIRD-PARTY-LICENSES.md').length > 500, '第三方组件许可清单存在');
    ok(/GPL-3\.0-or-later|GPLv3/.test(read('README.md')), 'README 许可证段为 GPLv3');
    ok(/set\.about\.license\.label/.test(settingsJs), '关于页展示开源协议');
    ok(!!pkg.build.copyright && /ShiGuang Studio/.test(pkg.build.copyright),
      '安装包版权信息存在');
  }

  console.log('\n' + (fail ? fail + ' 个断言未通过' : 'ALL PASS（' + pass + ' 断言）'));
  process.exit(fail ? 1 : 0);
}

main();
