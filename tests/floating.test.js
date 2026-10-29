'use strict';
/*
 * tests/floating.test.js —— 桌面悬浮歌词（主进程侧）自检。
 *
 * 背景：逐字歌词上线后，主渲染端经 floating:lyrics 推送的 info 多了四个
 * 增强字段（tr / at / t / e / words），悬浮窗拿词的绝对时间轴自己跑 CSS
 * 补间动画做卡拉OK（刻意不开高频 IPC）。main/floating.js 的 setLyrics
 * 是一道白名单关口 —— words 经结构化克隆过来，字段坏了悬浮窗会整行
 * 不渲染，所以必须在这里收敛。
 *
 * 做法：electron 不可解析（pkg 目录无 node_modules），用 Module._load
 * 钩子注入假 electron（BrowserWindow / ipcMain / screen），open() 之后
 * 手动触发 did-finish-load，capture webContents.send 的载荷做断言。
 *
 * 覆盖：
 *   1) 经典 LRC 推送：words 为 null、增强字段为默认值（悬浮窗走纯文本）
 *   2) 逐字推送：tr/at/t/e/words 原样透传，词的多余字段被剥掉
 *   3) 脏词过滤：缺 t/e、空 x、null 项、NaN/Infinity 全部丢弃；空数组归一为 null
 *   4) 词数上限 120（超长行截断，防单行歌词把 IPC 载荷撑爆）
 *   5) IPC 通道 floating:lyrics / float:ready 行为
 *   6) float:init 携带最近一次歌词（悬浮窗重启后不丢当前行）
 *
 * 运行：node tests/floating.test.js
 */

const path = require('path');
const Module = require('module');

const FLOATING = path.join(__dirname, '..', 'main', 'floating.js');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n---- ' + name + ' ----'); }

/* ---------- 假 electron ---------- */

function makeFakeElectron() {
  const handlers = new Map();
  const wins = [];

  function FakeWin(opts) {
    this.opts = opts || {};
    this._destroyed = false;
    this._bounds = { x: this.opts.x || 0, y: this.opts.y || 0, width: this.opts.width || 760, height: this.opts.height || 132 };
    this._handlers = {};
    this.sent = [];                      // {channel, payload}
    const self = this;
    this.webContents = {
      send(channel, payload) { self.sent.push({ channel: channel, payload: payload }); },
      on(ev, cb) { (self._handlers[ev] = self._handlers[ev] || []).push(cb); }
    };
    wins.push(this);
  }
  FakeWin.prototype.isDestroyed = function () { return this._destroyed; };
  FakeWin.prototype.getBounds = function () { return Object.assign({}, this._bounds); };
  FakeWin.prototype.setBounds = function (b) { Object.assign(this._bounds, b); };
  FakeWin.prototype.getPosition = function () { return [this._bounds.x, this._bounds.y]; };
  FakeWin.prototype.showInactive = function () { this.shown = true; };
  FakeWin.prototype.setAlwaysOnTop = function () {};
  FakeWin.prototype.removeMenu = function () {};
  FakeWin.prototype.setIgnoreMouseEvents = function () {};
  FakeWin.prototype.loadFile = function () {};
  FakeWin.prototype.on = function (ev, cb) { (this._handlers[ev] = this._handlers[ev] || []).push(cb); };
  FakeWin.prototype.destroy = function () { this._destroyed = true; };
  FakeWin.prototype.emit = function (ev) {
    const list = (this._handlers[ev] || []).slice();
    for (const cb of list) cb();
  };

  const wa = { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    BrowserWindow: FakeWin,
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    screen: {
      getPrimaryDisplay: () => ({ workArea: wa }),
      getDisplayNearestPoint: () => ({ workArea: wa })
    },
    __handlers: handlers,
    __wins: wins
  };
}

/* ---------- 加载被测模块（注入假 electron） ---------- */

const fake = makeFakeElectron();
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fake;
  return origLoad.apply(this, arguments);
};
let createFloating;
try {
  ({ createFloating } = require(FLOATING));
} finally {
  Module._load = origLoad;
}

/* ---------- 搭一个开着的悬浮窗 ---------- */

const settings = {
  data: {},
  updates: [],
  update(patch) { Object.assign(this.data, patch); this.updates.push(patch); }
};
const logs = [];
const floating = createFloating({
  settings: settings,
  log: (m) => logs.push(m),
  getMainWindow: () => null
});
ok(floating.open() === true, 'open() 成功创建窗口');
const win = fake.__wins[0];
ok(!!win, 'BrowserWindow 被构造过');
win.emit('did-finish-load');          // 手动触发加载完成 → pushInit

function lastPayload(channel) {
  for (let i = win.sent.length - 1; i >= 0; i--) {
    if (win.sent[i].channel === channel) return win.sent[i].payload;
  }
  return null;
}

/* ================================================================
 * 1) 经典 LRC 推送：无逐字字段
 * ================================================================ */
section('经典 LRC 推送：增强字段归一化为默认值');

floating.setLyrics({ text: '第一行歌词', prev: '', next: '第二行歌词', index: 0, total: 12, playing: true });
{
  const p = lastPayload('float:lyrics');
  ok(!!p, 'float:lyrics 已推送');
  ok(p.text === '第一行歌词' && p.prev === '' && p.next === '第二行歌词', '文本三行原样');
  ok(p.index === 0 && p.total === 12 && p.playing === true, '旧字段（index/total/playing）不变');
  ok(p.words === null, '无 words → null（悬浮窗走纯文本渲染）');
  ok(p.tr === '' && p.at === null && p.t === null && p.e === null, '增强字段默认值');
}

/* ================================================================
 * 2) 逐字推送：原样透传 + 剥掉多余字段
 * ================================================================ */
section('逐字推送：tr/at/t/e/words 透传，词字段白名单');

floating.setLyrics({
  text: '歌词内容', prev: '上一行', next: '下一行', index: 3, total: 20, playing: true,
  tr: 'lyrics content', at: 12.5, t: 12.0, e: 15.0,
  words: [
    { t: 12.0, e: 12.4, x: '歌', extra: 'drop me' },
    { t: 12.4, e: 12.9, x: '词' },
    { t: 12.9, e: 15.0, x: '内容' }
  ]
});
{
  const p = lastPayload('float:lyrics');
  ok(p.tr === 'lyrics content', '译文透传');
  ok(p.at === 12.5 && p.t === 12 && p.e === 15, '时间轴透传（at/t/e）');
  ok(p.words && p.words.length === 3, '三个词全部通过');
  ok(p.words[0].x === '歌' && p.words[0].t === 12 && p.words[0].e === 12.4, '词字段完整');
  ok(p.words[0].extra === undefined, '词的多余字段被剥掉（白名单）');
}

/* ================================================================
 * 3) 脏词过滤
 * ================================================================ */
section('脏词过滤：缺字段 / null / NaN / Infinity 全丢弃');

floating.setLyrics({
  text: 'x', index: 0, total: 1, playing: false,
  words: [
    { t: 1, e: 2, x: 'ok' },
    { t: 'x', e: 2, x: 'bad-t' },
    { e: 2, x: 'bad-missing-t' },
    { t: 1, x: 'bad-missing-e' },
    { t: 1, e: 2, x: '' },
    { t: 1, e: 2 },
    null,
    { t: NaN, e: 2, x: 'nan' },
    { t: 1, e: Infinity, x: 'inf' },
    'not-an-object'
  ]
});
{
  const p = lastPayload('float:lyrics');
  ok(p.words && p.words.length === 1 && p.words[0].x === 'ok',
    '只有完整合法的词存活（实际 ' + (p.words ? p.words.length : 'null') + ' 个）', p.words);
}

floating.setLyrics({ text: 'x', index: 0, total: 1, words: [] });
{
  const p = lastPayload('float:lyrics');
  ok(p.words === null, '空数组归一为 null');
}

/* ================================================================
 * 4) 词数上限
 * ================================================================ */
section('词数上限 120');
{
  const many = [];
  for (let i = 0; i < 130; i++) many.push({ t: i * 0.1, e: i * 0.1 + 0.09, x: '词' });
  floating.setLyrics({ text: 'x', index: 0, total: 1, words: many });
  const p = lastPayload('float:lyrics');
  ok(p.words && p.words.length === 120, '130 个词截断到 120（实际 ' + (p.words ? p.words.length : 'null') + '）');
}

/* ================================================================
 * 5) IPC 通道
 * ================================================================ */
section('IPC 通道');
{
  const h = fake.__handlers.get('floating:lyrics');
  ok(typeof h === 'function', 'floating:lyrics handler 已注册');
  h(null, { text: 'ipc行', index: 1, total: 2, playing: false, at: 1, t: 1, e: 2, words: [{ t: 1, e: 2, x: 'ipc' }] });
  const p = lastPayload('float:lyrics');
  ok(p && p.text === 'ipc行' && p.words[0].x === 'ipc', '经 handler 推送同样过白名单');

  const ready = fake.__handlers.get('float:ready');
  ok(typeof ready === 'function', 'float:ready handler 已注册');
  ready();
  const init = lastPayload('float:init');
  ok(init && init.lyrics && init.lyrics.text === 'ipc行', 'float:ready → pushInit 带最近一次歌词');
  ok(init.lyrics.words && init.lyrics.words.length === 1, 'init 里的逐字词也在（悬浮窗重启不丢当前行）');
  ok(typeof init.color === 'string' && typeof init.size === 'number', 'init 仍带颜色/字号配置');
}

/* ================================================================
 * 6) 播放中反复推送同一行（暂停后续播）：载荷稳定
 * ================================================================ */
section('重复推送同一行：载荷稳定可重放');
{
  const info = { text: '同一行', prev: '前', next: '后', index: 5, total: 30, playing: true, at: 3, t: 3, e: 6, words: [{ t: 3, e: 6, x: '同一行' }] };
  floating.setLyrics(info);
  const a = lastPayload('float:lyrics');
  floating.setLyrics(info);
  const b = lastPayload('float:lyrics');
  ok(JSON.stringify(a) === JSON.stringify(b), '相同输入 → 相同载荷（渲染端去重后可安全跳过）');
}

console.log('\n' + (fail ? fail + ' 个断言未通过' : 'ALL PASS（' + pass + '）'));
process.exit(fail ? 1 : 0);
