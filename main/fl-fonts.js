'use strict';
/* ============================================================
   fl-fonts.js —— 全屏歌词演出层「用户字体仓库」（主进程侧）
   ------------------------------------------------------------
   存放位置：userData/fonts/
     <id>.<ext>   字体文件本体
     index.json   清单（原子写：先 tmp 后 rename）

   设计要点：
   - id 随机生成，内部 font-family 名 = "FlFont-<id>"，与用户给的
     显示名解耦 —— 两个不同的文件都叫「思源黑体」也不会在 @font-face
     层面撞名（撞名的后果是浏览器随机挑一个，极难排查）。
   - 魔数校验：ttf 00 01 00 00 / 'true' / 'OTTO'，woff 'wOFF'，
     woff2 'wOF2'。dataURL 的 MIME 只作辅助判断，**以魔数为准** ——
     用户从奇怪来源拖进来的 .ttf 实际是个 html 错误页也不该进仓库。
   - 容量上限：文件数 ≤ MAX_COUNT，单文件 ≤ MAX_BYTES（中文字体
     ttf 常见 8~15MB，放宽到 32MB）。
   - 清单原子写，避免崩溃时 index.json 写一半。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* 扩展名 → MIME（read 时按 ext 推 dataURL 的 MIME） */
const EXT_MIME = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2'
};

/* dataURL MIME → ext（浏览器 File.type 在不同平台给的值不一样） */
const MIME_EXT = {
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'application/x-font-ttf': 'ttf',
  'application/x-font-otf': 'otf',
  'application/font-woff': 'woff',
  'application/font-woff2': 'woff2',
  'application/octet-stream': null /* 靠魔数推 */
};

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_COUNT = 24;

/** 按扩展名校验文件头魔数；返回 true 表示确实是该格式的字体 */
function magicOk(buf, ext) {
  if (!buf || buf.length < 4) return false;
  const tag = buf.toString('latin1', 0, 4);
  if (ext === 'ttf') {
    return tag === '\u0000\u0001\u0000\u0000' || tag === 'true' || tag === 'OTTO';
  }
  if (ext === 'otf') return tag === 'OTTO' || tag === '\u0000\u0001\u0000\u0000';
  if (ext === 'woff') return tag === 'wOFF';
  if (ext === 'woff2') return tag === 'wOF2';
  return false;
}

/** 魔数反推扩展名（MIME 不可信时用） */
function extFromMagic(buf) {
  if (!buf || buf.length < 4) return null;
  const tag = buf.toString('latin1', 0, 4);
  if (tag === 'wOFF') return 'woff';
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'OTTO') return 'otf';
  if (tag === '\u0000\u0001\u0000\u0000' || tag === 'true') return 'ttf';
  return null;
}

function createFlFonts(userDataDir) {
  const dir = path.join(userDataDir, 'fonts');
  const indexFile = path.join(dir, 'index.json');

  let cache = null; /* [{id,name,family,ext,size,addedAt}] */

  function readIndex() {
    if (cache) return cache;
    try {
      const arr = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      cache = Array.isArray(arr) ? arr : [];
    } catch (e) {
      cache = [];
    }
    return cache;
  }

  /** 原子写清单；顺手剔除文件已丢失的条目 */
  function writeIndex(list) {
    const alive = list.filter((f) => {
      try { return fs.statSync(path.join(dir, f.id + '.' + f.ext)).isFile(); }
      catch (e) { return false; }
    });
    fs.mkdirSync(dir, { recursive: true });
    const tmp = indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(alive, null, 2), 'utf8');
    fs.renameSync(tmp, indexFile);
    cache = alive;
  }

  function list() {
    /* 读盘时顺手清理失效条目（用户手动删过文件等情况） */
    const all = readIndex();
    const alive = all.filter((f) => {
      try { return fs.statSync(path.join(dir, f.id + '.' + f.ext)).isFile(); }
      catch (e) { return false; }
    });
    if (alive.length !== all.length) writeIndex(alive);
    return alive.map((f) => Object.assign({}, f));
  }

  /**
   * @param {{name:string, dataUrl:string}} p
   * @returns {{ok:boolean, error?:string, font?:object}}
   */
  function save(p) {
    const name = p && typeof p.name === 'string' ? p.name : '';
    const dataUrl = p && typeof p.dataUrl === 'string' ? p.dataUrl : '';
    if (!name || !dataUrl) return { ok: false, error: 'bad-args' };
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
    if (!m || !m[2]) return { ok: false, error: 'bad-dataurl' };

    let buf;
    try { buf = Buffer.from(m[3], 'base64'); } catch (e) { return { ok: false, error: 'bad-base64' }; }
    if (!buf.length) return { ok: false, error: 'empty' };
    if (buf.length > MAX_BYTES) {
      return { ok: false, error: 'too-large: ' + Math.round(buf.length / 1048576) + 'MB > ' + Math.round(MAX_BYTES / 1048576) + 'MB' };
    }

    /* 扩展名判定：MIME 优先，魔数兜底且可推翻 MIME */
    let ext = MIME_EXT[m[1]] || null;
    const magic = extFromMagic(buf);
    if (magic && ext !== magic) ext = magic;   /* MIME 撒谎，听魔数的 */
    if (!ext) ext = magic;
    if (!ext) return { ok: false, error: 'not-a-font: 文件头不是 ttf/otf/woff/woff2' };
    if (!magicOk(buf, ext)) return { ok: false, error: 'not-a-font: 魔数校验失败（' + ext + '）' };

    const all = list();
    if (all.length >= MAX_COUNT) {
      return { ok: false, error: 'too-many: 最多 ' + MAX_COUNT + ' 个自定义字体' };
    }
    /* 同名同内容重复上传：直接复用旧条目，不膨胀仓库。
       注意比对用**剥扩展名后的显示名**（entry.name 是剥过的），
       否则同名重复上传永远判不中。 */
    const dispName = name.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/i, '').slice(0, 40) || '自定义字体';
    const dup = all.find((f) => f.size === buf.length && f.name === dispName);
    if (dup) {
      try {
        const old = fs.readFileSync(path.join(dir, dup.id + '.' + dup.ext));
        if (old.equals(buf)) return { ok: true, font: Object.assign({}, dup) };
      } catch (e) { /* 继续走新建 */ }
    }

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const entry = {
      id: id,
      name: dispName,
      family: 'FlFont-' + id,
      ext: ext,
      size: buf.length,
      addedAt: new Date().toISOString()
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + '.' + ext), buf);
    } catch (e) {
      return { ok: false, error: 'write-failed: ' + (e && e.message ? e.message : e) };
    }
    all.push(entry);
    writeIndex(all);
    return { ok: true, font: Object.assign({}, entry) };
  }

  /** @returns {{ok:boolean, error?:string, dataUrl?:string}} */
  function read(id) {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'bad-args' };
    const entry = list().find((f) => f.id === id);
    if (!entry) return { ok: false, error: 'no-font' };
    try {
      const buf = fs.readFileSync(path.join(dir, entry.id + '.' + entry.ext));
      const mime = EXT_MIME[entry.ext] || 'application/octet-stream';
      return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
    } catch (e) {
      return { ok: false, error: 'read-failed' };
    }
  }

  /** @returns {{ok:boolean, error?:string}} */
  function remove(id) {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'bad-args' };
    const all = list();
    const entry = all.find((f) => f.id === id);
    if (!entry) return { ok: false, error: 'no-font' };
    try { fs.unlinkSync(path.join(dir, entry.id + '.' + entry.ext)); } catch (e) { /* 可能已丢 */ }
    writeIndex(all.filter((f) => f.id !== id));
    return { ok: true };
  }

  return { list, save, read, remove };
}

module.exports = { createFlFonts, magicOk, extFromMagic };
