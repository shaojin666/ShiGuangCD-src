'use strict';
/*
 * tests/tween.test.js —— 自写补间模块（renderer/js/tween.js）单测。
 *
 * v10.12 移除了 GSAP（专有许可与 GPLv3 冲突），补间改由 tween.js 承担。
 * 本套件锁三件事：
 *   1) 缓动曲线与 GSAP 逐点一致 —— 下面那组采样值是直接从
 *      `gsap.parseEase('power2.out')` 等导出后抄进来的，改造时对过：
 *      power2/power3 偏差 0（同一多项式），sine 偏差 2.4e-16（浮点噪声）。
 *   2) 写入通路不变：每帧 style.setProperty，**不碰** transition/animation。
 *      这条很要命 —— .fl-line 自带 `transition: opacity .28s, font-size .35s,
 *      color .35s`，若用内联 transition 做补间会把它们整个覆盖掉（行的
 *      淡入会突然变硬切）。
 *   3) 打断 / 清场语义：重复 fromTo 即「打断重来」，reset 抹掉内联值回落
 *      CSS 默认态。
 *
 * 运行：node tests/tween.test.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer/js/tween.js'), 'utf8');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'outside-only',
  pretendToBeVisual: true     // 给 jsdom 装上 requestAnimationFrame
});
const w = dom.window;
const doc = w.document;

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n---- ' + name + ' ----'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = () => doc.createElement('div');

w.eval(SRC + '\n;window.__tw = window.Tween;');
const Tw = w.__tw;

/* 顶层有 await（等 rAF 推进），整段包进 async main —— 否则 Node 会按 ESM 解析 */
async function main() {

/* ================================================================
 * 1) 缓动曲线：与 GSAP 对标
 * ================================================================ */
section('缓动曲线（对照 gsap.parseEase）');
{
  /* 这三个函数在 GSAP 里的实测值（t = 0.25 / 0.5 / 0.75）：
     power2.out 0.578125 / 0.875000 / 0.984375
     power3.out 0.683594 / 0.937500 / 0.996094
     sine.out   0.382683 / 0.707107 / 0.923880 */
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const p2 = Tw.ease('power2.out');
  const p3 = Tw.ease('power3.out');
  const sn = Tw.ease('sine.out');

  ok(near(p2(0), 0) && near(p2(1), 1) && near(p3(0), 0) && near(p3(1), 1), '端点严格 0 / 1');
  ok(near(p2(0.25), 0.578125) && near(p2(0.5), 0.875) && near(p2(0.75), 0.984375),
    'power2.out 三点与 GSAP 一致', [p2(0.25), p2(0.5), p2(0.75)]);
  ok(near(p3(0.25), 0.683594) && near(p3(0.5), 0.9375) && near(p3(0.75), 0.996094),
    'power3.out 三点与 GSAP 一致', [p3(0.25), p3(0.5), p3(0.75)]);
  ok(near(sn(0.25), 0.382683) && near(sn(0.5), 0.707107) && near(sn(0.75), 0.92388),
    'sine.out 三点与 GSAP 一致', [sn(0.25), sn(0.5), sn(0.75)]);
  ok(Tw.ease('不存在') === p2, '未知缓动回落 power2.out（与调用点默认一致）');

  /* 单调递增（三条都是 easeOut，只能越来越慢、不能回退） */
  let mono = true;
  for (const fn of [p2, p3, sn]) {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = fn(i / 100);
      if (v < prev - 1e-12) mono = false;
      prev = v;
    }
  }
  ok(mono, '三条缓动全程单调不减');
}

/* ================================================================
 * 2) 元素补间：写入通路
 * ================================================================ */
section('元素补间（CSS 变量 + 普通属性）');
{
  const d = el();
  doc.body.appendChild(d);
  Tw.fromTo(d, { '--fl-pop': 1 }, { '--fl-pop': 0 }, { duration: 0, ease: 'power2.out' });
  ok(d.style.getPropertyValue('--fl-pop') === '0', 'duration=0 立即落到终值',
    d.style.getPropertyValue('--fl-pop'));

  const d2 = el();
  doc.body.appendChild(d2);
  Tw.fromTo(d2, { '--fl-orbit-kick': 2.6 }, { '--fl-orbit-kick': 0 }, { duration: 0.12 });
  ok(d2.style.getPropertyValue('--fl-orbit-kick') === '2.6', '起点先落地（首帧前即可读到 from）',
    d2.style.getPropertyValue('--fl-orbit-kick'));
  await sleep(60);
  const mid = parseFloat(d2.style.getPropertyValue('--fl-orbit-kick'));
  ok(mid > 0 && mid < 2.6, '中途值落在 (0, from) 之间', mid);
  await sleep(220);
  ok(d2.style.getPropertyValue('--fl-orbit-kick') === '0', '结束精确归零',
    d2.style.getPropertyValue('--fl-orbit-kick'));
  ok(d2.style.transition === '' || d2.style.transition === undefined,
    '全程不写内联 transition（不覆盖 .fl-line 自带的 opacity/font-size 过渡）', d2.style.transition);
}

/* ================================================================
 * 2.5) GSAP 写法：duration / ease 写在目标对象里
 *      （本项目 9 个调用点全是这种写法，回归过一次：只认第 4 个参数时
 *        时长被忽略、退化成默认 0.3s，肉眼几乎看不出来）
 * ================================================================ */
section('GSAP 风格参数（duration/ease 写在目标对象里）');
{
  const d = el();
  doc.body.appendChild(d);
  Tw.fromTo(d, { '--fl-pop': 1 }, { '--fl-pop': 0, duration: 0.05, ease: 'power3.out' });
  const raw = d.getAttribute('style') || '';
  ok(!/duration|ease/.test(raw), '控制键不会被当成 CSS 属性写进 style', raw);
  await sleep(200);
  ok(d.style.getPropertyValue('--fl-pop') === '0',
    'duration:0.05 写在目标里也生效（若是默认 0.3s，此刻仍应 >0）',
    d.style.getPropertyValue('--fl-pop'));

  /* 对象目标同理（运镜 cut/intro 就是这么调的） */
  const obj = { push: 3 };
  Tw.fromTo(obj, { push: 3 }, { push: 0, duration: 0.05 });
  await sleep(200);
  ok(obj.push === 0, '对象目标：duration 写在目标里同样生效', obj.push);

  /* 两处都写时，第 4 个参数优先（显式 opt 覆盖） */
  const d2 = el();
  doc.body.appendChild(d2);
  Tw.fromTo(d2, { '--fl-pop': 1 }, { '--fl-pop': 0, duration: 5 }, { duration: 0 });
  ok(d2.style.getPropertyValue('--fl-pop') === '0', '第 4 个参数里的 duration 优先于目标对象');
}

/* ================================================================
 * 3) 打断：同一目标再次 fromTo 就是重来
 * ================================================================ */
section('打断与重来');
{
  const d = el();
  doc.body.appendChild(d);
  Tw.fromTo(d, { '--fl-pop': 1 }, { '--fl-pop': 0 }, { duration: 0.3 });
  await sleep(80);
  const a = parseFloat(d.style.getPropertyValue('--fl-pop'));
  Tw.fromTo(d, { '--fl-pop': 0.9 }, { '--fl-pop': 0 }, { duration: 0.3 });
  ok(d.style.getPropertyValue('--fl-pop') === '0.9', '再次 fromTo 立刻回到新起点（等价 killTweensOf + fromTo）',
    d.style.getPropertyValue('--fl-pop'));
  ok(a > 0 && a < 1, '打断前确实在衰减中', a);
  await sleep(400);
  ok(d.style.getPropertyValue('--fl-pop') === '0', '第二个补间正常收尾');
}

/* ================================================================
 * 4) stagger：相邻元素依次启动
 * ================================================================ */
section('stagger 依次启动');
{
  const box = doc.createElement('div');
  const ws = [0, 1, 2].map(() => {
    const s = doc.createElement('span');
    box.appendChild(s);
    return s;
  });
  doc.body.appendChild(box);
  Tw.fromTo(box.querySelectorAll('span'), { '--fl-whisper-y': 10 }, { '--fl-whisper-y': 0 },
    { duration: 0.15, stagger: 0.12 });

  await sleep(70);
  const first = parseFloat(ws[0].style.getPropertyValue('--fl-whisper-y'));
  const last = parseFloat(ws[2].style.getPropertyValue('--fl-whisper-y'));
  ok(first < 10, '第一个元素已启动', first);
  ok(last === 10, '最后一个仍在延迟里（保持起点值）', last);

  await sleep(500);
  ok(ws.every((s) => s.style.getPropertyValue('--fl-whisper-y') === '0'), '三个元素最终都归零');
}

/* ================================================================
 * 5) clearProps / reset
 * ================================================================ */
section('clearProps 与 reset');
{
  const d = el();
  doc.body.appendChild(d);
  Tw.fromTo(d, { '--fl-whisper-y': 10, opacity: 0 }, { '--fl-whisper-y': 0, opacity: 1 },
    { duration: 0.05, clearProps: 'opacity' });
  await sleep(180);
  ok(d.style.opacity === '', 'clearProps 移除内联 opacity（让 w-on 门控重新生效）', d.style.opacity);
  ok(d.style.getPropertyValue('--fl-whisper-y') === '0', '变量保留终值（0 与 CSS 默认一致）');

  const e2 = el();
  doc.body.appendChild(e2);
  Tw.fromTo(e2, { '--fl-whisper-y': 8, opacity: 0 }, { '--fl-whisper-y': 0, opacity: 1 }, { duration: 0.5 });
  await sleep(60);
  Tw.reset(e2, 'opacity');
  ok(e2.style.getPropertyValue('--fl-whisper-y') === '', 'reset 抹掉变量内联值（回落到 var(--x, 0)）',
    e2.style.getPropertyValue('--fl-whisper-y'));
  ok(e2.style.opacity === '', 'reset 同时清掉指定属性');
  await sleep(300);
  ok(e2.style.getPropertyValue('--fl-whisper-y') === '', 'reset 之后补间不再继续写（已停）',
    e2.style.getPropertyValue('--fl-whisper-y'));
}

/* ================================================================
 * 6) 普通对象补间（运镜 cut / intro）
 * ================================================================ */
section('对象补间（cam rig 的 cut / intro）');
{
  const cut = { yaw: 0.8, pitch: -0.4, push: 3, x: 0.2, y: -0.1 };
  Tw.fromTo(cut, { yaw: 0.8, pitch: -0.4, push: 3, x: 0.2, y: -0.1 }, { yaw: 0, pitch: 0, push: 0, x: 0, y: 0 },
    { duration: 0.1, ease: 'power3.out' });
  await sleep(50);
  const midSum = Math.abs(cut.yaw) + Math.abs(cut.push) + Math.abs(cut.x);
  ok(midSum > 0 && midSum < 4.0, '五个通道同时在衰减', midSum.toFixed(3));
  await sleep(200);
  ok(cut.yaw === 0 && cut.pitch === 0 && cut.push === 0 && cut.x === 0 && cut.y === 0, '全部精确归零', cut);

  const intro = { v: 1 };
  Tw.fromTo(intro, { v: 1 }, { v: 0 }, { duration: 0.05 });
  await sleep(150);
  ok(intro.v === 0, 'intro.v 归零（入场推近结束）');

  /* stop：停下但不归零 */
  const cut2 = { push: 5 };
  Tw.fromTo(cut2, { push: 5 }, { push: 0 }, { duration: 0.4 });
  await sleep(60);
  Tw.stop(cut2);
  const frozen = cut2.push;
  await sleep(120);
  ok(cut2.push === frozen && frozen > 0 && frozen < 5, 'stop 冻结在当前值，不再写', frozen);
}

/* ================================================================
 * 7) 静态契约
 * ================================================================ */
section('静态契约（不引第三方 / 不用 transition）');
{
  const SRC_NC = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/\brequire\(|^\s*import\s/m.test(SRC_NC), 'tween.js 无任何 require / import（零依赖）');
  ok(!/gsap/i.test(SRC_NC), 'tween.js 代码里无 GSAP 调用（注释里提到历史除外）');
  ok(/style\.setProperty/.test(SRC), '写入走 style.setProperty');
  ok(!/\.style\.transition\s*=/.test(SRC), '不写内联 transition（避免覆盖元素自带的过渡）');
  ok(!/\.animate\(/.test(SRC), '不走 WAAPI（Electron 22 对自定义属性支持不稳）');
  ok(/requestAnimationFrame/.test(SRC) && /cancelAnimationFrame/.test(SRC), 'rAF 驱动，可取消');

  const themes = fs.readFileSync(path.join(ROOT, 'renderer/js/fl-themes.js'), 'utf8');
  ok(!/gsap/i.test(themes), 'fl-themes 不再引用 GSAP');
  ok(/tween: \(typeof window !== 'undefined' && window\.Tween\) \? window\.Tween : null/.test(themes),
    'ctx.tween 注入（缺失时主题静默降级）');
  ok((themes.match(/tween\.fromTo\(/g) || []).length === 9, '9 处 fromTo 全部改到 tween.js',
    (themes.match(/tween\.fromTo\(/g) || []).length);
  ok(!/killTweensOf/.test(themes), '不再有 killTweensOf（fromTo 本身即打断重来）');

  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  ok(/<script src="js\/tween\.js"><\/script>/.test(html), 'index.html 引入 tween.js');
  ok(!/<script[^>]+gsap/i.test(html), 'index.html 不再引入 GSAP');
  ok(!fs.existsSync(path.join(ROOT, 'renderer/js/vendor/gsap.min.js')), 'vendor 里已无 gsap.min.js');
}

  console.log('\n' + (fail ? fail + ' 个断言未通过' : 'ALL PASS（' + pass + ' 断言）'));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
