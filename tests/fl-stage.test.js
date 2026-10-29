'use strict';
/* ============================================================
   fl-stage.test.js —— 全屏歌词演出层（v10.8）整链路测试
   ------------------------------------------------------------
   覆盖：
     1) 外壳构建 / 开关 / 退碟强制关闭（演出层不能盖住读盘场景）
     2) 歌词装载（词级模型 / 经典 LRC / 空态 / 切轨重建 / 歌词后到）
     3) 每帧行定位（--d/--ad）+ 词级填充（--wp）+ 窗口外剔除
     4) 旧界面停渲守卫（tickLoop 不再驱动隐藏 DOM）
     5) 快捷键让位（空格只被处理一次；Esc/F/T）
     6) 主题面板（主题卡 / 字号 / 译音开关 / 持久化）
     7) 小胶囊（轻点播放暂停 / 长按拖进度 / 滚轮音量 / 播控菜单）
     8) 封面色板取色在无 canvas 环境下安全降级
     9) v10.9：正在播放页退出回归（navigate 拼错曾吞掉 closeTimer）
     10) v10.9：右下角专辑封面 + 播控菜单「弹出光盘」
     11) v10.9：歌词弹出方式（all / line / word，.fl-in 揭示链与主题解耦）

   运行：node tests/fl-stage.test.js（需要 jsdom，缺失自动跳过）
   ============================================================ */

const fs = require('fs');
const path = require('path');
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; } catch (e) {
  console.log('[skip] 需要 jsdom：npm i jsdom');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'file://' + path.join(__dirname, '..', 'renderer', 'index.html'),
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const w = dom.window;

/* ---- 可控时钟（Transport 墙钟模型依赖 performance.now） ---- */
let CLOCK = 1000;
Object.defineProperty(w.performance, 'now', { value: () => CLOCK, configurable: true });
const advance = (ms) => { CLOCK += ms; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- jsdom 缺失 API 桩 ---- */
w.HTMLElement.prototype.setPointerCapture = function () {};
w.HTMLElement.prototype.releasePointerCapture = function () {};
w.HTMLElement.prototype.scrollTo = function () {};
// canvas 在无 node-canvas 时 getContext 返回 null —— fl-stage 已容错，这里显式桩掉避免告警
w.HTMLCanvasElement.prototype.getContext = function () { return null; };

/* ---- 词级歌词夹具：14 行，每行 4 秒，前两行带词级时间 ---- */
function makeWordLines() {
  const lines = [];
  for (let i = 0; i < 14; i++) {
    const t = i * 4;
    const l = { t: t, e: t + 4, text: '第' + (i + 1) + '句歌词' };
    if (i === 0) l.words = [{ t: 0, e: 1, x: '第一' }, { t: 1, e: 2.5, x: '句' }, { t: 2.5, e: 4, x: '歌词' }];
    if (i === 1) { l.tr = 'the second line'; l.words = [{ t: 4, e: 6, x: '第二' }, { t: 6, e: 8, x: '句歌词' }]; }
    lines.push(l);
  }
  return lines;
}

const META = {
  signature: 'sig-fl', album: '演出专辑', artist: '演出艺术家', year: 2024, trackCount: 2, hasCover: false,
  tracks: [
    {
      number: 1, title: '词级曲', artist: '演出艺术家', durationSec: 60, lyricsSynced: true,
      lyricsData: { v: 1, source: 'amll', isWordByWord: true, quality: 130, lines: makeWordLines() }
    },
    {
      number: 2, title: '行级曲', artist: '演出艺术家', durationSec: 60, lyricsSynced: true,
      lyrics: '[00:00.00]行级甲\n[00:04.00]行级乙\n[00:08.00]行级丙'
    }
  ]
};
const TOC = { first: 1, last: 2, leadout: 9000, tracks: [{ number: 1, startFrame: 0, endFrame: 4500, audio: true }, { number: 2, startFrame: 4500, endFrame: 9000, audio: true }] };

/* 对唱夹具（M2 群唱主题用）：双 agent + 第三行带背景人声 */
const META2 = {
  signature: 'sig-fl2', album: '合唱专辑', artist: '合唱艺术家', year: 2024, trackCount: 1, hasCover: false,
  tracks: [
    {
      number: 1, title: '对唱曲', artist: '合唱艺术家', durationSec: 40, lyricsSynced: true,
      lyricsData: {
        v: 1, source: 'amll', isWordByWord: true, quality: 130,
        lines: [
          { t: 0, e: 4, text: '男主唱', agent: 'v1', words: [{ t: 0, e: 2, x: '男主' }, { t: 2, e: 4, x: '唱' }] },
          { t: 4, e: 8, text: '女主唱', agent: 'v2', words: [{ t: 4, e: 6, x: '女主' }, { t: 6, e: 8, x: '唱' }] },
          { t: 8, e: 12, text: '合唱', agent: 'v1', words: [{ t: 8, e: 10, x: '合' }, { t: 10, e: 12, x: '唱' }], bg: [{ t: 8, e: 12, text: '背景人声', agent: 'v2' }] }
        ]
      }
    }
  ]
};

/* ---- IPC 假实现 ---- */
const listeners = new Map();
const invoked = [];
w.cd = {
  on(ch, cb) {
    if (!listeners.has(ch)) listeners.set(ch, []);
    listeners.get(ch).push(cb);
    return () => {};
  },
  invoke(ch, ...args) {
    invoked.push({ ch: ch, args: args });
    switch (ch) {
      case 'settings:get': return Promise.resolve({ flTheme: 'lumen', flSize: 34, flShowTr: true, flShowRo: true, defaultVolume: 0.7, visualFx: true });
      case 'settings:set': return Promise.resolve(Object.assign({}, args[0]));
      case 'cd:get-state': return Promise.resolve({ phase: 'ready', playState: 'stopped', track: 1, positionSec: 0, durationSec: 60, engine: 'mci', volumeSupported: true, trackCount: 2, mode: 'normal', signature: 'sig-fl' });
      case 'cd:get-toc': return Promise.resolve(TOC);
      case 'cd:get-metadata': return Promise.resolve(META);
      case 'meta:list': return Promise.resolve([META]);
      case 'app:win-state': return Promise.resolve({ maximized: false, fullScreen: false });
      /* 字体仓库（M4）：默认假实现，M4 测试节可整体替换 w.cd.invoke 的这几个分支 */
      case 'fl:list-fonts': return Promise.resolve({ ok: true, fonts: [] });
      case 'fl:read-font': return Promise.resolve({ ok: false, error: 'no-font' });
      case 'fl:save-font': return Promise.resolve({ ok: false, error: 'stub' });
      case 'fl:delete-font': return Promise.resolve({ ok: true });
      default: return Promise.resolve(null);
    }
  }
};
function emit(ch, payload) {
  const arr = listeners.get(ch) || [];
  for (const cb of arr) cb(payload);
}
function lastInvoke(ch) {
  for (let i = invoked.length - 1; i >= 0; i--) if (invoked[i].ch === ch) return invoked[i];
  return null;
}

/* ---- 加载渲染端脚本（顺序与 index.html 一致；单 bundle 一次 eval，
       让各文件的 const 声明共享同一作用域——与 renderer.test.js 同法。
       tween 也一并载入：主题补间走 renderer/js/tween.js（v10.12 起无 GSAP） ---- */
const files = ['js/i18n.js', 'js/audio.js', 'js/transport.js', 'js/scene.js', 'js/visualizer.js', 'js/library.js', 'js/album.js', 'js/lyrics-view.js', 'js/nowplaying.js', 'js/edit.js', 'js/settings.js', 'js/smtc.js'];
let bundle = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
try { bundle += '\n;\n' + fs.readFileSync(path.join(ROOT, 'js/tween.js'), 'utf8'); } catch (e) { /* 无补间模块：主题静默降级 */ }
bundle += '\n;\n' + ['js/fl-lyrics.js', 'js/fl-themes.js', 'js/fl-theme-mirror.js', 'js/fl-capsule.js', 'js/fl-panel.js', 'js/fl-tracks.js', 'js/fl-stage.js', 'js/fl-fonts.js']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
bundle += '\n;\n' + fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
bundle += '\n;window.__t = { tickLoop, navigate, Transport, App, FlStage, FlThemes, FlLyrics, FlCapsule, FlPanel, FlTracks, FlFonts, NowPlaying, SettingsPanel };';
w.eval(bundle);

/* ---- 断言工具 ---- */
let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const $ = (id) => w.document.getElementById(id);
const stage = () => $('fl-stage');
const flush = () => new Promise((r) => setImmediate(r));
/** 跑若干动画帧（jsdom rAF ≈16ms 一拍），让主控的 frame() 执行 */
async function frames(n) {
  for (let i = 0; i < (n || 3); i++) await sleep(20);
}
/** 读元素 inline style 里的 CSS 自定义属性 */
function cssVar(el, name) {
  const s = (el && el.getAttribute('style')) || '';
  const m = new RegExp('--' + name + ':\\s*([^;]+)').exec(s);
  return m ? m[1].trim() : null;
}
function htmlCls() { return w.document.documentElement.className; }

(async () => {
  await new Promise((r) => {
    if (w.document.readyState === 'complete') return r();
    w.addEventListener('load', () => r());
    setTimeout(r, 2000);
  });
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await flush(); await flush(); await flush();

  /* ================================================================
   * 1) 外壳构建与初始化
   * ================================================================ */
  console.log('# 1. 演出层外壳与初始化');
  check('FlStage 已注册', !!w.FlStage && typeof w.FlStage.open === 'function');
  check('#fl-stage 已挂到 #app', !!stage(), stage() && stage().parentElement.id);
  check('初始隐藏', stage().classList.contains('hidden'));
  check('初始未激活旧界面停渲', htmlCls().indexOf('fl-active') < 0, htmlCls());
  check('默认主题=lumen', stage().dataset.theme === 'lumen', stage().dataset.theme);
  check('字号写入 --fl-size=34px', cssVar(stage(), 'fl-size') === '34px', cssVar(stage(), 'fl-size'));
  check('主题注册表 8 个（流光/倾诉/回环/群唱/凝彩/镜台/跃迁/星环）', w.FlThemes.list().length === 8 && w.FlThemes.list()[0].id === 'lumen', w.FlThemes.list().map((d) => d.id));
  check('入口按钮已加入传输条工具组', !!$('np-fl-stage'));

  /* 起播 + 元数据 */
  emit('cd:metadata', { metadata: META, fromCache: true });
  await flush(); await flush();
  emit('cd:state', { state: 'playing', track: 1, positionSec: 0, durationSec: 60, trackCount: 2, engine: 'mci', reason: 'play' });
  await flush();

  /* ================================================================
   * 2) 打开：旧界面停渲 + 歌词装载
   * ================================================================ */
  console.log('# 2. 打开演出层');
  w.FlStage.open();
  await flush();
  check('舞台可见', !stage().classList.contains('hidden'));
  check('html.fl-active 生效', htmlCls().indexOf('fl-active') >= 0, htmlCls());
  check('aria-hidden 打开', stage().getAttribute('aria-hidden') === 'false');
  const st = w.__t.FlStage.debugState();
  check('词级模型装载 14 行', st.built && st.built.count === 14, st.built && st.built.count);
  check('word-mode 类已置位', stage().classList.contains('word-mode'));
  check('译文行存在（第二行 tr）', !!w.document.querySelector('#fl-lyrics .fl-tr'));
  check('胶囊已挂载', !!$('fl-capsule') && !!$('fl-menu-btn'));

  /* ================================================================
   * 3) 每帧行定位与词填充
   * ================================================================ */
  console.log('# 3. 行定位 / 词填充 / 窗口剔除');
  advance(5000);                       // 墙钟推进 5s → 第 2 行（t=4）为当前行
  await frames(4);
  const recs = w.__t.FlStage.debugState().built.recs;
  check('当前行=1（pos=5）', w.__t.FlStage.debugState().active === 1, w.__t.FlStage.debugState().active);
  check('当前行挂 active 类', recs[1].el.classList.contains('active'));
  check('非当前行无 active 类', !recs[0].el.classList.contains('active'));
  const d0 = parseFloat(cssVar(recs[0].el, 'd'));
  const d1 = parseFloat(cssVar(recs[1].el, 'd'));
  check('第 1 行 --d≈-1.x（滑到当前行上方）', d0 <= -0.9 && d0 >= -1.6, d0);
  check('第 2 行 --d≈0.x（就近归位）', Math.abs(d1) < 0.7, d1);
  check('--ad 已写入', parseFloat(cssVar(recs[0].el, 'ad')) > 0.5);
  check('窗口外行（第 12 行）挂 fl-out', recs[12].el.classList.contains('fl-out'));
  check('窗口内行（第 2 行）未挂 fl-out', !recs[1].el.classList.contains('fl-out'));

  // 词级填充：当前行是第 2 行（t=4）——只有当前行填充
  // pos=5 → 第二(4~6) wp=0.5，句歌词(6~8) wp=0；第 1 行非当前行，不写 --wp
  const words = recs[1].words;
  check('当前行词 span 已建', words.length === 2, words.length);
  const wp0 = parseFloat(cssVar(words[0].el, 'wp'));
  const wp1 = parseFloat(cssVar(words[1].el, 'wp'));
  check('词1 --wp=0.5（唱到一半）', Math.abs(wp0 - 0.5) < 0.03, wp0);
  check('词2 --wp=0（未唱）', wp1 === 0, wp1);
  // 非当前行的填充值必须冻结——不跟随 pos=5 继续涨（否则就是"全曲同时填充"的 bug）。
  // 注意这里允许「从没写过」：本节直接在 pos=5 打开，第 1 行可能一次都没当过
  // 当前行，于是它的词压根没有 --wp；真正的契约是"不涨"，不是"必须有 0.000"。
  const w2 = recs[0].words[2] && recs[0].words[2].el;
  const v2 = cssVar(w2, 'wp');
  check('非当前行填充值冻结（不跟随 pos 上涨）', v2 === null || parseFloat(v2) === 0, v2);

  advance(2000);                       // pos=7 → 当前行仍为 2，词1 唱满、词2 进行中
  await frames(4);
  check('词1 唱满 --wp=1', Math.abs(parseFloat(cssVar(recs[1].words[0].el, 'wp')) - 1) < 0.01);
  check('词2 进行中 0<wp<1', (() => { const v = parseFloat(cssVar(recs[1].words[1].el, 'wp')); return v > 0.01 && v < 0.99; })());

  /* ================================================================
   * 4) 旧界面停渲守卫
   * ================================================================ */
  console.log('# 4. 旧界面停渲');
  // 打开前旧歌词引擎已在 pos=0 高亮第 1 行 —— 演出层打开后它必须被冻结
  const oldActiveEl = w.document.querySelector('#page-nowplaying .lrc-line.active');
  const oldActiveText = oldActiveEl && oldActiveEl.textContent;
  const seekSlider = w.document.querySelector('.np-seek input.slider');
  seekSlider.max = '1000';             // 先抬上限，避免 range 钳制（max 默认=时长 60）
  seekSlider.value = '77';
  advance(1000);
  w.__t.tickLoop();
  check('tickLoop 被守卫短路（滑块停在 77）', seekSlider.value === '77', seekSlider.value);
  const oldActiveNow = w.document.querySelector('#page-nowplaying .lrc-line.active');
  check('旧歌词引擎被冻结（仍是打开前那一行）', oldActiveNow === oldActiveEl && oldActiveNow && oldActiveNow.textContent === oldActiveText,
    oldActiveNow && oldActiveNow.textContent);

  /* ================================================================
   * 5) 快捷键让位
   * ================================================================ */
  console.log('# 5. 快捷键');
  invoked.length = 0;
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  await flush();
  check('空格只触发一次暂停（Shortcuts 让位，无重复处理）', invoked.filter((x) => x.ch === 'cd:pause' || x.ch === 'cd:resume').length === 1, invoked.map((x) => x.ch));
  check('当前为 paused', w.__t.Transport.status === 'paused', w.__t.Transport.status);

  invoked.length = 0;
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'F', bubbles: true, cancelable: true }));
  await flush();
  check('F 走全屏通道', !!lastInvoke('app:win-fullscreen'));

  invoked.length = 0;
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
  await flush();
  check('T 打开主题面板', !$('fl-panel').classList.contains('hidden'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await flush();
  check('Esc 先关面板（舞台仍开着）', $('fl-panel').classList.contains('hidden') && !stage().classList.contains('hidden'));

  /* ================================================================
   * 6) 主题面板
   * ================================================================ */
  console.log('# 6. 主题面板');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
  await flush();
  const cards = w.document.querySelectorAll('#fl-panel .fl-theme-card');
  check('渲染 8 张主题卡', cards.length === 8, cards.length);
  check('当前卡高亮', cards[0].classList.contains('on'));

  const sizeInput = w.document.querySelector('#fl-panel .fl-param-row input[aria-label="歌词字号"]');
  sizeInput.value = '44';
  sizeInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  await flush();
  check('字号滑条 → --fl-size=44px', cssVar(stage(), 'fl-size') === '44px', cssVar(stage(), 'fl-size'));
  check('字号已持久化', lastInvoke('settings:set') && lastInvoke('settings:set').args[0].flSize === 44, lastInvoke('settings:set'));

  const bodyBtns = w.document.querySelectorAll('#fl-panel .fl-panel-body .fl-panel-btn');
  check('译/音两个开关按钮', bodyBtns.length === 2, bodyBtns.length);
  bodyBtns[0].dispatchEvent(new w.Event('click', { bubbles: true }));
  await flush();
  check('关翻译 → no-tr 类', stage().classList.contains('no-tr'));
  check('关翻译 → 持久化 flShowTr:false', lastInvoke('settings:set').args[0].flShowTr === false, lastInvoke('settings:set').args[0]);
  bodyBtns[0].dispatchEvent(new w.Event('click', { bubbles: true }));
  await flush();
  check('再点恢复 → no-tr 移除', !stage().classList.contains('no-tr'));

  // 点面板外关闭
  w.document.body.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }));
  await flush();
  check('点击面板外关闭', $('fl-panel').classList.contains('hidden'));

  /* ================================================================
   * 6.5) M2：三大主题 + 参数滑条
   * ================================================================ */
  console.log('# 6.5. M2 三大主题与参数');
  check('注册表 8 个主题', w.FlThemes.list().length === 8, w.FlThemes.list().map((d) => d.id));
  check('主题顺序 = 流光/倾诉/回环/群唱/凝彩/跃迁/星环/镜台', w.FlThemes.list().map((d) => d.id).join(',') === 'lumen,whisper,orbit,chorus,prism,warp,halo,mirror');
  check('默认主题仍是流光', w.FlThemes.defaultTheme().id === 'lumen');
  check('Whisper 声明 2 个参数', w.FlThemes.get('whisper').params.length === 2);
  check('Orbit 声明 2 个参数', w.FlThemes.get('orbit').params.length === 2);
  check('Chorus 声明 2 个参数', w.FlThemes.get('chorus').params.length === 2);
  check('Lumen 无参数', !w.FlThemes.get('lumen').params);

  // 打开面板 → 4 张卡 → 切 Whisper（setTheme 有 200ms veil，需等待）
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
  await flush();
  const cards2 = w.document.querySelectorAll('#fl-panel .fl-theme-card');
  check('面板渲染 8 张主题卡', cards2.length === 8, cards2.length);

  w.document.querySelector('#fl-panel .fl-theme-card[data-theme="whisper"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(280);
  check('切到 whisper → data-theme', stage().dataset.theme === 'whisper', stage().dataset.theme);
  check('whisper 默认 sway=7', cssVar(stage(), 'fl-p-sway') === '7', cssVar(stage(), 'fl-p-sway'));
  check('whisper 默认 soft=0.9', cssVar(stage(), 'fl-p-soft') === '0.9', cssVar(stage(), 'fl-p-soft'));
  const swayInput = w.document.querySelector('#fl-panel .fl-param-box input[aria-label^="倾诉"]');
  check('参数区渲染 sway 滑条', !!swayInput);
  if (swayInput) {
    swayInput.value = '12';
    swayInput.dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
    check('滑条 → --fl-p-sway=12', cssVar(stage(), 'fl-p-sway') === '12', cssVar(stage(), 'fl-p-sway'));
    check('参数持久化 flParams.whisper.sway=12', (() => { const s = lastInvoke('settings:set'); return !!s && !!s.args[0].flParams && !!s.args[0].flParams.whisper && s.args[0].flParams.whisper.sway === 12; })(), lastInvoke('settings:set'));
  }

  // 切 Orbit → whisper 变量清掉、orbit 默认值写入
  w.document.querySelector('#fl-panel .fl-theme-card[data-theme="orbit"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(280);
  check('切到 orbit → data-theme', stage().dataset.theme === 'orbit', stage().dataset.theme);
  check('orbit 默认 spread=1.1', cssVar(stage(), 'fl-p-spread') === '1.1', cssVar(stage(), 'fl-p-spread'));
  check('whisper 的 sway 变量已清', cssVar(stage(), 'fl-p-sway') === null, cssVar(stage(), 'fl-p-sway'));

  // setThemeParam 钳制 + themeParams 读取
  w.FlStage.setThemeParam('spread', 99);
  await flush();
  check('spread=99 被钳到 2.4', cssVar(stage(), 'fl-p-spread') === '2.4', cssVar(stage(), 'fl-p-spread'));
  check('themeParams() 反映现值', w.FlStage.themeParams().spread === 2.4, w.FlStage.themeParams());

  // Chorus 主题契约：onLine 打/摘 has-bg
  const chorusH = w.FlThemes.get('chorus').mount(w.FlThemes.makeCtx(stage()));
  const fakeRec = { el: w.document.createElement('div'), bgs: [{ el: null, words: [], t: 0, e: 1, agent: 'v2' }] };
  fakeRec.el.className = 'fl-line';
  fakeRec.el.appendChild(w.document.createElement('span')).className = 'fl-bg';
  chorusH.onLine(fakeRec);
  check('Chorus onLine 打 has-bg 标记', fakeRec.el.classList.contains('has-bg'));
  const fakeRec2 = { el: w.document.createElement('div'), bgs: [] };
  fakeRec2.el.className = 'fl-line';
  chorusH.onLine(fakeRec2);
  check('无 bg 的行移除 has-bg', !fakeRec2.el.classList.contains('has-bg'));

  // Orbit 主题契约：frame 写相位（15fps 节流，一次 0.5s 大步足够触发）+ dispose 归零
  const orbitH = w.FlThemes.get('orbit').mount(w.FlThemes.makeCtx(stage()));
  orbitH.frame(0.5, { pos: 0, pulse: 0, bass: 0, level: 0 });
  check('Orbit frame 写 --fl-orbit-phase', /^-?\d\.\d{3}$/.test(cssVar(stage(), 'fl-orbit-phase') || ''), cssVar(stage(), 'fl-orbit-phase'));
  orbitH.dispose();
  check('Orbit dispose 相位归零', cssVar(stage(), 'fl-orbit-phase') === '0', cssVar(stage(), 'fl-orbit-phase'));

  // 对唱集成：换带（新签名触发重建）→ Chorus 下 duet-line / has-bg 就位
  w.FlStage.setTheme('chorus', { persist: false });
  await sleep(280);
  emit('cd:metadata', { metadata: META2, fromCache: true });
  await flush(); await flush();
  emit('cd:state', { state: 'playing', track: 1, positionSec: 0, durationSec: 40, trackCount: 1, engine: 'mci' });
  await frames(6);
  const recs2 = w.__t.FlStage.debugState().built.recs;
  check('对唱带重建出 3 行', recs2.length === 3, recs2.length);
  check('第二行是 duet-line（非主唱声线）', !!recs2[1] && recs2[1].el.classList.contains('duet-line'));
  emit('cd:state', { state: 'playing', track: 1, positionSec: 9, durationSec: 40, trackCount: 1, engine: 'mci' });
  await frames(4);
  check('合唱行（t=8）活跃且带 has-bg', !!recs2[2] && recs2[2].el.classList.contains('active') && recs2[2].el.classList.contains('has-bg'), recs2[2] && recs2[2].el.className);
  check('Chorus 下 bg 块在 DOM 中', !!recs2[2] && recs2[2].el.querySelectorAll('.fl-bg').length === 1);

  // 面板参数区跟随程序化切主题（setTheme → FlPanel.syncParams）
  // 先显式关面板再按 t 开：6.5 前面用例点开的面板可能还开着，
  // 不显式归位的话 t 会变成"关面板"、随后的 Esc 就会误关演出层
  w.FlPanel.close();
  await flush();
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
  await flush();
  const paramRows = w.document.querySelectorAll('#fl-panel .fl-param-box .fl-param-row');
  check('程序化切到 chorus 后面板出现 2 个参数行', paramRows.length === 2, paramRows.length);
  check('参数行是分列间距/人声放大', /分列间距|人声放大/.test(w.document.querySelector('#fl-panel .fl-param-box').textContent), w.document.querySelector('#fl-panel .fl-param-box').textContent);
  // 面板开着 → Esc 只关面板，演出层不动
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await flush();
  check('Esc 关面板（不影响演出）', $('fl-panel').classList.contains('hidden') && !stage().classList.contains('hidden'));

  // 收尾：回 lumen + 恢复后续用例的锚点状态（META 碟、track 1、paused@5）
  w.FlStage.setTheme('lumen', { persist: false });
  await sleep(280);
  emit('cd:metadata', { metadata: META, fromCache: true });
  await flush(); await flush();
  emit('cd:state', { state: 'paused', track: 1, positionSec: 5, durationSec: 60, trackCount: 2, engine: 'mci' });
  await frames(4);
  check('回到 lumen', stage().dataset.theme === 'lumen');
  check('锚点状态恢复（paused@5）', w.__t.Transport.status === 'paused' && Math.abs(w.__t.Transport.positionSec() - 5) < 0.5, w.__t.Transport.status + '@' + w.__t.Transport.positionSec());

  /* ================================================================
   * 6.7) M3：镜台 3D 主题 + 三级降级链 + 画质自适应 + 凝彩
   * ================================================================ */
  console.log('# 6.7. M3 镜台与凝彩');
  check('注册表含 mirror/prism', w.FlThemes.has('mirror') && w.FlThemes.has('prism'));
  check('Mirror 声明 density 参数', (w.FlThemes.get('mirror').params || []).length === 1 && w.FlThemes.get('mirror').params[0].key === 'density');
  check('Prism 声明 stretch/sheen', (w.FlThemes.get('prism').params || []).map((p) => p.key).join(',') === 'stretch,sheen');
  check('Mirror type=3d', w.FlThemes.get('mirror').type === '3d');

  /* ---- 降级链测试装置：可控 loadScript / THREE / canvas 上下文 ---- */
  const realGetContext = w.HTMLCanvasElement.prototype.getContext;
  const realCores = w.navigator.hardwareConcurrency;
  Object.defineProperty(w.navigator, 'hardwareConcurrency', { value: 2, configurable: true });

  const THREE_LOG = { renderers: [], drawRange: [], renders: 0, material: null };
  function makeFakeTHREE() {
    function Geo() { this.attrs = {}; this.range = [0, 0]; this.disposed = false; }
    Geo.prototype.setAttribute = function (n, a) { this.attrs[n] = a; };
    Geo.prototype.setDrawRange = function (s, c) { this.range = [s, c]; THREE_LOG.drawRange.push([s, c]); };
    Geo.prototype.dispose = function () { this.disposed = true; };
    function Renderer(o) { this.canvas = o && o.canvas; this.pixelRatio = 1; this.disposed = false; this.lost = false; THREE_LOG.renderers.push(this); }
    Renderer.prototype.setClearColor = function () {};
    Renderer.prototype.setPixelRatio = function (p) { this.pixelRatio = p; };
    Renderer.prototype.setSize = function () {};
    Renderer.prototype.getPixelRatio = function () { return this.pixelRatio; };
    Renderer.prototype.render = function () { THREE_LOG.renders++; };
    Renderer.prototype.dispose = function () { this.disposed = true; };
    Renderer.prototype.forceContextLoss = function () { this.lost = true; };
    function Scene() { this.children = []; }
    Scene.prototype.add = function (c) { this.children.push(c); };
    function Cam() {
      this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.aspect = 1; this.lookAts = 0;
    }
    Cam.prototype.updateProjectionMatrix = function () {};
    Cam.prototype.lookAt = function () { this.lookAts++; };
    function Mat(o) { this.uniforms = o.uniforms; this.disposed = false; if (o.uniforms) THREE_LOG.material = this; }
    Mat.prototype.dispose = function () { this.disposed = true; };
    return {
      AdditiveBlending: 2,
      WebGLRenderer: Renderer, Scene: Scene, PerspectiveCamera: Cam,
      Color: function (c) { return { css: c, r: 0.5, g: 0.5, b: 0.5 }; },
      BufferGeometry: Geo,
      BufferAttribute: function (a, n) { return { array: a, itemSize: n }; },
      Float32BufferAttribute: function (a, n) { return { array: a, itemSize: n }; },
      ShaderMaterial: Mat,
      Points: function (g, m) { this.geo = g; this.mat = m; this.frustumCulled = true; },
      LineBasicMaterial: Mat,
      LineSegments: function (g, m) { this.geo = g; this.mat = m; }
    };
  }
  function makeFake2d() {
    return {
      fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
      createRadialGradient() { return { addColorStop() {} }; },
      createLinearGradient() { return { addColorStop() {} }; },
      fillRect() {}, drawImage() {}, setTransform() {}
    };
  }
  /** 直接挂载镜台（绕过舞台控制器），返回 handle */
  async function mountMirrorOpt(opts) {
    const ctx = w.FlThemes.makeCtx(stage());
    ctx.loadScript = opts.loadFail ? () => Promise.reject(new Error('offline')) : () => Promise.resolve();
    if (opts.three) w.THREE = makeFakeTHREE(); else delete w.THREE;
    w.HTMLCanvasElement.prototype.getContext = function (t) {
      if (/webgl/.test(t)) return opts.gl ? {} : null;
      if (t === '2d') return opts.c2d ? makeFake2d() : null;
      return null;
    };
    const handle = await w.FlThemes.get('mirror').mount(ctx);
    return { ctx: ctx, handle: handle };
  }
  function cleanupMount(m) {
    try { m.handle.dispose(); } catch (e) { /* 忽略 */ }
    m.ctx.fx.innerHTML = '';
  }

  // 分支 1：three.js 到位 + WebGL 可用 → GL 点云
  THREE_LOG.drawRange.length = 0; THREE_LOG.renders = 0; THREE_LOG.renderers.length = 0; THREE_LOG.material = null;
  const mGL = await mountMirrorOpt({ three: true, gl: true });
  check('降级链①：GL 点云模式', mGL.handle.mode === 'gl', mGL.handle.mode);
  check('GL：初始档 drawRange=1000（cores=2 → 低档）', THREE_LOG.drawRange[THREE_LOG.drawRange.length - 1][1] === 1000, THREE_LOG.drawRange[THREE_LOG.drawRange.length - 1]);
  // 鼓点喂给 uniform：uPulse 平滑跟随 pulse=0.5
  for (let i = 0; i < 30; i++) mGL.handle.frame(0.016, { pos: 1, pulse: 0.5, bass: 0.3, level: 0.2 });
  check('GL：uTime 推进且 uPulse 跟随', THREE_LOG.material.uniforms.uTime.value > 0.4 && THREE_LOG.material.uniforms.uPulse.value > 0.3, THREE_LOG.material.uniforms.uPulse.value);
  check('GL：渲染计数=30', THREE_LOG.renders === 30, THREE_LOG.renders);
  // 涟漪：onLine 触发 → uRipple>0；持续 1.5s 后归零
  mGL.handle.onLine();
  mGL.handle.frame(0.016, { pos: 1, pulse: 0, bass: 0, level: 0 });
  check('GL：onLine 触发涟漪（uRipple>0.5）', THREE_LOG.material.uniforms.uRipple.value > 0.5, THREE_LOG.material.uniforms.uRipple.value);
  for (let i = 0; i < 100; i++) mGL.handle.frame(0.016, { pos: 1, pulse: 0, bass: 0, level: 0 });
  check('GL：涟漪 1.5s 后归零', THREE_LOG.material.uniforms.uRipple.value === 0, THREE_LOG.material.uniforms.uRipple.value);
  // 参数钩子：density 乘到 drawRange（管线契约：舞台变量是唯一真相源，
  // setThemeParam 先写 --fl-p-density 再通知 onParam —— 这里如实复现）
  stage().style.setProperty('--fl-p-density', '2');
  mGL.handle.onParam('density', 2);
  check('GL：onParam density=2 → drawRange=2000', THREE_LOG.drawRange[THREE_LOG.drawRange.length - 1][1] === 2000, THREE_LOG.drawRange[THREE_LOG.drawRange.length - 1]);
  stage().style.removeProperty('--fl-p-density');
  // 画质自适应：持续高帧（dt=16ms → 62.5fps）→ 连升到顶档
  // （升档需持续 6s：每 0.5s 评估一次，0→1→2 共约 24 次评估 ≈ 768 帧）
  for (let i = 0; i < 900; i++) mGL.handle.frame(0.016, { pos: 1, pulse: 0.2, bass: 0.1, level: 0.1 });
  check('GL：高帧持续 → 升档到顶（drawRange=4600）', THREE_LOG.drawRange[THREE_LOG.drawRange.length - 1][1] === 4600, THREE_LOG.drawRange[THREE_LOG.drawRange.length - 1]);
  mGL.handle.dispose();
  check('GL：dispose 释放上下文', THREE_LOG.renderers[0].disposed && THREE_LOG.renderers[0].lost);
  cleanupMount(mGL);

  // 画质自适应（降档）：cores=32 → 顶档起步，持续低帧（dt=0.12 → 8fps）→ 降一档
  // （降档需持续 2.5s：每 0.5s 评估一次共 5 次；25 帧=3s 只够降一档，
  //   不足以触发第二次——精确卡在单次降档窗口内）
  Object.defineProperty(w.navigator, 'hardwareConcurrency', { value: 32, configurable: true });
  THREE_LOG.drawRange.length = 0; THREE_LOG.renderers.length = 0;
  const mGL2 = await mountMirrorOpt({ three: true, gl: true });
  check('GL：顶档起步 drawRange=4600', THREE_LOG.drawRange[THREE_LOG.drawRange.length - 1][1] === 4600, THREE_LOG.drawRange[THREE_LOG.drawRange.length - 1]);
  for (let i = 0; i < 25; i++) mGL2.handle.frame(0.12, { pos: 1, pulse: 0.2, bass: 0.1, level: 0.1 });
  check('GL：低帧持续 → 降档（drawRange=2400）', THREE_LOG.drawRange[THREE_LOG.drawRange.length - 1][1] === 2400, THREE_LOG.drawRange[THREE_LOG.drawRange.length - 1]);
  mGL2.handle.dispose();
  cleanupMount(mGL2);
  Object.defineProperty(w.navigator, 'hardwareConcurrency', { value: 2, configurable: true });

  // 分支 2：three.js 缺失 + Canvas2D 可用 → 星云
  const m2d = await mountMirrorOpt({ three: false, c2d: true });
  check('降级链②：Canvas2D 星云模式', m2d.handle.mode === '2d', m2d.handle.mode);
  m2d.handle.frame(0.016, { pos: 1, pulse: 0.6, bass: 0.4, level: 0.3 });
  m2d.handle.onLine();
  m2d.handle.frame(0.016, { pos: 1, pulse: 0.6, bass: 0.4, level: 0.3 });
  check('2D：frame/onLine 不抛', true);
  m2d.handle.dispose();
  cleanupMount(m2d);

  // 分支 3：全都不可用 → 纯 CSS（涟漪走 --fl-mirror-ripple）
  const mCss = await mountMirrorOpt({ loadFail: true });
  check('降级链③：纯 CSS 模式', mCss.handle.mode === 'css', mCss.handle.mode);
  mCss.handle.frame(0.016, { pos: 1, pulse: 0, bass: 0, level: 0 });
  mCss.handle.onLine();
  mCss.handle.frame(0.016, { pos: 1, pulse: 0, bass: 0, level: 0 });
  check('CSS 降级：涟漪写 --fl-mirror-ripple', parseFloat(cssVar(stage(), 'fl-mirror-ripple')) > 0.3, cssVar(stage(), 'fl-mirror-ripple'));
  mCss.handle.dispose();
  check('CSS 降级：dispose 归零变量', cssVar(stage(), 'fl-mirror-ripple') === '0', cssVar(stage(), 'fl-mirror-ripple'));
  cleanupMount(mCss);

  /* ---- 走舞台控制器的完整异步装载（stub loadScript + 假 THREE） ---- */
  const origMakeCtx = w.FlThemes.makeCtx;
  w.FlThemes.makeCtx = function (st) {
    const c = origMakeCtx(st);
    c.loadScript = () => Promise.resolve();
    return c;
  };
  w.THREE = makeFakeTHREE();
  THREE_LOG.drawRange.length = 0;
  w.FlStage.setTheme('mirror', { persist: false });
  await sleep(320);
  check('切 mirror → data-theme（异步装载中）', stage().dataset.theme === 'mirror', stage().dataset.theme);
  check('mirror 默认 density=1', cssVar(stage(), 'fl-p-density') === '1', cssVar(stage(), 'fl-p-density'));
  const dbgM = w.__t.FlStage.debugState();
  check('异步 handle 已就绪（GL）', !!dbgM.built, dbgM.built && dbgM.built.count);
  // 面板滑条：镜台粒子密度
  const denInput = w.document.querySelector('#fl-panel .fl-param-box input[aria-label^="镜台"]');
  check('参数区渲染 density 滑条', !!denInput);
  if (denInput) {
    denInput.value = '1.8';
    denInput.dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
    check('滑条 → --fl-p-density=1.8', cssVar(stage(), 'fl-p-density') === '1.8', cssVar(stage(), 'fl-p-density'));
    check('参数持久化 flParams.mirror.density=1.8', (() => { const s = lastInvoke('settings:set'); return !!s && !!s.args[0].flParams && !!s.args[0].flParams.mirror && s.args[0].flParams.mirror.density === 1.8; })(), lastInvoke('settings:set'));
  }
  // 切凝彩：默认参数 + 滑条持久化
  w.document.querySelector('#fl-panel .fl-theme-card[data-theme="prism"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(320);
  check('切到 prism → data-theme', stage().dataset.theme === 'prism', stage().dataset.theme);
  check('prism 默认 stretch=0.7', cssVar(stage(), 'fl-p-stretch') === '0.7', cssVar(stage(), 'fl-p-stretch'));
  check('prism 默认 sheen=0.5', cssVar(stage(), 'fl-p-sheen') === '0.5', cssVar(stage(), 'fl-p-sheen'));
  const strInput = w.document.querySelector('#fl-panel .fl-param-box input[aria-label^="凝彩"]');
  if (strInput) {
    strInput.value = '1.2';
    strInput.dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
    check('滑条 → --fl-p-stretch=1.2', cssVar(stage(), 'fl-p-stretch') === '1.2', cssVar(stage(), 'fl-p-stretch'));
  }
  // 还原：回 lumen + 拆除 stub（后续用例回到真实环境）
  w.FlStage.setTheme('lumen', { persist: false });
  await sleep(320);
  w.FlThemes.makeCtx = origMakeCtx;
  delete w.THREE;
  w.HTMLCanvasElement.prototype.getContext = realGetContext;
  Object.defineProperty(w.navigator, 'hardwareConcurrency', { value: realCores, configurable: true });
  check('M3 收尾回到 lumen', stage().dataset.theme === 'lumen', stage().dataset.theme);

  /* ================================================================
   * 6.8) M4：演出层字体（FlFonts）—— 默认链 / 系统字体 / 自定义注入
   * ================================================================ */
  console.log('# 6.8. M4 字体系统');
  check('FlFonts 已注册', !!w.FlFonts && typeof w.FlFonts.apply === 'function');

  // 默认链：与 CSS 回退值同源，删变量即回默认
  await w.FlFonts.apply(null);
  check('默认 → 移除 --fl-font', cssVar(stage(), 'fl-font') === null, cssVar(stage(), 'fl-font'));
  check('DEFAULT_CHAIN 含 MiSans', /MiSans/.test(w.FlFonts.DEFAULT_CHAIN));

  // 系统字体：用户选择置前 + 默认链兜底
  await w.FlFonts.apply({ kind: 'system', name: 'PingFang SC' });
  const chain = cssVar(stage(), 'fl-font');
  check('系统字体 → --fl-font 置前', chain && chain.indexOf('"PingFang SC"') === 0, chain);
  check('系统字体 → 默认链兜底', !!chain && /MiSans/.test(chain), chain);

  // 自定义字体：fl:read-font 拿 dataURL → 注入 @font-face → 写族名链
  // （jsdom 的 canvas getContext 为 null，探测返回空列表，属预期）
  check('jsdom 系统字体探测为空（无 canvas）', w.FlFonts.detectSystem().length === 0);

  const realInvoke = w.cd.invoke;
  let readCalls = 0;
  w.cd.invoke = function (ch, ...args) {
    if (ch === 'fl:read-font') {
      readCalls++;
      /* 按 id 判别：只有 abc123 读得到，其余一律 no-font（测坏 id 路径） */
      if (!args[0] || args[0].id !== 'abc123') return Promise.resolve({ ok: false, error: 'no-font' });
      return Promise.resolve({ ok: true, dataUrl: 'data:font/ttf;base64,AAECAwQ=' });
    }
    if (ch === 'fl:list-fonts') {
      return Promise.resolve({ ok: true, fonts: [{ id: 'abc123', name: '演示字体', family: 'FlFont-abc123', ext: 'ttf', size: 2048 }] });
    }
    return realInvoke.call(w.cd, ch, ...args);
  };
  await w.FlFonts.listCustom();
  check('自定义字体列表已载入', w.FlFonts.customList().length === 1, w.FlFonts.customList());
  const rCustom = await w.FlFonts.apply({ kind: 'custom', id: 'abc123', name: 'FlFont-abc123' });
  check('自定义字体应用成功', rCustom.ok === true, rCustom);
  const face = w.document.head.querySelector('style[data-fl-font="FlFont-abc123"]');
  check('@font-face 已注入', !!face && /FlFont-abc123/.test(face.textContent), face && face.textContent.slice(0, 60));
  check('自定义字体 → --fl-font 用族名', cssVar(stage(), 'fl-font') === '"FlFont-abc123",' + w.FlFonts.DEFAULT_CHAIN, cssVar(stage(), 'fl-font'));
  check('current() 记住自定义选择', w.FlFonts.current() && w.FlFonts.current().id === 'abc123', w.FlFonts.current());

  // read 失败：不写变量、不注入（坏 id 不能污染舞台）
  const rBad = await w.FlFonts.apply({ kind: 'custom', id: 'nope', name: 'FlFont-nope' });
  check('read 失败 → 返回错误', rBad.ok === false && /no-font|read-failed/.test(rBad.error || ''), rBad);
  check('read 失败 → 不注入 face', !w.document.head.querySelector('style[data-fl-font="FlFont-nope"]'));

  // 删除正在使用的字体：先回默认链，再摘 style
  let delArgs = null;
  w.cd.invoke = function (ch, ...args) {
    if (ch === 'fl:delete-font') { delArgs = args[0]; return Promise.resolve({ ok: true }); }
    if (ch === 'fl:list-fonts') return Promise.resolve({ ok: true, fonts: [] });
    return realInvoke.call(w.cd, ch, ...args);
  };
  const rDel = await w.FlFonts.remove('abc123');
  check('删除自定义字体 ok', rDel.ok === true, rDel);
  check('删除走了 fl:delete-font', !!delArgs && delArgs.id === 'abc123', delArgs);
  check('删除后 style 已摘除', !w.document.head.querySelector('style[data-fl-font="FlFont-abc123"]'));
  check('删除当前字体 → 回默认链', cssVar(stage(), 'fl-font') === null, cssVar(stage(), 'fl-font'));

  // 上传：File 读取 → fl:save-font → 列表刷新 → change 订阅触发
  const ttfMagic = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x04, 0x05, 0x06, 0x07]);
  let savedPayload = null;
  w.cd.invoke = function (ch, ...args) {
    if (ch === 'fl:save-font') {
      savedPayload = args[0];
      return Promise.resolve({ ok: true, font: { id: 'new999', name: '新字体', family: 'FlFont-new999', ext: 'ttf', size: 8 } });
    }
    if (ch === 'fl:list-fonts') return Promise.resolve({ ok: true, fonts: [{ id: 'new999', name: '新字体', family: 'FlFont-new999', ext: 'ttf', size: 8 }] });
    return realInvoke.call(w.cd, ch, ...args);
  };
  let changeFired = 0;
  w.FlFonts.onChange(() => { changeFired++; });
  const rSave = await w.FlFonts.save({
    name: '新字体.ttf',
    type: 'font/ttf',
    arrayBuffer: async () => ttfMagic.buffer
  });
  check('上传成功', rSave.ok === true && rSave.font.id === 'new999', rSave);
  check('上传带出 name+dataUrl', !!savedPayload && savedPayload.name === '新字体.ttf' && /^data:font\/ttf;base64,/.test(savedPayload.dataUrl || ''), savedPayload && savedPayload.dataUrl.slice(0, 30));
  check('上传后列表刷新', w.FlFonts.customList().length === 1 && w.FlFonts.customList()[0].id === 'new999');
  check('change 订阅已触发', changeFired >= 1, changeFired);   // save 内部 onChange 一次
  w.cd.invoke = realInvoke;

  // 设置面板的「全屏歌词」区：构建不炸 + 字体下拉齐备
  const overlay = $('overlay-settings');
  check('设置面板容器存在', !!overlay);
  await w.__t.SettingsPanel.open();
  await flush();
  const secTexts = [];
  for (const s of overlay.querySelectorAll('.set-section')) secTexts.push(s.textContent);
  check('设置区含「全屏歌词」', secTexts.indexOf('全屏歌词') >= 0, secTexts);
  const fontSel = overlay.querySelector('.set-font-box .set-select');
  check('字体下拉存在', !!fontSel);
  if (fontSel) {
    const optTexts = [];
    for (const o of fontSel.querySelectorAll('option')) optTexts.push(o.textContent);
    check('字体下拉含默认项', optTexts.some((t) => /默认/.test(t)), optTexts);
    check('字体下拉含系统字体组', !!fontSel.querySelector('optgroup[label="系统字体"]'));
  }
  check('上传按钮存在', !!overlay.querySelector('.set-font-box .panel-btn'));
  // 打开面板时当前是默认（前面删完了）→ 下拉回显 @default
  if (fontSel) check('默认态下拉回显', fontSel.value === '@default', fontSel.value);
  w.__t.SettingsPanel.close();

  /* ================================================================
   * 7) 小胶囊：轻点 / 长按拖进度 / 滚轮 / 菜单
   * ================================================================ */
  console.log('# 7. 小胶囊');
  const cap = $('fl-capsule');
  const ev = (type, x, y, extra) => new w.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, button: 0, clientX: x || 0, clientY: y || 0 }, extra || {}));

  // 轻点 → 恢复播放（当前 paused）
  invoked.length = 0;
  cap.dispatchEvent(ev('pointerdown', 100, 500));
  cap.dispatchEvent(ev('pointerup', 100, 500));
  await flush();
  check('轻点胶囊 → 播放/暂停', !!lastInvoke('cd:resume'), invoked.map((x) => x.ch));

  // 长按 260ms 后横拖 100px → 预览 +35s（不超曲长 60s，避开钳制），松手提交
  const posBefore = w.__t.Transport.positionSec();
  invoked.length = 0;
  cap.dispatchEvent(ev('pointerdown', 100, 500));
  await sleep(260);                    // 越过 HOLD_MS=200
  cap.dispatchEvent(ev('pointermove', 200, 500));   // dx=100 → +35s
  await flush();
  check('长按进入拖进度（seeking 类）', cap.classList.contains('seeking'));
  const bubble = w.document.querySelector('#fl-capsule .fl-cap-bubble');
  check('气泡显示目标时间', /\d:\d\d/.test(bubble.textContent), bubble.textContent);
  check('Transport 进入预览', w.__t.Transport.seeking === true);
  const preview = w.__t.Transport.positionSec();
  check('预览值≈起拖点+35', Math.abs(preview - (posBefore + 35)) < 2, preview + ' (posBefore=' + posBefore + ')');
  cap.dispatchEvent(ev('pointerup', 200, 500));
  await flush();
  check('松手提交 cd:seek≈起拖点+35', (() => { const s = lastInvoke('cd:seek'); return !!s && Math.abs(s.args[0] - (posBefore + 35)) < 2; })(), lastInvoke('cd:seek'));
  check('提交后退出 seeking 态', !cap.classList.contains('seeking') && w.__t.Transport.seeking === false);

  // 滚轮音量（setVolume 有 600ms 防抖持久化，等它落地）
  invoked.length = 0;
  let wheelEv;
  try { wheelEv = new w.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }); }
  catch (e) { wheelEv = ev('wheel'); }
  cap.dispatchEvent(wheelEv);
  await sleep(750);
  check('滚轮上调音量 → 持久化', (() => { const s = lastInvoke('settings:set'); return !!s && s.args[0].defaultVolume > 0.7; })(), lastInvoke('settings:set'));

  // 播控菜单
  const menuBtn = $('fl-menu-btn');
  menuBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  check('菜单弹出', !$('fl-menu').classList.contains('hidden'));
  check('模式标签=顺序播放', $('fl-m-mode').textContent.indexOf('顺序播放') >= 0, $('fl-m-mode').textContent);
  invoked.length = 0;
  $('fl-m-mode').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  check('切模式 → cd:set-mode', !!lastInvoke('cd:set-mode'), invoked.map((x) => x.ch));
  check('模式标签变为单曲循环', $('fl-m-mode').textContent.indexOf('单曲循环') >= 0, $('fl-m-mode').textContent);
  invoked.length = 0;
  $('fl-m-next').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  check('菜单下一曲 → cd:play-track', !!lastInvoke('cd:play-track'), invoked.map((x) => x.ch));

  /* ================================================================
   * 8) 切轨重建 + 行级 LRC + 空态
   * ================================================================ */
  console.log('# 8. 歌词装载变体');
  emit('cd:state', { state: 'playing', track: 2, positionSec: 0, durationSec: 60, trackCount: 2, engine: 'mci', reason: 'play' });
  await flush(); await frames(4);
  let dbg = w.__t.FlStage.debugState();
  check('切到行级曲：重建 3 行', dbg.built && dbg.built.count === 3, dbg.built && dbg.built.count);
  check('行级模型无 word-mode', !stage().classList.contains('word-mode'));
  check('行级行挂 fl-solid（整行同亮）', !!w.document.querySelector('#fl-lyrics .fl-w.fl-solid'));

  // 空态：把曲目 2 的歌词清掉再推一次元数据
  META.tracks[1].lyrics = '';
  emit('cd:metadata', { metadata: META, fromCache: false });
  await flush(); await frames(4);
  check('无歌词 → 空态提示', !!w.document.querySelector('#fl-lyrics .fl-empty'), w.document.querySelector('#fl-lyrics').innerHTML.slice(0, 60));

  /* ================================================================
   * 9) 退碟强制关闭
   * ================================================================ */
  console.log('# 9. 退碟强制关闭');
  emit('cd:phase', { phase: 'eject' });
  await flush();
  check('出舱 → 演出层立即消失', stage().classList.contains('hidden'));
  check('出舱 → 停渲类移除', htmlCls().indexOf('fl-active') < 0, htmlCls());
  check('指针隐身类移除', htmlCls().indexOf('fl-idle') < 0);

  /* 再开一次 → 正常关闭走淡出（340ms 后 hidden） */
  w.FlStage.open();
  await flush();
  check('可再次打开', !stage().classList.contains('hidden'));
  w.FlStage.close();
  await flush();
  check('关闭后立即取消 fl-active', htmlCls().indexOf('fl-active') < 0);
  check('退出后回到音乐库', w.__t.App.state.page === 'library', w.__t.App.state.page);
  await sleep(400);
  check('淡入结束后真正隐藏', stage().classList.contains('hidden'));

  /* ---- v10.9 回归：正在播放页退出（App.navigate 曾拼错，TypeError 会吞掉
         整个 closeTimer → 舞台透明盖全窗吃鼠标，键盘却正常）---- */
  w.__t.navigate('nowplaying');
  await flush();
  check('已在正在播放页', w.__t.App.state.page === 'nowplaying', w.__t.App.state.page);
  w.FlStage.open();
  await flush();
  check('播放页可开舞台', !stage().classList.contains('hidden'));
  let closeThrew = null;
  try { w.FlStage.close(); } catch (e) { closeThrew = e; }
  check('播放页 close 不抛异常', closeThrew === null, closeThrew && closeThrew.message);
  check('播放页退出 → 回到音乐库', w.__t.App.state.page === 'library', w.__t.App.state.page);
  check('播放页退出 → 立即取消 fl-active', htmlCls().indexOf('fl-active') < 0);
  await sleep(400);
  check('播放页退出 → 340ms 后真正 hidden（鼠标不再被吃）', stage().classList.contains('hidden'));
  check('播放页退出 → 停渲类移除', htmlCls().indexOf('fl-active') < 0, htmlCls());
  w.__t.navigate('library');
  await flush();

  /* ================================================================
   * 10) 封面色板降级
   * ================================================================ */
  console.log('# 10. 封面色板');
  w.FlStage.open();
  await flush();
  META.hasCover = true;
  emit('cd:metadata', { metadata: META, fromCache: false });
  await flush(); await sleep(50);
  check('无 canvas 环境不崩（舞台仍开着）', !stage().classList.contains('hidden'));
  w.FlStage.forceClose();

  /* ================================================================
   * 11) v10.9：右下角专辑封面 + 播控菜单「弹出光盘」
   * ================================================================ */
  console.log('# 11. 播控菜单内大号封面 + 歌名/艺术家 + 弹出光盘');
  META.hasCover = false;                   // 先验无封面兜底
  w.FlStage.open();
  await flush(); await frames(2);
  check('菜单内封面元素存在（.fl-menu-cover > .fl-cover-img）', (() => {
    const menu = $('fl-menu');
    const cov = menu && menu.querySelector('.fl-menu-cover');
    return !!cov && !!cov.querySelector('.fl-cover-img') && cov === menu.firstElementChild;
  })(), $('fl-menu') && $('fl-menu').firstElementChild.className);
  check('封面在播放/切歌按钮上方（同一菜单内为首块）', (() => {
    const menu = $('fl-menu');
    const row = $('fl-m-prev').parentElement;
    const cov = menu.querySelector('.fl-menu-cover');
    return !!cov.compareDocumentPosition(row) && !!(cov.compareDocumentPosition(row) & 4); // cov 在 row 之前
  })());
  check('封面下方是歌名与艺术家', (() => {
    const menu = $('fl-menu');
    const t = menu.querySelector('.fl-menu-title'), a = menu.querySelector('.fl-menu-artist');
    return !!t && !!a && t.textContent === '词级曲' && a.textContent === '演出艺术家';
  })(), (() => { const m = $('fl-menu'); return [m.querySelector('.fl-menu-title').textContent, m.querySelector('.fl-menu-artist').textContent]; })());
  check('无封面 → 不挂 has-cover（露占位光盘）', !$('fl-menu').querySelector('.fl-menu-cover').classList.contains('has-cover'));
  check('右下角不再有独立封面（.fl-bottom-right 已移除）', !$('fl-menu').ownerDocument.querySelector('.fl-bottom-right'));

  // 有封面：cover:// URL 进背景图 + has-cover 类（走真实事件链）
  META.hasCover = true;
  emit('cd:metadata', { metadata: META, fromCache: false });
  await flush(); await flush(); await frames(2);
  check('有封面 → has-cover 类', $('fl-menu').querySelector('.fl-menu-cover').classList.contains('has-cover'));
  check('封面背景图走 cover:// 协议', /cover:\/\/sig-fl\//.test($('fl-menu').querySelector('.fl-cover-img').style.backgroundImage || ''), $('fl-menu').querySelector('.fl-cover-img').style.backgroundImage);
  check('胶囊小封面同步（同一 URL）', /cover:\/\/sig-fl\//.test($('fl-cap-cover').style.backgroundImage || ''), $('fl-cap-cover').style.backgroundImage);

  // 播控菜单：播放顺序与弹出光盘并排最下方
  $('fl-menu-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  check('播放顺序与弹出光盘并排最下方（同一 row 两个 half）', (() => {
    const mode = $('fl-m-mode'), ej = $('fl-m-eject');
    return !!mode && !!ej && mode.parentElement === ej.parentElement
      && mode.classList.contains('half') && ej.classList.contains('half')
      && mode.parentElement === $('fl-menu').lastElementChild;
  })(), $('fl-m-mode') && $('fl-m-mode').parentElement.className);
  check('菜单含「弹出光盘」项', !!$('fl-m-eject') && $('fl-m-eject').textContent.indexOf('弹出光盘') >= 0, $('fl-m-eject') && $('fl-m-eject').textContent);
  check('弹出光盘项带图标', !!$('fl-m-eject') && $('fl-m-eject').querySelector('svg') !== null);
  invoked.length = 0;
  $('fl-m-eject').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  check('点弹出光盘 → cd:eject 已发', !!lastInvoke('cd:eject'), invoked.map((x) => x.ch));
  check('点弹出光盘 → 演出层立即消失（不盖出舱场景）', stage().classList.contains('hidden'));

  /* ================================================================
   * 12) v10.9：歌词弹出方式（all / line / word，全部主题可套用）
   * ================================================================ */
  console.log('# 12. 歌词弹出方式（reveal）');
  /* 前面各节把墙钟推到了 stopped/pos=0——重发 playing@0 重置墙钟基准，
     之后的 advance() 都是相对 pos=0 的确定位移（与 #3 节同手法）。 */
  emit('cd:state', { state: 'playing', track: 1, positionSec: 0, durationSec: 60, trackCount: 2, engine: 'mci', reason: 'play' });
  w.FlStage.open();
  await flush(); await frames(2);

  // DOM 分层：.fl-line（定位链）> .fl-in（揭示链）
  const line0 = w.__t.FlStage.debugState().built.recs[0].el;
  check('行内层 .fl-in 存在（揭示链专属层）', line0.classList.contains('fl-line') && !!line0.querySelector(':scope > .fl-in'), line0.innerHTML.slice(0, 80));
  check('词 span 挂在 .fl-in 内（不占定位链属性）', (() => {
    const rec = w.__t.FlStage.debugState().built.recs[1];
    return rec.words.every((wd) => wd.el.parentElement && wd.el.parentElement.classList.contains('fl-in'));
  })());

  // 默认 all：无揭示类，data-reveal=all
  check('默认弹出方式=all', w.FlStage.currentReveal() === 'all', w.FlStage.currentReveal());
  check('data-reveal=all', stage().dataset.reveal === 'all', stage().dataset.reveal);
  check('revealModes 枚举 3 项', w.FlStage.revealModes().length === 3 && w.FlStage.revealModes()[1].id === 'line', JSON.stringify(w.FlStage.revealModes()));

  // ---- 切 line：pos=5 时第 2 行（i=1）为当前行 ----
  w.FlStage.setReveal('line');
  await flush();
  advance(5000);
  await frames(4);
  {
    const recs2 = w.__t.FlStage.debugState().built.recs;
    check('line 模式 → data-reveal=line', stage().dataset.reveal === 'line', stage().dataset.reveal);
    check('line 模式 → 当前行挂 rv-on', recs2[1].el.classList.contains('rv-on'), w.__t.FlStage.debugState().active);
    check('line 模式 → 过去行挂 rv-past', recs2[0].el.classList.contains('rv-past'));
    check('line 模式 → 未来行无揭示类（不预显）', !recs2[2].el.classList.contains('rv-on') && !recs2[2].el.classList.contains('rv-past'));
    check('line 模式 → 未来行不挂 w-on', recs2[1].words.every((wd) => !wd.el.classList.contains('w-on')));
  }

  // 行推进：pos=9 → 当前行=2（i=2），旧当前行变过去行
  advance(4000);
  await frames(4);
  {
    const recs2 = w.__t.FlStage.debugState().built.recs;
    check('line 模式 → 行推进后 rv-on 迁移', recs2[2].el.classList.contains('rv-on') && !recs2[1].el.classList.contains('rv-on'));
    check('line 模式 → 行推进后 rv-past 累积', recs2[1].el.classList.contains('rv-past') && recs2[0].el.classList.contains('rv-past'));
  }

  // ---- 切 word：当前行（i=2，无词级时间）整行直显 ----
  w.FlStage.setReveal('word');
  await flush();
  await frames(2);
  {
    const recs2 = w.__t.FlStage.debugState().built.recs;
    check('word 模式 → data-reveal=word', stage().dataset.reveal === 'word', stage().dataset.reveal);
    check('word 模式 → 当前行挂 rv-on（行先落入）', recs2[2].el.classList.contains('rv-on'));
    check('word 模式 → 无词时间的行整行可见（fl-solid 直显）', !!recs2[2].el.querySelector('.fl-w.fl-solid'));
  }

  // 词门控：重发 playing@2 → pos=2，当前行=0（i=0，词级行）
  // 词1(0~1) 唱满、词2(1~2.5) 进行中、词3(2.5~4) 未到
  emit('cd:state', { state: 'playing', track: 1, positionSec: 2, durationSec: 60, trackCount: 2, engine: 'mci', reason: 'play' });
  await flush(); await frames(4);
  {
    const wds = w.__t.FlStage.debugState().built.recs[0].words;
    check('word 模式 → 词1（已唱过）w-on', wds[0].el.classList.contains('w-on'));
    check('word 模式 → 词2（进行中）w-on', wds[1].el.classList.contains('w-on'));
    check('word 模式 → 词3（未唱）无 w-on', !wds[2].el.classList.contains('w-on'));
  }
  advance(1000);                       // pos=3 → 词3(2.5~4) 已开唱
  await frames(4);
  check('word 模式 → 时间推进后词3 浮现 w-on', w.__t.FlStage.debugState().built.recs[0].words[2].el.classList.contains('w-on'));

  // ---- 非法值回落 all，并清揭示类 ----
  w.FlStage.setReveal('line');
  await flush(); await frames(2);
  w.FlStage.setReveal('bogus');
  await flush();
  check('非法弹出方式回落 all', w.FlStage.currentReveal() === 'all' && stage().dataset.reveal === 'all', w.FlStage.currentReveal());
  check('回落 all 后揭示类被清空', (() => {
    const recs2 = w.__t.FlStage.debugState().built.recs;
    return recs2.every((r) => !r.el.classList.contains('rv-on') && !r.el.classList.contains('rv-past')) &&
      recs2[0].words.every((wd) => !wd.el.classList.contains('w-on'));
  })());

  // ---- 面板 chip 组：高亮跟随 + 点击生效 + 落盘 ----
  check('面板 chip 组存在（三选一）', (() => {
    const chips = w.document.querySelectorAll('#fl-panel .fl-reveal-chip');
    return chips.length === 3 && !!w.document.querySelector('#fl-reveal-word');
  })());
  w.FlStage.setReveal('word');
  await flush();
  const chipWord = $('fl-reveal-word');
  check('面板 chip 高亮跟随程序化切换', !!chipWord && chipWord.classList.contains('on'), chipWord && chipWord.className);
  invoked.length = 0;
  $('fl-reveal-line').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  check('点 chip line → setReveal 生效', w.FlStage.currentReveal() === 'line', w.FlStage.currentReveal());
  check('点 chip line → settings:set 落盘 flReveal', !!lastInvoke('settings:set') && lastInvoke('settings:set').args[0] && lastInvoke('settings:set').args[0].flReveal === 'line', JSON.stringify(invoked.filter((x) => x.ch === 'settings:set').slice(-1)));
  w.FlStage.forceClose();

  /* ================================================================
   * 13) v10.9：两个 3D 运镜主题（跃迁 Warp / 星环 Halo）
   * ================================================================ */
  console.log('# 13. 3D 运镜主题（warp / halo）');
  check('跃迁/星环已注册（type=3d）', (() => {
    const a = w.FlThemes.get('warp'), b = w.FlThemes.get('halo');
    return !!a && !!b && a.type === '3d' && b.type === '3d' && a.params.length === 4 && b.params.length === 4;
  })(), w.FlThemes.list().map((d) => d.id + ':' + d.type));

  emit('cd:state', { state: 'playing', track: 1, positionSec: 5, durationSec: 60, trackCount: 2, engine: 'mci', reason: 'play' });
  w.FlStage.open();
  await flush(); await frames(2);

  // 切跃迁（setTheme 有 200ms veil，等它过去再断言）
  w.FlStage.setTheme('warp');
  await sleep(450);
  check('跃迁主题已挂上', stage().dataset.theme === 'warp', stage().dataset.theme);
  check('跃迁参数变量已写（--fl-p-depth/sway/push/dash）', ['depth', 'sway', 'push', 'dash'].every((k) => cssVar(stage(), 'fl-p-' + k) !== null), ['depth', 'sway', 'push', 'dash'].map((k) => cssVar(stage(), 'fl-p-' + k)));

  // 运镜 rig：frame() 往 #fl-lyrics 写 transform，且随时间变化（镜头在动）
  const t1 = cssVar($('fl-lyrics'), 'none') // 占位防呆
    || (() => { const s = $('fl-lyrics').getAttribute('style') || ''; const m = /transform:\s*([^;]+)/.exec(s); return m ? m[1].trim() : null; })();
  check('运镜 rig 已写 #fl-lyrics transform', !!t1 && /rotateX\(.*deg\) rotateY\(.*deg\) translate3d/.test(t1), t1);
  advance(700);
  await frames(4);
  const t2 = (() => { const s = $('fl-lyrics').getAttribute('style') || ''; const m = /transform:\s*([^;]+)/.exec(s); return m ? m[1].trim() : null; })();
  check('镜头随时间移动（transform 值变化）', !!t2 && t2 !== t1, [t1, t2]);

  // rig 只动 #fl-lyrics，不碰 .fl-line 的 transform（定位链纪律）
  check('rig 不写 .fl-line 的 transform（单写入纪律）', (() => {
    const recs = w.__t.FlStage.debugState().built.recs;
    const s = recs[1].el.getAttribute('style') || '';
    return !/transform:/.test(s) && /--d:/.test(s);   // --d 照常写，transform 不碰
  })());

  // 穿梭强度滑条：setThemeParam 即时写变量（面板滑条同路径）
  w.FlStage.setThemeParam('dash', 1.8);
  check('穿梭强度参数可调（--fl-p-dash）', cssVar(stage(), 'fl-p-dash') === '1.8', cssVar(stage(), 'fl-p-dash'));
  w.FlStage.setThemeParam('dash', 1);

  // 切镜 / 入场 / dispose 不抛（补间模块缺失时的静默降级路径）
  let threw = null;
  try {
    w.__t.FlStage.debugState();           // 状态可读
    advance(1000); await frames(3);       // 再跑几帧（含 onLine 触发路径）
  } catch (e) { threw = e; }
  check('rig 在无 GSAP 环境下稳定运行', threw === null, threw && threw.message);

  // 切星环 → rig 重新挂载（dispose 旧 rig 后新 rig 接管）
  w.FlStage.setTheme('halo');
  await sleep(450);
  check('星环主题已挂上', stage().dataset.theme === 'halo', stage().dataset.theme);
  check('星环参数变量已写（--fl-p-radius/spread/sway/dash）', ['radius', 'spread', 'sway', 'dash'].every((k) => cssVar(stage(), 'fl-p-' + k) !== null));
  const t3 = (() => { const s = $('fl-lyrics').getAttribute('style') || ''; const m = /transform:\s*([^;]+)/.exec(s); return m ? m[1].trim() : null; })();
  check('星环 rig 同样在运镜', !!t3 && /translate3d/.test(t3), t3);
  advance(600);
  await frames(4);
  const t4 = (() => { const s = $('fl-lyrics').getAttribute('style') || ''; const m = /transform:\s*([^;]+)/.exec(s); return m ? m[1].trim() : null; })();
  check('星环镜头随时间移动', !!t4 && t4 !== t3, [t3, t4]);

  // 切回流光 → rig dispose（transform 清空）
  w.FlStage.setTheme('lumen');
  await sleep(450);
  check('切回流光后 rig 已卸载（transform 清空）', (() => {
    const s = $('fl-lyrics').getAttribute('style') || '';
    return !/transform:/.test(s);
  })(), $('fl-lyrics').getAttribute('style'));

  /* ================================================================
   * 14) v10.9.1：选歌面板（fl-tracks：列表 / 高亮 / 点行切歌 / 快捷键）
   * ================================================================ */
  console.log('# 14. 选歌面板（fl-tracks）');
  emit('cd:state', { state: 'playing', track: 1, positionSec: 2, durationSec: 60, trackCount: 2, engine: 'mci', reason: 'play' });
  w.FlStage.open();
  await flush(); await frames(2);

  // 打开：顶栏按钮 + 快捷键 L 两条路
  $('fl-tracks-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  check('选歌面板已打开（点顶栏按钮）', !$('fl-tracks').classList.contains('hidden'));
  check('面板列出全部曲目（TOC 定数）', $('fl-tracks').querySelectorAll('.fl-track-row').length === 2, $('fl-tracks').querySelectorAll('.fl-track-row').length);
  check('行内容 = 曲目号 + 歌名 + 时长', (() => {
    const r = $('fl-tracks').querySelectorAll('.fl-track-row')[0];
    return r.querySelector('.fl-track-no').textContent === '01'
      && r.querySelector('.fl-track-title').textContent === '词级曲'
      && r.querySelector('.fl-track-dur').textContent === '1:00';
  })(), $('fl-tracks').querySelector('.fl-track-row').textContent);
  check('当前曲目高亮（第 1 行 .on）', (() => {
    const rows = $('fl-tracks').querySelectorAll('.fl-track-row');
    return rows[0].classList.contains('on') && !rows[1].classList.contains('on');
  })());

  // 点第 2 行 → App.playTrack(2) 且面板关闭
  invoked.length = 0;
  $('fl-tracks').querySelectorAll('.fl-track-row')[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  check('点行 → cd:play-track 已发（曲目 2）', (() => {
    const it = lastInvoke('cd:play-track');
    return !!it && it.args[0] === 2;
  })(), invoked.map((x) => x.ch + ':' + JSON.stringify(x.args)));
  check('点行后面板关闭', $('fl-tracks').classList.contains('hidden'));

  // 快捷键 L：开 → 关
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
  await flush();
  check('快捷键 L 打开选歌', !$('fl-tracks').classList.contains('hidden'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await flush();
  check('Escape 先关选歌（不退出演出层）', $('fl-tracks').classList.contains('hidden') && !stage().classList.contains('hidden'));

  // 换歌后高亮跟随（Transport 事件驱动 sync）
  emit('cd:state', { state: 'playing', track: 2, positionSec: 1, durationSec: 60, trackCount: 2, engine: 'mci', reason: 'play' });
  await flush(); await frames(2);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
  await flush();
  check('换歌后高亮跟随到第 2 行', (() => {
    const rows = $('fl-tracks').querySelectorAll('.fl-track-row');
    return rows[1].classList.contains('on') && !rows[0].classList.contains('on');
  })());

  /* ================================================================
   * 15) 多语言：切换语言重排文案，但不打断播放
   * ================================================================ */
  console.log('# 15. 多语言切换（文案重排 / 播放不中断）');

  // 先把舞台重新打开（上一节末已 forceClose），并确认在播放
  emit('cd:state', { state: 'playing', track: 1, positionSec: 3, durationSec: 60, trackCount: 2, engine: 'mci', reason: 'play' });
  await flush();
  w.FlStage.open();
  await frames(2);
  const trackBefore = w.__t.Transport.track;
  const statusBefore = w.__t.Transport.status;
  const linesBefore = w.FlStage.debugState().built.count;

  const navLib = $('nav-library');
  const zhNav = navLib.textContent;
  check('起始语言为简体中文', w.I18n.get() === 'zh-CN' && zhNav === '音乐库', [w.I18n.get(), zhNav]);
  check('演出层返回按钮 title 为中文',
    $('fl-back').title.indexOf('返回音乐库') === 0, $('fl-back').title);
  check('胶囊菜单按钮 title 为中文', $('fl-menu-btn').title === '播放控制', $('fl-menu-btn').title);

  // 切到英文
  invoked.length = 0;
  w.__t.App.setLang('en', true);
  await flush(); await frames(2);

  check('导航按钮变成英文', navLib.textContent === 'Library', navLib.textContent);
  check('html[lang] 变成 en', w.document.documentElement.getAttribute('lang') === 'en',
    w.document.documentElement.getAttribute('lang'));
  check('语言已落盘（settings:set lang:en）', (() => {
    const it = lastInvoke('settings:set');
    return !!it && it.args[0] && it.args[0].lang === 'en';
  })(), invoked.map((x) => x.ch + ':' + JSON.stringify(x.args)));
  check('App.state.settings.lang 同步', w.__t.App.state.settings.lang === 'en', w.__t.App.state.settings.lang);
  check('演出层返回按钮 title 变成英文（原地回填，不重建 DOM）',
    $('fl-back').title.indexOf('Back to library') === 0, $('fl-back').title);
  check('胶囊菜单按钮 title 变成英文', $('fl-menu-btn').title === 'Playback controls', $('fl-menu-btn').title);
  check('全屏按钮 title 变成英文', $('fl-full').title.indexOf('Full screen') === 0, $('fl-full').title);

  // 播放链路一点没动
  check('切语言不打断播放（曲目不变）', w.__t.Transport.track === trackBefore, [trackBefore, w.__t.Transport.track]);
  check('切语言不打断播放（状态不变）', w.__t.Transport.status === statusBefore, [statusBefore, w.__t.Transport.status]);
  check('歌词不被清空（行数不变）', w.FlStage.debugState().built.count === linesBefore,
    [linesBefore, w.FlStage.debugState().built.count]);
  check('舞台仍开着', !stage().classList.contains('hidden'));

  // 切到日文：面板文案跟着换（主题面板是重建的）
  w.__t.App.setLang('ja', true);
  await flush(); await frames(2);
  check('主题面板标题变成日文', (() => {
    const t = $('fl-panel') && $('fl-panel').querySelector('.fl-panel-head span');
    return !!t && t.textContent === w.T('fl.panel.title') && t.textContent !== '歌词主题';
  })(), (($('fl-panel').querySelector('.fl-panel-head span') || {}).textContent));

  // 设置页：语言下拉（5 个选项、当前值正确、选中即刻生效）
  w.__t.SettingsPanel.open();
  await flush();
  const sel = $('set-lang');
  check('设置页有语言下拉', !!sel, !!sel);
  check('下拉有 5 个语言选项', sel && sel.options.length === 5, sel && sel.options.length);
  check('选项名用各语言自己的写法', (() => {
    const names = Array.prototype.map.call(sel.options, (o) => o.textContent);
    return names[0] === '简体中文' && names[1] === '繁體中文' && names[2] === 'English'
      && names[3] === '日本語' && names[4] === 'Русский';
  })(), Array.prototype.map.call(sel.options, (o) => o.textContent));
  check('下拉当前值 = 当前语言', sel.value === 'ja', sel.value);

  invoked.length = 0;
  sel.value = 'ru';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await flush(); await frames(2);
  check('选俄文后界面立刻变', navLib.textContent === w.T('app.nav.library') && w.I18n.get() === 'ru',
    [w.I18n.get(), navLib.textContent]);
  check('选俄文后落盘', (() => {
    const it = lastInvoke('settings:set');
    return !!it && it.args[0] && it.args[0].lang === 'ru';
  })(), invoked.map((x) => x.ch + ':' + JSON.stringify(x.args)));
  check('设置面板重建后仍是外观页（没跳回第一页）',
    !!$('set-lang') && $('set-lang').value === 'ru',
    [$('set-lang') && $('set-lang').value, !!$('set-lang')]);

  // 切到繁体：只差字形，键仍是同一套
  w.__t.App.setLang('zh-TW', true);
  await flush();
  check('繁体文案与简体不同', navLib.textContent !== zhNav && navLib.textContent === '音樂庫', navLib.textContent);
  check('繁体下演出层键仍在（返回按钮）', $('fl-back').title.indexOf('返回音樂庫') === 0, $('fl-back').title);

  // 复位，避免影响收尾
  w.__t.App.setLang('zh-CN', false);
  await flush();
  w.__t.SettingsPanel.close();
  await flush();
  check('复位回简体中文', navLib.textContent === zhNav, navLib.textContent);

  /* # 16. 主题补间接线（v10.12：GSAP → renderer/js/tween.js） */
  console.log('# 16. 主题补间（tween.js 接线）');
  check('window.Tween 已加载', !!(w.Tween && typeof w.Tween.fromTo === 'function'));
  check('缓动与 GSAP 同名同值（power2.out(0.5)=0.875）',
    Math.abs(w.Tween.ease('power2.out')(0.5) - 0.875) < 1e-9, w.Tween.ease('power2.out')(0.5));

  w.FlStage.open();
  await frames(3);
  w.FlStage.setTheme('lumen');
  await sleep(280);
  advance(3000);                      // 换行 → lumen.onLine → 补间写 --fl-pop
  await frames(4);
  const st16 = w.FlStage.debugState();
  const cur16 = st16.built && st16.built.recs[st16.active];
  const pop1 = parseFloat(cssVar(cur16 && cur16.el, 'fl-pop'));
  check('换行后当前行被写入 --fl-pop（补间真的接到主题上了）',
    isFinite(pop1) && pop1 > 0 && pop1 <= 0.9, cssVar(cur16 && cur16.el, 'fl-pop'));
  /* 本套件把 performance.now 换成了受控 CLOCK（Transport 的墙钟），
     补间也读同一个时钟 —— 必须显式 advance 它才会走 */
  advance(700);
  await frames(2);
  const pop2 = parseFloat(cssVar(cur16 && cur16.el, 'fl-pop'));
  check('--fl-pop 已衰减归零（补间收尾）', pop2 === 0, pop2);
  check('补间不写内联 transition（不破坏行自带的淡入）',
    !/transition/.test((cur16 && cur16.el.getAttribute('style')) || ''), (cur16 && cur16.el.getAttribute('style')));

  // 无 TOC 时的空态（清掉 toc，只留元数据 2 轨——仍有列表；再清元数据才空）
  w.FlStage.forceClose();

  console.log('\n' + (fails ? fails + ' 个用例未通过' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(1); });
