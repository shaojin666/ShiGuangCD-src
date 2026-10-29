'use strict';
/*
 * native.test.js —— 原生层自检（不需要 Windows、不需要光驱）。
 *
 * 通过 Module._load 注入可编程的假 koffi，加载真实的 main/native.js，
 * 逐项校验 IOCTL 常量、TOC 解析、RAW_READ_INFO 输入结构、介质探测回退链。
 *
 * ★ 这个测试的存在意义：项目原有的测试套件全部通过 require.cache 注入假 native
 *   模块，真实 native.js 从未被加载过 —— 其 IOCTL 常量曾经全部错误
 *   （raw 读取完全不可用），测试却一路绿灯。常量属"写错即全盘皆输"的硬编码，
 *   必须有回归测试盯防。
 */

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', 'main');

/* ---------- 可编程假 koffi ---------- */
const calls = [];
let script = null; // (fnName, args) => 返回值 | undefined（走默认行为）

function fakeLib(name) {
  return {
    func(sig) {
      const m = /__stdcall\s+(\w+)\s*\(/.exec(sig);
      const fnName = m ? m[1] : sig;
      return function (...args) {
        calls.push({ lib: name, fn: fnName, args });
        if (script) {
          const r = script(fnName, args);
          if (r !== undefined) return r;
        }
        switch (fnName) {
          case 'CreateFileW': return 1n;
          case 'DeviceIoControl': return true;
          case 'CloseHandle': return true;
          case 'GetDriveTypeW': return 5;
          case 'GetLastError': return 0;
          case 'mciSendStringW': return 0;
          case 'mciGetErrorStringW': return true;
          default: return 0;
        }
      };
    }
  };
}

const fakeKoffi = { load: (name) => fakeLib(name) };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'koffi') return fakeKoffi;
  return origLoad.apply(this, arguments);
};

/* native.js 的 ensure() 只认 win32；其余逻辑与平台无关，此处伪装以便在 Linux 下自检 */
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

const native = require(path.join(ROOT, 'native.js'));

/* ---------- 断言工具 ---------- */
let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, actual, expected) {
  check(name + ' = ' + expected, actual === expected, actual);
}
function reset() { calls.length = 0; script = null; }
function ioCalls() { return calls.filter((c) => c.fn === 'DeviceIoControl'); }

/* ---------- CDROM_TOC 构造助手 ---------- */
function msfBytes(lba) {
  return [Math.floor(lba / 4500), Math.floor((lba % 4500) / 75), lba % 75, 0];
}
function trackEntry(number, lba, controlNibble) {
  const b = Buffer.alloc(8);
  b.writeUInt8(controlNibble << 4, 1); // ADR=0 | Control（高 4 位）
  b.writeUInt8(number, 2);
  const a = msfBytes(lba);
  for (let i = 0; i < 4; i++) b.writeUInt8(a[i], 4 + i);
  return b;
}
function buildToc(entries, first, last) {
  const out = Buffer.alloc(4 + 100 * 8);
  out.writeUInt8(first, 2);
  out.writeUInt8(last, 3);
  entries.forEach((e, i) => e.copy(out, 4 + i * 8));
  return out;
}
/** 标准三音频轨 CD：轨1@绝对帧150，lead-out@74000 */
const STD_TOC = buildToc([
  trackEntry(1, 150, 0x00),
  trackEntry(2, 22000, 0x00),
  trackEntry(3, 48000, 0x00),
  trackEntry(0xAA, 74000, 0x00)
], 1, 3);

const HANDLE = 1n;

(async () => {
  console.log('# 1. IOCTL 常量（Wine ntddcdrm.h / DDK6000 IOCTL 表 / CD Cracking Uncovered 三方确认）');
  eq('IOCTL_CDROM_READ_TOC', native.IOCTL_CDROM_READ_TOC, 0x00024000);
  eq('IOCTL_CDROM_READ_TOC_EX', native.IOCTL_CDROM_READ_TOC_EX, 0x00024054);
  eq('IOCTL_CDROM_RAW_READ', native.IOCTL_CDROM_RAW_READ, 0x0002403E);
  eq('IOCTL_CDROM_EJECT_MEDIA', native.IOCTL_CDROM_EJECT_MEDIA, 0x00024808);
  eq('IOCTL_CDROM_LOAD_MEDIA', native.IOCTL_CDROM_LOAD_MEDIA, 0x0002480C);
  eq('IOCTL_CDROM_CLOSE_DOOR（= STORAGE_LOAD_MEDIA，旧值已废弃）', native.IOCTL_CDROM_CLOSE_DOOR, 0x002D480C);
  eq('IOCTL_STORAGE_LOAD_MEDIA', native.IOCTL_STORAGE_LOAD_MEDIA, 0x002D480C);
  eq('IOCTL_STORAGE_CHECK_VERIFY', native.IOCTL_STORAGE_CHECK_VERIFY, 0x002D4800);
  eq('IOCTL_STORAGE_CHECK_VERIFY2', native.IOCTL_STORAGE_CHECK_VERIFY2, 0x002D0804);
  eq('TRACK_MODE_CDDA', native.TRACK_MODE_CDDA, 2);
  eq('CONTROL_DATA_TRACK', native.CONTROL_DATA_TRACK, 0x04);

  // CTL_CODE 公式自洽：每个常量都必须能由 (DeviceType, Function, Method, Access) 复算出来
  const ctl = (dev, fn, method, access) => (dev << 16) | (access << 14) | (fn << 2) | method;
  eq('READ_TOC 符合 CTL_CODE(0x2,0x00,BUFFERED,READ)', ctl(0x2, 0x00, 0, 1), native.IOCTL_CDROM_READ_TOC);
  eq('READ_TOC_EX 符合 CTL_CODE(0x2,0x15,BUFFERED,READ)', ctl(0x2, 0x15, 0, 1), native.IOCTL_CDROM_READ_TOC_EX);
  eq('RAW_READ 符合 CTL_CODE(0x2,0x0F,OUT_DIRECT,READ)', ctl(0x2, 0x0F, 2, 1), native.IOCTL_CDROM_RAW_READ);
  eq('EJECT_MEDIA 符合 CTL_CODE(0x2,0x202,BUFFERED,READ)', ctl(0x2, 0x202, 0, 1), native.IOCTL_CDROM_EJECT_MEDIA);
  eq('LOAD_MEDIA 符合 CTL_CODE(0x2,0x203,BUFFERED,READ)', ctl(0x2, 0x203, 0, 1), native.IOCTL_CDROM_LOAD_MEDIA);
  eq('CHECK_VERIFY 符合 CTL_CODE(0x2D,0x200,BUFFERED,READ)', ctl(0x2D, 0x200, 0, 1), native.IOCTL_STORAGE_CHECK_VERIFY);
  eq('CHECK_VERIFY2 符合 CTL_CODE(0x2D,0x201,BUFFERED,ANY)', ctl(0x2D, 0x201, 0, 0), native.IOCTL_STORAGE_CHECK_VERIFY2);
  eq('STORAGE_LOAD_MEDIA 符合 CTL_CODE(0x2D,0x203,BUFFERED,READ)', ctl(0x2D, 0x203, 0, 1), native.IOCTL_STORAGE_LOAD_MEDIA);

  // SPTI 常量（mingw-w64 ntddscsi.h：CTL_CODE(FILE_DEVICE_CONTROLLER=4, ...)）
  eq('IOCTL_SCSI_PASS_THROUGH', native.IOCTL_SCSI_PASS_THROUGH, 0x0004D004);
  eq('IOCTL_SCSI_GET_ADDRESS', native.IOCTL_SCSI_GET_ADDRESS, 0x00041018);
  eq('SCSI_IOCTL_DATA_IN', native.SCSI_IOCTL_DATA_IN, 1);
  eq('SPT 结构体大小（x64 sizeof=56 = 52 内容 + 4 字节尾部填充；写 52 会被驱动以 1306 revision mismatch 拒收）', native.SPT_STRUCT_SIZE, 56);
  eq('SPTI 单块扇区上限（27×2352=63504 < 64KB）', native.SPTI_MAX_SECTORS, 27);
  check('SPTI 上限确实小于 64KB', native.SPTI_MAX_SECTORS * 2352 < 65536);
  eq('IOCTL_RAW_READ 拆分上限与 SPTI 一致', native.IOCTL_MAX_SECTORS, native.SPTI_MAX_SECTORS);
  eq('RAW_MAX_SECTORS 是两者的共同来源', native.RAW_MAX_SECTORS, 27);
  eq('SPT 符合 CTL_CODE(0x4,0x401,BUFFERED,READ|WRITE)', ctl(0x4, 0x401, 0, 3), native.IOCTL_SCSI_PASS_THROUGH);
  eq('GET_ADDRESS 符合 CTL_CODE(0x4,0x406,BUFFERED,ANY)', ctl(0x4, 0x406, 0, 0), native.IOCTL_SCSI_GET_ADDRESS);

  console.log('# 2. readToc：优先走 READ_TOC_EX，输入结构与输出解析');
  reset();
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_CDROM_READ_TOC_EX) {
      const inBuf = args[2];
      check('EX 输入为 4 字节 CDROM_READ_TOC_EX', Buffer.isBuffer(inBuf) && inBuf.length === 4);
      check('EX 输入 byte0 = 0x80（Format=TOC(0) | Msf=1）', inBuf.readUInt8(0) === 0x80, inBuf.readUInt8(0));
      check('EX 输入 SessionTrack = 0（整碟 TOC）', inBuf.readUInt8(1) === 0);
      check('EX 输入长度参数 = 4', args[3] === 4);
      check('EX 输出缓冲 = 804 字节（CDROM_TOC）', args[5] === 4 + 100 * 8);
      STD_TOC.copy(args[4]);
      return true;
    }
    return false; // 旧指令不应被调用
  };
  const toc = native.readToc(HANDLE);
  check('返回 TOC 对象', !!toc);
  eq('first', toc.first, 1);
  eq('last', toc.last, 3);
  eq('leadout', toc.leadout, 74000);
  eq('轨道数', toc.tracks.length, 3);
  eq('track1 起始帧（绝对帧 150）', toc.tracks[0].startFrame, 150);
  eq('track2 起始帧', toc.tracks[1].startFrame, 22000);
  eq('track3 起始帧', toc.tracks[2].startFrame, 48000);
  eq('track1 音频标记', toc.tracks[0].audio, true);
  eq('track1 时长（秒）', toc.tracks[0].durationSec, (22000 - 150) / 75);
  check('EX 成功即止（未回退旧指令）',
    !ioCalls().some((c) => c.args[1] === native.IOCTL_CDROM_READ_TOC));

  console.log('# 3. readToc：EX 失败时回退旧 READ_TOC（老驱动/虚拟光驱）');
  reset();
  let legacyCalled = false;
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_CDROM_READ_TOC_EX) return false;
    if (args[1] === native.IOCTL_CDROM_READ_TOC) {
      legacyCalled = true;
      check('旧指令无输入缓冲', args[2] === null && args[3] === 0);
      STD_TOC.copy(args[4]);
      return true;
    }
    return undefined;
  };
  const toc2 = native.readToc(HANDLE);
  check('旧指令被调用（回退生效）', legacyCalled);
  eq('回退后 leadout', toc2.leadout, 74000);
  eq('回退后轨道数', toc2.tracks.length, 3);
  eq('回退后 track1 起始帧', toc2.tracks[0].startFrame, 150);

  console.log('# 4. readToc：两条路径都失败 → 抛 EWIN32（带 Windows 错误码）');
  reset();
  script = (fn, args) => {
    if (fn === 'DeviceIoControl') return false;
    if (fn === 'GetLastError') return 21; // ERROR_NOT_READY
    return undefined;
  };
  let threw = null;
  try { native.readToc(HANDLE); } catch (e) { threw = e; }
  check('抛出错误', !!threw);
  check('错误码 EWIN32', threw && threw.code === 'EWIN32', threw && threw.code);
  check('winCode = 21', threw && threw.winCode === 21, threw && threw.winCode);

  console.log('# 5. 数据轨判定（CONTROL_DATA_TRACK = 0x04，旧值 0x08 是四声道位）');
  reset();
  const mixedToc = buildToc([
    trackEntry(1, 150, 0x00),
    trackEntry(2, 22000, 0x04),   // 数据轨（CD-Extra 混合盘）
    trackEntry(0xAA, 74000, 0x00)
  ], 1, 2);
  script = (fn, args) => {
    if (fn === 'DeviceIoControl' && args[1] === native.IOCTL_CDROM_READ_TOC_EX) { mixedToc.copy(args[4]); return true; }
    return undefined;
  };
  const toc3 = native.readToc(HANDLE);
  eq('音频轨标记（track1, control=0x0）', toc3.tracks[0].audio, true);
  eq('数据轨标记（track2, control=0x4）', toc3.tracks[1].audio, false);
  eq('control 原值保留', toc3.tracks[1].control, 0x4);

  reset();
  const quadToc = buildToc([trackEntry(1, 150, 0x08), trackEntry(0xAA, 74000, 0x00)], 1, 1);
  script = (fn, args) => {
    if (fn === 'DeviceIoControl' && args[1] === native.IOCTL_CDROM_READ_TOC_EX) { quadToc.copy(args[4]); return true; }
    return undefined;
  };
  const toc4 = native.readToc(HANDLE);
  eq('四声道位 0x8 不算数据轨', toc4.tracks[0].audio, true);

  console.log('# 6. rawRead：RAW_READ_INFO 输入结构 + 大请求自动拆分（≤27 扇区/笔）');
  reset();
  const readInfos = [];
  let rawReadIdx = 0;
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    check('使用 IOCTL_CDROM_RAW_READ(0x2403E)', args[1] === native.IOCTL_CDROM_RAW_READ, args[1]);
    const inBuf = args[2];
    check('输入结构 16 字节', Buffer.isBuffer(inBuf) && inBuf.length === 16);
    readInfos.push({
      offset: Number(inBuf.readBigInt64LE(0)),
      count: inBuf.readUInt32LE(8),
      mode: inBuf.readUInt32LE(12),
      outSize: args[5]
    });
    // 每笔填不同标记字节：既做内容校验，也避免全零触发 SPTI 验证路径
    const fill = [0xA1, 0xA2, 0xA3][rawReadIdx++];
    const outBuf = args[4];
    for (let i = 0; i < outBuf.length; i++) outBuf.writeUInt8(fill, i);
    return true;
  };
  const data = native.rawRead(HANDLE, 12345, 75);
  check('返回 176400 字节 PCM', data.length === 75 * 2352, data.length);
  eq('75 扇区拆成 3 笔（27+27+21）', readInfos.length, 3);
  eq('第 1 笔 SectorCount', readInfos[0].count, 27);
  eq('第 2 笔 SectorCount', readInfos[1].count, 27);
  eq('第 3 笔 SectorCount', readInfos[2].count, 21);
  eq('第 1 笔 DiskOffset = 12345 × 2048', readInfos[0].offset, 12345 * 2048);
  eq('第 2 笔 DiskOffset = 12372 × 2048（接续不重不漏）', readInfos[1].offset, 12372 * 2048);
  eq('第 3 笔 DiskOffset = 12399 × 2048（接续不重不漏）', readInfos[2].offset, 12399 * 2048);
  check('每笔 TrackMode = CDDA(2)', readInfos.every((r) => r.mode === 2));
  check('每笔输出缓冲 = 扇区数 × 2352', readInfos.every((r) => r.outSize === r.count * 2352));
  check('每笔都不超 27 扇区上限（64KB）', readInfos.every((r) => r.count <= native.IOCTL_MAX_SECTORS));
  check('拼接顺序：前 27 扇区来自笔1（0xA1）', data.subarray(0, 100).every((b) => b === 0xA1));
  check('拼接顺序：中 27 扇区来自笔2（0xA2）', data.subarray(27 * 2352, 27 * 2352 + 100).every((b) => b === 0xA2));
  check('拼接顺序：尾 21 扇区来自笔3（0xA3）', data.subarray(54 * 2352, 54 * 2352 + 100).every((b) => b === 0xA3));
  eq('非零数据不触发 SPTI 验证（零额外 IOCTL）', ioCalls().length, 3);

  console.log('# 6b. rawReadIoctlSingle：单笔不拆（诊断工具直接验证大传输上限）');
  reset();
  const single = [];
  script = (fn, args) => {
    if (fn === 'DeviceIoControl') { single.push(args[2].readUInt32LE(8)); return true; }
    return undefined;
  };
  const d6b = native.rawReadIoctlSingle(HANDLE, 100, 75);
  eq('单笔发出（不拆）', single.length, 1);
  eq('单笔 SectorCount = 75', single[0], 75);
  check('返回 176400 字节', d6b.length === 75 * 2352, d6b.length);

  console.log('# 6c. rawRead：小请求（≤27 扇区）不拆，保持单笔（能力测试 2 扇区同参）');
  reset();
  const small = [];
  script = (fn, args) => {
    if (fn === 'DeviceIoControl') { small.push(args[2].readUInt32LE(8)); return true; }
    return undefined;
  };
  native.rawRead(HANDLE, 500, 2);
  eq('2 扇区单笔', small.length, 1);
  eq('SectorCount = 2', small[0], 2);

  console.log('# 6d. rawRead：恰好 27 扇区边界不拆');
  reset();
  const edge = [];
  script = (fn, args) => {
    if (fn === 'DeviceIoControl') { edge.push(args[2].readUInt32LE(8)); return true; }
    return undefined;
  };
  native.rawRead(HANDLE, 700, 27);
  eq('27 扇区单笔', edge.length, 1);
  eq('SectorCount = 27', edge[0], 27);

  console.log('# 7. checkMedia：VERIFY2 → VERIFY 回退链');
  reset();
  script = (fn, args) => {
    if (fn === 'DeviceIoControl' && args[1] === native.IOCTL_STORAGE_CHECK_VERIFY2) return true;
    return undefined;
  };
  let m = native.checkMedia(HANDLE);
  check('VERIFY2 成功 → 有盘', m.supported === true && m.present === true, m);

  reset();
  script = (fn, args) => {
    if (fn === 'DeviceIoControl') {
      if (args[1] === native.IOCTL_STORAGE_CHECK_VERIFY2) return false;
      if (args[1] === native.IOCTL_STORAGE_CHECK_VERIFY) return true;
    }
    if (fn === 'GetLastError') return 50; // ERROR_NOT_SUPPORTED
    return undefined;
  };
  m = native.checkMedia(HANDLE);
  check('VERIFY2 不支持 → 回退 VERIFY 成功 → 有盘', m.supported === true && m.present === true, m);

  reset();
  script = (fn, args) => {
    if (fn === 'DeviceIoControl') {
      if (args[1] === native.IOCTL_STORAGE_CHECK_VERIFY2) return false;
      if (args[1] === native.IOCTL_STORAGE_CHECK_VERIFY) return false;
    }
    if (fn === 'GetLastError') return 21; // ERROR_NOT_READY（非"不支持"类）
    return undefined;
  };
  m = native.checkMedia(HANDLE);
  check('两条都失败（就绪类错误）→ 无盘', m.supported === true && m.present === false, m);

  reset();
  script = (fn, args) => {
    if (fn === 'DeviceIoControl') return false;
    if (fn === 'GetLastError') return 1; // ERROR_INVALID_FUNCTION
    return undefined;
  };
  m = native.checkMedia(HANDLE);
  check('两条都不支持 → supported=false', m.supported === false && m.present === true, m);

  console.log('# 8. trayControl / openCdDevice');
  reset();
  script = (fn, args) => {
    if (fn === 'DeviceIoControl') {
      check('托盘指令码透传（关舱 = 0x2D480C）', args[1] === 0x002D480C, args[1]);
      return true;
    }
    return undefined;
  };
  native.trayControl(HANDLE, native.IOCTL_CDROM_CLOSE_DOOR);

  reset();
  script = (fn, args) => {
    if (fn === 'CreateFileW') {
      const p = args[0].toString('utf16le').replace(/\0$/, '');
      check('设备路径为 \\\\.\\D:', p === '\\\\.\\D:', p);
      check('访问权限 GENERIC_READ|GENERIC_WRITE（SPTI 回退需要写权限）',
        args[1] === -1073741824 /* 0xC0000000，JS 位运算为有符号 int32 */, args[1]);
      check('共享模式 读|写', args[2] === 0x00000003, args[2]);
      return 1n;
    }
    return undefined;
  };
  const h = native.openCdDevice('D');
  check('打开设备返回有效句柄', h !== 0n && h !== -1n, String(h));

  reset();
  let openAttempts = 0;
  script = (fn) => {
    if (fn === 'CreateFileW') {
      openAttempts++;
      // 第一次（读写权限）被拒，第二次（只读）成功 —— 部分设备/共享场景如此
      return openAttempts === 1 ? -1n : 1n;
    }
    if (fn === 'GetLastError') return 5; // ERROR_ACCESS_DENIED
    return undefined;
  };
  const h2 = native.openCdDevice('D');
  check('写权限被拒 → 回退只读打开成功', h2 !== 0n && h2 !== -1n && openAttempts === 2, openAttempts);

  reset();
  script = (fn) => {
    if (fn === 'CreateFileW') return -1n; // 两次都被拒
    if (fn === 'GetLastError') return 2;  // ERROR_FILE_NOT_FOUND
    return undefined;
  };
  let openErr = null;
  try { native.openCdDevice('Z'); } catch (e) { openErr = e; }
  check('打开失败抛 EWIN32', openErr && openErr.code === 'EWIN32' && openErr.winCode === 2, openErr && openErr.code);

  console.log('# 9. rawRead：IOCTL_RAW_READ 失败 → SPTI READ CD 回退（★ 物理光驱修复）');
  reset();
  const H9 = 9n;
  const sptCalls = [];
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_CDROM_RAW_READ) return false; // 驱动不支持 RAW_READ
    if (args[1] === native.IOCTL_SCSI_GET_ADDRESS) {
      const out = args[4];
      out.writeUInt32LE(8, 0); // Length
      out.writeUInt8(0, 4);    // PortNumber
      out.writeUInt8(2, 5);    // PathId
      out.writeUInt8(1, 6);    // TargetId
      out.writeUInt8(0, 7);    // Lun
      return true;
    }
    if (args[1] === native.IOCTL_SCSI_PASS_THROUGH) {
      const buf = args[2]; // 非 DIRECT：inBuf = 结构 + sense + data，outBuf 同一缓冲
      const c = {
        length: buf.readUInt16LE(0),
        scsiStatus: buf.readUInt8(2),
        pathId: buf.readUInt8(3), targetId: buf.readUInt8(4), lun: buf.readUInt8(5),
        cdbLength: buf.readUInt8(6), senseLen: buf.readUInt8(7),
        dataIn: buf.readUInt32LE(8),
        dataTransferLength: buf.readUInt32LE(12),
        timeout: buf.readUInt32LE(16),
        dataBufferOffset: Number(buf.readBigUInt64LE(24)),
        senseInfoOffset: buf.readUInt32LE(32),
        cdb: Array.from(buf.subarray(36, 48)),
        bufLen: buf.length,
        inLen: args[3], outLen: args[5]
      };
      sptCalls.push(c);
      buf.writeUInt8(0, 2); // ScsiStatus = GOOD
      // 每块 data 区填块号常量，便于验证拼接顺序
      const fill = [0x11, 0x22, 0x33][sptCalls.length - 1];
      for (let i = 0; i < c.dataTransferLength; i++) buf.writeUInt8(fill, 88 + i);
      return true;
    }
    return undefined;
  };
  const d9 = native.rawRead(H9, 0, 75);
  check('75 扇区 → 返回 176400 字节', d9.length === 75 * 2352, d9.length);
  eq('RAW_READ IOCTL 只试一次（失败即永久切 SPTI）',
    ioCalls().filter((c) => c.args[1] === native.IOCTL_CDROM_RAW_READ).length, 1);
  eq('SPTI 调用次数（27+27+21）', sptCalls.length, 3);
  eq('第一块 length = 56（x64 sizeof，含尾部填充）', sptCalls[0].length, 56);
  eq('第一块 pathId/targetId/lun（来自 GET_ADDRESS）',
    sptCalls[0].pathId * 100 + sptCalls[0].targetId * 10 + sptCalls[0].lun, 210);
  eq('第一块 cdbLength = 12', sptCalls[0].cdbLength, 12);
  eq('第一块 senseInfoLength = 32', sptCalls[0].senseLen, 32);
  eq('第一块 dataIn = SCSI_IOCTL_DATA_IN', sptCalls[0].dataIn, 1);
  eq('第一块 dataTransferLength = 27×2352', sptCalls[0].dataTransferLength, 27 * 2352);
  eq('第一块 timeout = 30s', sptCalls[0].timeout, 30);
  eq('第一块 dataBufferOffset = 88', sptCalls[0].dataBufferOffset, 88);
  eq('第一块 senseInfoOffset = 56', sptCalls[0].senseInfoOffset, 56);
  eq('第一块缓冲总长 = 88 + 27×2352', sptCalls[0].bufLen, 88 + 27 * 2352);
  eq('第一块 in/out 长度一致（同一缓冲）', sptCalls[0].inLen, sptCalls[0].bufLen);
  eq('第一块 outBuf 长度一致', sptCalls[0].outLen, sptCalls[0].bufLen);
  // READ CD CDB 字节级断言（MMC-4 + Linux sr_read_cd）
  eq('第一块 CDB opcode = 0xBE（READ CD）', sptCalls[0].cdb[0], 0xBE);
  eq('第一块 CDB expected sector type = CD-DA(0x04)', sptCalls[0].cdb[1], 0x04);
  eq('第一块 CDB LBA = 0', sptCalls[0].cdb.slice(2, 6).join(','), '0,0,0,0');
  eq('第一块 CDB TransferLength = 27', sptCalls[0].cdb.slice(6, 9).join(','), '0,0,27');
  eq('第一块 CDB 主通道 = 0xF8（完整 2352B 扇区）', sptCalls[0].cdb[9], 0xF8);
  eq('第一块 CDB 子通道 = 0', sptCalls[0].cdb[10], 0);
  eq('第二块 CDB LBA = 27', sptCalls[1].cdb.slice(2, 6).join(','), '0,0,0,27');
  eq('第三块 CDB LBA = 54', sptCalls[2].cdb.slice(2, 6).join(','), '0,0,0,54');
  eq('第三块 CDB TransferLength = 21', sptCalls[2].cdb.slice(6, 9).join(','), '0,0,21');
  // 拼接顺序：块1(0x11) → 块2(0x22) → 块3(0x33)
  check('前 27 扇区来自块1（0x11）', d9.subarray(0, 100).every((b) => b === 0x11));
  check('中 27 扇区来自块2（0x22）', d9.subarray(27 * 2352, 27 * 2352 + 100).every((b) => b === 0x22));
  check('尾 21 扇区来自块3（0x33）', d9.subarray(54 * 2352, 54 * 2352 + 100).every((b) => b === 0x33));

  console.log('# 10. SPTI 大 LBA（>24 位）字节序 + 生效方法缓存');
  reset();
  const sptCalls2 = [];
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_SCSI_PASS_THROUGH) {
      sptCalls2.push(Array.from(args[2].subarray(36, 48)));
      args[2].writeUInt8(0, 2);
      return true;
    }
    return undefined;
  };
  // H9 已缓存 mode='spti' + addr，本次直接走 SPTI，不再试 IOCTL
  native.rawRead(H9, 0x01020304, 10);
  eq('大 LBA CDB 字节序（大端）', sptCalls2[0].slice(2, 6).join(','), '1,2,3,4');
  eq('rawReadMethod 报告 spti', native.rawReadMethod(H9), 'spti');
  check('缓存后不再调用 IOCTL_CDROM_RAW_READ',
    !ioCalls().some((c) => c.args[1] === native.IOCTL_CDROM_RAW_READ));

  console.log('# 11. getScsiAddress：取不到地址 → ERAWREAD（sptiNoAddr）');
  reset();
  const H11 = 11n;
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_CDROM_RAW_READ) return false;
    if (args[1] === native.IOCTL_SCSI_GET_ADDRESS) return false; // 老驱动不认识
    return undefined;
  };
  let err11 = null;
  try { native.rawRead(H11, 0, 2); } catch (e) { err11 = e; }
  check('抛 ERAWREAD', err11 && err11.code === 'ERAWREAD', err11 && err11.code);
  check('diag.sptiNoAddr = true', err11 && err11.diag && err11.diag.sptiNoAddr === true, err11 && err11.diag);
  check('diag 带 IOCTL 失败码', err11 && err11.diag && typeof err11.diag.ioctlWinCode === 'number');

  console.log('# 12. SPTI CHECK_CONDITION：sense 数据进入诊断');
  reset();
  const H12 = 12n;
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_CDROM_RAW_READ) return false;
    if (args[1] === native.IOCTL_SCSI_GET_ADDRESS) {
      args[4].writeUInt8(2, 5); args[4].writeUInt8(1, 6);
      return true;
    }
    if (args[1] === native.IOCTL_SCSI_PASS_THROUGH) {
      args[2].writeUInt8(2, 2); // ScsiStatus = CHECK_CONDITION
      // fixed format sense @56：response code 0x70, key@2, asc@12, ascq@13
      args[2].writeUInt8(0x70, 56);
      args[2].writeUInt8(0x06, 58); // sense key: UNIT ATTENTION
      args[2].writeUInt8(0x29, 56 + 12); // asc: POWER ON / RESET
      args[2].writeUInt8(0x00, 56 + 13); // ascq
      return true;
    }
    return undefined;
  };
  let err12 = null;
  try { native.rawRead(H12, 0, 2); } catch (e) { err12 = e; }
  check('抛 ERAWREAD', err12 && err12.code === 'ERAWREAD');
  check('诊断含 sense 06/29/00', err12 && /sense 06\/29\/00/.test(err12.message), err12 && err12.message);
  check('diag.scsiStatus = 2', err12 && err12.diag && err12.diag.scsiStatus === 2);
  check('diag.senseKey = 6', err12 && err12.diag && err12.diag.senseKey === 6);
  check('diag.asc = 0x29', err12 && err12.diag && err12.diag.asc === 0x29);

  console.log('# 13. broken 态：后续调用直接抛缓存原因，不再发任何 IOCTL');
  reset();
  script = null; // 全部走默认成功也无所谓——不应再有调用
  let err13 = null;
  try { native.rawRead(H12, 0, 2); } catch (e) { err13 = e; }
  check('再次抛错', !!err13);
  check('错误信息与首次一致（缓存原因）', err13 && err13.message === err12.message);
  eq('broken 后零 DeviceIoControl 调用', ioCalls().length, 0);
  eq('rawReadMethod 报告 broken', native.rawReadMethod(H12), 'broken');

  console.log('# 14. scsiReadCd / getScsiAddress 单独导出（冒烟工具用）');
  reset();
  const H14 = 14n;
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_SCSI_GET_ADDRESS) {
      args[4].writeUInt8(3, 5); args[4].writeUInt8(2, 6); args[4].writeUInt8(1, 7);
      return true;
    }
    if (args[1] === native.IOCTL_SCSI_PASS_THROUGH) {
      args[2].writeUInt8(0, 2);
      for (let i = 0; i < 2 * 2352; i++) args[2].writeUInt8(0xAB, 88 + i);
      return true;
    }
    return undefined;
  };
  const addr14 = native.getScsiAddress(H14);
  check('GET_ADDRESS 解析出 path/target/lun',
    addr14 && addr14.pathId === 3 && addr14.targetId === 2 && addr14.lun === 1, addr14);
  const d14 = native.scsiReadCd(H14, addr14, 100, 2);
  check('scsiReadCd 返回 2×2352 字节', d14.length === 2 * 2352, d14.length);
  check('scsiReadCd 数据来自 data 区（@88）', d14[0] === 0xAB && d14[d14.length - 1] === 0xAB);
  // closeDevice 清理 readStates（防止 Map 泄漏）
  native.closeDevice(H14);
  eq('closeDevice 后 rawReadMethod = null', native.rawReadMethod(H14), null);

  /* ---------- #15~17：IOCTL "成功但全零" → SPTI 验证（★ 物理光驱修复补强） ---------- */
  // 类驱动缺陷的两种表现：抛错（#9 已覆盖）/ 成功但全零。后者早期只被能力测试
  // 判死刑走 MCI，SPTI 从未被尝试——同一台光驱的 READ CD 明明是好的。

  console.log('# 15. IOCTL 成功但全零 → SPTI 有真数据 → 永久切 SPTI 并返回真数据');
  reset();
  const H15 = 15n;
  let spti15Count = 0;
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_CDROM_RAW_READ) {
      return true; // "成功"，但 out 缓冲保持全零（驱动缺陷的假成功）
    }
    if (args[1] === native.IOCTL_SCSI_GET_ADDRESS) {
      args[4].writeUInt8(0, 5); args[4].writeUInt8(1, 6); args[4].writeUInt8(0, 7);
      return true;
    }
    if (args[1] === native.IOCTL_SCSI_PASS_THROUGH) {
      spti15Count++;
      args[2].writeUInt8(0, 2); // ScsiStatus = GOOD
      for (let i = 0; i < 2 * 2352; i++) args[2].writeUInt8(0x5A, 88 + i);
      return true;
    }
    return undefined;
  };
  const d15 = native.rawRead(H15, 10, 2);
  check('SPTI 被调用过（全零触发了验证）', spti15Count === 1, spti15Count);
  check('返回 SPTI 的真数据（非全零）', d15[0] === 0x5A && d15.length === 2 * 2352, d15[0]);
  eq('生效方法切为 spti', native.rawReadMethod(H15), 'spti');
  // 二次读取直接走 SPTI，不再试 IOCTL（只清 calls，保留 script）
  calls.length = 0;
  const d15b = native.rawRead(H15, 12, 2);
  eq('二次读取零 RAW_READ 调用（模式已缓存）',
    ioCalls().filter((c) => c.args[1] === native.IOCTL_CDROM_RAW_READ).length, 0);
  check('二次读取仍拿到 SPTI 数据', d15b[0] === 0x5A, d15b[0]);

  console.log('# 16. IOCTL 全零 → SPTI 也全零 → 留在 ioctl（数字静音不误切）');
  reset();
  const H16 = 16n;
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_CDROM_RAW_READ) return true; // 全零
    if (args[1] === native.IOCTL_SCSI_GET_ADDRESS) {
      args[4].writeUInt8(0, 5); args[4].writeUInt8(1, 6); args[4].writeUInt8(0, 7);
      return true;
    }
    if (args[1] === native.IOCTL_SCSI_PASS_THROUGH) {
      args[2].writeUInt8(0, 2); // GOOD，data 区全零（真静音）
      return true;
    }
    return undefined;
  };
  const d16 = native.rawRead(H16, 20, 2);
  check('返回 IOCTL 的全零数据（不抛错）', d16.length === 2 * 2352 && d16.every((b) => b === 0));
  eq('生效方法留在 ioctl', native.rawReadMethod(H16), 'ioctl');

  console.log('# 17. IOCTL 全零 → SPTI 抛错 → 留在 ioctl 返回全零（IOCTL 可用，不判死刑）');
  reset();
  const H17 = 17n;
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_CDROM_RAW_READ) return true; // 全零
    if (args[1] === native.IOCTL_SCSI_PASS_THROUGH) return false; // SPTI 坏
    if (fn === 'GetLastError') return 21; // ERROR_NOT_READY
    return undefined;
  };
  let threw17 = null;
  let d17 = null;
  try { d17 = native.rawRead(H17, 30, 2); } catch (e) { threw17 = e; }
  check('不抛错（IOCTL 路径照常可用）', !threw17, threw17 && threw17.message);
  check('返回全零数据', d17 && d17.length === 2 * 2352 && d17.every((b) => b === 0));
  eq('生效方法留在 ioctl', native.rawReadMethod(H17), 'ioctl');
  eq('没有进入 broken', native.rawReadMethod(H17) !== 'broken', true);

  console.log('# 18. IOCTL 抛错 → SPTI 全零 → 留在 spti（v6 行为保持）');
  reset();
  const H18 = 18n;
  script = (fn, args) => {
    if (fn !== 'DeviceIoControl') return undefined;
    if (args[1] === native.IOCTL_CDROM_RAW_READ) return false; // 抛错
    if (args[1] === native.IOCTL_SCSI_GET_ADDRESS) {
      args[4].writeUInt8(0, 5); args[4].writeUInt8(1, 6); args[4].writeUInt8(0, 7);
      return true;
    }
    if (args[1] === native.IOCTL_SCSI_PASS_THROUGH) {
      args[2].writeUInt8(0, 2); // GOOD，data 全零
      return true;
    }
    if (fn === 'GetLastError') return 21;
    return undefined;
  };
  const d18 = native.rawRead(H18, 40, 2);
  check('返回 SPTI 的全零数据（不抛错）', d18.length === 2 * 2352 && d18.every((b) => b === 0));
  eq('生效方法为 spti', native.rawReadMethod(H18), 'spti');

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
