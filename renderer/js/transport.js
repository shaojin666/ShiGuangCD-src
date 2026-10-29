'use strict';
/* ============================================================
   transport.js —— 播放控件唯一真相（Single Source of Truth）
   ------------------------------------------------------------
   目标：无论用户在软件内怎么操作（切页 / 切歌 / 拖动进度条 / 暂停 / 定位），
   进度条与时间显示都只从这一个地方取值，杜绝"各处各算一套"的错乱。

   模型：
     status      stopped | playing | paused      —— 传输状态
     track       当前曲目号
     durationSec 当前曲目时长
     anchorSec + anchorAt + running              —— 位置锚点（墙钟推算）
     seeking / previewSec                        —— 用户正在拖动进度条
     holdUntil                                   —— 定位后的保护期，抑制回跳

   数据源优先级：
     1) 主进程 cd:state（权威快照，状态/曲目变化时无条件采纳）
     2) 引擎自身位置（RAW 的 AudioContext 调度位置 / Demo 的 AudioContext 时间）
     3) 主进程 cd:position（MCI 轮询，仅作死区校正）
     4) 本地墙钟（兜底，保证任何情况下都连续单调）
   ============================================================ */

const Transport = (() => {
  /** 运行中的软校正死区（秒） */
  const CORRECTION_DEADBAND = 0.5;
  /** 定位后忽略外部软校正的保护时长（ms） */
  const HOLD_MS = 1000;

  const state = {
    track: 1,
    trackCount: 1,
    status: 'stopped',
    durationSec: 0,
    engine: null,
    anchorSec: 0,
    anchorAt: 0,
    running: false,
    seeking: false,
    previewSec: null,
    holdUntil: 0
  };

  const listeners = [];

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function clampSec(sec) {
    let s = Math.max(0, Number(sec) || 0);
    if (state.durationSec > 0) s = Math.min(s, state.durationSec);
    return s;
  }

  /** 把锚点设到指定秒数（running 跟随当前 status） */
  function reset(sec) {
    state.anchorSec = clampSec(sec);
    state.anchorAt = now();
    state.running = state.status === 'playing';
    state.previewSec = null;
  }

  /**
   * 强制把位置设为指定秒数（不改变 status）。
   * 暂停时用它把锚点钉在"真实听感位置"上：界面显示的数字必须与耳朵听到的
   * 是同一个数，否则续播后进度条就会一路追赶音频。
   */
  function setPosition(sec) {
    if (sec == null || !isFinite(sec)) return;
    state.anchorSec = clampSec(sec);
    state.anchorAt = now();
    state.running = state.status === 'playing';
    state.previewSec = null;
    notify();
  }

  /** 墙钟推算出的当前位置 */
  function clockSec() {
    let s = state.anchorSec;
    if (state.running) s += (now() - state.anchorAt) / 1000;
    return clampSec(s);
  }

  /** 界面应当展示的位置（拖动时展示预览值） */
  function positionSec() {
    if (state.seeking && state.previewSec != null) return clampSec(state.previewSec);
    return clockSec();
  }

  function notify() {
    const snap = snapshot();
    for (const cb of listeners) {
      try { cb(snap); } catch (e) { /* 单个订阅者出错不影响其它 */ }
    }
  }

  function snapshot() {
    return {
      track: state.track,
      trackCount: state.trackCount,
      status: state.status,
      durationSec: state.durationSec,
      positionSec: positionSec(),
      seeking: state.seeking,
      engine: state.engine
    };
  }

  /* ---------- 写入口 ---------- */

  function setDuration(sec) {
    const v = Math.max(0, Number(sec) || 0);
    if (Math.abs(v - state.durationSec) < 0.01) return;
    state.durationSec = v;
    // 时长变化后重新夹紧锚点，避免进度条超出新时长
    state.anchorSec = clampSec(state.anchorSec);
    notify();
  }

  function setTrackCount(n) {
    const v = Math.max(1, Number(n) || 1);
    if (v === state.trackCount) return;
    state.trackCount = v;
    notify();
  }

  function setEngine(e) {
    state.engine = e || null;
  }

  function setStatus(next) {
    const s = next === 'playing' || next === 'paused' ? next : 'stopped';
    if (s === state.status) return;
    // 先按旧状态结算当前位置，再切换，保证位置连续
    const cur = clockSec();
    state.status = s;
    reset(s === 'stopped' ? 0 : cur);
    notify();
  }

  /** 本地乐观切轨：立刻把界面切到新曲目 0:00 并进入播放态 */
  function optimisticTrack(n) {
    state.track = Number(n) || 1;
    state.status = 'playing';
    reset(0);
    state.holdUntil = now() + 1200;
    notify();
  }

  /**
   * 采纳主进程的权威快照
   * @param {{state:string,track:number,positionSec:number,durationSec:number,engine:string,mode:string}} ev
   */
  function applyMainState(ev) {
    if (!ev) return;
    // 主进程在元数据缺失时会回 0，不能拿 0 覆盖已经知道的时长
    if (typeof ev.durationSec === 'number' && ev.durationSec > 0) setDuration(ev.durationSec);
    if (typeof ev.trackCount === 'number' && ev.trackCount > 0) setTrackCount(ev.trackCount);
    if (typeof ev.engine === 'string') state.engine = ev.engine;

    const track = Number(ev.track) || state.track;
    const status = (ev.state === 'playing' || ev.state === 'paused') ? ev.state : 'stopped';
    const pos = (typeof ev.positionSec === 'number' && isFinite(ev.positionSec)) ? Math.max(0, ev.positionSec) : null;

    const trackChanged = track !== state.track;
    const statusChanged = status !== state.status;

    state.track = track;
    state.status = status;

    if (trackChanged || statusChanged) {
      // 状态/曲目变化：无条件采纳权威位置（缺失时按语义归零或保持）
      reset(pos != null ? pos : (status === 'stopped' ? 0 : clockSec()));
      state.holdUntil = 0;
    } else if (pos != null) {
      // 稳态：仅当偏差超过死区才校正，避免 MCI 轮询把进度条往回拉
      if (status !== 'playing' || Math.abs(pos - clockSec()) > CORRECTION_DEADBAND) reset(pos);
    }
    notify();
  }

  /**
   * 用"引擎自身位置"这类软数据源校正（RAW 的 AudioContext / Demo 的 AudioContext / MCI 轮询）
   * @param {number} sec
   * @param {number} [deadband]
   * @returns {boolean} 是否真的校正了
   */
  function correctFrom(sec, deadband) {
    if (state.status !== 'playing') return false;
    if (state.seeking) return false;
    if (now() < state.holdUntil) return false;
    if (sec == null || !isFinite(sec)) return false;
    const d = (typeof deadband === 'number') ? deadband : CORRECTION_DEADBAND;
    const target = clampSec(sec);
    if (Math.abs(target - clockSec()) <= d) return false;
    state.anchorSec = target;
    state.anchorAt = now();
    return true;
  }

  /**
   * 渐进式软校正：把差异按一小步一小步消化，而不是一次性跳过去。
   * 用于消除残余的小偏差（起播延迟、IPC 抖动），避免进度条"跳一下"或
   * "用更快的速度追上音频"这类肉眼可见的异常。
   * @param {number} sec 目标位置
   * @param {number} [deadband] 小于该差值不处理
   */
  function easeTo(sec, deadband) {
    if (state.status !== 'playing') return false;
    if (state.seeking) return false;
    if (now() < state.holdUntil) return false;
    if (sec == null || !isFinite(sec)) return false;
    const d = (typeof deadband === 'number') ? deadband : CORRECTION_DEADBAND;
    const target = clampSec(sec);
    const diff = target - clockSec();
    if (Math.abs(diff) <= d) return false;
    // 每步最多消化 40%，且限制单步幅度，保证视觉上匀速
    const step = Math.sign(diff) * Math.min(Math.abs(diff) * 0.4, 0.25);
    state.anchorSec = clampSec(clockSec() + step);
    state.anchorAt = now();
    return true;
  }

  /* ---------- 进度条交互 ---------- */

  function beginSeek(sec) {
    state.seeking = true;
    if (sec != null) state.previewSec = clampSec(sec);
    notify();
  }

  function previewSeek(sec) {
    state.seeking = true;
    state.previewSec = clampSec(sec);
    notify();
  }

  /** 提交定位：立即把锚点挪到目标，并开启保护期 */
  function commitSeek(sec) {
    const target = clampSec(sec);
    state.seeking = false;
    state.previewSec = null;
    // 定位后若处于停止态，语义上等同于从该位置起播（与 MCI 行为一致）
    if (state.status === 'stopped') state.status = 'playing';
    reset(target);
    state.holdUntil = now() + HOLD_MS;
    notify();
    return target;
  }

  function cancelSeek() {
    if (!state.seeking) return;
    state.seeking = false;
    state.previewSec = null;
    notify();
  }

  /** 换碟 / 出舱：整体归零 */
  function resetAll(track) {
    state.track = Number(track) || 1;
    state.status = 'stopped';
    state.durationSec = 0;
    state.seeking = false;
    state.previewSec = null;
    state.holdUntil = 0;
    reset(0);
    notify();
  }

  function subscribe(cb) {
    if (typeof cb === 'function') listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  return {
    // 读
    snapshot, positionSec, now,
    get track() { return state.track; },
    get status() { return state.status; },
    get durationSec() { return state.durationSec; },
    get trackCount() { return state.trackCount; },
    get seeking() { return state.seeking; },
    get engine() { return state.engine; },
    // 写
    setDuration, setTrackCount, setEngine, setStatus, optimisticTrack,
    applyMainState, correctFrom, easeTo, setPosition,
    beginSeek, previewSeek, commitSeek, cancelSeek, resetAll,
    subscribe
  };
})();
