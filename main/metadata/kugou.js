'use strict';
/*
 * kugou.js —— 酷狗歌词源（KRC 逐字）。
 *
 * ★ 2026-11 重大变化：lyrics.kugou.com/search?keyword=… 对**任何**关键词
 *   恒返回 404（连纯歌名也 404），旧的"关键词直查歌词"入口已死。hash 直查
 *   （krcs.kugou.com/search?hash=…）活得好好的 —— 参考 minerradio 的两段式
 *   配方，本模块已切换为：
 *
 *   第一段（拿 hash）：
 *     GET https://songsearch.kugou.com/song_search_v2
 *     （WebFilter 客户端，免登录；返回 FileHash + MixSongID/EMixSongID）
 *   第二段（拿候选）：
 *     GET https://krcs.kugou.com/search?hash=…&album_audio_id=…&duration=<秒>
 *     （官方推荐候选打头，实测 10~20 个版本；与 lyrics.kugou.com 同 API 不同 host）
 *   第三段（下载解密）：
 *     GET https://krcs.kugou.com/download?fmt=krc
 *     → {content: base64}，解密 = 去 'krc1' 头 → XOR 16 字节 key → zlib inflate
 *     （krcDecrypt 在 lyrics-model.js，本模块只负责网络与候选挑选）
 *
 *   fmt=lrc 可拿行级歌词作兜底；fmt=krc 拿逐字。优先 krc。
 *
 * 关键坑：
 *   - SongName/SingerName 带 <em> 高亮标签，必须剥除再用于匹配
 *   - album_audio_id 优先取数字 MixSongID（酷狗自己的排序分据此给），
 *     退化 EMixSongID（字母数字混合），都没有时退 hash
 *   - keyword 参数在两个 host 上都会触发 404，只用于旧路径兜底
 */

const { getJson, withTimeout, BROWSER_UA } = require('./http');

const SONG_SEARCH_URL = 'https://songsearch.kugou.com/song_search_v2';
// 同 API 双 host 互备：keyword 入口都死了，但 hash 直查两边都正常
const LYRIC_SEARCH_URLS = ['https://krcs.kugou.com/search', 'https://lyrics.kugou.com/search'];
const DOWNLOAD_URLS = ['https://krcs.kugou.com/download', 'https://lyrics.kugou.com/download'];
// 旧 keyword 路径（已 404）：仅当新路径完全无果时花一发兜底，不主动依赖
const LEGACY_SEARCH_URL = 'https://lyrics.kugou.com/search';
const TIMEOUT_MS = 5000;

const UA = { 'User-Agent': BROWSER_UA, Referer: 'https://www.kugou.com/' };

function stripTags(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim();
}

function api(url, params) {
  return withTimeout(getJson(url + '?' + new URLSearchParams(params).toString(), {
    browser: true,
    headers: UA
  }), TIMEOUT_MS, '酷狗歌词');
}

/**
 * 第一段：歌曲搜索（mineradio 配方，WebFilter 客户端免登录）。
 * @param {string} keyword "歌名 歌手"
 * @returns {Promise<Array|null>} 归一化歌曲列表；null = 搜索失败
 */
async function searchSongs(keyword) {
  if (!keyword || !String(keyword).trim()) return null;
  const params = {
    page: '1',
    pagesize: '10',
    userid: '-1',
    clientver: '2000',
    platform: 'WebFilter',
    tag: 'em',
    filter: '2',
    iscorrection: '1',
    privilege_filter: '0',
    filter_ver: '2',
    appid: '1014',
    token: '',
    mid: '1',
    keyword: String(keyword).trim()
  };
  const res = await api(SONG_SEARCH_URL, params);
  if (!res || res.status !== 1 || !res.data || !Array.isArray(res.data.lists)) return null;
  const out = [];
  for (const item of res.data.lists) {
    const song = mapSong(item);
    if (song && song.name && song.hash) out.push(song);
  }
  return out.length ? out : null;
}

/** songsearch 原始条目 → 归一化歌曲（剥 <em>、提炼 album_audio_id） */
function mapSong(item) {
  const mixSongId = item.MixSongID != null ? String(item.MixSongID) : '';
  // 纯数字 MixSongID 优先（酷狗给官方推荐的排序分据此），退化 EMixSongID
  const albumAudioId = (/^\d+$/.test(mixSongId) ? mixSongId : '')
    || String(item.EMixSongID || item.AlbumAudioID || item.album_audio_id || mixSongId || '');
  return {
    name: stripTags(item.SongName),
    artist: stripTags(item.SingerName),
    durationSec: Number(item.Duration) || 0,
    hash: String(item.FileHash || ''),
    albumAudioId,
    album: stripTags(item.AlbumName)
  };
}

/**
 * 第二段：hash 直查歌词候选（官方推荐打头，通常 10~20 个版本）。
 * @param {{hash:string, albumAudioId:string, durationSec:number}} song
 * @returns {Promise<Array|null>} candidates；null = 查询失败
 */
async function lyricCandidates(song) {
  if (!song || !song.hash) return null;
  const params = {
    ver: '1',
    man: 'yes',
    client: 'pc',
    keyword: '',
    duration: String(Math.round(song.durationSec || 0)),
    hash: String(song.hash)
  };
  if (song.albumAudioId) params.album_audio_id = String(song.albumAudioId);
  // 双 host 轮试（同 API 不同 host，互为灾备）
  for (const base of LYRIC_SEARCH_URLS) {
    try {
      const res = await api(base, params);
      if (!res || res.status !== 200 || !Array.isArray(res.candidates)) continue;
      const list = res.candidates.filter((c) => c && c.id && c.accesskey);
      if (list.length) return list;
    } catch (e) { /* 试下一个 host */ }
  }
  return null;
}

/**
 * 旧 keyword 直查路径（入口已 404，仅兜底）。
 * @param {string} keyword
 * @param {number} durationSec 毫秒
 * @returns {Promise<Array|null>}
 */
async function search(keyword, durationSec) {
  if (!keyword || !String(keyword).trim()) return null;
  const params = {
    ver: '1',
    man: 'true',
    client: 'mobi',
    keyword: String(keyword).trim()
  };
  if (durationSec > 0) params.duration = String(Math.round(durationSec * 1000));
  const res = await api(LEGACY_SEARCH_URL, params);
  if (!res || res.status !== 200 || !Array.isArray(res.candidates)) return null;
  return res.candidates.filter((c) => c && c.id && c.accesskey);
}

/**
 * 下载候选歌词的明文文本。
 * @param {{id:string, accesskey:string}} cand
 * @param {'krc'|'lrc'} fmt
 * @returns {Promise<string|null>} KRC/LRC 明文（krc 已解密）
 */
async function download(cand, fmt) {
  if (!cand || !cand.id) return null;
  const params = {
    ver: '1',
    man: 'true',
    client: 'mobi',
    id: String(cand.id),
    accesskey: cand.accesskey || '',
    fmt: fmt || 'krc',
    charset: 'utf8'
  };
  for (const base of DOWNLOAD_URLS) {
    try {
      const res = await api(base, params);
      const content = res && typeof res.content === 'string' ? res.content : '';
      if (!content) continue;
      if (fmt === 'krc') {
        const { krcDecrypt } = require('./lyrics-model');
        try {
          return krcDecrypt(content);
        } catch (e) {
          return null;
        }
      }
      // LRC：base64 明文
      try {
        let t = content.trim();
        while (t.length % 4 !== 0) t += '=';
        return Buffer.from(t, 'base64').toString('utf8');
      } catch (e) {
        return null;
      }
    } catch (e) { /* 试下一个 host */ }
  }
  return null;
}

module.exports = { searchSongs, lyricCandidates, search, download };
