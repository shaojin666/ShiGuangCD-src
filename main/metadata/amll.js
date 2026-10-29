'use strict';
/*
 * amll.js —— AMLL TTML DB 客户端（https://amll.dev/reference/http-api/overview）。
 *
 * 数据形态：社区维护的 TTML 歌词库，人工校对质量最高，
 * 支持词级时间、翻译（x-translation）、罗马音（x-roman）、
 * 对唱（ttm:agent）与背景人声（x-bg）。是逐字歌词的首选源。
 *
 * 实测要点（2026-10 验证）：
 *   - GET /v1/lyrics/get?ncmMusicId=xxx 或 ?qqMusicId=xxx → {status:200,data:{lyrics:'<tt…>',format:'ttml'}}
 *   - GET /v1/lyrics/search?musicName=&artistName=&pageSize=N → items[]（不含 lyrics 字段）
 *   - 未收录：{status:404}；限流约 50 次/秒/IP，命中 429 **不重试**（等下一次自然恢复）
 *   - 同一首歌可能登记多个平台 ID（换音源重发），调用方应逐个尝试
 */

const { getJson, qs, withTimeout } = require('./http');

const BASE = 'https://api.amll.dev';
const TIMEOUT_MS = 5000;

function api(path, params) {
  const url = BASE + path + (params ? '?' + qs(params) : '');
  return withTimeout(getJson(url, { browser: true }), TIMEOUT_MS, 'AMLL');
}

/**
 * 按平台 ID 取 TTML 歌词原文。
 * @param {'ncm'|'qq'} platform
 * @param {string|number} musicId
 * @returns {Promise<string|null>} TTML XML 文本
 */
async function getLyric(platform, musicId) {
  if (!musicId) return null;
  const key = platform === 'qq' ? 'qqMusicId' : 'ncmMusicId';
  const res = await api('/v1/lyrics/get', { [key]: String(musicId) });
  const data = res && res.data;
  const ttml = data && typeof data.lyrics === 'string' ? data.lyrics : '';
  if (!ttml.trim() || !/<tt[\s>]/.test(ttml)) return null;
  return ttml;
}

/**
 * 按关键词搜索歌曲条目（用于没有平台 ID 时反查 ncmMusicId / qqMusicId）。
 * @param {{musicName?:string, artistName?:string, q?:string}} params
 * @returns {Promise<Array<{musicNames:string[],artistNames:string[],albumNames:string[],ncmMusicIds:string[],qqMusicIds:string[]}>|null>}
 *          null 表示搜索失败（网络错误/超时），[] 表示没有结果
 */
async function search(params, pageSize = 8) {
  const q = {};
  if (params.musicName) q.musicName = params.musicName;
  if (params.artistName) q.artistName = params.artistName;
  if (params.q) q.q = params.q;
  q.pageSize = pageSize;
  const res = await api('/v1/lyrics/search', q);
  const items = res && res.data && res.data.items;
  return Array.isArray(items) ? items : null;
}

module.exports = { getLyric, search };
