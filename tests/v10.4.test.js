'use strict';
/*
 * tests/v10.4.test.js —— v10.4 八项新需求的自检（纯逻辑 + 源码契约，零网络）。
 *
 * 覆盖：
 *   A. schema 白名单：albumIntro / artistIntro / lyricsFilledAt 透传与截断
 *   B. fetchLyricsOnly：缓存补抓只补缺歌词的轨、按本碟碟号建映射、
 *      无关键词不联网、已有歌词不被覆盖
 *   C. CdService._fillLyricsBackground：落盘 + 推 lyricsFilled 事件 +
 *      并发去重 + 换碟竞态作废
 *   D. 前端契约（读源码）：
 *      - 音乐库点击专辑 → Album.open（原版网格与 CoverFlow 统一）
 *      - CoverFlow transform 驱动（.lib-flow-row / flow-dragging / 播放按钮 / 顶部大名）
 *      - 点歌换碟续播（requestDiscTrack + needDisc.track + onMetadata 落地播放）
 *      - 歌词自动应用（onMetadata 对非缓存数据 force）
 *      - 退碟清空播放界面（onPhase idle/eject → NowPlaying.reset + 清 state）
 *      - Esc 一镜到底关闭专辑页 / resize 重排 CoverFlow
 *      - cover 协议 CORS 头（专辑页取色的前提）
 *
 * 运行：node tests/v10.4.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n---- ' + name + ' ----'); }

/* ================================================================
 * A. schema 白名单
 * ================================================================ */
section('A. schema：专辑/歌手介绍与歌词补抓时间戳');

{
  const { validateMetadata } = require(path.join(ROOT, 'main', 'metadata', 'schema.js'));

  const m = validateMetadata({
    signature: 'sig-a',
    album: '专辑',
    artist: '歌手',
    albumIntro: '这是一段专辑介绍',
    artistIntro: '这是一段歌手介绍',
    lyricsFilledAt: '2026-10-19T00:00:00.000Z',
    tracks: [{ number: 1, title: '歌' }]
  });
  ok(m.albumIntro === '这是一段专辑介绍', 'albumIntro 透传', m.albumIntro);
  ok(m.artistIntro === '这是一段歌手介绍', 'artistIntro 透传', m.artistIntro);
  ok(m.lyricsFilledAt === '2026-10-19T00:00:00.000Z', 'lyricsFilledAt 透传', m.lyricsFilledAt);

  const long = validateMetadata({ signature: 's', albumIntro: '介'.repeat(5000), artistIntro: '绍'.repeat(5000) });
  ok(long.albumIntro.length === 4000, 'albumIntro 截断到 4000 字', long.albumIntro.length);
  ok(long.artistIntro.length === 4000, 'artistIntro 截断到 4000 字', long.artistIntro.length);

  const none = validateMetadata({ signature: 's' });
  ok(none.albumIntro == null, '缺省 albumIntro 为 null（界面据此隐藏介绍区）', none.albumIntro);
  ok(none.artistIntro == null, '缺省 artistIntro 为 null', none.artistIntro);
  ok(none.lyricsFilledAt == null, '缺省 lyricsFilledAt 为 null', none.lyricsFilledAt);
  ok(validateMetadata({ signature: 's', albumIntro: '  ' }).albumIntro == null,
    '纯空白 albumIntro 归一为 null');
}

/* ================================================================
 * B. fetchLyricsOnly（打桩 netease 专辑检索 + 歌词降级链客户端）
 * ================================================================ */
section('B. fetchLyricsOnly：缓存补抓只补缺歌词的轨');

const BASE = path.join(ROOT, 'main', 'metadata');
const YRC = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'netease-yrc-gurenge.json'), 'utf8'));

/** 记录调用的 spy（异步） */
function spy(impl) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return impl ? impl(...args) : null; };
  fn.calls = calls;
  return fn;
}

/** 同步 spy（真实的 pickAlbum / tracksOfDisc 就是同步函数，语义必须一致） */
function spySync(impl) {
  const calls = [];
  const fn = (...args) => { calls.push(args); return impl ? impl(...args) : null; };
  fn.calls = calls;
  return fn;
}

/**
 * 合并假 netease：fetch.js 用专辑检索四件套，lyrics.js 用歌词客户端两件套。
 * 两者是同一个模块实例（真实代码里也是），注入一次两边同时生效。
 */
function makeFakeNetease(albumTracks) {
  return {
    // ---- fetch.js 的专辑检索面 ----
    searchAlbums: spy(async () => [{
      id: 99, name: '测试专辑', artist: '测试歌手', trackCount: albumTracks.length, coverUrl: 'http://x/y.jpg'
    }]),
    pickAlbum: spySync((candidates) => candidates && candidates.length
      ? { candidate: candidates[0], score: 9 } : null),
    getAlbum: spy(async () => ({ id: 99, name: '测试专辑', artist: '测试歌手', tracks: albumTracks })),
    // 简化版按碟切分：cd 字段一致 → 重编号 1..N（与真实实现同语义）
    tracksOfDisc: spySync((tracks, disc) => tracks
      .filter((t) => (Number(t.cd) || 1) === (Number(disc) || 1))
      .map((t, i) => Object.assign({}, t, { number: i + 1 }))),
    groupByDisc: () => new Map(),
    durationMatchRatio: () => 1,
    norm: (s) => String(s || '').toLowerCase().trim(),
    // ---- lyrics.js 的歌词客户端面 ----
    getLyric: spy(async () => ({ yrc: YRC.yrc, lyrics: '', yrcTranslation: YRC.ytlrc, yromalrc: YRC.yromalrc })),
    searchSongs: spy(async () => [])
  };
}

/** 把假模块注入 require.cache，返回 require 到的新实例 */
function inject(name, exports) {
  const p = path.join(BASE, name + '.js');
  delete require.cache[require.resolve(p)];
  require.cache[require.resolve(p)] = {
    id: p, filename: p, loaded: true, exports, children: [], paths: []
  };
  return require(p);
}

function loadFetchWith(fakeNetease) {
  // lyrics.js 的其它客户端：全部失败，强制走网易云 yrc 这一源
  inject('amll', { getLyric: spy(), search: spy(async () => []) });
  inject('netease', fakeNetease);
  inject('qq-music', { getLyric: spy() });
  inject('kugou', { searchSongs: spy(), lyricCandidates: spy(), search: spy(), download: spy() });
  inject('http', {
    getJson: spy(), postJson: spy(), getBuffer: spy(),
    qs: () => '', withTimeout: (p) => p, DEFAULT_UA: 't', BROWSER_UA: 't', MAX_COVER_BYTES: 1
  });
  // ★ lyrics.js 也必须重载：它在加载时捕获了 netease 引用，
  //   不删缓存的话第二轮注入的新假件不会被它看到（B3 踩过这个坑）。
  for (const name of ['lyrics', 'fetch']) {
    const p = path.join(BASE, name + '.js');
    delete require.cache[require.resolve(p)];
  }
  return require(path.join(BASE, 'fetch.js'));
}

(async () => {

  /* ---------- B1：只补缺歌词的轨 ---------- */
  {
    const albumTracks = [
      { number: 1, cd: 1, neteaseSongId: 1001 },
      { number: 2, cd: 1, neteaseSongId: 1002 },
      { number: 3, cd: 1, neteaseSongId: 1003 }
    ];
    const ne = makeFakeNetease(albumTracks);
    const { fetchLyricsOnly } = loadFetchWith(ne);

    const cached = {
      album: '测试专辑', artist: '测试歌手', discNumber: 1,
      tracks: [
        { number: 1, title: '第一首', lyrics: '[00:01.00]用户手写的旧歌词', lyricsSynced: true },
        { number: 2, title: '第二首' },
        { number: 3, title: '第三首' }
      ]
    };
    const r = await fetchLyricsOnly(cached, [
      { number: 1 }, { number: 2 }, { number: 3 }
    ], { log: () => {} });

    ok(r && r.filled === 3, '三轨都拿到歌词（filled 计的是骨架里带歌词的轨数）', r && r.filled);
    const t1 = r.tracks.find((t) => t.number === 1);
    const t2 = r.tracks.find((t) => t.number === 2);
    const t3 = r.tracks.find((t) => t.number === 3);
    ok(t1.lyrics === '[00:01.00]用户手写的旧歌词', '已有歌词的轨原样带回（不被覆盖）', t1.lyrics);
    ok(!!t2.lyricsData && Array.isArray(t2.lyricsData.lines) && t2.lyricsData.lines.length > 0,
      '缺歌词的轨补上结构化逐字模型');
    ok(!!t2.lyrics && t2.lyrics.indexOf('[00:') === 0, '同时生成经典 LRC 兜底文本');
    ok(!!t3.lyricsData, '第三轨同样补上');
    ok(ne.getLyric.calls.length === 2, '只对 2 首缺歌词的轨发起歌词请求（不重抓已有的）', ne.getLyric.calls.length);
    ok(ne.searchAlbums.calls.length === 1, '用缓存专辑名搜了一次网易云', ne.searchAlbums.calls.length);
  }

  /* ---------- B2：无关键词不联网 ---------- */
  {
    const ne = makeFakeNetease([{ number: 1, cd: 1, neteaseSongId: 1 }]);
    const { fetchLyricsOnly } = loadFetchWith(ne);
    const r = await fetchLyricsOnly({ album: '', artist: '', discNumber: 1, tracks: [{ number: 1, title: 'x' }] }, [], {});
    ok(r.filled === 0 && r.tracks === null, '没有专辑名/歌手 → 直接放弃', r);
    ok(ne.searchAlbums.calls.length === 0, '不发任何网易云请求', ne.searchAlbums.calls.length);
  }

  /* ---------- B3：多碟按本碟碟号建映射 ---------- */
  {
    // 网易云把双碟合成一个扁平 songs 数组，cd 字段区分碟号
    const albumTracks = [
      { number: 1, cd: 1, neteaseSongId: 2001 },
      { number: 2, cd: 1, neteaseSongId: 2002 },
      { number: 1, cd: 2, neteaseSongId: 2101 },
      { number: 2, cd: 2, neteaseSongId: 2102 }
    ];
    const ne = makeFakeNetease(albumTracks);
    const { fetchLyricsOnly } = loadFetchWith(ne);
    const r = await fetchLyricsOnly({
      album: '测试专辑', artist: '测试歌手', discNumber: 2,
      tracks: [{ number: 1, title: 'disc2-1' }, { number: 2, title: 'disc2-2' }]
    }, [{ number: 1 }, { number: 2 }], {});
    ok(r.filled === 2, 'disc2 两轨都补到', r.filled);
    // getLyric 的入参就是 songId：必须是 disc2 的 2101/2102，不能串到 disc1 的 2001/2002
    const ids = ne.getLyric.calls.map((c) => c[0]).sort();
    ok(ids[0] === 2101 && ids[1] === 2102, '歌词请求用的是 disc2 的 songId（不串碟）', ids);
  }

  /* ---------- B4：降级链整体异常不炸 ---------- */
  {
    const ne = makeFakeNetease([{ number: 1, cd: 1, neteaseSongId: 1 }]);
    ne.getAlbum = spy(async () => { throw new Error('netease down'); });
    const { fetchLyricsOnly } = loadFetchWith(ne);
    const r = await fetchLyricsOnly({
      album: 'A', artist: 'B', discNumber: 1, tracks: [{ number: 1, title: 'x' }]
    }, [], {});
    ok(r.filled === 0 && r.tracks === null, '选碟失败 → 安静返回空结果（不抛）', r);
  }

  /* ================================================================
   * C. CdService._fillLyricsBackground
   * ================================================================ */
  section('C. CdService._fillLyricsBackground：落盘 / 事件 / 去重 / 竞态');

  /* ---- 注入假 native 与 RawPlayer（真实实现依赖 Windows） ---- */
  const fakeNative = {
    listCdDrives: () => ['D'], openCdDevice: () => 1, closeDevice: () => {},
    readToc: () => ({ first: 1, last: 2, leadout: 40000, tracks: [] }),
    readTocViaMci: () => { throw new Error('no mci'); },
    rawRead: () => Buffer.alloc(4704), trayControl: () => {},
    mciSend: () => ({ code: 0, text: '00:00:00' }), mciError: () => 'fake',
    IOCTL_CDROM_EJECT_MEDIA: 1, IOCTL_CDROM_LOAD_MEDIA: 2, IOCTL_CDROM_CLOSE_DOOR: 3
  };
  const nativeId = require.resolve(path.join(ROOT, 'main', 'native.js'));
  require.cache[nativeId] = new Module(nativeId, null);
  require.cache[nativeId].filename = nativeId;
  require.cache[nativeId].loaded = true;
  require.cache[nativeId].exports = fakeNative;

  const rawId = require.resolve(path.join(ROOT, 'main', 'cd', 'raw-player.js'));
  class FakeRawPlayer {
    constructor() { this.state = 'stopped'; }
    async start() {} async playTrack() {} positionSec() { return 0; }
    audibleSec() { return 0; } pause() {} resume() {}
    setAudibleSec() {} async stop() {} async close() {} seekToSeconds() {} getPositionFrame() { return 0; }
  }
  require.cache[rawId] = new Module(rawId, null);
  require.cache[rawId].filename = rawId;
  require.cache[rawId].loaded = true;
  require.cache[rawId].exports = { RawPlayer: FakeRawPlayer, CHUNK_SECTORS: 75, CHUNK_SECONDS: 0.5 };

  /* ---- 注入假 fetch（cd-service 只从里面拿两个函数） ---- */
  const fetchId = require.resolve(path.join(ROOT, 'main', 'metadata', 'fetch.js'));
  let fetchLyricsOnlyImpl = async () => ({ filled: 0, tracks: null });
  const fetchSpy = { calls: 0 };
  require.cache[fetchId] = new Module(fetchId, null);
  require.cache[fetchId].filename = fetchId;
  require.cache[fetchId].loaded = true;
  require.cache[fetchId].exports = {
    fetchDiscMetadata: async () => null,
    fetchLyricsOnly: async (...args) => { fetchSpy.calls++; return fetchLyricsOnlyImpl(...args); }
  };

  const { CdService } = require(path.join(ROOT, 'main', 'cd', 'cd-service.js'));

  const sent = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcd-v104-'));
  const svc = new CdService({
    userData: tmp, autoPlay: false, demo: false,
    log: () => {}, send: (ch, p) => sent.push({ ch, p })
  });
  const last = (ch) => {
    for (let i = sent.length - 1; i >= 0; i--) if (sent[i].ch === ch) return sent[i].p;
    return null;
  };

  const SIG = 'sig-fill-1';
  const cached = {
    signature: SIG, album: '测试专辑', artist: '测试歌手', discNumber: 1,
    tracks: [
      { number: 1, title: '一', lyrics: '[00:01.00]旧歌词', lyricsSynced: true },
      { number: 2, title: '二' }
    ]
  };
  svc.store.save(cached);
  svc.signature = SIG;
  svc.toc = fakeNative.readToc();

  /* ---- C1：正常补抓 ---- */
  fetchLyricsOnlyImpl = async () => ({
    filled: 1,
    tracks: [
      { number: 1, title: '一', lyrics: '[00:01.00]旧歌词', lyricsData: { lines: [] } },
      {
        number: 2, title: '二',
        lyrics: '[00:02.00]新歌词', lyricsSynced: true,
        lyricsData: { lines: [{ time: 2, words: [] }] },
        lyricsSource: 'netease-yrc'
      }
    ]
  });
  const r1 = await svc._fillLyricsBackground(SIG, cached, svc.toc);
  ok(!!r1, '补抓有收获时返回新元数据');
  const saved = svc.store.get(SIG);
  ok(saved.tracks[0].lyrics === '[00:01.00]旧歌词', '落盘后已有歌词的轨不被覆盖', saved.tracks[0].lyrics);
  ok(saved.tracks[1].lyricsData && saved.tracks[1].lyrics.indexOf('[00:02.00]') === 0,
    '落盘后缺歌词的轨补上模型 + LRC');
  ok(typeof saved.lyricsFilledAt === 'string' && saved.lyricsFilledAt.length > 0,
    '落盘记录 lyricsFilledAt', saved.lyricsFilledAt);
  const ev = last('cd:metadata');
  ok(!!ev && ev.lyricsFilled === true, '推 cd:metadata 且带 lyricsFilled 标记（渲染端据此强制刷新歌词）', ev && ev.lyricsFilled);
  ok(!!ev && ev.fromCache === false, 'fromCache=false（触发 setLyrics 的 force 分支）', ev && ev.fromCache);

  /* ---- C2：并发去重 ---- */
  let release;
  fetchLyricsOnlyImpl = () => new Promise((res) => { release = () => res({ filled: 1, tracks: [{ number: 2, lyrics: 'x', lyricsData: { lines: [] } }] }); });
  const p1 = svc._fillLyricsBackground(SIG, cached, svc.toc);
  const r2 = await svc._fillLyricsBackground(SIG, cached, svc.toc);
  ok(r2 === null, '同一张碟补抓进行中 → 第二次直接跳过', r2);
  release();
  await p1;

  /* ---- C3：换碟竞态 ---- */
  fetchSpy.calls = 0;
  fetchLyricsOnlyImpl = async () => {
    // 抓取期间用户换了碟
    svc.signature = 'another-disc';
    return { filled: 1, tracks: [{ number: 2, lyrics: '迟到的歌词', lyricsData: { lines: [] } }] };
  };
  const before = svc.store.get(SIG).tracks[1].lyrics || '';
  const r3 = await svc._fillLyricsBackground(SIG, cached, svc.toc);
  ok(r3 === null, '抓取期间换了碟 → 结果作废', r3);
  ok((svc.store.get(SIG).tracks[1].lyrics || '') === before, '不写错碟的缓存');

  /* ---- C4：一无所获不推事件 ---- */
  sent.length = 0;
  svc.signature = SIG;
  fetchLyricsOnlyImpl = async () => ({ filled: 0, tracks: null });
  const r4 = await svc._fillLyricsBackground(SIG, cached, svc.toc);
  ok(r4 === null, '没补到歌词 → 返回 null');
  ok(last('cd:metadata') === null, '不推 cd:metadata（不打扰界面）');

  /* ================================================================
   * D. 前端契约（静态读源码）
   * ================================================================ */
  section('D. 前端契约：音乐库 / 专辑页 / 换碟续播 / 歌词自动应用 / 退碟清空');

  const libraryJs = read('renderer/js/library.js');
  const appJs = read('renderer/js/app.js');
  const albumJs = read('renderer/js/album.js');
  const nowplayingJs = read('renderer/js/nowplaying.js');
  const pagesCss = read('renderer/css/pages.css');
  const indexHtml = read('renderer/index.html');
  const mainJs = read('main/index.js');
  /* 文案改走 i18n：静态断言同时查「代码用对了键」与「词典里有对应中文」 */
  const i18nJs = read('renderer/js/i18n.js');

  /* ---- D1：点击专辑进入详情页（两种视图统一） ---- */
  ok(/Album\.open\(meta, node\)/.test(libraryJs), '音乐库卡片点击 → Album.open（原版网格与 CoverFlow 同一目的地）');
  ok(/Album\.open\(meta, it\)/.test(libraryJs), 'CoverFlow 回车同样打开详情页');
  ok(/id="overlay-album"/.test(indexHtml), 'index.html 有专辑详情页容器');
  ok(/<script src="js\/album.js"><\/script>/.test(indexHtml), 'album.js 已接入');

  /* ---- D2：CoverFlow transform 驱动 ---- */
  ok(/flowRow\.style\.transform = `translate3d\(\$\{x\}px, 0, 0\)`/.test(libraryJs), '整行平移用 translate3d（transform 驱动）');
  ok(/container\.classList\.add\('flow-dragging'\)/.test(libraryJs) &&
     /container\.classList\.remove\('flow-dragging'\)/.test(libraryJs), '拖动时切 flow-dragging（关过渡跟手）');
  ok(/onFlowWheel[\s\S]*?setFlowFocus\(flowIndex \+ \(wheelAcc > 0 \? 1 : -1\), true\)/.test(libraryJs),
    '滚轮直接切换焦点并居中（不是拖动列表）');
  ok(/case 'Enter'/.test(libraryJs) && /setFlowFocus\(flowIndex - 1, true\)/.test(libraryJs) &&
     /setFlowFocus\(flowIndex \+ 1, true\)/.test(libraryJs), '键盘左右同样直接选中居中');
  ok(/flowPlay\.className = 'lib-flow-play/.test(libraryJs) && /App\.requestDisc\(meta\)/.test(libraryJs),
    '选中项下方播放按钮 → requestDisc（从第一首播）');
  ok(/setTopName\(name\)/.test(libraryJs) && /lib-flow-top-clone/.test(libraryJs),
    '顶部大字专辑名 + 过长滚动克隆');
  ok(/onResize\(\)/.test(libraryJs) && /placeRow\(rowTargetX\(\), false\)/.test(libraryJs),
    'resize 时重算居中');
  const rowCss = /\.lib-flow-row\s*\{([^}]*)\}/.exec(pagesCss);
  ok(!!rowCss && /transform-style:\s*preserve-3d/.test(rowCss[1]),
    '.lib-flow-row preserve-3d（子项 3D 纳入视口透视）');
  const itemCss = /\.lib-flow-item\s*\{([^}]*)\}/.exec(pagesCss);
  ok(!!itemCss && /rotateY\(calc\(var\(--pos/.test(itemCss[1]), '单项按 --pos/--adist 做 3D 变换');
  const flowCss = /\.lib-flow\s*\{([^}]*)\}/.exec(pagesCss);
  ok(!!flowCss && /perspective:\s*1500px/.test(flowCss[1]) && /overflow:\s*hidden/.test(flowCss[1]),
    '.lib-flow 只做透视与裁剪');
  ok(/--flow-item:\s*236px/.test(pagesCss), '封面放大到 236px（原 224）');
  ok(/--flow-item:\s*316px/.test(pagesCss), '全屏放大到 316px（原 300）');
  ok(/\.lib-flow-top\s*\{([^}]*)\}/.test(pagesCss) && /@keyframes flowmarquee/.test(pagesCss),
    '顶部大名样式与滚动动画存在');
  ok(/to \{ transform: translateX\(calc\(-50% - 1\.6em\)\); \}/.test(pagesCss),
    'marquee 位移补半个间距（无缝循环，无跳变）');
  const playCss = /\.lib-flow-play\s*\{([^}]*)\}/.exec(pagesCss);
  ok(!!playCss && /top:\s*calc\(50% \+ var\(--flow-item\) \/ 2 \+ 20px\)/.test(playCss[1]),
    '播放按钮贴在选中封面下方');

  /* ---- D3：点歌换碟续播 ---- */
  ok(/App\.requestDiscTrack = requestDiscTrack/.test(appJs), 'requestDiscTrack 已导出');
  ok(/App\.needDisc = \{ sig: meta && meta\.signature, meta, track: n \}/.test(appJs),
    'needDisc 携带目标曲目');
  ok(/if \(target\) playTrack\(target\);/.test(appJs),
    '换碟落地后直接播目标曲目（显式点歌无视 autoPlay）');
  ok(/T\('needDisc\.subTrack', \{ n: track \}\)/.test(appJs)
    && /'needDisc\.subTrack': '[^']*第 \{n\} 首/.test(i18nJs),
    '放碟提示写明"第 N 首"');
  ok(/App\.requestDiscTrack\(meta, number\)/.test(albumJs), '详情页点歌走 requestDiscTrack');
  ok(/App\.playTrack\(number\)/.test(albumJs), '当前碟正是目标碟 → 直接播');

  /* ---- D4：歌词自动应用 ---- */
  ok(/NowPlaying\.setLyrics\(ev\.metadata, Transport\.track, ev\.fromCache !== true\)/.test(appJs),
    '非缓存数据（抓取完成/补抓/重取）强制刷新歌词视图');
  ok(/lyricsFilled: true/.test(mainJsRead('main/cd/cd-service.js')),
    '补抓完成推 lyricsFilled 标记');

  /* ---- D5：退碟清空 ---- */
  ok(/App\.state\.metadata = null;[\s\S]{0,200}App\.state\.signature = null;[\s\S]{0,200}App\.state\.toc = null;/.test(appJs),
    'idle/eject 清空 metadata/signature/toc');
  ok(/NowPlaying\.reset\(\)/.test(appJs), 'idle/eject 调用 NowPlaying.reset');
  ok(/function reset\(\)/.test(nowplayingJs) && /reset,/.test(nowplayingJs), 'NowPlaying.reset 已实现并导出');
  ok(/if \(title\) title\.textContent = '—'/.test(nowplayingJs), 'reset 清空标题');
  ok(/T\('np\.empty\.waiting'\)/.test(nowplayingJs)
    && /'np\.empty\.waiting': '等待光盘\\n放入 CD 后这里会显示歌词'/.test(i18nJs),
    'reset 后歌词区显示等待提示');
  ok(/hideNeedDisc\(\)/.test(appJs), '退碟时收起放碟提示');

  /* ---- D6：Esc / resize ---- */
  ok(/Album\.onKey\(e\)/.test(appJs), 'Esc 路由到专辑详情页（一镜到底飞回）');
  ok(/Library\.onResize\(\)/.test(appJs), '窗口 resize 联动 CoverFlow 重算居中');
  ok(/refitTitle/.test(albumJs), 'resize 时专辑页标题重排（静态↔滚动切换）');

  /* ---- D7：cover 协议 CORS（取色前提） ---- */
  ok(/headers: \{ 'Access-Control-Allow-Origin': '\*' \}/.test(mainJs), 'cover 协议带 CORS 头（专辑页 canvas 取色）');
  ok(/crossOrigin = 'anonymous'/.test(albumJs), '专辑页取色按跨域匿名读取');

  /* ---- D8：专辑页结构细节 ---- */
  ok(!/al-capsule-hint/.test(albumJs), '胶囊里没有多余的文字元素（只有两个按钮）');
  ok(/data-tab = 'album'/.test(albumJs.replace(/'/g, '=')) || /dataset\.tab = 'album'/.test(albumJs),
    '胶囊两个选项：专辑 / 曲目');
  ok(/tab = 'tracks';/.test(albumJs), '默认停在曲目选项');
  ok(/has-colors/.test(albumJs) && /--al-c1/.test(albumJs), '背景按封面取色设渐变变量');
  ok(/classList\.toggle\('tab-album'/.test(albumJs) && /classList\.toggle\('tab-tracks'/.test(albumJs),
    'Tab 切换只挪 class（同一批元素位移，一镜到底）');

  /* ---- 汇总 ---- */
  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED'));
  console.log(pass + ' 断言通过' + (fail ? '，' + fail + ' 失败' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});

/** 读主进程源码（D4 用） */
function mainJsRead(p) { return read(p); }
