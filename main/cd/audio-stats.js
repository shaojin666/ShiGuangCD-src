'use strict';
/*
 * audio-stats.js —— PCM 数据统计与数据形态判别（纯函数，无平台依赖，测试可直接用真货）。
 *
 * 为什么需要它：RAW 链路最大的陷阱是"IOCTL_CDROM_RAW_READ 返回成功"不等于
 * "读到了音频"。相当一部分光驱（虚拟光驱、部分 USB 外置光驱）对该指令
 * 返回成功但数据全零 —— 只看抛不抛错就会判定"RAW 可用"，结果进入 RAW
 * 模式后全程静音，日志还写着"数字读取可用"（用户侧：说能用，却没声音）。
 *
 * 三个使用点：
 *   1) 能力测试（cd-service._testRawRead）：首块全零 → 判不支持 → 回退 MCI；
 *   2) 播放看门狗（raw-player.pump）：连续多块全零/垃圾 → 交上层切换 MCI / 止损；
 *   3) 解码判别（reader-worker.decodeRaw）：按数据形态选字节序（见 detectPcmForm）。
 *
 * 字节序：默认按 Int16LE（reader-worker swapEndian 之后、IPC 推送之前的形态）。
 * 能力测试拿到的是尚未翻转的大端原始数据，传 bigEndian=true 换成大端口径 ——
 * 否则字节序会让峰值出现 32768 这种假"满幅"，诊断信息反而误导人。
 *
 * ★ v10.2 数据形态判别（detectPcmForm）—— 用户 F 盘实体光驱实测定论：
 *   该光驱（USB 桥接芯片固件）返回的是**小端 16bit PCM**，而 CD-DA 标准是
 *   大端。旧管线一律按大端 swapEndian → 把真音频字节对调 → 全程白噪音
 *   （v9 症状）；安静前奏时低 8 位就是全部内容、高字节恒为符号扩展，
 *   看上去像"8bit 降质"（v10.1 的 raw8 误判来源），音乐变响后高字节开始
 *   变化、raw8 随即失效 → 又变白噪音。判别不靠符号扩展浓度，靠**波形
 *   平滑度**：真实音频的相邻采样差远小于信号幅度（MASD/RMS ≈ 0.1~0.5），
 *   字节序搞反时相邻采样变成"随机组合"（≈1.1），伪造垃圾同理。
 */

/** 16bit 字节翻转（用于大端口径统计） */
function swap16(v) {
  const u = v & 0xffff;
  const s = ((u << 8) & 0xff00) | (u >>> 8);
  return s << 16 >> 16;
}

/**
 * @param {Buffer|Uint8Array} buf
 * @param {boolean} [bigEndian] 数据是否为大端 16bit（未经 swapEndian 的原始扇区）
 * @returns {{bytes:number, samples:number, peak:number, nonZero:number,
 *            nonZeroRatio:number, allZero:boolean}}
 *   peak        —— 采样峰值（0~32767）
 *   nonZeroRatio—— 非零采样占比（0~1）
 *   allZero     —— 是否整块全是数字静音（与字节序无关）
 */
function pcmStats(buf, bigEndian) {
  if (!buf || buf.length < 2) {
    return { bytes: 0, samples: 0, peak: 0, nonZero: 0, nonZeroRatio: 0, allZero: true };
  }
  const view = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  let peak = 0;
  let nonZero = 0;
  for (let i = 0; i < view.length; i++) {
    const v = bigEndian ? swap16(view[i]) : view[i];
    if (v !== 0) nonZero++;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return {
    bytes: buf.length,
    samples: view.length,
    peak,
    nonZero,
    nonZeroRatio: nonZero / view.length,
    allZero: nonZero === 0
  };
}

/**
 * 统计缓冲里带合法 CD-DA sync 头的扇区数（2352B/扇区）。
 *
 * 为什么需要它：相当一部分光驱/驱动对 RAW 读取"返回成功 + 非零数据"，
 * 但内容是伪造的垃圾（用户侧：RAW 模式下全程白噪音）。全零校验拦不住它
 * —— 数据不是零，只是不是音频。sync 头是 CD-DA 流的格式铁证：
 * 真音频每扇区必带，随机垃圾几乎不可能以 00 FF*10 00 开头。
 *
 * 字节序容忍：sync 头 12 字节 = 6 个 16bit 对，每对必为 00FF 或 FF00，
 * 且首对与第 6 对相反。能力测试看的是未经翻转的大端原始数据，
 * 播放看门狗看的是 reader-worker swapEndian 之后的小端数据 ——
 * 两种形态用同一套规则都能识别，不必让调用方关心数据有没有翻转过。
 *
 * v10.2 起它的角色降级为"正向铁证"：有 sync 头 → 必定是大端真 CD-DA；
 * 没有 sync 头**不再**是垃圾证据（实测有光驱返回无同步头的纯 PCM，
 * 见文件头说明），垃圾判别改由波形平滑度负责（waveformScore）。
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {number} 合规扇区数（0 = 无同步头流或垃圾）
 */
function cddaSyncCount(buf) {
  if (!buf || buf.length < 2352) return 0;
  const n = Math.floor(buf.length / 2352);
  let c = 0;
  for (let s = 0; s < n; s++) {
    const o = s * 2352;
    let ok = true;
    // 中间 4 对（字节 2..9）必须是 0xFFFF（CD-DA sync 的 10 个 FF）
    for (let i = 1; i <= 4; i++) {
      if (buf[o + i * 2] !== 0xFF || buf[o + i * 2 + 1] !== 0xFF) { ok = false; break; }
    }
    // 首对与末对（字节 0/1 与 10/11）必须是 00FF/FF00 且相反：
    //   BE 原序   00 FF | FF FF ×4 | FF 00
    //   swapEndian 后 FF 00 | FF FF ×4 | 00 FF
    if (ok) {
      const p0 = (buf[o] === 0x00 && buf[o + 1] === 0xFF) || (buf[o] === 0xFF && buf[o + 1] === 0x00);
      const p5 = (buf[o + 10] === 0x00 && buf[o + 11] === 0xFF) || (buf[o + 10] === 0xFF && buf[o + 11] === 0x00);
      if (!p0 || !p5 || buf[o] === buf[o + 10]) ok = false;
    }
    if (ok) c++;
  }
  return c;
}

/**
 * 波形平滑度打分：MASD（相邻采样平均绝对差）/ RMS。
 *
 * 判别原理：真实音频是带限信号，相邻采样高度相关，差/幅度比很小
 * （实测该用户光驱数据 0.145~0.300）；把字节序搞反（或数据是随机垃圾）
 * 时相邻采样失去相关性，比值升到噪声水平（均匀随机 ≈1.15）。
 * 这是 v10.2 字节序判别与垃圾判别的核心依据，取代 v10.1 的符号扩展判据
 * （那个判据分不清"小端安静前奏"与"8bit 降质"，音乐变响即失效）。
 *
 * @param {Buffer|Uint8Array} buf
 * @param {boolean} littleEndian 按小端解释（true=Int16LE，false=Int16BE）
 * @returns {{rms:number, masd:number, score:number}} score=masd/rms（全零时 0）
 */
function waveformScore(buf, littleEndian) {
  if (!buf || buf.length < 4) return { rms: 0, masd: 0, score: 0 };
  let sum = 0, sumD = 0, n = 0, prev = null;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = littleEndian ? buf.readInt16LE(i) : buf.readInt16BE(i);
    sum += v * v;
    n++;
    if (prev !== null) sumD += Math.abs(v - prev);
    prev = v;
  }
  const rms = Math.sqrt(sum / n);
  const masd = n > 1 ? sumD / (n - 1) : 0;
  return { rms, masd, score: rms > 0 ? masd / rms : 0 };
}

/**
 * 波形判据阈值：MASD/RMS 低于此值判"波形像音频"。
 * 依据：真实音频实测 0.145~0.300（再宽松的内容也罕见超过 0.6）；
 * 字节序搞反/随机垃圾 ≈1.1。取 0.7 留足两侧余量。
 */
const FORM_AUDIO_MAX = 0.7;

/**
 * 静音判据：小端解释的 RMS 低于此值判静音（全零/近全零）。
 * 静音数据两种字节序等价（都是零或近零），直通即可。
 * 依据：该光驱安静前奏 RMS 也有 60+，全零为 0，阈值 8 分隔明确。
 */
const FORM_SILENCE_RMS = 8;

/**
 * 判别一块 RAW 扇区数据的形态（v10.2 核心）：
 *   'be16'    —— 标准大端 CD-DA（含 sync 头或无同步头的纯 PCM 大端流）
 *   'le16'    —— 小端 16bit PCM（实测 USB 桥接光驱的固件行为）
 *   'silence' —— 全零/近静音（两种字节序解码等价，直通）
 *   'garbage' —— 两种字节序都不像音频波形（驱动伪造数据）
 *
 * 判据优先级：
 *   1) 有 sync 头 → 必定大端真 CD-DA（格式铁证，先于一切启发式）；
 *   2) 小端 RMS 低于静音阈值 → 静音；
 *   3) 任一种字节序的波形分低于 FORM_AUDIO_MAX → 取更平滑的那个
 *      （平局时偏向大端：标准 CD-DA 是大端，且小端光驱的数据不会平局）；
 *   4) 都不像 → 垃圾。
 *
 * 注意：判据是**逐块**的，不跨块记忆 —— 安静段两种字节序都可能"像音频"，
 * 但取 argmin 仍稳定（实测小端光驱安静段 LE 0.26 vs BE 0.41，响段
 * LE 0.28 vs BE 1.15，从不翻转）；跨块记忆反而可能在极少数模糊块上
 * 把错的字节序粘住。
 *
 * @param {Buffer|Uint8Array} buf 未经解码的原始扇区数据
 * @returns {'be16'|'le16'|'silence'|'garbage'}
 */
function detectPcmForm(buf) {
  if (!buf || buf.length < 4) return 'silence';
  if (cddaSyncCount(buf) > 0) return 'be16';      // sync 铁证：标准大端 CD-DA
  const le = waveformScore(buf, true);
  if (le.rms < FORM_SILENCE_RMS) return 'silence'; // 小端视角就是静音（两种字节序等价）
  const be = waveformScore(buf, false);
  if (le.score < FORM_AUDIO_MAX || be.score < FORM_AUDIO_MAX) {
    return be.score <= le.score ? 'be16' : 'le16';
  }
  return 'garbage';
}

module.exports = { pcmStats, cddaSyncCount, waveformScore, detectPcmForm, FORM_AUDIO_MAX, FORM_SILENCE_RMS };
