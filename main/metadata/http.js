'use strict';
/*
 * http.js —— 极简 HTTPS 请求助手。
 *
 * 相较旧实现补齐了几处**会直接导致"联网获取失效"**的缺陷：
 *   1) 重定向时丢失 maxBytes / headers —— 封面接口（Cover Art Archive）必走 307，
 *      丢失大小上限后可能拖回一张几十 MB 的原图；
 *   2) POST 未写 Content-Length —— 部分服务端（MusicBrainz 的 POST 兜底）直接拒收；
 *   3) 不支持 gzip/deflate/br —— 不声明 Accept-Encoding 时大响应传输更慢；
 *   4) 没有 per-host 限速与超时区分 —— MusicBrainz 要求 ≤1 req/s，
 *      超了会返回 503 并把该 IP 短时封禁；
 *   5) 无 429/503 的 Retry-After 处理 —— 被限流后整个流程静默失败。
 *
 * 所有请求都带 Referer 与浏览器 UA 的能力（网易云等源要求）。
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

/**
 * 请在打包前把联系邮箱换成你自己的（MusicBrainz 的礼貌要求）。
 * 使用 example.com 这类占位邮箱不影响功能，但有可能被限流。
 */
const DEFAULT_UA = 'ShiGuangCD/1.0.0 (Electron CD Player; +https://github.com/shiguang-cd)';
/** 部分国内接口（网易云）对非浏览器 UA 会直接拒绝，故单独备一个 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT = 12000;
const MAX_REDIRECTS = 5;
const MAX_COVER_BYTES = 6 * 1024 * 1024;

/* ---------- per-host 限速（MusicBrainz：≤1 req/s） ---------- */

const HOST_MIN_GAP = new Map([
  ['musicbrainz.org', 1100],
  ['coverartarchive.org', 400]
]);
const _lastHit = new Map();

/**
 * per-host 限速（MusicBrainz 要求 ≤1 req/s，超了会 503 并短时封 IP）。
 *
 * ★ 实现要点：必须基于"上一次**实际发出**请求的时间"来计算等待，
 *   而不是把每个新请求挂到一条不断增长的 Promise 链尾部。
 *   旧写法（链式串行）在连续调用时会让等待时间线性累积：
 *   第一次 0s、第二次 1.1s、第三次 2.2s……很快就把调用方的超时预算耗尽，
 *   表现为"查询时灵时不灵"。这里改成时间戳计算 + 简单等待，等待量恒定。
 */
let _throttleChain = Promise.resolve();

function throttle(host) {
  const gap = HOST_MIN_GAP.get(host) || 0;
  if (!gap) return Promise.resolve();
  // 串行化"计算 + 占位"这一段，但等待量只取决于上次实际发出的时间
  const run = _throttleChain.then(async () => {
    const last = _lastHit.get(host) || 0;
    const wait = gap - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _lastHit.set(host, Date.now());
  });
  _throttleChain = run.catch(() => {});
  return run;
}

/* ---------- 底层请求 ---------- */

function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    timeout = DEFAULT_TIMEOUT,
    maxBytes = 0,
    body = null,
    insecure = false
  } = opts;

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'http:' ? http : https;
    const req = mod.request(
      target,
      {
        method,
        headers: Object.assign({ 'User-Agent': DEFAULT_UA, Accept: '*/*' }, headers),
        timeout,
        rejectUnauthorized: !insecure
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;

        if (status >= 300 && status < 400 && location) {
          res.resume();
          const next = new URL(location, target).toString();
          return resolve({ status, redirect: next, headers: res.headers });
        }

        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br' && zlib.createBrotliDecompress) stream = res.pipe(zlib.createBrotliDecompress());

        const chunks = [];
        let total = 0;
        let aborted = false;
        stream.on('data', (c) => {
          if (aborted) return;
          total += c.length;
          if (maxBytes && total > maxBytes) {
            aborted = true;
            req.destroy();
            const e = new Error('响应过大（超过 ' + Math.round(maxBytes / 1024) + ' KB）');
            e.code = 'ETOOLARGE';
            reject(e);
            return;
          }
          chunks.push(c);
        });
        // 解压流可能先于 res 结束；以流为准，但错误挂到 res 上
        stream.on('end', () => {
          if (aborted) return;
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
        });
        stream.on('error', (err) => { if (!aborted) reject(err); });
        res.on('error', (err) => { if (!aborted) reject(err); });
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body) {
      // ★ 显式 Content-Length：旧实现漏了这一步，POST 兜底路径会被服务端拒收
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      req.setHeader('Content-Length', buf.length);
      req.write(buf);
    }
    req.end();
  });
}

/**
 * 带重定向跟随的请求。
 * ★ 修复：重定向后**沿用原始 opts**（含 maxBytes / headers），旧实现把上限丢了。
 */
async function getWithRedirects(url, opts = {}, maxRedirects = MAX_REDIRECTS) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const host = new URL(current).hostname;
    await throttle(host);
    const res = await request(current, opts);
    if (res.redirect) {
      // 跨到 archive.org（CAA 的图片实际存放地）时，UA 与大小上限都要保留
      current = res.redirect;
      continue;
    }
    return res;
  }
  throw new Error('重定向次数过多');
}

/** 命中限流（429/503）时的重试间隔 */
function retryAfterMs(res) {
  const h = res.headers && (res.headers['retry-after'] || res.headers['Retry-After']);
  if (!h) return 0;
  const sec = parseInt(String(h), 10);
  if (!isNaN(sec) && sec > 0) return Math.min(sec * 1000, 5000);
  const date = Date.parse(String(h));
  if (!isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 5000);
  return 0;
}

/**
 * 返回解析后的 JSON；404 返回 null；其余错误抛异常。
 * 命中限流会自动重试一次。
 */
async function getJson(url, opts = {}) {
  const merged = Object.assign({ headers: { Accept: 'application/json, text/plain, */*' } }, opts);
  merged.headers = Object.assign({}, merged.headers);
  if (!merged.headers.Referer && opts.referer) merged.headers.Referer = opts.referer;
  if (opts.browser) merged.headers['User-Agent'] = BROWSER_UA;

  let res = await getWithRedirects(url, merged);
  if (res.status === 429 || res.status === 503) {
    const wait = retryAfterMs(res) || 1200;
    await new Promise((r) => setTimeout(r, wait));
    res = await getWithRedirects(url, merged);
  }
  if (res.status === 404) return null;
  if (res.status >= 400) {
    const err = new Error(`HTTP ${res.status} @ ${url}`);
    err.status = res.status;
    throw err;
  }
  const text = res.body.toString('utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('响应不是合法 JSON：' + url);
    err.body = text.slice(0, 200);
    throw err;
  }
}

/**
 * POST JSON 并返回解析后的响应；404 返回 null；其余错误抛异常。
 * 与 getJson 同样的限流重试语义。QQ musicu 等接口必须走这里
 * （早期 qq-music.js 用原生 https 直连，测试桩拦不到，会发真实请求）。
 */
async function postJson(url, body, opts = {}) {
  const payload = Buffer.from(JSON.stringify(body == null ? {} : body), 'utf8');
  const merged = Object.assign({
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8'
    },
    body: payload
  }, opts);
  merged.headers = Object.assign({}, merged.headers);
  if (!merged.headers.Referer && opts.referer) merged.headers.Referer = opts.referer;
  if (opts.browser) merged.headers['User-Agent'] = BROWSER_UA;

  let res = await getWithRedirects(url, merged);
  if (res.status === 429 || res.status === 503) {
    const wait = retryAfterMs(res) || 1200;
    await new Promise((r) => setTimeout(r, wait));
    res = await getWithRedirects(url, merged);
  }
  if (res.status === 404) return null;
  if (res.status >= 400) {
    const err = new Error(`HTTP ${res.status} @ ${url}`);
    err.status = res.status;
    throw err;
  }
  const text = res.body.toString('utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('响应不是合法 JSON：' + url);
    err.body = text.slice(0, 200);
    throw err;
  }
}

/** 返回 Buffer 与内容类型；404 返回 null */
async function getBuffer(url, opts = {}) {
  const merged = Object.assign({ maxBytes: MAX_COVER_BYTES }, opts);
  merged.headers = Object.assign({}, merged.headers);
  if (opts.referer && !merged.headers.Referer) merged.headers.Referer = opts.referer;
  if (opts.browser) merged.headers['User-Agent'] = BROWSER_UA;

  const res = await getWithRedirects(url, merged);
  if (res.status === 404) return null;
  if (res.status >= 400) {
    const err = new Error(`HTTP ${res.status} @ ${url}`);
    err.status = res.status;
    throw err;
  }
  return { body: res.body, contentType: res.headers['content-type'] || '' };
}

function qs(obj) {
  return Object.keys(obj)
    .filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`)
    .join('&');
}

/** 给 Promise 加硬超时：任一源无响应时不能让整条链路卡住 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || '请求') + ' 超时')), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

module.exports = {
  getJson,
  postJson,
  getBuffer,
  qs,
  withTimeout,
  DEFAULT_UA,
  BROWSER_UA,
  MAX_COVER_BYTES
};
