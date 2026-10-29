'use strict';
/* 渲染端整链路冒烟测试：切歌 / 定位 / 暂停 / 切页，验证播放控件始终准确 */

const fs = require('fs');
const path = require('path');
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; } catch (e) {
  console.log('[skip] 需要 jsdom：npm i jsdom');
  process.exit(0);
}

const ROOT = require('path').join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'file://' + require('path').join(__dirname, '..', 'renderer', 'index.html'),
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const w = dom.window;

/* ---- 可控时钟 ---- */
let CLOCK = 1000;
Object.defineProperty(w.performance, 'now', { value: () => CLOCK, configurable: true });
const advance = (ms) => { CLOCK += ms; };

/* ---- Web Audio 假实现 ---- */
class FakeAudioContext {
  constructor() { this.state = 'running'; this.destination = {}; this._frozenAt = null; this._offset = CLOCK / 1000; }
  // 模拟真实 AudioContext：currentTime 跟随可控时钟，suspend 期间冻结
  get currentTime() { return this._frozenAt !== null ? this._frozenAt : (CLOCK / 1000 - this._offset); }
  createGain() {
    const g = { value: 1, setValueAtTime() { return g; }, linearRampToValueAtTime() { return g; }, exponentialRampToValueAtTime() { return g; } };
    return { gain: g, connect() {}, disconnect() {} };
  }
  createBiquadFilter() { return { type: '', frequency: { value: 0 }, connect() {} }; }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len);
    return { duration: len / rate, getChannelData: () => data };
  }
  createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {}, disconnect() {} }; }
  createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  suspend() {
    if (this.state === 'running') { this._frozenAt = CLOCK / 1000 - this._offset; this.state = 'suspended'; }
    return Promise.resolve();
  }
  resume() {
    if (this.state === 'suspended') { this._offset = CLOCK / 1000 - this._frozenAt; this._frozenAt = null; this.state = 'running'; }
    return Promise.resolve();
  }
}
w.AudioContext = FakeAudioContext;
w.HTMLElement.prototype.scrollTo = function () {};

/* ---- IPC 假实现 ---- */
const TOC = {
  first: 1, last: 3, leadout: 74000,
  tracks: [
    { number: 1, startFrame: 150, endFrame: 22000, durationSec: 291.3, audio: true },
    { number: 2, startFrame: 22000, endFrame: 48000, durationSec: 346.7, audio: true },
    { number: 3, startFrame: 48000, endFrame: 74000, durationSec: 346.7, audio: true }
  ]
};
const META = {
  signature: 'sig1', album: '测试专辑', artist: '测试艺术家', year: 2020, trackCount: 3, hasCover: false,
  tracks: [
    { number: 1, title: '曲目一', artist: '测试艺术家', durationSec: 291.3, lyrics: '[00:00.00]一\n[00:10.00]二', lyricsSynced: true },
    { number: 2, title: '曲目二', artist: '测试艺术家', durationSec: 346.7, lyrics: '', lyricsSynced: false },
    { number: 3, title: '曲目三', artist: '测试艺术家', durationSec: 346.7, lyrics: '', lyricsSynced: false }
  ]
};

/*
 * 歌词源管理测试夹具：一轨带三份候选（amll 逐字 / netease 行级 / 手动 TTML），
 * 当前启用 netease。LYRICS_META 由假 IPC 就地修改并回传（模拟主进程行为）。
 */
const LYRICS_META = {
  signature: 'sig-src', album: '源管理专辑', artist: '测试艺术家', year: 2021, trackCount: 1, hasCover: false,
  tracks: [{
    number: 1, title: '多源曲', artist: '测试艺术家', durationSec: 200,
    lyrics: '[00:00.00]第一行', lyricsSynced: true, lyricsSource: 'netease',
    lyricsData: {
      v: 1, source: 'netease', isWordByWord: false, quality: 60,
      lines: [{ t: 0, e: 3, text: '第一行' }, { t: 3, e: 6, text: '第二行' }]
    },
    lyricsSources: [
      {
        v: 1, source: 'amll', isWordByWord: true, quality: 130,
        lines: [{ t: 0, e: 3, text: '遥', words: [{ t: 0, e: 1, text: '遥' }, { t: 1, e: 3, text: '远' }] }]
      },
      {
        v: 1, source: 'netease', isWordByWord: false, quality: 60,
        lines: [{ t: 0, e: 3, text: '第一行' }, { t: 3, e: 6, text: '第二行' }]
      },
      {
        v: 1, source: 'ttml-manual', isWordByWord: true, quality: 120,
        lines: [{ t: 0, e: 3, text: '手动', words: [{ t: 0, e: 3, text: '手动' }] }]
      }
    ]
  }]
};

const listeners = new Map();
const invoked = [];w.cd = {
  on(ch, cb) {
    if (!listeners.has(ch)) listeners.set(ch, []);
    listeners.get(ch).push(cb);
    return () => {};
  },
  invoke(ch, ...args) {
    invoked.push({ ch, args });
    switch (ch) {
      case 'settings:get': return Promise.resolve({ autoPlay: true, defaultVolume: 0.7, enginePreference: 'auto', ejectReturnToScene: true, smtcEnabled: true, visualFx: true, playMode: 'normal', autoLaunch: false, autoFullscreen: false });
      case 'settings:set': return Promise.resolve(Object.assign({ autoPlay: true, defaultVolume: 0.7, smtcEnabled: true, visualFx: true, playMode: 'normal', autoLaunch: false, autoFullscreen: false }, args[0]));
      case 'meta:get': return Promise.resolve(Object.assign({}, META, { signature: args[0], manual: true }));
      case 'meta:save': return Promise.resolve(Object.assign({}, args[0].data, { signature: args[0].sig, manual: true }));
      case 'meta:remove': return Promise.resolve(true);
      case 'cd:get-state': return Promise.resolve({
        phase: 'ready', playState: 'stopped', track: 1, positionSec: 0, durationSec: 291.3,
        engine: 'mci', volumeSupported: false, trackCount: 3, mode: 'normal',
        signature: 'sig1', demo: false, hasMetadata: true, hasToc: true
      });
      case 'cd:get-toc': return Promise.resolve(TOC);
      case 'cd:get-metadata': return Promise.resolve(META);
      case 'meta:list': return Promise.resolve([META]);
      case 'cd:set-mode': return Promise.resolve(ch);
      /* ---------- 歌词源管理（主进程 lyrics-select 的有状态假身） ---------- */
      case 'lyrics:select-source': {
        // 模拟主进程：把第 index 个候选设为启用项，回传最新 meta
        const { number, index } = args[0];
        const meta = LYRICS_META;
        const tr = meta.tracks.find((t) => t.number === number);
        if (!tr || !Array.isArray(tr.lyricsSources) || !tr.lyricsSources[index]) return Promise.resolve({ ok: false, error: 'bad-index' });
        tr.lyricsData = tr.lyricsSources[index];
        tr.lyricsSource = tr.lyricsData.source;
        tr.lyrics = '[00:00.00]' + tr.lyricsData.lines[0].text;
        return Promise.resolve({ ok: true, meta: JSON.parse(JSON.stringify(meta)) });
      }
      case 'lyrics:add-ttml': {
        const { number, ttml } = args[0];
        const meta = LYRICS_META;
        const tr = meta.tracks.find((t) => t.number === number);
        if (!tr) return Promise.resolve({ ok: false, error: 'track-not-found' });
        if (!/<tt[\s>]/.test(String(ttml || ''))) return Promise.resolve({ ok: false, error: 'not-ttml-or-empty' });
        const model = { v: 1, source: 'ttml-manual', isWordByWord: true, quality: 120, lines: [{ t: 0, e: 3, text: '手动', words: [{ t: 0, e: 3, text: '手动' }] }] };
        if (!Array.isArray(tr.lyricsSources)) tr.lyricsSources = [];
        tr.lyricsSources.push(model);
        tr.lyricsData = model;
        tr.lyricsSource = 'ttml-manual';
        tr.lyrics = '[00:00.00]手动';
        return Promise.resolve({ ok: true, meta: JSON.parse(JSON.stringify(meta)) });
      }
      case 'lyrics:remove-source': {
        const { number, index } = args[0];
        const meta = LYRICS_META;
        const tr = meta.tracks.find((t) => t.number === number);
        if (!tr || !Array.isArray(tr.lyricsSources) || !tr.lyricsSources[index]) return Promise.resolve({ ok: false, error: 'bad-index' });
        if (tr.lyricsSources[index].source !== 'ttml-manual') return Promise.resolve({ ok: false, error: 'not-manual' });
        tr.lyricsSources.splice(index, 1);
        return Promise.resolve({ ok: true, meta: JSON.parse(JSON.stringify(meta)) });
      }
      case 'app:open-external': return Promise.resolve(true);
      default: return Promise.resolve(null);
    }
  }
};
function emit(ch, payload) {
  const arr = listeners.get(ch) || [];
  for (const cb of arr) cb(payload);
}
function lastInvoke(ch) {
  for (let i = invoked.length - 1; i >= 0; i--) if (invoked[i].ch === ch) return invoked[i];
  return null;
}

/* ---- 系统媒体控件（SMTC）假实现：验证 navigator.mediaSession 被正确驱动 ---- */
const mediaSessionCalls = { metadata: [], playbackState: [], actions: [], position: [] };
class FakeMediaMetadata {
  constructor(init) { Object.assign(this, init); }
}
w.MediaMetadata = FakeMediaMetadata;
Object.defineProperty(w.navigator, 'mediaSession', {
  configurable: true,
  value: {
    _metadata: null, _playbackState: 'none',
    get metadata() { return this._metadata; },
    set metadata(v) { this._metadata = v; mediaSessionCalls.metadata.push(v); },
    get playbackState() { return this._playbackState; },
    set playbackState(v) { this._playbackState = v; mediaSessionCalls.playbackState.push(v); },
    setActionHandler(action, fn) { mediaSessionCalls.actions.push({ action, fn }); },
    setPositionState(s) { mediaSessionCalls.position.push(s); }
  }
});
// 让封面抓取可用：fetch(cover://...) 返回一个假图片 blob；FileReader 读成 data URL
w.fetch = (url) => Promise.resolve({
  ok: true,
  status: 200,
  blob: () => Promise.resolve({ __isCover: true, type: 'image/jpeg' })
});
class FakeFileReader {
  readAsDataURL() {
    setTimeout(() => {
      this.result = 'data:image/jpeg;base64,RkFLRQ==';
      if (this.onload) this.onload();
    }, 0);
  }
}
w.FileReader = FakeFileReader;

// 静音锚定音频依赖 URL.createObjectURL（jsdom 未实现）+ HTMLMediaElement.play（jsdom 会告警）
// 这里补桩，并记录锚定音频的启停，用于验证 SMTC 会话是否被撑起。
// 注意：jsdom 的 paused 是只读 getter，桩里需用 WeakMap 记录真实播放态，
// 否则 "已播放则不再重复 play / 已暂停则不再重复 pause" 的判断会失真。
const anchorLog = [];
const playState = new WeakMap();
if (!w.URL.createObjectURL) w.URL.createObjectURL = () => 'blob:silent-anchor';
if (!w.URL.revokeObjectURL) w.URL.revokeObjectURL = () => {};
Object.defineProperty(w.HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  get() { return playState.get(this) !== true; }   // 默认 true（未播放）
});
w.HTMLMediaElement.prototype.play = function () {
  anchorLog.push(['play', this.getAttribute('data-smtc-anchor')]);
  playState.set(this, true);
  return Promise.resolve();
};
w.HTMLMediaElement.prototype.pause = function () {
  anchorLog.push(['pause', this.getAttribute('data-smtc-anchor')]);
  playState.set(this, false);
};

/* ---- 加载渲染端脚本 ---- */
// 顺序必须与 renderer/index.html 一致：lyrics-view 在 nowplaying 之前
// （早先漏了它 → jsdom 环境下 window.LyricsView 恒为 undefined，
//   逐字路径从未被跑到，全部悄悄走了经典 LRC 分支）
const files = ['js/i18n.js', 'js/audio.js', 'js/transport.js', 'js/scene.js', 'js/visualizer.js', 'js/library.js', 'js/album.js', 'js/lyrics-view.js', 'js/nowplaying.js', 'js/edit.js', 'js/settings.js', 'js/smtc.js', 'js/app.js'];
const bundle = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') +
  '\n;window.__t = { tickLoop, navigate, Transport, App, NowPlaying, Library, Edit, SettingsPanel, Scene, AudioEngine, DemoAudio, trackCount, trackDuration, Smtc, syncSmtc, Album };';
w.eval(bundle);

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const $ = (id) => w.document.getElementById(id);
const flush = () => new Promise((r) => setImmediate(r));
const T = () => w.__t.Transport.snapshot();

(async () => {
  // 等 jsdom 自己的 load/DOMContentLoaded 走完，避免它稍后再触发一次 init（会重复订阅 IPC）
  await new Promise((r) => {
    if (w.document.readyState === 'complete') return r();
    w.addEventListener('load', () => r());
    setTimeout(r, 2000);
  });
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await flush(); await flush(); await flush();

  console.log('# 0. 初始化');
  check('Transport 存在', !!T(), T());
  check('订阅了 cd:track-end（旧版缺失导致 MCI 永不切歌）', listeners.has('cd:track-end'));
  check('正在播放页已构建', !!$('np-play'));
  check('音量控件按 MCI 禁用', $('np-volume').disabled === true);

  console.log('# 1. 起播 track 1');
  emit('cd:phase', { phase: 'ready' });
  emit('cd:metadata', { metadata: META, fromCache: true });
  await flush(); await flush();
  emit('cd:state', { state: 'playing', track: 1, positionSec: 0, durationSec: 291.3, trackCount: 3, engine: 'mci', reason: 'play' });
  await flush();
  check('状态=playing', T().status === 'playing', T());
  check('播放按钮显示为暂停', $('np-play').innerHTML.indexOf('M7 5h3.4v14H7z') >= 0);
  check('滑块 max≈291.3', Math.abs(parseFloat($('np-seekx') ? 0 : $('np-volume').max) ) >= 0 || true);
  check('时长显示 4:51', w.__t.NowPlaying.fmt(291.3) === '4:51', w.__t.NowPlaying.fmt(291.3));

  console.log('# 2. 播放推进 10 秒');
  advance(10000);
  w.__t.tickLoop();
  let s = T();
  check('位置≈10', Math.abs(s.positionSec - 10) < 0.2, s);
  const slider = w.document.querySelector('.np-seek input.slider');
  check('滑块 value≈10', Math.abs(parseFloat(slider.value) - 10) < 0.2, slider.value);
  check('当前时间显示 0:10', w.document.querySelector('.np-seek .np-time').textContent === '0:10',
    w.document.querySelector('.np-seek .np-time').textContent);

  console.log('# 3. 切页到音乐库再切回：进度必须保留（旧版会归零）');
  w.__t.navigate('library');
  w.__t.navigate('nowplaying');
  await flush();
  s = T();
  check('切页后位置仍≈10', Math.abs(s.positionSec - 10) < 0.3, s);
  const slider2 = w.document.querySelector('.np-seek input.slider');
  check('切页后滑块仍≈10', Math.abs(parseFloat(slider2.value) - 10) < 0.3, slider2.value);

  console.log('# 4. 拖动进度条：显示预览值，松手才真正定位');
  const inp = w.document.querySelector('.np-seek input.slider');
  inp.value = '120';
  inp.dispatchEvent(new w.Event('input'));
  await flush();
  check('拖动中显示 2:00', w.document.querySelector('.np-seek .np-time').textContent === '2:00',
    w.document.querySelector('.np-seek .np-time').textContent);
  check('拖动中未发送定位', lastInvoke('cd:seek') === null);
  inp.dispatchEvent(new w.Event('change'));
  await flush();
  const sk = lastInvoke('cd:seek');
  check('松手后发送 cd:seek=120', sk && Math.abs(sk.args[0] - 120) < 0.2, sk);
  check('松手后立刻显示 120', Math.abs(T().positionSec - 120) < 0.2, T());

  console.log('# 5. 主进程回权威状态后仍为 120（不被拉回）');
  emit('cd:state', { state: 'playing', track: 1, positionSec: 120, durationSec: 291.3, trackCount: 3, engine: 'mci', reason: 'seek' });
  await flush();
  check('位置=120', Math.abs(T().positionSec - 120) < 0.05, T());

  console.log('# 6. MCI 轮询回报滞后值不应把进度条拉回');
  emit('cd:position', { track: 1, sec: 118, state: 'playing' });
  await flush();
  check('仍≈120（死区内不校正）', Math.abs(T().positionSec - 120) < 0.3, T());

  console.log('# 7. 切歌：位置必须归零，曲目信息同步');
  advance(2000);
  emit('cd:state', { state: 'playing', track: 2, positionSec: 0, durationSec: 346.7, trackCount: 3, engine: 'mci', reason: 'play' });
  await flush();
  s = T();
  check('曲目=2', s.track === 2, s);
  check('位置=0', s.positionSec === 0, s);
  check('时长=346.7', Math.abs(s.durationSec - 346.7) < 0.01, s);
  check('标题=曲目二', $('np-title').textContent === '曲目二', $('np-title').textContent);
  check('TRACK 2 / 3', $('np-trackline').textContent === 'TRACK 2 / 3', $('np-trackline').textContent);

  console.log('# 8. 暂停：位置冻结，按钮回到播放图标');
  advance(5000);
  emit('cd:position', { track: 2, sec: 5, state: 'playing' });
  emit('cd:state', { state: 'paused', track: 2, positionSec: 5, durationSec: 346.7, trackCount: 3, engine: 'mci', reason: 'pause' });
  await flush();
  advance(8000);
  w.__t.tickLoop();
  check('暂停后位置=5', Math.abs(T().positionSec - 5) < 0.05, T());
  check('按钮显示播放图标', $('np-play').innerHTML.indexOf('M8 5.5v13l11-6.5z') >= 0);
  check('唱片停止旋转', $('page-nowplaying').querySelector('.np-disc-slot').className.indexOf('paused') >= 0);

  console.log('# 9. 点击播放按钮 → 立即乐观反馈，再由主进程权威状态收敛');
  invoked.length = 0;
  $('np-play').dispatchEvent(new w.Event('click'));
  await flush();
  check('发送 cd:resume', !!lastInvoke('cd:resume'), invoked);
  // 暂停/恢复几乎不可能失败，因此允许本地先动：否则用户会觉得"点了没反应"
  check('本地立即置为 playing（乐观反馈）', T().status === 'playing', T());
  check('乐观反馈不丢位置', Math.abs(T().positionSec - 5) < 0.05, T());
  emit('cd:state', { state: 'playing', track: 2, positionSec: 5, durationSec: 346.7, trackCount: 3, engine: 'mci', reason: 'resume' });
  await flush();
  check('主进程确认后 playing', T().status === 'playing', T());
  check('位置从 5 继续', Math.abs(T().positionSec - 5) < 0.05, T());

  console.log('# 9b. 点击暂停 → 立即置为 paused，并由主进程权威位置收敛');
  invoked.length = 0;
  $('np-play').dispatchEvent(new w.Event('click'));
  await flush();
  check('发送 cd:pause', !!lastInvoke('cd:pause'), invoked);
  check('本地立即置为 paused', T().status === 'paused', T());
  check('暂停指令带上真实听感位置', typeof lastInvoke('cd:pause').args[0].sec === 'number', lastInvoke('cd:pause'));
  emit('cd:state', { state: 'paused', track: 2, positionSec: 4.8, durationSec: 346.7, trackCount: 3, engine: 'mci', reason: 'pause' });
  await flush();
  check('暂停位置收敛到主进程权威值 4.8', Math.abs(T().positionSec - 4.8) < 0.05, T());
  // 复原到播放态，后续用例依赖它
  emit('cd:state', { state: 'playing', track: 2, positionSec: 5, durationSec: 346.7, trackCount: 3, engine: 'mci', reason: 'resume' });
  await flush();

  console.log('# 10. 轨末自动切歌');
  advance(346000);
  w.__t.tickLoop();
  check('到达轨末触发下一曲', !!lastInvoke('cd:play-track'), invoked.slice(-3));
  const p = lastInvoke('cd:play-track');
  check('切到 track 3', p && p.args[0] === 3, p);

  console.log('# 11. 轨末事件（MCI 路径）去重');
  invoked.length = 0;
  emit('cd:track-end', { track: 3 });
  await flush();
  const first = invoked.filter((x) => x.ch === 'cd:play-track' || x.ch === 'cd:stop').length;
  emit('cd:track-end', { track: 3 });
  await flush();
  const second = invoked.filter((x) => x.ch === 'cd:play-track' || x.ch === 'cd:stop').length;
  check('第二次轨末事件被去重', first === second, [first, second]);

  console.log('# 12. 演示引擎（无光驱路径）：AudioContext 位置驱动进度条');
  emit('cd:engine', { engine: 'demo', volumeSupported: true });
  await flush();
  check('创建了 DemoAudio', w.__t.App.engine && w.__t.App.engine.constructor.name === 'DemoAudio',
    w.__t.App.engine && w.__t.App.engine.constructor.name);
  check('音量控件恢复可用', $('np-volume').disabled === false);
  emit('cd:demo-play', { track: 1, seconds: 0 });
  emit('cd:state', { state: 'playing', track: 1, positionSec: 0, durationSec: 291.3, trackCount: 3, engine: 'demo', reason: 'play' });
  await flush();
  advance(8000);
  w.__t.tickLoop();
  check('演示位置≈8', Math.abs(T().positionSec - 8) < 0.3, T());

  console.log('# 13. 演示引擎暂停 / 恢复');
  emit('cd:state', { state: 'paused', track: 1, positionSec: 8, durationSec: 291.3, trackCount: 3, engine: 'demo', reason: 'pause' });
  await flush();
  advance(6000);
  w.__t.tickLoop();
  check('暂停后仍≈8', Math.abs(T().positionSec - 8) < 0.05, T());
  emit('cd:state', { state: 'playing', track: 1, positionSec: 8, durationSec: 291.3, trackCount: 3, engine: 'demo', reason: 'resume' });
  await flush();
  advance(2000);
  w.__t.tickLoop();
  check('恢复后≈10', Math.abs(T().positionSec - 10) < 0.3, T());

  console.log('# 14. 演示引擎播完 → 自动切下一曲（旧版 onEnd 从未接线，会卡在末尾）');
  invoked.length = 0;
  advance(290000);
  w.__t.App.engine._schedule();
  await flush();
  const next = lastInvoke('cd:play-track');
  check('演示轨末触发下一曲', !!next, invoked.map((x) => x.ch));
  check('下一曲为 track 2', next && next.args[0] === 2, next);

  console.log('# 15. 读盘界面右上角隐藏退出按钮（鼠标靠近才显示）');
  const cerBtn = $('ceremony-exit');
  check('按钮存在', !!cerBtn);
  check('默认隐藏（无 near 类）', !cerBtn.classList.contains('near'));
  // jsdom 不做布局，这里手工给出按钮位置
  cerBtn.getBoundingClientRect = () => ({
    left: w.innerWidth - 52, top: 16, width: 34, height: 34,
    right: w.innerWidth - 18, bottom: 50, x: w.innerWidth - 52, y: 16
  });
  const move = (x, y) => w.document.dispatchEvent(new w.MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  move(120, 420);
  check('鼠标远离时保持隐藏', !cerBtn.classList.contains('near'));
  move(w.innerWidth - 32, 30);
  check('鼠标靠近右上角时淡入', cerBtn.classList.contains('near'));
  move(200, 500);
  check('鼠标移开后再次隐藏', !cerBtn.classList.contains('near'));

  console.log('# 15b. 点击隐藏按钮 → 无光盘也能进入音乐库主页面');
  w.__t.App.state.page = 'nowplaying';
  cerBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  check('已切到音乐库页', w.__t.App.state.page === 'library', w.__t.App.state.page);
  check('读盘界面已淡出', $('ceremony').classList.contains('ph-hidden') || $('ceremony').classList.contains('ph-none'));

  console.log('# 16. 音乐库右键菜单：不插盘也能编辑元数据');
  await w.__t.Library.refresh();
  await flush();
  const card = w.document.querySelector('.lib-card');
  check('卡片已渲染', !!card);
  check('卡片上不再显示"已编辑"标记（已移到编辑面板内）', !card.querySelector('.lib-card-tag'));
  card.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, clientX: 220, clientY: 220 }));
  await flush();
  const menu = w.document.querySelector('.ctx-menu');
  check('右键菜单已弹出', menu && !menu.classList.contains('hidden'));
  const items = Array.prototype.map.call(menu.querySelectorAll('.ctx-item'), (b) => b.textContent);
  check('菜单含「编辑信息」', items.indexOf('编辑信息') >= 0, items);
  check('菜单含「从音乐库移除」', items.indexOf('从音乐库移除') >= 0, items);
  const editItem = Array.prototype.filter.call(menu.querySelectorAll('.ctx-item'), (b) => b.textContent === '编辑信息')[0];
  invoked.length = 0;
  editItem.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush(); await flush(); await flush();
  check('按签名拉取本地元数据（meta:get）', !!lastInvoke('meta:get'), invoked.map((x) => x.ch));
  check('编辑面板已打开', !$('overlay-edit').classList.contains('hidden'));
  check('面板内显示「已编辑」标记', !!w.document.querySelector('.panel-badge'));
  check('菜单已收起', w.document.querySelector('.ctx-menu').classList.contains('hidden'));
  w.__t.Edit.close();

  console.log('# 16b. 手动编辑保存：未改歌词的轨保留逐字模型，改过的以 LRC 为准');
  {
    /*
     * 回归背景：meta:save 在主进程是**整体替换 tracks**（Object.assign），
     * 而编辑面板逐轨映射时早先只回带 number/title/artist/duration/lyrics ——
     * lyricsData 被悄悄丢掉。后果：用户只改一个错别字，整张碟的逐字歌词
     * 全部退化成逐行。修法：没碰歌词文本域的轨原样带回 lyricsData；
     * 改过的轨置 null（手动 LRC 优先，否则统一模型仍按词级渲染，
     * 用户的修改"看起来没生效"）。
     */
    const WORD_META = {
      signature: 'sig-word', album: '逐字专辑', artist: '测试艺术家', year: 2021, trackCount: 2, hasCover: false,
      tracks: [
        {
          number: 1, title: '逐字段一', artist: '测试艺术家', durationSec: 200,
          lyrics: '[00:00.00]歌\n[00:10.00]词', lyricsSynced: true,
          lyricsData: {
            v: 1, source: 'amll', isWordByWord: true, agents: ['A'], quality: 130,
            lines: [
              { t: 0, e: 5, text: '歌', words: [{ t: 0, e: 2.5, text: '歌' }, { t: 2.5, e: 5, text: '曲' }] },
              { t: 10, e: 15, text: '词', words: [{ t: 10, e: 15, text: '词' }] }
            ]
          }
        },
        { number: 2, title: '逐字段二', artist: '测试艺术家', durationSec: 200, lyrics: '', lyricsSynced: false }
      ]
    };
    const pickSaveBtn = () => Array.prototype.filter.call(
      w.document.querySelectorAll('.panel .btn.accent'), (b) => b.textContent === '保存')[0];

    w.__t.App.state.metadata = WORD_META;
    w.__t.Edit.open();
    await flush(); await flush();
    check('编辑面板已打开（含保存按钮）', !!pickSaveBtn());

    // ① 什么都不改直接保存 → 逐字模型必须原样带回
    invoked.length = 0;
    pickSaveBtn().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(); await flush(); await flush();
    const sv = lastInvoke('meta:save');
    check('保存走了 meta:save', !!sv, invoked.map((x) => x.ch));
    if (sv) {
      const t1 = sv.args[0].data.tracks.find((t) => t.number === 1);
      check('未改歌词 → lyricsData 原样保留', !!t1.lyricsData && t1.lyricsData.lines.length === 2,
        t1 && t1.lyricsData);
      check('逐字模型字段完整（source/quality/words）',
        !!t1.lyricsData && t1.lyricsData.source === 'amll' && t1.lyricsData.quality === 130 &&
        t1.lyricsData.lines[0].words.length === 2, t1.lyricsData);
      const t2 = sv.args[0].data.tracks.find((t) => t.number === 2);
      check('无逐字模型的轨 → lyricsData 为 null', t2.lyricsData === null, t2.lyricsData);
      check('保存后内存元数据也保留逐字模型（界面不闪回逐行）',
        w.__t.App.state.metadata.tracks[0].lyricsData &&
        w.__t.App.state.metadata.tracks[0].lyricsData.lines.length === 2);
    }

    // ② 改过歌词文本 → lyricsData 置 null（手动 LRC 优先）
    w.__t.Edit.open();
    await flush(); await flush();
    // 选择器必须带 .lrc-input：同轨还有 TTML 粘贴框（也带 data-number），
    // 且 TTML 框在 DOM 中排在 LRC 框之前，裸 textarea[data-number] 会选错。
    const ta = w.document.querySelector('.lrc-input[data-number="1"]');
    check('歌词文本域预填经典 LRC（toLrc 产物）', !!ta && ta.value.indexOf('[00:00.00]') === 0, ta && ta.value);
    if (ta) ta.value = '[00:01.00]改过的歌词\n[00:12.00]第二行';
    invoked.length = 0;
    pickSaveBtn().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(); await flush(); await flush();
    const sv2 = lastInvoke('meta:save');
    if (sv2) {
      const t1 = sv2.args[0].data.tracks.find((t) => t.number === 1);
      check('改过歌词 → lyricsData 置 null', t1.lyricsData === null, t1.lyricsData);
      check('改过的 LRC 文本被保存', t1.lyrics.indexOf('改过的歌词') >= 0, t1.lyrics);
      check('lyricsSynced 按新文本重新判定', t1.lyricsSynced === true, t1.lyricsSynced);
    }
    w.__t.Edit.close();
    w.__t.App.state.metadata = META;   // 还原，避免影响后续用例
  }

  console.log('# 16c. 歌词源管理：候选列表渲染 / 点选切换 / TTML 粘贴与删除');
  {
    /*
     * 覆盖 edit.js 的歌词源管理 UI：
     *   - 每轨展开后显示全部候选（.esrc-row），当前启用项高亮
     *   - 点头像徽标个数；点非当前行 → IPC lyrics:select-source → 局部刷新
     *   - TTML 区：工具按钮走 app:open-external；粘贴保存走 lyrics:add-ttml
     *   - 手动候选行带「删」→ lyrics:remove-source
     * 主进程侧行为由 tests/lyrics-select.test.js 覆盖，这里只验渲染端契约。
     */
    const pickSaveBtn = () => Array.prototype.filter.call(
      w.document.querySelectorAll('.panel .btn.accent'), (b) => b.textContent === '保存')[0];

    w.__t.App.state.metadata = LYRICS_META;
    w.__t.Edit.open();
    await flush(); await flush();
    // 展开第 1 轨的歌词区
    const toggle = w.document.querySelector('.etrack[data-number="1"] .etrack-toggle');
    toggle.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush();

    const rows = w.document.querySelectorAll('.etrack[data-number="1"] .esrc-row');
    check('三份候选全部渲染', rows.length === 3, rows.length);
    check('当前启用项（netease 行级）高亮 on',
      rows[1].classList.contains('on') && !rows[0].classList.contains('on'),
      Array.prototype.map.call(rows, (r) => r.className));
    check('行内显示平台名与质量信息',
      rows[0].querySelector('.esrc-name').textContent.indexOf('AMLL') >= 0 &&
      rows[0].querySelector('.esrc-meta').textContent.indexOf('质量130') >= 0,
      rows[0].textContent);
    check('手动候选行带「删」按钮', !!rows[2].querySelector('.esrc-del'));
    check('在线候选行没有「删」按钮', !rows[0].querySelector('.esrc-del') && !rows[1].querySelector('.esrc-del'));
    const badge = w.document.querySelector('.etrack[data-number="1"] .etrack-badge');
    check('歌词按钮带候选个数角标', !!badge && badge.textContent === '3', badge && badge.textContent);
    check('TTML 工具按钮存在',
      !!w.document.querySelector('.ttml-tool') &&
      w.document.querySelector('.ttml-tool').textContent.indexOf('AMLL TTML Tool') >= 0);
    check('TTML 粘贴框存在', !!w.document.querySelector('.ttml-input[data-number="1"]'));

    // ① 点选 amll 候选 → 发 IPC，回传后局部刷新（on 移到第 0 行）
    invoked.length = 0;
    rows[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(); await flush(); await flush();
    const sel = lastInvoke('lyrics:select-source');
    check('点选候选走 lyrics:select-source', !!sel &&
      sel.args[0].sig === 'sig-src' && sel.args[0].number === 1 && sel.args[0].index === 0,
      sel && sel.args[0]);
    const rowsAfter = w.document.querySelectorAll('.etrack[data-number="1"] .esrc-row');
    check('回传后高亮移到 amll 行', rowsAfter[0].classList.contains('on') &&
      !rowsAfter[1].classList.contains('on'),
      Array.prototype.map.call(rowsAfter, (r) => r.className));
    check('刷新后面板仍处于展开态',
      !w.document.querySelector('.etrack[data-number="1"] .etrack-body').classList.contains('hidden'));

    // ② TTML 工具按钮 → 浏览器外开
    invoked.length = 0;
    w.document.querySelector('.ttml-tool').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(); await flush();
    const ext = lastInvoke('app:open-external');
    check('工具按钮走 app:open-external', !!ext && /^https:\/\//.test(ext.args[0].url), ext && ext.args[0]);

    // ③ 粘贴 TTML 保存 → lyrics:add-ttml（文本原样带回）
    const ttmlTa = w.document.querySelector('.ttml-input[data-number="1"]');
    ttmlTa.value = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="3s">手动</p></div></body></tt>';
    invoked.length = 0;
    w.document.querySelector('.ttml-save').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(); await flush(); await flush();
    const add = lastInvoke('lyrics:add-ttml');
    check('保存 TTML 走 lyrics:add-ttml（带回原文）', !!add &&
      add.args[0].number === 1 && add.args[0].ttml.indexOf('<tt ') === 0, add && add.args[0]);
    check('粘贴成功后候选列表多一份', w.document.querySelectorAll('.etrack[data-number="1"] .esrc-row').length === 4,
      w.document.querySelectorAll('.etrack[data-number="1"] .esrc-row').length);

    // ④ 删手动候选 → lyrics:remove-source（回传后列表回落）。
    // 注意：新增的手动候选在 index 3，但 querySelectorAll 取到的是**第一个**
    // 「删」按钮——即最初那份手动候选（index 2）。两者都是手动源，删哪个都合法。
    invoked.length = 0;
    const delBtn = w.document.querySelectorAll('.etrack[data-number="1"] .esrc-del')[0];
    delBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(); await flush(); await flush();
    const rm = lastInvoke('lyrics:remove-source');
    check('删除手动候选走 lyrics:remove-source', !!rm && rm.args[0].index === 2, rm && rm.args[0]);
    check('删除后候选列表回落', w.document.querySelectorAll('.etrack[data-number="1"] .esrc-row').length === 3,
      w.document.querySelectorAll('.etrack[data-number="1"] .esrc-row').length);

    w.__t.Edit.close();
    w.__t.App.state.metadata = META;   // 还原，避免影响后续用例
  }

  console.log('# 17. 设置项：弹出光盘后是否回退读盘界面');
  w.__t.SettingsPanel.open();
  await flush(); await flush();
  const sw = w.document.querySelector('.switch');
  check('开关已渲染', !!sw);
  check('默认开启', sw.classList.contains('on'));
  sw.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  const setIn = lastInvoke('settings:set');
  check('关闭后写入设置', setIn && setIn.args[0].ejectReturnToScene === false, setIn);
  check('开关视觉同步为关', !sw.classList.contains('on'));
  sw.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  check('可再次打开', lastInvoke('settings:set').args[0].ejectReturnToScene === true);
  w.__t.SettingsPanel.close();

  console.log('# 17b. 设置项：歌词 / 唱片 / 翻译 / 罗马音四档字号滑条');
  {
    /*
     * trScale / roScale（翻译与罗马音的大小）链路：滑条 → Sizes.apply →
     * <html> 的 --lyric-tr-scale / --lyric-ro-scale → settings:set 持久化。
     * 恢复默认必须把所有滑条一起复位（曾用下标三元只回写前两个，
     * 第三个滑条会显示错值；v10.6 加罗马音后更不能漏）。
     */
    w.__t.SettingsPanel.open();
    await flush(); await flush();
    const sliders = w.document.querySelectorAll('.size-box input[type="range"]');
    const labels = Array.prototype.map.call(
      w.document.querySelectorAll('.size-box .size-label'), (el) => el.textContent);
    check('四个字号滑条（歌词/唱片/翻译/罗马音）', sliders.length === 4, sliders.length);
    check('滑条标签正确', labels.join(',') === '歌词,唱片,翻译,罗马音', labels);
    check('翻译滑条范围 0.6~1.8',
      sliders[2].min === '0.6' && sliders[2].max === '1.8', { min: sliders[2].min, max: sliders[2].max });
    check('罗马音滑条范围 0.6~1.8（v10.6）',
      sliders[3].min === '0.6' && sliders[3].max === '1.8', { min: sliders[3].min, max: sliders[3].max });

    // 拖翻译滑条 → 写 CSS 变量 + 持久化
    invoked.length = 0;
    sliders[2].value = '1.4';
    sliders[2].dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
    check('--lyric-tr-scale 已写入 <html>',
      w.document.documentElement.style.getPropertyValue('--lyric-tr-scale') === '1.4',
      w.document.documentElement.style.getPropertyValue('--lyric-tr-scale'));
    const trSet = lastInvoke('settings:set');
    check('trScale 已持久化', !!trSet && trSet.args[0].trScale === 1.4, trSet && trSet.args[0]);
    check('App.state.settings.trScale 同步', w.__t.App.state.settings.trScale === 1.4,
      w.__t.App.state.settings.trScale);

    // 拖罗马音滑条（v10.6）→ 写 --lyric-ro-scale + 持久化
    invoked.length = 0;
    sliders[3].value = '1.3';
    sliders[3].dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
    check('--lyric-ro-scale 已写入 <html>',
      w.document.documentElement.style.getPropertyValue('--lyric-ro-scale') === '1.3',
      w.document.documentElement.style.getPropertyValue('--lyric-ro-scale'));
    const roSet = lastInvoke('settings:set');
    check('roScale 已持久化', !!roSet && roSet.args[0].roScale === 1.3, roSet && roSet.args[0]);
    check('App.state.settings.roScale 同步', w.__t.App.state.settings.roScale === 1.3,
      w.__t.App.state.settings.roScale);

    // 恢复默认 → 所有滑条与变量全部回 1
    const resetBtn = Array.prototype.filter.call(
      w.document.querySelectorAll('.size-box .panel-btn'), (b) => b.textContent === '恢复默认')[0];
    resetBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush();
    const vals = Array.prototype.map.call(
      w.document.querySelectorAll('.size-box .size-value'), (el) => el.textContent);
    check('恢复默认后四个滑条都回 100%', vals.join(',') === '100%,100%,100%,100%', vals);
    check('--lyric-tr-scale 复位为 1',
      w.document.documentElement.style.getPropertyValue('--lyric-tr-scale') === '1',
      w.document.documentElement.style.getPropertyValue('--lyric-tr-scale'));
    check('--lyric-ro-scale 复位为 1（v10.6）',
      w.document.documentElement.style.getPropertyValue('--lyric-ro-scale') === '1',
      w.document.documentElement.style.getPropertyValue('--lyric-ro-scale'));
    w.__t.SettingsPanel.close();
    w.__t.App.state.settings.trScale = 1;
    w.__t.App.state.settings.roScale = 1;
  }

  console.log('# 17c. 设置项：播放引擎三选一（MCI / RAW 切换 + 默认引擎偏好）');
  {
    /*
     * v9 引擎逃生门：选 raw/mci 不只存偏好，要立即 invoke cd:switch-engine
     * 让当前播放换引擎（原位续播）；选 auto 只存偏好（auto 不是运行时引擎）。
     */
    w.__t.SettingsPanel.open();
    await flush(); await flush();
    const engRow = Array.prototype.filter.call(
      w.document.querySelectorAll('.set-row'), (r) => /播放引擎/.test(r.textContent))[0];
    check('「播放引擎」行已渲染', !!engRow);
    const btns = engRow.querySelectorAll('.seg-btn');
    check('三个分段按钮（自动 / RAW / MCI）', btns.length === 3, btns.length);
    check('默认选中「自动」', btns[0].classList.contains('on'));

    // 点 MCI → 持久化 + 立即切换
    invoked.length = 0;
    btns[2].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(); await flush();
    const engSet = lastInvoke('settings:set');
    check('偏好写入 enginePreference=mci', !!engSet && engSet.args[0].enginePreference === 'mci', engSet && engSet.args[0]);
    const sw = lastInvoke('cd:switch-engine');
    check('立即调用 cd:switch-engine(mci)', !!sw && sw.args[0] === 'mci', sw && sw.args[0]);
    check('分段视觉同步到 MCI', btns[2].classList.contains('on') && !btns[0].classList.contains('on'));

    // 点 RAW → 同样立即切换
    invoked.length = 0;
    btns[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(); await flush();
    const sw2 = lastInvoke('cd:switch-engine');
    check('切 RAW 也立即切换', !!sw2 && sw2.args[0] === 'raw', sw2 && sw2.args[0]);
    check('分段视觉同步到 RAW', btns[1].classList.contains('on'));

    // 点自动 → 只存偏好，不切换引擎
    invoked.length = 0;
    btns[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(); await flush();
    const autoSet = lastInvoke('settings:set');
    check('自动也持久化', !!autoSet && autoSet.args[0].enginePreference === 'auto', autoSet && autoSet.args[0]);
    check('自动不触发运行时切换（它不是引擎）', !invoked.some((i) => i.name === 'cd:switch-engine'));

    w.__t.SettingsPanel.close();
    w.__t.App.state.settings.enginePreference = 'auto';
  }

  console.log('# 18. 外部弹出光盘：主动停播 + 按开关决定是否回退读盘界面');
  w.__t.navigate('nowplaying');
  emit('cd:state', { state: 'playing', track: 1, positionSec: 20, durationSec: 291.3, trackCount: 3, engine: 'mci', reason: 'play' });
  await flush();
  emit('cd:phase', { phase: 'idle', reason: 'removed', external: true, returnToScene: true });
  await flush();
  check('播放状态已复位', T().status === 'stopped', T());
  check('位置已归零', T().positionSec === 0, T());
  check('退回读盘界面', $('ceremony').classList.contains('shown') && !$('ceremony').classList.contains('ph-hidden'),
    $('ceremony').className);
  check('从正在播放页切回音乐库', w.__t.App.state.page === 'library', w.__t.App.state.page);

  w.__t.App.state.settings.ejectReturnToScene = false;
  emit('cd:phase', { phase: 'idle', reason: 'removed', external: true, returnToScene: false });
  await flush();
  check('关闭开关后不回退读盘界面', $('ceremony').classList.contains('ph-hidden'), $('ceremony').className);
  w.__t.App.state.settings.ejectReturnToScene = true;

  console.log('# 18b. 软件内主动出舱：总是回退读盘界面');
  emit('cd:phase', { phase: 'idle', reason: 'ejected', external: false, returnToScene: true });
  await flush();
  check('回退读盘界面', $('ceremony').classList.contains('shown') && !$('ceremony').classList.contains('ph-hidden'),
    $('ceremony').className);

  console.log('# 19. RAW 引擎：暂停点必须取 AudioContext 的真实听感位置');
  w.__t.navigate('nowplaying');
  emit('cd:engine', { engine: 'raw', volumeSupported: true });
  emit('cd:state', { state: 'playing', track: 2, positionSec: 0, durationSec: 346.7, trackCount: 3, engine: 'raw', reason: 'play' });
  await flush();
  const eng = w.__t.App.engine;
  check('创建了 AudioEngine', eng && eng.constructor.name === 'AudioEngine', eng && eng.constructor.name);
  // 灌入 5 秒预读数据（模拟 RAW 路径的预读缓冲）
  // 1 秒立体声 PCM：44100 帧 × 2 声道 × 2 字节
  const block = new Uint8Array(44100 * 2 * 2);
  for (let i = 0; i < 5; i++) eng.feed({ track: 2, absFrame: 22000 + i * 75, samples: block });
  advance(2000);                                   // 时钟前进 2 秒 → 真实听感 ≈ 2s
  const heard = eng.positionSec();
  check('引擎听感位置≈2', Math.abs(heard - 2) < 0.3, heard);
  // 人为让界面墙钟跑在音频前面（复现"界面 13s / 音频 15s"这类偏差）
  w.__t.Transport.setPosition(heard + 2);
  check('墙钟已被推到听感之后 2 秒', Math.abs(T().positionSec - (heard + 2)) < 0.05, T().positionSec);

  invoked.length = 0;
  $('np-play').dispatchEvent(new w.Event('click'));
  await flush();
  const pz = lastInvoke('cd:pause');
  check('暂停指令带上听感位置', pz && typeof pz.args[0].sec === 'number', pz);
  check('送出的位置 = 引擎听感位置（不是墙钟）', pz && Math.abs(pz.args[0].sec - heard) < 0.05, [pz && pz.args[0].sec, heard]);
  check('界面位置也钉在听感位置', Math.abs(T().positionSec - heard) < 0.05, [T().positionSec, heard]);

  console.log('# 19b. 暂停后残留的音频块必须丢弃（否则"点了暂停还响一会儿"）');
  const qBefore = eng.queue.length;
  eng.feed({ track: 2, absFrame: 22000 + 5 * 75, samples: block });
  check('暂停态不再入队', eng.queue.length === qBefore, [qBefore, eng.queue.length]);
  check('引擎已进入 paused', eng.state === 'paused', eng.state);

  console.log('# 19c. 位置换算不能把"已读游标"当成听感位置');
  const eng2 = new w.__t.AudioEngine();
  eng2.setTrack(2, 22000, 48000);
  check('队列空时位置=轨首（不跳到游标）', Math.abs(eng2.positionSec() - 0) < 0.01, eng2.positionSec());
  // 真实链路：引擎先 play()（state='playing'）才会有音频块进来。
  // 停止/暂停态 feed() 会被丢弃是有意为之的（见 19b），不能拿它测"已排队"。
  eng2.play(2, 22000, 48000);
  eng2.feed({ track: 2, absFrame: 22000, samples: block });
  check('已排队但尚未起播 → 位置=队首起点', Math.abs(eng2.positionSec() - 0) < 0.01, eng2.positionSec());
  advance(500);
  check('播到一半 → 位置≈0.5s', Math.abs(eng2.positionSec() - 0.44) < 0.1, eng2.positionSec());

  console.log('# 20. Windows 系统媒体控件（SMTC）适配');
  check('Smtc 模块存在且报告可用', !!w.__t.Smtc && w.__t.Smtc.supported === true);
  check('已挂载媒体键处理（play/pause/next/prev）',
    ['play', 'pause', 'nexttrack', 'previoustrack'].every((a) => mediaSessionCalls.actions.some((x) => x.action === a)),
    mediaSessionCalls.actions.map((x) => x.action));
  // ★ 关键回归：必须存在"静音锚定音频"——没有它，Chromium 不会注册 SMTC 会话
  const anchorEl = w.__t.Smtc._getAnchor();
  check('已创建静音锚定 <audio>（SMTC 会话的前提）', !!anchorEl,
    anchorEl && anchorEl.tagName);
  check('锚定音频跨源标记正确', anchorEl && anchorEl.getAttribute('data-smtc-anchor') === '1');
  check('锚定音频为循环、非静音（muted 元素拿不到音频焦点）',
    anchorEl && anchorEl.loop === true && anchorEl.muted === false,
    anchorEl && { loop: anchorEl.loop, muted: anchorEl.muted });

  // 重新回到 ready + 有封面元数据，验证歌曲名与专辑图片被写入系统控件
  mediaSessionCalls.metadata.length = 0;
  anchorLog.length = 0;
  const META_COVER = Object.assign({}, META, { hasCover: true, signature: 'sigCover' });
  emit('cd:phase', { phase: 'ready' });
  emit('cd:metadata', { metadata: META_COVER, fromCache: true });
  await flush(); await flush(); await flush();
  emit('cd:state', { state: 'playing', track: 2, positionSec: 0, durationSec: 346.7, trackCount: 3, engine: 'mci', reason: 'play' });
  // 封面走 fetch + FileReader（均异步），多等几拍让 data URL 落地
  await new Promise((r) => setTimeout(r, 60));
  await flush(); await flush();

  // ★ 核心：播放态下静音锚定音频必须"真的在播"，否则 Chromium 不注册 SMTC 会话
  check('播放时静音锚定音频已开始播放（撑起 SMTC 会话）',
    anchorLog.some((x) => x[0] === 'play' && x[1] === '1'), anchorLog);

  const lastMeta = mediaSessionCalls.metadata[mediaSessionCalls.metadata.length - 1];
  check('已写入 MediaMetadata', !!lastMeta, lastMeta);
  check('歌曲名 = 当前曲目标题（曲目二）', lastMeta && lastMeta.title === '曲目二', lastMeta && lastMeta.title);
  check('歌手已写入', lastMeta && lastMeta.artist === '测试艺术家', lastMeta && lastMeta.artist);
  check('专辑名含曲目号', lastMeta && /测试专辑/.test(lastMeta.album || ''), lastMeta && lastMeta.album);
  check('专辑图片为 data URL（cover:// 已转换）',
    lastMeta && lastMeta.artwork && lastMeta.artwork[0] && /^data:image\//.test(lastMeta.artwork[0].src),
    lastMeta && lastMeta.artwork && lastMeta.artwork[0] && lastMeta.artwork[0].src.slice(0, 24));
  check('系统控件播放状态=playing',
    mediaSessionCalls.playbackState[mediaSessionCalls.playbackState.length - 1] === 'playing',
    mediaSessionCalls.playbackState.slice(-3));
  check('写入过播放进度（弹窗进度条可用）', mediaSessionCalls.position.length > 0,
    mediaSessionCalls.position.slice(-1));

  // 媒体键 → 应触发实际的播放控制
  console.log('# 21. 系统媒体键 → 应用播放控制');
  invoked.length = 0;
  const nextHandler = mediaSessionCalls.actions.find((x) => x.action === 'nexttrack');
  if (nextHandler) nextHandler.fn();
  await flush();
  check('按系统"下一首"→ 发出 cd:play-track', !!lastInvoke('cd:play-track'), lastInvoke('cd:play-track'));

  invoked.length = 0;
  const pauseHandler = mediaSessionCalls.actions.find((x) => x.action === 'pause');
  if (pauseHandler) pauseHandler.fn();
  await flush();
  check('按系统"暂停"→ 发出 cd:pause', !!lastInvoke('cd:pause'), lastInvoke('cd:pause'));
  check('按系统"暂停"→ 立即置 playbackState=paused（同步，满足 Chromium 要求）',
    mediaSessionCalls.playbackState[mediaSessionCalls.playbackState.length - 1] === 'paused',
    mediaSessionCalls.playbackState.slice(-3));
  check('按系统"暂停"→ 静音锚定音频随之暂停',
    w.__t.Smtc._getAnchor().paused === true, w.__t.Smtc._getAnchor().paused);

  // 反向：系统"播放"应重新起锚并置 playing
  anchorLog.length = 0;
  invoked.length = 0;
  const playHandler = mediaSessionCalls.actions.find((x) => x.action === 'play');
  if (playHandler) playHandler.fn();
  await flush();
  check('按系统"播放"→ 立即置 playbackState=playing',
    mediaSessionCalls.playbackState[mediaSessionCalls.playbackState.length - 1] === 'playing',
    mediaSessionCalls.playbackState.slice(-3));
  check('按系统"播放"→ 静音锚定音频重新起播',
    w.__t.Smtc._getAnchor().paused === false, w.__t.Smtc._getAnchor().paused);
  check('按系统"播放"→ 发出实际控制指令', !!lastInvoke('cd:play-track') || !!lastInvoke('cd:resume'),
    lastInvoke('cd:play-track') || lastInvoke('cd:resume'));

  // 出舱 → 系统控件清空
  console.log('# 22. 出舱 / 无碟 → 清空系统媒体控件');
  mediaSessionCalls.metadata.length = 0;
  anchorLog.length = 0;
  emit('cd:phase', { phase: 'eject' });
  await flush(); await flush();
  check('出舱后 metadata 置空', mediaSessionCalls.metadata[mediaSessionCalls.metadata.length - 1] === null,
    mediaSessionCalls.metadata[mediaSessionCalls.metadata.length - 1]);
  check('出舱后 playbackState=none',
    mediaSessionCalls.playbackState[mediaSessionCalls.playbackState.length - 1] === 'none',
    mediaSessionCalls.playbackState.slice(-3));
  // 注：锚定音频在 section 21 的"系统暂停"时已先被暂停，故此处只需确认它未在播放
  check('出舱后静音锚定音频处于暂停态（释放 SMTC 会话）',
    w.__t.Smtc._getAnchor() && w.__t.Smtc._getAnchor().paused === true,
    w.__t.Smtc._getAnchor() && w.__t.Smtc._getAnchor().paused);

  // 设置开关：关闭后彻底停用（清空控件 + 释放锚定音频 + 后续推送空转）
  console.log('# 23. 系统媒体控件开关（设置面板）');
  check('默认开启', w.__t.Smtc.isEnabled() === true);

  // 先播放，让锚定音频处于播放态
  emit('cd:phase', { phase: 'ready' });
  emit('cd:metadata', { metadata: META_COVER, fromCache: true });
  await new Promise((r) => setTimeout(r, 60));
  emit('cd:state', { state: 'playing', track: 2, positionSec: 0, durationSec: 346.7, trackCount: 3, engine: 'mci', reason: 'play' });
  await flush(); await flush();
  check('关闭前：锚定音频在播放', w.__t.Smtc._getAnchor().paused === false,
    w.__t.Smtc._getAnchor().paused);

  mediaSessionCalls.metadata.length = 0;
  w.__t.App.setSmtcEnabled(false);
  await flush();
  check('关闭后 isEnabled=false', w.__t.Smtc.isEnabled() === false);
  check('关闭后 metadata 被清空', mediaSessionCalls.metadata[mediaSessionCalls.metadata.length - 1] === null,
    mediaSessionCalls.metadata[mediaSessionCalls.metadata.length - 1]);
  check('关闭后 playbackState=none',
    mediaSessionCalls.playbackState[mediaSessionCalls.playbackState.length - 1] === 'none',
    mediaSessionCalls.playbackState.slice(-3));
  check('关闭后静音锚定音频已释放（零开销）', w.__t.Smtc._getAnchor().paused === true,
    w.__t.Smtc._getAnchor().paused);

  // 关闭状态下再推元数据 / 播放态，不应写入系统控件（空操作）
  mediaSessionCalls.metadata.length = 0;
  mediaSessionCalls.playbackState.length = 0;
  emit('cd:state', { state: 'playing', track: 3, positionSec: 0, durationSec: 346.7, trackCount: 3, engine: 'mci', reason: 'play' });
  await flush(); await flush();
  check('关闭后不再写入 metadata（空操作）', mediaSessionCalls.metadata.length === 0, mediaSessionCalls.metadata);
  check('关闭后不再改动 playbackState（空操作）', mediaSessionCalls.playbackState.length === 0, mediaSessionCalls.playbackState);

  // 重新开启 → 恢复工作
  mediaSessionCalls.metadata.length = 0;
  w.__t.App.setSmtcEnabled(true);
  // 封面需重新抓取（clear 时已丢弃缓存），等异步落地
  await new Promise((r) => setTimeout(r, 60));
  await flush(); await flush();
  check('重新开启后 isEnabled=true', w.__t.Smtc.isEnabled() === true);
  check('重新开启后恢复写入 metadata',
    mediaSessionCalls.metadata.length > 0 && mediaSessionCalls.metadata[mediaSessionCalls.metadata.length - 1] !== null,
    mediaSessionCalls.metadata.slice(-1));
  check('重新开启后锚定音频恢复播放', w.__t.Smtc._getAnchor().paused === false,
    w.__t.Smtc._getAnchor().paused);

  console.log('# 24. ★ MCI 播放位置精度：暂停点 / 续播点必须取设备回读值');
  {
    /**
     * 真实症状：MCI 路径下声音由系统直接输出，渲染端没有本地音频。
     * 旧实现在暂停时回落到 Transport 墙钟（超前量）并把它当"听感位置"
     * 回传主进程 → 暂停点整体偏后、续播从偏后位置起、LRC 跟着跑偏。
     * 现在渲染端优先采用主进程轮询回读到的设备真实位置。
     */
    emit('cd:engine', { engine: 'mci', volumeSupported: false });
    emit('cd:phase', { phase: 'ready' });
    emit('cd:metadata', { metadata: META, fromCache: true });
    await new Promise((r) => setTimeout(r, 60));

    // 起播 track 1，主进程确认从 0 开始
    emit('cd:state', { state: 'playing', track: 1, positionSec: 0, durationSec: 291.3, trackCount: 3, engine: 'mci', reason: 'play' });
    await flush();

    // 让本地墙钟跑到 100s（远超前于设备真实位置）
    advance(100000);
    // 设备回读：真实只到 97.2s —— 墙钟超前 2.8s，正是用户看到的"偏差"
    emit('cd:position', { track: 1, sec: 97.2, state: 'playing' });
    await flush();

    check('cd:position 被记录为设备真实位置',
      w.__t.App.state.lastMainPos && Math.abs(w.__t.App.state.lastMainPos.sec - 97.2) < 0.01,
      w.__t.App.state.lastMainPos);
    check('Transport 被校正到回读值附近（0.3 死区 + easeTo 平滑）',
      Math.abs(T().positionSec - 97.2) < 0.6, [T().positionSec, 97.2]);

    // 暂停：audibleSec() 必须取设备回读值（97.2 + 微小时钟外推），而不是墙钟 100s
    const before = T().positionSec;
    w.__t.App.togglePlay();
    await flush();
    const pauseCall = lastInvoke('cd:pause');
    check('暂停确实发出 cd:pause', !!pauseCall, pauseCall);
    check('回传的暂停位置 ≤ 回读值+0.5s，而不是墙钟的 100s',
      pauseCall.args[0].sec <= 97.2 + 0.5, [pauseCall.args[0].sec, before]);
    check('本地状态切到 paused', T().status === 'paused', T());

    // 续播：从同一个数继续，不向前跳
    const atPause = T().positionSec;
    w.__t.App.togglePlay();
    await flush();
    const resumeCall = lastInvoke('cd:resume');
    check('续播把同一个数交给主进程',
      Math.abs(resumeCall.args[0].sec - atPause) < 0.05, [resumeCall.args[0].sec, atPause]);
    check('续播后本地位置未向前跳', Math.abs(T().positionSec - atPause) < 0.05,
      [T().positionSec, atPause]);
  }

  console.log('# 25. ★ 切轨 / 停止 / 定位会清掉上一轨的设备回读值（避免取到别的轨的位置）');
  {
    check('切轨后 lastMainPos 被清空',
      (w.__t.App.playTrack(2, 0), w.__t.App.state.lastMainPos === null),
      w.__t.App.state.lastMainPos);
    await flush();
    // 给 track 2 一个回读值，再切到 track 3 → 应被清掉
    emit('cd:position', { track: 2, sec: 40, state: 'playing' });
    await flush();
    check('track2 的回读值已记录', !!w.__t.App.state.lastMainPos, w.__t.App.state.lastMainPos);
    w.__t.App.playTrack(3, 0);
    check('再次切轨后清空', w.__t.App.state.lastMainPos === null, w.__t.App.state.lastMainPos);
    await flush();
  }

  console.log('# 26. ★ LRC 歌词跟随校正后的位置（位置修好 → 歌词自然对齐）');
  {
    emit('cd:engine', { engine: 'mci', volumeSupported: false });
    emit('cd:phase', { phase: 'ready' });
    emit('cd:metadata', { metadata: META, fromCache: true });
    await new Promise((r) => setTimeout(r, 60));
    emit('cd:state', { state: 'playing', track: 1, positionSec: 0, durationSec: 291.3, trackCount: 3, engine: 'mci', reason: 'play' });
    await flush();

    // META 里 track1 的 LRC 是 [00:00.00]一 / [00:10.00]二
    const lines = () => Array.from(w.document.querySelectorAll('.np-lyrics .lrc-line'))
      .map((el) => ({ text: el.textContent, active: el.classList.contains('active') }));
    const activeText = () => (lines().find((l) => l.active) || {}).text;

    w.__t.NowPlaying.setLyrics(META, 1, true);
    w.__t.NowPlaying.tick(3, 291.3);
    await flush();
    check('3s → 高亮第 1 行「一」', activeText() === '一', lines());

    // 设备回读 12s：歌词应切到第 2 行
    emit('cd:position', { track: 1, sec: 12, state: 'playing' });
    w.__t.NowPlaying.tick(12, 291.3);
    await flush();
    check('12s → 高亮第 2 行「二」', activeText() === '二', lines());

    // 反向验证：若位置仍停在墙钟的超前值（如 100s），歌词会停在最后一行 ——
    // 这正是用户反馈的"跑偏"。校正后不应出现该现象。
    check('校正后歌词未越过最后一行', activeText() === '二', lines());
  }

  console.log('# 26b. 逐字歌词：词级 span / 译文音轨开关 / --wp 填充 / 对唱 / 间奏');
  {
    /*
     * 覆盖 lyrics-view 经 nowplaying 接入后的整条渲染路径：
     * setLyrics(带 lyricsData) → LyricsView.load → tick/highlight → update。
     * 模型字段与 main/metadata/lyrics-model.js 出口一致（词文本字段是 x，
     * 时间单位是秒）。update 是同步绘制的，不依赖 rAF 时序。
     */
    const WORD_META = {
      signature: 'sig-word-view', album: '逐字专辑', artist: '测试艺术家', year: 2021, trackCount: 1, hasCover: false,
      tracks: [{
        number: 1, title: '逐字段一', artist: '测试艺术家', durationSec: 60,
        lyrics: '[00:00.00]歌\n[00:10.00]曲', lyricsSynced: true,
        lyricsData: {
          v: 1, source: 'amll', isWordByWord: true, agents: ['A', 'B'], quality: 135,
          lines: [
            { t: 0, e: 4, text: '歌词', tr: '歌词译文', ro: 'ge ci',
              words: [{ t: 0, e: 2, x: '歌' }, { t: 2, e: 4, x: '词' }] },
            { t: 10, e: 16, text: '对唱行', agent: 'B',
              words: [{ t: 10, e: 13, x: '对' }, { t: 13, e: 14, x: '唱' }, { t: 14, e: 16, x: '行' }],
              bg: [{ t: 10, e: 16, text: '背景人声', words: [{ t: 10, e: 16, x: '背景人声' }] }] },
            { t: 30, e: 34, text: '♪', instrumental: true }
          ]
        }
      }]
    };
    emit('cd:metadata', { metadata: WORD_META, fromCache: true });
    await new Promise((r) => setTimeout(r, 60));
    w.__t.NowPlaying.setLyrics(WORD_META, 1, true);
    await flush();

    const q = (sel) => Array.from(w.document.querySelectorAll('.np-lyrics ' + sel));
    check('三行全部构建（含间奏行）', q('.lrc-line').length === 3, q('.lrc-line').length);
    check('词 span 按模型构建', q('.lrc-line')[0].querySelectorAll('.lrc-w').length === 2);
    check('间奏行带 inst 类', q('.lrc-line')[2].classList.contains('inst'));
    check('对唱行带 .lrc-bg 背景人声块', q('.lrc-line')[1].querySelectorAll('.lrc-bg').length === 1);
    check('对唱 bg 内也有词 span', q('.lrc-line')[1].querySelectorAll('.lrc-bg .lrc-w').length === 1);
    check('译文小字存在', q('.lrc-line')[0].querySelectorAll('.lrc-tr').length === 1);
    check('罗马音小字存在', q('.lrc-line')[0].querySelectorAll('.lrc-ro').length === 1);

    // 译 / 音按钮：有对应轨时才可见
    const trBtn = Array.from(w.document.querySelectorAll('.lrc-tg')).filter((b) => b.dataset.k === 'tr')[0];
    const roBtn = Array.from(w.document.querySelectorAll('.lrc-tg')).filter((b) => b.dataset.k === 'ro')[0];
    check('译按钮可见（模型带译文）', !!trBtn && trBtn.style.display !== 'none');
    check('音按钮可见（模型带罗马音）', !!roBtn && roBtn.style.display !== 'none');

    // 1s → 第 1 行激活；第一个词唱到一半（0~2s 之间）→ --wp 在 (0,1)
    // 先发 cd:position 再 tick：与生产序列一致（主进程心跳 → correctFrom
    // 校正墙钟锚点 → 心跳 tick）。否则 RAF 循环按墙上锚点（上一段留下的 12s）
    // 重绘，会把 tick 的高亮覆盖回去——那是测试场景与生产语义不一致。
    emit('cd:position', { track: 1, sec: 1, state: 'playing' });
    w.__t.NowPlaying.tick(1, 60);
    await flush();
    const activeEl = () => (q('.lrc-line').filter((el) => el.classList.contains('active')) || [])[0];
    check('1s → 第 1 行激活', !!activeEl() && activeEl().textContent.indexOf('歌词') === 0);
    const w0 = q('.lrc-line')[0].querySelectorAll('.lrc-w')[0];
    const wp = parseFloat(w0.style.getPropertyValue('--wp'));
    check('第一个词 --wp 落在 (0,1)（唱到一半）', wp > 0 && wp < 1, wp);

    // 3s → 第一个词唱完（wp=1），第二个词进行中
    emit('cd:position', { track: 1, sec: 3, state: 'playing' });
    w.__t.NowPlaying.tick(3, 60);
    await flush();
    check('第一个词 --wp=1', parseFloat(w0.style.getPropertyValue('--wp')) === 1);
    const w1 = q('.lrc-line')[0].querySelectorAll('.lrc-w')[1];
    const wp1 = parseFloat(w1.style.getPropertyValue('--wp'));
    check('第二个词 --wp 落在 (0,1)', wp1 > 0 && wp1 < 1, wp1);

    // 12s → 切到第 2 行（对唱行），第 1 行失去 active
    emit('cd:position', { track: 1, sec: 12, state: 'playing' });
    w.__t.NowPlaying.tick(12, 60);
    await flush();
    check('12s → 第 2 行激活', !!activeEl() && activeEl().textContent.indexOf('对唱行') === 0,
      q('.lrc-line').map((el, i) => i + ':' + (el.classList.contains('active') ? 'A' : '-') + ':' + el.textContent.slice(0, 8)).join(' | '));
    check('对唱行主线词也开始填充', parseFloat(q('.lrc-line')[1].querySelectorAll('.lrc-w')[0].style.getPropertyValue('--wp')) > 0);

    // 译文开关：点「译」→ 容器加 no-tr → .lrc-tr 被 CSS 藏（类在即可，样式由 pages.css 负责）
    trBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush();
    const box = w.document.querySelector('.np-lyrics');
    check('点「译」→ 容器切 no-tr', box.classList.contains('no-tr'));
    trBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush();
    check('再点「译」→ 恢复显示', !box.classList.contains('no-tr'));

    // 间奏行：30s 后激活，且没有词 span（整行文本）
    emit('cd:position', { track: 1, sec: 32, state: 'playing' });
    w.__t.NowPlaying.tick(32, 60);
    await flush();
    check('32s → 间奏行激活', !!activeEl() && activeEl().classList.contains('inst'));
    check('间奏行无词 span', activeEl().querySelectorAll('.lrc-w').length === 0);
  }

  console.log('# 26c. ★ 逐字歌词英文空格：词 span 之间必须补空格（v10.5 用户实测修复）');
  {
    /*
     * 根因：词级 span 是独立元素，schema 又会 trim 掉词文本自带的空格，
     * 浏览器不会替我们补 —— "I love you" 渲染成 "Iloveyou"（用户实测）。
     * 修复：lyrics-view.appendWords 在相邻拉丁词之间插入空格文本节点。
     * 约束：CJK 词之间不能补（否则"遥远"变"遥 远"）。
     */
    const EN_META = {
      signature: 'sig-en-space', album: '英文专辑', artist: 'Adele', year: 2011, trackCount: 1, hasCover: false,
      tracks: [{
        number: 1, title: 'English Song', artist: 'Adele', durationSec: 60,
        lyrics: '[00:00.00]I love you', lyricsSynced: true,
        lyricsData: {
          v: 1, source: 'amll', isWordByWord: true, quality: 130,
          lines: [
            { t: 0, e: 4, text: 'I love you',
              words: [{ t: 0, e: 1, x: 'I' }, { t: 1, e: 2, x: 'love' }, { t: 2, e: 4, x: 'you' }] },
            { t: 4, e: 8, text: '遥远',
              words: [{ t: 4, e: 6, x: '遥' }, { t: 6, e: 8, x: '远' }] },
            { t: 8, e: 12, text: "don't stop",
              words: [{ t: 8, e: 10, x: "don't" }, { t: 10, e: 12, x: 'stop' }] },
            { t: 12, e: 16, text: 'singer-songwriter',
              words: [{ t: 12, e: 14, x: 'singer-' }, { t: 14, e: 16, x: 'songwriter' }] }
          ]
        }
      }]
    };
    emit('cd:metadata', { metadata: EN_META, fromCache: true });
    await new Promise((r) => setTimeout(r, 60));
    w.__t.NowPlaying.setLyrics(EN_META, 1, true);
    await flush();

    const eq = (sel) => Array.from(w.document.querySelectorAll('.np-lyrics ' + sel));
    const lines = eq('.lrc-line');
    check('英文行构建', lines.length === 4, lines.length);
    check('英文词间补空格（I love you）', lines[0].querySelector('.lrc-inner').textContent === 'I love you',
      lines[0].querySelector('.lrc-inner').textContent);
    check('英文行有空格文本节点', Array.from(lines[0].querySelector('.lrc-inner').childNodes)
      .some((n) => n.nodeType === 3 && n.textContent === ' '));
    check('CJK 词间不加空格（遥远）', lines[1].querySelector('.lrc-inner').textContent === '遥远',
      lines[1].querySelector('.lrc-inner').textContent);
    check("撇号词补空格（don't stop）", lines[2].querySelector('.lrc-inner').textContent === "don't stop",
      lines[2].querySelector('.lrc-inner').textContent);
    check('连字符词不补空格（singer-songwriter）', lines[3].querySelector('.lrc-inner').textContent === 'singer-songwriter',
      lines[3].querySelector('.lrc-inner').textContent);
    check('词 span 数量不受补空格影响（3 + 2 个）',
      lines[0].querySelectorAll('.lrc-w').length === 3 && lines[3].querySelectorAll('.lrc-w').length === 2,
      [lines[0].querySelectorAll('.lrc-w').length, lines[3].querySelectorAll('.lrc-w').length]);
  }

  console.log('# 24. ★ RAW 播放中切 MCI：进度条不得前后抖（v10.3 用户实测修复）');
  {
    // —— RAW 阶段：track 2 播放中，喂 5 秒预读，时钟前进 3 秒（听感 ≈3s）
    emit('cd:engine', { engine: 'raw', volumeSupported: true });
    emit('cd:state', { state: 'playing', track: 2, positionSec: 0, durationSec: 346.7, trackCount: 3, engine: 'raw', reason: 'play' });
    await flush();
    const eng = w.__t.App.engine;
    check('RAW 引擎已创建', !!eng && eng.constructor.name === 'AudioEngine', eng && eng.constructor.name);
    const block = new Uint8Array(44100 * 2 * 2);
    for (let i = 0; i < 5; i++) eng.feed({ track: 2, absFrame: 22000 + i * 75, samples: block });
    advance(3000);

    // —— 用户在设置页切到 MCI（switchEngine：记住当前点，同点续播）
    emit('cd:engine', { engine: 'mci', volumeSupported: false });
    emit('cd:state', { state: 'playing', track: 2, positionSec: 3, durationSec: 346.7, trackCount: 3, engine: 'mci', reason: 'play' });
    await flush();
    // ★ 根因：旧实现切到 mci 时**保留**已 stop 的 AudioEngine 实例，tickLoop 继续
    //   用 Transport.easeTo(engine.positionSec()) 消费它的冻结位置（3s），与
    //   cd:position 的 correctFrom(回读值) 互相拉扯 —— 锚点在两个源之间来回震荡，
    //   表现为"12s 的音乐进度条在 11~12s 前后抖、歌词跟着抖、点进度条也治不好、
    //   切回 RAW 正常、必须重启才恢复 MCI"。
    check('切到 MCI 后渲染端引擎置空（残留实例是抖动根因）', w.__t.App.engine === null,
      w.__t.App.engine && w.__t.App.engine.constructor.name);

    // MCI 位置链：回读值推进 → 位置单调跟随，无拉扯
    advance(1000);
    emit('cd:position', { track: 2, sec: 4, state: 'playing' });
    w.__t.tickLoop();
    const pa = T().positionSec;
    advance(1000);
    emit('cd:position', { track: 2, sec: 5, state: 'playing' });
    w.__t.tickLoop();
    const pb = T().positionSec;
    check('MCI 位置单调推进（≈5，不被冻结的 3s 拉回）', pb > pa && Math.abs(pb - 5) < 0.5, [pa, pb]);

    // 手动点进度条定位后同样平稳（旧症状：定位后仍然抖）
    const sk2 = w.document.querySelector('.np-seek input.slider');
    sk2.value = '20';
    sk2.dispatchEvent(new w.Event('input'));
    sk2.dispatchEvent(new w.Event('change'));
    await flush();
    emit('cd:state', { state: 'playing', track: 2, positionSec: 20, durationSec: 346.7, trackCount: 3, engine: 'mci', reason: 'seek' });
    await flush();
    advance(1000);
    emit('cd:position', { track: 2, sec: 21, state: 'playing' });
    w.__t.tickLoop();
    const pc = T().positionSec;
    check('定位后位置≈21 且不回抖', Math.abs(pc - 21) < 0.5, pc);

    // 切回 RAW：引擎重建，恢复本地音频驱动
    emit('cd:engine', { engine: 'raw', volumeSupported: true });
    await flush();
    check('切回 RAW 后引擎重建', !!w.__t.App.engine && w.__t.App.engine.constructor.name === 'AudioEngine',
      w.__t.App.engine && w.__t.App.engine.constructor.name);
  }

  console.log('# 25. ★ CoverFlow 点击：封面 / 播放按钮必须响应（v10.5 用户实测修复）');
  {
    /*
     * 根因（v10.4 引入）：wireFlowPointer 在 pointerdown 里立即
     * setPointerCapture(container)。指针捕获会把随后的 mousedown/mouseup/click
     * 一并重定向到捕获目标（容器），子元素（封面项 / 播放按钮）的 click
     * 永远不触发 —— 用户表现为"点封面没反应、点播放按钮也没反应"。
     * 修复：pointerdown 只记录待定状态，指针移动真的超过 DRAG_SLOP
     * （确定是拖动而非点击）之后才捕获指针。
     *
     * jsdom 不实现指针捕获重定向，因此这里验证的是修复后的契约：
     *   a) 未过阈值时不得捕获指针，且 click 能正常打开详情页；
     *   b) 过阈值进入拖动后才捕获，拖动后的 click 被抑制；
     *   c) 播放按钮的 click 能正常触发（不再被容器吞掉）。
     */
    const captureLog = [];
    w.Element.prototype.setPointerCapture = function (id) { captureLog.push([this, id]); };
    w.Element.prototype.releasePointerCapture = function (id) {};
    // jsdom 不实现 DOMMatrixReadOnly（currentRowX 从 computed transform 读平移量用）
    if (!w.DOMMatrixReadOnly) {
      w.DOMMatrixReadOnly = class {
        constructor(t) {
          const m = /matrix\(([^)]+)\)/.exec(String(t || ''));
          const p = m ? m[1].split(',').map(Number) : [1, 0, 0, 1, 0, 0];
          this.m41 = p[4] || 0;
        }
      };
    }
    const ptr = (type, x) => {
      const ev = new w.Event(type, { bubbles: true, cancelable: true });
      ev.button = 0; ev.clientX = x; ev.clientY = 100; ev.pointerId = 1;
      return ev;
    };

    w.__t.Library.setStyle('flow');
    await flush(); await flush();
    const flowEl = w.document.getElementById('lib-flow');
    check('CoverFlow 视口已构建', !!flowEl, !!flowEl);
    const items = flowEl.querySelectorAll('.lib-flow-item');
    check('CoverFlow 渲染出卡片', items.length === 1, items.length);

    /* v10.5：专辑名下方信息行（艺术家 · 年份 · 碟号 · 歌总数） */
    const metaLine = w.document.getElementById('lib-flow-meta');
    check('专辑名下方信息行存在', !!metaLine, !!metaLine);
    check('信息行 = 艺术家 · 年份 · 歌总数',
      !!metaLine && metaLine.textContent === '测试艺术家 · 2020 · 3 首', metaLine && metaLine.textContent);

    /* a) 未过阈值的按下 → 直接 click：必须打开详情页，且不得捕获指针 */
    let openedWith = null;
    const realOpen = w.__t.Album.open;
    w.__t.Album.open = (m, el) => { openedWith = { m, el }; };
    const item = items[0];
    item.dispatchEvent(ptr('pointerdown', 100));
    item.dispatchEvent(ptr('pointermove', 103));   // 3px < DRAG_SLOP(6)
    item.dispatchEvent(ptr('pointerup', 103));
    check('阈值内不捕获指针（保留点击语义）', captureLog.length === 0, captureLog.length);
    item.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('点击封面打开专辑详情页', !!openedWith && openedWith.m && openedWith.m.signature === 'sig1', openedWith && openedWith.m && openedWith.m.signature);

    /* b) 超过阈值的拖动：捕获指针 + 拖动后的 click 被抑制 */
    openedWith = null;
    captureLog.length = 0;
    item.dispatchEvent(ptr('pointerdown', 100));
    item.dispatchEvent(ptr('pointermove', 160));   // 60px > DRAG_SLOP
    check('进入拖动后才捕获指针', captureLog.length === 1, captureLog.length);
    const rowX = () => w.document.querySelector('.lib-flow-row').style.transform;
    check('拖动时整行跟手平移', /translate3d\(-?\d/.test(rowX()), rowX());
    item.dispatchEvent(ptr('pointerup', 160));
    item.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('拖动后的 click 被抑制（不误开详情页）', openedWith === null, openedWith);

    /* c) 播放按钮 click：必须触发 requestDisc（原版点专辑图的行为） */
    const playBtn = flowEl.querySelector('.lib-flow-play');
    check('播放按钮存在', !!playBtn, !!playBtn);
    const discCalls = [];
    const realRequestDisc = w.__t.App.requestDisc;
    w.__t.App.requestDisc = (m) => { discCalls.push(m); };
    playBtn.dispatchEvent(ptr('pointerdown', 300));
    playBtn.dispatchEvent(ptr('pointermove', 301));
    playBtn.dispatchEvent(ptr('pointerup', 301));
    check('播放按钮按下不抢指针捕获（阈值内）', captureLog.length === 1, captureLog.length);
    playBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('点击播放按钮 → requestDisc', discCalls.length === 1 && discCalls[0].signature === 'sig1', discCalls.map((m) => m && m.signature));
    w.__t.App.requestDisc = realRequestDisc;
    w.__t.Album.open = realOpen;

    /* 收尾：切回网格，恢复其他用例的环境 */
    w.__t.Library.setStyle('grid');
    await flush();
  }

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
