'use strict';
/*
 * itunes.js —— iTunes Search API 兜底源。
 *
 * 定位：**海外/英文碟**的兜底。华语曲库收录很差（实测用中文专辑名搜索返回 0 条），
 * 所以绝不能把它放在主路径上；只在其它源都失败时试一次。
 *
 * 优点：
 *   - 无需 Key、无需 Referer、国内外均可访问；
 *   - `lookup?id=&entity=song` 能一次拿到完整曲目表（含 trackNumber 与时长）；
 *   - artworkUrl100 把末尾的 100x100 换成 600x600 即为大图。
 */

const { getJson, getBuffer, qs, withTimeout } = require('./http');

const TIMEOUT_MS = 7000;

/** artworkUrl100 → 指定尺寸（iTunes 的 URL 规则是替换末尾的尺寸片段） */
function artworkUrl(url, size) {
  if (!url) return null;
  return String(url).replace(/\/\d+x\d+bb\.(jpg|png)$/i, `/${size}x${size}bb.$1`);
}

/** 搜索专辑 */
async function searchAlbums(term, limit = 10) {
  if (!term || !String(term).trim()) return [];
  const url = 'https://itunes.apple.com/search?' + qs({
    term: String(term).trim(),
    entity: 'album',
    limit,
    country: 'us'
  });
  const data = await withTimeout(getJson(url), TIMEOUT_MS, 'iTunes');
  const results = (data && data.results) || [];
  return results.map((r) => ({
    id: r.collectionId,
    name: r.collectionName,
    artist: r.artistName,
    trackCount: r.trackCount || 0,
    year: r.releaseDate ? (parseInt(String(r.releaseDate).slice(0, 4), 10) || null) : null,
    publishTime: r.releaseDate ? Date.parse(r.releaseDate) : 0,
    coverUrl: artworkUrl(r.artworkUrl100, 600),
    company: ''
  }));
}

/** 按专辑 id 取完整曲目表 */
async function getAlbum(collectionId) {
  const url = 'https://itunes.apple.com/lookup?' + qs({
    id: collectionId,
    entity: 'song',
    limit: 200
  });
  const data = await withTimeout(getJson(url), TIMEOUT_MS, 'iTunes lookup');
  const results = (data && data.results) || [];
  const songs = results.filter((r) => r.wrapperType === 'track');
  if (!songs.length) return null;

  const first = songs[0];
  return {
    id: collectionId,
    name: first.collectionName,
    artist: first.artistName,
    year: first.releaseDate ? (parseInt(String(first.releaseDate).slice(0, 4), 10) || null) : null,
    publishTime: first.releaseDate ? Date.parse(first.releaseDate) : 0,
    company: '',
    genres: [first.primaryGenreName].filter(Boolean),
    coverUrl: artworkUrl(first.artworkUrl100, 600),
    tracks: songs.map((s) => ({
      number: s.trackNumber,
      title: s.trackName,
      artist: s.artistName,
      durationSec: s.trackTimeMillis ? s.trackTimeMillis / 1000 : null,
      itunesTrackId: s.trackId
    })).filter((t) => t.number >= 1)
  };
}

async function downloadCover(url) {
  if (!url) return null;
  try {
    const res = await withTimeout(getBuffer(url), TIMEOUT_MS, 'iTunes 封面');
    if (res && res.body && res.body.length > 512 && /^image\//.test(res.contentType)) {
      return res.body;
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

module.exports = { searchAlbums, getAlbum, downloadCover, artworkUrl };
