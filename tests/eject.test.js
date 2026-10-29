'use strict';
/* 光盘弹出检测自检：外部弹出 → 主动停播 + 回退读盘界面；软件内出舱不受开关影响 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..', 'main');

let discPresent = true;
let tocCalls = 0;

const fakeNative = {
  listCdDrives: () => ['D'],
  openCdDevice: () => 1,
  closeDevice: () => {},
  readToc: () => {
    tocCalls++;
    if (!discPresent) throw new Error('no medium');
    return {
      first: 1, last: 3, leadout: 74000,
      tracks: [
        { number: 1, startFrame: 150, endFrame: 22000, durationSec: 291.3, audio: true },
        { number: 2, startFrame: 22000, endFrame: 48000, durationSec: 346.7, audio: true },
        { number: 3, startFrame: 48000, endFrame: 74000, durationSec: 346.7, audio: true }
      ]
    };
  },
  readTocViaMci: () => { throw new Error('no mci'); },
  rawRead: () => Buffer.alloc(4704),
  trayControl: () => {},
  mciSend: () => ({ code: 0, text: '00:00:00' }),
  mciError: () => 'fake',
  IOCTL_CDROM_EJECT_MEDIA: 1, IOCTL_CDROM_LOAD_MEDIA: 2, IOCTL_CDROM_CLOSE_DOOR: 3
};
const nativeId = require.resolve(path.join(ROOT, 'native.js'));
require.cache[nativeId] = new Module(nativeId, null);
Object.assign(require.cache[nativeId], { filename: nativeId, loaded: true, exports: fakeNative });

/* 假 RAW 播放器：health 与 mediaCheck 分别可控
   - health=false      → 模拟"读取连续失败"
   - mediaCheck=false  → 模拟"读取一路成功（返回全零），但设备明确报告没有介质" */
let health = true;
let mediaCheck = true;
class FakeRawPlayer {
  constructor(o) { this.opts = o; this.state = 'stopped'; this.trackNumber = 0; this.sec = 0; this._pausedSec = null; }
  async start() {}
  async playTrack(n, fromSec) { this.trackNumber = n; this.sec = fromSec || 0; this.state = 'playing'; }
  pause() { if (this.state === 'playing') { this._pausedSec = this.sec; this.state = 'paused'; } }
  resume() { if (this.state === 'paused') { this.sec = this._pausedSec || 0; this.state = 'playing'; } }
  async stop() { this.state = 'stopped'; this.sec = 0; }
  async close() {}
  seekToSeconds(sec) { this.sec = sec; }
  getPositionFrame() { return 0; }
  setAudibleSec(sec) { this.sec = sec; if (this.state === 'paused') this._pausedSec = sec; }
  audibleSec() { return this.sec; }
  mediaHealthy() { return health; }
  async probeMedia() { return mediaCheck; }
}
const rawId = require.resolve(path.join(ROOT, 'cd/raw-player.js'));
require.cache[rawId] = new Module(rawId, null);
Object.assign(require.cache[rawId], {
  filename: rawId, loaded: true,
  exports: { RawPlayer: FakeRawPlayer, CHUNK_SECTORS: 75, CHUNK_SECONDS: 0.5 }
});

const { CdService } = require(path.join(ROOT, 'cd/cd-service.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcd-eject-'));
const sent = [];
const svc = new CdService({
  userData: tmp, autoPlay: false, demo: false, ejectReturnToScene: true,
  log: () => {}, send: (ch, p) => sent.push({ ch, p })
});

function last(ch) {
  for (let i = sent.length - 1; i >= 0; i--) if (sent[i].ch === ch) return sent[i].p;
  return null;
}
function clear() { sent.length = 0; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

async function mount() {
  health = true;
  mediaCheck = true;
  discPresent = true;                 // 必须在读 TOC 之前置位
  svc.drive = 'D';
  svc.signature = 'sig1';
  svc.toc = fakeNative.readToc();
  svc.phase = 'ready';
  await svc.playTrack(2, 0);
  clear();
}

(async () => {
  console.log('# 1. 播放期间探测不再做全量 TOC 扫描（否则同步 IOCTL 会阻塞主线程）');
  await mount();
  tocCalls = 0;
  await svc._probe();
  check('播放中未调用 readToc', tocCalls === 0, tocCalls);
  check('播放状态未受影响', svc.playState === 'playing', svc.playState);

  console.log('# 2. 物理弹出光盘 → 读取停滞 → 主动停播并回到读盘界面');
  health = false;                 // 模拟抽出光盘后读取线程连续失败
  discPresent = false;
  clear();
  await svc._probe();
  check('已停止播放', svc.playState === 'stopped', svc.playState);
  check('phase=idle', svc.phase === 'idle', svc.phase);
  const ph = last('cd:phase');
  check('发出 cd:phase/idle', ph && ph.phase === 'idle', ph);
  check('标记为外部弹出（external=true）', ph && ph.external === true, ph);
  check('默认回退读盘界面（returnToScene=true）', ph && ph.returnToScene === true, ph);
  check('不再持有该碟（signature 已清）', svc.signature === null, svc.signature);
  check('提示用户已停止播放', /弹出/.test((last('cd:notice') || {}).text || ''), last('cd:notice'));

  console.log('# 3. 关掉开关后：仍然停播，但不强制回退读盘界面');
  await mount();
  svc.ejectReturnToScene = false;
  health = false;
  discPresent = false;
  clear();
  await svc._probe();
  check('仍然停止播放', svc.playState === 'stopped', svc.playState);
  check('returnToScene=false', last('cd:phase').returnToScene === false, last('cd:phase'));
  svc.ejectReturnToScene = true;

  console.log('# 4. 盘还在但读取受阻 → 只提示，不误判为弹出');
  await mount();
  health = false;
  discPresent = true;
  clear();
  await svc._probe();
  check('phase 仍为 ready（没被误判成光盘没了）', svc.phase === 'ready', svc.phase);
  check('signature 保留', svc.signature === 'sig1', svc.signature);
  check('给出读取受阻提示', /读取受阻/.test((last('cd:notice') || {}).text || ''), last('cd:notice'));

  console.log('# 4b. 光驱"无盘也照样读取成功" → 靠主动探测识别弹出');
  await mount();
  health = true;                  // 读取线程一路"成功"（部分光驱无介质时返回全零数据）
  mediaCheck = false;             // 但设备明确报告：没有介质
  discPresent = false;
  clear();
  await svc._probe();
  check('已停止播放（不再闷头继续播）', svc.playState === 'stopped', svc.playState);
  check('phase=idle', svc.phase === 'idle', svc.phase);
  check('识别为外部弹出', last('cd:phase') && last('cd:phase').external === true, last('cd:phase'));
  check('signature 已清', svc.signature === null, svc.signature);

  console.log('# 4c. 主动探测报"不在"但 TOC 复核仍在 → 不误判（驱动瞬时抖动）');
  await mount();
  health = true;
  mediaCheck = false;
  discPresent = true;             // 复核能读到 TOC
  clear();
  await svc._probe();
  check('phase 仍为 ready', svc.phase === 'ready', svc.phase);
  check('仍在播放', svc.playState === 'playing', svc.playState);

  console.log('# 4d. 设备不支持探测指令 → 不能判定为弹出');
  await mount();
  mediaCheck = null;              // 无法判定
  clear();
  await svc._probe();
  check('phase 仍为 ready', svc.phase === 'ready', svc.phase);
  check('仍在播放', svc.playState === 'playing', svc.playState);

  console.log('# 5. 软件内主动出舱：external=false，且不受开关影响');
  await mount();
  svc.ejectReturnToScene = false;    // 即使开关关闭，主动出舱也必须回退
  clear();
  await svc._handleDiscRemoved('ejected');
  const ph2 = last('cd:phase');
  check('external=false', ph2 && ph2.external === false, ph2);
  check('returnToScene=true（不受开关影响）', ph2 && ph2.returnToScene === true, ph2);
  check('reason=ejected', ph2 && ph2.reason === 'ejected', ph2);
  svc.ejectReturnToScene = true;

  console.log('# 6. 移除只处理一次（探测循环与看门狗可能同时判定）');
  await mount();
  health = false;
  discPresent = false;
  clear();
  await Promise.all([svc._probe(), svc._handleDiscRemoved('removed')]);
  const phases = sent.filter((s) => s.ch === 'cd:phase').length;
  check('只广播一次 cd:phase', phases === 1, phases);

  await svc.closePlayer();
  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})();
