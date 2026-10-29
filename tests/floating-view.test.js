'use strict';
/*
 * tests/floating-view.test.js —— 桌面悬浮歌词**渲染端**自检。
 *
 * 覆盖 renderer/js/floating.js 的逐字渲染路径（主进程侧的白名单在
 * floating.test.js）。jsdom 未安装（本项目测试要求零依赖、随处可跑），
 * 所以手搓一个刚好够用的 DOM 桩，用 vm 加载**真实的** floating.js，
 * 再经 window.cd.on('float:lyrics') 注册的处理器驱动，断言：
 *
 *   1) 经典模式：三行纯文本，无词 span
 *   2) 逐字模式：词 span 的 class / animation-delay / duration 换算正确
 *      （已唱过→sung 直接终态；唱到一半→补间剩余；未唱→按绝对时间延迟）
 *   3) 词长下限 60ms（极短词不会瞬间闪完）
 *   3.5) v10.6：英文词间空格修复 / 罗马音 .ro / float:opts 译音显隐
 *        （body.no-tr / no-ro，缺项不动）
 *   3.6) v10.7：bg 词同样跑 bw-fill 补间；duet 左右分类
 *        （duet-line / bg-duet / bg-main，无对唱不打类）
 *   4) 译文 .tr 小字挂在当前行末尾
 *   5) 去重键：相同 info 重复推送不重建（span 引用不变）
 *   6) 行序推进判定：接着上一行走才播入场（track.adv），跳转不播
 *   7) float:init：颜色/字号/锁定复位路径不炸
 *
 * 运行：node tests/floating-view.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FLOATING_JS = path.join(__dirname, '..', 'renderer', 'js', 'floating.js');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n---- ' + name + ' ----'); }

/* ---------- 最小 DOM 桩 ---------- */

function makeStyle() {
  const o = {};
  o.setProperty = (k, v) => { o[k] = String(v); };
  return o;
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    _set: set
  };
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    dataset: {},
    className: '',
    value: '',
    style: makeStyle(),
    parent: null,
    _text: '',
    _listeners: {}
  };
  el.classList = makeClassList();
  Object.defineProperty(el, 'textContent', {
    get() {
      let s = el._text;
      for (const c of el.children) s += c.textContent;
      return s;
    },
    set(v) { el._text = String(v); el.children.length = 0; }
  });
  el.appendChild = (c) => { el.children.push(c); c.parent = el; return c; };
  el.addEventListener = (t, cb) => { (el._listeners[t] = el._listeners[t] || []).push(cb); };
  el.querySelectorAll = () => [];
  el.querySelector = () => null;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });
  el.setPointerCapture = () => {};
  return el;
}

/* ---------- 组装 document / window ---------- */

const root = makeEl('html');
const body = makeEl('body');
const byId = {};
for (const id of ['stage', 'plate', 'track', 'controls', 'lockhint', 'fsize', 'fsize-val', 'custom', 'swatches', 'close']) {
  byId[id] = makeEl('div');
}
const slotLines = { '0': makeEl('div'), '1': makeEl('div'), '2': makeEl('div') };
byId.track.querySelector = (sel) => {
  const m = /data-slot="(\d)"/.exec(String(sel));
  return m ? slotLines[m[1]] : null;
};

const docListeners = {};
const documentStub = {
  documentElement: root,
  body: body,
  createElement: (t) => makeEl(t),
  /* v10.6 起 floating.js 会在拉丁词之间插空格文本节点（英文空格修复），
     桩必须提供 createTextNode，否则真实脚本一加载到那条路径就炸。 */
  createTextNode: (t) => { const n = makeEl('#text'); n.textContent = String(t); return n; },
  getElementById: (id) => byId[id] || null,
  addEventListener: (t, cb) => { (docListeners[t] = docListeners[t] || []).push(cb); }
};

const cdHandlers = {};
const invoked = [];
const windowStub = {
  cd: {
    on: (ch, cb) => { cdHandlers[ch] = cb; },
    invoke: (ch, ...args) => { invoked.push({ ch: ch, args: args }); return Promise.resolve(); }
  },
  addEventListener: () => {}
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: (h) => clearTimeout(h)
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FLOATING_JS, 'utf8'), sandbox, { filename: 'floating.js' });

ok(typeof cdHandlers['float:lyrics'] === 'function', 'float:lyrics 处理器已注册');
ok(invoked.some((i) => i.ch === 'float:ready'), '加载后主动 float:ready');
const push = (info) => cdHandlers['float:lyrics'](info);

/* ================================================================
 * 1) 经典模式
 * ================================================================ */
section('经典 LRC：三行纯文本');

push({ index: 0, text: '第一行', prev: '', next: '第二行', total: 12, playing: true });
{
  const cur = slotLines['1'];
  ok(cur.textContent === '第一行', '当前行文本');
  ok(cur.children.length === 0, '无词 span（经典模式）');
  ok(slotLines['0'].textContent === '' && slotLines['2'].textContent === '第二行', '上/下行文本');
  ok(body.classList.contains('playing'), 'playing 类同步');
  ok(byId.plate.classList.contains('has-text'), 'has-text 类同步');
}

/* ================================================================
 * 2) 逐字模式：时间换算
 * ================================================================ */
section('逐字模式：词 span 与动画时间换算');

push({
  index: 2, text: '歌词内容', prev: '上一行', next: '下一行', total: 10, playing: true,
  tr: 'translation', at: 12.5, t: 12.0, e: 15.0,
  words: [
    { t: 12.0, e: 12.4, x: '歌' },    // 已唱过（e <= at）
    { t: 12.4, e: 12.9, x: '词' },    // 唱到一半（t < at < e）
    { t: 12.9, e: 15.0, x: '内容' }   // 未唱（t > at）
  ]
});
{
  const cur = slotLines['1'];
  const ws = cur.children.filter((c) => c.className.split(' ').indexOf('w') >= 0);
  ok(ws.length === 3, '三个词 span');
  ok(ws.map((w) => w.textContent).join('') === '歌词内容', '词文本拼接 = 行文本');
  ok(ws[0].classList.contains('sung'), '已唱过的词直接 sung 终态');
  ok(ws[0].style.animationDuration === undefined, 'sung 词不跑动画');
  ok(!ws[1].style.animationDelay && ws[1].style.animationDuration === '400ms',
    '唱到一半的词：无延迟、补间剩下一段（400ms）', { d: ws[1].style.animationDelay, du: ws[1].style.animationDuration });
  ok(ws[2].style.animationDelay === '400ms' && ws[2].style.animationDuration === '2100ms',
    '未唱的词：延迟 400ms、时长 2100ms', { d: ws[2].style.animationDelay, du: ws[2].style.animationDuration });
  const tr = cur.children[cur.children.length - 1];
  ok(tr.className === 'tr' && tr.textContent === 'translation', '译文 .tr 挂在行尾');
}

/* ================================================================
 * 3) 词长下限 + at 缺失回退
 * ================================================================ */
section('边界：极短词 60ms 下限 / at 缺失回退 t');

push({
  index: 3, text: '快', prev: '', next: '', total: 10, playing: true, t: 20.0,
  words: [{ t: 20.0, e: 20.03, x: '快' }]
});
{
  const ws = slotLines['1'].children.filter((c) => c.className.indexOf('w') >= 0);
  ok(ws.length === 1 && ws[0].style.animationDuration === '60ms',
    '30ms 的词被抬到 60ms 下限', ws[0] && ws[0].style.animationDuration);
  ok(!ws[0].style.animationDelay, 'at 缺失时回退 info.t，当前词无延迟');
}

/* ================================================================
 * 3.5) v10.6：英文词间空格 / 对唱块 / 罗马音 / 译音开关
 * ================================================================ */
section('v10.6：英文空格修复（与主界面同规则）');

push({
  index: 6, text: 'I love you', prev: '', next: '', total: 10, playing: true,
  at: 30, t: 30, e: 33,
  words: [
    { t: 30.0, e: 30.8, x: 'I' },
    { t: 30.8, e: 31.6, x: 'love' },
    { t: 31.6, e: 33.0, x: 'you' }
  ]
});
{
  const cur = slotLines['1'];
  const kids = cur.children;
  // 3 个词 span + 2 个空格文本节点
  ok(kids.length === 5, '拉丁词之间插入了空格文本节点（3 词 + 2 空格）', kids.length);
  ok(kids[1].tagName === '#TEXT' && kids[1].textContent === ' ' &&
     kids[3].tagName === '#TEXT' && kids[3].textContent === ' ', '空格节点位置正确');
  ok(cur.textContent === 'I love you', '拼接后文本带空格', cur.textContent);
}

// CJK 词之间不补；连字符两侧不补（与 lyrics-view.js 的 needsSpace 同规则）
push({
  index: 7, text: '遥远-星光', prev: '', next: '', total: 10, playing: true,
  at: 40, t: 40, e: 44,
  words: [
    { t: 40.0, e: 41.5, x: '遥远' },
    { t: 41.5, e: 44.0, x: '-星光' }
  ]
});
{
  const kids = slotLines['1'].children;
  ok(kids.length === 2 && kids.every((k) => k.tagName !== '#TEXT'),
    'CJK 词 / 连字符词之间不插空格', kids.length);
}

section('v10.7：对唱块（bg）词级填充 + duet 左右分类');

// 非对唱歌：bg 块不打任何 duet 类（CSS 不启用左右规则，整体居中）
push({
  index: 8, text: '主唱句', prev: '', next: '', total: 10, playing: true,
  at: 50, t: 50, e: 54,
  words: [{ t: 50.0, e: 54.0, x: '主唱句' }],
  bg: [
    { text: '背景声', t: 49, e: 50, words: [{ t: 49.0, e: 50.0, x: '背景声' }] },
    { text: 'second voice', t: 50, e: 54, words: [{ t: 50.0, e: 54.0, x: 'second' }, { t: 51.0, e: 54.0, x: 'voice' }] }
  ],
  ro: 'ROMAJI'
});
{
  const cur = slotLines['1'];
  ok(!cur.classList.contains('duet-line'), '非对唱行不打 duet-line');
  ok(!cur.classList.contains('has-bg'), 'v10.7 起不再用 has-bg 类（由 bg-duet/bg-main 取代）');
  const bgs = cur.children.filter((c) => c.className === 'bg');
  ok(bgs.length === 2, '两条背景人声各一个 .bg 块', bgs.length);
  ok(bgs[0].textContent === '背景声', '对唱块文本', bgs[0].textContent);
  const bws = bgs[0].children.filter((c) => c.className === 'bw');
  ok(bws.length === 1, 'bg 块内词 span 用 .bw', bws.length);
  ok(bws[0].classList.contains('sung'), '推送时已唱过的 bg 词直接 sung 终态');
  ok(!bgs[0].classList.contains('bg-duet') && !bgs[0].classList.contains('bg-main'),
    '无对唱的歌：bg 块两个 duet 类都不打（居中）');
  ok(bgs[1].children[1] && bgs[1].children[1].tagName === '#TEXT' && bgs[1].children[1].textContent === ' ',
    'bg 块内拉丁词之间也补空格');
  ok(bgs[1].textContent === 'second voice', 'bg 块英文拼接带空格', bgs[1].textContent);
  const ro = cur.children[cur.children.length - 1];
  ok(ro.className === 'ro' && ro.textContent === 'ROMAJI', '罗马音 .ro 挂在行尾');
}

// 对唱歌：行 agent=v2（非主唱）→ duet-line 靠左；bg agent=v2 → bg-duet 靠左；无 agent → bg-main 靠右
push({
  index: 9, text: '对唱句', prev: '', next: '', total: 10, playing: true,
  at: 60, t: 60, e: 64, agent: 'v2', duet: { has: true, main: 'v1' },
  words: [{ t: 60.0, e: 64.0, x: '对唱句' }],
  bg: [
    { text: '主唱背景', t: 60, e: 64, words: [{ t: 60.0, e: 64.0, x: '主唱背景' }] },
    { text: '对唱背景', agent: 'v2', t: 60, e: 64, words: [{ t: 60.0, e: 64.0, x: '对唱背景' }] }
  ]
});
{
  const cur = slotLines['1'];
  ok(cur.classList.contains('duet-line'), '对唱行（agent≠主唱）打 duet-line（靠左）');
  const bgs = cur.children.filter((c) => c.className.split(' ').indexOf('bg') >= 0);
  ok(bgs.length === 2, '两条 bg 块', bgs.length);
  ok(bgs[0].classList.contains('bg-main') && !bgs[0].classList.contains('bg-duet'),
    '无 agent 的 bg 条目 → bg-main（跟随宿主；宿主为对唱时靠左）');
  ok(bgs[1].classList.contains('bg-duet') && !bgs[1].classList.contains('bg-main'),
    '带 agent 的 bg 条目（≠主唱）→ bg-duet（靠左）');
  // bg 词跑补间动画（v10.7：不再静态）
  const bw = bgs[0].children.filter((c) => c.className === 'bw')[0];
  ok(bw && bw.style.animationDuration === '4000ms',
    'bg 词按绝对时间设 animation-duration（补间 4s）', bw && bw.style.animationDuration);
  // 主唱行：agent=main → 不打 duet-line（靠右）
  push({
    index: 10, text: '主唱句', prev: '', next: '', total: 10, playing: true,
    at: 65, t: 65, e: 69, agent: 'v1', duet: { has: true, main: 'v1' },
    words: [{ t: 65.0, e: 69.0, x: '主唱句' }]
  });
  ok(!slotLines['1'].classList.contains('duet-line'), '主唱行（agent=主 agent）不打 duet-line（靠右）');
}

section('v10.6：float:opts 译/音显隐开关');

cdHandlers['float:opts']({ float: false, showTr: false, showRo: true });
ok(body.classList.contains('no-tr') && !body.classList.contains('no-ro'),
  'showTr=false → body.no-tr；showRo=true 不动 no-ro');
cdHandlers['float:opts']({ float: true, showTr: true, showRo: false });
ok(!body.classList.contains('no-tr') && body.classList.contains('no-ro'),
  '再次推送 → 两个类跟随最新偏好');
// 缺项不动：老通道（只有 float）不能把译/音全关掉
cdHandlers['float:opts']({ float: false });
ok(body.classList.contains('no-ro'), '载荷缺 showTr/showRo 时保持原状');

/* ================================================================
 * 4) 去重：相同 info 不重建
 * ================================================================ */
section('去重：相同 info 重复推送不重建');

{
  const info = {
    index: 4, text: '同一行', prev: '前', next: '后', total: 10, playing: true,
    at: 1, t: 1, e: 4, words: [{ t: 1, e: 4, x: '同一行' }]
  };
  push(info);
  const first = slotLines['1'].children[0];
  push(info);
  ok(slotLines['1'].children[0] === first, 'span 引用不变（未重建）');
  // 换一行（哪怕文本相同、行号不同）必须重建，动画才会重跑
  push(Object.assign({}, info, { index: 5, text: '另一行', words: [{ t: 1, e: 4, x: '另一行' }] }));
  ok(slotLines['1'].children[0] !== first, '行号/文本变化 → 重建');
}

/* ================================================================
 * 5) 行序推进判定
 * ================================================================ */
section('行序推进：接着上一行才播入场');

push({ index: 0, text: 'A', prev: '', next: 'B', total: 3, playing: true });
push({ index: 1, text: 'B', prev: 'A', next: 'C', total: 3, playing: true });
ok(byId.track.classList.contains('adv'), 'A→B 顺序推进 → track.adv');
push({ index: 9, text: 'Z', prev: 'X', next: '', total: 3, playing: true });
ok(!byId.track.classList.contains('adv'), '跳转到 Z → 不播入场（摘掉 adv）');

/* ================================================================
 * 6) float:init 冒烟（颜色/字号/锁定复位路径）
 * ================================================================ */
section('float:init：外观与歌词初始化');

cdHandlers['float:init']({
  color: '#c9a56a', size: 30, locked: false, float: false,
  lyrics: { text: '', prev: '', next: '', index: -1, total: 0, playing: false, tr: '', at: null, t: null, e: null, words: null }
});
{
  ok(root.style['--fg'] === '#c9a56a', '颜色应用到 --fg');
  ok(root.style['--fg-dim'] === 'rgba(201,165,106,0.42)', '暗态变量同步（换色不换层次）');
  ok(root.style['--fs'] === '30px', '字号应用到 --fs');
  ok(slotLines['1'].textContent === '', '空歌词不渲染');
  ok(body.classList.contains('unlocked') && !body.classList.contains('locked'), '解锁态类正确');
}

console.log('\n' + (fail ? fail + ' 个断言未通过' : 'ALL PASS（' + pass + '）'));
process.exit(fail ? 1 : 0);
