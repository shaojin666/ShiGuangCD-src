'use strict';
/* MCI 播放器时间轴自检：验证 MSF 映射、起播/定位位置、轨末判定 */

const path = require('path');
const Module = require('module');
const ROOT = require('path').join(__dirname, '..', 'main');

const TOC = {
  first: 1, last: 3, leadout: 74000,
  tracks: [
    { number: 1, startFrame: 150, endFrame: 22000, durationSec: 291.3, audio: true },
    { number: 2, startFrame: 22000, endFrame: 48000, durationSec: 346.7, audio: true },
    { number: 3, startFrame: 48000, endFrame: 74000, durationSec: 346.7, audio: true }
  ]
};
// MCI 自己的时间轴：msf 0 = 首轨起点（TOC 绝对帧 150）
const MSF_START = [0, 21850, 47850];
const MSF_LEN = [21850, 26000, 26000];

function toMsf(f) {
  const min = Math.floor(f / 4500), sec = Math.floor((f % 4500) / 75), fr = f % 75;
  return `${min}:${String(sec).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}
function toFrame(s) {
  const m = /^(\d+):(\d+):(\d+)$/.exec(String(s).trim());
  return parseInt(m[1], 10) * 4500 + parseInt(m[2], 10) * 75 + parseInt(m[3], 10);
}

let perTrackQueryFails = false;
/** 模拟"设备不支持 status cd position"（部分虚拟光驱） */
let posQueryFails = false;
/**
 * 模拟命令耗时：`pause cd` 是同步阻塞调用，MCI 在返回前还会往前播一点点。
 * 真实光驱上这个量级是几十到几百毫秒，正是旧实现"暂停点偏后"的来源。
 */
let pauseLatencyFrames = 0;
/** 模拟 drive 把请求的定位帧贴到扇区边界（向前推进 0..n-1 帧） */
let seekSnapFrames = 0;
const cmds = [];
const sim = { mode: 'stopped', pos: 0, stopAt: 0, lastPlay: null };

const fakeNative = {
  mciSend(cmd) {
    const c = String(cmd);
    cmds.push(c);
    if (/^open /.test(c)) return { code: 0, text: '' };
    if (/^set cd time format/.test(c)) return { code: 0, text: '' };
    let mm;
    if ((mm = /^status cd position track (\d+)/.exec(c))) {
      const n = parseInt(mm[1], 10);
      if (perTrackQueryFails) return { code: 277, text: '' };
      return { code: 0, text: toMsf(MSF_START[n - 1]) };
    }
    if ((mm = /^status cd length track (\d+)/.exec(c))) {
      const n = parseInt(mm[1], 10);
      if (perTrackQueryFails) return { code: 277, text: '' };
      return { code: 0, text: toMsf(MSF_LEN[n - 1]) };
    }
    if (/^status cd position/.test(c)) {
      if (posQueryFails) return { code: 277, text: '' };
      return { code: 0, text: toMsf(sim.pos) };
    }
    if (/^status cd mode/.test(c)) return { code: 0, text: sim.mode };
    if (/^status cd media present/.test(c)) return { code: 0, text: 'true' };
    if ((mm = /^play cd from (\S+) to (\S+)/.exec(c))) {
      const from = toFrame(mm[1]), to = toFrame(mm[2]);
      sim.lastPlay = { from, to };
      // 驱动定位：若有 snap 设置，把落点按扇区对齐（向前推进 0..seekSnapFrames-1 帧，
      // 真实驱动就是这样把请求帧"贴"到最近的扇区边界上的）
      sim.pos = seekSnapFrames ? from + (seekSnapFrames - (from % seekSnapFrames)) : from;
      sim.stopAt = to; sim.mode = 'playing';
      return { code: 0, text: '' };
    }
    if (/^pause cd/.test(c)) {
      // 命令处理期间 MCI 还在往前走 → 真实停下的位置比下发时刻更靠后
      sim.pos += pauseLatencyFrames;
      sim.mode = 'paused';
      return { code: 0, text: '' };
    }
    if (/^resume cd/.test(c)) { sim.mode = 'playing'; return { code: 0, text: '' }; }
    if (/^stop cd/.test(c)) { sim.mode = 'stopped'; sim.pos = 0; return { code: 0, text: '' }; }
    if (/^close cd/.test(c)) return { code: 0, text: '' };
    return { code: 275, text: '' };
  },
  mciError: (c) => 'fake ' + c
};
const nativeId = require.resolve(path.join(ROOT, 'native.js'));
const m = new Module(nativeId, null);
m.filename = nativeId; m.loaded = true; m.exports = fakeNative;
require.cache[nativeId] = m;

const { MciPlayer } = require(path.join(ROOT, 'cd/mci-player.js'));

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const events = [];
const player = new MciPlayer({
  drive: 'D', toc: TOC,
  onPosition: (p) => events.push(['pos', p]),
  onRemoved: () => events.push(['removed']),
  onTrackEnd: (t) => events.push(['end', t]),
  log: () => {}
});

(async () => {
  console.log('# 1. open 后建立 MSF 映射（与 MCI 自身时间轴一致）');
  check('open 成功', await player.open() === true);
  check('track1 msf 起点 = 0', player._msfStart.get(1) === 0, player._msfStart.get(1));
  check('track2 msf 起点 = 21850', player._msfStart.get(2) === 21850, player._msfStart.get(2));
  check('track1 时长 291.33s', Math.abs(player.trackLengthSec(1) - 21850 / 75) < 0.01, player.trackLengthSec(1));

  console.log('# 2. 起播位置必须与 MCI 时间轴对齐（旧的 +origin 会偏 4 秒）');
  await player.playTrack(1, 0);
  check('from = 0 (00:00:00)', sim.lastPlay.from === 0, sim.lastPlay);
  check('to = 21850', sim.lastPlay.to === 21850, sim.lastPlay);
  check('本地位置 = 0', Math.abs(player.positionSec()) < 0.01, player.positionSec());

  await player.playTrack(2, 0);
  check('切轨 from = 21850', sim.lastPlay.from === 21850, sim.lastPlay);
  check('切轨 to = 47850', sim.lastPlay.to === 47850, sim.lastPlay);

  console.log('# 3. 定位：保持"到本轨末"边界，不会播到导出区循环');
  await player.seekToSeconds(60);
  check('seek from = 21850+4500', sim.lastPlay.from === 21850 + 4500, sim.lastPlay);
  check('seek 仍带 to 边界', sim.lastPlay.to === 47850, sim.lastPlay);
  check('本地位置 = 60', Math.abs(player.positionSec() - 60) < 0.01, player.positionSec());

  console.log('# 4. 暂停 / 恢复：MCI 位置保留，本地位置连续');
  sim.pos = 21850 + 4500; // 模拟 MCI 真的停在这里
  await player.pause();
  check('MCI mode=paused', sim.mode === 'paused', sim.mode);
  check('本地状态 = paused', player.state === 'paused');
  check('本地位置仍 = 60', Math.abs(player.positionSec() - 60) < 0.01, player.positionSec());
  sim.pos = 21850 + 75 * 75; // 有人又把它挪了一下
  await player.resume();
  check('MCI mode=playing', sim.mode === 'playing', sim.mode);
  check('恢复后仍从 60 继续', Math.abs(player.positionSec() - 60) < 0.01, player.positionSec());

  console.log('# 5. 暂停态定位：必须 play+pause，不能把暂停态弄丢');
  await player.pause();
  await player.seekToSeconds(120);
  check('MCI mode 仍是 paused', sim.mode === 'paused', sim.mode);
  check('本地状态仍是 paused', player.state === 'paused', player.state);
  check('本地位置 = 120', Math.abs(player.positionSec() - 120) < 0.01, player.positionSec());

  console.log('# 6. 逐轨查询失败时的回退换算（raw TOC：msf = 绝对帧 - 150）');
  player.close();
  perTrackQueryFails = true;
  const p2 = new MciPlayer({ drive: 'D', toc: TOC, log: () => {} });
  check('open 仍成功', await p2.open() === true);
  check('回落 track1 msf = 0', p2._msfStart.get(1) === 0, p2._msfStart.get(1));
  check('回落 track2 msf = 21850', p2._msfStart.get(2) === 21850, p2._msfStart.get(2));
  check('回落 track3 msf = 47850', p2._msfStart.get(3) === 47850, p2._msfStart.get(3));
  p2.close();

  /* ============================================================
     A–E：位置权威链（本次修复的核心）
     ------------------------------------------------------------
     症状：暂停后续播"往前跳几秒"、每暂停一次偏差累积一次、
           快进后 LRC 歌词跑偏。
     根因：pause() 在**下发 pause cd 之前**量位置，且从不回读 MCI 真实落点；
           resume() 用 `resume cd` 让 MCI 从它自己的内部位置继续，
           应用却把锚点钉在自己的时钟上 —— 两套基准互不覆盖。
     ============================================================ */

  console.log('\n# A. 暂停点必须是 MCI 真实停下的位置（回读值），而不是命令前的估计值');
  {
    cmds.length = 0;
    const pa = new MciPlayer({
      drive: 'D', toc: TOC,
      onPosition: (p) => events.push(['A-pos', p]),
      onTrackEnd: () => {}, onRemoved: () => {}, log: () => {}
    });
    await pa.open();
    await pa.playTrack(1, 30);
    // MCI 真实推进到 30s + 2s
    sim.pos = toFrame(toMsf(MSF_START[0])) + 32 * 75;
    // 下一条 pause cd 还要再花 0.4s 才真正停下
    pauseLatencyFrames = Math.round(0.4 * 75);
    await pa.pause();
    pauseLatencyFrames = 0;
    // 真实停下位置 = 32.4s；旧实现会记成 32.0s 附近（命令前量的）
    check('暂停点 = 回读值 32.4s（不是命令前的估计值）',
      Math.abs(pa.audibleSec() - 32.4) < 0.02, pa.audibleSec());
    check('_pausedSec 已被写入', Math.abs(pa._pausedSec - 32.4) < 0.02, pa._pausedSec);
    check('上报的 onPosition.sec = 回读值',
      Math.abs(events.filter((e) => e[0] === 'A-pos').pop()[1].sec - 32.4) < 0.02,
      events.filter((e) => e[0] === 'A-pos').pop()[1]);
    pa.close();
  }

  console.log('\n# B. 连续 5 轮 暂停/续播：偏差不得累积，且不再使用 resume cd');
  {
    cmds.length = 0;
    const pb = new MciPlayer({
      drive: 'D', toc: TOC,
      onPosition: () => {}, onTrackEnd: () => {}, onRemoved: () => {}, log: () => {}
    });
    await pb.open();
    await pb.playTrack(1, 10);
    // 真值从 10s 出发，每轮 MCI 前进 1s，pause 命令再花 0.3s
    let truth = 10;
    for (let i = 0; i < 5; i++) {
      truth += 1;
      sim.pos = toFrame(toMsf(MSF_START[0])) + Math.round(truth * 75);
      pauseLatencyFrames = Math.round(0.3 * 75);
      await pb.pause();
      pauseLatencyFrames = 0;
      truth += 0.3;
      // 续播必须从暂停点物理重起
      await pb.resume();
      check(`第 ${i + 1} 轮续播后位置与真值一致（不累积）`,
        Math.abs(pb.audibleSec() - truth) < 0.06,
        [pb.audibleSec(), truth]);
    }
    const resumeCmds = cmds.filter((c) => /^resume cd/.test(c)).length;
    const playFromCmds = cmds.filter((c) => /^play cd from/.test(c)).length;
    check('全程未使用 resume cd（改用 play cd from 物理重起）', resumeCmds === 0, resumeCmds);
    check('续播确实走了 play cd from', playFromCmds >= 5, playFromCmds);
    pb.close();
  }

  console.log('\n# C. 暂停态定位：落点必须回读 MCI，而不是直接信任请求值');
  {
    const pc = new MciPlayer({
      drive: 'D', toc: TOC,
      onPosition: () => {}, onTrackEnd: () => {}, onRemoved: () => {}, log: () => {}
    });
    await pc.open();
    await pc.playTrack(2, 0);
    // 驱动把定位帧贴到 75 帧的扇区边界上，落点会比请求值多 0..74 帧
    seekSnapFrames = 75;
    // 先算出真实请求帧的确切落点，断言必须对上"回读值"而不是"请求值"
    const reqFrame = Math.round(MSF_START[1] + 100 * 75);
    const snapFrame = reqFrame + (75 - (reqFrame % 75));
    const snapSec = (snapFrame - MSF_START[1]) / 75;
    check('（前置）模拟落点与请求值确实不同',
      Math.abs(snapSec - 100) > 0.1, [snapSec, 100]);

    await pc.seekToSeconds(100);
    check('播放态定位上报回读落点（而非请求的 100s）',
      Math.abs(pc.audibleSec() - snapSec) < 0.02, [pc.audibleSec(), snapSec]);

    await pc.pause();
    const reqFrame2 = Math.round(MSF_START[1] + 120 * 75);
    const snapFrame2 = reqFrame2 + (75 - (reqFrame2 % 75));
    const snapSec2 = (snapFrame2 - MSF_START[1]) / 75;
    await pc.seekToSeconds(120);
    check('暂停态定位后仍是 paused', pc.state === 'paused', pc.state);
    check('暂停态定位上报回读落点', Math.abs(pc.audibleSec() - snapSec2) < 0.02,
      [pc.audibleSec(), snapSec2]);
    check('暂停点同步落进 _pausedSec', Math.abs(pc._pausedSec - snapSec2) < 0.02, pc._pausedSec);
    seekSnapFrames = 0;
    pc.close();
  }

  console.log('\n# D. 起播校验：MCI 落在别处时本地时钟必须被对齐（死区已收紧到 0.04，v10.3）');
  {
    const pd = new MciPlayer({
      drive: 'D', toc: TOC,
      onPosition: () => {}, onTrackEnd: () => {}, onRemoved: () => {}, log: () => {}
    });
    await pd.open();
    // 请求从 30s 起播，MCI 实际落在 30.2s（典型的上轨起点/驱动舍入误差）
    await pd.playTrack(2, 30);
    sim.pos = MSF_START[1] + Math.round(30.2 * 75);
    pd._correct(30.2);
    check('0.2s 偏差被纠正',
      Math.abs(pd.positionSec() - 30.2) < 0.02, pd.positionSec());
    // 量化噪声（1/75s ≈ 13ms）以内不该打扰本地时钟
    const before = pd.positionSec();
    check('0.03s 以内（量化噪声）不触发校正', pd._correct(before + 0.03) === false, [before, pd.positionSec()]);
    // 超过死区的偏差必须被纠正（歌词同步依赖这条：v10.3 收紧到 0.04 后，
    // 起播校验遗留的小偏差不再被永久保留，歌词不会再"比音乐快半秒"）
    check('0.1s 偏差触发校正', pd._correct(before + 0.1) === true, [before, pd.positionSec()]);
    pd.close();
  }

  console.log('\n# E. 设备不支持 status cd position → 静默回退，绝不抛异常');
  {
    const pe = new MciPlayer({
      drive: 'D', toc: TOC,
      onPosition: () => {}, onTrackEnd: () => {}, onRemoved: () => {}, log: () => {}
    });
    await pe.open();
    await pe.playTrack(1, 50);
    posQueryFails = true;
    let threw = null;
    try {
      await pe.pause();
      check('pause 不抛异常', true);
      await pe.resume();
      check('resume 不抛异常', true);
      await pe.seekToSeconds(80);
      check('seekToSeconds 不抛异常', true);
    } catch (e) {
      threw = e;
      check('回读不可用时不得抛异常', false, e.message);
    }
    check('确实没有异常', threw === null);
    check('回退后仍保持 paused/playing 语义（state 合法）',
      ['paused', 'playing'].indexOf(pe.state) >= 0, pe.state);
    check('位置回退到本地时钟语义（> 0 且有限）',
      isFinite(pe.audibleSec()) && pe.audibleSec() > 0, pe.audibleSec());
    posQueryFails = false;
    pe.close();
  }

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})();
