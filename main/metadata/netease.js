'use strict';
/*
 * netease.js —— 网易云音乐元数据源（大陆地区主力源）。
 *
 * 为什么选它：
 *   1) 国内网络直连可用（实测 <200ms），无需代理、无需 API Key；
 *   2) 华语专辑收录远好于 MusicBrainz / iTunes；
 *   3) 一次请求就能拿到：专辑名、歌手、年份、公司、封面大图、完整曲目表（含轨号与时长）、
 *      以及逐轨的同步歌词。
 *
 * ★ 实测踩坑记录（这些是"接口看起来能用但其实返回错误"的分界点）：
 *   - `api/album/{id}` **已加密**，返回 `{"code":-462,...}`（要求绑手机验证），
 *     必须改用 `api/v1/album/{id}`，它返回明文且含 songs 曲目表；
 *   - 搜索必须带 `Referer: https://music.163.com/` 与浏览器 UA，
 *     否则可能被判定为非浏览器流量；
 *   - 专辑搜索的 type 是 **10**（专辑），歌曲搜索是 1，歌手是 100；
 *   - 封面 URL 追加 `?param=500y500` 可拿到 500×500 的合适尺寸
 *     （原图动辄 1~2MB，500 尺寸约 500KB，实测均返回 200）。
 */

const { getJson, getBuffer, qs, withTimeout, BROWSER_UA } = require('./http');

const BASE = 'https://music.163.com';
const REFERER = 'https://music.163.com/';
/** 单次请求硬超时：网易云正常在 300ms 内返回 */
const NET_TIMEOUT_MS = 7000;
/** 封面目标尺寸 */
const COVER_PARAM = '?param=500y500';

function api(path, params) {
  const url = BASE + path + (params ? '?' + qs(params) : '');
  return withTimeout(getJson(url, {
    referer: REFERER,
    browser: true,
    headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' }
  }), NET_TIMEOUT_MS, '网易云');
}

/* ---------- 搜索 ---------- */

/** 搜索专辑，返回候选列表（含曲目数、年份、封面） */
async function searchAlbums(keyword, limit = 10) {
  if (!keyword || !String(keyword).trim()) return [];
  const data = await api('/api/search/get/web', {
    s: String(keyword).trim(),
    type: 10,
    limit,
    offset: 0
  });
  const albums = (data && data.result && data.result.albums) || [];
  return albums.map((a) => ({
    id: a.id,
    name: a.name,
    artists: (a.artists || []).map((x) => x.name).filter(Boolean),
    artist: (a.artists || []).map((x) => x.name).filter(Boolean).join(' / '),
    trackCount: a.size || 0,
    year: a.publishTime ? new Date(a.publishTime).getFullYear() : null,
    publishTime: a.publishTime || 0,
    coverUrl: a.picUrl || null,
    company: a.company || ''
  }));
}

/** 搜索歌手，拿 artistId（用于按歌手列专辑） */
async function searchArtists(keyword, limit = 5) {
  const data = await api('/api/search/get/web', {
    s: String(keyword).trim(), type: 100, limit, offset: 0
  });
  const artists = (data && data.result && data.result.artists) || [];
  return artists.map((a) => ({
    id: a.id,
    name: a.name,
    alias: a.alias || [],
    albumSize: a.albumSize || 0
  }));
}

/* ---------- 专辑详情（曲目表） ---------- */

/**
 * 从一首歌记录里读出碟号。
 *
 * ★ 多碟专辑错配的根因就在这里，务必理解：
 *   网易云专辑详情接口返回的 `songs` 是**一张碟一个扁平数组**，
 *   多碟专辑时所有碟的歌混在一起，每首歌的 `no` 是**碟内轨号**
 *   （disc1 与 disc2 都会各有一套 1..N），碟号则另存在 `cd` 字段里。
 *
 *   旧实现只取 `s.no` 当轨号、完全忽略 `cd`，于是 disc1 与 disc2 的
 *   前 N 首歌在内部**轨号完全相同（都是 1..N）**，applyTracks 按轨号匹配时
 *   就会把先出现的那一碟（通常是 disc2 或 disc1 中的一个）的歌名与歌词
 *   贴到另一碟上 —— 这正是"disc1 前五首歌的歌词与 disc2 完全一致"的来源。
 *
 *   因此碟号必须显式带出，供上层按 (碟号, 轨号) 精确对应。
 *
 * @returns {number} 碟号（1 起）；无法判定时返回 null
 */
function songDiscNumber(song) {
  if (!song) return null;
  // 网易云在不同接口版本里用过 cd / disc / discNumber 几种字段名，一并兼容
  const raw = song.cd != null ? song.cd
    : song.disc != null ? song.disc
      : song.discNumber;
  const n = Number(raw);
  return isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/**
 * 取专辑完整信息。
 * ★ 必须用 /api/v1/album/ —— /api/album/ 已加密返回 -462。
 */
async function getAlbum(albumId) {
  const data = await api('/api/v1/album/' + albumId);
  if (!data || data.code !== 200) return null;
  const alb = data.album || {};
  const songs = data.songs || [];

  // 逐首读出碟号；缺失时按"碟内轨号回落"推断所属碟
  // （网易云对绝大多数专辑都会给 cd，这一层只是为了兼容老数据）
  let inferredDisc = 1;
  let lastNo = 0;
  const rawTracks = songs.map((s, i) => {
    let disc = songDiscNumber(s);
    let no = Number(s.no);
    if (!isFinite(no) || no < 1) no = i + 1;
    if (disc == null) {
      // 轨号回落（1 之后又出现 1）说明进入了下一张碟
      if (no <= lastNo && lastNo > 0) inferredDisc += 1;
      disc = inferredDisc;
    } else {
      inferredDisc = disc;
    }
    lastNo = no;
    return {
      discNumber: disc,
      number: no,        // ★ 碟内轨号（与 CD 的 TOC 轨号对应）
      title: s.name,
      artist: (s.ar || []).map((a) => a.name).filter(Boolean).join(' / '),
      durationSec: s.dt ? s.dt / 1000 : null,
      neteaseSongId: s.id
    };
  }).filter((t) => t.number >= 1);

  // 碟总数 = 出现过的最大碟号
  let discTotal = 0;
  for (const t of rawTracks) discTotal = Math.max(discTotal, t.discNumber);
  if (!discTotal) discTotal = 1;

  return {
    id: alb.id || albumId,
    name: alb.name,
    artist: (alb.artists || []).map((a) => a.name).filter(Boolean).join(' / ') ||
      (alb.artist && alb.artist.name) || '',
    // ★ 首位艺人的 id：歌手介绍（artistIntro）按它去 /api/v1/artist 取。
    //   专辑详情本身不含歌手简介，必须再问一次歌手接口。
    artistId: (alb.artists && alb.artists[0] && alb.artists[0].id) || null,
    year: alb.publishTime ? new Date(alb.publishTime).getFullYear() : null,
    publishTime: alb.publishTime || 0,
    company: alb.company || '',
    description: alb.description || alb.briefDesc || '',
    genres: (alb.tags || []).map((t) => t && t.name).filter(Boolean).slice(0, 3),
    coverUrl: alb.picUrl || null,
    // ★ 碟总数：供上层判断"是否多碟专辑"，以及渲染端角标的 "x/y"
    discTotal,
    tracks: rawTracks
  };
}

/**
 * 把（可能含多碟的）曲目表按碟号切开。
 * @returns {Map<number, Array>} discNumber -> tracks
 */
function groupByDisc(tracks) {
  const map = new Map();
  for (const t of tracks || []) {
    const d = Number(t.discNumber) >= 1 ? Math.floor(Number(t.discNumber)) : 1;
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(t);
  }
  return map;
}

/**
 * 取某一张碟的曲目子集；若该碟号不存在则返回空数组。
 * 这是修复"多碟专辑错配"的关键：上层必须先切碟再按轨号匹配，
 * 否则各碟的 1..N 会互相串味。
 */
function tracksOfDisc(tracks, discNumber) {
  const d = Math.floor(Number(discNumber)) || 1;
  return (tracks || []).filter((t) => (Number(t.discNumber) >= 1 ? Math.floor(Number(t.discNumber)) : 1) === d);
}

/* ---------- 歌手详情（歌手介绍） ---------- */

/**
 * 取歌手信息（v10.4：专辑详情页的"歌手介绍"数据源）。
 *
 * ★ 必须用 /api/v1/artist/：与专辑详情同理，/api/artist/ 已加密返回 -462。
 *   briefDesc 是网易云维护的歌手简介（通常几百字），identified 字段是
 *   认证信息（流派/国籍），一并带出供界面拼装。
 *
 * @param {number} artistId
 * @returns {Promise<{id:number,name:string,briefDesc:string}|null>}
 */
async function getArtistDetail(artistId) {
  const id = Number(artistId);
  if (!isFinite(id) || id <= 0) return null;
  const data = await api('/api/v1/artist/' + id);
  if (!data || data.code !== 200) return null;
  const ar = data.artist || {};
  const brief = String(ar.briefDesc || '').trim();
  if (!brief) return null;
  return {
    id: ar.id || id,
    name: ar.name || '',
    briefDesc: brief
  };
}

/* ---------- 歌词 ---------- */

/**
 * 取单曲歌词（优先同步 LRC）。
 *
 * 返回 { lyrics, synced, translation, romanization, yrc, source }：
 *   - lyrics / translation / romanization：经典 LRC 文本（行级），synced 标记有无时间轴
 *   - yrc：逐字歌词原文（网易云 yrc 混合格式），没有则为 null
 *
 * ★ 逐字歌词必须走 `/api/song/lyric/v1`（带 yv/ytv/yrv 参数）：
 *   旧接口 `/api/song/lyric` 根本不返回 yrc 字段（2026-10 实测）。
 *   但 v1 的 lrc.lyric 是 **JSON 结构**（{"t":ms,"c":[{"tx":…}]}），不是经典 LRC 文本，
 *   所以两个接口都要留：v1 拿 yrc/ytlrc/yromalrc，旧接口拿经典 lrc/tlyric 作兜底。
 */
async function getLyric(songId) {
  if (!songId) return null;

  let yrc = null;
  let ytlrc = null;
  let yromalrc = null;
  try {
    const v1 = await api('/api/song/lyric/v1', {
      id: songId, cp: 0, tv: 1, lv: 1, rv: 1, kv: 1, yv: 1, ytv: 1, yrv: 1
    });
    const pick = (k) => {
      const o = v1 && v1[k];
      return o && typeof o.lyric === 'string' && o.lyric.trim() ? o.lyric : null;
    };
    yrc = pick('yrc');
    ytlrc = pick('ytlrc');
    yromalrc = pick('yromalrc');
  } catch (e) { /* v1 失败落到旧接口 */ }

  try {
    const data = await api('/api/song/lyric', { id: songId, lv: 1, tv: -1, kv: -1 });
    const lrc = (data && data.lrc && data.lrc.lyric) || '';
    const tlyric = (data && data.tlyric && data.tlyric.lyric) || '';
    const romalrc = (data && data.romalrc && data.romalrc.lyric) || '';
    if (!lrc.trim() && !yrc) return null;
    return {
      lyrics: lrc.trim(),
      // 是否含 [mm:ss.xx] 时间标签
      synced: /\[\d{1,2}:\d{1,2}([.:]\d{1,3})?\]/.test(lrc),
      translation: tlyric.trim() || null,
      romanization: romalrc.trim() || null,
      // ★ yrc 专用译文轨（与 yrc 行级时间严格对应，优先于经典 tlyric）
      yrcTranslation: ytlrc || null,
      yrcRomanization: yromalrc || null,
      yrc: yrc || null,
      source: 'netease'
    };
  } catch (e) {
    // 旧接口也失败：有 yrc 就还有救
    if (yrc) {
      return {
        lyrics: '', synced: false,
        translation: null, romanization: null,
        yrcTranslation: ytlrc, yrcRomanization: yromalrc,
        yrc, source: 'netease'
      };
    }
    return null;
  }
}

/* ---------- 封面 ---------- */

/** 下载封面并转成适合归档的尺寸；失败返回 null */
async function downloadCover(url) {
  if (!url) return null;
  const withParam = url.indexOf('?') >= 0 ? url : url + COVER_PARAM;
  try {
    const res = await withTimeout(getBuffer(withParam, {
      referer: REFERER,
      browser: true
    }), NET_TIMEOUT_MS, '网易云封面');
    if (res && res.body && res.body.length > 512 && /^image\//.test(res.contentType)) {
      return res.body;
    }
  } catch (e) { /* 无封面不影响其它字段 */ }
  return null;
}

/* ---------- 打分选优 ---------- */

/** 名称归一化：去空格/大小写/常见标点，便于中文标题比较 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_·、，,。.（）()\[\]【】'"“”‘’:：/\\|]/g, '');
}

/**
 * 在候选专辑中挑选与本张 CD 最匹配的一张。
 *
 * ★ 打分的核心原则：**专辑身份靠"名称 + 艺人"确认，而不是"轨数一致"。**
 *
 * 这一点是踩过坑才改的。旧实现把曲目数当成硬门槛（不一致就重罚 -5），
 * 结果一张宇多田光的精选集碟（用户手里是 5 轨的分卷）在网易云的候选是
 * 18 轨完整版 —— 名称、艺人全对，只因轨数差 13 就被一票否决，
 * 于是**网易云阶段整个被跳过，封面、歌词、艺术家全部丢失**。
 *
 * 而"同一专辑的不同版本轨数不同"在现实里极其常见：
 *   - 精选集 / 分卷碟（用户手里是其中一辑）
 *   - 网易云收录的是 Deluxe 版（多几首 Bonus）
 *   - 单曲碟 vs 专辑版
 * 这类情况专辑名与艺人高度吻合，应当采信（只为拿封面/歌词/艺人），
 * 曲目名则交给 fetch.js 按"时长逐轨对应"决定是否覆盖（不吻合就不改，不会错位）。
 *
 * 因此轨数的角色从"门槛"改为"加分项"：一致说明更可信，不一致也不否定，
 * 只是不加分；并且**只在名称或艺人也对得上时**才有意义。
 *
 * 打分维度：
 *   1) 专辑名：完全一致 +6，包含关系 +3；
 *   2) 艺人：完全一致 +4，包含关系 +2；
 *   3) 轨数一致 +3（作为佐证，不作为门槛）；
 *   4) 有封面 +1。
 *
 * 可信度门槛仍保留（score >= 3），避免把无关专辑糊上去 —— 而"名称完全一致"
 * 单独就能拿到 6 分，所以真正对得上的专辑不会因为轨数不同而落选。
 *
 * @param {Array} candidates searchAlbums 的结果
 * @param {object} want { album, artist, trackCount }
 */
function pickAlbum(candidates, want) {
  if (!candidates || !candidates.length) return null;
  const wantName = norm(want.album);
  const wantArtist = norm(want.artist);
  const scored = candidates.map((c) => {
    let score = 0;
    const cName = norm(c.name);
    const cArtist = norm(c.artist);

    let nameHit = 0;
    if (wantName) {
      if (cName === wantName) { score += 6; nameHit = 2; }
      else if (cName.indexOf(wantName) >= 0 || wantName.indexOf(cName) >= 0) { score += 3; nameHit = 1; }
    }
    let artistHit = 0;
    if (wantArtist && cArtist) {
      if (cArtist === wantArtist) { score += 4; artistHit = 2; }
      else if (cArtist.indexOf(wantArtist) >= 0 || wantArtist.indexOf(cArtist) >= 0) { score += 2; artistHit = 1; }
    }
    // 轨数一致只作加分（且要求在名称或艺人上已有呼应，避免"轨数巧合同为 N"的误认）
    if (want.trackCount > 0 && c.trackCount === want.trackCount && (nameHit || artistHit)) {
      score += 3;
    }
    if (c.coverUrl) score += 1;
    return { candidate: c, score, nameHit, artistHit };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 3) return null;
  // 名称与艺人**都没**对上时，即使分数够（靠封面/轨数凑的）也不采信
  if (!best.nameHit && !best.artistHit) return null;
  return best;
}

/**
 * 校验网易云专辑的曲目时长与本碟 TOC 时长是否吻合。
 * 用于防止"曲目数恰好相同但其实是另一张碟"的误匹配。
 *
 * ★ 注意：本函数接收的应当是**已经切好碟**的曲目表
 *   （用 tracksOfDisc 取子集后再传入），否则多碟专辑会拿
 *   disc2 的第一首去比 disc1 的第一首，吻合度完全失真。
 *
 * @returns {number} 0~1 的吻合度（逐轨比对，容差 8 秒）
 */
function durationMatchRatio(albumTracks, tocTracks) {
  if (!albumTracks || !tocTracks || !tocTracks.length) return 0;
  let hit = 0;
  let cmp = 0;
  const n = Math.min(albumTracks.length, tocTracks.length);
  for (let i = 0; i < n; i++) {
    const a = albumTracks[i].durationSec;
    const t = tocTracks[i].durationSec;
    if (!a || !t) continue;
    cmp++;
    if (Math.abs(a - t) <= 8) hit++;
  }
  return cmp ? hit / cmp : 0;
}

/**
 * 搜索单曲（歌词反查用：没有专辑级 neteaseSongId 时，按 歌名+歌手 找 songId）。
 * @returns {Promise<Array<{id:number,name:string,artist:string,durationSec:number|null,album:string}>>}
 */
async function searchSongs(keyword, limit = 5) {
  if (!keyword || !String(keyword).trim()) return [];
  const data = await api('/api/search/get/web', {
    s: String(keyword).trim(), type: 1, limit, offset: 0
  });
  const songs = (data && data.result && data.result.songs) || [];
  return songs.map((s) => ({
    id: s.id,
    name: s.name,
    artist: (s.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
    album: (s.album && s.album.name) || '',
    durationSec: s.duration ? s.duration / 1000 : null
  }));
}

module.exports = {
  searchAlbums,
  searchArtists,
  searchSongs,
  getAlbum,
  getArtistDetail,
  getLyric,
  downloadCover,
  pickAlbum,
  durationMatchRatio,
  groupByDisc,
  tracksOfDisc,
  songDiscNumber,
  norm
};
