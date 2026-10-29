'use strict';
/*
 * metadata.test.js —— 在线元数据链路的离线自检。
 *
 * 原则：**一个真实网络请求都不发**。做法是在 require 之前把 http 层打桩，
 * 让所有源返回预先准备的假数据，从而能稳定复现过去那些"偶发失败"。
 *
 * 覆盖的是真正踩过坑的几处：
 *   1) MusicBrainz 返回结构解析（旧实现读 data.discs 而非 data.releases，恒为空）
 *   2) TOC 参数编码（空格必须编码成 +）
 *   3) 得分选优（多版本发行里挑最像本张碟的那个）
 *   4) 骨架生成与曲目兜底
 *   5) 元数据白名单重建时 **封面 Buffer 必须透传**（旧实现丢失 → 封面永远存不下）
 *   6) 网易云按时长逐轨对应（轨数不一致时不能错位贴名）
 *   7) 合并语义（后来的源只能补空缺，不能覆盖已有值）
 *   8) hint 交叉校验（MB 认错碟时，用户给的 hint 要能纠正）
 */

const path = require('path');
const Module = require('module');

// ---------- 打桩：拦截 './http'，所有网络调用走内存 ----------
const httpPath = require.resolve(path.join(__dirname, '..', 'main', 'metadata', 'http.js'));

const routes = new Map();   // url 前缀 -> 处理函数
let httpCalls = [];

const httpStub = {
  DEFAULT_UA: 'test',
  BROWSER_UA: 'test-browser',
  MAX_COVER_BYTES: 6 * 1024 * 1024,
  qs(obj) {
    return Object.keys(obj)
      .filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`)
      .join('&');
  },
  withTimeout(promise, ms, label) {
    let timer = null;
    const t = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error((label || '请求') + ' 超时')), ms);
    });
    return Promise.race([promise, t]).finally(() => clearTimeout(timer));
  },
  async getJson(url, opts) {
    httpCalls.push({ url, opts });
    for (const [prefix, handler] of routes) {
      if (url.indexOf(prefix) === 0) return handler(url, opts);
    }
    throw new Error('HTTP 404 @ ' + url);
  },
  async postJson(url, body, opts) {
    httpCalls.push({ url, opts, body });
    for (const [prefix, handler] of routes) {
      if (url.indexOf(prefix) === 0) return handler(url, opts);
    }
    throw new Error('HTTP 404 @ ' + url);
  },
  async getBuffer(url, opts) {
    httpCalls.push({ url, opts });
    for (const [prefix, handler] of routes) {
      if (url.indexOf(prefix) === 0) {
        const r = await handler(url, opts);
        if (r && r.__buffer) return { body: r.body, contentType: r.contentType };
        if (r && r.__null) return null;
      }
    }
    throw new Error('HTTP 404 @ ' + url);
  }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === httpPath.replace('http.js', 'musicbrainz.js') && request === './http') {
    return httpStub;
  }
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent, isMain); } catch (e) { return null; }
  })();
  if (resolved === httpPath) return httpStub;
  return origLoad.apply(this, arguments);
};

const { lookupByToc, encodeToc, pickBestRelease, searchRelease, artistCreditName } = require(path.join(__dirname, '..', 'main', 'metadata', 'musicbrainz.js'));
const netease = require(path.join(__dirname, '..', 'main', 'metadata', 'netease.js'));
const { validateMetadata } = require(path.join(__dirname, '..', 'main', 'metadata', 'schema.js'));
const {
  emptySkeleton, mergeInto, applyTracks, applyTracksByDuration, fetchDiscMetadata,
  filterTracksByDisc, inferDiscNumber, discInfoOf
} = require(path.join(__dirname, '..', 'main', 'metadata', 'fetch.js'));

let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok  ' + name); }
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function reset() { routes.clear(); httpCalls = []; }

/* ============ 1. TOC 编码 ============ */
console.log('# 1. TOC 参数编码：空格必须是 + 而不是 %20');
check('空格编码为 +', encodeToc('1 12 100 150 200') === '1+12+100+150+200', encodeToc('1 12 100 150 200'));

/* ============ 2. MusicBrainz 结构解析 ============ */
console.log('# 2. MusicBrainz 返回结构：顶层是 releases（旧实现误读 discs → 恒为空）');
const MB_REL = {
  id: 'rel-1',
  title: 'Nevermind',
  date: '1991-09-24',
  status: 'Official',
  'release-group': { id: 'rg-1', 'primary-type': 'Album', genres: [{ name: 'Grunge' }] },
  'artist-credit': [{ name: 'Nirvana', joinphrase: '' }],
  media: [{
    'track-count': 3,
    tracks: [
      { position: 1, title: 'Smells Like Teen Spirit', length: 301133, 'artist-credit': [{ name: 'Nirvana' }] },
      { position: 2, title: 'In Bloom', length: 175000, 'artist-credit': [{ name: 'Nirvana' }] },
      { position: 3, title: 'Come as You Are', length: 219000, 'artist-credit': [{ name: 'Nirvana' }] }
    ]
  }]
};
const TOC3 = {
  first: 1, last: 3, leadout: 70000,
  tracks: [
    { number: 1, startFrame: 150, endFrame: 22725, durationSec: 301 },
    { number: 2, startFrame: 22725, endFrame: 35900, durationSec: 175 },
    { number: 3, startFrame: 35900, endFrame: 52300, durationSec: 219 }
  ]
};

reset();
routes.set('https://musicbrainz.org/ws/2/discid/', () => ({ releases: [MB_REL] }));
(async () => {
  const mb = await lookupByToc(TOC3);
  check('解析出专辑名', mb && mb.album === 'Nevermind', mb && mb.album);
  check('解析出歌手', mb && mb.artist === 'Nirvana', mb && mb.artist);
  check('解析出年份', mb && mb.year === 1991, mb && mb.year);
  check('解析出 3 首曲目', mb && mb.tracks.length === 3, mb && mb.tracks.length);
  check('曲目时长由 ms 转秒', mb && Math.abs(mb.tracks[0].durationSec - 301.133) < 0.01, mb && mb.tracks[0].durationSec);
  check('releaseMbid 已带出', mb && mb.releaseMbid === 'rel-1', mb && mb.releaseMbid);
  check('genre 已带出', mb && mb.genres.indexOf('Grunge') >= 0, mb && JSON.stringify(mb.genres));
  check('inc 参数已瘦身（不再含 release-groups）', httpCalls.length > 0 && httpCalls[0].url.indexOf('release-groups') < 0, httpCalls[0] && httpCalls[0].url);

  /* ---------- 3. 无匹配 ---------- */
  console.log('# 3. MusicBrainz 无匹配 → 返回 null 而不是抛错或返回残缺对象');
  reset();
  routes.set('https://musicbrainz.org/ws/2/discid/', () => ({ releases: [] }));
  check('空 releases → null', (await lookupByToc(TOC3)) === null);

  /* ---------- 4. 多版本选优 ---------- */
  console.log('# 4. 多版本选优：曲目数一致优先，Official 与 Album 加分');
  const multi = [
    { id: 'a', title: 'Single版', date: '1992', status: 'Official', 'release-group': { 'primary-type': 'Single' }, 'artist-credit': [{ name: 'X' }], media: [{ 'track-count': 3, tracks: [] }] },
    { id: 'b', title: '正规专辑', date: '1991', status: 'Official', 'release-group': { 'primary-type': 'Album' }, 'artist-credit': [{ name: 'X' }], media: [{ 'track-count': 3, tracks: [] }] },
    { id: 'c', title: '轨数不符', date: '1991', status: 'Official', 'release-group': { 'primary-type': 'Album' }, 'artist-credit': [{ name: 'X' }], media: [{ 'track-count': 9, tracks: [] }] }
  ];
  const pick = pickBestRelease(multi, 3);
  check('挑出正规专辑', pick && pick.release.id === 'b', pick && pick.release.id);
  check('轨数不符的被排除', pickBestRelease([multi[2]], 3) === null);

  /* ---------- 5. 骨架 ---------- */
  console.log('# 5. 骨架：匹配全失败时仍给出可播放/可编辑的结构');
  const sk = emptySkeleton(TOC3);
  check('轨数与 TOC 一致', sk.tracks.length === 3, sk.tracks.length);
  check('标题兜底为「轨道 N」', sk.tracks[0].title === '轨道 1', sk.tracks[0].title);
  check('source = unknown', sk.source === 'unknown', sk.source);
  check('时长沿用 TOC', sk.tracks[0].durationSec === 301, sk.tracks[0].durationSec);

  /* ---------- 6. 合并语义 ---------- */
  console.log('# 6. 合并：后到的源只补空缺，不覆盖已有值');
  const target = emptySkeleton(TOC3);
  target.sources = [];
  mergeInto(target, { album: 'A', artist: 'AA', year: 2001 }, 'src1');
  mergeInto(target, { album: 'B', artist: 'BB', year: 2099 }, 'src2');
  check('专辑名不被覆盖', target.album === 'A', target.album);
  check('歌手不被覆盖', target.artist === 'AA', target.artist);
  check('年份不被覆盖', target.year === 2001, target.year);
  check('来源已累计', target.sources.join(',') === 'src1,src2', target.sources.join(','));
  mergeInto(target, { album: 'C', coverUrl: 'http://x/c.jpg' }, 'src3');
  check('空缺字段照常补上', target.coverUrl === 'http://x/c.jpg', target.coverUrl);
  check('重复来源不重复记录', (() => { mergeInto(target, { album: 'D' }, 'src3'); return target.sources.filter(s => s === 'src3').length; })() === 1);

  /* ---------- 7. 曲目套用 ---------- */
  console.log('# 7. 曲目套用：轨数一致时按轨号对应，时长以物理 TOC 为准');
  const t7 = emptySkeleton(TOC3);
  // 注意：applyTracks 消费的是**规范化后**的曲目（含 artist 字段），
  // 而非 MB 原始 track 对象（那是 normalizeRelease 的职责，见第 2 节）
  const normTracks = MB_REL.media[0].tracks.map((t) => ({
    number: t.position, title: t.title, artist: t['artist-credit'][0].name, durationSec: t.length / 1000
  }));
  applyTracks(t7, normTracks, TOC3.tracks);
  check('曲名已替换', t7.tracks[0].title === 'Smells Like Teen Spirit', t7.tracks[0].title);
  check('时长仍为 TOC 值', t7.tracks[0].durationSec === 301, t7.tracks[0].durationSec);
  check('歌手已带上', t7.tracks[0].artist === 'Nirvana', t7.tracks[0].artist);

  /* ---------- 8. 按时长对应（轨数不一致） ---------- */
  console.log('# 8. 轨数不一致时按时长就近对应，命中率不足则整体放弃改名');
  const t8 = emptySkeleton(TOC3);
  // 源多一轨，且顺序被打乱
  const shuffled = [
    { number: 1, title: '第三首(错位)', durationSec: 219 },
    { number: 2, title: '第一首(错位)', durationSec: 301 },
    { number: 3, title: '第二首(错位)', durationSec: 175 },
    { number: 4, title: 'Bonus', durationSec: 999 }
  ];
  const ok8 = applyTracksByDuration(t8, shuffled, TOC3.tracks, 6);
  check('命中率足够 → 采纳', ok8 === true, ok8);
  check('轨1 按时长匹配到 301s 的曲目', t8.tracks[0].title === '第一首(错位)', t8.tracks[0].title);
  check('轨3 按时长匹配到 219s 的曲目', t8.tracks[2].title === '第三首(错位)', t8.tracks[2].title);
  check('Bonus（999s）未被误贴', t8.tracks.every(t => t.title.indexOf('Bonus') < 0));

  const t8b = emptySkeleton(TOC3);
  const allWrong = [
    { number: 1, title: 'W1', durationSec: 10 },
    { number: 2, title: 'W2', durationSec: 20 },
    { number: 3, title: 'W3', durationSec: 30 }
  ];
  const ok8b = applyTracksByDuration(t8b, allWrong, TOC3.tracks, 6);
  check('命中率不足 → 拒绝改名', ok8b === false, ok8b);
  check('标题保持「轨道 N」（未被污染）', t8b.tracks[0].title === '轨道 1', t8b.tracks[0].title);

  /* ---------- 9. 白名单重建必须透传封面 Buffer ---------- */
  console.log('# 9. ★ 封面 Buffer 必须穿过 validateMetadata（旧实现丢在这里 → 封面永远存不下）');
  const covBuf = Buffer.alloc(2048, 7);
  const vm9 = validateMetadata({
    album: 'X', artist: 'Y', tracks: [],
    coverBuffer: covBuf
  });
  check('coverBuffer 原样带出', Buffer.isBuffer(vm9.coverBuffer) && vm9.coverBuffer.length === 2048,
    vm9.coverBuffer && vm9.coverBuffer.length);
  const vm9b = validateMetadata({ album: 'X', tracks: [], coverBuffer: Buffer.alloc(0) });
  check('空 Buffer 不带出（避免写空文件）', vm9b.coverBuffer === undefined, vm9b.coverBuffer);
  const vm9c = validateMetadata({ album: 'X', tracks: [], coverBuffer: null });
  check('null 不带出', vm9c.coverBuffer === undefined, vm9c.coverBuffer);

  /* ---------- 10. 字段规范化 ---------- */
  console.log('# 10. 规范化：脏数据不进入界面/缓存');
  const vm10 = validateMetadata({
    album: '  带空格的专辑  ',
    artist: 12345,
    year: '1991-09-24',
    genres: ['Grunge', '', null, 'Rock', 'A', 'B', 'C'],
    trackCount: 'abc',
    tracks: [{ number: 2, title: 'b' }, { number: 1, title: 'a' }, { number: 'x', title: 'c' }]
  });
  check('首尾空格已去除', vm10.album === '带空格的专辑', JSON.stringify(vm10.album));
  check('数字型歌手转字符串', vm10.artist === '12345', vm10.artist);
  check('年份从日期截取', vm10.year === 1991, vm10.year);
  check('genres 去空并限量 5', vm10.genres.length === 5, JSON.stringify(vm10.genres));
  check('非法 trackCount 归 0', vm10.trackCount === 0, vm10.trackCount);
  check('曲目按轨号排序', vm10.tracks.map(t => t.number).join(',') === '1,2,3', vm10.tracks.map(t => t.number).join(','));
  check('非法曲目号兜底为下标+1', vm10.tracks[2].number === 3, vm10.tracks[2].number);

  /* ---------- 11. 网易云打分 ---------- */
  console.log('# 11. 网易云候选打分：以「名称 + 艺人」确认身份，轨数只作加分');
  const cands = [
    { id: 1, name: '叶惠美', artist: '周杰伦', trackCount: 11, coverUrl: 'c1', year: 2003 },
    { id: 2, name: '叶惠美 (Live)', artist: '周杰伦', trackCount: 25, coverUrl: 'c2', year: 2013 },
    { id: 3, name: '无关专辑', artist: '某人', trackCount: 3, coverUrl: null, year: 2020 }
  ];
  const p11 = netease.pickAlbum(cands, { album: '叶惠美', artist: '周杰伦', trackCount: 11 });
  check('选中同名同艺人且轨数一致的版本', p11 && p11.candidate.id === 1, p11 && p11.candidate.id);
  check('名称与艺人都不符 → null（宁缺毋滥）',
    netease.pickAlbum([cands[2]], { album: '不同的碟', artist: '别人', trackCount: 99 }) === null);

  /* ---------- 11b. ★ 轨数不同的同专辑仍须命中（真实踩坑回归） ---------- */
  console.log('# 11b. ★ 精选集分卷：轨数 5 vs 网易云 18，名称/艺人吻合必须仍然选中');
  /**
   * 真实案例：用户的 5 轨宇多田光精选集分卷碟，网易云收录的是 18 轨完整版。
   * 旧实现因为 |18-5|=13 重罚 -5 分，导致整个网易云阶段被跳过，
   * 封面、歌词、艺术家全部丢失。这是本次修复的核心回归点。
   */
  const utada = [{ id: 9001, name: 'SINGLE COLLECTION VOL.2', artist: '宇多田ヒカル', trackCount: 18, coverUrl: 'c', year: 2010 }];
  const p11b = netease.pickAlbum(utada, { album: 'Utada Hikaru SINGLE COLLECTION VOL.2', artist: '', trackCount: 5 });
  check('轨数差异大但名称吻合 → 仍被选中', p11b && p11b.candidate.id === 9001, p11b && p11b.candidate.id);
  check('MB 未给艺人时不因缺艺人而落选', p11b !== null, p11b);

  /* ---------- 11c. MB 的 artist-credit 两种形态都要能解析 ---------- */
  console.log('# 11c. ★ artist-credit 的两种形态（顶层 name / 嵌套 artist.name）');
  check('形态A：顶层 name', artistCreditName([{ name: '宇多田ヒカル', joinphrase: '' }]) === '宇多田ヒカル');
  check('形态B：嵌套 artist.name（旧实现读不到 → 艺术家栏空白）',
    artistCreditName([{ artist: { id: 'x', name: '宇多田ヒカル' } }]) === '宇多田ヒカル',
    artistCreditName([{ artist: { id: 'x', name: '宇多田ヒカル' } }]));
  check('joinphrase 拼接正常', artistCreditName([{ name: 'A', joinphrase: ' feat. ' }, { name: 'B' }]) === 'A feat. B');
  check('空/非法输入返回空串', artistCreditName(null) === '' && artistCreditName('x') === '');

  /* ---------- 12. 时长吻合度 ---------- */
  console.log('# 12. 时长吻合度：用于防止"轨数相同其实是另一张碟"');
  const ratioFull = netease.durationMatchRatio(
    [{ durationSec: 301 }, { durationSec: 175 }],
    [{ durationSec: 301 }, { durationSec: 176 }]
  );
  check('容差内视为吻合', ratioFull === 1, ratioFull);
  const ratioNone = netease.durationMatchRatio(
    [{ durationSec: 10 }, { durationSec: 20 }],
    [{ durationSec: 301 }, { durationSec: 175 }]
  );
  check('差得远 → 0', ratioNone === 0, ratioNone);
  check('空输入不炸', netease.durationMatchRatio([], []) === 0);

  /* ---------- 13. 端到端：MB 命中 + 网易云补封面 + hint 纠错 ---------- */
  console.log('# 13. 端到端（全部打桩）：MB 命中 → 网易云补封面 → Buffer 存活到出口');
  reset();
  routes.set('https://musicbrainz.org/ws/2/discid/', () => ({ releases: [MB_REL] }));
  routes.set('https://music.163.com/api/search/get/web', () => ({
    result: { albums: [{ id: 101, name: 'Nevermind', artists: [{ name: 'Nirvana' }], size: 3, publishTime: 685123200000, picUrl: 'https://p1.music.126.net/x.jpg' }] }
  }));
  routes.set('https://music.163.com/api/v1/album/', () => ({
    code: 200,
    album: { id: 101, name: 'Nevermind', artists: [{ name: 'Nirvana' }], publishTime: 685123200000, picUrl: 'https://p1.music.126.net/x.jpg' },
    songs: [
      { id: 9001, no: 1, name: 'Smells Like Teen Spirit', ar: [{ name: 'Nirvana' }], dt: 301000 },
      { id: 9002, no: 2, name: 'In Bloom', ar: [{ name: 'Nirvana' }], dt: 175000 },
      { id: 9003, no: 3, name: 'Come as You Are', ar: [{ name: 'Nirvana' }], dt: 219000 }
    ]
  }));
  routes.set('https://music.163.com/api/song/lyric', () => ({
    lrc: { lyric: '[00:01.00]Load up on guns\n[00:05.00]Bring your friends' },
    tlyric: { lyric: '' }
  }));
  routes.set('https://p1.music.126.net/', () => ({ __buffer: true, body: Buffer.alloc(4096, 3), contentType: 'image/jpeg' }));

  const e2e = await fetchDiscMetadata(TOC3, {});
  check('专辑名来自 MB', e2e.album === 'Nevermind', e2e.album);
  check('歌手正确', e2e.artist === 'Nirvana', e2e.artist);
  check('封面 Buffer 存活到出口', Buffer.isBuffer(e2e.coverBuffer) && e2e.coverBuffer.length === 4096,
    e2e.coverBuffer && e2e.coverBuffer.length);
  check('曲目名已填', e2e.tracks[0].title === 'Smells Like Teen Spirit', e2e.tracks[0].title);
  check('歌词已挂上', !!e2e.tracks[0].lyrics, !!e2e.tracks[0].lyrics);
  check('歌词标记为同步 LRC', e2e.tracks[0].lyricsSynced === true, e2e.tracks[0].lyricsSynced);
  check('来源记录了 MB 与网易云', e2e.sources.indexOf('musicbrainz') >= 0 && e2e.sources.indexOf('netease') >= 0,
    JSON.stringify(e2e.sources));
  check('未走 CAA（网易云封面优先且已成功）',
    !httpCalls.some(c => c.url.indexOf('coverartarchive.org') === 0),
    httpCalls.map(c => c.url.split('/')[2]).join(','));

  /* ---------- 14. MB 认错碟时 hint 纠错 ---------- */
  console.log('# 14. ★ MB 认错碟 → hint 交叉校验丢弃它，改用网易云');
  reset();
  const WRONG = {
    id: 'wrong', title: '不相关的专辑', date: '2007', status: 'Official',
    'release-group': { 'primary-type': 'Album' },
    'artist-credit': [{ name: '某外国歌手' }],
    media: [{ 'track-count': 3, tracks: [
      { position: 1, title: 'X1', length: 100000 },
      { position: 2, title: 'X2', length: 100000 },
      { position: 3, title: 'X3', length: 100000 }
    ] }]
  };
  routes.set('https://musicbrainz.org/ws/2/discid/', () => ({ releases: [WRONG] }));
  routes.set('https://music.163.com/api/search/get/web', () => ({
    result: { albums: [{ id: 202, name: '叶惠美', artists: [{ name: '周杰伦' }], size: 3, publishTime: 1057161600000, picUrl: 'https://p1.music.126.net/y.jpg' }] }
  }));
  routes.set('https://music.163.com/api/v1/album/', () => ({
    code: 200,
    album: { id: 202, name: '叶惠美', artists: [{ name: '周杰伦' }], publishTime: 1057161600000, picUrl: 'https://p1.music.126.net/y.jpg' },
    songs: [
      { id: 1, no: 1, name: '以父之名', ar: [{ name: '周杰伦' }], dt: 301000 },
      { id: 2, no: 2, name: '懦夫', ar: [{ name: '周杰伦' }], dt: 175000 },
      { id: 3, no: 3, name: '晴天', ar: [{ name: '周杰伦' }], dt: 219000 }
    ]
  }));
  routes.set('https://p1.music.126.net/', () => ({ __buffer: true, body: Buffer.alloc(2048, 5), contentType: 'image/jpeg' }));

  const e14 = await fetchDiscMetadata(TOC3, { hint: { album: '叶惠美', artist: '周杰伦' } });
  check('错误 MB 结果已被丢弃', e14.album === '叶惠美', e14.album);
  check('歌手来自网易云', e14.artist === '周杰伦', e14.artist);
  check('年份正确', e14.year === 2003, e14.year);
  check('来源不含 musicbrainz', e14.sources.indexOf('musicbrainz') < 0, JSON.stringify(e14.sources));
  check('曲目名来自网易云', e14.tracks[0].title === '以父之名', e14.tracks[0].title);

  /* ---------- 15. 全部源都失败 ---------- */
  console.log('# 15. 所有源都不可达 → 必须优雅降级为骨架，绝不抛错');
  reset();
  routes.set('https://musicbrainz.org/ws/2/discid/', () => { throw new Error('connect ECONNREFUSED'); });
  routes.set('https://music.163.com/', () => { throw new Error('timeout'); });
  routes.set('https://itunes.apple.com/', () => { throw new Error('timeout'); });
  const e15 = await fetchDiscMetadata(TOC3, {});
  check('未抛错且返回对象', e15 && typeof e15 === 'object');
  check('降级为骨架', e15.source === 'unknown', e15.source);
  check('仍保留 3 条可编辑曲目', e15.tracks.length === 3, e15.tracks.length);
  check('标题为「轨道 N」', e15.tracks[0].title === '轨道 1', e15.tracks[0].title);

  /* ---------- 16. 文本检索兜底 ---------- */
  console.log('# 16. MusicBrainz 文本检索兜底（无 TOC 匹配时按名称再试）');
  reset();
  routes.set('https://musicbrainz.org/ws/2/release/', () => ({
    releases: [{ id: 'r-search', title: '叶惠美', date: '2003-07-31', 'track-count': 11, 'artist-credit': [{ name: '周杰伦' }], 'release-group': { id: 'rg-s' } }]
  }));
  const r16 = await searchRelease('叶惠美', '周杰伦');
  check('检索结果已归一化', r16 && r16.album === '叶惠美', r16 && r16.album);
  check('来源标记为检索', r16 && r16.source === 'musicbrainz-search', r16 && r16.source);
  check('无曲目（检索接口不含 track 详情）', r16 && r16.tracks.length === 0, r16 && r16.tracks.length);

  /* ---------- 17. ★ 端到端回归：精选集分卷（轨数差 13）仍要拿到封面+歌词+艺人 ---------- */
  console.log('# 17. ★ 真实案例回归：MB 命中 5 轨分卷碟，网易云是 18 轨完整版');
  reset();
  // MB 返回罗马字专辑名、artist-credit 为"嵌套形态"（旧实现解析为空）
  const MB_UTADA = {
    id: 'rel-utada', title: 'Utada Hikaru SINGLE COLLECTION VOL.2', date: '2010-11-24',
    status: 'Official',
    'release-group': { 'primary-type': 'Album' },
    'artist-credit': [{ artist: { id: 'a1', name: '宇多田ヒカル' } }],   // ← 嵌套形态
    media: [{ 'track-count': 5, tracks: [
      { position: 1, title: '誰の女神', length: 256300 },
      { position: 2, title: 'Show Me Love (Not A Dream)', length: 257700 },
      { position: 3, title: 'Goodbye Happiness', length: 321300 },
      { position: 4, title: 'Hymne à l\'amour ～愛のアンセム～', length: 389900 },
      { position: 5, title: 'Can\'t Wait \'til Christmas', length: 224200 }
    ] }]
  };
  const TOC5 = {
    first: 1, last: 5, leadout: 115000,
    tracks: [
      { number: 1, startFrame: 150, endFrame: 19370, durationSec: 256.3 },
      { number: 2, startFrame: 19370, endFrame: 38699, durationSec: 257.7 },
      { number: 3, startFrame: 38699, endFrame: 62797, durationSec: 321.3 },
      { number: 4, startFrame: 62797, endFrame: 92043, durationSec: 389.9 },
      { number: 5, startFrame: 92043, endFrame: 115000, durationSec: 224.2 }
    ]
  };
  routes.set('https://musicbrainz.org/ws/2/discid/', () => ({ releases: [MB_UTADA] }));
  routes.set('https://music.163.com/api/search/get/web', () => ({
    result: { albums: [
      { id: 5001, name: 'SINGLE COLLECTION VOL.2', artists: [{ name: '宇多田ヒカル' }], size: 18, publishTime: 1290528000000, picUrl: 'https://p2.music.126.net/u.jpg' },
      { id: 5002, name: 'Utada Hikaru SINGLE COLLECTION VOL.1', artists: [{ name: '宇多田ヒカル' }], size: 15, publishTime: 1100000000000, picUrl: 'https://p2.music.126.net/v.jpg' }
    ] }
  }));
  routes.set('https://music.163.com/api/v1/album/', () => ({
    code: 200,
    album: { id: 5001, name: 'SINGLE COLLECTION VOL.2', artists: [{ name: '宇多田ヒカル' }], publishTime: 1290528000000, picUrl: 'https://p2.music.126.net/u.jpg' },
    songs: Array.from({ length: 18 }, (_, i) => ({
      id: 6000 + i, no: i + 1, name: 'NE_' + (i + 1), ar: [{ name: '宇多田ヒカル' }], dt: 200000
    }))
  }));
  routes.set('https://music.163.com/api/song/lyric', () => ({
    lrc: { lyric: '[00:01.00]誰の女神\n[00:05.00]second line' }, tlyric: { lyric: '' }
  }));
  routes.set('https://p2.music.126.net/', () => ({ __buffer: true, body: Buffer.alloc(24162, 6), contentType: 'image/jpeg' }));

  const e17 = await fetchDiscMetadata(TOC5, {});
  check('专辑名来自 MB', e17.album === 'Utada Hikaru SINGLE COLLECTION VOL.2', e17.album);
  check('★ 艺术家已被填上（嵌套 artist-credit 解析成功）', e17.artist === '宇多田ヒカル', JSON.stringify(e17.artist));
  check('★ 封面已拿到（网易云 18 轨版也能供图）',
    Buffer.isBuffer(e17.coverBuffer) && e17.coverBuffer.length === 24162,
    e17.coverBuffer && e17.coverBuffer.length);
  check('★ 歌词已拿到', !!e17.tracks[0].lyrics && e17.tracks[0].lyricsSynced === true,
    e17.tracks[0] && e17.tracks[0].lyricsSynced);
  check('★ 曲目名保留 MB 的正确值（未被 18 轨版错位覆盖）',
    e17.tracks[0].title === '誰の女神', e17.tracks[0].title);
  check('网易云已被记入来源', e17.sources.indexOf('netease') >= 0, JSON.stringify(e17.sources));

  /* =========================================================
   * 18. ★★ 多碟专辑：碟号抽取与切分（本次修复的核心）
   * ========================================================= */
  console.log('# 18. 多碟专辑：网易云 cd 字段抽取 → 按碟切分 → 不再串味');
  reset();

  // 模拟网易云：一张 2 碟专辑，各碟轨号都是 1..5，靠 cd 区分
  const NE_MULTI = {
    code: 200,
    album: { id: 7001, name: '双碟精选', artists: [{ name: '某歌手' }], publishTime: 1300000000000, picUrl: 'https://p2.music.126.net/m.jpg' },
    songs: [
      // disc1
      { id: 101, no: 1, cd: 1, name: 'D1-T1', ar: [{ name: '某歌手' }], dt: 200000 },
      { id: 102, no: 2, cd: 1, name: 'D1-T2', ar: [{ name: '某歌手' }], dt: 210000 },
      { id: 103, no: 3, cd: 1, name: 'D1-T3', ar: [{ name: '某歌手' }], dt: 220000 },
      { id: 104, no: 4, cd: 1, name: 'D1-T4', ar: [{ name: '某歌手' }], dt: 230000 },
      { id: 105, no: 5, cd: 1, name: 'D1-T5', ar: [{ name: '某歌手' }], dt: 240000 },
      // disc2 —— 轨号同样是 1..5，只有 cd 不同
      { id: 201, no: 1, cd: 2, name: 'D2-T1', ar: [{ name: '某歌手' }], dt: 300000 },
      { id: 202, no: 2, cd: 2, name: 'D2-T2', ar: [{ name: '某歌手' }], dt: 310000 },
      { id: 203, no: 3, cd: 2, name: 'D2-T3', ar: [{ name: '某歌手' }], dt: 320000 },
      { id: 204, no: 4, cd: 2, name: 'D2-T4', ar: [{ name: '某歌手' }], dt: 330000 },
      { id: 205, no: 5, cd: 2, name: 'D2-T5', ar: [{ name: '某歌手' }], dt: 340000 }
    ]
  };
  routes.set('https://music.163.com/api/v1/album/', () => NE_MULTI);

  const neMulti = await netease.getAlbum(7001);
  check('网易云解析出碟号（cd 字段）', neMulti.tracks[0].discNumber === 1 && neMulti.tracks[5].discNumber === 2,
    JSON.stringify(neMulti.tracks.map((t) => t.discNumber)));
  check('碟总数 = 2', neMulti.discTotal === 2, neMulti.discTotal);
  check('每碟轨号都从 1 开始（碟内轨号）', neMulti.tracks[0].number === 1 && neMulti.tracks[5].number === 1,
    JSON.stringify(neMulti.tracks.map((t) => t.number)));

  const g = netease.groupByDisc(neMulti.tracks);
  check('groupByDisc 切成 2 组', g.size === 2, g.size);
  check('disc1 组有 5 首', g.get(1).length === 5, g.get(1) && g.get(1).length);
  check('disc2 组首曲为 D2-T1', g.get(2)[0].title === 'D2-T1', g.get(2)[0].title);

  const d1 = netease.tracksOfDisc(neMulti.tracks, 1);
  const d2 = netease.tracksOfDisc(neMulti.tracks, 2);
  check('tracksOfDisc(1) 只含 disc1', d1.length === 5 && d1.every((t) => t.title.indexOf('D1-') === 0),
    JSON.stringify(d1.map((t) => t.title)));
  check('tracksOfDisc(2) 只含 disc2', d2.length === 5 && d2.every((t) => t.title.indexOf('D2-') === 0),
    JSON.stringify(d2.map((t) => t.title)));

  /* ---------- 19. filterTracksByDisc：无碟号信息时原样返回 ---------- */
  console.log('# 19. filterTracksByDisc：单碟源不带碟号时不应被过滤掉');
  const singleSrc = [{ number: 1, title: 'A' }, { number: 2, title: 'B' }];
  check('源未标碟号 → 原样返回', filterTracksByDisc(singleSrc, 2).length === 2, filterTracksByDisc(singleSrc, 2).length);
  check('源已标碟号 → 按碟取子集', filterTracksByDisc(neMulti.tracks, 2).length === 5);
  check('info: 未标碟号 tagged=false', discInfoOf(singleSrc, null).tagged === false);
  check('info: 已标碟号 tagged=true / total=2',
    discInfoOf(neMulti.tracks, 2).tagged === true && discInfoOf(neMulti.tracks, 2).discTotal === 2);

  /* ---------- 20. inferDiscNumber：碟号来源优先级 ---------- */
  console.log('# 20. inferDiscNumber：hint > cache > 默认 1');
  check('hint 优先', inferDiscNumber({ hint: { discNumber: 2 }, cachedDiscNumber: 1 }).discNumber === 2);
  check('无 hint 用缓存', inferDiscNumber({ cachedDiscNumber: 3 }).discNumber === 3);
  check('都没有 → 默认 1', inferDiscNumber({}).discNumber === 1);
  check('非法 hint 被忽略', inferDiscNumber({ hint: { discNumber: 'x' } }).discNumber === 1);

  /* =========================================================
   * 21. ★★★ 端到端回归：先 disc2 后 disc1，绝不能串味
   *    这是用户实际遇到的 bug 场景（disc1 前五首歌词 == disc2）
   * ========================================================= */
  console.log('# 21. ★ 端到端：多碟专辑放进 disc1，曲目与歌词必须是 disc1 的');
  reset();
  routes.set('https://music.163.com/api/search/get/web', () => ({
    result: { albums: [
      { id: 7001, name: '双碟精选', artists: [{ name: '某歌手' }], size: 10, publishTime: 1300000000000, picUrl: 'https://p2.music.126.net/m.jpg' }
    ] }
  }));
  routes.set('https://music.163.com/api/v1/album/', () => NE_MULTI);
  // 歌词接口：按 songId 返回专属内容，能一眼看出有没有串碟
  routes.set('https://music.163.com/api/song/lyric', (url) => {
    const m = /id=(\d+)/.exec(url);
    const id = m ? Number(m[1]) : 0;
    return { lrc: { lyric: '[00:01.00]LYRIC-' + id + '\n[00:05.00]x' }, tlyric: { lyric: '' } };
  });
  routes.set('https://p2.music.126.net/', () => ({ __buffer: true, body: Buffer.alloc(30000, 3), contentType: 'image/jpeg' }));
  // MB 不可达（华语碟常见）
  routes.set('https://musicbrainz.org/ws/2/discid/', () => { throw new Error('MB down'); });

  // disc1：5 轨，时长与网易云 disc1 完全一致（200~240s）
  const TOC_D1 = {
    first: 1, last: 5, leadout: 100000,
    tracks: [
      { number: 1, startFrame: 150, endFrame: 15150, durationSec: 200 },
      { number: 2, startFrame: 15150, endFrame: 30900, durationSec: 210 },
      { number: 3, startFrame: 30900, endFrame: 47400, durationSec: 220 },
      { number: 4, startFrame: 47400, endFrame: 64650, durationSec: 230 },
      { number: 5, startFrame: 64650, endFrame: 82650, durationSec: 240 }
    ]
  };
  const eDisc1 = await fetchDiscMetadata(TOC_D1, { hint: { album: '双碟精选', artist: '某歌手', discNumber: 1 } });
  check('★ 曲目名全部来自 disc1（不再是 disc2）',
    eDisc1.tracks.map((t) => t.title).join(',') === 'D1-T1,D1-T2,D1-T3,D1-T4,D1-T5',
    JSON.stringify(eDisc1.tracks.map((t) => t.title)));
  check('★ 歌词是 disc1 的 songId（不是 disc2 的 201~205）',
    eDisc1.tracks[0].lyrics.indexOf('LYRIC-101') >= 0 && eDisc1.tracks[0].lyrics.indexOf('LYRIC-201') < 0,
    eDisc1.tracks[0].lyrics);
  check('★ 每轨都拿到了 disc1 自己的歌词',
    eDisc1.tracks.every((t, i) => t.lyrics && t.lyrics.indexOf('LYRIC-' + (101 + i)) >= 0),
    JSON.stringify(eDisc1.tracks.map((t) => t.lyrics && t.lyrics.slice(0, 22))));
  check('碟号已写入出口元数据', eDisc1.discNumber === 1, eDisc1.discNumber);
  check('碟总数已写入出口元数据', eDisc1.discTotal === 2, eDisc1.discTotal);

  /* ---------- 22. ★ 同一张专辑放进 disc2：同样要对上 disc2 ---------- */
  console.log('# 22. ★ 端到端：同一专辑放进 disc2，曲目与歌词必须是 disc2 的');
  reset();
  routes.set('https://music.163.com/api/search/get/web', () => ({
    result: { albums: [
      { id: 7001, name: '双碟精选', artists: [{ name: '某歌手' }], size: 10, publishTime: 1300000000000, picUrl: 'https://p2.music.126.net/m.jpg' }
    ] }
  }));
  routes.set('https://music.163.com/api/v1/album/', () => NE_MULTI);
  routes.set('https://music.163.com/api/song/lyric', (url) => {
    const m = /id=(\d+)/.exec(url);
    const id = m ? Number(m[1]) : 0;
    return { lrc: { lyric: '[00:01.00]LYRIC-' + id }, tlyric: { lyric: '' } };
  });
  routes.set('https://p2.music.126.net/', () => ({ __buffer: true, body: Buffer.alloc(30000, 4), contentType: 'image/jpeg' }));
  routes.set('https://musicbrainz.org/ws/2/discid/', () => { throw new Error('MB down'); });

  // disc2：5 轨，时长与网易云 disc2 一致（300~340s）
  const TOC_D2 = {
    first: 1, last: 5, leadout: 130000,
    tracks: [
      { number: 1, startFrame: 150, endFrame: 22650, durationSec: 300 },
      { number: 2, startFrame: 22650, endFrame: 45900, durationSec: 310 },
      { number: 3, startFrame: 45900, endFrame: 69900, durationSec: 320 },
      { number: 4, startFrame: 69900, endFrame: 94650, durationSec: 330 },
      { number: 5, startFrame: 94650, endFrame: 120150, durationSec: 340 }
    ]
  };
  const eDisc2 = await fetchDiscMetadata(TOC_D2, { hint: { album: '双碟精选', artist: '某歌手', discNumber: 2 } });
  check('★ 曲目名全部来自 disc2',
    eDisc2.tracks.map((t) => t.title).join(',') === 'D2-T1,D2-T2,D2-T3,D2-T4,D2-T5',
    JSON.stringify(eDisc2.tracks.map((t) => t.title)));
  check('★ 歌词是 disc2 的 songId',
    eDisc2.tracks[0].lyrics.indexOf('LYRIC-201') >= 0 && eDisc2.tracks[0].lyrics.indexOf('LYRIC-101') < 0,
    eDisc2.tracks[0].lyrics);
  check('碟号为 2', eDisc2.discNumber === 2, eDisc2.discNumber);

  /* ---------- 23. ★ 不看碟号的旧行为对照：证明 bug 确实被修掉 ---------- */
  console.log('# 23. 对照：无碟号时若整表按轨号匹配就会串味（说明碟号过滤是必需的）');
  reset();
  // 直接演示错误路径：把整张 multi 表（含 disc2）丢给 applyTracks，
  // 由于 disc2 的轨号 1..5 在 Map 里覆盖了 disc1，结果会全是 disc2 —— 即旧 bug
  const naiveTarget = emptySkeleton(TOC_D1);
  const naiveMap = new Map();
  for (const t of neMulti.tracks) naiveMap.set(t.number, t);   // 后写的 disc2 覆盖 disc1
  applyTracks(naiveTarget, neMulti.tracks, TOC_D1.tracks);
  check('对照：不切碟 → 前五首被 disc2 覆盖（复现原 bug）',
    naiveTarget.tracks[0].title === 'D2-T1', naiveTarget.tracks[0].title);
  // 正确路径：先切碟
  const fixedTarget = emptySkeleton(TOC_D1);
  applyTracks(fixedTarget, filterTracksByDisc(neMulti.tracks, 1), TOC_D1.tracks);
  check('修好后：先切碟 → 全部为 disc1',
    fixedTarget.tracks[0].title === 'D1-T1' && fixedTarget.tracks[4].title === 'D1-T5',
    JSON.stringify(fixedTarget.tracks.map((t) => t.title)));

  /* ---------- 24. ★ MusicBrainz 多碟发行：medium.position 作为碟号 ---------- */
  console.log('# 24. ★ MusicBrainz 多碟发行：按 medium.position 取对应碟');
  const MB_MULTI = {
    id: 'rel-multi', title: 'Two Disc Set', date: '2001-01-01', status: 'Official',
    'release-group': { 'primary-type': 'Album' },
    'artist-credit': [{ name: 'Artist X' }],
    media: [
      { position: 1, 'track-count': 3, tracks: [
        { position: 1, title: 'M1-T1', length: 200000 },
        { position: 2, title: 'M1-T2', length: 210000 },
        { position: 3, title: 'M1-T3', length: 220000 }
      ] },
      { position: 2, 'track-count': 3, tracks: [
        { position: 1, title: 'M2-T1', length: 300000 },
        { position: 2, title: 'M2-T2', length: 310000 },
        { position: 3, title: 'M2-T3', length: 320000 }
      ] }
    ]
  };
  reset();
  routes.set('https://musicbrainz.org/ws/2/discid/', () => ({ releases: [MB_MULTI], 'disc-id': 'abc' }));
  const TOC_MB3 = {
    first: 1, last: 3, leadout: 60000,
    tracks: [
      { number: 1, startFrame: 150, endFrame: 4500, durationSec: 58 },
      { number: 2, startFrame: 4500, endFrame: 9000, durationSec: 60 },
      { number: 3, startFrame: 9000, endFrame: 13500, durationSec: 60 }
    ]
  };
  const pickNoHint = pickBestRelease([MB_MULTI], 3);
  check('无碟号提示时 pickBestRelease 返回 mediums 列表', Array.isArray(pickNoHint.mediums) && pickNoHint.mediums.length === 2,
    pickNoHint.mediums && pickNoHint.mediums.length);
  const mb2 = await lookupByToc(TOC_MB3, { discHint: 2 });
  check('★ discHint=2 → 取到第 2 张碟的曲目', mb2.tracks[0].title === 'M2-T1', mb2.tracks[0].title);
  check('★ 碟号 = 2', mb2.discNumber === 2, mb2.discNumber);
  check('★ 碟总数 = 2', mb2.discTotal === 2, mb2.discTotal);
  const mb1 = await lookupByToc(TOC_MB3, { discHint: 1 });
  check('discHint=1 → 取到第 1 张碟的曲目', mb1.tracks[0].title === 'M1-T1', mb1.tracks[0].title);

  /* ---------- 25. 缓存碟号参与推断（用户改过的最权威） ---------- */
  console.log('# 25. 缓存碟号参与推断：重抓时不应退回 disc1');
  reset();
  routes.set('https://music.163.com/api/search/get/web', () => ({
    result: { albums: [
      { id: 7001, name: '双碟精选', artists: [{ name: '某歌手' }], size: 10, publishTime: 1300000000000, picUrl: 'https://p2.music.126.net/m.jpg' }
    ] }
  }));
  routes.set('https://music.163.com/api/v1/album/', () => NE_MULTI);
  routes.set('https://music.163.com/api/song/lyric', (url) => {
    const m = /id=(\d+)/.exec(url);
    return { lrc: { lyric: '[00:01.00]LYRIC-' + (m ? m[1] : '0') }, tlyric: { lyric: '' } };
  });
  routes.set('https://p2.music.126.net/', () => ({ __buffer: true, body: Buffer.alloc(30000, 5), contentType: 'image/jpeg' }));
  routes.set('https://musicbrainz.org/ws/2/discid/', () => { throw new Error('MB down'); });
  // 有专辑关键词（否则不会去搜网易云），但没有 hint.discNumber，
  // 碟号只来自缓存 → 用来验证"缓存碟号参与推断"这条链路
  const eCached = await fetchDiscMetadata(TOC_D2, { hint: { album: '双碟精选', artist: '某歌手' }, cachedDiscNumber: 2 });
  check('★ 无 hint 碟号时用缓存碟号 → 对上 disc2',
    eCached.tracks[0].title === 'D2-T1', eCached.tracks[0].title);
  check('出口碟号为 2', eCached.discNumber === 2, eCached.discNumber);

  /* ---------- 26. schema：碟号规范化与持久化 ---------- */
  console.log('# 26. schema：碟号字段规范化（非法值兜底、默认 1）');
  const vmDisc = validateMetadata({ album: 'X', discNumber: 2, discTotal: 3, tracks: [{ number: 1, discNumber: 2, title: 'T' }] });
  check('discNumber 保留', vmDisc.discNumber === 2, vmDisc.discNumber);
  check('discTotal 保留', vmDisc.discTotal === 3, vmDisc.discTotal);
  check('轨级 discNumber 保留', vmDisc.tracks[0].discNumber === 2, vmDisc.tracks[0].discNumber);
  const vmDiscDef = validateMetadata({ album: 'Y' });
  check('缺省 discNumber → 1', vmDiscDef.discNumber === 1, vmDiscDef.discNumber);
  check('缺省 discTotal → null', vmDiscDef.discTotal === null, vmDiscDef.discTotal);
  const vmDiscBad = validateMetadata({ discNumber: 'x', discTotal: -3 });
  check('非法碟号 → 1 / null', vmDiscBad.discNumber === 1 && vmDiscBad.discTotal === null,
    vmDiscBad.discNumber + '/' + vmDiscBad.discTotal);

  Module._load = origLoad;
  console.log(fails ? `\n${fails} 项未通过` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
