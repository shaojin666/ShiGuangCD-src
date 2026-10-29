'use strict';
/*
 * raw-player.js —— 主进程侧的 RAW 流式播放引擎。
 * 通过 worker 线程逐块读取 CD-DA 扇区，做预读缓冲后推送给渲染进程。
 *
 * 帧号约定：
 *   - 对外（TOC / 渲染端）一律使用 TOC 帧号：
 *       raw TOC  → 绝对帧（首轨 = 150）
 *       MCI TOC  → LBA 帧（首轨 = 0）
 *   - 下发到 IOCTL_CDROM_RAW_READ 的必须是 LBA，换算偏移量由构造参数 lbaOffset 决定，
 *     旧实现硬编码 150，在 MCI 兜底读到的 TOC 上会整体错位 2 秒。
 */

const { Worker } = require('worker_threads');
const path = require('path');
const { pcmStats } = require('./audio-stats');

const CHUNK_SECTORS = 75;        // 1 秒（75 扇区 × 1/75 秒）
const CHUNK_SECONDS = 1;
/**
 * 最大预读：以"已读超前量（秒）"衡量，而不是只增不减的块计数。
 * 旧实现用块计数做背压，20 块之后 pump 就永远睡下去 —— 长轨播到 20 秒左右直接断流。
 * 取值也不宜过大：预读越多，暂停时"界面位置 vs 真实听感位置"的偏差越大，
 * 且切轨/暂停后要丢弃的缓冲越多。5 秒（约 0.85 MB）足够吸收光驱抖动。
 */
const MAX_BUFFER_SECONDS = 5;
/**
 * 连续读取失败阈值。旧值为 8，意味着弹出光盘后还要填 8 秒静音才停 ——
 * 期间进度条照走、轨末判定照触发，于是表现为"卡死 + 无限重播下一轨"。
 */
const MAX_CONSECUTIVE_ERRORS = 3;
/** 读取停滞阈值：超过这么久没有任何推进，就认为介质可能已经不在了 */
const STALL_LIMIT_MS = 4000;
/**
 * 连续全零数据块阈值（块 = 1 秒音频）。
 * IOCTL_CDROM_RAW_READ 对"读取失败"并不总是报错：介质被取走、虚拟光驱、
 * 部分 USB 外置光驱都会返回"成功 + 全零"。不识别的话 pump 一路健康推进，
 * 用户听到静音、进度条照走 —— 能力测试只查开头 2 扇区，兜不住播放中才
 * 出现的全零（弹盘后设备不报错的那类）。连续 8 秒纯数字静意在真实 CD 上
 * 几乎不存在；即便误判，后果也只是切换 MCI，声音不会断。
 */
const ZERO_CHUNK_LIMIT = 8;
/**
 * 连续"垃圾数据"块阈值（块 = 1 秒音频）。
 * 比 ZERO_CHUNK_LIMIT 短：白噪音是**正在往外喷的噪声**，多响一秒都是折磨，
 * 而静音至少不刺耳。非零但整块没有一个合法 CD-DA sync 头 = 驱动伪造数据
 * （2026-10 用户实测：RAW 模式全程"电视雪花"白噪音，正是这一形态）。
 * 真音频每扇区必带 sync 头，误判只会发生在已经是垃圾的流上；
 * 即便误判，后果也只是切换 MCI，声音不会断。
 */
const GARBAGE_CHUNK_LIMIT = 4;
/**
 * 数据形态看门狗的"起播窗口"（毫秒）。
 *
 * ★ 为什么需要窗口（v10.3 用户实测修复）：
 *   旧实现让 silence/garbage 看门狗在整个播放期持续生效，切歌成为重灾区 ——
 *   用户实测：读盘时能力测试已判定 RAW 可用、播放完全正常，仅因为切歌操作
 *   就有很大概率触发"白噪音"误判，被错误回退 MCI（断声 + 引擎状态突变）。
 *   误判来自两个层面：
 *     1) 逐块波形判据（detectPcmForm）在轨首静音、极低电平段等边界块上
 *        可能把正常数据判成 garbage；
 *     2) 切歌瞬间旧轨在途数据块回来后仍会刷新全局 _decodeMode（竞态污染）。
 *   而"引擎该用哪种"本应在读盘仪式的能力测试里就决策完（见 cd-service
 *   _testRawRead），播放中再看门狗属于冗余安全网 —— 误判的代价（正常播放
 *   被强行打断、切到 MCI）远大于收益。
 *
 *   现在：看门狗只在本引擎**起播后的窗口期内**有回退权，覆盖能力测试
 *   漏判的场景（能力测试只探第一个音频轨的轨首，用户若直接从第 5 轨起播，
 *   第 5 轨轨首的异常数据需要这道保险）。窗口基于实例创建时间，**切歌 /
 *   seek / 暂停恢复都不刷新** —— 稳定播放中绝不再因数据形态切换引擎。
 */
const WATCHDOG_WINDOW_MS = 10000;
/** 介质探测超时：设备无响应时不能让看门狗被永久挂起 */
const CHECK_TIMEOUT_MS = 1500;
/**
 * 读取线程启动超时。
 * worker 加载失败（原生模块在线程内加载不了等）时，'open' 的回复可能永远
 * 不来 —— 起播路径若无限等待，表现为"点了播放什么都没发生、没有任何日志"。
 * 必须快速失败，让服务层回退 MCI（至少有声音）。
 */
const START_TIMEOUT_MS = 10000;

class RawPlayer {
  /**
   * @param {object} opts
   * @param {string} opts.drive 驱动器盘符，如 'D'
   * @param {object} opts.toc
   * @param {number} [opts.lbaOffset] TOC 帧 → LBA 的偏移量（raw TOC:150，MCI TOC:0）
   * @param {function} opts.onChunk  (payload) => void   payload={track,absFrame,samples(Buffer)}
   * @param {function} opts.onError  (message) => void
   */
  constructor(opts) {
    this.drive = opts.drive;
    this.toc = opts.toc;
    // 旧代码恒为 150；MCI 兜底得到的 TOC 首轨已是 LBA 0，此处必须为 0
    this.lbaOffset = typeof opts.lbaOffset === 'number' ? opts.lbaOffset : 150;
    this.onChunk = opts.onChunk;
    this.onError = opts.onError;
    this.log = opts.log || (() => {});
    this.worker = null;
    this.reqSeq = 0;
    this.pending = new Map();
    this.state = 'stopped'; // stopped | playing | paused
    this.trackNumber = 0;
    this.cursorFrame = 0;
    this.trackStartFrame = 0;
    this.trackEndFrame = 0;
    /* 播放进度时钟：用于计算"已读超前量"。
       旧实现用只增不减的 buffered 计数做背压，20 块之后 pump 就永远睡下去
       —— 长轨播到 20 秒左右会直接断流。 */
    this._clock = { sec: 0, at: Date.now() };
    this.buffered = 0;
    this.consecutiveErrors = 0;
    this.totalReadErrors = 0;
    /** 连续全零数据块计数（看门狗用，见 ZERO_CHUNK_LIMIT） */
    this._zeroChunks = 0;
    /** 连续垃圾数据块计数（看门狗用，见 GARBAGE_CHUNK_LIMIT） */
    this._garbageChunks = 0;
    /** 最近一个数据块的解码形态：'be16' | 'le16' | 'silence' | 'garbage'（worker 判别，看门狗用） */
    this._decodeMode = 'be16';
    /** 看门狗回退权的截止时刻（起播窗口，见 WATCHDOG_WINDOW_MS）。切歌不刷新 */
    this._watchdogUntil = Date.now() + WATCHDOG_WINDOW_MS;
    /** 窗口外已发过一次"疑似白噪音"日志（避免每块都打） */
    this._garbageNoticeSent = false;
    this.pumping = false;
    this.closed = false;
    /** 单调递增的播放代次：切轨/定位会自增，用于丢弃过期的在途数据 */
    this.generation = 0;
    /** 最近一次"读取有推进"的时间戳，用于介质丢失看门狗 */
    this._lastProgressAt = Date.now();
    /** 暂停时记录的真实听感位置（秒），恢复时从此处重新起读 */
    this._pausedSec = null;
  }

  /** 标记读取有推进（背压等待也算健康，不能误判为停滞） */
  _touch() {
    this._lastProgressAt = Date.now();
  }

  /**
   * 读取健康度：服务层用它判定介质是否还在。
   * 物理弹出光盘后，rawRead 会连续报错或直接卡住 —— 这是唯一不占用主线程的探测手段。
   */
  mediaHealthy() {
    if (this.state !== 'playing') return true;
    if (this.cursorFrame >= this.trackEndFrame) return true;   // 整轨已读完，停泵属正常
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return false;
    return (Date.now() - this._lastProgressAt) < STALL_LIMIT_MS;
  }

  async start() {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { if (this.worker) this.worker.terminate(); } catch (e) { /* 已退出 */ }
        reject(new Error('读取线程启动超时（' + START_TIMEOUT_MS + 'ms 无响应）'));
      }, START_TIMEOUT_MS);
      const done = (fn) => (arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      this.worker = new Worker(path.join(__dirname, 'reader-worker.js'));
      this.worker.on('message', (m) => this._onMessage(m));
      this.worker.on('error', (e) => this._fatal('读取线程错误：' + e.message));
      this.worker.on('exit', (code) => {
        if (!this.closed && code !== 0) this._fatal('读取线程异常退出');
      });
      this._request({ type: 'open', drive: this.drive })
        .then(done(() => {
          // 引擎真正就绪才起算看门狗窗口（worker 启动本身可能耗时数秒）
          this._watchdogUntil = Date.now() + WATCHDOG_WINDOW_MS;
          resolve();
        }))
        .catch(done((e) => reject(e)));
    });
  }

  _request(msg) {
    return new Promise((resolve, reject) => {
      const id = ++this.reqSeq;
      msg.reqId = id;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(msg);
    });
  }

  /**
   * 读取一个音频块，返回 { samples, decode }。
   * decode 随块返回而不是写进全局状态（见 _onMessage 的说明）：
   * 只有 generation 匹配的块才有资格更新 _decodeMode。
   */
  _readChunk(lba, count) {
    return this._request({ type: 'read', lba, count });
  }

  _onMessage(m) {
    const p = this.pending.get(m.reqId);
    if (!p) return;
    this.pending.delete(m.reqId);
    // 注意：check-result 不带 ok 字段（结果在 supported/present 里），
    // 只有显式 ok === false 才算失败，否则会被误判成 reject。
    if (m.ok === false) {
      p.reject(new Error(m.error || '读取失败'));
      return;
    }
    if (m.type === 'data') {
      /**
       * ★ 不再在这里写 this._decodeMode（v10.3 修复）。
       *   旧实现对**任何** data 消息都刷新全局 _decodeMode —— 包括切歌瞬间
       *   回来的旧轨过期块。过期块被 pump 丢弃，但它判出的 'garbage' 形态
       *   已经污染全局状态，随后新轨的正常块可能沿用过期的看门狗计数口径。
       *   现在由 pump 在确认 generation 匹配后，从本块的 resolve 值里取形态
       *   （见 _readChunk），过期的块碰不到任何共享状态。
       */
      p.resolve({ samples: m.samples, decode: m.decode || 'be16' });
      return;
    }
    p.resolve(m);
  }

  _fatal(msg) {
    if (this.closed) return;
    this.state = 'stopped';
    if (this.onError) this.onError(msg);
  }

  /* ---------- 播放进度时钟（背压与位置推算的基准） ---------- */

  _setClock(sec) {
    this._clock = { sec: Math.max(0, Number(sec) || 0), at: Date.now() };
  }

  _freezeClock() {
    this._clock = { sec: this.playedSec(), at: Date.now() };
  }

  /** 本轨"已送到播放端"的秒数（暂停时冻结） */
  playedSec() {
    let s = this._clock.sec;
    if (this.state === 'playing') s += (Date.now() - this._clock.at) / 1000;
    return Math.max(0, s);
  }

  /** 已读超前量（秒）：决定还能不能继续预读 */
  _aheadSec() {
    const start = this._startFrameOf(this.trackNumber);
    if (start === null) return 0;
    return Math.max(0, (this.cursorFrame - start) / 75 - this.playedSec());
  }

  _lbaOf(frame) {
    return Math.max(0, Math.round(frame) - this.lbaOffset);
  }

  _startFrameOf(trackNumber) {
    const t = this.toc.tracks.find((x) => x.number === trackNumber);
    return t ? t.startFrame : null;
  }

  _endFrameOf(trackNumber) {
    const t = this.toc.tracks.find((x) => x.number === trackNumber);
    return t ? t.endFrame : null;
  }

  /** 轨内秒数 → TOC 帧号 */
  _frameOfSec(trackNumber, sec) {
    const start = this._startFrameOf(trackNumber);
    if (start === null) return null;
    return start + Math.round(Math.max(0, sec) * 75);
  }

  /** TOC 帧号 → 轨内秒数 */
  positionSec() {
    const start = this._startFrameOf(this.trackNumber);
    if (start === null) return 0;
    // 光标是"已读"位置，真正听到的位置落后约一个缓冲区；
    // 精确位置由渲染端基于已调度音频计算，这里只提供一个保守下界。
    return Math.max(0, (this.cursorFrame - start) / 75);
  }

  /**
   * 本进程能给出的"听感位置下界"。
   *
   * ★ 这里**不是**真实听感位置。主进程只知道两件事：
   *   1) 已读光标（cursorFrame）——比耳朵听到的最多超前整个预读缓冲；
   *   2) 本地墙钟（playedSec）——只反映"数据送出去了多久"，同样超前。
   *   真正播到第几秒只有渲染端知道（它握着 AudioContext 的调度队列）。
   *
   * 旧实现写成 `Math.min(playedSec(), positionSec())`，看起来像"取更保守的那个"，
   * 实际上两者都超前于真实听感，于是暂停点会整体偏后几秒 ——
   * 表现为"续播位置比暂停时偏后"。
   *
   * 现在的语义：
   *   - 暂停态：返回渲染端通过 setAudibleSec() 写入的听感位置（权威）；
   *   - 播放态：返回 playedSec()（墙钟），仅作为**兜底日志/看门狗**用，
   *     绝不允许被服务层拿去当暂停点。
   */
  audibleSec() {
    if (this.state === 'paused' && this._pausedSec != null) return this._pausedSec;
    return this.playedSec();
  }

  durationSec() {
    const start = this._startFrameOf(this.trackNumber);
    const end = this._endFrameOf(this.trackNumber);
    if (start === null || end === null) return 0;
    return Math.max(0, (end - start) / 75);
  }

  /**
   * 起播指定轨道
   * @param {number} trackNumber
   * @param {number} [fromSec] 轨内起始秒数
   */
  async playTrack(trackNumber, fromSec) {
    const start = this._startFrameOf(trackNumber);
    const end = this._endFrameOf(trackNumber);
    if (start === null || end === null) throw new Error('未知轨道 ' + trackNumber);
    this.generation++;
    this.trackNumber = trackNumber;
    this.trackStartFrame = start;
    this.trackEndFrame = end;
    this.cursorFrame = Math.min(Math.max(this._frameOfSec(trackNumber, fromSec || 0), start), end);
    this._setClock(fromSec || 0);
    this.buffered = 0;
    this.consecutiveErrors = 0;
    this._zeroChunks = 0;
    this._garbageChunks = 0;
    this._decodeMode = 'be16';
    this._pausedSec = null;
    this._touch();
    this.state = 'playing';
    this.pump();
  }

  /**
   * 暂停。
   *
   * 关键顺序：**先冻结时钟、切状态，再让在途数据作废**。
   * 暂停点本身不在这里决定 —— 服务层会把渲染端上报的听感位置随后通过
   * setAudibleSec() 写进来（那才是耳朵听到的那一秒）。
   * 这里只做一个保守兜底：若渲染端没来得及上报，至少不要用已读光标冒充。
   */
  pause() {
    if (this.state !== 'playing') return;
    // 兜底值取墙钟（比光标保守），随后会被渲染端的权威值覆盖
    const fallback = this.playedSec();
    this._freezeClock();
    this.state = 'paused';
    this._pausedSec = fallback;
    this.generation++;      // 让在途读取结果失效，避免暂停后仍有数据被推给渲染端
  }

  /**
   * 由外部（渲染端）指定真实听感位置 —— 这是暂停点/续播起点的**唯一权威**。
   *
   * 渲染端掌握 AudioContext 的调度时间，知道音频到底播到了哪；主进程的已读光标
   * 与它之间隔着一个预读缓冲（RAW 路径最多 5 秒）。以渲染端为准，
   * 暂停点与界面数字才可能一致，续播也不会偏后。
   *
   * ★ 在 playing 态也要同步光标（cursorFrame）：
   *   否则"锚点定在 13s、读取却从 18s 继续"，恢复后第一块音频就是 18s 的内容，
   *   听感依旧偏后。光标必须与锚点落在同一秒。
   */
  setAudibleSec(sec) {
    if (sec == null || !isFinite(sec)) return;
    const s = Math.max(0, Number(sec) || 0);
    this._pausedSec = s;
    this._clock = { sec: s, at: Date.now() };
    // 光标与听感位置对齐（在同一轨内才动，避免跨轨误移）
    const start = this._startFrameOf(this.trackNumber);
    const end = this._endFrameOf(this.trackNumber);
    if (start !== null) {
      this.cursorFrame = Math.min(
        Math.max(start + Math.round(s * 75), start),
        end != null ? end : this.trackEndFrame
      );
    }
    this._pausedSec = s;
  }

  /**
   * 主动探测介质是否还在（在 worker 线程里做，不占用主线程）。
   * @returns {Promise<boolean|null>} true=在，false=已不在，null=无法判定
   *
   * ★ 为什么不能只靠"读取连续失败"：
   *   相当一部分光驱（尤其是虚拟光驱、部分 USB 外置光驱）在无介质时
   *   IOCTL_CDROM_RAW_READ 依然返回成功，只是数据全为零。此时 pump 一路
   *   "读取成功"并持续推进光标，看门狗永远判定健康 —— 光盘被弹出却毫无察觉。
   *   所以必须显式问一次设备："盘还在吗？"
   */
  async probeMedia() {
    if (!this.worker || this.closed) return null;
    try {
      const r = await this._requestWithTimeout({ type: 'check' }, CHECK_TIMEOUT_MS);
      if (!r || r.supported === false) return null;   // 设备不支持该指令 → 交回上层另想办法
      return !!r.present;
    } catch (e) {
      // 超时（设备无响应）也算"可疑"，由上层结合复核结果判断
      return null;
    }
  }

  /** 带超时的请求：避免设备无响应时 promise 永不落地，看门狗被永久挂起 */
  _requestWithTimeout(msg, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('设备无响应（超时 ' + ms + 'ms）'));
      }, ms);
      this._request(msg)
        .then((r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } })
        .catch((e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  }

  resume() {
    if (this.state === 'paused') {
      const start = this._startFrameOf(this.trackNumber);
      const end = this._endFrameOf(this.trackNumber);
      // 暂停点以 _pausedSec 为准（由渲染端写入）；_pausedSec 为空才退到墙钟
      const sec = Math.max(0, this._pausedSec != null ? this._pausedSec : this.playedSec());
      // 预读缓冲在暂停时已被丢弃：必须从暂停点重新起读，
      // 否则会重复播一段已听过的内容（听感位置比界面数字靠后）
      this.generation++;
      if (start !== null) {
        this.cursorFrame = Math.min(Math.max(start + Math.round(sec * 75), start),
          end != null ? end : this.trackEndFrame);
      }
      this._pausedSec = null;
      this.buffered = 0;
      this.consecutiveErrors = 0;
      this._zeroChunks = 0;
      this._garbageChunks = 0;
      this._decodeMode = 'be16';
      this._setClock(sec);
      this._touch();
      this.state = 'playing';
      this.pump();
      return;
    }
    if (this.state === 'stopped' && this.trackNumber) {
      // 播完/停止后续播：从当前光标重新起播当前轨
      this._setClock(Math.max(0, (this.cursorFrame - (this._startFrameOf(this.trackNumber) || 0)) / 75));
      this._touch();
      this.state = 'playing';
      this.pump();
    }
  }

  /** 轨内秒数定位（对外首选接口，避免调用方自行换算帧号） */
  seekToSeconds(sec) {
    if (this.state === 'stopped') {
      // 停止态无法静默定位：把光标挪过去，等下次起播时生效
      const f = this._frameOfSec(this.trackNumber, sec);
      if (f !== null) this.cursorFrame = Math.min(Math.max(f, this.trackStartFrame), this.trackEndFrame);
      return;
    }
    this.seekToFrame(this._frameOfSec(this.trackNumber, sec));
  }

  /** TOC 绝对帧定位 */
  seekToFrame(frame) {
    if (this.state === 'stopped') return;
    if (frame === null || frame === undefined) return;
    this.generation++;
    this.cursorFrame = Math.min(
      Math.max(Math.round(frame), this._startFrameOf(this.trackNumber) || 0),
      this._endFrameOf(this.trackNumber) || this.trackEndFrame
    );
    const start = this._startFrameOf(this.trackNumber) || 0;
    this._setClock((this.cursorFrame - start) / 75);
    this.buffered = 0;
    this.consecutiveErrors = 0;
    this._zeroChunks = 0;
    this._garbageChunks = 0;
    this._decodeMode = 'be16';
    this._pausedSec = null;
    this._touch();
    this.pump();
  }

  getPositionFrame() {
    return this.cursorFrame;
  }

  async stop() {
    this._setClock(0);
    this.state = 'stopped';
    this.buffered = 0;
    this._zeroChunks = 0;
    this._garbageChunks = 0;
    this._decodeMode = 'be16';
    // 不要在这里手动清 pumping：正在跑的 pump 会在下一轮判断里自行退出并复位，
    // 提前清掉反而可能让下一次 pump() 与它并存（两份读取 → 声音重叠）
    this.generation++;
    this._pausedSec = null;
    // 停止后回到轨首，便于下一次起播
    this.cursorFrame = this._startFrameOf(this.trackNumber) || 0;
  }

  async close() {
    this.closed = true;
    this.state = 'stopped';
    this.pumping = false;
    if (this.worker) {
      try { this._request({ type: 'close' }); } catch (e) { /* 忽略 */ }
      try { await this.worker.terminate(); } catch (e) { /* 忽略 */ }
      this.worker = null;
    }
  }

  /**
   * 读取循环。
   * ★ 代次（generation）只在"丢弃过期的在途数据"时使用，不再用来终止本循环：
   *   旧实现把 `this.generation === gen` 写进 while 条件，一旦切轨/定位/暂停时推进了代次，
   *   正在跑的 pump 会退出，但 finally 里又因为代次不匹配而**不复位 pumping**，
   *   于是下一次 pump() 被 `if (this.pumping) return` 挡在门外 —— 切歌后再也读不出声音。
   *   现在循环只看"是否仍在播放"，代次变化只是让刚读回来的那块作废并从新位置继续。
   */
  async pump() {
    if (this.pumping || this.state !== 'playing' || this.closed) return;
    this.pumping = true;
    try {
      while (this.state === 'playing' && !this.closed) {
        if (this.cursorFrame >= this.trackEndFrame) {
          // 轨道读完（渲染端会在音频真正播完后触发切歌）
          break;
        }
        // 背压：以"已读超前量"为准（旧实现的块计数只增不减，20 块后永久卡死）
        if (this._aheadSec() >= MAX_BUFFER_SECONDS) {
          this._touch();            // 主动等待，不算停滞
          await sleep(60);
          continue;
        }
        const lba = this._lbaOf(this.cursorFrame);
        // 每轮重新取当前代次：读取期间被切轨/定位的话，回来的这块要作废
        const gen = this.generation;
        let samples;
        let decode = this._decodeMode;
        try {
          const chunk = await this._readChunk(lba, CHUNK_SECTORS);
          samples = chunk.samples;
          decode = chunk.decode;
          this.consecutiveErrors = 0;
        } catch (e) {
          this.consecutiveErrors++;
          this.totalReadErrors++;
          if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            // 连续读取失败：交给服务层判定是"光盘被弹出"还是"光盘划伤"。
            // 旧实现在这里填充静音继续推进 —— 弹出光盘时进度条照走、轨末判定照触发，
            // 于是变成"音频卡死 + 无限重播下一轨"。
            if (this.onError) this.onError('__read_stalled__');
            return;
          }
          // 跳过损坏区域（填充静音），保持播放连续性
          samples = Buffer.alloc(CHUNK_SECTORS * 2352);
          decode = 'silence';
          if (this.totalReadErrors === 1) {
            // 由服务层转成一次性提示
            if (this.onError) this.onError('__skip_notice__');
          }
        }
        // 异步读取期间可能已经切轨 / 定位 / 暂停：作废这块，按最新状态继续。
        // ★ 过期块连 _decodeMode 都不许更新（v10.3）：旧实现在 _onMessage 里
        //   全局刷新形态，切歌瞬间旧轨的 'garbage' 块会污染新轨的看门狗口径。
        if (this.generation !== gen || this.state !== 'playing' || this.closed) continue;
        this._decodeMode = decode;
        /**
         * ★ 全零数据看门狗。
         *   "读取成功"也可能是全零（介质被取走、虚拟光驱、部分 USB 光驱）。
         *   能力测试只覆盖起播前的 2 个扇区；播放中才出现的全零靠这里兜底 —
         *   否则用户听到静音、进度条照走、轨末判定照触发，最后无限重播。
         *   单块全零仍然放行（CD 上极短的数字静音是合法内容），连续多块才触发。
         *
         * ★ 垃圾数据看门狗（v9 引入、v10.2 改判据、v10.3 加窗口）。
         *   v9 用"非零但无 sync 头"判垃圾 —— 对伪造数据有效，但会把
         *   **无同步头的真音频**（实测光驱返回纯 PCM，无 sync 头）误判。
         *   v10.2 起改由 worker 的波形判据（audio-stats.detectPcmForm）
         *   定性：两种字节序都不像音频波形（MASD/RMS 都 ≥0.7）才判垃圾，
         *   连续 GARBAGE_CHUNK_LIMIT 块止损切 MCI。字节序（be16/le16）
         *   与静音（silence）都是合法形态，直接放行。
         *   v10.3：回退权收紧到起播窗口内（WATCHDOG_WINDOW_MS）—— 稳定播放中
         *   的形态误判（切歌高发）不再打断播放，只记日志；引擎决策归读盘仪式。
         */
        const wst = pcmStats(samples);
        const inWindow = Date.now() < this._watchdogUntil;
        if (wst.allZero) {
          this._zeroChunks++;
          this._garbageChunks = 0;
          if (this._zeroChunks >= ZERO_CHUNK_LIMIT) {
            if (inWindow) {
              this.log('raw read: 连续 ' + ZERO_CHUNK_LIMIT +
                ' 块全零数据（起播窗口内，光驱可能不支持数字音频提取）');
              if (this.onError) this.onError('RAW 读取连续返回静音数据（光驱可能不支持数字音频提取）');
            } else {
              // 窗口外：全零是数据事实（不是启发式误判），但不再切换引擎 ——
              // 交给服务层走介质验证（盘真被取走 → 取盘流程；盘还在 → 继续播）。
              this.log('raw read: 连续 ' + ZERO_CHUNK_LIMIT +
                ' 块全零数据（稳定播放期）-> 交服务层验证介质');
              if (this.onError) this.onError('__read_silent__');
            }
            return;
          }
        } else if (this._decodeMode === 'garbage') {
          this._garbageChunks++;
          this._zeroChunks = 0;
          if (this._garbageChunks >= GARBAGE_CHUNK_LIMIT) {
            if (inWindow) {
              this.log('raw read: 连续 ' + GARBAGE_CHUNK_LIMIT +
                ' 块数据两种字节序都不像音频波形（起播窗口内，驱动返回伪造数据，疑似白噪音）→ 交上层切换 MCI');
              if (this.onError) this.onError('RAW 读取返回伪造数据（数据形态非音频，疑似白噪音）');
            } else {
              // 窗口外：形态判据是启发式，稳定播放期误判代价大于收益 ——
              // 只记录一次日志，绝不打断播放、绝不切换引擎（用户实测：切歌时
              // 正常播放被误判白噪音强行回退 MCI，v10.3 起杜绝）。
              if (!this._garbageNoticeSent) {
                this._garbageNoticeSent = true;
                this.log('raw read: 连续 ' + GARBAGE_CHUNK_LIMIT +
                  ' 块数据两种字节序都不像音频波形（稳定播放期，疑似误判）-> 仅记录，不回退');
              }
              this._garbageChunks = 0;
            }
          }
        } else {
          this._zeroChunks = 0;
          this._garbageChunks = 0;
        }
        const absFrame = this.cursorFrame;
        const track = this.trackNumber;
        this.cursorFrame += CHUNK_SECTORS;
        this.buffered++;
        this._touch();
        this.onChunk({ track, absFrame, samples, generation: gen, decode: this._decodeMode });
      }
    } finally {
      this.pumping = false;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { RawPlayer, CHUNK_SECTORS, CHUNK_SECONDS };
