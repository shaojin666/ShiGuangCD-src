'use strict';
/*
 * raw-diag.js —— 物理光驱 RAW 读取诊断（Windows 专用，纯 Node 运行）。
 *
 * 用途：应用在物理光驱上回退 MCI 时，本工具逐项打印底层读取的每一步结果
 * （错误码 / SCSI sense / 数据是否全零），把"为什么回退"变成可复制的文本。
 *
 * 运行：双击 raw-diag.bat，或在解压目录执行 node tools/raw-diag.js
 * 结束后把窗口里的全部内容发给开发者。
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

if (process.platform !== 'win32') {
  console.log('本工具只能在 Windows 上运行（当前平台：' + process.platform + '）。');
  console.log('请在 Windows 电脑上进入 ShiGuangCD-src 目录，双击 tools\\raw-diag.bat。');
  process.exit(1);
}

let native;
try {
  native = require(path.join(ROOT, 'main', 'native.js'));
} catch (e) {
  console.log('加载 native.js 失败：' + e.message);
  console.log('请确认在 ShiGuangCD-src 目录下运行，且已执行过 npm install。');
  process.exit(1);
}

let fDIC = null, fGetLastError = null;
try {
  const koffi = require('koffi');
  const kernel32 = koffi.load('kernel32.dll');
  fDIC = kernel32.func('bool __stdcall DeviceIoControl(void* h, uint32 code, void* inBuf, uint32 inSize, void* outBuf, uint32 outSize, void* returned, void* ovl)');
  fGetLastError = kernel32.func('uint32 __stdcall GetLastError()');
} catch (e) {
  console.log('加载 koffi 失败：' + e.message);
  console.log('请先在本目录执行 npm install 再运行本工具。');
  process.exit(1);
}

const lines = [];
function out(s) { console.log(s); lines.push(s); }
function hex(n) { return '0x' + (n >>> 0).toString(16); }
function errText(e) {
  if (!e) return '(无异常)';
  let t = e.message || String(e);
  if (e.winCode != null) t += ' [winCode=' + e.winCode + ' ' + hex(e.winCode) + ']';
  if (e.scsiStatus != null) t += ' [scsiStatus=' + e.scsiStatus + ']';
  if (e.senseKey != null) t += ' [sense=' + e.senseKey + '/' + e.asc + '/' + e.ascq + ']';
  if (e.mciCode != null) t += ' [mciCode=' + e.mciCode + ']';
  return t;
}
function peek(buf, n) {
  const b = buf.subarray(0, n);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');
}
function allZero(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

let _audioStats = null;
/** RAW 数据质量速检：sync 合规数 / PCM 统计（大端+小端）/ 全零扇区 / 波形平滑度与形态判定 */
function qualityOf(buf) {
  if (!_audioStats) _audioStats = require(path.join(ROOT, 'main', 'cd', 'audio-stats.js'));
  const SECTOR = 2352;
  const nSec = Math.floor(buf.length / SECTOR);
  const syncOk = _audioStats.cddaSyncCount(buf);
  const be = _audioStats.pcmStats(buf, true);
  const le = _audioStats.pcmStats(buf, false);
  // 波形平滑度（MASD/RMS，v10.2 判据）：真实音频相邻采样高度相关（<0.7），
  // 字节序搞反或随机垃圾时失去相关性（≈1.1+）。detectPcmForm 给出四态结论。
  const wLe = _audioStats.waveformScore(buf, true);
  const wBe = _audioStats.waveformScore(buf, false);
  const form = _audioStats.detectPcmForm(buf);
  let zeroSec = 0;
  for (let s = 0; s < nSec; s++) if (allZero(buf.subarray(s * SECTOR, (s + 1) * SECTOR))) zeroSec++;
  return { nSec, syncOk, be, le, zeroSec, wLe, wBe, form };
}

async function main() {
  out('==== ShiGuangCD RAW 读取诊断 ' + new Date().toLocaleString() + ' ====');
  out('Node ' + process.version + ' / ' + process.platform + ' ' + process.arch);
  out('');

  /* 1. 驱动器枚举 */
  out('---- 1. 驱动器枚举 ----');
  const drives = native.listCdDrives();
  out('CD/可移动驱动器: ' + (drives.length ? drives.join(', ') : '(无)'));
  const all = native.listAllDrives();
  out('全部驱动器: ' + all.map((d) => d.letter + ':' + '(type=' + d.type + ')').join(' ') || '(无)');
  if (!drives.length) { out('没有找到光驱，诊断结束。'); return finish(); }

  /* 2. 逐盘探测 */
  for (const letter of drives) {
    out('');
    out('########## 光驱 ' + letter + ': ##########');

    /* 2a. 打开设备（记录走了哪条权限路径） */
    out('---- ' + letter + ': 打开设备 ----');
    let handle = null;
    try {
      handle = native.openCdDevice(letter);
      out('打开成功（句柄 ' + String(handle) + '）。先试 GENERIC_READ|WRITE，被拒会自动退回只读。');
    } catch (e) {
      out('打开失败: ' + errText(e));
      continue;
    }

    /* 2b. TOC */
    out('---- ' + letter + ': 读取 TOC ----');
    let toc = null;
    try {
      toc = native.readToc(handle);
      out('TOC 读取成功: ' + toc.tracks.length + ' 轨, leadout=' + toc.leadout +
        ', 音频轨=' + toc.tracks.filter((t) => t.audio).length);
    } catch (e) {
      out('TOC 读取失败: ' + errText(e) + '（TOC 都读不到，后续无意义）');
      native.closeDevice(handle);
      continue;
    }
    const audioTrack = toc.tracks.find((t) => t.audio) || toc.tracks[0];
    const lba = Math.max(0, audioTrack.startFrame - 150);
    out('测试轨: #' + audioTrack.number + ' LBA=' + lba);

    /* 2c. 能力测试同参：IOCTL RAW_READ 2 扇区 */
    out('---- ' + letter + ': IOCTL_CDROM_RAW_READ 读 2 扇区（应用能力测试同参）----');
    let twoSectorZero = false;
    try {
      const d = native.rawReadIoctl ? native.rawReadIoctl(handle, lba, 2) : native.rawRead(handle, lba, 2);
      twoSectorZero = allZero(d);
      out('结果: 成功, ' + d.length + ' 字节, 全零=' + twoSectorZero);
      out('  前 48 字节: ' + peek(d, 48));
      if (twoSectorZero) {
        out('  ↑ 全零有两种可能：光驱"假成功"（真读不到音频），或轨首恰好是数字静音。');
        out('  ↑ 用 75 扇区窗口甄别（应用 v8 起的能力测试逻辑）：');
      }
    } catch (e) {
      out('结果: 失败 → ' + errText(e));
    }

    /* 2c-2. 静音前奏甄别：2 扇区全零时读 75 扇区（拆分路径）看有无真音频 */
    if (twoSectorZero) {
      try {
        const d = native.rawRead(handle, lba, 75);
        const z = allZero(d);
        out('  75 扇区窗口: ' + (z ? '仍全零 → 光驱确实读不到音频（能力测试会判不可用）'
          : '有真数据 → 轨首只是静音前奏，能力测试应判可用（v8 已修复此误判）'));
      } catch (e) {
        out('  75 扇区窗口: 失败 → ' + errText(e));
      }
    }

    /* 2d. ★ 大请求：IOCTL RAW_READ 单笔 75 扇区（播放时 worker 的历史请求大小）---- */
    out('---- ' + letter + ': IOCTL_CDROM_RAW_READ 单笔读 75 扇区（176KB，验证大传输上限）----');
    try {
      const d = native.rawReadIoctlSingle ? native.rawReadIoctlSingle(handle, lba, 75) : native.rawReadIoctl(handle, lba, 75);
      out('结果: 成功, ' + d.length + ' 字节, 全零=' + allZero(d) + '（单笔大请求可用）');
    } catch (e) {
      out('结果: 失败 → ' + errText(e) + '  ← 若此项失败而 2 扇区成功，即"单笔大请求被驱动/miniport 拒绝"（应用已自动拆分规避）');
    }

    /* 2e. SCSI 地址 */
    out('---- ' + letter + ': IOCTL_SCSI_GET_ADDRESS ----');
    let addr = null;
    try {
      addr = native.getScsiAddress(handle);
      out('结果: ' + (addr ? 'PathId=' + addr.pathId + ' TargetId=' + addr.targetId + ' Lun=' + addr.lun : '失败(设备不支持)'));
    } catch (e) {
      out('结果: 异常 → ' + errText(e));
    }

    /* 2f. SPTI READ CD 2 扇区（v10 修复 Length=56 后重测） */
    if (addr) {
      out('---- ' + letter + ': SPTI READ CD 读 2 扇区 ----');
      try {
        const d = native.scsiReadCd(handle, addr, lba, 2);
        out('结果: 成功, ' + d.length + ' 字节, 全零=' + allZero(d));
        out('  前 48 字节: ' + peek(d, 48));
        const q = qualityOf(d);
        out('  sync 合规: ' + q.syncOk + '/' + q.nSec +
          '  PCM(大端) peak=' + q.be.peak + ' nonZero=' + (q.be.nonZeroRatio * 100).toFixed(1) + '%' +
          '  PCM(小端) peak=' + q.le.peak +
          '  波形平滑度 小端=' + q.wLe.score.toFixed(3) + ' 大端=' + q.wBe.score.toFixed(3) +
          '  形态判定=' + q.form);
        out('  ↑ sync=2/2 = 真 16bit CD-DA（SPTI 修复生效）；无 sync 但小端平滑度<0.7 = 小端 16bit PCM' +
          '（USB 桥接固件行为，v10.2 起直通解码，属正常形态）');
      } catch (e) {
        out('结果: 失败 → ' + errText(e) +
          (e.winCode === 1306 ? '  ← 1306=revision mismatch：Length 仍不被驱动接受（布局不匹配）' : ''));
      }

      /* 2g. SPTI READ CD 27 扇区 */
      out('---- ' + letter + ': SPTI READ CD 读 27 扇区（63.5KB）----');
      try {
        const d = native.scsiReadCd(handle, addr, lba, 27);
        const q = qualityOf(d);
        out('结果: 成功, ' + d.length + ' 字节, 全零=' + allZero(d) +
          '  sync=' + q.syncOk + '/' + q.nSec + '  PCM(大端) peak=' + q.be.peak +
          ' nonZero=' + (q.be.nonZeroRatio * 100).toFixed(1) + '%' +
          '  波形平滑度 小端=' + q.wLe.score.toFixed(3) + ' 大端=' + q.wBe.score.toFixed(3) +
          '  形态判定=' + q.form);
        try {
          fs.writeFileSync(path.join(ROOT, 'raw-dump-' + letter + '-spti.bin'), d);
          out('  SPTI 数据已存盘: raw-dump-' + letter + '-spti.bin（27 扇区，供离线字节序分析）');
        } catch (e5) { out('  SPTI 数据落盘失败 → ' + e5.message); }
      } catch (e) {
        out('结果: 失败 → ' + errText(e));
      }

      /* 2h-1. SPTI 变体：44 字节旧布局——实证驱动到底按哪种 Length 校验 */
      out('---- ' + letter + ': SPTI READ CD 变体（Length=44 旧布局 / 0xF8 / 2352B）----');
      try {
        const d = scsiVariant(handle, addr, lba, 2, 0xF8, 2352, 44);
        out('结果: 成功, ' + d.length + ' 字节 ← 驱动按 44 字节旧布局校验（若此项成功而上面失败，请告知开发者改回旧布局）');
      } catch (e) {
        out('结果: 失败 → ' + errText(e) + '（现代驱动只认 56 字节布局，此项失败属预期）');
      }

      /* 2h-2. SPTI 变体：主通道 0x10（仅 User Data，2048B/扇区）—— 兼容探测 */
      out('---- ' + letter + ': SPTI READ CD 变体（主通道 0x10 / 2048B 扇区）----');
      try {
        const d = scsiVariant(handle, addr, lba, 2, 0x10, 2048);
        out('结果: 成功, ' + d.length + ' 字节, 全零=' + allZero(d) +
          '（能读用户数据但不能读 2352 raw = 驱动限制 raw 格式，非布局问题）');
      } catch (e) {
        out('结果: 失败 → ' + errText(e));
      }
    } else {
      out('(拿不到 SCSI 地址，跳过 SPTI 测试)');
    }

    /* 2i. 介质探测 */
    out('---- ' + letter + ': checkMedia ----');
    try {
      const m = native.checkMedia(handle);
      out('结果: supported=' + m.supported + ' present=' + m.present + (m.code != null ? ' code=' + m.code : ''));
    } catch (e) {
      out('结果: 异常 → ' + errText(e));
    }

    /* 2j. rawRead 全链（应用真实入口：自动 IOCTL→SPTI 回退）*/
    out('---- ' + letter + ': rawRead(2 扇区) 全链（应用真实入口）----');
    try {
      const d = native.rawRead(handle, lba, 2);
      out('结果: 成功, 全零=' + allZero(d) + ', 生效方法=' + native.rawReadMethod(handle));
    } catch (e) {
      out('结果: 失败 → ' + errText(e) + ', 方法=' + native.rawReadMethod(handle));
    }
    out('---- ' + letter + ': rawRead(75 扇区) 全链（应用真实入口，自动拆分≤27）----');
    try {
      const d = native.rawRead(handle, lba, 75);
      out('结果: 成功, 全零=' + allZero(d) + ', 生效方法=' + native.rawReadMethod(handle));
    } catch (e) {
      out('结果: 失败 → ' + errText(e) + ', 方法=' + native.rawReadMethod(handle));
    }

    /* 2l. ★ 数据质量定性（RAW 白噪音排查，v9 引入 / v10.2 改波形判据）---- */
    out('---- ' + letter + ': RAW 数据质量定性（白噪音排查）----');
    try {
      const { pcmStats, cddaSyncCount, waveformScore, detectPcmForm } = require(path.join(ROOT, 'main', 'cd', 'audio-stats.js'));
      const win = native.rawRead(handle, lba, 75);   // 75 扇区 = 1 秒音频
      const SECTOR = 2352;
      const nSec = Math.floor(win.length / SECTOR);
      const syncOk = cddaSyncCount(win);
      let zeroSec = 0;
      for (let s = 0; s < nSec; s++) if (allZero(win.subarray(s * SECTOR, (s + 1) * SECTOR))) zeroSec++;
      out('  (a) sync 头合规扇区: ' + syncOk + '/' + nSec +
        '（CD-DA 每扇区前 12 字节应为 00 FF*10 00；合规=标准 CD-DA 流）');
      out('  (b) 全零扇区: ' + zeroSec + '/' + nSec);
      const st = pcmStats(win, true);
      out('  (c) PCM 统计（大端口径）: peak=' + st.peak +
        ' nonZero=' + (st.nonZeroRatio * 100).toFixed(1) + '% allZero=' + st.allZero);
      // (c2) 波形平滑度 + 形态判定（v10.2 核心判据）：真实音频相邻采样高度相关
      // （MASD/RMS < 0.7），字节序搞反或随机垃圾时失去相关性（≈1.1+）。
      const wLe = waveformScore(win, true);
      const wBe = waveformScore(win, false);
      const form = detectPcmForm(win);
      out('  (c2) 波形平滑度（MASD/RMS，越小越像音频）: 小端=' + wLe.score.toFixed(3) +
        ' 大端=' + wBe.score.toFixed(3) + '  → 形态判定: ' + form +
        '（be16=标准大端 / le16=小端直通 / silence=静音 / garbage=两种字节序都不像音频）');
      // (d) 确定性：同 LBA 双读比对（真音频每次一样；随机垃圾每次不同）
      const again = native.rawRead(handle, lba, 75);
      out('  (d) 同 LBA 双读完全一致: ' + (again.length === win.length && again.equals(win) ? '是' : '否 ← 每次不同=随机垃圾数据') +
        '（真音频两次读取必然一致）');
      // (e) 请求大小依赖：2 扇区 vs 75 扇区的前 4704 字节
      try {
        const small = native.rawRead(handle, lba, 2);
        const same = small.length >= 4704 && small.subarray(0, 4704).equals(win.subarray(0, 4704));
        out('  (e) 2 扇区读 vs 75 扇区读前 4704 字节一致: ' + (same ? '是' : '否 ← 请求大小影响内容=拆分/缓冲错位') +
          '  小读前 16 字节: ' + peek(small, 16));
      } catch (e2) { out('  (e) 2 扇区复读失败 → ' + errText(e2)); }
      // (f) 轨中段读取（排除"只有轨首坏"）
      const trackLen = (audioTrack.endFrame || 0) - (audioTrack.startFrame || 0);
      if (trackLen > 150) {
        const midLba = Math.max(0, (audioTrack.startFrame - 150) + Math.floor(trackLen / 2));
        try {
          const mid = native.rawRead(handle, midLba, 75);
          const ms = pcmStats(mid, true);
          const mForm = detectPcmForm(mid);
          out('  (f) 轨中段 LBA=' + midLba + ': peak=' + ms.peak +
            ' nonZero=' + (ms.nonZeroRatio * 100).toFixed(1) + '% allZero=' + ms.allZero +
            ' sync=' + cddaSyncCount(mid) + '/' + Math.floor(mid.length / SECTOR) +
            ' 形态判定=' + mForm);
        } catch (e3) { out('  (f) 轨中段读取失败 → ' + errText(e3)); }
      }
      // (g) 原始数据落盘（离线分析用）
      const dumpPath = path.join(ROOT, 'raw-dump-' + letter + '.bin');
      try {
        fs.writeFileSync(dumpPath, win);
        out('  (g) 原始数据已存盘: ' + dumpPath + '（75 扇区 ' + win.length + ' 字节，排查时请一并发给开发者）');
      } catch (e4) { out('  (g) 落盘失败 → ' + e4.message); }
      // 结论速查（v10.2：无 sync 头≠垃圾，小端 PCM 是正常形态）
      if (form === 'be16') {
        out('  ↑ 结论：数据形态合法（sync 齐全 + 大端波形平滑）。若应用里仍是白噪音，');
        out('    嫌疑在字节序/管线（reader-worker swapEndian 或 audio.js 缓冲写入），请把 (g) 的 dump 发回。');
      } else if (form === 'le16') {
        out('  ↑ 结论：小端 16bit PCM（该光驱返回 little-endian 数据，无 sync 头但波形平滑）。');
        out('    v10.2 起应用已直通解码（不做字节交换），此形态可正常播放；若仍是白噪音请把 (g) 的 dump 发回。');
      } else if (form === 'garbage') {
        out('  ↑ 结论：非零但两种字节序都不像音频波形 → 驱动返回的是伪造/垃圾数据，');
        out('    这正是白噪音的来源。临时解法：设置页播放引擎切 MCI（已支持即时切换）。');
      } else if (st.allZero) {
        out('  ↑ 结论：全零 = 数字静音或假成功，能力测试应已判不可用回退 MCI。');
      }
    } catch (e) {
      out('结果: 失败 → ' + errText(e));
    }

    /* 2k. MCI 可用性 */
    out('---- ' + letter + ': MCI 兜底路径 ----');
    try {
      const t = native.readTocViaMci(letter);
      out('MCI TOC 读取成功: ' + t.tracks.length + ' 轨（MCI 兜底可用）');
    } catch (e) {
      out('MCI TOC 读取失败 → ' + errText(e));
    }

    native.closeDevice(handle);
  }

  finish();
}

/**
 * SPTI 变体探测：自定义主通道选择/扇区大小，以及可选的 44 字节旧布局。
 * layout=56（默认）：x64 正确布局（Length=56，DataBufferOffset u64@24 /
 *                   SenseInfoOffset@32 / Cdb@36）。
 * layout=44：旧文档的 ULONG 布局（Length=44，DataBufferOffset u32@20 /
 *             SenseInfoOffset@24 / Cdb@28）——用于实证驱动按哪种 Length 校验
 *             （v9 曾按字段内容写 Length=52，收 0x51a/1306 revision mismatch）。
 */
function scsiVariant(handle, addr, lba, count, mainSel, sectorSize, layout) {
  const legacy = layout === 44;
  const structSize = legacy ? 44 : 56;
  const SENSE_OFF = legacy ? 48 : 56;
  const DATA_OFF = legacy ? 80 : 88;
  const dataBytes = count * sectorSize;
  const buf = Buffer.alloc(DATA_OFF + dataBytes);
  buf.writeUInt16LE(structSize, 0);
  buf.writeUInt8(addr.pathId, 3); buf.writeUInt8(addr.targetId, 4); buf.writeUInt8(addr.lun, 5);
  buf.writeUInt8(12, 6); buf.writeUInt8(32, 7);
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(dataBytes, 12);
  buf.writeUInt32LE(30, 16);
  let cdb;
  if (legacy) {
    buf.writeUInt32LE(DATA_OFF, 20);              // DataBufferOffset（ULONG）
    buf.writeUInt32LE(SENSE_OFF, 24);             // SenseInfoOffset
    cdb = buf.subarray(28);
  } else {
    buf.writeBigUInt64LE(BigInt(DATA_OFF), 24);   // DataBufferOffset（ULONG_PTR）
    buf.writeUInt32LE(SENSE_OFF, 32);             // SenseInfoOffset
    cdb = buf.subarray(36);
  }
  cdb[0] = 0xBE; cdb[1] = 0x04;
  cdb[2] = (lba >>> 24) & 0xFF; cdb[3] = (lba >>> 16) & 0xFF; cdb[4] = (lba >>> 8) & 0xFF; cdb[5] = lba & 0xFF;
  cdb[6] = (count >>> 16) & 0xFF; cdb[7] = (count >>> 8) & 0xFF; cdb[8] = count & 0xFF;
  cdb[9] = mainSel; cdb[10] = 0; cdb[11] = 0;
  // 直接发 IOCTL（绕过 scsiReadCd 的固定参数）
  const returned = Buffer.alloc(4);
  const ok = fDIC(handle, native.IOCTL_SCSI_PASS_THROUGH, buf, buf.length, buf, buf.length, returned, null);
  const scsiStatus = buf.readUInt8(2);
  if (!ok || scsiStatus !== 0) {
    const e = new Error('SPTI 变体失败（Length=' + structSize + ' / 主通道 0x' +
      mainSel.toString(16).padStart(2, '0') + ' / ' + sectorSize + 'B 扇区）');
    if (!ok) e.winCode = fGetLastError();
    e.scsiStatus = scsiStatus;
    // sense buffer @ SENSE_OFF：sense key/asc/ascq（固定格式 sense，偏移 2/12/13）
    const sense = buf.subarray(SENSE_OFF);
    if (sense.length >= 14 && (sense[0] & 0x7F) === 0x70) {
      e.senseKey = sense[2] & 0x0F;
      e.asc = sense[12];
      e.ascq = sense[13];
    }
    throw e;
  }
  return buf.subarray(DATA_OFF);
}

function finish() {
  out('');
  out('==== 诊断结束 ====');
  out('请把上面从"==== ShiGuangCD RAW 读取诊断"开始的全部内容发给开发者。');
  if (process.stdin.isTTY) {
    out('（按回车键关闭窗口）');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(0));
  }
}

main().catch((e) => { console.error('诊断脚本异常：', e); process.exit(1); });
