'use strict';
/*
 * tests/lyrics-fallback.test.js —— 多源逐字歌词降级链（fetchLyricsRich）离线单测。
 *
 * 原则：一个真实网络请求都不发。做法是在 require 之前把四个歌词客户端
 * （amll / netease / qq-music / kugou）与 http 层（LRCLIB 走它）打进
 * require.cache，lyrics.js 加载时拿到的就是假客户端；解析器用真实的
 * lyrics-model.js + tests/fixtures 下的真实样本。
 *
 * 覆盖：
 *   1) 源优先级：AMLL > 网易云 yrc > QQ QRC > 酷狗 KRC > 网易云 lrc > LRCLIB
 *   2) 单源失败/抛异常不阻塞后续源；全部失败返回 null 且不抛
 *   3) 匹配纪律：有 neteaseSongId 绝不搜索；搜索候选必须标题命中且有佐证
 *   4) 单行歌词规则：搜索源单行视为脏数据；精确 ID 单行放行
 *   5) 真实样本经降级链产出的统一模型字段完整（词级/翻译/罗马音/质量分）
 *   6) 诊断日志：命中一行 / 六源均未命中 / 异常才记「失败」/ 长曲名截断
 *   7) 全收集 fetchLyricsRichAll：六源全跑、候选降序、best=质量最高、
 *      与单发模式的行为差异（命中即停 vs 全部收集）
 *
 * 运行：node tests/lyrics-fallback.test.js
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const BASE = path.join(__dirname, '..', 'main', 'metadata');
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}
function section(name) { console.log('\n---- ' + name + ' ----'); }

/* ---------- 真实样本 ---------- */
const TTML_SHUKUFUKU = fixture('amll-yoasobi-shukufuku.ttml');       // AMLL 真实 TTML
const YRC_GURENGE = JSON.parse(fixture('netease-yrc-gurenge.json')); // 网易云 yrc 五轨齐全
const KRC_QILIXIANG = fixture('kugou-krc-qilixiang.txt');            // 酷狗 KRC 明文
const QRC_SYNTH = '[0,4000](0,800)GNZ48(800,400)女(1200,400)王(1600,400)派(2000,400)对(2400,400)来(2800,400)了\n' +
  '[4200,3000](4200,500)站(4700,500)在(5200,500)舞(5700,500)台(6200,500)中(6700,500)央';

/* ---------- 假客户端工厂 ---------- */

/** 记录每次调用，便于断言"有没有乱搜索"。包装任意实现，保留 .calls */
function spy(impl) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return impl ? impl(...args) : null; };
  fn.calls = calls;
  return fn;
}

function fakeAmll(opts = {}) {
  return {
    getLyric: opts.getLyric ? spy(opts.getLyric) : spy(),
    search: opts.search ? spy(opts.search) : spy()
  };
}
function fakeNetease(opts = {}) {
  return {
    getLyric: opts.getLyric ? spy(opts.getLyric) : spy(),
    searchSongs: opts.searchSongs ? spy(opts.searchSongs) : spy()
  };
}
function fakeQq(opts = {}) {
  return { getLyric: opts.getLyric ? spy(opts.getLyric) : spy() };
}
function fakeKugou(opts = {}) {
  return {
    // 新路径（两段式）：songsearch 拿 hash → krcs hash 直查候选
    searchSongs: opts.searchSongs ? spy(opts.searchSongs) : spy(),
    lyricCandidates: opts.lyricCandidates ? spy(opts.lyricCandidates) : spy(),
    // 旧 keyword 直查路径（入口已 404，仅兜底）
    search: opts.search ? spy(opts.search) : spy(),
    download: opts.download ? spy(opts.download) : spy()
  };
}
function fakeHttp(opts = {}) {
  return {
    getJson: opts.getJson ? spy(opts.getJson) : spy(),
    postJson: opts.postJson ? spy(opts.postJson) : spy(),
    getBuffer: opts.getBuffer ? spy(opts.getBuffer) : spy(),
    qs: (o) => Object.keys(o).filter((k) => o[k] != null && o[k] !== '')
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&'),
    withTimeout: (p) => p,
    DEFAULT_UA: 'test',
    BROWSER_UA: 'test-browser',
    MAX_COVER_BYTES: 1
  };
}

/**
 * 用一组假客户端加载**全新的** lyrics.js 实例。
 * 客户端与 lyrics.js 本身的模块缓存都清掉，保证每次注入互不影响。
 */
function loadLyrics({ amll, netease, qq, kugou, http }) {
  for (const name of ['amll', 'netease', 'qq-music', 'kugou', 'lyrics', 'http']) {
    const p = path.join(BASE, name + '.js');
    delete require.cache[require.resolve(p)];
  }
  const inject = (name, exports) => {
    const p = require.resolve(path.join(BASE, name + '.js'));
    require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
  };
  if (amll) inject('amll', amll);
  if (netease) inject('netease', netease);
  if (qq) inject('qq-music', qq);
  if (kugou) inject('kugou', kugou);
  if (http) inject('http', http);
  return require(path.join(BASE, 'lyrics.js'));
}

const TARGET = { title: '紅蓮華', artist: 'LiSA', durationSec: 237 };

async function main() {

  /* ================================================================
   * 1) 源优先级
   * ================================================================ */
  section('降级链：源优先级（AMLL > 网易云 yrc > QQ > 酷狗 > 网易云 lrc > LRCLIB）');

  {
    // 全源可用 → 必须拿 AMLL
    const amll = fakeAmll({ getLyric: async () => TTML_SHUKUFUKU });
    const ne = fakeNetease({ getLyric: async () => ({ yrc: YRC_GURENGE.yrc, lyrics: '', yrcTranslation: YRC_GURENGE.ytlrc }) });
    const qq = fakeQq({ getLyric: async () => ({ qrc: QRC_SYNTH }) });
    const kg = fakeKugou({
      search: async () => [{ id: '1', accesskey: 'k', song: '紅蓮華', singer: 'LiSA', duration: 237000 }],
      download: async () => KRC_QILIXIANG
    });
    const { fetchLyricsRich } = loadLyrics({ amll, netease: ne, qq, kugou: kg, http: fakeHttp() });
    const m = await fetchLyricsRich(Object.assign({ neteaseSongId: 1375305989 }, TARGET));
    ok(m && m.source === 'amll', '全源可用 → AMLL 优先（实际 ' + (m && m.source) + '）');
    ok(amll.getLyric.calls.length === 1, 'AMLL 用精确 ID 直查（调用 ' + amll.getLyric.calls.length + ' 次）');
    ok(ne.getLyric.calls.length === 0, 'AMLL 命中后不再调网易云');
  }

  {
    // AMLL 全失败 → 网易云 yrc
    const amll = fakeAmll({ getLyric: async () => null });
    const ne = fakeNetease({ getLyric: async () => ({ yrc: YRC_GURENGE.yrc, lyrics: '', yrcTranslation: YRC_GURENGE.ytlrc, yrcRomanization: YRC_GURENGE.yromalrc }) });
    const { fetchLyricsRich } = loadLyrics({ amll, netease: ne, qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const m = await fetchLyricsRich(Object.assign({ neteaseSongId: 1375305989 }, TARGET));
    ok(m && m.source === 'netease' && m.isWordByWord, 'AMLL 失败 → 网易云 yrc');
    ok(m.lines.length >= 30, 'yrc 行数齐全（' + (m && m.lines.length) + '）');
    ok(m.lines.filter((l) => l.tr).length > 25, '译文轨挂接');
    ok(m.quality > 100, '质量分 > 100（' + (m && m.quality) + '）');
    ok(ne.getLyric.calls.length === 1, '网易云用精确 ID 直查，不搜索');
    ok(ne.searchSongs.calls.length === 0, '有 neteaseSongId 时绝不搜索');
  }

  {
    // AMLL + 网易云失败 → QQ QRC
    const qq = fakeQq({ getLyric: async () => ({ qrc: QRC_SYNTH, trans: '[00:00.00]GNZ48 女王派来袭\n[00:04.20]站在舞台中央' }) });
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: fakeNetease({ getLyric: async () => null }),
      qq, kugou: fakeKugou(), http: fakeHttp()
    });
    const m = await fetchLyricsRich(Object.assign({ qqMid: '001KEjQl07j8DG' }, TARGET));
    ok(m && m.source === 'qq' && m.isWordByWord, '前两源失败 → QQ QRC');
    ok(m.lines[0].text === 'GNZ48女王派对来了', 'QRC 行文本（' + (m && m.lines[0].text) + '）');
    ok(!!m.lines[0].tr, 'QRC 译文挂接');
    ok(qq.getLyric.calls.length === 1, 'QQ 用 mid 直查');
  }

  {
    // 前三源失败 → 酷狗 KRC（新路径：songsearch 拿 hash → krcs hash 直查）
    const kg = fakeKugou({
      searchSongs: async () => [
        { name: '紅蓮華', artist: 'LiSA', durationSec: 237, hash: 'HASH_STUDIO', albumAudioId: '100' },
        { name: '紅蓮華 (Live ver)', artist: 'LiSA', durationSec: 260, hash: 'HASH_LIVE', albumAudioId: '200' }
      ],
      lyricCandidates: async (song) => [{ id: '9', accesskey: 'ak', song: '紅蓮華', singer: 'LiSA', duration: 237000 }],
      download: async (cand, fmt) => (fmt === 'krc' ? KRC_QILIXIANG : null)
    });
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: fakeNetease({ getLyric: async () => null }),
      qq: fakeQq({ getLyric: async () => null }),
      kugou: kg, http: fakeHttp()
    });
    const m = await fetchLyricsRich(TARGET);
    ok(m && m.source === 'kugou' && m.isWordByWord, '前三源失败 → 酷狗 KRC（新路径）');
    ok(kg.searchSongs.calls.length === 1, '先走 songsearch 拿 hash');
    ok(kg.lyricCandidates.calls.length === 1 && kg.lyricCandidates.calls[0][0].hash === 'HASH_STUDIO',
      'hash 直查选中时长吻合的录音室版（' + (kg.lyricCandidates.calls[0] && kg.lyricCandidates.calls[0][0].hash) + '）');
    ok(kg.search.calls.length === 0, '旧 keyword 直查未被调用（入口已 404）');
    ok(m.lines.some((l) => l.text.indexOf('窗外') === 0), 'KRC 内容正确解析');
  }

  {
    // 新路径整条无果（歌曲未命中）→ 才回落旧 keyword 直查
    const kg = fakeKugou({
      searchSongs: async () => [{ name: '完全无关的歌', artist: '某人', durationSec: 99, hash: 'X' }],
      search: async () => [{ id: '77', accesskey: 'ak', song: '紅蓮華', singer: 'LiSA', duration: 237000 }],
      download: async (cand, fmt) => (fmt === 'krc' ? KRC_QILIXIANG : null)
    });
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: fakeNetease({ getLyric: async () => null }),
      qq: fakeQq({ getLyric: async () => null }),
      kugou: kg, http: fakeHttp()
    });
    const m = await fetchLyricsRich(TARGET);
    ok(m && m.source === 'kugou', '新路径无果 → 旧 keyword 兜底仍出结果');
    ok(kg.search.calls.length === 1, '旧 keyword 兜底被调用一次');
    ok(kg.lyricCandidates.calls.length === 0, '歌曲未命中时不发 hash 直查');
  }

  {
    // 前四源失败 → LRCLIB（http.getJson 桩）
  const http = fakeHttp({
    getJson: async (url) => {
      if (url.indexOf('lrclib.net/api/get') >= 0) {
        return { syncedLyrics: '[00:01.00]LRCLIB 行一\n[00:05.00]LRCLIB 行二\n[00:09.00]LRCLIB 行三' };
      }
      return null;
    }
  });
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: fakeNetease({ getLyric: async () => null }),
      qq: fakeQq({ getLyric: async () => null }),
      kugou: fakeKugou({ search: async () => null }),
      http
    });
    const m = await fetchLyricsRich(TARGET);
    ok(m && m.source === 'lrclib' && !m.isWordByWord, '前四源失败 → LRCLIB 行级兜底');
    ok(m.lines.length === 3, 'LRCLIB 三行（' + (m && m.lines.length) + '）');
    ok(http.getJson.calls.length >= 1, 'LRCLIB 走了 http 层（可被测试桩拦截）');
  }

  /* ================================================================
   * 2) 失败语义
   * ================================================================ */
  section('失败语义：单源抛异常不阻塞；全失败返回 null');

  {
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => { throw new Error('AMLL 炸了'); } }),
      netease: fakeNetease({ getLyric: async () => ({ yrc: YRC_GURENGE.yrc }) }),
      qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp()
    });
    const m = await fetchLyricsRich(Object.assign({ neteaseSongId: 1375305989 }, TARGET));
    ok(m && m.source === 'netease', 'AMLL 抛异常 → 自动落到网易云');
  }

  {
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => { throw new Error('x'); }, search: async () => { throw new Error('x'); } }),
      netease: fakeNetease({ getLyric: async () => { throw new Error('x'); }, searchSongs: async () => { throw new Error('x'); } }),
      qq: fakeQq({ getLyric: async () => { throw new Error('x'); } }),
      kugou: fakeKugou({ search: async () => { throw new Error('x'); } }),
      http: fakeHttp({ getJson: async () => { throw new Error('lrclib down'); } })
    });
    let m = 'UNSET';
    let threw = null;
    try { m = await fetchLyricsRich(TARGET); } catch (e) { threw = e; }
    ok(threw === null, '全部源失败也不向外抛异常');
    ok(m === null, '全部源失败 → null');
  }

  /* ================================================================
   * 3) 匹配纪律（搜索反查）
   * ================================================================ */
  section('匹配纪律：标题命中是硬条件，歌手/时长作佐证');

  {
    // 无 ID：AMLL 搜索反查。候选中标题必须命中
    const items = [
      { musicNames: ['完全无关的另一首歌'], artistNames: ['某歌手'], ncmMusicIds: ['111'] },
      { musicNames: ['紅蓮華'], artistNames: ['LiSA'], ncmMusicIds: ['1375305989'], qqMusicIds: ['001KEjQl07j8DG'] }
    ];
    const amll = fakeAmll({
      search: async ({ musicName, artistName }) => (musicName === '紅蓮華' ? items : []),
      getLyric: async (platform, id) => (platform === 'ncm' ? TTML_SHUKUFUKU : null)
    });
    const { fetchLyricsRich } = loadLyrics({ amll, netease: fakeNetease(), qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const m = await fetchLyricsRich(TARGET);
    ok(m && m.source === 'amll', '无 ID → AMLL 搜索反查命中');
    ok(amll.getLyric.calls.length === 1 && amll.getLyric.calls[0][1] === '1375305989',
      '用候选项里的 ncmMusicId 回查（' + JSON.stringify(amll.getLyric.calls) + '）');
  }

  {
    // 候选项标题**包含**目标（Live 版）→ containment 判为命中，AMLL 采用
    const items = [{ musicNames: ['紅蓮華 (Live ver)'], artistNames: ['LiSA'], ncmMusicIds: ['999'] }];
    const amll = fakeAmll({
      search: async () => items,
      getLyric: async () => TTML_SHUKUFUKU
    });
    const ne = fakeNetease();
    const { fetchLyricsRich } = loadLyrics({ amll, netease: ne, qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const m = await fetchLyricsRich(TARGET);
    ok(m && m.source === 'amll', '候选项标题包含目标（Live 版）→ 判为命中');
    ok(amll.getLyric.calls.length === 1 && amll.getLyric.calls[0][1] === '999',
      '采用该候选的 ncmMusicId 回查');
    ok(ne.searchSongs.calls.length === 0, 'AMLL 命中后不走网易云');
  }

  {
    // 标题不命中（完全不相关）→ AMLL 与网易云搜索都拒绝 → 走不到 QQ（无 mid）
    const amll = fakeAmll({ search: async () => [{ musicNames: ['万里长城'], artistNames: ['未知'], ncmMusicIds: ['1'] }], getLyric: async () => TTML_SHUKUFUKU });
    const ne = fakeNetease({ searchSongs: async () => [{ id: 2, name: '万里长城', artists: [{ name: '未知' }], duration: 999000 }], getLyric: async () => ({ yrc: YRC_GURENGE.yrc }) });
    const { fetchLyricsRich } = loadLyrics({ amll, netease: ne, qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const m = await fetchLyricsRich(TARGET);
    ok(amll.getLyric.calls.length === 0, 'AMLL 不相干候选未回查');
    ok(ne.getLyric.calls.length === 0, '网易云不相干候选未取歌词');
    ok(m === null, '全部不相干 → null');
  }

  /* ================================================================
   * 4) 单行歌词规则
   * ================================================================ */
  section('单行规则：搜索源单行拒收；精确 ID 单行放行');

  {
    // 精确 ID + 单行 LRC → 收（真实存在单行歌，如前奏曲）
    const ne = fakeNetease({ getLyric: async () => ({ lyrics: '[00:01.00]只有一行' }) });
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }), netease: ne, qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp()
    });
    const m = await fetchLyricsRich(Object.assign({ neteaseSongId: 1375305989 }, TARGET));
    ok(m && m.source === 'netease' && m.lines.length === 1, '精确 ID 单行 LRC 放行');
  }

  {
    // 搜索来源 + 单行 → 拒（脏数据）
    const ne = fakeNetease({
      searchSongs: async () => [{ id: 777, name: '紅蓮華', artists: [{ name: 'LiSA' }], duration: 237000 }],
      getLyric: async () => ({ lyrics: '[00:01.00]只有一行' })
    });
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null, search: async () => [] }), netease: ne, qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp()
    });
    const m = await fetchLyricsRich(TARGET);
    ok(m === null, '搜索来源的单行 LRC 视为脏数据拒收');
  }

  /* ================================================================
   * 5) 模型出口字段
   * ================================================================ */
  section('模型出口：统一结构可直接进 schema 白名单');

  {
    const amll = fakeAmll({ getLyric: async () => TTML_SHUKUFUKU });
    const { fetchLyricsRich } = loadLyrics({ amll, netease: fakeNetease(), qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const m = await fetchLyricsRich(Object.assign({ neteaseSongId: 1983292457 }, TARGET));
    const { lyricsDataModel } = require(path.join(BASE, 'schema.js'));
    const clean = lyricsDataModel(m);
    ok(!!clean, 'schema.lyricsDataModel 接受模型');
    ok(clean && clean.lines.length === m.lines.length, '行数经白名单后不变');
    ok(clean && clean.isWordByWord === true, '词级标记保留');
    ok(clean && clean.lines.every((l) => typeof l.t === 'number' && typeof l.e === 'number' && typeof l.text === 'string'),
      '每行 t/e/text 类型稳定');
    ok(lyricsDataModel({ lines: '不是数组' }) === null, '脏 lyricsData → null');
    ok(lyricsDataModel({ lines: [{ t: 1 }] }) === null, '缺 e/text 的行被剔除后 → null');
  }

  /* ================================================================
   * 6) 诊断日志（won / trySource / 六源均未命中）
   * ================================================================ */
  section('诊断日志：命中、失败、全空三种行（用户排障的主要依据）');

  {
    // 命中：一行说清 源/逐字与否/行数/质量分/译音对唱标记
    const amll = fakeAmll({ getLyric: async () => TTML_SHUKUFUKU });
    const { fetchLyricsRich } = loadLyrics({ amll, netease: fakeNetease(), qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const lines = [];
    const m = await fetchLyricsRich(Object.assign({ neteaseSongId: 1375305989, log: (s) => lines.push(s) }, TARGET));
    const hit = lines.join('\n');
    ok(lines.length === 1, '命中时只记一行（实际 ' + lines.length + ' 行）');
    ok(hit.indexOf('lyrics[紅蓮華]') === 0, '日志以 lyrics[曲名] 开头：' + lines[0]);
    ok(hit.indexOf('amll') >= 0 && hit.indexOf('逐字') >= 0, '含源名与逐字标记');
    ok(/质量\d+/.test(hit), '含质量分');
    ok(m && m.lines && m.lines.length, '返回值不受日志影响');
  }

  {
    // 六源全空：必须明确告诉用户"没命中"，而不是静默 null
    const { fetchLyricsRich } = loadLyrics({ amll: fakeAmll(), netease: fakeNetease(), qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const lines = [];
    const m = await fetchLyricsRich(Object.assign({ neteaseSongId: 1, log: (s) => lines.push(s) }, TARGET));
    ok(m === null, '全源无数据返回 null');
    ok(lines.length === 1 && lines[0].indexOf('六源均未命中') >= 0,
      '全空时记一行「六源均未命中」：' + (lines[0] || '(无)'));
  }

  {
    // 抛异常（超时/网络错）才记「失败」；返回 null（没收录）静默
    const amll = fakeAmll({ getLyric: async () => { throw new Error('timeout'); } });
    const ne = fakeNetease({ getLyric: async () => ({ yrc: YRC_GURENGE.yrc, lyrics: '', yrcTranslation: YRC_GURENGE.ytlrc }) });
    const { fetchLyricsRich } = loadLyrics({ amll, netease: ne, qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const lines = [];
    const m = await fetchLyricsRich(Object.assign({ neteaseSongId: 1375305989, log: (s) => lines.push(s) }, TARGET));
    ok(m && m.source === 'netease', 'AMLL 抛异常不阻塞，网易云顶上');
    const failed = lines.filter((l) => l.indexOf('失败') >= 0);
    ok(failed.length === 1 && failed[0].indexOf('lyrics[amll] 失败：timeout') === 0,
      '异常记「lyrics[amll] 失败：timeout」：' + (failed[0] || '(无)'));
  }

  {
    // 长曲名截断：一行日志要塞下源信息，曲名 >10 字截断加省略号
    const amll = fakeAmll({ getLyric: async () => TTML_SHUKUFUKU });
    const { fetchLyricsRich } = loadLyrics({ amll, netease: fakeNetease(), qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const lines = [];
    await fetchLyricsRich({ title: '小星星变奏曲第一乐章超长测试', artist: '莫扎特', durationSec: 180, neteaseSongId: 1, log: (s) => lines.push(s) });
    ok(lines.length === 1 && lines[0].indexOf('lyrics[小星星变奏曲第一乐章…]') === 0,
      '长曲名截断为 10 字+省略号：' + (lines[0] || '(无)'));
  }

  {
    // 不传 log 不得炸（老调用方兼容）
    const amll = fakeAmll({ getLyric: async () => TTML_SHUKUFUKU });
    const { fetchLyricsRich } = loadLyrics({ amll, netease: fakeNetease(), qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const m = await fetchLyricsRich(Object.assign({ neteaseSongId: 1375305989 }, TARGET));
    ok(m && m.source === 'amll', '不传 log 时链路照常工作');
  }

  /* ================================================================
   * 7) 全收集模式 fetchLyricsRichAll（编辑面板"歌词源管理"的数据源）
   * ================================================================ */
  section('全收集 fetchLyricsRichAll：跑完全部源，返回 {best, candidates}');

  {
    // 全源可用：单发模式命中即返回（AMLL 后不再问网易云），
    // 全收集模式必须把六个源都问一遍，候选按质量降序，best = 质量最高。
    const mkClients = () => ({
      amll: fakeAmll({ getLyric: async () => TTML_SHUKUFUKU }),
      ne: fakeNetease({ getLyric: async () => ({ yrc: YRC_GURENGE.yrc, lyrics: '', yrcTranslation: YRC_GURENGE.ytlrc }) }),
      qq: fakeQq({ getLyric: async () => ({ qrc: QRC_SYNTH }) }),
      kg: fakeKugou({
        searchSongs: async () => [{ name: '紅蓮華', artist: 'LiSA', durationSec: 237, hash: 'HASH_STUDIO', albumAudioId: '100' }],
        lyricCandidates: async () => [{ id: '1', accesskey: 'k', song: '紅蓮華', singer: 'LiSA', duration: 237000 }],
        download: async () => KRC_QILIXIANG
      }),
      http: fakeHttp()
    });
    const opts = Object.assign({ neteaseSongId: 1375305989 }, TARGET);

    const c1 = mkClients();
    const { fetchLyricsRich } = loadLyrics({ amll: c1.amll, netease: c1.ne, qq: c1.qq, kugou: c1.kg, http: c1.http });
    await fetchLyricsRich(opts);
    ok(c1.amll.getLyric.calls.length === 1 && c1.ne.getLyric.calls.length === 0,
      '单发模式：AMLL 命中后不再调网易云（旧行为保持）');

    const c2 = mkClients();
    const { fetchLyricsRichAll } = loadLyrics({ amll: c2.amll, netease: c2.ne, qq: c2.qq, kugou: c2.kg, http: c2.http });
    const all = await fetchLyricsRichAll(opts);
    ok(all && all.candidates.length >= 3, '全收集：候选 ≥3（amll/netease/qq/kugou 都返回）',
      all && all.candidates.length);
    ok(c2.ne.getLyric.calls.length === 1, '全收集：AMLL 之后仍继续问网易云');
    ok(all.best && all.best.source === 'amll', 'best = 质量最高的候选（amll）', all.best && all.best.source);
    // 候选按质量降序（稳定排序：同分时源表在前的胜）
    const qs = all.candidates.map((m) => m.quality || 0);
    let sorted = true;
    for (let i = 1; i < qs.length; i++) if (qs[i] > qs[i - 1]) sorted = false;
    ok(sorted, '候选按质量降序排列', qs);
    ok(all.candidates.every((m) => m && Array.isArray(m.lines) && m.lines.length), '候选都是有效模型');
  }

  {
    // 网易云 yrc 与 lrc 是不同候选：同一首歌两种质量都该出现在列表里
    // （夹具只有 yrc，plain lrc 现场造一份多行文本即可）
    const PLAIN_LRC = '[00:00.00]也曾彼此相伴\n[00:03.00]走过漫漫长夜\n[00:06.00]黎明终会来临';
    const ne = fakeNetease({ getLyric: async () => ({ yrc: YRC_GURENGE.yrc, lyrics: PLAIN_LRC, yrcTranslation: YRC_GURENGE.ytlrc }) });
    const { fetchLyricsRichAll } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: ne, qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp()
    });
    const all = await fetchLyricsRichAll(Object.assign({ neteaseSongId: 1375305989 }, TARGET));
    const fromNe = all.candidates.filter((m) => m.source === 'netease');
    ok(fromNe.length === 2, '网易云 yrc 与 lrc 作为两个候选都返回', fromNe.map((m) => m.isWordByWord));
    ok(all.best.isWordByWord, 'yrc（逐字）质量高于 lrc，best 是逐字那份');
  }

  {
    // 单源可用：全收集也把它作为唯一候选返回（best === candidates[0]）
    const ne = fakeNetease({ getLyric: async () => ({ yrc: YRC_GURENGE.yrc, lyrics: '', yrcTranslation: YRC_GURENGE.ytlrc }) });
    const { fetchLyricsRichAll } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: ne, qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp()
    });
    const all = await fetchLyricsRichAll(Object.assign({ neteaseSongId: 1375305989 }, TARGET));
    ok(all && all.candidates.length === 1 && all.best === all.candidates[0],
      '只有一源命中 → 单候选，best 即它本身', all && all.candidates.length);
  }

  {
    // 六源均未命中：返回 null（与单发模式一致），调用方照旧走"无歌词"分支
    const { fetchLyricsRichAll } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: fakeNetease({ getLyric: async () => null }),
      qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp()
    });
    const lines = [];
    const all = await fetchLyricsRichAll(Object.assign({ neteaseSongId: 1375305989, log: (s) => lines.push(s) }, TARGET));
    ok(all === null, '六源均未命中 → 返回 null');
    ok(lines.length === 1 && lines[0].indexOf('六源均未命中') >= 0,
      '同样记一行六源均未命中日志', lines[0]);
  }

  {
    // 某源抛异常不阻塞全收集：剩余源照常入列
    const amll = fakeAmll({ getLyric: async () => { throw new Error('timeout'); } });
    const ne = fakeNetease({ getLyric: async () => ({ yrc: YRC_GURENGE.yrc, lyrics: '', yrcTranslation: YRC_GURENGE.ytlrc }) });
    const { fetchLyricsRichAll } = loadLyrics({ amll, netease: ne, qq: fakeQq(), kugou: fakeKugou(), http: fakeHttp() });
    const all = await fetchLyricsRichAll(Object.assign({ neteaseSongId: 1375305989 }, TARGET));
    ok(all && all.candidates.length === 1 && all.best.source === 'netease',
      'AMLL 抛异常不阻塞，剩余源入列', all && all.candidates.map((m) => m.source));
  }

  /* ================================================================
   * 8) 酷狗新路径：候选逐个顺延 / LRC 兜底 / 双候选入列 / 异常语义
   * ================================================================ */
  section('酷狗新路径：候选顺延（3KRC+2LRC 封顶）、双候选入列、异常即中止');

  {
    // 首候选无 KRC → 顺延到第二个候选即止；命中后再向同候选补一份 LRC
    const kg = fakeKugou({
      searchSongs: async () => [{ name: '紅蓮華', artist: 'LiSA', durationSec: 237, hash: 'H1', albumAudioId: '1' }],
      lyricCandidates: async () => [
        { id: 'a', accesskey: 'k1' }, { id: 'b', accesskey: 'k2' }, { id: 'c', accesskey: 'k3' }
      ],
      download: async (cand, fmt) => {
        if (fmt === 'krc') return cand.id === 'a' ? null : KRC_QILIXIANG; // 首候选无 KRC
        return null; // LRC 也拿不到（只验证顺延逻辑）
      }
    });
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: fakeNetease({ getLyric: async () => null }),
      qq: fakeQq({ getLyric: async () => null }),
      kugou: kg, http: fakeHttp()
    });
    const m = await fetchLyricsRich(TARGET);
    ok(m && m.source === 'kugou' && m.isWordByWord, '首候选无 KRC → 顺延第二个候选命中');
    const seq = kg.download.calls.map((c) => c[0].id + ':' + c[1]);
    ok(JSON.stringify(seq) === JSON.stringify(['a:krc', 'b:krc', 'b:lrc']),
      '下载序列 = 2 次 KRC 顺延 + 命中候选补 1 次 LRC（' + seq.join(' ') + '）');
  }

  {
    // KRC 全失败 → LRC 兜底（先试 3 个 KRC 再试 2 个 LRC）
    const kg = fakeKugou({
      searchSongs: async () => [{ name: '紅蓮華', artist: 'LiSA', durationSec: 237, hash: 'H1', albumAudioId: '1' }],
      lyricCandidates: async () => [
        { id: 'a', accesskey: 'k1' }, { id: 'b', accesskey: 'k2' }, { id: 'c', accesskey: 'k3' }
      ],
      download: async (cand, fmt) => (fmt === 'lrc' && cand.id === 'b'
        ? '[00:00.00]兜底行一\n[00:03.00]兜底行二\n[00:06.00]兜底行三' : null)
    });
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: fakeNetease({ getLyric: async () => null }),
      qq: fakeQq({ getLyric: async () => null }),
      kugou: kg, http: fakeHttp()
    });
    const m = await fetchLyricsRich(TARGET);
    ok(m && m.source === 'kugou' && !m.isWordByWord, 'KRC 全失败 → LRC 兜底（行级）');
    const krcN = kg.download.calls.filter((c) => c[1] === 'krc').length;
    const lrcN = kg.download.calls.filter((c) => c[1] === 'lrc').length;
    ok(krcN === 3 && lrcN === 2, '先 3 个 KRC 再 2 个 LRC（实际 ' + krcN + '+' + lrcN + '）');
    ok(m.lines.length === 3, 'LRC 兜底内容正确（' + m.lines.length + ' 行）');
  }

  {
    // 同一候选的 KRC 与 LRC 是两个候选：全收集模式都该入列（酷狗逐字优先）
    const kg = fakeKugou({
      searchSongs: async () => [{ name: '紅蓮華', artist: 'LiSA', durationSec: 237, hash: 'H1', albumAudioId: '1' }],
      lyricCandidates: async () => [{ id: 'a', accesskey: 'k1' }],
      download: async (cand, fmt) => (fmt === 'krc' ? KRC_QILIXIANG : '[00:00.00]行级版本\n[00:03.00]第二行\n[00:06.00]第三行')
    });
    const { fetchLyricsRichAll } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: fakeNetease({ getLyric: async () => null }),
      qq: fakeQq(), kugou: kg, http: fakeHttp()
    });
    const all = await fetchLyricsRichAll(TARGET);
    const fromKg = all.candidates.filter((m) => m.source === 'kugou');
    ok(fromKg.length === 2, '同候选的 KRC 与 LRC 作为两个候选入列', fromKg.map((m) => m.isWordByWord));
    ok(all.best.isWordByWord && all.best.source === 'kugou', '逐字 KRC 质量高于行级，best 是逐字');
  }

  {
    // songsearch 抛异常（超时/网络错）→ 本源自此刻中止，不直查、不下载、不试旧入口。
    // 两个入口同属酷狗，一个炸另一个大概率也炸；静默重试会搅浑诊断日志。
    const kg = fakeKugou({
      searchSongs: async () => { throw new Error('songsearch timeout'); },
      lyricCandidates: async () => [{ id: 'a', accesskey: 'k1' }],
      download: async () => KRC_QILIXIANG,
      search: async () => [{ id: '9', accesskey: 'ak' }]
    });
    const { fetchLyricsRich } = loadLyrics({
      amll: fakeAmll({ getLyric: async () => null }),
      netease: fakeNetease({ getLyric: async () => null }),
      qq: fakeQq({ getLyric: async () => null }),
      kugou: kg, http: fakeHttp()
    });
    const lines = [];
    const m = await fetchLyricsRich(Object.assign({ log: (s) => lines.push(s) }, TARGET));
    ok(m === null, 'songsearch 炸了 → 酷狗无结果（后续源也无）');
    ok(kg.lyricCandidates.calls.length === 0 && kg.download.calls.length === 0 && kg.search.calls.length === 0,
      '异常即中止：不直查、不下载、不试旧入口');
    ok(lines.some((l) => l.indexOf('lyrics[kugou] 失败：songsearch timeout') === 0),
      '异常记一行 kugou 失败日志：' + (lines.find((l) => l.indexOf('kugou') >= 0) || '(无)'));
  }

  console.log('\n' + (fail ? fail + ' 个断言未通过' : 'ALL PASS（' + pass + ' 断言）'));
  process.exit(fail ? 1 : 0);

}

main().catch((e) => { console.error(e); process.exit(1); });
