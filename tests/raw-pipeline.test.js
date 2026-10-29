'use strict';
/*
 * raw-pipeline.test.js —— RAW 播放全链路集成自检（主进程侧，不依赖 Windows/光驱）。
 *
 * 与既有套件的分工：
 *   raw-player.test.js   用假 Worker 驱动 RawPlayer 单体（协议级模拟）；
 *   engine-select.test.js 用假播放器驱动 CdService 的引擎选择；
 *   本套件把**真实**的 RawPlayer + **真实**的 reader-worker（vm 内装载）
 *   + **真实**的 CdService 串起来，假 native 只负责"光驱"本身。
 *   它回答的是一个具体的事故："日志说 RAW 数字读取可用，就是没声音"——
 *   数据到底有没有从光驱流到 cd:audio、内容是不是音频、帧号约定对不对。
 *
 * 场景（1/2/3/3b/4/5）：
 *   1) 正常链路：rawRead 返回带 LBA 标记的非零测试音 →
 *      验证 chunk 流动、LBA/absFrame 换算、swapEndian 字节序、内容非零；
 *   2) "读取成功但全零"的光驱（虚拟光驱/部分 USB 光驱的典型行为）→
 *      能力测试必须判不过、回退 MCI，而不是进入 RAW 模式全程静音；
 *   3) 播放中才开始返回全零（弹盘后设备不报错的那类）→
 *      连续全零看门狗必须触发并切换 MCI 续播；
 *   3b) 播放中才开始返回垃圾数据（非零但两种字节序都不像音频波形，白噪音形态）→
 *      垃圾数据看门狗触发并切换 MCI；
 *   4) 小端 16bit PCM 光驱（v10.2，用户 F 盘实体光驱实测形态：无 sync 头、
 *      小端直通即真音频）→ 能力测试按波形判据放行，reader-worker 走 le16
 *      直通解码（不做字节交换），播放看门狗不得误报白噪音；
 *   5) 读取线程对 open 无响应 → start() 必须超时失败，不许挂起。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..', 'main');

/* ================= 可编程假 native ================= */

/** 'audio' = 带标记的非零测试音；'zero' = 全零（模拟不支持数字音频提取的光驱） */
const cfg = { rawReadMode: 'audio' };
const rawReadLog = [];

/**
 * 小端 PCM 样本发生器（le16 假光驱 + 校验端共用，保证"光驱返回什么、
 * 主进程就收到什么"可逐字节对账）：
 *   多正弦叠加，相邻采样高度相关（MASD/RMS ≈ 0.3），是 detectPcmForm
 *   认可的真音频波形；幅值 ±7200，不会出现 sync 头要求的 8 连 FF。
 * t = 绝对采样序号（跨扇区连续），与 fakeRawRead 的填充式严格一致。
 */
function le16Sample(t) {
  return Math.round(8000 * (0.6 * Math.sin(t / 50) + 0.3 * Math.sin(t / 17)));
}

/** RAW TOC：绝对帧（首轨 = 150），与 engine-select.test.js 同一张碟 */
const RAW_TOC = {
  first: 1, last: 3, leadout: 74000,
  tracks: [
    { number: 1, startFrame: 150, endFrame: 22000, durationSec: 291.3, audio: true },
    { number: 2, startFrame: 22000, endFrame: 48000, durationSec: 346.7, audio: true },
    { number: 3, startFrame: 48000, endFrame: 74000, durationSec: 346.7, audio: true }
  ]
};

/**
 * 假光驱的 RAW 读取：每个扇区按真实 CD-DA 布局填充 ——
 *   0..11  sync 头（00 FF*10 00）
 *   12..15 扇区头（这里放大端 LBA 标记 0xA0000000 + lba）
 *   16..   非零测试音（Int16BE，构造上保证不为 0）
 * 标记经 reader-worker 的 swapEndian 后仍可解码，用来同时验证
 * "下发的 LBA 对不对"和"字节序翻转对不对"。
 */
function fakeRawRead(h, lba, count) {
  rawReadLog.push({ lba, count });
  const buf = Buffer.alloc(count * 2352);
  if (cfg.rawReadMode === 'zero') return buf;      // 读取"成功"但全零
  if (cfg.rawReadMode === 'garbage') {             // 非零但两种字节序都不像音频波形
    // 真随机垃圾（LCG）：线性递增模式在 16 位视角下是平滑斜坡，
    // 会被波形判据当成音频——伪造数据必须是不可预测的随机字节。
    let a = 12345;
    for (let i = 0; i < buf.length; i++) {
      a = (a * 1103515245 + 12345) & 0x7fffffff;
      buf[i] = (a >>> 16) & 0xFF;
    }
    return buf;
  }
  if (cfg.rawReadMode === 'le16') {
    // 小端 16bit PCM 光驱（v10.2，用户 F 盘实体光驱实测形态）：
    // 整个 2352B 扇区都是小端 PCM 采样 —— 无 sync 头、无扇区头，
    // 但波形平滑（真音乐）。worker 判别为 le16 后原样直通（不交换字节）。
    for (let s = 0; s < count; s++) {
      const base = s * 2352;
      for (let i = 0; i < 2352; i += 2) {
        const t = ((lba + s) * 2352 + i) / 2;      // 绝对采样序号
        buf.writeInt16LE(le16Sample(t), base + i);
      }
    }
    return buf;
  }
  for (let s = 0; s < count; s++) {
    const base = s * 2352;
    buf[base] = 0x00;
    for (let i = 1; i <= 10; i++) buf[base + i] = 0xFF;
    buf[base + 11] = 0x00;
    buf.writeUInt32BE(0xA0000000 + (lba + s), base + 12);
    for (let i = 16; i < 2352; i += 2) {
      buf.writeInt16BE(1 + ((i * 7 + s * 131 + lba * 17) % 1998), base + i);
    }
  }
  return buf;
}

const fakeNative = {
  listCdDrives: () => ['D'],
  openCdDevice: () => 1,
  closeDevice: () => {},
  readToc: () => JSON.parse(JSON.stringify(RAW_TOC)),
  readTocViaMci: () => { throw new Error('MCI 不可用'); },
  rawRead: fakeRawRead,
  checkMedia: () => ({ supported: true, present: true }),
  trayControl: () => {},
  mciSend: (cmd) => {
    if (/^status cd media present/.test(cmd)) return { code: 0, text: 'true' };
    if (/^status cd mode/.test(cmd)) return { code: 0, text: 'playing' };
    if (/^status cd position/.test(cmd)) return { code: 0, text: '00:00:00' };
    if (/^status cd length/.test(cmd)) return { code: 0, text: '04:51:00' };   // 291s
    if (/^status cd number of tracks/.test(cmd)) return { code: 0, text: '3' };
    return { code: 0, text: '00:00:00' };
  },
  mciError: () => 'fake',
  IOCTL_CDROM_EJECT_MEDIA: 0x24808,
  IOCTL_CDROM_LOAD_MEDIA: 0x2480C,
  IOCTL_CDROM_CLOSE_DOOR: 0x2D480C
};

/* ================= 真实 reader-worker 的 vm 装载 ================= */

const workerSrc = fs.readFileSync(path.join(ROOT, 'cd', 'reader-worker.js'), 'utf8');

/**
 * 假 Worker：在 vm 里跑**真实**的 reader-worker.js 源码，
 * 只替换它的两个依赖（worker_threads 的 parentPort、../native）。
 * 这样 swapEndian、readSectorsWithRetry、消息协议都是真代码在接受检验。
 */
class FakeWorker {
  constructor(file) {
    this.file = file;
    this._handlers = { message: [], error: [], exit: [] };
    const self = this;
    const port = {
      _cb: null,
      on(ev, cb) { if (ev === 'message') port._cb = cb; },
      postMessage(msg) {
        // 模拟"启动无响应"：吞掉 opened 回复（历史上 open 回复漏带 reqId
        // 被主进程丢弃，等价于这个效果 —— 起播路径永久挂起）
        if (FakeWorker.swallowOpen && msg.type === 'opened') return;
        // 真实 worker 线程间通信是宏任务：异步投递，避免比主进程的
        // 微任务置位更早（同步桩会造出生产环境不存在的竞态）
        setTimeout(() => self._deliver('message', msg), 0);      // worker → 主进程
      }
    };
    const fakeRequire = (id) => {
      if (id === 'worker_threads') return { parentPort: port };
      if (id === '../native') return fakeNative;
      // v10.2：reader-worker 的数据形态判别依赖 audio-stats 的波形判据，
      // 纯函数模块，直接装载真实实现（判据同源原则的检验点）
      if (id === './audio-stats') return require(path.join(ROOT, 'cd', 'audio-stats.js'));
      throw new Error('reader-worker 未预期的 require: ' + id);
    };
    const sandbox = { require: fakeRequire, console, Buffer, Date, setTimeout, clearTimeout };
    vm.runInNewContext(workerSrc, sandbox, { filename: 'reader-worker.js' });
    this._port = port;
  }
  on(ev, cb) { this._handlers[ev].push(cb); }
  _deliver(ev, arg) { for (const cb of this._handlers[ev]) cb(arg); }
  postMessage(msg) {
    // 主进程 → worker 同样异步化（与真实线程语义一致）
    if (this._port._cb) setTimeout(() => this._port._cb(msg), 0);
  }
  async terminate() { this._deliver('exit', 0); }
}
FakeWorker.swallowOpen = false;

/* raw-player.js 在 require 时解构 { Worker }，必须先替换再加载 */
const wt = require('worker_threads');
wt.Worker = FakeWorker;

/* 假 native / 假元数据抓取注入 require 缓存（cd-service 与 mci-player 共享） */
const nativeId = require.resolve(path.join(ROOT, 'native.js'));
require.cache[nativeId] = new Module(nativeId, null);
Object.assign(require.cache[nativeId], { filename: nativeId, loaded: true, exports: fakeNative });
const fetchId = require.resolve(path.join(ROOT, 'metadata/fetch.js'));
require.cache[fetchId] = new Module(fetchId, null);
Object.assign(require.cache[fetchId], {
  filename: fetchId, loaded: true,
  exports: { fetchDiscMetadata: async () => null }
});

/* 真实的 CdService（内部持有真实的 RawPlayer / MciPlayer） */
const { CdService } = require(path.join(ROOT, 'cd/cd-service.js'));

/* ================= 测试骨架 ================= */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcd-pipeline-'));
const sent = [];
const logs = [];
function makeSvc() {
  sent.length = 0;
  logs.length = 0;
  return new CdService({
    userData: tmp, autoPlay: false, demo: false,
    log: (m) => logs.push(m),
    send: (ch, p) => sent.push({ ch, p })
  });
}
function last(ch) {
  for (let i = sent.length - 1; i >= 0; i--) if (sent[i].ch === ch) return sent[i].p;
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/** 走完读盘仪式（1000 + 650 + 1150ms 仪式节奏 + 余量） */
async function runCeremony(svc) {
  await svc._probe();          // _beginReading 是即发即弃的
  await sleep(3300);
}

/**
 * 校验一块 cd:audio 的内容：
 *   - 每个扇区头的 LBA 标记经 swapEndian 后应可解码出 n = chunkIdx*75 + s；
 *   - 音频区必须非零。
 * 返回 { badMarker, nonZeroRatio }。
 */
function inspectChunk(samples, chunkIdx) {
  let badMarker = 0;
  let nonZero = 0;
  let total = 0;
  const sectors = samples.length / 2352;
  for (let s = 0; s < sectors; s++) {
    const base = s * 2352;
    const n = chunkIdx * 75 + s;
    if (samples.readUInt8(base + 12) !== ((n >> 16) & 0xFF) ||
        samples.readUInt8(base + 13) !== 0xA0 ||
        samples.readUInt8(base + 14) !== (n & 0xFF) ||
        samples.readUInt8(base + 15) !== ((n >> 8) & 0xFF)) {
      badMarker++;
    }
    for (let i = 16; i < 2352; i += 2) {
      total++;
      if (samples.readUInt16LE(base + i) !== 0) nonZero++;
    }
  }
  return { badMarker, nonZeroRatio: total ? nonZero / total : 0 };
}

(async () => {
  /* ---------- 1. 正常链路 ---------- */
  console.log('# 1. 全链路：RAW 起播 → worker 读取 → 字节序翻转 → cd:audio 推送');
  cfg.rawReadMode = 'audio';
  rawReadLog.length = 0;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    check('TOC 经 raw 读到（detectedVia=raw）', svc.detectedVia === 'raw', svc.detectedVia);
    check('能力试读首轨 LBA 0（75 扇区窗口，跳过静音前奏用）',
      rawReadLog[0] && rawReadLog[0].lba === 0 && rawReadLog[0].count === 75, rawReadLog[0]);
    check('能力测试通过（非零数据）', svc.engine === null, svc.engine);   // 懒加载：就绪时不抢引擎

    await svc.playTrack(1, 0);
    check('起播后 engine=raw', svc.engine === 'raw', svc.engine);
    check('上报 cd:engine=raw', (last('cd:engine') || {}).engine === 'raw');
    const st = last('cd:state');
    check('cd:state=playing 且 engine=raw', st && st.state === 'playing' && st.engine === 'raw', st);

    await sleep(2500);                       // 预读缓冲 + 持续推送
    const chunks = sent.filter((s) => s.ch === 'cd:audio');
    check('cd:audio 数据块已推送（>=5 块）', chunks.length >= 5, chunks.length);
    check('块大小 = 75 扇区 × 2352 字节',
      chunks.every((c) => c.p.samples && c.p.samples.length === 75 * 2352),
      chunks[0] && chunks[0].p.samples && chunks[0].p.samples.length);
    check('块头字段：track=1 且 absFrame 从 150 起每块 +75',
      chunks.every((c, i) => c.p.track === 1 && c.p.absFrame === 150 + 75 * i),
      chunks.map((c) => c.p.absFrame));
    check('下发给光驱的 LBA = absFrame - 150（raw TOC 偏移）',
      chunks.every((c, i) => rawReadLog[1 + i] && rawReadLog[1 + i].lba === 75 * i && rawReadLog[1 + i].count === 75),
      rawReadLog.slice(1, 4));
    const insp = chunks.map((c, i) => inspectChunk(c.p.samples, i));
    check('LBA 标记全部对得上（LBA 换算 + swapEndian 正确）',
      insp.every((r) => r.badMarker === 0), insp.map((r) => r.badMarker));
    check('音频内容非零（不是静音数据）',
      insp.every((r) => r.nonZeroRatio > 0.99), insp.map((r) => r.nonZeroRatio.toFixed(3)));
    // 注：sync 头（12 字节）与扇区头标记（4 字节）也随采样一起翻转下发，
    // 它们同样是强非零数据，因此非零率可以是 100% —— "有音频"的正确形态。
    check('首块日志报告 nonZero≈100%（且 absFrame=150）',
      /raw chunk #1: track=1 absFrame=150 bytes=176400 peak=\d+ nonZero=(99|100)\.\d%/.test(
        logs.find((m) => /raw chunk #1/.test(m)) || ''),
      logs.find((m) => /raw chunk #1/.test(m)));
    check('首块日志报告 sync=75/75（数据形态合法）',
      /sync=75\/75/.test(logs.find((m) => /raw chunk #1/.test(m)) || ''),
      logs.find((m) => /raw chunk #1/.test(m)));
    await svc.stopPlayback();
  }

  /* ---------- 2. 读取成功但全零 → 必须回退 MCI ---------- */
  console.log('# 2. 光驱"读取成功但全零"（虚拟光驱/部分 USB 光驱）→ 判不过 → MCI 回退');
  cfg.rawReadMode = 'zero';
  rawReadLog.length = 0;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    check('TOC 仍经 raw 读到（detectedVia=raw）', svc.detectedVia === 'raw', svc.detectedVia);
    check('全零数据 → RAW 判不可用，engine=mci', svc.engine === 'mci', svc.engine);
    check('上报 cd:engine=mci', (last('cd:engine') || {}).engine === 'mci');
    check('日志记录了全零判定', logs.some((m) => /全零/.test(m)),
      logs.filter((m) => /raw capability/.test(m)));
    await svc.playTrack(1, 0);
    check('起播走 MCI（有声音，只是没有音乐律动数据）',
      svc.engine === 'mci' && svc.playState === 'playing', svc.playState);
    check('MCI 模式不推送 cd:audio（没有静音 PCM 管道）',
      sent.filter((s) => s.ch === 'cd:audio').length === 0);
    await svc.stopPlayback();
  }

  /* ---------- 3. 播放中连续全零 → 看门狗切换 MCI ---------- */
  console.log('# 3. 播放中才开始全零（弹盘后设备不报错的那类）→ 看门狗触发 → MCI 续播');
  cfg.rawReadMode = 'audio';
  rawReadLog.length = 0;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    await svc.playTrack(1, 0);
    await sleep(1500);
    const before = sent.filter((s) => s.ch === 'cd:audio').length;
    check('切换前 cd:audio 正常推送', before >= 3, before);

    cfg.rawReadMode = 'zero';      // 光驱开始返回全零（介质异常/被取走且设备不报错）
    const t0 = Date.now();
    while (svc.engine !== 'mci' && Date.now() - t0 < 25000) await sleep(250);
    check('连续全零 → 已切换到 MCI', svc.engine === 'mci', svc.engine);
    check('切换后仍在播放（声音不断）', svc.playState === 'playing', svc.playState);
    check('给出了切换提示', /切换为模拟播放/.test((last('cd:notice') || {}).text || ''), last('cd:notice'));
    check('日志记录了全零看门狗', logs.some((m) => /全零/.test(m)),
      logs.filter((m) => /raw read/.test(m)));
    await svc.stopPlayback();
  }

  /* ---------- 3b. 播放中返回垃圾数据（白噪音形态）→ 看门狗切换 MCI ---------- */
  console.log('# 3b. 播放中才开始返回垃圾数据（非零但两种字节序都不像音频波形）→ 看门狗触发 → MCI 续播');
  cfg.rawReadMode = 'audio';
  rawReadLog.length = 0;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    await svc.playTrack(1, 0);
    await sleep(1500);
    const before = sent.filter((s) => s.ch === 'cd:audio').length;
    check('切换前 cd:audio 正常推送', before >= 3, before);

    cfg.rawReadMode = 'garbage';   // 光驱开始伪造数据（用户实测的白噪音形态）
    const t0 = Date.now();
    while (svc.engine !== 'mci' && Date.now() - t0 < 25000) await sleep(250);
    check('连续垃圾数据 → 已切换到 MCI', svc.engine === 'mci', svc.engine);
    check('切换后仍在播放（声音不断）', svc.playState === 'playing', svc.playState);
    check('给出了白噪音切换提示', /数据异常（白噪音）/.test((last('cd:notice') || {}).text || ''), last('cd:notice'));
    check('日志记录了垃圾数据看门狗', logs.some((m) => /两种字节序都不像音频波形/.test(m)),
      logs.filter((m) => /raw read/.test(m)));
    await svc.stopPlayback();
  }

  /* ---------- 4. 小端 16bit PCM 光驱（le16）：波形判据放行 → 直通解码 → 正常播放 ---------- */
  console.log('# 4. 小端 16bit PCM 光驱（无 sync 头、小端直通即真音频）→ 直通解码链路（v10.2）');
  cfg.rawReadMode = 'le16';
  rawReadLog.length = 0;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    check('TOC 经 raw 读到（detectedVia=raw）', svc.detectedVia === 'raw', svc.detectedVia);

    await svc.playTrack(1, 0);
    check('能力测试按波形判据放行（判出 le16），engine=raw', svc.engine === 'raw', svc.engine);
    check('能力测试日志记录了小端 PCM 说明',
      /raw capability test ok.*小端 16bit PCM/.test(
        logs.find((m) => /raw capability/.test(m)) || ''),
      logs.find((m) => /raw capability/.test(m)));

    await sleep(2500);                       // 预读缓冲 + 持续推送
    const chunks = sent.filter((s) => s.ch === 'cd:audio');
    check('cd:audio 数据块已推送（>=5 块）', chunks.length >= 5, chunks.length);
    check('块大小 = 75 扇区 × 2352 字节',
      chunks.every((c) => c.p.samples && c.p.samples.length === 75 * 2352));
    check('所有块标记 decode=le16',
      chunks.every((c) => c.p.decode === 'le16'),
      chunks[0] && chunks[0].p.decode);

    /* le16 直通正确性：worker 对 le16 数据原样回传（不做字节交换），
     * 因此主进程收到的样本必须与假光驱写出的字节逐一相同 ——
     * 这正是用户 F 盘光驱"返回小端 PCM"时要的解码路径。 */
    let bad = 0, total = 0, peak = 0;
    for (const c of chunks) {
      const samples = c.p.samples;
      const chunkIdx = (c.p.absFrame - 150) / 75;
      for (let s = 0; s < samples.length / 2352; s++) {
        const base = s * 2352;
        const lbaAbs = chunkIdx * 75 + s;
        for (let i = 0; i < 2352; i += 2) {
          const t = (lbaAbs * 2352 + i) / 2;
          const want = le16Sample(t);
          total++;
          if (samples.readInt16LE(base + i) !== want) bad++;
          if (Math.abs(want) > peak) peak = Math.abs(want);
        }
      }
    }
    check('le16 直通字节级正确（样本与小端光驱输出逐一相同）', bad === 0, bad + '/' + total);
    check('数据是真音频波形（peak 有实际幅度）', peak > 5000, peak);
    check('首块日志报告小端 PCM 适配说明（不误报垃圾数据）',
      /raw chunk #1.*小端 16bit PCM/.test(
        logs.find((m) => /raw chunk #1/.test(m)) || ''),
      logs.find((m) => /raw chunk #1/.test(m)));
    check('看门狗未误报（engine 仍为 raw）', svc.engine === 'raw', svc.engine);
    await svc.stopPlayback();
  }

  /* ---------- 4. 读取线程启动无响应 → 必须超时失败，不许挂起 ---------- */
  console.log('# 5. 读取线程对 open 无响应 → start() 超时 → MCI 回退（起播不许挂起）');
  cfg.rawReadMode = 'audio';
  rawReadLog.length = 0;
  FakeWorker.swallowOpen = true;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    const t0 = Date.now();
    await svc.playTrack(1, 0);
    const elapsed = Date.now() - t0;
    check('起播没有永久挂起（<15s 内返回）', elapsed < 15000, elapsed);
    check('超时后回退 MCI 并保持播放', svc.engine === 'mci' && svc.playState === 'playing',
      { engine: svc.engine, state: svc.playState });
    check('日志记录了启动超时', logs.some((m) => /启动超时/.test(m)),
      logs.filter((m) => /raw player/.test(m)));
    await svc.stopPlayback();
  }
  FakeWorker.swallowOpen = false;

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
