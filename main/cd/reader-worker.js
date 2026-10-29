'use strict';
/*
 * reader-worker.js —— 在独立 worker 线程中执行 RAW 扇区读取，
 * 避免同步的原生调用阻塞主进程事件循环。
 *
 * 消息协议（来自主进程）：
 *   { type: 'open',  drive: 'D' }                  → { type: 'opened', reqId, ok, error? }
 *   { type: 'read',  reqId, lba, count }           → { type: 'data', reqId, ok, error?, samples: Buffer(Int16LE) }
 *   { type: 'check', reqId }                       → { type: 'check-result', reqId, supported, present, code? }
 *   { type: 'toc', reqId }                         → { type: 'toc-result', reqId, ok, error?, toc? }
 *   { type: 'tray', action: 'eject'|'load'|'close'} → { type: 'tray-result', reqId, ok, error? }
 *   { type: 'close', reqId }                       → { type: 'closed', reqId }
 *
 * ★ 每条回复都必须回带 reqId：主进程的 _request() 靠它把回复认领给等待中的
 *   Promise。历史上 'open' 的回复漏带 reqId，被 _onMessage 当无效消息丢弃 ——
 *   RawPlayer.start() 的 Promise 永远不落地，起播路径整体挂起，
 *   表现为"日志说 RAW 可用，点播放却什么都没发生、没有声音也没有报错"。
 *   既有 raw-player.test.js 的假 Worker 反而回带了 reqId，把这条 bug 遮住了；
 *   现在由 raw-pipeline.test.js 用真实 worker 源码做全链路回归。
 */

const { parentPort } = require('worker_threads');
const native = require('../native');
const { detectPcmForm } = require('./audio-stats');

const CHUNK_SECTORS = 75; // 0.5 秒音频（75 帧）
const MAX_RETRY = 3;

let handle = null;

function swapEndian(buf) {
  // CD-DA 采样为大端 16bit，转为小端
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
}

/**
 * 把光驱返回的原始扇区数据解码成 Int16LE 采样，并按数据形态自动判别
 * （audio-stats.detectPcmForm，v10.2）：
 *   be16    —— 标准大端 CD-DA：swapEndian 转小端（绝大多数光驱）；
 *   le16    —— 小端 16bit PCM（实测 USB 桥接光驱固件行为，用户 F 盘）：
 *              数据本来就是小端，**直通**即可。旧管线对大端假设一刀切
 *              swapEndian，把这种光驱的真音频字节对调 → 全程白噪音；
 *   silence —— 全零/近静音：两种字节序等价，直通；
 *   garbage —— 两种字节序都不像音频波形（驱动伪造数据）：原样回传，
 *              由播放看门狗连续计数止损（切换 MCI），不在解码层消化。
 *
 * 判别是逐块的、无记忆的：安静段两种字节序都可能"像音频"，但 argmin
 * 稳定（实测该光驱安静段 LE 0.26 vs BE 0.41、响段 0.28 vs 1.15，不翻转）；
 * 跨块记忆反而可能在少数模糊块上把错的字节序粘住。
 */
function decodeRaw(buf) {
  const form = detectPcmForm(buf);
  if (form === 'be16') {
    return { samples: swapEndian(buf), decode: 'be16' };
  }
  // le16 / silence / garbage：小端口径下即为最终形态（或交由上层处置），直通
  return { samples: buf, decode: form };
}

function readSectorsWithRetry(lba, count) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const raw = native.rawRead(handle, lba, count);
      const { samples, decode } = decodeRaw(raw);
      return { ok: true, samples, decode };
    } catch (e) {
      lastErr = e;
      // 轻微退避后重试（读取划伤区域常见瞬时错误）
      const wait = 30 * (attempt + 1);
      const end = Date.now() + wait;
      while (Date.now() < end) { /* 忙等，保持线程内同步语义 */ }
    }
  }
  return { ok: false, error: (lastErr && lastErr.message || '未知错误') + (lastErr && lastErr.diag ? ' [' + JSON.stringify(lastErr.diag) + ']' : '') };
}

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'open': {
        try {
          if (handle) native.closeDevice(handle);
          handle = native.openCdDevice(msg.drive);
          parentPort.postMessage({ type: 'opened', reqId: msg.reqId, ok: true });
        } catch (e) {
          parentPort.postMessage({ type: 'opened', reqId: msg.reqId, ok: false, error: e.message });
        }
        break;
      }
      case 'check': {
        // 介质存在性探测：主进程在播放期间周期性调用，用于在"读取不报错但盘其实
        // 已经被拿走"的情况下及时止损（部分光驱无介质时 RAW 读取仍返回成功）。
        if (!handle) {
          // 设备根本没打开：无法判定，不能当成"盘没了"
          parentPort.postMessage({ type: 'check-result', reqId: msg.reqId, supported: false, present: true });
          break;
        }
        try {
          const r = native.checkMedia(handle);
          parentPort.postMessage({ type: 'check-result', reqId: msg.reqId, supported: !!r.supported, present: !!r.present, code: r.code });
        } catch (e) {
          parentPort.postMessage({ type: 'check-result', reqId: msg.reqId, supported: false, present: false, error: e.message });
        }
        break;
      }
      case 'toc': {
        if (!handle) {
          parentPort.postMessage({ type: 'toc-result', reqId: msg.reqId, ok: false, error: '设备未打开' });
          break;
        }
        try {
          const toc = native.readToc(handle);
          parentPort.postMessage({ type: 'toc-result', reqId: msg.reqId, ok: true, toc });
        } catch (e) {
          parentPort.postMessage({ type: 'toc-result', reqId: msg.reqId, ok: false, error: e.message });
        }
        break;
      }
      case 'read': {
        if (!handle) {
          parentPort.postMessage({ type: 'data', reqId: msg.reqId, ok: false, error: '设备未打开' });
          break;
        }
        const { ok, samples, decode, error } = readSectorsWithRetry(msg.lba, msg.count);
        if (ok) {
          parentPort.postMessage({ type: 'data', reqId: msg.reqId, ok: true, samples,
            method: native.rawReadMethod ? native.rawReadMethod(handle) : 'ioctl',
            decode: decode || 'be16' }, [samples.buffer]);
        } else {
          parentPort.postMessage({ type: 'data', reqId: msg.reqId, ok: false, error });
        }
        break;
      }
      case 'tray': {
        if (!handle) {
          parentPort.postMessage({ type: 'tray-result', reqId: msg.reqId, ok: false, error: '设备未打开' });
          break;
        }
        try {
          const code = msg.action === 'eject' ? native.IOCTL_CDROM_EJECT_MEDIA
            : msg.action === 'load' ? native.IOCTL_CDROM_LOAD_MEDIA
              : native.IOCTL_CDROM_CLOSE_DOOR;
          native.trayControl(handle, code);
          parentPort.postMessage({ type: 'tray-result', reqId: msg.reqId, ok: true });
        } catch (e) {
          parentPort.postMessage({ type: 'tray-result', reqId: msg.reqId, ok: false, error: e.message });
        }
        break;
      }
      case 'close': {
        if (handle) {
          try { native.closeDevice(handle); } catch (e) { /* 忽略 */ }
          handle = null;
        }
        parentPort.postMessage({ type: 'closed', reqId: msg.reqId });
        break;
      }
      default:
        parentPort.postMessage({ type: 'error', reqId: msg.reqId, error: '未知消息类型: ' + msg.type });
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', reqId: msg && msg.reqId, error: e.message });
  }
});
