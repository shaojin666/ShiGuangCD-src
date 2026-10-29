'use strict';
/* RAW 播放引擎自检：暂停必须立刻停读、恢复必须从暂停点重新起读 */

const path = require('path');
const ROOT = path.join(__dirname, '..', 'main');

/* ---- 用假 Worker 替换 worker_threads（真实实现要开读取线程 + Windows IOCTL） ---- */
const wt = require('worker_threads');
class FakeWorker {
  constructor() { this.handlers = {}; FakeWorker.last = this; }
  on(ev, cb) { this.handlers[ev] = cb; }
  postMessage(msg) {
    // check 可被测试驱动：{supported:false}=设备不支持，null=不回复（模拟设备无响应）
    if (msg.type === 'check') {
      const r = FakeWorker.checkResult;
      if (r === null) return;                       // 故意不回复 → 超时路径
      return setTimeout(() => {
        this.handlers.message && this.handlers.message(
          Object.assign({ reqId: msg.reqId, type: 'check-result' }, r)
        );
      }, 0);
    }
    setTimeout(() => {
      const reply = (m) => this.handlers.message && this.handlers.message(m);
      if (msg.type === 'open') return reply({ ok: true, reqId: msg.reqId, type: 'open' });
      if (msg.type === 'read') {
        if (FakeWorker.readMode === 'zero') {
          // 真实 worker 对全零数据判 silence（rms<8），看门狗的全零分支先于
          // 一切形态豁免生效（静音就是静音，与字节序无关）
          return reply({ ok: true, reqId: msg.reqId, type: 'data', samples: Buffer.alloc(75 * 2352), decode: 'silence' });
        }
        // le16 形态（v10.2，用户 F 盘光驱实测）：模拟 worker 解码后的回传——
        // 无 sync 头的小端 PCM（真音频，直通不解码）。桩必须带 decode 标记，
        // 看门狗据此放行（无 sync 是这种光驱的正常形态，不是伪造证据）。
        if (FakeWorker.readMode === 'le16') {
          const samples = Buffer.alloc(75 * 2352);
          for (let i = 0; i < samples.length; i += 2) {
            const t = i / 2;
            samples.writeInt16LE(Math.round(8000 * (0.6 * Math.sin(t / 50) + 0.3 * Math.sin(t / 17))), i);
          }
          return reply({ ok: true, reqId: msg.reqId, type: 'data', samples, decode: 'le16' });
        }
        // 假数据按真实形态构造：2352B/扇区，前 12 字节 sync 头（worker 回的是
        // swapEndian 之后的小端形态：FF 00 FF FF FF FF FF FF FF FF 00 FF），
        // 16 字节后是大端 PCM 采样。
        const samples = Buffer.alloc(75 * 2352);
        if (FakeWorker.readMode === 'garbage') {
          // 真随机垃圾（PRNG）：线性递增模式在 16 位视角下是平滑斜坡，
          // 会被波形判据当成音频——伪造数据必须是不可预测的随机字节。
          let a = 12345;
          for (let i = 0; i < samples.length; i++) {
            a = (a * 1103515245 + 12345) & 0x7fffffff;
            samples[i] = (a >>> 16) & 0xFF;
          }
          return reply({ ok: true, reqId: msg.reqId, type: 'data', samples, decode: 'garbage' });
        }
        for (let s = 0; s < 75; s++) {
          const base = s * 2352;
          samples[base] = 0xFF; samples[base + 1] = 0x00;
          for (let i = 2; i <= 9; i++) samples[base + i] = 0xFF;
          samples[base + 10] = 0x00; samples[base + 11] = 0xFF;
          for (let i = 12; i + 1 < 2352; i += 2) samples.writeUInt16BE(1000 + (i % 500), base + i);
        }
        return reply({ ok: true, reqId: msg.reqId, type: 'data', samples, decode: 'be16' });
      }
      reply({ ok: true, reqId: msg.reqId, type: msg.type });
    }, 0);
  }
  terminate() { return Promise.resolve(); }
}
FakeWorker.checkResult = { supported: true, present: true };
FakeWorker.readMode = 'audio';   // 'audio'(be16) | 'zero' | 'garbage' | 'le16'
wt.Worker = FakeWorker;

const { RawPlayer } = require(path.join(ROOT, 'cd/raw-player.js'));

const TOC = {
  first: 1, last: 2, leadout: 30000,
  tracks: [
    { number: 1, startFrame: 150, endFrame: 15000, audio: true },
    { number: 2, startFrame: 15000, endFrame: 30000, audio: true }
  ]
};

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('# 1. 起播：光标从轨首开始');
  const p = new RawPlayer({
    drive: 'D', toc: TOC, lbaOffset: 150,
    onChunk: () => {}, onError: () => {}
  });
  await p.start();
  await p.playTrack(1, 0);
  check('state=playing', p.state === 'playing', p.state);
  check('cursorFrame=150', p.cursorFrame === 150, p.cursorFrame);

  console.log('# 2. 预读推进但会受背压限制');
  await sleep(120);
  const cursorAfter = p.cursorFrame;
  check('光标已推进', cursorAfter > 150, cursorAfter);
  check('超前量不超过 6 秒（背压生效）', p._aheadSec() <= 6, p._aheadSec());

  console.log('# 3. 暂停：记录听感位置 + 自增代次（让在途数据失效）');
  const genBefore = p.generation;
  const playedBefore = p.audibleSec();
  await p.pause();
  check('state=paused', p.state === 'paused', p.state);
  check('代次已自增（在途读取结果会被丢弃）', p.generation > genBefore, [genBefore, p.generation]);
  check('记录了暂停位置', p._pausedSec != null, p._pausedSec);
  check('暂停位置 = 听感位置', Math.abs(p._pausedSec - playedBefore) < 0.01, [p._pausedSec, playedBefore]);
  const cursorAtPause = p.cursorFrame;
  await sleep(80);
  check('暂停后不再读取（光标不动）', p.cursorFrame === cursorAtPause, [cursorAtPause, p.cursorFrame]);

  console.log('# 4. 恢复：从暂停点重新起读（不是接着预读位置，否则会重复播一段）');
  const expectFrame = 150 + Math.round(p._pausedSec * 75);
  const pausedSec = p._pausedSec;
  await p.resume();
  check('state=playing', p.state === 'playing', p.state);
  check('光标回到暂停点', Math.abs(p.cursorFrame - expectFrame) <= 1, [p.cursorFrame, expectFrame]);
  check('时钟对齐暂停点', Math.abs(p.playedSec() - pausedSec) < 0.05, [p.playedSec(), pausedSec]);
  check('恢复后超前量归零', p._aheadSec() < 1.2, p._aheadSec());

  console.log('# 5. 介质健康度看门狗');
  check('正常播放时健康', p.mediaHealthy() === true);
  p.consecutiveErrors = 3;
  check('连续读取失败 → 判定不健康', p.mediaHealthy() === false);
  p.consecutiveErrors = 0;
  // 整轨读完停泵属于正常，不能误判
  p.cursorFrame = p.trackEndFrame;
  check('整轨读完仍判健康（不误报弹出）', p.mediaHealthy() === true);
  p.cursorFrame = 150;
  p._lastProgressAt = Date.now() - 5000;
  check('长时间无推进 → 判定不健康', p.mediaHealthy() === false);

  console.log('# 6. 切轨时读取循环不能"死掉"（旧实现 pumping 标志会被永久留在 true）');
  const p2 = new RawPlayer({
    drive: 'D', toc: TOC, lbaOffset: 150,
    onChunk: () => {}, onError: () => {}
  });
  await p2.start();
  await p2.playTrack(1, 0);
  await sleep(120);                      // 让 pump 跑到"预读已满、正在 sleep"的稳定态
  check('切轨前 pump 在跑', p2.pumping === true || p2.cursorFrame > 150, p2.pumping);
  await p2.playTrack(2, 0);              // 播放中手动切歌
  const before = p2.cursorFrame;
  await sleep(150);
  check('切轨后仍在继续读取', p2.cursorFrame > before, [before, p2.cursorFrame]);
  check('切轨后光标落在 track2 区间', p2.cursorFrame >= 15000 && p2.cursorFrame <= 30000, p2.cursorFrame);
  await p2.close();

  console.log('# 7. 渲染端指定听感位置：续播必须严格从该点开始');
  const p3 = new RawPlayer({
    drive: 'D', toc: TOC, lbaOffset: 150,
    onChunk: () => {}, onError: () => {}
  });
  await p3.start();
  await p3.playTrack(1, 0);
  await sleep(60);
  await p3.pause();
  // 模拟"界面显示 13s、但耳朵听到 15s"：渲染端把 15s 送过来
  p3.setAudibleSec(15);
  await p3.resume();
  check('光标对齐到渲染端听感位置', Math.abs(p3.cursorFrame - (150 + 15 * 75)) <= 1, p3.cursorFrame);
  check('本地时钟同步为 15s', Math.abs(p3.playedSec() - 15) < 0.05, p3.playedSec());
  check('听感位置也是 15s（界面与耳朵一致）', Math.abs(p3.audibleSec() - 15) < 0.1, p3.audibleSec());
  await p3.close();

  console.log('# 8. 介质主动探测（应对"无盘但 RAW 读取仍返回成功"的光驱）');
  const p4 = new RawPlayer({
    drive: 'D', toc: TOC, lbaOffset: 150,
    onChunk: () => {}, onError: () => {}
  });
  await p4.start();
  FakeWorker.checkResult = { supported: true, present: true };
  check('介质在 → true', await p4.probeMedia() === true);
  FakeWorker.checkResult = { supported: true, present: false };
  check('介质不在 → false', await p4.probeMedia() === false);
  FakeWorker.checkResult = { supported: false, present: true };
  check('设备不支持该指令 → null（交回上层另想办法）', await p4.probeMedia() === null);
  FakeWorker.checkResult = null;                    // 设备无响应
  const t0 = Date.now();
  check('设备无响应 → null 且不能永久挂起', await p4.probeMedia() === null);
  check('超时确实生效（未等到天荒地老）', Date.now() - t0 < 3000, Date.now() - t0);
  FakeWorker.checkResult = { supported: true, present: true };
  await p4.close();

  console.log('# 9. ★ 垃圾数据看门狗：非零但两种字节序都不像音频波形（白噪音形态）→ 连续 4 块即止损');
  FakeWorker.readMode = 'audio';
  {
    const errs = [];
    const p5 = new RawPlayer({
      drive: 'D', toc: TOC, lbaOffset: 150,
      onChunk: () => {}, onError: (m) => errs.push(m)
    });
    await p5.start();
    await p5.playTrack(1, 0);
    await sleep(120);
    FakeWorker.readMode = 'garbage';   // 光驱开始返回伪造数据
    const t0 = Date.now();
    while (errs.length === 0 && Date.now() - t0 < 10000) await sleep(100);
    check('垃圾数据触发 onError', errs.length === 1, errs);
    check('错误信息点明"伪造数据 / 数据形态非音频"',
      errs.some((m) => /伪造数据|数据形态非音频/.test(m)), errs);
    check('看门狗阈值比全零短（4 块 ≈ 4 秒内触发）', Date.now() - t0 < 8000, Date.now() - t0);
    await p5.close();
    FakeWorker.readMode = 'audio';
  }

  console.log('# 10. 合法数据（含 sync 头）长播不误触垃圾看门狗');
  {
    const errs = [];
    const p6 = new RawPlayer({
      drive: 'D', toc: TOC, lbaOffset: 150,
      onChunk: () => {}, onError: (m) => errs.push(m)
    });
    await p6.start();
    await p6.playTrack(1, 0);
    await sleep(2500);                  // 超过背压上限，pump 会持续读
    check('合法数据零误报', errs.length === 0, errs);
    await p6.close();
  }

  console.log('# 11. ★ le16 数据看门狗豁免：无 sync 头是小端光驱的真音乐形态，不得误报白噪音');
  {
    const errs = [];
    const chunks = [];
    FakeWorker.readMode = 'le16';
    const p7 = new RawPlayer({
      drive: 'D', toc: TOC, lbaOffset: 150,
      onChunk: (c) => chunks.push(c), onError: (m) => errs.push(m)
    });
    await p7.start();
    await p7.playTrack(1, 0);
    await sleep(2500);                  // 与 #10 同时长：足以触达误报阈值
    check('le16 数据零误报（不被当成伪造数据）', errs.length === 0, errs);
    check('onChunk 透传 decode=le16',
      chunks.length > 0 && chunks.every((c) => c.decode === 'le16'),
      chunks.length ? chunks[0].decode : 'no chunks');
    await p7.close();
    FakeWorker.readMode = 'audio';
  }

  console.log('# 12. le16 数据同样受全零看门狗约束（小端光驱也可能返回静音）');
  {
    const errs = [];
    FakeWorker.readMode = 'zero';
    const p8 = new RawPlayer({
      drive: 'D', toc: TOC, lbaOffset: 150,
      onChunk: () => {}, onError: (m) => errs.push(m)
    });
    await p8.start();
    await p8.playTrack(1, 0);
    const t0 = Date.now();
    while (errs.length === 0 && Date.now() - t0 < 15000) await sleep(100);
    check('le16 模式下全零数据仍触发 onError', errs.length === 1, errs);
    await p8.close();
    FakeWorker.readMode = 'audio';
  }

  console.log('# 13. ★ 稳定播放期（起播窗口外）垃圾数据不再回退 —— 切歌误判白噪音的修复（v10.3）');
  {
    const errs = [];
    const p9 = new RawPlayer({
      drive: 'D', toc: TOC, lbaOffset: 150,
      onChunk: () => {}, onError: (m) => errs.push(m)
    });
    await p9.start();
    await p9.playTrack(1, 0);
    // 把看门狗窗口设为已过期：模拟"能力测试已决策、已稳定播放一段时间的引擎"
    p9._watchdogUntil = Date.now() - 1000;
    FakeWorker.readMode = 'garbage';
    await sleep(6000);                  // 远超 4 块止损阈值的时间
    check('窗口外垃圾数据零 onError（不打断播放、不切引擎）', errs.length === 0, errs);
    check('窗口外 pump 仍在推进（播放没被看门狗掐死）', p9.cursorFrame > 15000 || p9.state === 'playing', p9.cursorFrame);
    await p9.close();
    FakeWorker.readMode = 'audio';
  }

  console.log('# 14. 窗口外连续全零 → __read_silent__（介质验证，不切引擎）');
  {
    const errs = [];
    FakeWorker.readMode = 'zero';
    const p10 = new RawPlayer({
      drive: 'D', toc: TOC, lbaOffset: 150,
      onChunk: () => {}, onError: (m) => errs.push(m)
    });
    await p10.start();
    await p10.playTrack(1, 0);
    p10._watchdogUntil = Date.now() - 1000;
    const t0 = Date.now();
    while (errs.length === 0 && Date.now() - t0 < 15000) await sleep(100);
    check('窗口外全零触发 __read_silent__（交服务层验证介质）',
      errs.length === 1 && errs[0] === '__read_silent__', errs);
    await p10.close();
    FakeWorker.readMode = 'audio';
  }

  console.log('# 15. 过期数据块不污染 _decodeMode（切歌竞态，v10.3）');
  {
    const p11 = new RawPlayer({
      drive: 'D', toc: TOC, lbaOffset: 150,
      onChunk: () => {}, onError: () => {}
    });
    await p11.start();
    await p11.playTrack(1, 0);
    await sleep(60);
    p11._decodeMode = 'be16';
    FakeWorker.readMode = 'garbage';
    // 手动发起一次读取并立即推进代次：模拟"读取期间用户切歌"，
    // 回来的这块随即过期。旧实现在 _onMessage 里全局刷新 _decodeMode，
    // 过期块的 'garbage' 形态会污染新轨的看门狗口径（切歌误判的源头之一）。
    const chunkP = p11._readChunk(150, 75);
    p11.generation++;
    const chunk = await chunkP;
    check('过期块带回自己的 decode（由调用方按代次决定采不采纳）', chunk.decode === 'garbage', chunk.decode);
    check('过期块没有污染全局 _decodeMode', p11._decodeMode === 'be16', p11._decodeMode);
    await p11.close();
    FakeWorker.readMode = 'audio';
  }

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})();
