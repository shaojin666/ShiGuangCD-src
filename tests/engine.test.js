'use strict';
/* AudioEngine 自检：PCM 调度位置换算、轨末判定、Buffer/Uint8Array 兼容 */

const fs = require('fs');
const vm = require('vm');

let CLOCK = 1000; // ms
/** 记录增益调度，用于断言"暂停当帧把增益拉到 0" */
const GAIN_LOG = [];
/** 记录 suspend/resume 调用次数与顺序 */
const CTX_LOG = [];
class FakeAudioContext {
  constructor() { this.state = 'running'; this.destination = {}; }
  get currentTime() { return CLOCK / 1000; }
  createGain() {
    const g = {
      value: 1,
      _autoRamp: null,
      cancelScheduledValues() { GAIN_LOG.push({ op: 'cancel' }); return g; },
      setValueAtTime(v) { GAIN_LOG.push({ op: 'set', v }); g.value = v; return g; },
      linearRampToValueAtTime(v) { GAIN_LOG.push({ op: 'ramp', v }); g._autoRamp = v; return g; },
      exponentialRampToValueAtTime() { return g; }
    };
    return { gain: g, connect() {}, disconnect() {} };
  }
  createBiquadFilter() { return { type: '', frequency: { value: 0 }, connect() {} }; }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len);
    return { duration: len / rate, getChannelData: () => data };
  }
  createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {}, disconnect() {} }; }
  suspend() { this.state = 'suspended'; CTX_LOG.push('suspend'); return Promise.resolve(); }
  resume() { this.state = 'running'; CTX_LOG.push('resume'); return Promise.resolve(); }
}

const sandbox = {
  window: { AudioContext: FakeAudioContext },
  console, Math, Buffer, Uint8Array, Int16Array, Float32Array, Number, isFinite
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'renderer', 'js', 'audio.js'), 'utf8') +
  '\n;globalThis.__E = { AudioEngine, DemoAudio };', sandbox);
const { AudioEngine } = sandbox.__E;

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const advance = (ms) => { CLOCK += ms; };

/** 造一块 1 秒的 CD-DA PCM（75 扇区 × 2352 字节，Int16LE 立体声） */
function chunk() {
  const n = 75 * 2352 / 2;
  const b = Buffer.alloc(75 * 2352);
  for (let i = 0; i < n; i++) b.writeInt16LE(0, i * 2);
  return b;
}

console.log('# 1. 轨道边界未知时不得用引擎位置（否则进度条会飙到几千秒）');
const e0 = new AudioEngine();
check('hasTrackBounds()=false', e0.hasTrackBounds() === false);

console.log('# 2. 调度位置换算');
const e = new AudioEngine();
e.setTrack(1, 150, 22000);
e.play(1, 150, 22000);
// 连推 3 块（每块 1 秒），起点绝对帧 150 / 225 / 300
let frame = 150;
for (let i = 0; i < 3; i++) { e.feed({ track: 1, absFrame: frame, samples: chunk() }); frame += 75; }
advance(1500); // 已播 1.5 秒
const pf = e.positionFrame();
check('位置帧≈150+1.5*75=262.5', Math.abs(pf - 262.5) < 6, pf);
check('轨内秒≈1.5', Math.abs(e.positionSec() - 1.5) < 0.1, e.positionSec());

console.log('# 3. 播完一块后位置不超过实际调度范围，且队列会被回收');
advance(60000);
check('位置不超过轨末', e.positionFrame() <= 22000, e.positionFrame());
check('队列已空（旧版不 trim 会导致轨末判定永远不成立）', e.isQueueEmpty() === true, e.queue.length);
check('未读完时不算轨末', e.atTrackEnd() === false);

console.log('# 3b. 整轨推完 → 轨末判定成立');
const e1 = new AudioEngine();
e1.setTrack(1, 150, 22000);
e1.play(1, 150, 22000);
let f1 = 150;
while (f1 < 22000) { e1.feed({ track: 1, absFrame: f1, samples: chunk() }); f1 += 75; }
check('游标到达轨末', e1.atTrackEnd() === true, [e1.nextAbsFrame, e1.trackEndFrame]);
advance(400000);
check('播完后队列清空', e1.isQueueEmpty() === true, e1.queue.length);
check('播完后位置夹在轨末', Math.abs(e1.positionFrame() - 22000) < 1, e1.positionFrame());

console.log('# 4. 收到 Uint8Array 也能正常解析（Electron IPC 可能把 Buffer 转成视图）');
const e2 = new AudioEngine();
e2.setTrack(1, 150, 22000);
e2.play(1, 150, 22000);
const u8 = new Uint8Array(chunk());
e2.feed({ track: 1, absFrame: 150, samples: u8 });
advance(500);
check('Uint8Array 输入后位置≈0.5s', Math.abs(e2.positionSec() - 0.5) < 0.15, e2.positionSec());

console.log('# 5. 游标漂移（定位后）会自动重排');
e2.feed({ track: 1, absFrame: 150 + 75 * 100, samples: chunk() });
check('游标跟随主进程新位置', Math.abs(e2.nextAbsFrame - (150 + 75 * 101)) < 1, e2.nextAbsFrame);

console.log('# 6. ★ 暂停立刻静音：不能等 AudioContext.suspend 生效');
const e3 = new AudioEngine();
e3.setTrack(1, 150, 22000);
e3.play(1, 150, 22000);
// 灌满 5 秒预读（模拟 RAW 路径的最大缓冲）
for (let i = 0; i < 5; i++) e3.feed({ track: 1, absFrame: 150 + i * 75, samples: chunk() });
advance(2000);                                   // 真实听感 ≈ 2s
const qBefore = e3.queue.length;
const heardBefore = e3.positionSec();
GAIN_LOG.length = 0; CTX_LOG.length = 0;
e3.pause();
check('暂停当帧就把增益拉到 0（不等 suspend）',
  GAIN_LOG.some((x) => x.op === 'ramp' && x.v === 0),
  GAIN_LOG);
check('预读缓冲被整段丢弃（否则还会响几秒）', e3.queue.length === 0, [qBefore, e3.queue.length]);
check('暂停态标记生效，后续音频块一律丢弃', e3.state === 'paused', e3.state);
check('suspend 仍然被调用（省电 + 冻结时间轴）', CTX_LOG.indexOf('suspend') >= 0, CTX_LOG);
// 暂停后主进程还在推的残留块必须被丢掉
e3.feed({ track: 1, absFrame: 150 + 5 * 75, samples: chunk() });
check('暂停后到达的残留块不会入队', e3.queue.length === 0, e3.queue.length);

console.log('# 6b. ★ 暂停点必须冻结，且等于耳朵听到的位置');
const pausedAt = e3.positionSec();
check('暂停点 ≈ 暂停前的听感位置', Math.abs(pausedAt - heardBefore) < 0.1, [pausedAt, heardBefore]);
advance(10000);                                  // 暂停期间时钟继续走
check('暂停期间位置冻结（不随墙钟前移）', Math.abs(e3.positionSec() - pausedAt) < 0.01, e3.positionSec());
check('pausedFrame() 给出同一个暂停点', Math.abs((e3.pausedFrame() - 150) / 75 - pausedAt) < 0.01,
  [e3.pausedFrame(), pausedAt]);

console.log('# 6c. ★ 续播必须从暂停点开始（不能偏后）');
e3.resume();
check('恢复后位置仍等于暂停点', Math.abs(e3.positionSec() - pausedAt) < 0.01, e3.positionSec());
check('恢复时撤销硬静音（增益回到音量值）',
  GAIN_LOG.some((x) => x.op === 'ramp' && x.v > 0), GAIN_LOG);
check('恢复后回到 playing', e3.state === 'playing', e3.state);
// 从暂停点重新灌数据，位置应当从这里继续，而不是跳到更后面
e3.feed({ track: 1, absFrame: 150 + Math.round(pausedAt * 75), samples: chunk() });
check('恢复后首块从暂停点起算', Math.abs(e3.positionSec() - pausedAt) < 0.15, e3.positionSec());

console.log('# 7. ★ 队列为空时不得把"已读游标"当成听感位置');
const e4 = new AudioEngine();
e4.setTrack(1, 150, 22000);
e4.play(1, 150, 22000);
// 主进程已把游标推到很后面（模拟预读很远、但渲染端一块都还没收到）
e4.nextAbsFrame = 150 + 75 * 60;
e4.lastPosFrame = 150;
check('队列空 → 位置停在最近确定的听感位置，不跳到游标',
  Math.abs(e4.positionSec() - 0) < 0.01, [e4.positionSec(), (e4.nextAbsFrame - 150) / 75]);

console.log('# 8. 越出轨末的尾巴要被裁掉（否则进度条差最后一小截）');
const e5 = new AudioEngine();
e5.setTrack(1, 150, 150 + 75 * 10 + 40);   // 轨长 10 秒零 40 帧，不是整秒
e5.play(1, 150, 150 + 75 * 10 + 40);
for (let i = 0; i <= 10; i++) e5.feed({ track: 1, absFrame: 150 + i * 75, samples: chunk() });
const lastBlk = e5.queue[e5.queue.length - 1];
check('末块被裁到轨末', Math.abs(lastBlk.absFrame + lastBlk.duration * 75 - (150 + 75 * 10 + 40)) < 1,
  lastBlk.absFrame + lastBlk.duration * 75);
advance(60000);
check('播完后位置夹到轨末', Math.abs(e5.positionFrame() - (150 + 75 * 10 + 40)) < 1, e5.positionFrame());

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
