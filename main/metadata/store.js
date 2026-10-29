'use strict';
/*
 * store.js —— 本地元数据仓库。
 * 位置：<userData>/metadata/，每个光盘一份 <signature>.json 与可选封面 <signature>.jpg。
 * 手动编辑不会在在线刷新时被覆盖（manual 标记）。
 */

const fs = require('fs');
const path = require('path');

class MetadataStore {
  constructor(userDataDir) {
    this.dir = path.join(userDataDir, 'metadata');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  sigFile(sig) {
    return path.join(this.dir, sig + '.json');
  }

  coverFile(sig) {
    return path.join(this.dir, sig + '.jpg');
  }

  get(sig) {
    try {
      const raw = fs.readFileSync(this.sigFile(sig), 'utf8');
      const data = JSON.parse(raw);
      data.hasCover = fs.existsSync(this.coverFile(sig));
      return data;
    } catch (e) {
      return null;
    }
  }

  list() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (e) { return out; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (!data || !data.signature) continue;
        data.hasCover = fs.existsSync(this.coverFile(data.signature));
        out.push(data);
      } catch (e) { /* 跳过损坏记录 */ }
    }
    out.sort((a, b) => String(b.fetchedAt || '').localeCompare(String(a.fetchedAt || '')));
    return out;
  }

  save(data) {
    const file = this.sigFile(data.signature);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  remove(sig) {
    for (const f of [this.sigFile(sig), this.coverFile(sig)]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* 忽略 */ }
    }
  }

  saveCover(sig, buffer) {
    fs.writeFileSync(this.coverFile(sig), buffer);
  }
}

module.exports = { MetadataStore };
