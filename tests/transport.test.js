'use strict';
/* Transport 时钟自检：模拟切歌 / 定位 / 暂停 / 切页 / 轮询校正，验证进度条始终准确 */

const fs = require('fs');
const vm = require('vm');

// ---- 可控时钟 ----
let CLOCK = 1000;
const sandbox = {
  performance: { now: () => CLOCK },
  Date: Date,
  Math: Math,
  isFinite: isFinite,
  Number: Number,
  console: console
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'renderer', 'js', 'transport.js'), 'utf8') +
  '\n;globalThis.Transport = Transport;', sandbox);
const T = sandbox.Transport;

let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok  ' + name); }
  else { fails++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}
function advance(ms) { CLOCK += ms; }

console.log('# 1. 起播 → 位置随墙钟推进');
T.applyMainState({ state: 'playing', track: 1, positionSec: 0, durationSec: 200, trackCount: 10, engine: 'mci' });
check('起播为 0', T.positionSec() === 0, T.positionSec());
advance(5000);
check('5s 后为 5', Math.abs(T.positionSec() - 5) < 0.01, T.positionSec());

console.log('# 2. 暂停 → 位置冻结');
T.applyMainState({ state: 'paused', track: 1, positionSec: 5, durationSec: 200 });
advance(10000);
check('暂停 10s 仍为 5', Math.abs(T.positionSec() - 5) < 0.01, T.positionSec());

console.log('# 3. 恢复 → 从 5 继续');
T.applyMainState({ state: 'playing', track: 1, positionSec: 5, durationSec: 200 });
advance(2000);
check('恢复 2s 后为 7', Math.abs(T.positionSec() - 7) < 0.01, T.positionSec());

console.log('# 4. 切歌 → 位置必须归零（旧实现的典型 bug）');
advance(1000);
T.applyMainState({ state: 'playing', track: 2, positionSec: 0, durationSec: 180 });
check('切轨后为 0', T.positionSec() === 0, T.positionSec());
advance(3000);
check('新轨 3s 后为 3', Math.abs(T.positionSec() - 3) < 0.01, T.positionSec());

console.log('# 5. 定位 → 立刻跳到目标且不被轮询拉回');
const target = Transport_commit(90);
check('定位返回 90', Math.abs(target - 90) < 0.05, target);
check('立即显示 90', Math.abs(T.positionSec() - 90) < 0.01, T.positionSec());
// 模拟 MCI 轮询仍回报旧位置（90ms 后才追上）
T.correctFrom(8, 0.5);
check('保护期内不被旧轮询拉回', Math.abs(T.positionSec() - 90) < 0.01, T.positionSec());
advance(1500);
check('1.5s 后为 91.5', Math.abs(T.positionSec() - 91.5) < 0.01, T.positionSec());
T.correctFrom(91.6, 0.5);
check('小幅偏差不校正（防抖）', Math.abs(T.positionSec() - 91.5) < 0.01, T.positionSec());
T.correctFrom(95, 0.5);
check('大幅偏差才校正', Math.abs(T.positionSec() - 95) < 0.01, T.positionSec());

console.log('# 6. 切页（重新 syncState）不应改变位置');
const before = T.positionSec();
T.applyMainState(T.snapshot()); // syncState 会用同一份快照回填
check('切页后位置不变', Math.abs(T.positionSec() - before) < 0.001, T.positionSec() + ' vs ' + before);

console.log('# 7. 拖动进度条：预览值显示，松手才提交');
T.beginSeek(30);
T.previewSeek(30);
check('拖动中显示预览 30', Math.abs(T.positionSec() - 30) < 0.01, T.positionSec());
advance(1000);
check('拖动中位置不随墙钟走', Math.abs(T.positionSec() - 30) < 0.01, T.positionSec());
const committed = T.commitSeek(30);
check('松手提交 30', Math.abs(committed - 30) < 0.05, committed);
advance(2000);
check('松手后从 30 继续 → 32', Math.abs(T.positionSec() - 32) < 0.01, T.positionSec());

console.log('# 8. 超过时长必须夹紧');
T.applyMainState({ state: 'playing', track: 3, positionSec: 0, durationSec: 100 });
T.commitSeek(500);
check('定位超界夹到时长', Math.abs(T.positionSec() - 100) < 0.01, T.positionSec());
advance(5000);
check('播放超界仍夹在时长', Math.abs(T.positionSec() - 100) < 0.01, T.positionSec());

console.log('# 9. 停止 → 归零；换碟 → 整体复位');
T.applyMainState({ state: 'stopped', track: 3, positionSec: 0, durationSec: 100 });
check('停止归零', T.positionSec() === 0, T.positionSec());
T.resetAll(1);
const s = T.snapshot();
check('换碟后 track=1', s.track === 1);
check('换碟后 status=stopped', s.status === 'stopped');
check('换碟后 position=0', s.positionSec === 0);

console.log('# 10. 未知时长时不得用 0 覆盖已知时长');
T.applyMainState({ state: 'playing', track: 1, positionSec: 0, durationSec: 250 });
T.applyMainState({ state: 'playing', track: 1, positionSec: 10, durationSec: 0 });
check('时长保持 250', Math.abs(T.durationSec - 250) < 0.001, T.durationSec);
check('位置采纳 10', Math.abs(T.positionSec() - 10) < 0.01, T.positionSec());

function Transport_commit(sec) { return T.commitSeek(sec); }

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
