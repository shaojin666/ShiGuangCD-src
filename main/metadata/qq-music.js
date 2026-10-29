'use strict';
/*
 * qq-music.js —— QQ 音乐歌词源（musicu 接口）。
 *
 * 接口：POST https://u.y.qq.com/cgi-bin/musicu.fcg
 *   {"comm":{"ct":24,"cv":0},"lyric":{"module":"music.musichallSong.PlayLyricInfo",
 *    "method":"GetPlayLyricInfo","param":{"songMID":"xxx","songID":123}}}
 * 返回 lyric.data.{lyric,trans,qrc,roma}，均 base64：
 *   - lyric  ：经典 LRC 文本
 *   - qrc    ：逐字 QRC（部分歌曲才有；可能是 base64 明文 XML，也可能是 3DES 加密 hex）
 *   - trans / roma：译文 / 罗马音 LRC
 *
 * 实测要点（2026-10 验证）：
 *   - musicu 对匿名请求的 qrc 字段多为空（仅部分歌曲开放），拿到时按
 *     "base64 明文"与"3DES 加密 hex"两条路都试（见 qrcDecrypt）。
 *   - 老接口 c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg 只返回 LRC，作兜底。
 */

const { postJson, withTimeout } = require('./http');

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const TIMEOUT_MS = 6000;

/** musicu 请求（POST JSON）。必须走 http.js：测试桩与限速/超时都挂在那一层 */
async function musicu(payload) {
  return withTimeout(
    postJson(MUSICU_URL, payload, {
      referer: 'https://y.qq.com/',
      browser: true,
      timeout: TIMEOUT_MS
    }),
    TIMEOUT_MS,
    'QQ musicu'
  );
}

function b64decode(s) {
  if (!s) return '';
  try {
    let t = String(s).trim();
    while (t.length % 4 !== 0) t += '=';
    return Buffer.from(t, 'base64').toString('utf8');
  } catch (e) { return ''; }
}

/**
 * QRC 解密。QQ 的 qrc 字段有两种形态：
 *   1) base64 明文 XML（`<Qrc>…` 或直接是 `[start,dur]…` 文本）；
 *   2) 十六进制字符串：3DES(ECB, key='!@#)(*$%123ZXC!@!@#)(NHL') 加密后接 raw-deflate。
 * @returns {string|null} 解密后的 QRC 文本
 */
function qrcDecrypt(hexOrB64) {
  if (!hexOrB64) return null;
  const raw = String(hexOrB64).trim();
  if (!raw) return null;

  // 先试 base64 明文
  const plain = b64decode(raw);
  if (plain && (/^\[[\d,]+\]/.test(plain) || /<Qrc[\s>]/.test(plain) || /\[offset:/i.test(plain))) {
    return plain;
  }
  // 再试 3DES + deflate（hex 输入）
  try {
    if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) return null;
    const enc = Buffer.from(raw, 'hex');
    const crypto = require('crypto');
    const zlib = require('zlib');
    const key = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'utf8');
    const decipher = crypto.createDecipheriv('des-ede3', key, Buffer.alloc(0));
    decipher.setAutoPadding(false);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    // 部分密文尾部带零填充，inflate 会报 unexpected end of file /
    // invalid distance 等错误——逐级截断尾零重试（与加密端零填充对齐）
    let text = null;
    let buf = dec;
    for (let tries = 0; tries <= 16 && buf.length > 0; tries++) {
      try { text = zlib.inflateSync(buf).toString('utf8'); break; }
      catch (e) {
        const trimmed = trimTrailingZeros(buf);
        if (!trimmed || trimmed.length === buf.length) break;
        buf = trimmed;
      }
    }
    return text || null;
  } catch (e) {
    return null;
  }
}

/** 去掉缓冲区尾部的连续零字节 */
function trimTrailingZeros(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return end === buf.length ? null : buf.subarray(0, end);
}

/**
 * 取单曲歌词（原始文本四件套）。
 * @param {{mid?:string, songId?:number|string}} song
 * @returns {Promise<{lyric:string,qrc:string,trans:string,roma:string}|null>}
 */
async function getLyric(song) {
  const mid = song && song.mid ? String(song.mid) : '';
  const songId = song && song.songId ? String(song.songId) : '';
  if (!mid && !songId) return null;
  const param = {};
  if (mid) param.songMID = mid;
  if (songId) param.songID = songId;
  let json;
  try {
    json = await musicu({
      comm: { ct: 24, cv: 0 },
      lyric: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param
      }
    });
  } catch (e) {
    json = null;
  }
  const data = json && json.lyric && json.lyric.data;
  if (!data) return null;
  const lyric = b64decode(data.lyric);
  const trans = b64decode(data.trans);
  const roma = b64decode(data.roma);
  let qrc = '';
  if (data.qrc) {
    // qrc 可能是 base64（明文或加密 hex 的 base64 外壳）
    const inner = b64decode(data.qrc) || String(data.qrc);
    qrc = qrcDecrypt(inner) || qrcDecrypt(String(data.qrc)) || '';
  }
  if (!lyric && !qrc) return null;
  return { lyric, qrc, trans, roma };
}

module.exports = { getLyric, qrcDecrypt };
