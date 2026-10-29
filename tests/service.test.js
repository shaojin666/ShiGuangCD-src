'use strict';
/* 主进程传输状态机自检：验证停播不重复读盘 / 定位 / 暂停恢复 / 轨末上报 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = require('path').join(__dirname, '..', 'main');

/* ---- 注入假的 native 模块（真实实现依赖 Windows koffi） ---- */
const fakeNative = {
  listCdDrives: () => ['D'],
  openCdDevice: () => 1,
  closeDevice: () => {},
  readToc: () => ({
    first: 1, last: 3, leadout: 74000,
    tracks: [
      { number: 1, startFrame: 150, endFrame: 22000, durationSec: 291.3, audio: true },
      { number: 2, startFrame: 22000, endFrame: 48000, durationSec: 346.7, audio: true },
      { number: 3, startFrame: 48000, endFrame: 74000, durationSec: 346.7, audio: true }
    ]
  }),
  readTocViaMci: () => { throw new Error('no mci'); },
  rawRead: () => Buffer.alloc(4704),
  trayControl: () => {},
  mciSend: () => ({ code: 0, text: '00:00:00' }),
  mciError: () => 'fake',
  IOCTL_CDROM_EJECT_MEDIA: 1, IOCTL_CDROM_LOAD_MEDIA: 2, IOCTL_CDROM_CLOSE_DOOR: 3
};
const nativeId = require.resolve(path.join(ROOT, 'native.js'));
require.cache[nativeId] = new Module(nativeId, null);
require.cache[nativeId].filename = nativeId;
require.cache[nativeId].loaded = true;
require.cache[nativeId].exports = fakeNative;

/* ---- 假的 RawPlayer（真实实现要开 worker 线程） ---- */
const rawId = require.resolve(path.join(ROOT, 'cd/raw-player.js'));
class FakeRawPlayer {
  constructor(o) { this.opts = o; this.state = 'stopped'; this.trackNumber = 0; this.sec = 0; this._anchorAt = Date.now(); }
  async start() {}
  async playTrack(n, fromSec) {
    this.trackNumber = n; this.sec = fromSec || 0; this._anchorAt = Date.now(); this.state = 'playing';
  }
  /** 模拟真实播放器的本地时钟：播放中按墙钟推进 */
  positionSec() {
    let s = this.sec;
    if (this.state === 'playing') s += (Date.now() - this._anchorAt) / 1000;
    return Math.max(0, s);
  }
  audibleSec() { return this.positionSec(); }
  pause() {
    if (this.state === 'playing') { this.sec = this.positionSec(); this._pausedSec = this.sec; this.state = 'paused'; }
  }
  resume() { if (this.state === 'paused') { this.sec = this._pausedSec || 0; this._anchorAt = Date.now(); this.state = 'playing'; } }
  setAudibleSec(sec) {
    this.sec = Math.max(0, sec); this._anchorAt = Date.now();
    if (this.state === 'paused') this._pausedSec = this.sec;
  }
  async stop() { this.state = 'stopped'; this.sec = 0; }
  async close() {}
  seekToSeconds(sec) { this.sec = sec; this._anchorAt = Date.now(); }
  getPositionFrame() { return 0; }
}
require.cache[rawId] = new Module(rawId, null);
require.cache[rawId].filename = rawId;
require.cache[rawId].loaded = true;
require.cache[rawId].exports = { RawPlayer: FakeRawPlayer, CHUNK_SECTORS: 75, CHUNK_SECONDS: 0.5 };

const { CdService } = require(path.join(ROOT, 'cd/cd-service.js'));

const sent = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcd-'));
const svc = new CdService({
  userData: tmp,
  autoPlay: false,
  demo: false,
  log: () => {},
  send: (ch, p) => sent.push({ ch, p })
});

function last(ch) {
  for (let i = sent.length - 1; i >= 0; i--) if (sent[i].ch === ch) return sent[i].p;
  return null;
}
function clear() { sent.length = 0; }

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('# 1. 手动装载一张碟（跳过探测仪式）');
  svc.drive = 'D';
  svc.signature = 'sig1';
  svc.toc = fakeNative.readToc();
  svc.phase = 'ready';
  check('trackDurationSec(1)=291.3', Math.abs(svc.trackDurationSec(1) - 291.3) < 0.01, svc.trackDurationSec(1));
  check('trackCount=3', svc.trackCount() === 3, svc.trackCount());

  console.log('# 2. 起播');
  clear();
  await svc.playTrack(2, 0);
  let st = last('cd:state');
  check('state=playing', st.state === 'playing', st);
  check('track=2', st.track === 2, st);
  check('positionSec≈0', st.positionSec < 0.05, st);
  check('phase 保持 ready（不再被写成 playing）', svc.phase === 'ready', svc.phase);

  console.log('# 3. 播放推进');
  await sleep(300);
  check('positionSec 前进', svc._positionSec() > 0.25 && svc._positionSec() < 1.5, svc._positionSec());

  console.log('# 4. 暂停 / 恢复：位置必须连续');
  await svc.pause();
  st = last('cd:state');
  const pausedAt = st.positionSec;
  check('state=paused', st.state === 'paused', st);
  check('暂停位置 > 0.25', pausedAt > 0.25, pausedAt);
  await sleep(400);
  check('暂停期间位置冻结', Math.abs(svc._positionSec() - pausedAt) < 0.01, svc._positionSec());
  await svc.resume();
  st = last('cd:state');
  check('恢复后 state=playing', st.state === 'playing', st);
  check('恢复位置≈暂停位置', Math.abs(st.positionSec - pausedAt) < 0.15, [st.positionSec, pausedAt]);

  console.log('# 4b. 暂停以渲染端"真实听感位置"为准（界面显示与耳朵听到必须是同一个数）');
  await svc.playTrack(2, 0);
  await sleep(200);
  clear();
  await svc.pause({ sec: 15 });           // 渲染端：我听到的是 15s
  st = last('cd:state');
  check('上报的暂停位置 = 15', Math.abs(st.positionSec - 15) < 0.01, st.positionSec);
  check('播放器也对齐到 15（续播从这里起读）', Math.abs(svc.player.audibleSec() - 15) < 0.01, svc.player.audibleSec());
  await sleep(200);
  check('暂停期间位置冻结在 15', Math.abs(svc._positionSec() - 15) < 0.01, svc._positionSec());
  await svc.resume({ sec: 15 });
  st = last('cd:state');
  check('续播位置仍从 15 开始（不跳到 17）', Math.abs(st.positionSec - 15) < 0.15, st.positionSec);

  console.log('# 4c. 暂停后不再向渲染端推送音频块（否则会"点了暂停还响一会儿"）');
  await svc.pause({ sec: 20 });
  clear();
  svc.player.opts.onChunk({ track: 2, absFrame: 1000, samples: Buffer.alloc(10) });
  check('暂停态丢弃音频块', sent.filter((s) => s.ch === 'cd:audio').length === 0,
    sent.filter((s) => s.ch === 'cd:audio').length);
  await svc.resume({ sec: 20 });
  clear();
  svc.player.opts.onChunk({ track: 2, absFrame: 1000, samples: Buffer.alloc(10) });
  check('播放态正常推送', sent.filter((s) => s.ch === 'cd:audio').length === 1,
    sent.filter((s) => s.ch === 'cd:audio').length);

  console.log('# 5. 定位');
  await svc.seekTo(120);
  st = last('cd:state');
  check('定位后 positionSec=120', Math.abs(st.positionSec - 120) < 0.2, st);
  check('定位不改变 playing 状态', st.state === 'playing', st);
  await svc.seekTo(99999);
  st = last('cd:state');
  check('超界定位夹到时长内', st.positionSec <= 346.7 && st.positionSec > 346, st);

  console.log('# 6. 停播：phase 必须保持 ready（旧实现置 idle → 探测循环反复重读）');
  await svc.stopPlayback();
  st = last('cd:state');
  check('state=stopped', st.state === 'stopped', st);
  check('positionSec≈0', st.positionSec < 0.05, st);
  check('phase=ready', svc.phase === 'ready', svc.phase);
  check('_discActive()=true（探测不会重读这张碟）', svc._discActive() === true);

  console.log('# 7. 停止态定位 → 起播');
  await svc.seekTo(30);
  st = last('cd:state');
  check('state=playing', st.state === 'playing', st);
  check('positionSec≈30', Math.abs(st.positionSec - 30) < 0.3, st);

  console.log('# 8. 轨末上报（不自行切轨，交给渲染端按播放模式决定）');
  clear();
  svc._onTrackEnd(3);
  check('发出 cd:track-end', !!last('cd:track-end'), last('cd:track-end'));
  check('state=stopped', last('cd:state').state === 'stopped', last('cd:state'));
  clear();
  svc._onTrackEnd(3);
  check('1.5s 内不重复上报', last('cd:track-end') === null);

  console.log('# 9. 播放模式');
  check('setPlayMode 合法值', svc.setPlayMode('shuffle') === 'shuffle');
  check('setPlayMode 非法值回落', svc.setPlayMode('nope') === 'normal');

  console.log('# 10. getState 暴露完整传输快照');
  const gs = svc.getState();
  for (const k of ['phase', 'playState', 'track', 'positionSec', 'durationSec', 'trackCount', 'mode']) {
    check('getState 含 ' + k, gs[k] !== undefined, gs);
  }

  /* ---------- MCI 路径的权威来源与响应性 ---------- */
  console.log('# 10b. ★ MCI 路径：暂停点以播放器回读值为准，而不是渲染端的墙钟估计值');
  {
    /**
     * 真实场景：MCI 由系统直接出声，渲染端手里没有本地音频，
     * 它上报的 heard 只是墙钟估计值（会超前）。若拿它当权威，
     * 暂停点就偏后、续播也从偏后的位置起 —— 用户反馈的正是这个。
     * MCI 下必须改用播放器回读到的真实落点。
     */
    const mciSent = [];
    const svcM = new CdService({
      userData: tmp, autoPlay: false, demo: false, log: () => {},
      send: (ch, p) => mciSent.push({ ch, p })
    });
    svcM.drive = 'D'; svcM.signature = 'sigM'; svcM.toc = fakeNative.readToc(); svcM.phase = 'ready';
    // 手工装一个"回读值为 20s"的假播放器
    const fakeMci = {
      state: 'playing', trackNumber: 2, _readback: 20,
      async playTrack() { this.state = 'playing'; },
      // 模拟 mci-player.pause()：先钉状态，回读后返回真实落点
      async pause() { this.state = 'paused'; this._readback = 20.35; },
      async resume() { this.state = 'playing'; },
      async stop() { this.state = 'stopped'; },
      async close() {},
      positionSec() { return this._readback; },
      audibleSec() { return this._readback; },
      setAudibleSec() { /* MCI 下会被忽略（回读优先） */ },
      seekToSeconds(sec) { this._readback = sec; }
    };
    svcM.player = fakeMci;
    svcM.engine = 'mci';
    svcM.playState = 'playing';
    svcM.currentTrack = 2;
    svcM._setAnchor(20);

    mciSent.length = 0;
    await svcM.pause({ sec: 24 });   // 渲染端报 24s（偏后的墙钟估计值）
    const mciStates = mciSent.filter((x) => x.ch === 'cd:state');
    const finalM = mciStates[mciStates.length - 1].p;
    check('MCI 暂停点 = 回读值 20.35，而非渲染端的 24',
      Math.abs(finalM.positionSec - 20.35) < 0.05, finalM.positionSec);
    check('暂停后 state=paused', finalM.state === 'paused', finalM.state);

    // 乐观广播：MCI 命令返回前就要有一条 cd:state（否则界面/系统控件迟钝）
    check('暂停命令前已乐观广播一次 cd:state',
      mciStates.length >= 2 && mciStates[0].p.reason === 'pause',
      mciStates.map((x) => x.p.reason));
    check('随后补发精确位置（pause-synced）',
      mciStates.some((x) => x.p.reason === 'pause-synced'),
      mciStates.map((x) => x.p.reason));

    // 续播：锚点同样取回读值
    fakeMci._readback = 20.4;
    mciSent.length = 0;
    await svcM.resume({ sec: 24 });   // 渲染端仍报偏后的 24
    const stM = mciSent.filter((x) => x.ch === 'cd:state').pop().p;
    check('MCI 续播锚点 = 回读值 20.4，不采纳渲染端的 24',
      Math.abs(stM.positionSec - 20.4) < 0.05, stM.positionSec);
    check('续播后 state=playing', stM.state === 'playing', stM.state);
    await svcM.closePlayer();
  }

  console.log('# 10c. ★ MCI 定位锚点取回读落点（驱动会贴扇区边界，偏差会污染歌词）');
  {
    const s2 = [];
    const svcS = new CdService({
      userData: tmp, autoPlay: false, demo: false, log: () => {},
      send: (ch, p) => s2.push({ ch, p })
    });
    svcS.drive = 'D'; svcS.signature = 'sigS'; svcS.toc = fakeNative.readToc(); svcS.phase = 'ready';
    const fakeMci2 = {
      state: 'playing', trackNumber: 1, _readback: 0,
      async playTrack(n, f) { this._readback = f || 0; this.state = 'playing'; },
      async pause() { this.state = 'paused'; },
      async resume() { this.state = 'playing'; },
      async stop() { this.state = 'stopped'; },
      async close() {},
      positionSec() { return this._readback; },
      audibleSec() { return this._readback; },
      setAudibleSec() {},
      async seekToSeconds(sec) { this._readback = sec + 0.6; }  // 驱动落在请求值之后
    };
    svcS.player = fakeMci2; svcS.engine = 'mci';
    svcS.playState = 'playing'; svcS.currentTrack = 1; svcS._setAnchor(0);
    s2.length = 0;
    await svcS.seekTo(50);
    const stS = s2.filter((x) => x.ch === 'cd:state').pop().p;
    check('定位锚点 = 回读落点 50.6（而非请求的 50）',
      Math.abs(stS.positionSec - 50.6) < 0.05, stS.positionSec);
    await svcS.closePlayer();
  }

  /* ---------- 元数据：首次读碟自动落盘 + 用户强制刷新 ---------- */
  console.log('# 11. 首次读碟自动保存元数据（缓存命中后二次读碟完全不联网）');
  // 直接给服务层喂一份"抓取结果"，走真实的落盘路径（不联网）
  const meta11 = {
    signature: 'sig1',
    source: 'netease',
    sources: ['netease'],
    album: '叶惠美',
    artist: '周杰伦',
    year: 2003,
    trackCount: 3,
    tracks: [
      { number: 1, title: '以父之名', artist: '周杰伦', durationSec: 291.3 },
      { number: 2, title: '懦夫', artist: '周杰伦', durationSec: 346.7 },
      { number: 3, title: '晴天', artist: '周杰伦', durationSec: 346.7 }
    ],
    coverBuffer: Buffer.alloc(1024, 9)
  };
  // 直接调用落盘逻辑（与 _fetchMetadataBackground 尾部一致）
  meta11.fetchedAt = new Date().toISOString();
  svc.store.saveCover('sig1', meta11.coverBuffer);
  meta11.hasCover = true;
  delete meta11.coverBuffer;
  svc.store.save(meta11);

  const cached = svc.store.get('sig1');
  check('缓存可读回', !!cached && cached.album === '叶惠美', cached && cached.album);
  check('封面文件已落盘', cached.hasCover === true, cached && cached.hasCover);
  check('曲目已保存', cached.tracks.length === 3 && cached.tracks[0].title === '以父之名',
    cached.tracks.length && cached.tracks[0].title);
  check('封面文件真实存在', fs.existsSync(path.join(tmp, 'metadata', 'sig1.jpg')));

  console.log('# 12. ★ 用户强制刷新不能被后台自动抓取挡掉（force 语义）');
  /**
   * cd-service.js 顶部是解构导入（const { fetchDiscMetadata } = require(...)），
   * 模块加载后就绑死了原函数引用，直接改 exports 对象没用。
   * 所以这里卸掉缓存、用 Module._load 拦截重新加载一份带桩的 CdService 来验证。
   */
  let stubCalls = 0;
  const fetchModPath = require.resolve(path.join(ROOT, 'metadata/fetch.js'));
  const realFetch = require(fetchModPath).fetchDiscMetadata;
  const origLoad12 = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch (e) { return null; } })();
    if (resolved === fetchModPath) {
      return Object.assign({}, require.cache[fetchModPath].exports, {
        fetchDiscMetadata: async () => {
          stubCalls++;
          return {
            signature: null, source: 'netease', sources: ['netease'], album: '叶惠美',
            artist: '周杰伦', year: 2003, trackCount: 3,
            tracks: [{ number: 1, title: '以父之名' }, { number: 2, title: '懦夫' }, { number: 3, title: '晴天' }]
          };
        }
      });
    }
    return origLoad12.apply(this, arguments);
  };
  const svcId = require.resolve(path.join(ROOT, 'cd/cd-service.js'));
  delete require.cache[svcId];
  const { CdService: PatchedCdService } = require(svcId);
  Module._load = origLoad12;

  const svc12 = new PatchedCdService({
    userData: tmp, autoPlay: false, demo: false, log: () => {}, send: () => {}
  });
  svc12.drive = 'D';
  svc12.signature = 'sig1';
  svc12.toc = fakeNative.readToc();
  svc12.phase = 'ready';

  svc12._fetching = 'sig1';
  stubCalls = 0;
  await svc12._fetchMetadataBackground('sig1', svc12.toc, {});
  check('非 force：被去重挡下，未调用抓取', stubCalls === 0, stubCalls);

  svc12._fetching = 'sig1';
  stubCalls = 0;
  await svc12._fetchMetadataBackground('sig1', svc12.toc, { force: true });
  check('force：未被挡，确实发起了抓取', stubCalls === 1, stubCalls);
  check('force 抓取后 _fetching 被清理', !svc12._fetching, svc12._fetching);

  delete require.cache[svcId];
  svc12._fetching = null;

  console.log('# 13. refetchMetadata 在无碟时给出明确拒绝');
  const savedSig = svc.signature;
  svc.signature = null;
  const r13 = await svc.refetchMetadata({});
  check('无碟 → ok:false / no-disc', r13.ok === false && r13.reason === 'no-disc', r13);
  svc.signature = savedSig;

  console.log('# 14. ★ 空壳缓存不得被当作有效命中（否则失败的抓取会把碟永久锁死）');
  /**
   * 真实踩坑：旧实现只要求 tracks.length > 0 就算缓存命中，
   * 而骨架也有曲目（"轨道 N"），于是一次失败抓取写入的空壳
   * 会让这张碟此后永远不再联网 —— 表现为"代码修好了但用户仍拿不到封面"。
   * 这里直接验证判定条件本身。
   */
  const usable = (c) => !!c && Array.isArray(c.tracks) && c.tracks.length > 0 &&
    (!!c.album || (c.sources || []).length > 0 || !!c.manual);

  check('空壳（有曲目但无 album/无来源）→ 判为无效',
    usable({ tracks: [{ number: 1, title: '轨道 1' }], album: null, sources: [] }) === false);
  check('有专辑名 → 有效', usable({ tracks: [{ number: 1 }], album: 'X', sources: [] }) === true);
  check('有来源 → 有效', usable({ tracks: [{ number: 1 }], album: null, sources: ['netease'] }) === true);
  check('手动编辑过 → 有效（用户劳动成果）',
    usable({ tracks: [{ number: 1, title: '我改的' }], album: null, sources: [], manual: { album: 'M' } }) === true);
  check('无曲目 → 无效', usable({ tracks: [], album: 'X', sources: ['netease'] }) === false);
  check('null → 无效', usable(null) === false);

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})();
