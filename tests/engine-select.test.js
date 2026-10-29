'use strict';
/*
 * engine-select.test.js —— 播放引擎预选自检。
 *
 * 核心约束（对应"完善 raw 读取、保留 MCI 回退、为音乐律动做准备"）：
 *   1) 无论 TOC 经 RAW 还是 MCI 读到，都优先尝试 RAW 数字读取 ——
 *      只有 RAW 能拿到 PCM（音乐律动可视化的数据来源）；
 *   2) RAW 不可用（虚拟光驱 / 不支持数字音频提取）才回退 MCI；
 *   3) 同一张碟的 RAW TOC 与 MCI TOC 必须得到相同签名，
 *      否则"这次 RAW 读到、下次 MCI 兜底"会被误判成换碟，触发整轮重读仪式；
 *   4) RAW 能力测试要跳过数据轨（CD-Extra 混合盘首轨可能是数据轨）。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..', 'main');

/* ---------- 可编程假 native ---------- */
const cfg = { rawTocOk: true, rawReadOk: true, mciOk: true, zeroUntilLba: 0, garbage: false, garbageUntilLba: Infinity, le16: false };
const rawReadLbas = [];

/** RAW TOC：绝对帧（首轨 = 150） */
const RAW_TOC = {
  first: 1, last: 3, leadout: 74000,
  tracks: [
    { number: 1, startFrame: 150, endFrame: 22000, durationSec: 291.3, audio: true },
    { number: 2, startFrame: 22000, endFrame: 48000, durationSec: 346.7, audio: true },
    { number: 3, startFrame: 48000, endFrame: 74000, durationSec: 346.7, audio: true }
  ]
};
/** MCI TOC：LBA 帧（首轨 = 0），与上面的 RAW_TOC 是同一张碟 */
const MCI_TOC = {
  first: 1, last: 3, leadout: 73850, mciOrigin: 150,
  tracks: [
    { number: 1, startFrame: 0, endFrame: 21850, durationSec: 291.3, audio: true },
    { number: 2, startFrame: 21850, endFrame: 47850, durationSec: 346.7, audio: true },
    { number: 3, startFrame: 47850, endFrame: 73850, durationSec: 346.7, audio: true }
  ]
};

const fakeNative = {
  listCdDrives: () => ['D'],
  openCdDevice: () => 1,
  closeDevice: () => {},
  readToc: () => {
    if (!cfg.rawTocOk) throw new Error('IOCTL 不可用（虚拟光驱）');
    return JSON.parse(JSON.stringify(RAW_TOC));
  },
  readTocViaMci: () => {
    if (!cfg.mciOk) throw new Error('MCI 不可用');
    return JSON.parse(JSON.stringify(MCI_TOC));
  },
  rawRead: (h, lba, count) => {
    rawReadLbas.push({ lba, count });
    if (!cfg.rawReadOk) throw new Error('RAW 读取失败（光驱不支持数字音频提取）');
    const buf = Buffer.alloc(count * 2352);
    // 静音前奏模拟：zeroUntilLba 之前的 LBA 返回全零（CD-DA 数字静音），
    // 之后返回真音频。用户实测碟轨首 2 帧就是静音，旧能力测试只读 2 帧
    // 被误判成"不支持数字提取"回退 MCI。
    if (lba < cfg.zeroUntilLba) return buf;
    // 垃圾数据模式（白噪音模拟）：非零但两种字节序都不像音频波形 —— 驱动伪造数据，
    // 能力测试的波形判据应判不可用（v10.2 改判据：线性递增在 16 位视角下是
    // 平滑斜坡会被误判为音频，伪造数据必须用真随机）。
    // garbageUntilLba 之前的 LBA 返回垃圾，之后转真音频（混合场景）。
    if (cfg.garbage && lba < cfg.garbageUntilLba) {
      let a = 12345;
      for (let i = 0; i < buf.length; i++) {
        a = (a * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = (a >>> 16) & 0xFF;
      }
      return buf;
    }
    // 小端 16bit PCM 模式（v10.2，用户 F 盘实体光驱实测形态）：无 sync 头，
    // 每个 16bit 采样以小端存放（USB 桥接固件行为），波形平滑即真音乐。
    // 能力测试的波形判据应判 le16 放行（sync 缺失不再是误判理由）。
    if (cfg.le16) {
      for (let s = 0; s < count; s++) {
        for (let i = 0; i < 2352; i += 2) {
          const t = ((lba + s) * 2352 + i) / 2;
          buf.writeInt16LE(Math.round(8000 * (0.6 * Math.sin(t / 50) + 0.3 * Math.sin(t / 17))), s * 2352 + i);
        }
      }
      return buf;
    }
    // 真音频：每扇区写合法 CD-DA sync 头（00 FF*10 00）+ 大端 PCM 采样
    for (let s = 0; s < count; s++) {
      const o = s * 2352;
      buf[o] = 0x00;
      for (let i = 1; i <= 10; i++) buf[o + i] = 0xFF;
      buf[o + 11] = 0x00;
      for (let i = 12; i + 1 < 2352; i += 2) buf.writeUInt16BE(1000 + ((i + s * 37) % 500), o + i);
    }
    return buf;
  },
  trayControl: () => {},
  mciSend: (cmd) => ({ code: 0, text: /media present/.test(cmd) ? 'true' : '00:00:00' }),
  mciError: () => 'fake',
  IOCTL_CDROM_EJECT_MEDIA: 1, IOCTL_CDROM_LOAD_MEDIA: 2, IOCTL_CDROM_CLOSE_DOOR: 3
};
const nativeId = require.resolve(path.join(ROOT, 'native.js'));
require.cache[nativeId] = new Module(nativeId, null);
Object.assign(require.cache[nativeId], { filename: nativeId, loaded: true, exports: fakeNative });

/* 假元数据抓取：直接返回 null（失败路径），避免测试依赖网络 */
const fetchId = require.resolve(path.join(ROOT, 'metadata/fetch.js'));
require.cache[fetchId] = new Module(fetchId, null);
Object.assign(require.cache[fetchId], {
  filename: fetchId, loaded: true,
  exports: { fetchDiscMetadata: async () => null }
});

/* ---------- 假播放器 ---------- */
class FakeRawPlayer {
  constructor(o) { this.opts = o; this.state = 'stopped'; this.trackNumber = 0; this.sec = 0; }
  async start() {}
  async playTrack(n, fromSec) { this.trackNumber = n; this.sec = fromSec || 0; this.state = 'playing'; }
  pause() { if (this.state === 'playing') { this._pausedSec = this.sec; this.state = 'paused'; } }
  resume() { if (this.state === 'paused') { this.sec = this._pausedSec || 0; this.state = 'playing'; } }
  async stop() { this.state = 'stopped'; this.sec = 0; }
  async close() { this.state = 'closed'; }   // 与真实播放器一致：close 必须停掉泵
  seekToSeconds(sec) { this.sec = sec; }
  setAudibleSec(sec) { this.sec = sec; }
  positionSec() { return this.sec; }
  audibleSec() { return this.sec; }
  mediaHealthy() { return true; }
  async probeMedia() { return true; }
  getPositionFrame() { return 0; }
}
class FakeMciPlayer {
  constructor(o) { this.opts = o; this.state = 'stopped'; this.trackNumber = 0; this.sec = 0; }
  async open() { return cfg.mciOk; }
  async playTrack(n, fromSec) { this.trackNumber = n; this.sec = fromSec || 0; this.state = 'playing'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'playing'; }
  async stop() { this.state = 'stopped'; this.sec = 0; }
  async close() { this.state = 'closed'; }
  setAudibleSec(sec) { this.sec = sec; }
  seekToSeconds(sec) { this.sec = sec; }
  positionSec() { return this.sec; }
  audibleSec() { return this.sec; }
  isMediaPresent() { return true; }
  async eject() { return true; }
  async closeDoor() { return true; }
}
const rawId = require.resolve(path.join(ROOT, 'cd/raw-player.js'));
require.cache[rawId] = new Module(rawId, null);
Object.assign(require.cache[rawId], {
  filename: rawId, loaded: true,
  exports: { RawPlayer: FakeRawPlayer, CHUNK_SECTORS: 75, CHUNK_SECONDS: 1 }
});
const mciId = require.resolve(path.join(ROOT, 'cd/mci-player.js'));
require.cache[mciId] = new Module(mciId, null);
Object.assign(require.cache[mciId], {
  filename: mciId, loaded: true,
  exports: { MciPlayer: FakeMciPlayer, msfToFrame: () => 0, frameToMsf: () => '' }
});

const { CdService } = require(path.join(ROOT, 'cd/cd-service.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcd-engine-'));
const sent = [];
function makeSvc(enginePreference) {
  sent.length = 0;
  const opts = {
    userData: tmp, autoPlay: false, demo: false,
    log: () => {}, send: (ch, p) => sent.push({ ch, p })
  };
  // 引擎偏好（v9）：以活引用传入，与主进程 index.js 的接线一致
  if (enginePreference) opts.settings = { enginePreference };
  return new CdService(opts);
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
  await svc._probe();          // 注意：_beginReading 是即发即弃的
  await sleep(3300);
}

(async () => {
  console.log('# 1. MCI 识别到的碟 + RAW 可用 → 起播走 RAW（★ 核心修复）');
  cfg.rawTocOk = false; cfg.mciOk = true; cfg.rawReadOk = true;
  rawReadLbas.length = 0;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    check('仪式完成 phase=ready', svc.phase === 'ready', svc.phase);
    check('detectedVia=mci', svc.detectedVia === 'mci', svc.detectedVia);
    check('就绪阶段未强占 MCI（RAW 懒加载，engine 仍空）', svc.engine === null, svc.engine);
    check('RAW 能力测试已执行', rawReadLbas.length >= 1, rawReadLbas);
    check('试读 LBA 用 MCI TOC 的 0 基帧', rawReadLbas[0] && rawReadLbas[0].lba === 0, rawReadLbas[0]);
    await svc.playTrack(1, 0);
    check('起播后 engine=raw', svc.engine === 'raw', svc.engine);
    const ev = last('cd:engine');
    check('上报 cd:engine=raw', ev && ev.engine === 'raw', ev);
    check('RAW 音量可软件控制', ev && ev.volumeSupported === true, ev);
    check('播放状态 playing', svc.playState === 'playing', svc.playState);
    await svc.stopPlayback();
  }

  console.log('# 2. RAW TOC + RAW 可用 → 起播走 RAW');
  cfg.rawTocOk = true; cfg.mciOk = true; cfg.rawReadOk = true;
  rawReadLbas.length = 0;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    check('detectedVia=raw', svc.detectedVia === 'raw', svc.detectedVia);
    await svc.playTrack(2, 0);
    check('engine=raw', svc.engine === 'raw', svc.engine);
    check('能力试读 LBA 用绝对帧-150（首轨 150 → 0）', rawReadLbas[0] && rawReadLbas[0].lba === 0, rawReadLbas[0]);
    await svc.stopPlayback();
  }

  console.log('# 3. RAW 不可用 → 就绪即回退 MCI（保留的回退路径）');
  cfg.rawTocOk = true; cfg.mciOk = true; cfg.rawReadOk = false;
  rawReadLbas.length = 0;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    check('engine=mci（RAW 失败回退）', svc.engine === 'mci', svc.engine);
    const ev = last('cd:engine');
    check('上报 cd:engine=mci', ev && ev.engine === 'mci', ev);
    check('MCI 音量走系统', ev && ev.volumeSupported === false, ev);
    await svc.playTrack(1, 0);
    check('MCI 引擎播放', svc.engine === 'mci' && svc.playState === 'playing', svc.playState);
    await svc.stopPlayback();
  }

  console.log('# 4. MCI 兜底 TOC + RAW 也不可用 → MCI（双兜底）');
  cfg.rawTocOk = false; cfg.mciOk = true; cfg.rawReadOk = false;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    check('engine=mci', svc.engine === 'mci', svc.engine);
    check('detectedVia=mci', svc.detectedVia === 'mci', svc.detectedVia);
  }

  console.log('# 5. 签名约定无关：同一张碟 RAW TOC 与 MCI TOC 签名一致');
  {
    const svc = makeSvc();
    const rawSig = svc._signature(RAW_TOC);
    const mciSig = svc._signature(MCI_TOC);
    check('两种约定签名相同（不误判换碟）', rawSig === mciSig, { rawSig, mciSig });
    const shifted = JSON.parse(JSON.stringify(RAW_TOC));
    shifted.tracks[1].startFrame += 75;   // 轨2 位置不同 → 另一张碟
    check('不同碟签名不同', svc._signature(shifted) !== rawSig);
  }

  console.log('# 6. RAW 能力测试跳过数据轨（CD-Extra 混合盘）');
  {
    const svc = makeSvc();
    svc.drive = 'D';
    svc.toc = {
      first: 1, last: 2, leadout: 74000,
      tracks: [
        { number: 1, startFrame: 150, endFrame: 22000, durationSec: 291.3, audio: false },
        { number: 2, startFrame: 22000, endFrame: 74000, durationSec: 693.3, audio: true }
      ]
    };
    rawReadLbas.length = 0;
    cfg.rawReadOk = true;
    const ok = await svc._testRawRead();
    check('能力测试成功', ok === true);
    check('试读第一个音频轨（跳过数据轨）',
      rawReadLbas.length === 1 && rawReadLbas[0].lba === 22000 - 150, rawReadLbas);
  }

  console.log('# 7. 虚拟光驱（MCI 识别 + RAW 可用）出舱：IOCTL 失败后经 MCI 复核，不误判');
  cfg.rawTocOk = false; cfg.mciOk = true; cfg.rawReadOk = true;
  {
    const svc = makeSvc();
    await runCeremony(svc);       // detectedVia=mci, RAW 可用但懒加载 → engine=null, player=null
    await svc.playTrack(1, 0);    // 起播后 engine=raw, player=FakeRawPlayer
    await svc.stopPlayback();
    sent.length = 0;
    // 模拟：物理 IOCTL 出舱"成功"但盘仍在（虚拟光驱常见行为）
    const ok = await svc.eject();
    check('未误判为已弹出（phase 回 ready）', svc.phase === 'ready', svc.phase);
    check('给出虚拟光驱指引', /虚拟光驱/.test((last('cd:notice') || {}).text || ''), last('cd:notice'));
    check('保留碟片状态（signature 未清）', !!svc.signature, svc.signature);
    check('自动恢复播放（engine 重建为 raw）', svc.engine === 'raw' && svc.playState === 'playing', svc.engine);
    await svc.stopPlayback();
  }

  console.log('# 8. ★ 静音前奏：轨首几秒全零但后面有真音频 → 跳过静音判可用（用户实测碟的坑）');
  cfg.rawTocOk = true; cfg.mciOk = true; cfg.rawReadOk = true;
  cfg.zeroUntilLba = 75 * 3; // 前 3 秒静音（用户那张是前 2 帧）
  rawReadLbas.length = 0;
  {
    const logLines = [];
    const svc = new CdService({
      userData: tmp, autoPlay: false, demo: false,
      log: (m) => logLines.push(m), send: (ch, p) => sent.push({ ch, p })
    });
    svc.drive = 'D';
    svc.toc = JSON.parse(JSON.stringify(RAW_TOC));
    const ok = await svc._testRawRead();
    check('能力测试成功（静音前奏未被误判成不支持）', ok === true);
    check('连试 4 个窗口（前 3 个静音，第 4 个有数据）',
      rawReadLbas.length === 4, rawReadLbas.map((r) => r.lba));
    check('首个非零窗口落在 LBA 225（跳过 225 帧）',
      rawReadLbas[3] && rawReadLbas[3].lba === 225, rawReadLbas[3]);
    check('每窗口 75 扇区（与播放块同大小）',
      rawReadLbas.every((r) => r.count === 75), rawReadLbas);
    check('日志记明跳过静音前奏',
      logLines.some((m) => /跳过 225 帧静音前奏/.test(m)), logLines);
    cfg.zeroUntilLba = 0;
  }

  console.log('# 9. 全程全零（真·无数字音频提取能力）→ 试满 8 窗口才判不可用');
  cfg.rawReadOk = true; // 不抛错，但永远全零（虚拟光驱 / 假成功型光驱）
  cfg.zeroUntilLba = Infinity;
  rawReadLbas.length = 0;
  {
    const svc = makeSvc();
    svc.drive = 'D';
    svc.toc = JSON.parse(JSON.stringify(RAW_TOC));
    const ok = await svc._testRawRead();
    check('能力测试失败（与看门狗 8 秒口径对齐）', ok === false);
    check('试满 8 个窗口才放弃', rawReadLbas.length === 8, rawReadLbas.length);
    cfg.zeroUntilLba = 0;
  }

  console.log('# 9b. ★ 垃圾数据（白噪音形态）：非零但两种字节序都不像音频波形 → 判不可用回退 MCI');
  cfg.rawReadOk = true;
  cfg.garbage = true; cfg.garbageUntilLba = Infinity;
  rawReadLbas.length = 0;
  {
    const logLines = [];
    const svc = new CdService({
      userData: tmp, autoPlay: false, demo: false,
      log: (m) => logLines.push(m), send: (ch, p) => sent.push({ ch, p })
    });
    svc.drive = 'D';
    svc.toc = JSON.parse(JSON.stringify(RAW_TOC));
    const ok = await svc._testRawRead();
    check('能力测试失败（波形判据抓住"非零垃圾"）', ok === false);
    check('8 个窗口全部试过（每个都非零但都不像音频波形）', rawReadLbas.length === 8, rawReadLbas.length);
    check('日志点明"非零但两种字节序都不像音频波形"',
      logLines.some((m) => /非零但两种字节序都不像音频波形/.test(m)), logLines);
    cfg.garbage = false;
  }

  console.log('# 9c. 垃圾前缀后转真音频：跳过垃圾窗口 → 判可用');
  cfg.garbage = true; cfg.garbageUntilLba = 75 * 3;   // 前 3 秒垃圾，之后真音频
  rawReadLbas.length = 0;
  {
    const logLines = [];
    const svc = new CdService({
      userData: tmp, autoPlay: false, demo: false,
      log: (m) => logLines.push(m), send: (ch, p) => sent.push({ ch, p })
    });
    svc.drive = 'D';
    svc.toc = JSON.parse(JSON.stringify(RAW_TOC));
    const ok = await svc._testRawRead();
    check('能力测试成功（跳过垃圾窗口找到合法 CD-DA）', ok === true);
    check('连试 4 个窗口（前 3 个垃圾，第 4 个合法）', rawReadLbas.length === 4, rawReadLbas.map((r) => r.lba));
    check('命中窗口 LBA=225', rawReadLbas[3] && rawReadLbas[3].lba === 225, rawReadLbas[3]);
    check('成功日志带 sync=75/75',
      logLines.some((m) => /sync=75\/75/.test(m)), logLines);
    cfg.garbage = false; cfg.garbageUntilLba = Infinity;
  }

  console.log('# 9d. ★ 小端 16bit PCM 数据（v10.2，用户 F 盘实体光驱实测）：无 sync 头但波形平滑 → 判可用');
  cfg.le16 = true;
  rawReadLbas.length = 0;
  {
    const logLines = [];
    const svc = new CdService({
      userData: tmp, autoPlay: false, demo: false,
      log: (m) => logLines.push(m), send: (ch, p) => sent.push({ ch, p })
    });
    svc.drive = 'D';
    svc.toc = JSON.parse(JSON.stringify(RAW_TOC));
    const ok = await svc._testRawRead();
    check('能力测试成功（波形判据放行 le16 数据）', ok === true);
    check('只试 1 个窗口（首个窗口即命中）', rawReadLbas.length === 1, rawReadLbas.map((r) => r.lba));
    check('成功日志带"小端 16bit PCM"',
      logLines.some((m) => /小端 16bit PCM/.test(m)), logLines);
    check('成功日志带直通解码说明',
      logLines.some((m) => /已启用直通解码/.test(m)), logLines);
    cfg.le16 = false;
  }

  console.log('# 9e. 静音前缀后转小端 PCM：先跳过静音窗口，命中 le16 即止（不贪多）');
  cfg.le16 = true;
  cfg.zeroUntilLba = 75;      // 第 1 窗口全零，第 2 窗口起 le16
  rawReadLbas.length = 0;
  {
    const logLines = [];
    const svc = new CdService({
      userData: tmp, autoPlay: false, demo: false,
      log: (m) => logLines.push(m), send: (ch, p) => sent.push({ ch, p })
    });
    svc.drive = 'D';
    svc.toc = JSON.parse(JSON.stringify(RAW_TOC));
    const ok = await svc._testRawRead();
    check('能力测试成功（跳过静音窗口后命中 le16）', ok === true);
    check('命中窗口 LBA=75（第 2 个窗口）', rawReadLbas[1] && rawReadLbas[1].lba === 75, rawReadLbas.map((r) => r.lba));
    check('日志带静音前奏跳过说明', /跳过 75 帧静音前奏/.test(logLines.join('\n')), logLines);
    cfg.zeroUntilLba = 0;
  }

  console.log('# 10. 引擎偏好 MCI：RAW 明明可用也跳过（白噪音逃生门）');
  cfg.rawTocOk = true; cfg.mciOk = true; cfg.rawReadOk = true;
  rawReadLbas.length = 0;
  {
    const svc = makeSvc('mci');
    await runCeremony(svc);
    check('engine=mci（偏好指定，未走 RAW）', svc.engine === 'mci', svc.engine);
    check('rawCapable=false（偏好写死）', svc.rawCapable === false, svc.rawCapable);
    check('一次 RAW 试读都没发生', rawReadLbas.length === 0, rawReadLbas);
    await svc.playTrack(1, 0);
    check('起播仍为 MCI', svc.engine === 'mci' && svc.playState === 'playing', svc.engine);
    await svc.stopPlayback();
  }

  console.log('# 11. 引擎偏好 RAW：跳过能力测试，起播强制 RAW');
  cfg.rawReadOk = true;
  rawReadLbas.length = 0;
  {
    const svc = makeSvc('raw');
    await runCeremony(svc);
    check('rawCapable=true（偏好写死）', svc.rawCapable === true, svc.rawCapable);
    check('能力测试被跳过（零试读）', rawReadLbas.length === 0, rawReadLbas);
    check('就绪阶段仍是懒加载（engine 空）', svc.engine === null, svc.engine);
    await svc.playTrack(1, 0);
    check('起播 engine=raw', svc.engine === 'raw', svc.engine);
    await svc.stopPlayback();
  }

  console.log('# 12. switchEngine：RAW → MCI → RAW 原位续播（设置页运行时切换）');
  cfg.rawTocOk = true; cfg.mciOk = true; cfg.rawReadOk = true;
  rawReadLbas.length = 0;
  {
    const svc = makeSvc();
    await runCeremony(svc);
    await svc.playTrack(2, 30);
    check('初始 engine=raw', svc.engine === 'raw', svc.engine);
    const rawPlayer = svc.player;
    const r1 = await svc.switchEngine('mci');
    check('切 MCI 成功', r1.ok === true && r1.engine === 'mci', r1);
    check('播放器已换成 MCI', svc.player instanceof FakeMciPlayer, svc.player && svc.player.constructor.name);
    check('旧 RAW 播放器已关闭', rawPlayer.state === 'stopped' || rawPlayer.state === 'closed', rawPlayer.state);
    check('仍在播放（原位续播）', svc.playState === 'playing', svc.playState);
    check('续播曲目/位置保持', svc.currentTrack === 2, svc.currentTrack);
    const mciPlayer = svc.player;
    const r2 = await svc.switchEngine('raw');
    check('切回 RAW 成功', r2.ok === true && r2.engine === 'raw', r2);
    check('播放器已换回 RAW', svc.player instanceof FakeRawPlayer, svc.player && svc.player.constructor.name);
    check('仍在播放', svc.playState === 'playing', svc.playState);
    check('MCI 播放器已关闭', mciPlayer.state === 'stopped' || mciPlayer.state === 'closed', mciPlayer.state);
    check('切 RAW 前跑了能力测试', rawReadLbas.length >= 1, rawReadLbas.length);
    await svc.stopPlayback();
  }

  console.log('# 13. switchEngine 失败与边界');
  {
    const svc = makeSvc();
    await runCeremony(svc);
    check('非法引擎名拒绝', (await svc.switchEngine('auto')).error === 'bad-engine');
    svc.engine = 'demo';
    check('演示模式拒绝切换', (await svc.switchEngine('mci')).error === 'demo-mode');
    svc.engine = null;
    const svc2 = makeSvc();
    check('无碟拒绝切换', (await svc2.switchEngine('mci')).error === 'no-disc');
    cfg.mciOk = false;
    const svc3 = makeSvc();
    await runCeremony(svc3);
    check('MCI 起播失败 → start-failed', (await svc3.switchEngine('mci')).error === 'start-failed');
    cfg.mciOk = true;
  }

  console.log('# 14. 引擎偏好活引用：运行时改设置即时生效');
  {
    const settings = { enginePreference: 'auto' };
    const svc = new CdService({
      userData: tmp, autoPlay: false, demo: false, settings,
      log: () => {}, send: (ch, p) => sent.push({ ch, p })
    });
    check('默认 auto', svc._enginePreference() === 'auto', svc._enginePreference());
    settings.enginePreference = 'mci';
    check('改设置后读到 mci（活引用）', svc._enginePreference() === 'mci');
    settings.enginePreference = 'garbage';
    check('非法值归一为 auto', svc._enginePreference() === 'auto');
    settings.enginePreference = 'raw';
    check('raw 生效', svc._enginePreference() === 'raw');
  }

  await sleep(50);
  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
