'use strict';
/* ============================================================
   fl-fonts.test.js —— 主进程字体仓库（main/fl-fonts.js）测试
   ------------------------------------------------------------
   纯 Node，不需要 jsdom：用临时目录当 userData/fonts。
   覆盖：魔数校验 / save-list-read-remove 全流程 / 坏文件拒绝 /
         MIME 撒谎时听魔数的 / 重复上传去重 / 容量与体积上限 /
         index.json 原子写与失效条目清理。
   运行：node tests/fl-fonts.test.js
   ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFlFonts, magicOk, extFromMagic } = require('../main/fl-fonts');

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* 临时目录：每个用例跑完即焚 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-fonts-'));
const mod = createFlFonts(tmp);

/* 最小合法字体字节（按格式的魔数 + 填充） */
function fontBuf(ext, fill) {
  const tag = { ttf: '\u0000\u0001\u0000\u0000', otf: 'OTTO', woff: 'wOFF', woff2: 'wOF2' }[ext];
  return Buffer.concat([Buffer.from(tag, 'latin1'), Buffer.alloc(fill || 64, 7)]);
}
function dataUrlOf(buf, mime) {
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

console.log('# 1. 魔数工具');
check('ttf 魔数（0x00010000）', magicOk(fontBuf('ttf'), 'ttf'));
check('otf 魔数（OTTO）', magicOk(fontBuf('otf'), 'otf'));
check('woff 魔数（wOFF）', magicOk(fontBuf('woff'), 'woff'));
check('woff2 魔数（wOF2）', magicOk(fontBuf('woff2'), 'woff2'));
check('html 错误页拒绝', !magicOk(Buffer.from('<!DOCTYPE html><html>'), 'ttf'));
check('反推 ttf', extFromMagic(fontBuf('ttf')) === 'ttf');
check('反推 woff2', extFromMagic(fontBuf('woff2')) === 'woff2');
check('垃圾反推 null', extFromMagic(Buffer.from('garbage!')) === null);

console.log('# 2. save / list / read / remove 全流程');
const r0 = mod.save({ name: '演示黑体.ttf', dataUrl: dataUrlOf(fontBuf('ttf', 2048), 'font/ttf') });
check('save ok', r0.ok === true, r0);
check('条目带唯一族名', !!r0.font && /^FlFont-[0-9a-f]{12}$/.test(r0.font.family), r0.font);
check('显示名剥掉扩展名', r0.font.name === '演示黑体', r0.font);
check('落盘文件存在', fs.statSync(path.join(tmp, 'fonts', r0.font.id + '.ttf')).isFile());

const list1 = mod.list();
check('list 一条', list1.length === 1 && list1[0].id === r0.font.id, list1);

const r1 = mod.read(r0.font.id);
check('read ok + dataURL 可还原', r1.ok && r1.dataUrl.indexOf('data:font/ttf;base64,') === 0
  && Buffer.from(r1.dataUrl.split(',')[1], 'base64').equals(fontBuf('ttf', 2048)), r1.dataUrl && r1.dataUrl.slice(0, 30));

const r2 = mod.remove(r0.font.id);
check('remove ok', r2.ok === true, r2);
check('文件已删', !fs.existsSync(path.join(tmp, 'fonts', r0.font.id + '.ttf')));
check('list 空', mod.list().length === 0);
check('read 已删条目 → no-font', mod.read(r0.font.id).error === 'no-font');
check('remove 不存在 → no-font', mod.remove('nope').error === 'no-font');

console.log('# 3. 坏文件拒绝');
check('dataURL 非 base64 拒', mod.save({ name: 'x.ttf', dataUrl: 'data:font/ttf,raw' }).error === 'bad-dataurl');
check('空参数拒', mod.save({}).error === 'bad-args');
check('超 32MB 拒', (() => {
  const big = Buffer.concat([fontBuf('ttf', 1024), Buffer.alloc(33 * 1024 * 1024, 1)]);
  const r = mod.save({ name: 'big.ttf', dataUrl: dataUrlOf(big, 'font/ttf') });
  return !r.ok && /too-large/.test(r.error || '');
})());

console.log('# 4. MIME 撒谎 → 听魔数');
const rMime = mod.save({ name: '撒谎.woff', dataUrl: dataUrlOf(fontBuf('ttf', 512), 'application/octet-stream') });
check('octet-stream + ttf 魔数 → 存为 ttf', rMime.ok && rMime.font.ext === 'ttf', rMime.font);
const rFake = mod.save({ name: '假字体.ttf', dataUrl: dataUrlOf(Buffer.from('not a font at all!!'), 'font/ttf') });
check('魔数不符拒收', !rFake.ok && /not-a-font/.test(rFake.error || ''), rFake);
mod.remove(rMime.font.id);

console.log('# 5. 重复上传去重');
const bufA = fontBuf('woff', 300);
const a1 = mod.save({ name: '同名字.woff', dataUrl: dataUrlOf(bufA, 'font/woff') });
const a2 = mod.save({ name: '同名字.woff', dataUrl: dataUrlOf(bufA, 'font/woff') });
check('二次上传复用旧 id', a1.ok && a2.ok && a1.font.id === a2.font.id, [a1.font && a1.font.id, a2.font && a2.font.id]);
check('仓库仍只有一条', mod.list().length === 1, mod.list().length);
mod.remove(a1.font.id);

console.log('# 6. 容量上限');
for (let i = 0; i < 24; i++) mod.save({ name: 'f' + i + '.ttf', dataUrl: dataUrlOf(fontBuf('ttf', 32 + i), 'font/ttf') });
check('装满 24 个', mod.list().length === 24, mod.list().length);
const over = mod.save({ name: 'over.ttf', dataUrl: dataUrlOf(fontBuf('ttf', 8), 'font/ttf') });
check('第 25 个被拒', !over.ok && /too-many/.test(over.error || ''), over);
for (const f of mod.list()) mod.remove(f.id);
check('清空后恢复可存', mod.save({ name: 'again.ttf', dataUrl: dataUrlOf(fontBuf('ttf', 8), 'font/ttf') }).ok === true);
mod.remove(mod.list()[0].id);

console.log('# 7. index.json 失效条目自清理');
const good = mod.save({ name: '幸存者.ttf', dataUrl: dataUrlOf(fontBuf('ttf', 16), 'font/ttf') });
/* 手工往 index.json 塞一条文件已丢失的幽灵条目 */
const idxFile = path.join(tmp, 'fonts', 'index.json');
const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
idx.push({ id: 'ghost', name: '幽灵', family: 'FlFont-ghost', ext: 'ttf', size: 1, addedAt: 'x' });
fs.writeFileSync(idxFile, JSON.stringify(idx));
check('list 过滤幽灵条目', mod.list().length === 1 && mod.list()[0].id === good.font.id, mod.list());
mod.remove(good.font.id);

/* ---- 收尾 ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

if (fails) {
  console.log('\nFAILED: ' + fails + ' 个断言');
  process.exit(1);
}
console.log('\nALL PASS');
