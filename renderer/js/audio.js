'use strict';
/* ============================================================
   audio.js —— 播放内核
   1) AudioEngine：将主进程推送的 CD-DA PCM（Int16LE）调度到 Web Audio
   2) DemoAudio：无光驱时合成柔和旋律，走同一套界面回调
   ============================================================ */

/* ---------- 原始 PCM 播放引擎 ---------- */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.queue = [];        // {src, absFrame, startTime, duration}
    this.nextTime = 0;
    this.nextAbsFrame = 0;
    this.trackNumber = 0;
    this.trackStartFrame = 0;
    this.trackEndFrame = 0;
    this.state = 'stopped'; // stopped | playing | paused
    this.volume = 0.7;
    this.onEnd = null;      // (trackNumber) => void
    this.lastPosFrame = 0;
    /** 播放代次：每次 setTrack / flush 自增，用于丢弃旧轨道的在途数据 */
    this.generation = 0;
    /**
     * 暂停瞬间钉住的听感帧。
     * ★ 暂停后队列被清空，positionFrame() 只能回退到记忆值；这个字段就是那次记忆，
     *   也是上报给主进程的"真实听到的那一秒"的唯一来源。
     */
    this._pausedFrame = null;
    /** 增益是否被硬静音（暂停态）。恢复时据此还原音量。 */
    this._silenced = false;
  }

  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.connect(this.ctx.destination);
    this.gain = this.ctx.createGain();
    this.gain.connect(master);
    this.gain.gain.value = this.volume * this.volume;
  }

  /** 目标增益（响度用平方曲线，音量条手感更线性） */
  _targetGain() {
    return this.volume * this.volume;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain && !this._silenced) this.gain.gain.value = this._targetGain();
  }

  /**
   * 立即静音（不等待 AudioContext.suspend 生效）。
   *
   * ★ 为什么必须这样：suspend() 是异步的，且已经 start() 的 BufferSource
   *   挂在已调度的时间轴上——suspend 真正生效前，预读缓冲里的音频照样在播。
   *   RAW 路径最多预读 5 秒，用户点暂停后就表现为"还要等一两秒才安静"。
   *   把主增益在同一帧内拉下来（12ms 短斜坡防爆音），听感上就是"立刻停"，
   *   且与后面 suspend/flush 的时序完全无关。
   */
  _muteNow() {
    if (!this.gain) return;
    const g = this.gain.gain;
    const now = this.ctx ? this.ctx.currentTime : 0;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.012);
    } catch (e) {
      // 某些实现不支持 cancel/ramp 组合：直接归零兜底
      try { g.value = 0; } catch (e2) { /* 忽略 */ }
    }
    this._silenced = true;
  }

  /** 恢复增益到当前音量（暂停后继续播放时调用） */
  _unmute() {
    if (!this.gain) return;
    const g = this.gain.gain;
    const now = this.ctx ? this.ctx.currentTime : 0;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
      g.linearRampToValueAtTime(this._targetGain(), now + 0.02);
    } catch (e) {
      try { g.value = this._targetGain(); } catch (e2) { /* 忽略 */ }
    }
    this._silenced = false;
  }

  setTrack(trackNumber, startFrame, endFrame) {
    this.flush();
    this.trackNumber = trackNumber;
    this.trackStartFrame = startFrame;
    this.trackEndFrame = endFrame;
    this.nextAbsFrame = startFrame;
    this.lastPosFrame = startFrame;
  }

  /** 轨内秒数（基于已调度音频，最精确的位置来源） */
  positionSec() {
    if (this.trackStartFrame == null) return null;
    return Math.max(0, (this.positionFrame() - this.trackStartFrame) / 75);
  }

  /** 真实听感位置（秒）：RAW 路径下落后"已读游标"一个预读缓冲，必须用已调度音频换算 */
  audibleSec() {
    return this.positionSec();
  }

  /** 把 IPC 传来的 PCM 数据规范化成 Int16Array 视图（兼容 Buffer / Uint8Array） */
  static _asInt16(samples) {
    if (samples instanceof Int16Array) return samples;
    const u8 = (samples instanceof Uint8Array) ? samples : new Uint8Array(samples);
    return new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
  }

  /**
   * 推送一块 PCM（Int16LE 立体声，与主进程绝对帧对齐）
   *
   * ★ 暂停态一律丢弃：主进程暂停后 IPC 管道里可能还残留若干已发出的块，
   *   若不丢弃，这些块到达后仍会被调度播放 —— 表现为"点了暂停还要响一会儿"。
   *   恢复时主进程会从暂停点重新送数据，丢掉这些残留块既不会断流也不会漏内容。
   */
  feed({ track, absFrame, samples }) {
    if (!samples) return;
    // 暂停/停止态一律丢弃：主进程暂停后 IPC 管道里可能还残留若干已发出的块，
    // 不丢弃就会出现"点了暂停还响一会儿"（主进程侧也有同样的前置过滤，双保险）。
    if (this.state !== 'playing') return;
    if (!this.ctx) this.ensure();
    const view = AudioEngine._asInt16(samples);
    let frames = view.length >> 1;
    if (!frames) return;

    // 轨道切换（主进程先推数据后发 state 的竞态）→ 直接采用新轨道
    if (track !== this.trackNumber && track) {
      this.flush();
      this.trackNumber = track;
      this.nextAbsFrame = absFrame;
      if (!this.trackStartFrame) this.trackStartFrame = absFrame;
      if (!this.trackEndFrame) this.trackEndFrame = absFrame + 1e9;
    }
    // 游标漂移（seek / 重排）→ 以主进程为准重排
    if (absFrame !== Math.round(this.nextAbsFrame)) {
      this.flush();
      this.nextAbsFrame = absFrame;
    }

    // ★ 裁掉越出轨末的尾巴。
    //   主进程按整秒（75 扇区）切块，而轨长通常不是整秒，最后一块会越过轨末；
    //   不裁剪就会多播零点几秒，并且位置永远到不了轨末
    //   （进度条差最后一小截、轨末判定也可能不成立）。
    //   注意换算必须用音频的真实采样率 44100，而不是 CD 的 75 帧/秒。
    if (this.trackEndFrame > this.trackStartFrame) {
      const endFrames = Math.round((this.trackEndFrame - absFrame) * 44100 / 75);
      if (endFrames <= 0) return;              // 整块都在轨末之外 → 丢弃
      if (frames > endFrames) frames = endFrames;
    }

    const ab = this.ctx.createBuffer(2, frames, 44100);
    const L = ab.getChannelData(0);
    const R = ab.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      L[i] = view[i * 2] / 32768;
      R[i] = view[i * 2 + 1] / 32768;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.gain);
    // 起播/恢复后首块不留额外延迟：0.04s 的"安全提前量"会让恢复听起来慢半拍
    const t0 = Math.max(this.nextTime, this.ctx.currentTime + (this.queue.length ? 0 : 0.012));
    // ★ 起播前先把"记忆位置"推进到这一块的起点。
    //   队列里几十块都是一次性排进未来的，光靠"队首起点"无法反映进度；
    //   而 positionFrame() 的兜底值就是这个 lastPosFrame，
    //   它必须代表"已经排到哪一块"，才能在队列为空/暂停的瞬间给出正确答案。
    if (absFrame > this.lastPosFrame) this.lastPosFrame = absFrame;
    src.start(t0);
    this.queue.push({ src, absFrame, startTime: t0, duration: ab.duration });
    this.nextTime = t0 + ab.duration;
    this.nextAbsFrame = absFrame + Math.round(frames / 44100 * 75);
    this._trim(this.ctx.currentTime);
  }

  _trim(now) {
    while (this.queue.length && this.queue[0].startTime + this.queue[0].duration < now - 0.1) {
      const q = this.queue.shift();
      // 出队即代表"这一块已经播出去了"：把记忆位置推进到它的末端。
      // 必须用 float 精度存，再统一夹到轨末，否则整轨会少最后一小块。
      const end = q.absFrame + q.duration * 75;
      if (end > this.lastPosFrame) this.lastPosFrame = end;
      try { q.src.disconnect(); } catch (e) { /* 已断开 */ }
    }
    if (this.trackEndFrame > this.trackStartFrame && this.lastPosFrame > this.trackEndFrame) {
      this.lastPosFrame = this.trackEndFrame;
    }
  }

  flush() {
    for (const q of this.queue) {
      try { q.src.stop(); } catch (e) { /* 已停止 */ }
      try { q.src.disconnect(); } catch (e) { /* 已断开 */ }
    }
    this.queue = [];
    this.nextTime = this.ctx ? this.ctx.currentTime : 0;
    this.generation++;
  }

  play(trackNumber, startFrame, endFrame) {
    this.ensure();
    if (trackNumber && (trackNumber !== this.trackNumber || startFrame !== this.trackStartFrame)) {
      this.setTrack(trackNumber, startFrame, endFrame);
    }
    // 播放态：撤销暂停时的硬静音，并保证上下文在跑
    this._unmute();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.state = 'playing';
  }

  /**
   * 暂停：立即静音 + 丢弃预读缓冲 + 冻结上下文。
   *
   * 顺序很关键——
   *   1) 先读一次听感帧（此刻队列还在，是最准的一刻）；
   *   2) state 立刻切到 paused，让"在途"的 feed() 从下一帧起就被丢弃；
   *   3) _muteNow() 当帧把增益拉到 0（不依赖 suspend 生效）；
   *   4) flush() 停掉所有已调度的 BufferSource，取消尚未出声的预读；
   *   5) 最后才 suspend()。
   *
   * 旧实现是 suspend() → flush()，把"立刻安静"寄托在异步的 suspend 上；
   * 同时 state 在 flush 之后才切换，暂停瞬间到达的音频块仍会被调度播出。
   */
  pause() {
    if (!this.ctx) return;
    const heard = this.positionFrame();
    this._pausedFrame = heard;
    this.lastPosFrame = heard;
    this.state = 'paused';       // 先置位：后续 feed() 一律丢弃
    this._muteNow();             // 当帧静音，不等 suspend
    this.flush();                // 丢掉预读缓冲（否则恢复时会重复播一段）
    // 上下文冻结：省电，并让 currentTime 停止推进，恢复时的时间轴才可预测
    try { this.ctx.suspend(); } catch (e) { /* 忽略 */ }
  }

  /** 暂停点（绝对帧）：上报给主进程的"真实听感位置" */
  pausedFrame() {
    return this._pausedFrame;
  }

  resume() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // 清掉暂停记忆：恢复后位置由新来的音频块重新建立
    this._pausedFrame = null;
    this._unmute();
    this.state = 'playing';
  }

  stop() {
    this.flush();
    this.state = 'stopped';
    this._pausedFrame = null;
    this.queue = [];
    this.nextAbsFrame = this.trackStartFrame || 0;
    this.lastPosFrame = this.trackStartFrame || 0;
  }

  /**
   * 当前位置（绝对帧）。
   * ★ 三种"没落在任何已调度块内"的情形必须分别处理，旧实现一律回退到
   *   nextAbsFrame（已读游标，最多超前整个预读缓冲），会让暂停点/进度条
   *   突然往前跳几秒，正是"暂停在 13s、续播从 15s 开始"的直接来源。
   *     1) 队首尚未起播（刚恢复/刚定位）→ 真实听感就是队首起点；
   *     2) 已播到队尾之后（数据断流）→ 听感停在队尾末端，不该继续往前跑；
   *     3) 队列已空 → 同样停在游标起点（尚未播出的那一帧）。
   */
  positionFrame() {
    if (!this.ctx) return this.lastPosFrame;
    // 暂停态：位置已被 pause() 钉死，不再随上下文/队列漂移
    if (this.state === 'paused') {
      return this._pausedFrame != null ? this._pausedFrame : this.lastPosFrame;
    }
    const ct = this.ctx.currentTime;
    this._trim(ct);   // 关键：不修剪的话队列永远不空，轨末判定会失效
    if (this.queue.length) {
      const first = this.queue[0];
      // ★ 队首尚未起播时不能用 first.absFrame 当位置。
      //   连续预读会把几十块一次性排进未来，此刻"队首起点"几乎等于轨首，
      //   用它会让位置一直卡在开头（旧实现在长轨上就会这样）。
      //   正确语义：真实听感 = 上一块结束处（lastPosFrame），
      //   只有它早于队首起点时才说明"确实还没轮到播放"。
      if (ct < first.startTime) {
        const f = Math.max(first.absFrame, this.lastPosFrame);
        this.lastPosFrame = f;
        return f;
      }
      for (const q of this.queue) {
        if (ct >= q.startTime && ct < q.startTime + q.duration) {
          const f = q.absFrame + (ct - q.startTime) * 75;
          this.lastPosFrame = f;
          return f;
        }
      }
      // 2) 播到了队尾之后（断流/整轨送完）：停在队尾末端。
      //    末尾块往往不足 1 秒（轨长不是 75 的整数倍），这里用轨末兜底，
      //    否则进度条会永远差最后一小截、轨末判定也可能不成立。
      const last = this.queue[this.queue.length - 1];
      let f = Math.max(last.absFrame + last.duration * 75, this.lastPosFrame);
      if (this.trackEndFrame > this.trackStartFrame) f = Math.min(f, this.trackEndFrame);
      this.lastPosFrame = f;
      return f;
    }
    // 3) 队列空（刚起播 / 刚恢复 / 刚定位 / 下一块还没到）：
    //    返回"最近一次确定的听感位置"。
    //    ★ 绝不能返回 nextAbsFrame（已读游标）——游标最多超前整个预读缓冲，
    //      用它当位置会让暂停点/进度条莫名往前跳几秒，
    //      正是"暂停在 13s、续播却从 15s 开始"的直接来源。
    return this.lastPosFrame;
  }

  isQueueEmpty() {
    // 先按当前时间回收已播完的块：否则轨末时队列永远非空，
    // 依赖 isQueueEmpty() 的"本轨播完"判定会一直不成立（旧版就卡在这里）
    if (this.ctx) this._trim(this.ctx.currentTime);
    return this.queue.length === 0;
  }

  /** 轨道边界是否已知（未知时不能用它换算位置，否则进度条会瞬间飙到几千秒） */
  hasTrackBounds() {
    return this.trackEndFrame > this.trackStartFrame;
  }

  atTrackEnd() {
    return this.trackEndFrame > 0 && this.nextAbsFrame >= this.trackEndFrame - 2;
  }
}

/* ---------- 演示合成引擎（无光驱时体验） ---------- */

class DemoAudio {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.melodyGain = null;
    this.filter = null;
    this.state = 'stopped';
    this.trackNumber = 0;
    this.trackStartCtx = 0;
    this.durationSec = 0;
    this.volume = 0.7;
    this.onEnd = null;
    this._timer = null;
    this._nextEvent = 0;
    this._seed = 0;
  }

  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.connect(this.ctx.destination);
    this.gain = this.ctx.createGain();
    this.gain.connect(master);
    this.gain.gain.value = this.volume * this.volume;
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 2400;
    this.filter.connect(this.gain);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume * this.volume;
  }

  /**
   * 起播演示轨
   * @param {number} track
   * @param {number} durationSec
   * @param {number} [fromSec] 轨内起始秒数
   */
  play(track, durationSec, fromSec) {
    this.ensure();
    this.trackNumber = track;
    this.durationSec = Math.max(1, Number(durationSec) || 1);
    this._seed = track * 7 + 3;
    const start = Math.max(0, Math.min(Number(fromSec) || 0, this.durationSec));
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // 关键：事件游标必须以当前 AudioContext 时间为基准，
    // 旧代码固定为 0，导致换轨后一次性补发大量过期音符（爆音 + 计数错乱）
    this._nextEvent = this.ctx.currentTime;
    this.trackStartCtx = this.ctx.currentTime - start;
    this.state = 'playing';
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this._schedule(), 140);
    this._schedule();
  }

  _note(t, freq, dur, vol) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.filter);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  _chord(t, freqs, dur, vol) {
    for (const f of freqs) this._note(t, f, dur, vol * 0.5);
  }

  _schedule() {
    if (!this.ctx || this.state !== 'playing') return;
    const ct = this.ctx.currentTime;
    // 标签页被节流后游标可能远远落后，直接追平，避免一次性补发上千个音符
    if (this._nextEvent < ct) this._nextEvent = ct;
    const horizon = ct + 1.4;
    const scale = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33]; // C 大调五声+六声
    const pattern = [0, 2, 4, 2, 5, 4, 2, 1];
    const eighth = 0.36;
    const bar = eighth * 8;

    while (this._nextEvent < horizon) {
      const ev = this._nextEvent;
      const secs = ev - this.trackStartCtx;
      if (secs > this.durationSec - 0.1) break;
      const barIndex = Math.floor(secs / bar);
      const inBar = secs - barIndex * bar;
      const step = Math.floor(inBar / eighth);

      // 低音（每小节第一个八分音符）
      if (step === 0) {
        const bass = 130.81 * (barIndex % 2 === 0 ? 1 : 1.5);
        this._note(ev, bass, bar * 0.9, 0.16);
        this._chord(ev, [scale[0] * 2, scale[2] * 2, scale[4] * 2], bar * 0.95, 0.07);
      }
      // 旋律琶音（八分音符，轻柔）
      const idx = pattern[step % pattern.length];
      const octave = step >= 4 ? 2 : 1;
      const freq = scale[idx] * octave;
      const accent = step % 4 === 0 ? 0.13 : 0.09;
      this._note(ev, freq, eighth * 1.7, accent);
      // 间隔点（偶尔的高音泛音）
      if (step % 8 === 7) this._note(ev, scale[6] * 2, eighth * 1.4, 0.045);

      this._nextEvent = ev + eighth * 0.5; // 每半个八分音符一个事件
    }

    // 轨末判定：以墙钟位置为准（不受事件调度粒度影响）
    if (this.positionSec() >= this.durationSec - 0.05) {
      this._finish();
    }
  }

  _finish() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.state = 'stopped';
    if (this.onEnd) this.onEnd(this.trackNumber);
  }

  pause() {
    if (!this.ctx) return;
    if (this.state !== 'playing') return;
    this.ctx.suspend();
    this.state = 'paused';
  }

  resume() {
    if (!this.ctx) return;
    if (this.state !== 'paused') return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // 暂停期间 AudioContext 时间冻结，恢复后事件游标需要重新对齐
    this._nextEvent = this.ctx.currentTime;
    this.state = 'playing';
    if (!this._timer) this._timer = setInterval(() => this._schedule(), 140);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.state = 'stopped';
  }

  seek(seconds) {
    if (!this.ctx) return;
    const sec = Math.max(0, Math.min(Number(seconds) || 0, this.durationSec));
    this.trackStartCtx = this.ctx.currentTime - sec;
    this._nextEvent = this.ctx.currentTime;
    if (this.state === 'stopped') {
      // 停止态定位等同于从该位置起播
      this.play(this.trackNumber, this.durationSec, sec);
    }
  }

  positionSec() {
    if (!this.ctx || this.state === 'stopped') return 0;
    return Math.max(0, Math.min(this.durationSec, this.ctx.currentTime - this.trackStartCtx));
  }
}
