'use strict';
/*
 * 生成应用图标：圆形深色 CD，**扁平化**风格。
 * 纯 Node 实现（只用内置 zlib），输出：
 *   build/icon.png  —— 256×256 主图
 *   build/icon.ico  —— 16/24/32/48/64/128/256 七档（Windows 会挑最接近的一档，
 *                      而不是把 256 缩下去；细环在小尺寸下才不会糊）
 *   node tools/generate-icon.js --preview <路径>  额外输出一张尺寸对照图（自查用）
 *
 * 设计说明
 * ------------------------------------------------------------
 * 扁平化 = 只有实心色块，没有渐变、没有高光、没有斜面/描边阴影。
 * 所以盘面刻意只用**同心的几段实色**表达，靠色阶而不是光影来分层：
 *
 *   真实 CD 的结构（半径占比，半径 R 为盘半径）照搬了过来，
 *   这样即使全是纯色块，一眼也还是"一张 CD"而不是"一个圆":
 *     · 中心孔   0.125R   —— 真 CD 是 7.5mm / 60mm
 *     · 夹持区   0.125–0.42R —— 真 CD 是 25mm / 60mm
 *     · 数据区   0.42–1.0R
 *
 * 三处刻意的取舍：
 *  1. **圆外透明**（不是填深色方块）。扁平图标配一个不透明的深色方角，
 *     在浅色任务栏上就是一块方砖；透明角才是圆形图标该有的样子。
 *     中心孔同样透明 —— 真 CD 那里本来就是空的。
 *  2. **金色只留一圈细线**（--accent，与界面同一色），压在夹持区与数据区的
 *     分界上。那条分界是 CD 最容易被认出来的特征，一个色环就够，
 *     多了就不是扁平而是花。
 *  3. **边缘要比盘面亮一档**。深色盘面放到浅色背景上时轮廓会"化开"，
 *     留 4.5% 半径的浅色边能把圆守住；这是唯一的"修饰"，也只是换了个实色。
 *
 * 抗锯齿：每个像素取 4×4 = 16 个子样本，按"实色 + 覆盖率"合成。
 * 之前用硬阈值判半径，边缘是台阶状的锯齿 —— 16px 任务栏尺寸下尤其明显。
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------- 配色（取自 renderer/css/base.css 的 :root，深色主题） ----------
 * ★ 扁平图标对"明度差"的要求比对"颜色好看"高得多：色块之间必须一眼分得开，
 *   否则一整块糊成一个黑剪影，完全不像 CD。
 *   所以这几档是**故意拉开**的（#26 → #34 → #4A），而不是都取 --surface 那种
 *   彼此只差几个值的深色 —— 那是给界面用的，放到图标上会失效。
 *   由内到外：中心孔(透明) → 夹持区 → 金环 → 数据区 → 外缘，亮度逐级抬高。
 */
const CLR_HUB = [62, 62, 74];       // 夹持区（哑光面）
const CLR_RING = [206, 170, 110];  // --accent 金色细环（比 --accent 提一点亮度，小尺寸下更清楚）
const CLR_DATA = [40, 40, 49];     // 数据区（主色，占面积最大）
const CLR_RIM = [86, 86, 98];      // 最外缘，浅一档压住轮廓

/* ---------- 结构（全部是盘半径 R 的比例） ---------- */
const R_HOLE = 0.125;    // 中心孔半径（真 CD 7.5mm / 60mm）
const R_RING_IN = 0.340; // 金色环内缘
const RING_W = 0.092;    // 金色环宽度
const R_HUB_OUT = 0.432; // 夹持区外缘（真 CD 25mm / 60mm，向上取整到金环外缘）
const R_RIM = 0.922;     // 外缘起始（宽一点才看得出"有一圈边"，细了等于没有）

/** 单个采样点的颜色 + 覆盖率（0 表示完全透明） */
function sample(x, y, cx, cy, R) {
  const dx = x - cx, dy = y - cy;
  const r = Math.sqrt(dx * dx + dy * dy) / R;

  if (r > 1) return null;            // 圆外 → 透明
  if (r < R_HOLE) return null;       // 中心孔 → 透明

  let c;
  if (r < R_RING_IN) c = CLR_HUB;                     // 夹持区内侧
  else if (r < R_RING_IN + RING_W) c = CLR_RING;      // 金色细环
  else if (r < R_HUB_OUT) c = CLR_HUB;                // 夹持区外侧
  else if (r < R_RIM) c = CLR_DATA;                   // 数据区
  else c = CLR_RIM;                                   // 外缘
  return c;
}

/**
 * 渲染一个尺寸，返回 RGBA8 像素缓冲。
 * 4×4 超采样：先按颜色桶累计覆盖率，再合成 —— 直接平均会在两种颜色交界处
 * 产生"第三条颜色"，桶化之后每种颜色的边缘都保持干净。
 */
function renderRGBA(size) {
  const SS = 4;                        // 每边子样本数
  const out = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  // 留 1px 余量，边缘才不会被切平（Windows 任务栏会原样缩放）
  const R = size / 2 - 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 颜色桶：[r,g,b,覆盖率]
      const acc = new Map();
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const c = sample(px, py, cx, cy, R);
          if (!c) continue;
          const k = (c[0] << 16) | (c[1] << 8) | c[2];
          acc.set(k, (acc.get(k) || 0) + 1);
        }
      }
      const total = SS * SS;
      let r = 0, g = 0, b = 0, a = 0;
      for (const [k, n] of acc) {
        r += ((k >> 16) & 255) * n;
        g += ((k >> 8) & 255) * n;
        b += (k & 255) * n;
        a += n;
      }
      const o = (y * size + x) * 4;
      if (a === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
      // 颜色按"命中色块的样本数"归一 —— 分母必须是 a，不是 total-a。
      // 用错成 total-a 时，内部整片覆盖的像素分母为 0，r/0 得到 Infinity，
      // 写进 Buffer 变成 0，于是整块盘面全黑、只有边缘有颜色。
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round((a / total) * 255);
    }
  }
  return out;
}

/* ---------- PNG 编码（zlib 内置，不需要任何依赖） ---------- */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  if (w == null) w = rgba.w;
  if (h == null) h = w;   // 正方形是常态
  const raw = Buffer.alloc(h * (w * 4 + 1));
  let off = 0;
  for (let y = 0; y < h; y++) {
    raw[off++] = 0; // filter type 0
    rgba.copy(raw, off, y * w * 4, (y + 1) * w * 4);
    off += w * 4;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- ICO 编码 ----------
 * Windows 资源管理器会挑选"最接近但不超过"请求尺寸的那一帧，
 * 所以必须把常用尺寸都塞进去；只放一张 256 的话，
 * 16px 任务栏图标就是缩放出来的，细金环会糊成一条灰线。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function encodeIco(frames) {
  const n = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = 1 (icon)
  header.writeUInt16LE(n, 4);   // 帧数

  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  frames.forEach((f, i) => {
    const o = i * 16;
    dir[o] = f.size >= 256 ? 0 : f.size;      // 0 表示 256
    dir[o + 1] = f.size >= 256 ? 0 : f.size;
    dir[o + 2] = 0;                            // 调色板色数（真彩色写 0）
    dir[o + 3] = 0;                            // reserved
    dir.writeUInt16LE(1, o + 4);               // color planes
    dir.writeUInt16LE(32, o + 6);              // bits per pixel
    dir.writeUInt32LE(f.png.length, o + 8);    // 字节数
    dir.writeUInt32LE(offset, o + 12);         // 偏移
    offset += f.png.length;
  });
  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

/* ---------- 输出 ---------- */
const outDir = path.join(__dirname, '..', 'build');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const frames = ICO_SIZES.map((size) => ({ size, png: encodePng(renderRGBA(size), size) }));
const main = frames[frames.length - 1];   // 256

fs.writeFileSync(path.join(outDir, 'icon.png'), main.png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(frames));
console.log('build/icon.png  ' + main.size + 'x' + main.size + '  ' + main.png.length + ' bytes');
console.log('build/icon.ico  ' + ICO_SIZES.join('/') + '  ' +
  fs.statSync(path.join(outDir, 'icon.ico')).size + ' bytes');

/* ---------- 可选：尺寸对照图，用来肉眼检查小尺寸是否还认得出 ---------- */
const argi = process.argv.indexOf('--preview');
if (argi > -1 && process.argv[argi + 1]) {
  const PAD = 12, GAP = 12;
  const W = 256 + PAD * 2;
  const H = PAD + 256 + GAP + 32 + PAD;
  const cv = Buffer.alloc(W * H * 4);
  // 中灰底：既不太亮也不太暗，最接近"两种背景下都要成立"的真实情况
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const g = (((x >> 4) + (y >> 4)) & 1) ? 148 : 124;
      cv[o] = cv[o + 1] = cv[o + 2] = g; cv[o + 3] = 255;
    }
  }
  // 放大铺一张主图（最近邻，看像素边缘）
  const big = renderRGBA(256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const s = (y * 256 + x) * 4, d = ((y + PAD) * W + (x + PAD)) * 4;
      const a = big[s + 3] / 255;
      cv[d] = Math.round(big[s] * a + cv[d] * (1 - a));
      cv[d + 1] = Math.round(big[s + 1] * a + cv[d + 1] * (1 - a));
      cv[d + 2] = Math.round(big[s + 2] * a + cv[d + 2] * (1 - a));
      cv[d + 3] = 255;
    }
  }
  // 下方按真实像素并排放各档尺寸
  let x = PAD;
  const yBase = PAD + 256 + GAP;
  for (const s of [16, 24, 32, 48, 64, 128]) {
    const f = renderRGBA(s);
    for (let yy = 0; yy < s; yy++) {
      for (let xx = 0; xx < s; xx++) {
        const sOff = (yy * s + xx) * 4;
        const d = ((yBase + yy) * W + (x + xx)) * 4;
        const a = f[sOff + 3] / 255;
        cv[d] = Math.round(f[sOff] * a + cv[d] * (1 - a));
        cv[d + 1] = Math.round(f[sOff + 1] * a + cv[d + 1] * (1 - a));
        cv[d + 2] = Math.round(f[sOff + 2] * a + cv[d + 2] * (1 - a));
      }
    }
    x += s + GAP;
  }
  fs.writeFileSync(process.argv[argi + 1], encodePng(cv, W, H));
  console.log('preview: ' + process.argv[argi + 1]);
}
