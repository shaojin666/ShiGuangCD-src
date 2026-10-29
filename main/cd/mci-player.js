'use strict';
/*
 * mci-player.js —— MCI 回退播放路径。
 * 当 RAW 扇区读取不可用时，通过 winmm MCI 播放 CD 音频。
 * 限制：应用内音量不可用（依赖系统音量）。
 *
 * 设计要点（本次重构重点）：
 * 1) 时间轴不再靠"原点猜测"。open() 后直接用 MCI 自身的 MSF 时间轴为每轨建立
 *    { 起始 msf, 时长 } 映射表：所有 play / seek / position 都在同一条时间轴上换算，
 *    彻底消除旧实现里 `position` 用 `-origin`、`play from` 用 `+origin` 的符号矛盾
 *    （该矛盾会让起播位置偏移整整 4 秒，且切轨/定位全错）。
 * 2) 播放位置由本类本地维护（锚点 + 墙钟），MCI 轮询结果只用于校正，避免
 *    250ms 轮询抖动直接变成进度条抖动。
 * 3) 轨道结束判定增加双重保险：MCI mode=stopped 且 已播时长确实到达轨末。
 *
 * ★ 位置权威链（本次修复的核心）：
 *   本地墙钟只是"平滑器"，**MCI 自己回的 `status cd position` 才是权威**。
 *   凡是能让 MCI 改变位置的命令（play / pause / seek），命令返回后都要回读一次
 *   真实落点，并用它硬对齐本地时钟；暂停点、续播起点一律取回读值。
 *   旧实现"发命令前先量一次本地时钟"的做法会系统性地把暂停点记在
 *   命令生效之前的位置上（`pause cd` 是同步阻塞调用，耗时几十到几百毫秒），
 *   于是暂停点超前；续播又用 `resume cd` 从 MCI 的内部位置继续，
 *   两个基准互不覆盖，误差每做一次暂停/播放就累积一次。
 *
 * 注意：MCI cdaudio 是单占用设备。本播放器 open 后（别名 cd）会一直持有，
 * cd-service 的探测循环在 MCI 模式下必须停手（见 cd-service._probe）。
 */

const native = require('../native');

const MCIERR_DEVICE_OPEN = 525;
const MCIERR_DEVICE_NOT_READY = 522;

/** MCI 轮询间隔（ms） */
const POLL_INTERVAL = 250;
/** 起播后多久才开始承认"mode=stopped == 本轨播完"，规避 play 指令刚下发时的瞬时 stopped */
const END_GRACE_MS = 900;
/** 判定播完的容差（秒） */
const END_EPS_SEC = 0.6;
/**
 * 位置校正死区（秒）：小于该差值不打扰本地时钟，避免进度条来回跳。
 *
 * v10.3 从 0.15 收紧到 0.04（MCI 路径对齐链的第一级）：
 *   MCI position 的量化粒度是 1/75s ≈ 13ms，墙钟外推与真实回读的稳态差
 *   就在 ±13ms 量级；0.15 的死区会让起播校验遗留的小偏差（≤0.3s 容差内
 *   不对齐）永久保留，MCI 墙钟带着相位差开跑，经服务层与渲染端两层死区
 *   过滤后，用户看到的就是"歌词比音乐快半秒左右"。
 *   0.04 ≈ 3 帧量化，足以过滤量化噪声，又保证任何真实偏差在一轮轮询内
 *   就被硬对齐。视觉平滑由渲染端 easeTo() + 0.3s 死区负责，不会抖。
 */
const CORRECTION_DEADBAND = 0.04;
/** 起播后回读校验时，超过该差值才认定 MCI 没落在请求的位置上（秒） */
const START_VERIFY_TOLERANCE = 0.3;

function msfToFrame(str) {
  // "mm:ss:ff"
  const m = /^(\d+):(\d+):(\d+)$/.exec(String(str).trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 4500 + parseInt(m[2], 10) * 75 + parseInt(m[3], 10);
}

function frameToMsf(frame) {
  const f = Math.max(0, Math.round(frame));
  const min = Math.floor(f / 4500);
  const sec = Math.floor((f % 4500) / 75);
  const fr = f % 75;
  return `${min}:${String(sec).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}

class MciPlayer {
  /**
   * @param {object} o
   * @param {string} o.drive       盘符
   * @param {object} o.toc         TOC
   * @param {function} o.onPosition ({track, sec, state}) => void  权威位置回报
   * @param {function} o.onRemoved  () => void  光盘被取出
   * @param {function} o.onTrackEnd (trackNumber) => void  本轨播完
   * @param {function} o.log
   */
  constructor(o) {
    this.drive = o.drive || null;
    this.toc = o.toc || null;
    this.onPosition = o.onPosition || (() => {});
    this.onRemoved = o.onRemoved || (() => {});
    this.onTrackEnd = o.onTrackEnd || (() => {});
    this.log = o.log || (() => {});

    this.opened = false;
    this.trackNumber = 0;
    this.state = 'stopped';    // stopped | playing | paused
    this.trackSec = 0;         // 本轨内已播秒数（本地时钟）
    this._anchorMs = Date.now();
    this._startedAtMs = 0;
    this._timer = null;
    this._rmErrors = 0;
    this._ended = false;
    /** 暂停点（秒）。pause() 回读 MCI 真实落点后写入；续播起点取它 */
    this._pausedSec = null;
    /** 最近一次从 MCI 回读到的轨内位置（秒）：audibleSec() 的首选来源 */
    this._mciSec = null;
    this._mciSecAt = 0;
    /** 回读不可用（部分虚拟光驱不支持 status cd position）→ 本张碟永久回退到本地时钟 */
    this._readbackBroken = false;

    /** @type {Map<number, number>} 轨道号 -> MCI MSF 时间轴上的起始帧 */
    this._msfStart = new Map();
    /** @type {Map<number, number>} 轨道号 -> 时长（秒） */
    this._lenSec = new Map();
  }

  /* ---------- 底层指令 ---------- */

  _cmd(cmd) {
    const r = native.mciSend(cmd);
    if (r.code !== 0) {
      const msg = native.mciError(r.code);
      const err = new Error(`MCI: ${cmd.split(' ')[0]} 失败 - ${msg}`);
      err.mciCode = r.code;
      throw err;
    }
    return r.text;
  }

  /* ---------- 生命周期 ---------- */

  async open() {
    try {
      // 指定盘符打开，避免多光驱时 MCI 落到默认设备上
      this._cmd(this.drive ? `open ${this.drive}: type cdaudio alias cd` : 'open cdaudio alias cd');
      this.opened = true;
      this._cmd('set cd time format msf');
      this._buildTrackMap();
      this._startStatusLoop();
      return true;
    } catch (e) {
      if (e.mciCode === MCIERR_DEVICE_OPEN || e.mciCode === MCIERR_DEVICE_NOT_READY) return false;
      throw e;
    }
  }

  async close() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.opened) {
      try { this._cmd('close cd'); } catch (e) { /* 忽略 */ }
      this.opened = false;
    }
    this.state = 'stopped';
    this.trackSec = 0;
    this._pausedSec = null;
    this._mciSec = null;
  }

  /**
   * 建立「轨道号 → MCI MSF 起始帧 / 时长」映射。
   * 优先逐个轨道向 MCI 查询（结果一定与 MCI 自身时间轴一致），
   * 查询失败时才基于 TOC 帧号做保守换算。
   */
  _buildTrackMap() {
    this._msfStart.clear();
    this._lenSec.clear();
    const tracks = (this.toc && this.toc.tracks) ? this.toc.tracks : [];
    if (!tracks.length) return;

    // 回退用的换算基准：
    //  - raw TOC 的 startFrame 是绝对帧（首轨 = 150），MCI msf 0 假定对应绝对帧 150 → msf = abs - 150
    //  - MCI TOC 的 startFrame 是 LBA（首轨 = 0），且 mciOrigin 记录了 MCI 上报的首轨 msf 值
    const isLba = typeof this.toc.mciOrigin === 'number';
    const origin = isLba ? 150 - this.toc.mciOrigin : 150; // abs = msf + origin
    const absOffset = isLba ? 150 : 0;                     // TOC 帧 → 绝对帧

    for (const t of tracks) {
      let startMsf = null;
      let lenSec = null;
      try {
        const f = msfToFrame(this._cmd(`status cd position track ${t.number}`));
        if (f !== null) startMsf = f;
      } catch (e) { /* 该设备不支持逐轨查询 → 走回退换算 */ }
      try {
        const f = msfToFrame(this._cmd(`status cd length track ${t.number}`));
        if (f !== null && f > 0) lenSec = f / 75;
      } catch (e) { /* 同上 */ }

      if (startMsf === null) {
        startMsf = Math.max(0, (t.startFrame + absOffset) - origin);
      }
      if (lenSec === null || !(lenSec > 0)) {
        lenSec = Math.max(0, (t.endFrame - t.startFrame) / 75);
      }
      this._msfStart.set(t.number, startMsf);
      this._lenSec.set(t.number, lenSec);
    }
    this.log('mci track map: ' + tracks.map((t) =>
      `${t.number}@${this._msfStart.get(t.number)}/${(this._lenSec.get(t.number) || 0).toFixed(1)}s`
    ).join(' '));
  }

  trackLengthSec(trackNumber) {
    const v = this._lenSec.get(trackNumber);
    if (v && v > 0) return v;
    const t = (this.toc && this.toc.tracks) ? this.toc.tracks.find((x) => x.number === trackNumber) : null;
    return t ? Math.max(0, (t.endFrame - t.startFrame) / 75) : 0;
  }

  /* ---------- MCI 位置回读（位置权威的唯一来源） ---------- */

  /**
   * 向 MCI 索取它自己的当前位置。
   *
   * `status cd position` 返回的是**整张碟时间轴**上的 MSF（0 = 首轨起点），
   * 这里换算成本轨内的秒数。任何一步失败（指令不支持、返回格式不认识）
   * 都返回 null —— 调用方一律回退到本地时钟，绝不因此抛错。
   *
   * @returns {number|null} 本轨内秒数；无法回读时为 null
   */
  _readMciRelSec() {
    if (this._readbackBroken) return null;
    if (!this.opened || !this.trackNumber) return null;
    const startMsf = this._msfStart.get(this.trackNumber);
    if (startMsf == null) return null;
    let absFrame;
    try {
      absFrame = msfToFrame(this._cmd('status cd position'));
    } catch (e) {
      return null;
    }
    if (absFrame === null || !isFinite(absFrame)) return null;
    let rel = (absFrame - startMsf) / 75;
    // 负值说明 MCI 报的位置在当前轨起点之前（切轨瞬间常见）→ 视为不可用，
    // 否则会把位置硬拉到 0，进度条会往回跳。
    if (rel < -0.05) return null;
    const len = this.trackLengthSec(this.trackNumber);
    rel = Math.max(0, rel);
    if (len > 0) rel = Math.min(rel, len);
    return rel;
  }

  /** 把回读结果落进本地时钟（无死区，硬对齐）；回读失败时静默不动 */
  _syncFromMci(tag) {
    const rel = this._readMciRelSec();
    if (rel == null) return null;
    this.trackSec = rel;
    this._anchorMs = Date.now();
    this._mciSec = rel;
    this._mciSecAt = Date.now();
    if (tag) this.log(`mci sync(${tag}): -> ${rel.toFixed(3)}s`);
    return rel;
  }

  /* ---------- 本地时钟 ---------- */

  /** 当前在本轨内已播秒数（本地推算，暂停时冻结） */
  positionSec() {
    let sec = this.trackSec;
    if (this.state === 'playing') sec += (Date.now() - this._anchorMs) / 1000;
    const len = this.trackLengthSec(this.trackNumber);
    if (len > 0) sec = Math.min(sec, len);
    return Math.max(0, sec);
  }

  /**
   * 真实听感位置：MCI 由系统声卡直接出声，**MCI 自己回的位置就是听感位置**。
   *
   * 优先级：
   *   - 暂停态：_pausedSec（pause() 回读 MCI 落点后写入）—— 这是最权威的一刻；
   *   - 播放态：最近一次 250ms 轮询/命令回读到的值（_mciSec），
   *             它比墙钟准；两次回读之间由本地时钟平滑外推。
   */
  audibleSec() {
    if (this.state === 'paused' && this._pausedSec != null) return this._pausedSec;
    if (this._mciSec != null && this.state === 'playing') {
      let sec = this._mciSec + (Date.now() - this._mciSecAt) / 1000;
      const len = this.trackLengthSec(this.trackNumber);
      if (len > 0) sec = Math.min(sec, len);
      return Math.max(0, sec);
    }
    return this.positionSec();
  }

  /**
   * 由外部（渲染端）指定真实听感位置。
   *
   * ★ 注意：MCI 路径的权威是**本类回读到的 MCI 位置**，不是渲染端的墙钟。
   *   渲染端没有本地音频（声音由系统直接输出），它能给的只是一个估计值。
   *   因此这里只在"本类无法回读"（虚拟光驱不支持 status cd position）时才采纳它，
   *   回读可用时仅做小幅兜底对齐，避免把估计值覆盖到回读值上。
   */
  setAudibleSec(sec) {
    if (sec == null || !isFinite(sec)) return;
    const s = Math.max(0, Number(sec) || 0);
    // 回读可用时以回读值为准（并拒绝明显偏离的估计值）
    if (!this._readbackBroken && this._mciSec != null && this.state !== 'stopped') {
      const trust = this.state === 'paused' && this._pausedSec != null ? this._pausedSec : this._mciSec;
      if (Math.abs(s - trust) > CORRECTION_DEADBAND) {
        this.log(`mci setAudibleSec ignored: local=${s.toFixed(3)} readback=${trust.toFixed(3)}`);
        return;
      }
    }
    this.trackSec = s;
    this._anchorMs = Date.now();
    this._pausedSec = s;
  }

  /** 用权威值校正本地时钟（带死区，避免抖动） */
  _correct(sec) {
    const len = this.trackLengthSec(this.trackNumber);
    let target = Math.max(0, sec);
    if (len > 0) target = Math.min(target, len);
    this._mciSec = target;
    this._mciSecAt = Date.now();
    const cur = this.positionSec();
    if (Math.abs(target - cur) <= CORRECTION_DEADBAND) return false;
    this.trackSec = target;
    this._anchorMs = Date.now();
    return true;
  }

  /* ---------- 状态轮询 ---------- */

  /**
   * 状态轮询（v10.3 重构：CPU 与精度）。
   *
   * ★ 旧实现每 250ms 固定发 4 条同步 MCI 命令（media present / position /
   *   length track N / mode），共 16 次/秒。MCI 命令是 winmm 同步调用，
   *   在虚拟光驱 / USB 光驱上单条就要数毫秒，主线程被反复打断 —— 这正是
   *   用户反馈"MCI 模式 CPU 占用偏高"的主因。
   *
   *   现在按状态分级：
   *     播放态 —— position + mode 每轮（轨末/位置/取盘都需要），
   *               media present 降到每 4 轮一次（取盘判定有 mode 兜底）；
   *     暂停/停止/就绪态 —— 位置不变，有效查询降到 500ms 一次，
   *               position 完全不查（没有意义），media present 每 4 次一次。
   *   另外两条降载规则：
   *     - `status cd length track N` 整个移除：轨道时长在 _buildTrackMap
   *       已有缓存，轮询里查它纯属浪费；
   *     - media present 连续不被设备支持（抛错）后停止再查，改由 mode 判定。
   */
  _startStatusLoop() {
    if (this._timer) clearInterval(this._timer);
    this._rmErrors = 0;
    this._tick = 0;
    this._presentFailStreak = 0;
    this._mediaPresentBroken = false;
    this._posFailStreak = 0;
    this._timer = setInterval(() => {
      this._tick++;
      const playing = this.state === 'playing';
      // 非播放态降频：位置不变，密集查询没有意义（取盘检测 500ms 足够）
      if (!playing && (this._tick & 1)) return;

      // 1) 取盘检测：`media present` 明确判定托盘内是否还有盘。
      //    降频到每 4 次有效轮询一次（播放态约 1s，暂停态约 2s）——
      //    mode 通道每轮都在，取盘判定不缺这一条；连续不被支持后停查。
      let present = true;
      if (!this._mediaPresentBroken && (this._tick % 4 === 0)) {
        try {
          const mp = this._cmd('status cd media present');
          const s = String(mp).trim().toLowerCase();
          if (s === 'false' || s === '0') present = false;
          this._presentFailStreak = 0;
        } catch (e) {
          this._presentFailStreak++;
          if (this._presentFailStreak >= 4) {
            this._mediaPresentBroken = true;
            this.log('mci: media present unavailable -> rely on mode for disc-removed');
          }
        }
      }

      // 2) 权威位置回读（仅播放态：暂停/停止态位置不变，不查）
      let msf = null;
      let posFail = false;
      if (playing) {
        try {
          msf = msfToFrame(this._cmd('status cd position'));
        } catch (e) {
          posFail = true;
        }
      }

      // 3) 播放模式（每轮都查：轨末判定与取盘判定都用它）
      let mode = null;
      try {
        mode = String(this._cmd('status cd mode')).trim().toLowerCase();
      } catch (e) { /* 忽略 */ }

      // 真正能判定"取盘"的证据：media present=false、mode 报无盘、
      // 或 mode 查询本身失败（设备整体无响应，原 lenOk 通道的继任者）
      if (!present || mode === 'no disc' || mode === 'not ready' || mode === 'open') this._rmErrors++;
      else if (posFail && !mode) this._rmErrors++;
      else this._rmErrors = Math.max(0, this._rmErrors - 1);
      if (this._rmErrors >= 3) {
        clearInterval(this._timer);
        this._timer = null;
        this.log('mci: disc removed (rmErrors=' + this._rmErrors + ')');
        if (this.onRemoved) this.onRemoved();
        return;
      }

      // 4) 位置回读连续失败 → 本张碟永久回退本地时钟（只在播放态统计）
      if (posFail && !this._readbackBroken) {
        this._posFailStreak++;
        if (this._posFailStreak >= 5) {
          this._readbackBroken = true;
          this.log('mci: status cd position unavailable -> fall back to local clock');
        }
      } else if (!posFail) {
        this._posFailStreak = 0;
      }

      // 5) 权威位置回报（仅在确实在播时）
      if (playing && msf !== null && this._msfStart.has(this.trackNumber)) {
        const rel = (msf - this._msfStart.get(this.trackNumber)) / 75;
        if (rel >= -1) {
          this._correct(rel);
          this.onPosition({ track: this.trackNumber, sec: this.positionSec(), state: this.state });
        }
      }

      // 6) 本轨结束：以 **MCI 自己的位置**为准，而不是本地时钟。
      //    MCI 播到 `to` 边界会自动停（mode=stopped）并停在轨末附近；
      //    本地时钟可能因起播校验/回读对齐而早或晚到轨末，用它判定会漏判或早判。
      if (playing && !this._ended) {
        const elapsed = Date.now() - this._startedAtMs;
        const len = this.trackLengthSec(this.trackNumber);
        const posNow = msf !== null && this._msfStart.has(this.trackNumber)
          ? (msf - this._msfStart.get(this.trackNumber)) / 75
          : this.positionSec();
        const atEnd = len > 0 ? posNow >= len - END_EPS_SEC : true;
        if (mode === 'stopped' && elapsed > END_GRACE_MS && atEnd) {
          this._ended = true;
          this.state = 'stopped';
          this._pausedSec = null;
          this.trackSec = len > 0 ? len : this.positionSec();
          this._anchorMs = Date.now();
          this.log('mci: track ' + this.trackNumber + ' ended');
          this.onTrackEnd(this.trackNumber);
        }
      }
    }, POLL_INTERVAL);
  }

  /* ---------- 播放控制 ---------- */

  /** 在 MCI 自身时间轴上起播：`play cd from <msf> to <msf>` */
  _play(trackNumber, fromSec) {
    if (!this._msfStart.has(trackNumber)) throw new Error('MCI 缺少轨道 ' + trackNumber + ' 的时间信息');
    const startMsf = this._msfStart.get(trackNumber);
    const lenSec = this.trackLengthSec(trackNumber);
    const from = Math.max(startMsf, Math.round(startMsf + Math.max(0, fromSec) * 75));
    // 显式给出"到本轨末"的边界：否则 MCI 会一路播到导出区（lead-out），
    // 多数虚拟光驱/驱动在导出区循环回放，表现为"重复一段内容"。
    const to = Math.round(startMsf + lenSec * 75);
    this._cmd(`play cd from ${frameToMsf(from)} to ${frameToMsf(Math.max(from + 75, to))}`);
  }

  /**
   * 起播指定轨道
   * @param {number} trackNumber
   * @param {number} [fromSec] 轨内起始秒数（用于定位后继续播 / 续播）
   */
  async playTrack(trackNumber, fromSec) {
    const t = (this.toc && this.toc.tracks) ? this.toc.tracks.find((x) => x.number === trackNumber) : null;
    if (!t) return;
    if (!this._msfStart.size) this._buildTrackMap();
    const len = this.trackLengthSec(trackNumber);
    let sec = Math.max(0, Number(fromSec) || 0);
    if (len > 0) sec = Math.min(sec, Math.max(0, len - 0.05));

    this.trackNumber = trackNumber;
    this._ended = false;
    this._pausedSec = null;
    this._mciSec = null;
    this._play(trackNumber, sec);
    this.trackSec = sec;
    this._anchorMs = Date.now();
    this._startedAtMs = Date.now();
    this.state = 'playing';

    // 起播校验：MCI 对上轨起点、光盘起始定位、驱动舍入都可能让它落在别处。
    // 回读一次真实落点，偏差明显就对齐本地时钟（否则进度条会一直偏着走）。
    const actual = this._readMciRelSec();
    if (actual != null && Math.abs(actual - sec) > START_VERIFY_TOLERANCE) {
      this.log(`mci playTrack verify: requested=${sec.toFixed(3)} actual=${actual.toFixed(3)} -> align`);
      this.trackSec = actual;
      this._anchorMs = Date.now();
    }
    if (actual != null) { this._mciSec = actual; this._mciSecAt = Date.now(); }

    this.onPosition({ track: trackNumber, sec: this.audibleSec(), state: 'playing' });
  }

  /**
   * 暂停。
   *
   * ★ 顺序是本次修复的关键：
   *   1) 先置 state='paused' —— 让本地时钟立刻停止累加，命令期间不再"偷偷前进"；
   *   2) 再下发 `pause cd`（这是同步阻塞调用，耗时几十到几百毫秒）；
   *   3) **回读 MCI 真正停下的位置**作为暂停点 —— 而不是命令前量到的那个值。
   *
   * 旧实现是"先量后停"且从不回读，于是暂停点 = 命令生效前的位置，
   * 系统性超前；续播再从这个超前位置继续，误差就累积成了"越播越靠后"。
   */
  async pause() {
    if (this.state !== 'playing') return;
    // 1) 冻结：positionSec() 从此不再累加墙钟
    const guess = this.positionSec();
    this.state = 'paused';
    this.trackSec = guess;
    this._anchorMs = Date.now();

    // 2) 下发暂停
    try { this._cmd('pause cd'); } catch (e) { /* 忽略 */ }

    // 3) 回读真实落点（硬对齐，无死区）
    const actual = this._syncFromMci('pause');
    const sec = actual != null ? actual : guess;
    this._pausedSec = sec;
    this.trackSec = sec;
    this._anchorMs = Date.now();

    this.log(`mci pause: guess=${guess.toFixed(3)} readback=${actual == null ? '-' : actual.toFixed(3)} -> pausedAt=${sec.toFixed(3)}`);
    this.onPosition({ track: this.trackNumber, sec, state: 'paused' });
  }

  /**
   * 续播。
   *
   * ★ 不再使用 `resume cd`：那条命令让 MCI 从**它自己的内部位置**继续，
   *   而应用把锚点钉在**自己的时钟**上，两个基准永不重合，误差每轮累积一次。
   *   改为 `play cd from <暂停点> to <轨末>` —— 起播位置完全由应用决定，
   *   MCI 只是执行者，只有一个权威，误差不可能累积。
   *   暂停点取 pause() 回读到的 _pausedSec（缺失时退到本地时钟）。
   */
  async resume() {
    if (this.state === 'playing') return;
    const base = this._pausedSec != null ? this._pausedSec : this.positionSec();

    if (this.state === 'stopped') {
      // MCI 到轨末自动停后 state 已是 stopped：从当前位置重新起播该轨
      await this.playTrack(this.trackNumber || 1, base);
      return;
    }

    const len = this.trackLengthSec(this.trackNumber);
    let sec = Math.max(0, base);
    if (len > 0) sec = Math.min(sec, Math.max(0, len - 0.05));

    this._ended = false;
    this._play(this.trackNumber, sec);
    this.trackSec = sec;
    this._anchorMs = Date.now();
    this._startedAtMs = Date.now();
    this._pausedSec = null;
    this.state = 'playing';

    // 起播校验：确认 MCI 确实从暂停点开始，而不是别的地方
    const actual = this._readMciRelSec();
    if (actual != null && Math.abs(actual - sec) > START_VERIFY_TOLERANCE) {
      this.log(`mci resume verify: requested=${sec.toFixed(3)} actual=${actual.toFixed(3)} -> align`);
      this.trackSec = actual;
      this._anchorMs = Date.now();
      sec = actual;
    }
    if (actual != null) { this._mciSec = actual; this._mciSecAt = Date.now(); }

    this.onPosition({ track: this.trackNumber, sec: this.audibleSec(), state: 'playing' });
  }

  async stop() {
    try { this._cmd('stop cd'); } catch (e) { /* 忽略 */ }
    this.state = 'stopped';
    this.trackSec = 0;
    this._ended = false;
    this._pausedSec = null;
    this._mciSec = null;
    this.onPosition({ track: this.trackNumber, sec: 0, state: 'stopped' });
    // 状态轮询保留：就绪态也能感知取盘
  }

  /**
   * 轨内定位（秒）。保持播放/暂停状态不变：
   *  - 播放中 → 从新位置继续播
   *  - 暂停中 → play 后立刻 pause，MCI 位置停在新位置且仍是暂停态
   *  - 停止中 → 直接起播（MCI 无法在 stopped 下静默定位）
   *
   * ★ 定位后回读 MCI 实际落点：驱动会把请求的帧对齐到扇区边界，
   *   直接回传 target 会让界面数字与实际出声位置差上一小段，
   *   这段差值随后被歌词消费，就表现为"快进后歌词跑偏"。
   */
  async seekToSeconds(sec) {
    const t = (this.toc && this.toc.tracks) ? this.toc.tracks.find((x) => x.number === this.trackNumber) : null;
    if (!t) return;
    if (!this._msfStart.size) this._buildTrackMap();
    const len = this.trackLengthSec(this.trackNumber);
    let target = Math.max(0, Number(sec) || 0);
    if (len > 0) target = Math.min(target, Math.max(0, len - 0.05));

    const wasPaused = this.state === 'paused';
    this._ended = false;
    this._pausedSec = null;
    this._mciSec = null;
    this._play(this.trackNumber, target);
    this.trackSec = target;
    this._anchorMs = Date.now();
    this._startedAtMs = Date.now();

    if (wasPaused) {
      // 暂停态定位：play 起播后立刻暂停，让 MCI 的位置停在新位置上
      try { this._cmd('pause cd'); } catch (e) { /* 忽略 */ }
      this.state = 'paused';
      const actual = this._syncFromMci('seek-paused');
      const landed = actual != null ? actual : target;
      this._pausedSec = landed;
      this.trackSec = landed;
      this._anchorMs = Date.now();
      this.log(`mci seek(paused): target=${target.toFixed(3)} landed=${landed.toFixed(3)}`);
      this.onPosition({ track: this.trackNumber, sec: landed, state: 'paused' });
    } else {
      this.state = 'playing';
      const actual = this._readMciRelSec();
      const landed = actual != null ? actual : target;
      if (actual != null) { this._mciSec = actual; this._mciSecAt = Date.now(); }
      this.trackSec = landed;
      this._anchorMs = Date.now();
      this.onPosition({ track: this.trackNumber, sec: landed, state: 'playing' });
    }
  }

  async eject() {
    try { this._cmd('set cd door open'); return true; } catch (e) { return false; }
  }

  async closeDoor() {
    try { this._cmd('set cd door closed'); return true; } catch (e) { return false; }
  }

  getState() {
    try {
      const mode = String(this._cmd('status cd mode')).trim().toLowerCase();
      if (mode === 'playing') return 'playing';
      if (mode === 'paused') return 'paused';
      return 'stopped';
    } catch (e) {
      return this.state;
    }
  }

  /** 供服务层判定盘是否仍在（虚拟光驱/无盘时仍可能读到旧状态） */
  isMediaPresent() {
    try {
      const mp = this._cmd('status cd media present');
      const s = String(mp).trim().toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
    } catch (e) { /* 回退到 mode 判断 */ }
    try {
      const mode = String(this._cmd('status cd mode')).trim().toLowerCase();
      return mode !== 'open' && mode !== 'no disc' && mode !== 'not ready';
    } catch (e) {
      return false;
    }
  }
}

module.exports = { MciPlayer, msfToFrame, frameToMsf };
