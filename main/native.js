'use strict';
/*
 * native.js —— Windows 原生 API 绑定（基于 koffi，N-API，兼容 Electron 22 / Node 16）。
 *
 * 仅面向 Windows。主进程与 worker 线程均可加载。
 * 所有宽字符串参数均以 UTF-16LE Buffer 传递，避免平台差异。
 */

const koffi = require('koffi');

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const DRIVE_CDROM = 5;
const DRIVE_REMOVABLE = 2; // USB 外置光驱常被系统报告为"可移动磁盘"，同样纳入探测

/*
 * IOCTL 常量。CTL_CODE(DeviceType, Function, Method, Access)
 *   = (DeviceType << 16) | (Access << 14) | (Function << 2) | Method
 *   FILE_DEVICE_CD_ROM      = 0x2    FILE_DEVICE_MASS_STORAGE = 0x2D
 *   FILE_READ_ACCESS        = 1      FILE_ANY_ACCESS         = 0
 *   METHOD_BUFFERED         = 0      METHOD_OUT_DIRECT       = 2
 *
 * 取值经 Wine ntddcdrm.h、DDK6000 IOCTL 表与《CD Cracking Uncovered》三方交叉确认。
 *
 * ★ 历史故障（raw 读取完全不可用的根因）：旧值全部漏掉了 FILE_READ_ACCESS 位
 *   （0x0002xxxx 而非 0x000240xx），RAW_READ 误写为 0x00038000，
 *   CLOSE_DOOR 用了驱动早已废弃的 0x00020010。
 */
const IOCTL_CDROM_READ_TOC = 0x00024000;      // Function=0x00, METHOD_BUFFERED,  FILE_READ_ACCESS
const IOCTL_CDROM_READ_TOC_EX = 0x00024054;   // Function=0x15, METHOD_BUFFERED,  FILE_READ_ACCESS（XP 起，READ_TOC 的现代替代）
const IOCTL_CDROM_EJECT_MEDIA = 0x00024808;   // Function=0x202, METHOD_BUFFERED, FILE_READ_ACCESS
const IOCTL_CDROM_LOAD_MEDIA = 0x0002480C;    // Function=0x203, METHOD_BUFFERED, FILE_READ_ACCESS
const IOCTL_CDROM_RAW_READ = 0x0002403E;      // Function=0x0F, METHOD_OUT_DIRECT, FILE_READ_ACCESS

// CTL_CODE(FILE_DEVICE_MASS_STORAGE, n, METHOD, ACCESS)
// 用于"盘还在吗"的轻量探测：比 READ_TOC 便宜得多，且不弹系统"请插入磁盘"对话框
const IOCTL_STORAGE_CHECK_VERIFY = 0x002D4800;  // Function=0x200, METHOD_BUFFERED, FILE_READ_ACCESS
const IOCTL_STORAGE_CHECK_VERIFY2 = 0x002D0804; // Function=0x201, METHOD_BUFFERED, FILE_ANY_ACCESS
const IOCTL_STORAGE_LOAD_MEDIA = 0x002D480C;    // Function=0x203, METHOD_BUFFERED, FILE_READ_ACCESS
/**
 * IOCTL_CDROM_CLOSE_DOOR 的旧值（0x00020010）早已被 CD-ROM 类驱动废弃，
 * 微软官方文档指定以 IOCTL_STORAGE_LOAD_MEDIA 取代。导出名保持不变，调用方无需改动。
 */
const IOCTL_CDROM_CLOSE_DOOR = IOCTL_STORAGE_LOAD_MEDIA;

/*
 * SPTI（SCSI Pass Through Interface）回退链 —— 应对 IOCTL_CDROM_RAW_READ
 * 不可用的物理光驱（EAC / cdrdao 同款思路）。
 *
 * 症状：能力测试时 IOCTL_CDROM_RAW_READ 返回成功但数据全零，或直接报错，
 * 而同一台光驱用普通播放软件（走 MCI/ASP I）放盘完全正常。根因是部分
 * 物理光驱（尤其 SATA/USB 桥接）的 cdrom 类驱动对 RAW_READ 支持不完整，
 * 但底层的 READ CD(0xBE) SCSI 指令是好的 —— 直接对端口驱动发 SCSI 命令
 * 即可绕过类驱动的缺陷。
 *
 * 取值经 mingw-w64 ntddscsi.h（跟随 Windows SDK）确认：
 *   IOCTL_SCSI_PASS_THROUGH      = CTL_CODE(0x04, 0x0401, BUFFERED, READ|WRITE) = 0x4D004
 *   IOCTL_SCSI_GET_ADDRESS       = CTL_CODE(0x04, 0x0406, BUFFERED, ANY)        = 0x41018
 * 用非 DIRECT 版本（SCSI_PASS_THROUGH）：DataBufferOffset 是偏移而非指针，
 * 且系统负责缓冲对齐，无需调用方分配对齐缓冲，纯手工布局即可。
 *
 * SCSI_PASS_THROUGH（ntddscsi.h；x64 sizeof=56）：
 *   Length u16@0 / ScsiStatus u8@2 / PathId@3 / TargetId@4 / Lun@5 /
 *   CdbLength@6 / SenseInfoLength@7 / DataIn u8@8 / DataTransferLength u32@12 /
 *   TimeOutValue u32@16 / DataBufferOffset u64@24 / SenseInfoOffset u32@32 /
 *   Cdb[16]@36
 * 两个易错点（v9 及以前 SPTI 全线 0x51a 就是第一个）：
 *  ① DataBufferOffset 是 ULONG_PTR（现行 MSDN / mingw-w64 / wine 三处头文件
 *     一致；勿信旧文档的 ULONG——那对应 44 字节的 SCSI_PASS_THROUGH32 布局）。
 *     字段内容到 52 字节，但含 8 字节成员的结构体对齐为 8，sizeof 要补 4 字节
 *     尾部填充 = 56，Length 必须写 56；写 52 会被 storport 以
 *     STATUS_REVISION_MISMATCH（ERROR_REVISION_MISMATCH=1306="two revision
 *     levels are incompatible"）拒收，SCSI 命令根本发不出去。
 *  ② 32/64 位布局不同（44 vs 56），Length 与各字段偏移必须成套替换。
 */
const IOCTL_SCSI_PASS_THROUGH = 0x0004D004;
const IOCTL_SCSI_GET_ADDRESS = 0x00041018;
const SCSI_IOCTL_DATA_IN = 1;
const SCSISTAT_GOOD = 0x00;
const SCSISTAT_CHECK_CONDITION = 0x02;
const SPT_STRUCT_SIZE = 56;      // x64 sizeof(SCSI_PASS_THROUGH) = 52 内容 + 4 尾部填充
const SPT_SENSE_LEN = 32;        // request-sense 缓冲（fixed format 0x70）
const SPT_SENSE_OFF = 56;        // = 56 字节结构之后（已 8 对齐，无需 filler）
const SPT_DATA_OFF = 88;         // = 56 + 32 sense
/**
 * 单次 RAW 读取的最大扇区数：27 × 2352 = 63,504 < 64KB。
 * 这是 storport/ATAPI 常见 MaximumTransferLength 上限（民间"27 扇区上限"的
 * 出处，cdrdao / EAC 同样保守取 26~27）。SPTI 必须按块发；IOCTL_CDROM_RAW_READ
 * 路径按老经验"类驱动自己会拆"不必拆，但播放 worker 曾按 75 扇区（176KB）单笔
 * 请求，超过 64KB 经典上限，部分 miniport 会直接拒掉（表现为能力测试过、
 * 播放中连片失败）。两边统一拆到 ≤27 扇区，多几笔 IOCTL 的成本可忽略。
 */
const RAW_MAX_SECTORS = 27;
const SPTI_MAX_SECTORS = RAW_MAX_SECTORS;
const IOCTL_MAX_SECTORS = RAW_MAX_SECTORS;

// TRACK_MODE_TYPE 枚举
const TRACK_MODE_CDDA = 2;

// TRACK_DATA.Control 位（TRACK_DATA 第 2 字节的高 4 位）
// Wine ntddcdrm.h：AUDIO_WITH_PREEMPHASIS=0x0 / DIGITAL_COPY_PERMITTED=0x2 /
//                    AUDIO_DATA_TRACK=0x4     / TWO_FOUR_CHANNEL_AUDIO=0x8
// bit2 = 1 表示数据轨道，为 0 表示音频轨。旧值误用 0x08（四声道位），
// 会把 CD-Extra 混合盘的数据轨误判成音频轨。
const CONTROL_DATA_TRACK = 0x04;

let ready = false;
let kernel32 = null;
let winmm = null;
let fCreateFileW = null;
let fDeviceIoControl = null;
let fCloseHandle = null;
let fGetDriveTypeW = null;
let fGetLastError = null;
let fMciSendStringW = null;
let fMciGetErrorStringW = null;

function ensure() {
  if (ready) return;
  if (process.platform !== 'win32') {
    const err = new Error('CD 读取仅在 Windows 上可用');
    err.code = 'EUNSUPPORTED';
    throw err;
  }
  try {
    kernel32 = koffi.load('kernel32.dll');
    fCreateFileW = kernel32.func('void* __stdcall CreateFileW(void* path, uint32 access, uint32 share, void* sec, uint32 disp, uint32 flags, void* tmpl)');
    fDeviceIoControl = kernel32.func('bool __stdcall DeviceIoControl(void* h, uint32 code, void* inBuf, uint32 inSize, void* outBuf, uint32 outSize, void* returned, void* ovl)');
    fCloseHandle = kernel32.func('bool __stdcall CloseHandle(void* h)');
    fGetDriveTypeW = kernel32.func('uint32 __stdcall GetDriveTypeW(void* path)');
    fGetLastError = kernel32.func('uint32 __stdcall GetLastError()');
    winmm = koffi.load('winmm.dll');
    fMciSendStringW = winmm.func('uint32 __stdcall mciSendStringW(void* cmd, void* ret, uint32 retLen, void* cb)');
    fMciGetErrorStringW = winmm.func('bool __stdcall mciGetErrorStringW(uint32 err, void* buf, uint32 len)');
  } catch (e) {
    const err = new Error('原生模块加载失败：' + e.message);
    err.code = 'ENATIVE';
    throw err;
  }
  ready = true;
}

function wide(str) {
  return Buffer.from(str + '\0', 'utf16le');
}

function winError(action, code) {
  const err = new Error(`${action} 失败（Windows 错误码 0x${(code >>> 0).toString(16)}）`);
  err.code = 'EWIN32';
  err.winCode = code >>> 0;
  return err;
}

/**
 * 每个句柄的 RAW 读取状态机：
 *   mode: 'ioctl'（默认，走 IOCTL_CDROM_RAW_READ）
 *         'spti' （IOCTL 已确认不可用，改走 SPTI READ CD）
 *         'broken'（两条路都断，后续直接抛缓存的原因，不再做无谓系统调用）
 *   addr: SCSI_ADDRESS（PathId/TargetId/Lun），懒加载
 *   message: 进入 broken 时定格的错误文本（前后一致，方便用户对照日志）
 * 句柄关闭时清理，防止 Map 无限增长。
 */
const readStates = new Map();

function getReadState(handle) {
  let st = readStates.get(handle);
  if (!st) { st = { mode: 'ioctl', addr: null, message: null }; readStates.set(handle, st); }
  return st;
}

function openCdDevice(driveLetter) {
  ensure();
  const path = wide(`\\\\.\\${driveLetter}:`);
  let handle = fCreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, null, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null);
  let h = BigInt.asIntN(64, BigInt(handle));
  if (h === 0n || h === -1n) {
    // SPTI 需要读写权限；部分设备/共享场景拒写 → 退回只读（旧 IOCTL 路径照常可用）
    handle = fCreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, null, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null);
    h = BigInt.asIntN(64, BigInt(handle));
  }
  if (h === 0n || h === -1n) {
    const code = fGetLastError();
    throw winError(`打开 ${driveLetter}: 光驱`, code);
  }
  readStates.delete(handle); // 复用同一数值句柄时清掉上一个生命周期的状态
  return handle;
}

function closeDevice(handle) {
  if (!handle) return;
  readStates.delete(handle);
  try { fCloseHandle(handle); } catch (e) { /* 忽略 */ }
}

/** 枚举系统中的 CD-ROM 驱动器（返回 ['D','E',...]）。USB 外置光驱可能被识别为"可移动磁盘"，一并纳入，由 TOC 校验过滤。 */
function listCdDrives() {
  ensure();
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const p = wide(`${letter}:\\`);
    const type = fGetDriveTypeW(p);
    if (type === DRIVE_CDROM || type === DRIVE_REMOVABLE) drives.push(letter);
  }
  return drives;
}

/** 枚举所有存在的驱动器及类型（诊断用）。type: 2=可移动 3=固定 4=网络 5=CD-ROM */
function listAllDrives() {
  ensure();
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const p = wide(`${letter}:\\`);
    const type = fGetDriveTypeW(p);
    if (type > 1) out.push({ letter, type });
  }
  return out;
}

/**
 * CDROM_READ_TOC_EX 输入结构（4 字节）：
 *   { UCHAR Format:4; UCHAR Reserved1:3; UCHAR Msf:1; UCHAR SessionTrack; UCHAR Reserved2; UCHAR Reserved3; }
 * Format = CDROM_READ_TOC_EX_FORMAT_TOC(0) 时输出与旧 READ_TOC 完全相同的 CDROM_TOC，
 * 因此可直接复用同一套解析。Msf=1 表示地址以 MSF（分/秒/帧）返回。
 * SessionTrack=0 → 返回整碟 TOC。
 */
function readTocEx(handle, out) {
  const input = Buffer.alloc(4);
  input.writeUInt8(0x80, 0); // Format=0 | Msf=1
  input.writeUInt8(0x00, 1); // SessionTrack=0（整碟）
  const returned = Buffer.alloc(4);
  return fDeviceIoControl(handle, IOCTL_CDROM_READ_TOC_EX, input, input.length, out, out.length, returned, null);
}

/** 解析 CDROM_TOC 缓冲区 → { first, last, leadout, tracks:[{number,startFrame,endFrame,durationSec,audio,control}] } */
function parseToc(out) {
  const first = out.readUInt8(2);
  const last = out.readUInt8(3);
  if (first === 0 || last === 0 || last < first || last > 99) return null;

  const count = last - first + 2; // 轨道 + lead-out
  const tracks = [];
  let leadout = 0;
  let primary = true; // 主解析：Address[0]=分钟 [1]=秒 [2]=帧

  for (let i = 0; i < count; i++) {
    const base = 4 + i * 8;
    const control = (out.readUInt8(base + 1) >> 4) & 0x0f;
    const trackNumber = out.readUInt8(base + 2);
    const a0 = out.readUInt8(base + 4);
    const a1 = out.readUInt8(base + 5);
    const a2 = out.readUInt8(base + 6);
    const a3 = out.readUInt8(base + 7);
    const lbaPrimary = a0 * 4500 + a1 * 75 + a2;
    const lbaAlt = a1 * 4500 + a2 * 75 + a3;
    if (i === 0 && trackNumber === 1) {
      // 标准 CD 第一轨绝对地址应为 150（0:02.00）。用一致性判定 MSF 字节序。
      if (lbaPrimary >= 100 && lbaPrimary <= 300) primary = true;
      else if (lbaAlt >= 100 && lbaAlt <= 300) primary = false;
    }
    const lba = primary ? lbaPrimary : lbaAlt;
    if (trackNumber === 0xaa || i === count - 1) {
      leadout = lba;
    } else {
      tracks.push({
        number: trackNumber,
        startFrame: lba,
        audio: (control & CONTROL_DATA_TRACK) === 0,
        control
      });
    }
  }
  if (!tracks.length || leadout <= tracks[0].startFrame) return null;
  // 按起始地址排序并校验连续
  tracks.sort((a, b) => a.startFrame - b.startFrame);
  const start = tracks[0].startFrame;
  for (let i = 0; i < tracks.length; i++) {
    const end = i + 1 < tracks.length ? tracks[i + 1].startFrame : leadout;
    tracks[i].endFrame = end;
    tracks[i].durationSec = (end - start) > 0 ? (end - tracks[i].startFrame) / 75 : 0;
  }
  return { first, last, leadout, tracks };
}

/** 读取 TOC，返回 { first, last, leadout, tracks:[{number, startFrame, endFrame, durationSec, audio, control}] } */
function readToc(handle) {
  ensure();
  const out = Buffer.alloc(4 + 100 * 8); // CDROM_TOC 头 + 100 个 TRACK_DATA
  // 先走现代的 READ_TOC_EX（XP 起可用；旧 READ_TOC 自 Vista 起被官方标记废弃），
  // 失败再退回旧指令，兼容只认旧码的老驱动与部分虚拟光驱。两者输出同为 CDROM_TOC。
  let ok = readTocEx(handle, out);
  if (!ok) {
    const returned = Buffer.alloc(4);
    ok = fDeviceIoControl(handle, IOCTL_CDROM_READ_TOC, null, 0, out, out.length, returned, null);
  }
  if (!ok) {
    const code = fGetLastError();
    throw winError('读取光盘目录 (TOC)', code);
  }
  return parseToc(out);
}

/**
 * IOCTL_CDROM_RAW_READ 单笔读取（内部用，不做拆分）。
 * 失败抛 EWIN32；成功返回 count × 2352 字节。
 */
function rawReadIoctlSingle(handle, lba, count) {
  const out = Buffer.alloc(count * 2352);
  const returned = Buffer.alloc(4);
  // RAW_READ_INFO { LARGE_INTEGER DiskOffset; ULONG SectorCount; TRACK_MODE_TYPE TrackMode; }
  const input = Buffer.alloc(16);
  input.writeBigInt64LE(BigInt(lba) * 2048n, 0); // LBA × 2048（设备逻辑块字节偏移）
  input.writeUInt32LE(count, 8);
  input.writeUInt32LE(TRACK_MODE_CDDA, 12);
  const ok = fDeviceIoControl(handle, IOCTL_CDROM_RAW_READ, input, input.length, out, out.length, returned, null);
  if (!ok) {
    const code = fGetLastError();
    throw winError('读取光盘音频数据', code);
  }
  return out;
}

/**
 * IOCTL_CDROM_RAW_READ 读取（对外入口，大请求自动拆分）。
 * count ≤ 27 扇区时单笔发出；超过则按 27 扇区边界拆成多笔后拼接，
 * 规避 storport/ATAPI 的 64KB MaximumTransferLength 上限。
 */
function rawReadIoctl(handle, lba, count) {
  if (count <= IOCTL_MAX_SECTORS) return rawReadIoctlSingle(handle, lba, count);
  const parts = [];
  let done = 0;
  while (done < count) {
    const n = Math.min(IOCTL_MAX_SECTORS, count - done);
    parts.push(rawReadIoctlSingle(handle, lba + done, n));
    done += n;
  }
  return Buffer.concat(parts);
}

/**
 * 取设备的 SCSI 地址（PathId/TargetId/Lun）—— SPTI 请求的必填字段。
 * ATA/SATA 光驱同样返回有效地址（storport 统一编址）。
 * 设备不支持时返回 null（SPTI 不可用）。
 */
function getScsiAddress(handle) {
  ensure();
  // SCSI_ADDRESS { ULONG Length; UCHAR PortNumber; UCHAR PathId; UCHAR TargetId; UCHAR Lun; }
  const out = Buffer.alloc(8);
  const returned = Buffer.alloc(4);
  const ok = fDeviceIoControl(handle, IOCTL_SCSI_GET_ADDRESS, null, 0, out, out.length, returned, null);
  if (!ok) return null;
  return { pathId: out.readUInt8(5), targetId: out.readUInt8(6), lun: out.readUInt8(7) };
}

/**
 * SPTI 单块读取：IOCTL_SCSI_PASS_THROUGH + READ CD(0xBE)。
 *
 * CDB（MMC-4 规范 + Linux 内核 sr_read_cd 双重确认）：
 *   byte0 = 0xBE
 *   byte1 = ExpectedSectorType << 2，CD-DA = 0x04
 *   byte2-5 = LBA（大端）
 *   byte6-8 = TransferLength（大端，3 字节）
 *   byte9  = 主通道选择 0xF8 = Sync+Header+UserData+EDC/ECC（完整 2352 字节
 *            扇区）。取值经 Linux 内核 sr_read_cd 确认：2352→0xF8、
 *            2048→0x10、2336→0x58、2340→0x78；cdrdao/cdparanoia 亦用 0xF8。
 *            与 IOCTL_CDROM_RAW_READ 的输出格式一致，上层字节序逻辑不用动）
 *   byte10 = 子通道选择 0x00（不需要）
 *
 * 缓冲区布局（x64，56 字节结构含 4 字节尾部填充；对齐官方
 * SCSI_PASS_THROUGH_WITH_BUFFERS 思路）：
 *   [结构 56B][Sense 32B @56][Data @88]
 * 非 DIRECT 版本由系统完成缓冲对齐与拷贝，无需调用方操心对齐。
 */
function scsiReadCd(handle, addr, lba, count) {
  ensure();
  const dataBytes = count * 2352;
  const buf = Buffer.alloc(SPT_DATA_OFF + dataBytes);
  buf.writeUInt16LE(SPT_STRUCT_SIZE, 0);        // Length = sizeof(SCSI_PASS_THROUGH)
  buf.writeUInt8(addr.pathId, 3);
  buf.writeUInt8(addr.targetId, 4);
  buf.writeUInt8(addr.lun, 5);
  buf.writeUInt8(12, 6);                        // CdbLength = 12（READ CD）
  buf.writeUInt8(SPT_SENSE_LEN, 7);             // SenseInfoLength
  buf.writeUInt32LE(SCSI_IOCTL_DATA_IN, 8);     // DataIn（UCHAR/ULONG 两种 SDK 定义都安全）
  buf.writeUInt32LE(dataBytes, 12);             // DataTransferLength
  buf.writeUInt32LE(30, 16);                    // TimeOutValue（秒）
  buf.writeBigUInt64LE(BigInt(SPT_DATA_OFF), 24); // DataBufferOffset（ULONG_PTR）
  buf.writeUInt32LE(SPT_SENSE_OFF, 32);         // SenseInfoOffset
  const l = lba >>> 0;
  const cdb = buf.subarray(36);
  cdb[0] = 0xBE;
  cdb[1] = 0x04;                                        // Expected Sector Type = CD-DA
  cdb[2] = (l >>> 24) & 0xFF; cdb[3] = (l >>> 16) & 0xFF;
  cdb[4] = (l >>> 8) & 0xFF;  cdb[5] = l & 0xFF;
  cdb[6] = (count >>> 16) & 0xFF; cdb[7] = (count >>> 8) & 0xFF; cdb[8] = count & 0xFF;
  cdb[9] = 0xF8;                                        // 主通道：完整 2352 字节扇区
  cdb[10] = 0x00;                                       // 子通道：无
  cdb[11] = 0x00;
  const returned = Buffer.alloc(4);
  const ok = fDeviceIoControl(handle, IOCTL_SCSI_PASS_THROUGH, buf, buf.length, buf, buf.length, returned, null);
  const scsiStatus = buf.readUInt8(2);
  if (!ok || scsiStatus !== SCSISTAT_GOOD) {
    const code = fGetLastError();
    const err = winError('SPTI 读取光盘音频数据', code);
    err.scsiStatus = scsiStatus;
    if (scsiStatus === SCSISTAT_CHECK_CONDITION) {
      // fixed format sense：key@2, asc@12, ascq@13
      const s = buf.subarray(SPT_SENSE_OFF, SPT_SENSE_OFF + SPT_SENSE_LEN);
      err.senseKey = s[2]; err.asc = s[12]; err.ascq = s[13];
    }
    throw err;
  }
  return buf.subarray(SPT_DATA_OFF);
}

/** SPTI 按 ≤27 扇区逐块读满 count，任一环失败即抛（诊断挂在 err.diag） */
function scsiReadCdSplit(handle, state, lba, count) {
  if (!state.addr) state.addr = getScsiAddress(handle);
  if (!state.addr) {
    const err = new Error('SPTI 不可用：取不到 SCSI 地址（IOCTL_SCSI_GET_ADDRESS 失败）');
    err.code = 'ENOSCSIADDR';
    throw err;
  }
  const out = Buffer.alloc(count * 2352);
  let done = 0;
  while (done < count) {
    const n = Math.min(SPTI_MAX_SECTORS, count - done);
    const chunk = scsiReadCd(handle, state.addr, lba + done, n);
    chunk.copy(out, done * 2352);
    done += n;
  }
  return out;
}

/** 构造两条路都断时的合并诊断错误 */
function rawReadBrokenError(ioctlErr, sptiErr, cachedMessage) {
  let message;
  if (cachedMessage) {
    message = cachedMessage; // broken 态：与首次失败逐字一致，方便用户对照日志
  } else {
    const parts = [];
    if (ioctlErr) parts.push('IOCTL_CDROM_RAW_READ 错误码 0x' + (ioctlErr.winCode >>> 0).toString(16));
    if (sptiErr) {
      let d = 'SPTI READ CD 错误码 0x' + (sptiErr.winCode >>> 0).toString(16);
      if (sptiErr.scsiStatus === SCSISTAT_CHECK_CONDITION) {
        const hex = (v) => (v >>> 0).toString(16).padStart(2, '0');
        d += '，sense ' + hex(sptiErr.senseKey) + '/' + hex(sptiErr.asc) + '/' + hex(sptiErr.ascq);
      }
      parts.push(d);
    }
    message = '读取光盘音频数据失败（' + parts.join('；') + '）';
  }
  const err = new Error(message);
  err.code = 'ERAWREAD';
  err.diag = {
    ioctlWinCode: ioctlErr ? ioctlErr.winCode : null,
    sptiWinCode: sptiErr ? sptiErr.winCode : null,
    sptiNoAddr: !!(sptiErr && sptiErr.code === 'ENOSCSIADDR'),
    scsiStatus: sptiErr ? sptiErr.scsiStatus : null,
    senseKey: sptiErr ? sptiErr.senseKey : null,
    asc: sptiErr ? sptiErr.asc : null,
    ascq: sptiErr ? sptiErr.ascq : null
  };
  return err;
}

/**
 * RAW 读取：从 LBA（逻辑块地址，track1 起始 = 0，即绝对帧号 - 150）开始读取
 * count 个扇区（每个 2352 字节）。返回原始 CD-DA 字节（16bit 大端采样）。
 * 注意：Windows 驱动将 DiskOffset(字节) >> 11 得到 LBA 后直接下发给 READ_CD，
 * 而 MMC 规范中 CD 的 LBA = 绝对帧号 - 150，因此调用方须传入 lba = startFrame - 150。
 *
 * 读取策略（按句柄缓存，命中后零额外开销）：
 *   1) IOCTL_CDROM_RAW_READ —— 首选，>27 扇区自动拆分后拼接
 *   2) 抛错，或"成功但全零" → SPTI READ CD（按 ≤27 扇区拆分）—— 绕过类驱动缺陷
 *   3) 都失败 → mode='broken'，后续调用直接抛带完整诊断的错误
 *
 * ★ "成功但全零"是类驱动缺陷的另一种表现（与抛错并列，见文件头注释）：
 *   部分光驱对 RAW_READ 返回成功但数据全零，早期实现只看抛不抛错，于是
 *   能力测试判死刑直接走 MCI，而同一台光驱的 READ CD(0xBE) 明明是好的。
 *   现在 IOCTL 拿到全零时会用 SPTI 验证一次：SPTI 有数据 → 永久切 SPTI；
 *   SPTI 也全零 → 多半是真正的数字静音段（CD-DA 静音就是全零），退回
 *   ioctl 路径把数据交给上层看门狗判定，不误切。
 */
function rawRead(handle, lba, count) {
  ensure();
  const state = getReadState(handle);
  if (state.mode === 'broken') throw rawReadBrokenError(null, null, state.message);
  if (state.mode === 'ioctl') {
    let ioctlErr = null;
    let out = null;
    try {
      out = rawReadIoctl(handle, lba, count);
    } catch (e) {
      ioctlErr = e;
    }
    if (!ioctlErr && (out.length === 0 || !bufferAllZero(out))) return out;
    // IOCTL 抛错或全零 → SPTI 验证/接管
    try {
      const sptiOut = scsiReadCdSplit(handle, state, lba, count);
      if (sptiOut.length > 0 && !bufferAllZero(sptiOut)) {
        // SPTI 有真数据：IOCTL 这条路（抛错型或全零型）坏实了，永久切换
        state.mode = 'spti';
        return sptiOut;
      }
      // SPTI 也全零：真正的数字静音段。IOCTL 没抛错就留在 ioctl（便宜路径），
      // 抛了错则 SPTI 至少能返回，留在 spti。
      state.mode = ioctlErr ? 'spti' : 'ioctl';
      if (ioctlErr) return sptiOut;
      return out;
    } catch (sptiErr) {
      if (ioctlErr) {
        // 两条路都断：broken，后续直接抛缓存原因
        state.mode = 'broken';
        state.message = rawReadBrokenError(ioctlErr, sptiErr).message;
        throw rawReadBrokenError(ioctlErr, sptiErr);
      }
      // IOCTL 能返回（哪怕是全零）而 SPTI 异常：IOCTL 照常可用，不判死刑
      state.mode = 'ioctl';
      return out;
    }
  }
  try {
    return scsiReadCdSplit(handle, state, lba, count);
  } catch (sptiErr) {
    state.mode = 'broken';
    state.message = rawReadBrokenError(null, sptiErr).message;
    throw rawReadBrokenError(null, sptiErr);
  }
}

/** 整缓冲是否全零（CD-DA 数字静音即全零；驱动缺陷的"假成功"同样表现为全零） */
function bufferAllZero(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

/** 诊断用：当前句柄实际生效的 RAW 读取方法（null = 尚未读过） */
function rawReadMethod(handle) {
  const st = readStates.get(handle);
  return st ? st.mode : null;
}

/**
 * 介质存在性探测（供读取线程在播放期间调用，避免阻塞主进程）。
 *
 * 优先使用 CHECK_VERIFY2：它在无介质时直接返回错误，且不会触发系统的
 * "请插入磁盘"提示；部分老驱动不认识它（ERROR_INVALID_FUNCTION=1 /
 * ERROR_NOT_SUPPORTED=50），此时退回 CHECK_VERIFY。
 *
 * @param {*} handle
 * @returns {{supported:boolean, present:boolean, code?:number}}
 *   supported=false 表示该设备两种指令都不支持，调用方应另想办法（如读 TOC）。
 */
function checkMedia(handle) {
  ensure();
  if (!handle) return { supported: false, present: true };
  const returned = Buffer.alloc(4);
  let ok = fDeviceIoControl(handle, IOCTL_STORAGE_CHECK_VERIFY2, null, 0, null, 0, returned, null);
  if (ok) return { supported: true, present: true };
  const code2 = fGetLastError() >>> 0;
  if (code2 === 1 || code2 === 50 || code2 === 0xA1 /*ERROR_INVALID_PARAMETER*/) {
    // 不支持 VERIFY2 → 退回 VERIFY
    ok = fDeviceIoControl(handle, IOCTL_STORAGE_CHECK_VERIFY, null, 0, null, 0, returned, null);
    if (ok) return { supported: true, present: true };
    const code1 = fGetLastError() >>> 0;
    if (code1 === 1 || code1 === 50 || code1 === 0xA1) return { supported: false, present: true };
    return { supported: true, present: false, code: code1 };
  }
  return { supported: true, present: false, code: code2 };
}

function trayControl(handle, code) {
  ensure();
  const returned = Buffer.alloc(4);
  const ok = fDeviceIoControl(handle, code, null, 0, null, 0, returned, null);
  if (!ok) {
    const errCode = fGetLastError();
    throw winError('控制光驱托盘', errCode);
  }
}

/** MCI 命令（回退播放路径） */
function mciSend(cmd) {
  ensure();
  const ret = Buffer.alloc(1024);
  const code = fMciSendStringW(wide(cmd), ret, 512, null);
  let text = ret.toString('utf16le');
  const nul = text.indexOf('\0');
  if (nul >= 0) text = text.slice(0, nul);
  return { code: code >>> 0, text };
}

function mciError(code) {
  ensure();
  const buf = Buffer.alloc(1024);
  fMciGetErrorStringW(code, buf, 512);
  let text = buf.toString('utf16le');
  const nul = text.indexOf('\0');
  if (nul >= 0) text = text.slice(0, nul);
  return text || `MCI 错误 ${code}`;
}

/** "mm:ss:ff" → 帧号（CD 帧率 75/s） */
function msfToFrame(str) {
  const m = /^(\d+):(\d+):(\d+)$/.exec(String(str).trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 4500 + parseInt(m[2], 10) * 75 + parseInt(m[3], 10);
}

/**
 * 通过 MCI cdaudio 读取 TOC（虚拟光驱 / 不支持底层 IOCTL 的光驱的兜底路径）。
 * 返回与 readToc 相同的 { first, last, leadout, tracks:[{number,startFrame,endFrame,durationSec,audio}] }。
 * 失败抛错（带 mciCode）。
 */
function readTocViaMci(letter) {
  ensure();
  const alias = 'sg_' + letter;
  const open = mciSend(`open ${letter}: type cdaudio alias ${alias} wait`);
  if (open.code !== 0) {
    const err = new Error('MCI 打开失败（' + mciError(open.code) + '）');
    err.mciCode = open.code;
    throw err;
  }
  try {
    const setTf = mciSend(`set ${alias} time format msf wait`);
    if (setTf.code !== 0) throw new Error('MCI 设置时间格式失败（' + mciError(setTf.code) + '）');
    const numRes = mciSend(`status ${alias} number of tracks wait`);
    if (numRes.code !== 0) throw new Error('MCI 读取轨道数失败（' + mciError(numRes.code) + '）');
    const n = parseInt(numRes.text, 10);
    if (!n || n < 1) throw new Error('MCI 报告 0 个轨道');

    const tracks = [];
    for (let i = 1; i <= n; i++) {
      const pos = mciSend(`status ${alias} position track ${i} wait`);
      const len = mciSend(`status ${alias} length track ${i} wait`);
      if (pos.code !== 0 || len.code !== 0) {
        throw new Error('MCI 读取轨道 ' + i + ' 失败（' + mciError(pos.code || len.code) + '）');
      }
      const startMsf = msfToFrame(pos.text);
      const lenFrames = msfToFrame(len.text);
      if (startMsf === null || lenFrames === null) throw new Error('MCI 轨道 ' + i + ' 时间格式异常: ' + pos.text + '/' + len.text);
      tracks.push({ number: i, startMsf, lenFrames });
    }

    // 统一偏移：MCI 的 msf 有的实现从 00:00:00（首轨）开始，有的从 00:02:00（绝对）开始。
    // CD 规范首轨绝对位置 = 150 帧（00:02:00）。据此把两种约定都折算成绝对 LBA。
    const start1 = tracks[0].startMsf;
    const delta = start1 < 150 ? 150 - start1 : 0;
    for (const t of tracks) {
      t.startFrame = t.startMsf + delta - 150;
      t.endFrame = t.startFrame + t.lenFrames;
      t.durationSec = t.lenFrames / 75;
      t.audio = true;
      delete t.startMsf;
      delete t.lenFrames;
    }
    tracks.sort((a, b) => a.startFrame - b.startFrame);
    const last = tracks[tracks.length - 1];
    return { first: tracks[0].number, last: last.number, leadout: last.endFrame, mciOrigin: start1, tracks };
  } finally {
    try { mciSend(`close ${alias}`); } catch (e) { /* 忽略 */ }
  }
}

module.exports = {
  ensure,
  openCdDevice,
  closeDevice,
  listCdDrives,
  listAllDrives,
  readToc,
  readTocViaMci,
  checkMedia,
  rawRead,
  rawReadIoctl,
  rawReadIoctlSingle,
  rawReadMethod,
  getScsiAddress,
  scsiReadCd,
  trayControl,
  mciSend,
  mciError,
  msfToFrame,
  /* ---- IOCTL / 协议常量（回归测试会逐项校验，改动需同步 tests/native.test.js） ---- */
  IOCTL_CDROM_READ_TOC,
  IOCTL_CDROM_READ_TOC_EX,
  IOCTL_CDROM_RAW_READ,
  IOCTL_CDROM_EJECT_MEDIA,
  IOCTL_CDROM_LOAD_MEDIA,
  IOCTL_CDROM_CLOSE_DOOR,
  IOCTL_STORAGE_CHECK_VERIFY,
  IOCTL_STORAGE_CHECK_VERIFY2,
  IOCTL_STORAGE_LOAD_MEDIA,
  IOCTL_SCSI_PASS_THROUGH,
  IOCTL_SCSI_GET_ADDRESS,
  SCSI_IOCTL_DATA_IN,
  SPT_STRUCT_SIZE,
  SPTI_MAX_SECTORS,
  IOCTL_MAX_SECTORS,
  RAW_MAX_SECTORS,
  TRACK_MODE_CDDA,
  CONTROL_DATA_TRACK
};
