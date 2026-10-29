'use strict';
/*
 * audio-stats.test.js —— RAW 链路数据形态判据单测（纯函数，真货直测）。
 *
 * v10.2 起核心是 detectPcmForm：按**波形平滑度**（MASD/RMS）判别数据形态，
 * 取代 v10.1 的符号扩展判据（分不清"小端安静前奏"与"8bit 降质"，
 * 音乐变响即失效 —— 用户 F 盘实测翻车点）。
 *
 * 覆盖：
 *   pcmStats      —— 全零/非零/峰值统计（字节序口径）
 *   cddaSyncCount —— CD-DA sync 头铁证（大端/小端双形态容忍）
 *   waveformScore —— 平滑度打分（真音频 vs 字节序搞反 vs 随机垃圾）
 *   detectPcmForm —— 四态判别（be16/le16/silence/garbage）+ 用户真实数据回归
 */

const path = require('path');
const fs = require('fs');
const { pcmStats, cddaSyncCount, waveformScore, detectPcmForm, FORM_AUDIO_MAX, FORM_SILENCE_RMS } =
  require(path.join(__dirname, '..', 'main', 'cd', 'audio-stats.js'));

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/** 确定性 PRNG（mulberry32）：测试垃圾数据用，真随机才能测出噪声级平滑度 */
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 构造平滑音频波形（多正弦叠加，大小端字节序写）——真音频的平滑度标杆 */
function smoothAudio(len, littleEndian, amp) {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i += 2) {
    const t = i / 2;
    const v = Math.round(amp * (0.6 * Math.sin(t / 50) + 0.3 * Math.sin(t / 17) + 0.1 * Math.sin(t / 7)));
    if (littleEndian) buf.writeInt16LE(v, i); else buf.writeInt16BE(v, i);
  }
  return buf;
}

/** 构造随机垃圾（均匀分布字节） */
function randomGarbage(len, seed) {
  const rnd = prng(seed);
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = Math.floor(rnd() * 256);
  return buf;
}

/** 构造大端 CD-DA 扇区流（带 sync 头） */
function cddaSectors(n) {
  const buf = Buffer.alloc(n * 2352);
  for (let s = 0; s < n; s++) {
    const o = s * 2352;
    buf[o] = 0x00;
    for (let i = 1; i <= 10; i++) buf[o + i] = 0xFF;
    buf[o + 11] = 0x00;
    for (let i = 12; i + 1 < 2352; i += 2) buf.writeInt16BE(1000 + ((i * 7 + s * 37) % 500), o + i);
  }
  return buf;
}

console.log('# 1. pcmStats：全零 / 非零 / 峰值 / 字节序口径');
{
  const zero = Buffer.alloc(2352);
  const z = pcmStats(zero);
  check('全零 → allZero=true, nonZeroRatio=0', z.allZero && z.nonZeroRatio === 0, z);
  check('全零 → peak=0', z.peak === 0, z.peak);

  const be = Buffer.alloc(2352);
  for (let i = 0; i < 2352; i += 2) be.writeUInt16BE(0x7FFF, i);
  const b = pcmStats(be, true);
  check('大端口径 peak=32767（不出现字节序假满幅）', b.peak === 32767, b.peak);
  check('大端非零率=100%', b.nonZeroRatio === 1, b.nonZeroRatio);

  const le = Buffer.alloc(2352);
  for (let i = 0; i < 2352; i += 2) le.writeUInt16LE(0x00FF, i);
  check('小端口径 peak=255', pcmStats(le).peak === 255);

  const neg = Buffer.alloc(2352);
  for (let i = 0; i < 2352; i += 2) neg.writeInt16BE(-32767, i);
  check('负峰取绝对值（peak=32767）', pcmStats(neg, true).peak === 32767);

  check('短缓冲区（<2B）安全返回', pcmStats(Buffer.alloc(1)).allZero === true);
  check('null 安全返回', pcmStats(null).allZero === true);
}

console.log('# 2. cddaSyncCount：sync 头铁证（双字节序形态）');
{
  const be = Buffer.alloc(2352 * 2);
  for (let s = 0; s < 2; s++) {
    const o = s * 2352;
    be[o] = 0x00;
    for (let i = 1; i <= 10; i++) be[o + i] = 0xFF;
    be[o + 11] = 0x00;
  }
  check('大端原序 2 扇区全合规', cddaSyncCount(be) === 2, cddaSyncCount(be));

  const le = Buffer.alloc(2352);
  le[0] = 0xFF; le[1] = 0x00;
  for (let i = 2; i <= 9; i++) le[i] = 0xFF;
  le[10] = 0x00; le[11] = 0xFF;
  check('小端翻转形态 1 扇区合规', cddaSyncCount(le) === 1, cddaSyncCount(le));

  check('随机垃圾 0 合规', cddaSyncCount(randomGarbage(2352, 7)) === 0);
  check('短缓冲区（<2352B）返回 0', cddaSyncCount(Buffer.alloc(100)) === 0);
}

console.log('# 3. ★ waveformScore：波形平滑度（v10.2 判据核心）');
{
  check('阈值常量 = 0.7', FORM_AUDIO_MAX === 0.7, FORM_AUDIO_MAX);
  check('静音 RMS 阈值 = 8', FORM_SILENCE_RMS === 8, FORM_SILENCE_RMS);

  const le = smoothAudio(2352, true, 8000);
  const be = smoothAudio(2352, false, 8000);
  const leS = waveformScore(le, true), leWrong = waveformScore(le, false);
  const beS = waveformScore(be, false), beWrong = waveformScore(be, true);
  check('小端真音频按小端读：平滑（<0.4）', leS.score < 0.4, leS.score.toFixed(3));
  check('小端真音频按大端读：噪声级（>0.9）', leWrong.score > 0.9, leWrong.score.toFixed(3));
  check('大端真音频按大端读：平滑（<0.4）', beS.score < 0.4, beS.score.toFixed(3));
  check('大端真音频按小端读：噪声级（>0.9）', beWrong.score > 0.9, beWrong.score.toFixed(3));
  check('正确字节序的分数远低于错误字节序（4 倍以上）',
    leWrong.score > leS.score * 4 && beWrong.score > beS.score * 4);

  const garbage = randomGarbage(2352, 42);
  const gl = waveformScore(garbage, true), gb = waveformScore(garbage, false);
  check('随机垃圾两种字节序都是噪声级（>0.9）', gl.score > 0.9 && gb.score > 0.9,
    { le: gl.score.toFixed(3), be: gb.score.toFixed(3) });

  check('全零：rms=0 score=0', waveformScore(Buffer.alloc(2352), true).score === 0);
  check('短缓冲区安全返回', waveformScore(Buffer.alloc(2), true).rms === 0);
  check('null 安全返回', waveformScore(null, true).score === 0);
}

console.log('# 4. ★ detectPcmForm：四态判别');
{
  check('大端带 sync → be16', detectPcmForm(cddaSectors(2)) === 'be16');
  check('大端无 sync 纯 PCM → be16', detectPcmForm(smoothAudio(2352, false, 8000)) === 'be16');
  check('小端 PCM → le16', detectPcmForm(smoothAudio(2352, true, 8000)) === 'le16');
  check('全零 → silence', detectPcmForm(Buffer.alloc(2352)) === 'silence');
  // 近静音：全零底 + 稀疏 ±1 抖动（颤噪声级别，两种字节序解码都听不出）
  const nearSilent = Buffer.alloc(2352);
  for (let i = 0; i < 2352; i += 500) nearSilent[i] = 0x01;
  check('近全零（稀疏 ±1 抖动，LE RMS<8）→ silence', detectPcmForm(nearSilent) === 'silence');
  check('随机垃圾 → garbage', detectPcmForm(randomGarbage(2352, 42)) === 'garbage');
  check('短缓冲区 → silence', detectPcmForm(Buffer.alloc(2)) === 'silence');
  check('null → silence', detectPcmForm(null) === 'silence');

  // 逐块稳定性：同一形态连读多块不得翻转（静音块也不得误判垃圾）
  const le = smoothAudio(75 * 2352, true, 8000);
  const forms = [];
  for (let s = 0; s < 75; s++) forms.push(detectPcmForm(le.subarray(s * 2352, (s + 1) * 2352)));
  check('小端流 75 块全部判 le16（无翻转）', forms.every((f) => f === 'le16'), forms.filter((f) => f !== 'le16').length + ' 块异常');
  const be = smoothAudio(75 * 2352, false, 8000);
  const forms2 = [];
  for (let s = 0; s < 75; s++) forms2.push(detectPcmForm(be.subarray(s * 2352, (s + 1) * 2352)));
  check('大端流 75 块全部判 be16（无翻转）', forms2.every((f) => f === 'be16'), forms2.filter((f) => f !== 'be16').length + ' 块异常');
}

console.log('# 5. ★ 用户 F 盘真实 dump 回归（v10.2 定论依据）');
{
  /**
   * fixture 是用户真实光驱 dump（原始上传目录带会话 UUID，不可移植）。
   * 找不到时优雅跳过 —— 这是环境差异，不是代码回归；
   * run.js 对输出里的 [skip] 不计失败。
   */
  const dumpDirs = [
    '/root/uploads/wb-agentserver-87aebd77-fcdc-4aed-9ae2-330182c933cd-uploads-1792285',
    '/root/uploads'
  ];
  const dumpDir = dumpDirs.find((d) => {
    try { return fs.existsSync(path.join(d, 'raw-dump-F.json')); } catch (e) { return false; }
  });
  if (!dumpDir) {
    console.log('  [skip] 缺用户 F 盘 dump fixture（原始上传目录在当前环境不可见）');
  } else {
  const dump = fs.readFileSync(path.join(dumpDir, 'raw-dump-F.json'));      // IOCTL 75 扇区
  const spti = fs.readFileSync(path.join(dumpDir, 'raw-dump-F-spti.json')); // SPTI 27 扇区
  check('dump 尺寸 = 75×2352', dump.length === 75 * 2352, dump.length);
  check('整块（安静前奏+响段混合）→ le16', detectPcmForm(dump) === 'le16');
  check('响段（扇区 60-74）→ le16', detectPcmForm(dump.subarray(60 * 2352)) === 'le16');
  check('安静段（扇区 15-49）→ le16', detectPcmForm(dump.subarray(15 * 2352, 50 * 2352)) === 'le16');
  check('静音前奏（扇区 0-13）→ silence', detectPcmForm(dump.subarray(0, 14 * 2352)) === 'silence');
  check('SPTI 27 扇区同样判 le16（两条路径同源）', detectPcmForm(spti) === 'le16');
  const loud = dump.subarray(60 * 2352);
  const ls = waveformScore(loud, true), bs = waveformScore(loud, false);
  check('响段小端分 <0.35（平滑波形）', ls.score < 0.35, ls.score.toFixed(3));
  check('响段大端分 >1.0（噪声级，旧白噪音口径）', bs.score > 1.0, bs.score.toFixed(3));
  }
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
