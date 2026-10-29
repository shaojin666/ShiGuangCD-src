'use strict';
/*
 * cd-service.js —— CD 服务编排层。
 * 负责：驱动器探测 → 发现光盘 → 读盘仪式状态机 → 播放引擎（RAW/MCI/Demo）→ 元数据调度。
 *
 * ★ 播放状态模型（本次重构的核心）
 *   phase     : 光盘生命周期 —— idle | insert | reading | reveal | ready | eject | no-drive
 *   playState : 传输状态     —— stopped | playing | paused
 *   currentTrack / positionSec : 权威曲目与轨内位置
 *
 *   旧实现把 playState 混进 phase（stopPlayback 直接把 phase 置为 idle），
 *   造成两个严重后果：
 *     1) 播完/手动停止后，探测循环认为"碟已不在"，立刻重新走一遍读盘仪式并自动续播；
 *     2) 渲染端无法区分"待机（有碟）"与"等待光盘（无碟）"，顶栏/进度条状态错乱。
 *   现在两者彻底分离：停播只改 playState，碟片仍在则 phase 保持 ready。
 *
 *   位置采用「锚点 + 墙钟」：所有状态迁移都会重设锚点，MCI 的轮询结果只做死区校正，
 *   因此无论 MCI 轮询抖动、切轨、定位、切页，对外上报的位置始终单调且连续。
 */

const crypto = require('crypto');
const native = require('../native');
const { RawPlayer } = require('./raw-player');
const { MciPlayer } = require('./mci-player');
const { pcmStats, cddaSyncCount, detectPcmForm } = require('./audio-stats');
const { MetadataStore } = require('../metadata/store');
const { fetchDiscMetadata, fetchLyricsOnly } = require('../metadata/fetch');
const { DEMO_TOC, DEMO_META } = require('../demo');

const PROBE_INTERVAL = 2000;
/**
 * 位置校正死区（秒）：小于该差值不重设锚点，避免进度条抖动。
 *
 * v10.3 从 0.15 收紧到 0.05（仅作用于 MCI 路径的位置对齐链）：
 *   MCI 的位置回报是**设备真实回读值**（不是估计值），而歌词直接消费服务层
 *   锚点。旧值 0.15 会让"起播校验遗留的小偏差永远不被纠正"——MCI 墙钟带着
 *   最多 0.15s 的相位差开跑，经渲染端 0.3s 死区过滤后用户看到的就是
 *   "歌词比音乐快半秒左右"。现在与 MciPlayer 侧的 0.04s 死区串联成两级
 *   细对齐（0.04 → 0.05），误差收敛到 50ms 以内；视觉平滑由渲染端
 *   easeTo()（每步 ≤0.25s）+ 0.3s 死区兜底，不会抖。
 */
const POSITION_DEADBAND = 0.05;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class CdService {
  /**
   * @param {object} opts
   * @param {string} opts.userData     userData 目录
   * @param {boolean} opts.autoPlay    读盘后是否自动播放
   * @param {boolean} opts.demo        是否演示模式
   * @param {boolean} [opts.ejectReturnToScene] 识别到"外部弹出"后是否回退到读盘界面
   * @param {function} opts.send       (channel, payload) => 发送给渲染进程
   * @param {object} [opts.settings]   主进程 settings.data 的**活引用**
   *   （update() 是 Object.assign 原地改，传引用才能读到运行时改动的引擎偏好）
   */
  constructor(opts) {
    this.userData = opts.userData;
    this.store = new MetadataStore(this.userData);
    this.send = opts.send || (() => {});
    this.log = opts.log || (() => {});
    this.autoPlay = opts.autoPlay;
    /** 外部弹出光盘后是否回退到读盘界面（软件内主动出舱不受此项影响） */
    this.ejectReturnToScene = opts.ejectReturnToScene !== false;
    /** 设置活引用：引擎偏好（auto/raw/mci）在设置里改完，下次起播即时生效 */
    this.settings = opts.settings || null;

    this.drive = null;
    this.toc = null;
    this.signature = null;
    this.metadata = null;
    this.engine = null;      // 'raw' | 'mci' | 'demo' | null
    this.player = null;      // RawPlayer | MciPlayer
    this.detectedVia = null; // 本张碟 TOC 识别路径：'raw' | 'mci'
    /** 实际生效的 RAW 读取方法：'ioctl' | 'spti' | null（未测/不可用）。排障用 */
    this.rawReadMethod = null;
    /** 本张碟的 RAW 能力结论：true/false/null（未测）。playTrack 懒起播时据此决策 */
    this.rawCapable = null;
    this.phase = 'idle';

    /* ---- 传输状态（与 phase 分离） ---- */
    this.playState = 'stopped';  // stopped | playing | paused
    this.currentTrack = 1;
    /* 播放顺序：从持久化设置恢复（v10.5 修复"播放顺序不保存"）。
       settings 是主进程 settings.data 的活引用，改设置在运行时即时生效 */
    this.playMode = (this.settings && this.settings.playMode) || 'normal';
    this._anchor = { sec: 0, at: Date.now() };
    this._endGuard = 0;          // 最近一次上报"本轨结束"的时间戳，防止重复上报

    this._probeTimer = null;
    this._reading = false;
    this._skipNoticeSent = false;
    this.demoRequested = !!opts.demo;
    /** 出舱/移除流程去重：探测循环与看门狗可能同时判定 */
    this._removing = false;
    /** 主动介质探测连续报"不在"的次数（抖动时给复核机会，避免误判） */
    this._mediaMiss = 0;
    /** MCI 模式下低频兜底复核的计数 */
    this._mciProbeTick = 0;
    /** 软件内主动出舱进行中（区别于用户在机箱上物理弹出） */
    this._selfEjecting = false;
    /** 正在抓取元数据的光盘签名（并发去重，避免重复请求与重复落盘） */
    this._fetching = null;
    /** 正在后台补抓歌词的光盘签名（缓存命中缺歌词时，v10.4） */
    this._lyricsFilling = null;
  }

  /* ---------- 启动与探测 ---------- */

  _emit(channel, payload) {
    try { this.send(channel, payload); } catch (e) { /* 窗口销毁时忽略 */ }
  }

  /**
   * 界面提示（多语言）：text 始终是简体中文，既作兜底也方便日志排查；
   * key + vars 交给渲染端按当前界面语言取词（见 renderer/js/app.js 的
   * cd:notice 订阅）。主进程不引入 i18n 词典，避免两套翻译各自漂移。
   */
  _notice(key, vars, text) {
    this._emit('cd:notice', { key: key, vars: vars || {}, text: text });
  }

  start() {
    this._emit('cd:phase', { phase: 'idle', reason: 'init' });
    if (this.demoRequested) {
      // 演示模式：等窗口就绪后直接走读盘仪式
      setTimeout(() => this.useDemo(), 1200);
    }
    this._probeLoop();
  }

  _probeLoop() {
    const tick = async () => {
      try { await this._probe(); } catch (e) { /* 探测失败不影响 */ }
    };
    tick();
    this._probeTimer = setInterval(tick, PROBE_INTERVAL);
  }

  /** 碟片是否仍在逻辑上"属于本应用"（决定是否跳过重新读盘） */
  _discActive() {
    if (!this.signature) return false;
    if (this.playState !== 'stopped') return true;
    return this.phase === 'ready' || this.phase === 'reveal' ||
      this.phase === 'insert' || this.phase === 'reading';
  }

  async _probe() {
    // 软件内正在出舱：让路，避免把主动出舱误判成"外部弹出"
    if (this._selfEjecting) return;
    // MCI 播放期间 cdaudio 设备已被我们的播放器（alias cd）占用：
    // 探测里再开 MCI 会冲突（误判"无盘"）甚至阻塞主进程（界面卡死）。
    // 因此常规取盘检测交给 MciPlayer 的状态轮询，这里只做低频兜底复核。
    if (this.engine === 'mci') {
      this._mciProbeTick += 1;
      if (this._mciProbeTick >= 3 && this._discActive()) {   // 约 6 秒一次
        this._mciProbeTick = 0;
        const present = await this._mediaStillThere();
        if (!present) await this._handleDiscRemoved('removed');
      }
      return;
    }

    // ★ 正在播放/暂停时不做全量探测。
    // 旧实现每 2 秒对每个光驱做一次 CreateFile + IOCTL_CDROM_READ_TOC，
    // 与 RAW 读取线程争用同一设备；同步 IOCTL 在无响应时会阻塞主线程数百毫秒~数秒，
    // 直接表现为"点了暂停/切歌要等一两秒才响应"。
    // 播放期间的取盘检测改由读取线程健康度看门狗负责（不占用主线程）。
    if (this._discActive() && this.playState !== 'stopped') {
      await this._watchMedia();
      return;
    }

    let drives = [];
    let nativeError = null;
    try {
      drives = native.listCdDrives();
    } catch (e) {
      nativeError = e.message;
    }
    this.log('probe: drives=' + JSON.stringify(drives) + (nativeError ? ' nativeError=' + nativeError : ''));
    if (nativeError || !drives.length) {
      if (this.demoRequested && this.signature === '__demo__') return;
      if (this.phase !== 'no-drive') {
        this.phase = 'no-drive';
        this._emit('cd:phase', { phase: 'no-drive', reason: nativeError });
        this.log('phase -> no-drive' + (nativeError ? ' (' + nativeError + ')' : ''));
      }
      return;
    }

    for (const letter of drives) {
      let handle = null;
      let toc = null;
      let tocVia = 'raw';
      try {
        handle = native.openCdDevice(letter);
        toc = native.readToc(handle);
      } catch (e) {
        // 底层 IOCTL 不可用（虚拟光驱 / 部分 USB 光驱 / 无介质）→ 尝试 MCI cdaudio 兜底
        try {
          toc = native.readTocViaMci(letter);
          tocVia = 'mci';
          this.log('probe: ' + letter + ': raw TOC 失败（' + e.message + '），MCI 兜底成功');
        } catch (e2) {
          this.log('probe: ' + letter + ': skip (' + e.message + (e2.message ? '；MCI: ' + e2.message : '') + ')');
          toc = null;
        }
      }
      try {
        if (toc && toc.tracks.length) {
          const sig = this._signature(toc);
          const active = this._discActive();
          this.log('probe: ' + letter + ': has disc via ' + tocVia + ', ' + toc.tracks.length + ' tracks, sig=' + sig);
          // 同一张碟且仍在本应用掌控中 → 不做任何事（这是旧实现反复重读的根因）
          if (this.signature === sig && active && this.drive === letter) return;
          native.closeDevice(handle);
          handle = null;
          if (this.signature === sig && this._reading) return;
          // 新光盘（或换碟）→ 开始读盘仪式
          this._beginReading(letter, sig, toc, tocVia);
          return;
        }
        this.log('probe: ' + letter + ': ' + tocVia + ' toc empty');
      } catch (e) {
        this.log('probe: ' + letter + ': skip (' + e.message + ')');
        // 无介质 / 设备未就绪 → 继续探测下一驱动器
      } finally {
        if (handle) { try { native.closeDevice(handle); } catch (e) { /* 忽略 */ } }
      }
    }

    // 所有驱动器都无盘：若此前正在播放/就绪 → 光盘被取出
    if (this._discActive()) {
      await this._handleDiscRemoved('removed');
    }
  }

  /* ---------- 光盘被取出 / 弹出 ---------- */

  /**
   * 播放期间的介质看门狗（RAW 路径）。
   *
   * 两道判定，缺一不可：
   *   1) 健康度：读取线程连续报错或长时间没有推进 → 物理弹出后最常见的表现；
   *   2) 主动探测：向设备显式问一次"盘还在吗"（在 worker 线程里做，不占主线程）。
   *      ★ 这一条是必需的：相当一部分光驱（虚拟光驱、部分 USB 外置光驱）在无介质时
   *        RAW 读取依然返回成功，只是数据全为零，第 1 条永远判定健康，
   *        于是光盘被拿走了软件还在一本正经地"继续播放"。
   */
  async _watchMedia() {
    if (this.engine !== 'raw' || !this.player) return;
    if (typeof this.player.mediaHealthy === 'function' && !this.player.mediaHealthy()) {
      this.log('watch: raw read stalled -> stop and verify medium');
      const wasPlaying = this.playState === 'playing';
      await this.stopPlayback();
      const present = await this._verifyMediaPresent();
      if (!present) {
        await this._handleDiscRemoved('removed', { wasPlaying });
        return;
      }
      this._notice('notice.readBlocked', null, '读取受阻，播放已停止（光盘可能严重划伤）');
      return;
    }
    if (typeof this.player.probeMedia !== 'function') return;
    const st = await this.player.probeMedia();
    if (st === null && !this._checkUnsupportedLogged) {
      this._checkUnsupportedLogged = true;
      this.log('watch: 该光驱不支持介质探测指令，只能依赖读取健康度判定');
    }
    if (st !== false) {
      this._mediaMiss = 0;
      return;
    }
    // 设备明确报告"没有介质"：再读一次 TOC 复核，避免驱动瞬时抖动造成误判
    this._mediaMiss += 1;
    // 首次失败立即复核（反应要快）；之后至少间隔 6 秒才再复核，
    // 否则每 2 秒一次的同步 IOCTL 又会把主线程拖慢
    const now = Date.now();
    if (this._mediaMiss > 1 && now - (this._lastVerifyAt || 0) < 6000) return;
    this._lastVerifyAt = now;
    this.log('watch: media check says absent (miss=' + this._mediaMiss + ') -> verify via TOC');
    const present = await this._verifyMediaPresent();
    if (present) return;              // 复核说盘还在 → 视为抖动
    const wasPlaying = this.playState === 'playing';
    await this.stopPlayback();
    await this._handleDiscRemoved('removed', { wasPlaying });
  }

  /** 真实读一次 TOC 确认介质是否还在（仅在已停播、无读取争用时调用） */
  _verifyMediaPresent() {
    if (!this.drive) return false;
    let handle = null;
    try {
      handle = native.openCdDevice(this.drive);
      const toc = native.readToc(handle);
      return !!(toc && toc.tracks && toc.tracks.length);
    } catch (e) {
      try {
        const toc = native.readTocViaMci(this.drive);
        return !!(toc && toc.tracks && toc.tracks.length);
      } catch (e2) {
        return false;
      }
    } finally {
      if (handle) { try { native.closeDevice(handle); } catch (e) { /* 忽略 */ } }
    }
  }

  /**
   * 复核介质是否还在。
   * MCI 模式下 cdaudio 设备由播放器持有，不能再开一个 MCI 实例去问，
   * 否则会互相抢设备并误报"无盘" —— 直接复用播放器自身的查询接口。
   */
  async _mediaStillThere() {
    if (this.engine === 'mci' && this.player && typeof this.player.isMediaPresent === 'function') {
      return !!this.player.isMediaPresent();
    }
    return this._verifyMediaPresent();
  }

  /**
   * 统一的光盘离场处理。
   * @param {'removed'|'ejected'} reason  removed=外部弹出/取出，ejected=软件内主动出舱
   * @param {{wasPlaying?:boolean}} [opts] 看门狗传入：停播之前是否正在播放（用于提示措辞）
   */
  async _handleDiscRemoved(reason, opts) {
    if (this._removing) return;
    this._removing = true;
    try {
      // 软件内主动出舱进行中：探测循环必须让路，否则会把主动出舱误判成"外部弹出"
      const external = reason !== 'ejected' && !this._selfEjecting;
      const wasActive = this._discActive();
      // 看门狗会先停播再校验介质，此时 playState 已是 stopped，需要它把原始状态带进来
      const wasPlaying = (opts && opts.wasPlaying) || this.playState === 'playing';
      await this.stopPlayback();
      await this.closePlayer();
      this.signature = null;
      this.toc = null;
      this.metadata = null;
      this.phase = 'idle';
      this._emit('cd:phase', {
        phase: 'idle',
        reason: external ? 'removed' : 'ejected',
        external,
        // 渲染端据此决定是否回退到读盘界面（软件内主动出舱不受该开关影响）
        returnToScene: external ? this.ejectReturnToScene : true
      });
      if (external) {
        if (wasPlaying) this._notice('notice.discEjected', null, '检测到光盘已弹出，播放已停止');
        else this._notice('notice.discRemoved', null, '光盘已取出');
      }
      if (!external && !wasActive) this.log('eject handled, no active disc');
    } finally {
      this._removing = false;
    }
  }

  _signature(toc) {
    /*
     * 帧号约定无关化：raw TOC 用绝对帧（首轨 = 150），MCI TOC 用 LBA（首轨 = 0），
     * 同一张碟两种约定只差一个常数偏移。若直接对 startFrame 做哈希，一次瞬时的
     * raw 失败走 MCI 兜底、随后的探测又用 raw 成功，签名就会对不上 ——
     * 服务层会把它当成"换了新碟"，重新走一遍读盘仪式（停播、重动画、重抓元数据）。
     * 因此先减去首轨起始帧再哈希。MCI TOC 的签名值与旧实现完全一致（首轨即 0），
     * 已有元数据缓存不受影响。
     */
    const base = toc.tracks.length ? toc.tracks[0].startFrame : 0;
    const parts = [toc.first, toc.last, toc.leadout - base]
      .concat(toc.tracks.map((t) => t.startFrame - base));
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 20);
  }

  /* ---------- 读盘仪式 ---------- */

  async _beginReading(drive, sig, toc, via) {
    if (this._reading) return;
    this._reading = true;
    this.log('beginReading: drive=' + drive + ' sig=' + sig + ' tracks=' + toc.tracks.length + ' via=' + via);
    try {
      // 换碟场景：先停掉旧播放
      if (this.signature && this.player) {
        await this.stopPlayback();
      }
      this.drive = drive;
      this.signature = sig;
      this.toc = toc;
      this.metadata = null;
      this.engine = null;
      this.player = null;
      this.detectedVia = via || (toc.mciOrigin !== undefined ? 'mci' : 'raw');
      this.rawCapable = null;   // 新碟：能力结论作废，重新判
      this._skipNoticeSent = false;
      this.playState = 'stopped';
      this.currentTrack = 1;
      this._setAnchor(0);

      // 引擎预选：无论 TOC 经哪条路径读到，默认优先尝试 RAW 数字读取。
      // 只有 RAW 能拿到 PCM 采样（音乐律动可视化的数据来源）；MCI 的声音由系统
      // 声卡直接输出，进程内拿不到任何音频数据。RAW 不可用（虚拟光驱 /
      // 不支持数字音频提取的光驱）才回退 MCI。
      // 设置里的引擎偏好可改写这套默认：
      //   'mci' → 跳过能力测试，直接用 MCI（RAW 数据异常时的逃生门）；
      //   'raw' → 跳过能力测试，强制 RAW（能力测试误判时的直通道）。
      const pref = this._enginePreference();
      if (pref === 'mci') {
        this.rawCapable = false;
        this.log('beginReading: 引擎偏好 MCI（设置指定），跳过 RAW 能力测试');
        await this._startMciPlayer();
      } else if (pref === 'raw') {
        this.rawCapable = true;
        this.log('beginReading: 引擎偏好 RAW（设置指定），跳过能力测试，起播时强制 RAW');
      } else {
        const rawOk = await this._testRawRead();
        this.rawCapable = rawOk;
        if (rawOk) {
          this.log('beginReading: RAW 数字读取可用，播放时使用 RAW 引擎（PCM 可用于音乐律动）');
        } else {
          await this._startMciPlayer();
        }
      }

      this.phase = 'reading';
      this._emit('cd:phase', { phase: 'insert', drive });

      await sleep(1000);                    // 光盘滑入动画
      if (!this._reading) return;

      this._emit('cd:phase', { phase: 'reading', stage: 'toc' });
      await sleep(650);                     // 目录读取（真实 TOC 已在探测中完成，此处为仪式节奏）

      // 元数据：先查缓存（含手动编辑过的），命中则完全不联网
      const cached = this.store.get(sig);
      /**
       * ★ 缓存有效性判定要比"有曲目"更严。
       *
       * 旧实现只要求 `cached.tracks.length > 0` 就算命中 —— 但骨架数据也有曲目
       * （"轨道 1..N"），于是**一次失败的抓取会把空壳写进缓存，此后这张碟
       * 永远命中这个空壳、再也不联网**（日志里 `album=-` 就是这种半成品）。
       * 这正是"修好了代码，用户那张碟却仍拿不到封面/歌词"的原因。
       *
       * 现在要求缓存必须有实质内容：有专辑名，或有至少一个真实来源。
       * 手动编辑过的记录（manual）即使只有曲目名也照样有效 —— 那是用户的劳动成果。
       */
      const cachedUsable = !!cached && Array.isArray(cached.tracks) && cached.tracks.length > 0 &&
        (!!cached.album || (cached.sources || []).length > 0 || !!cached.manual);

      if (cachedUsable) {
        this.metadata = cached;
        this._emit('cd:metadata', { metadata: cached, fromCache: true });
        this.log('metadata: cache hit ' + sig + ' album=' + (cached.album || '-'));
        /**
         * ★ 缓存命中但缺歌词 → 后台补抓（v10.4）。
         *
         * 老版本存的缓存、或上次抓取时歌词阶段整体超时的碟，走这条缓存路径
         * 时完全不联网 —— 歌词永远是空的，用户必须手动打开编辑面板点
         * "重新获取"才能拿到。这里在就绪之后后台补抓：不阻塞读盘仪式与
         * 播放，抓完落盘并推一条 cd:metadata（lyricsFilled），
         * 渲染端据此强制刷新歌词视图。
         */
        const needLyrics = (cached.tracks || []).some((t) => !t.lyrics && !t.lyricsData);
        if (needLyrics) {
          this.log('lyrics: cache 命中但缺歌词 → 后台补抓 ' + sig);
          this._fillLyricsBackground(sig, cached, toc);
        }
      } else {
        if (cached) this.log('metadata: cache 无实质内容（album 与 sources 均空）→ 丢弃并重新抓取');
        this._emit('cd:metadata', { metadata: null, fromCache: false });
        this._fetchMetadataBackground(sig, toc);   // 首次读碟自动抓取，后台进行、不阻塞就绪
      }

      this.phase = 'ready';
      this._emit('cd:phase', { phase: 'reveal', hasCover: !!(this.metadata && this.metadata.hasCover) });
      await sleep(1150);                    // 揭晓动画
      if (!this._reading) return;

      this._emit('cd:phase', { phase: 'ready' });
      this._emitState('ready');

      // 读盘后行为
      if (this.autoPlay) {
        this._emit('cd:land', { page: 'nowplaying', autoplay: true });
        this.playTrack(1);
      } else {
        this._emit('cd:land', { page: 'library', autoplay: false });
      }
    } finally {
      this._reading = false;
    }
  }

  /**
   * 首次读碟的**自动**元数据抓取。
   *
   * 行为约定（对应"首次读碟自动保存元数据"的需求）：
   *   1) 本地已有该碟缓存 → 直接使用，不再联网（_beginReading 里已处理）；
   *   2) 没有缓存 → 后台抓取，失败重试一次；抓完立即落盘（json + jpg）；
   *   3) 同一张碟并发去重：读盘仪式与用户点"重新获取"可能同时触发，
   *      用 _fetching 标记挡住第二次，避免重复请求与重复落盘；
   *   4) 全程不阻塞播放：本方法在后台跑，`cd:land` 早已发出。
   *
   * @param {string} sig  光盘签名
   * @param {object} toc
   * @param {object} [opts] { hint:{album,artist}, force:boolean }
   */
  async _fetchMetadataBackground(sig, toc, opts = {}) {
    /**
     * 并发去重：读盘仪式与用户点"重新获取"可能同时触发，挡掉第二次。
     *
     * ★ 但**用户主动发起的（force）不能被挡**。真实场景：首次读碟的自动抓取
     * 还在后台跑（可能因为 MB 慢而耗时数秒），用户等不及，打开编辑面板点了
     * "按关键词搜索" —— 若这里直接 return null，用户会看到"未找到匹配的在线信息"，
     * 明明关键词是对的。所以 force 时让新请求直接顶替旧请求：
     * 旧请求的 finally 会因 `this._fetching !== sig` 而不误清新标记。
     */
    if (this._fetching === sig && !opts.force) {
      this.log('metadata: already fetching ' + sig + ' -> skip');
      return null;
    }
    this._fetching = sig;
    try {
      const hint = opts.hint || {};
      /**
       * ★ 碟号提示：把已知的碟号喂给抓取层，让它在多碟发行里精确定位本碟。
       *
       * 优先级：本次 hint（用户当场指定）> 缓存里记过的碟号（用户以前编辑过）。
       * 这一步很重要 —— 重抓同一张碟时若丢掉碟号，又可能退回到"取第一张碟"
       * 的老毛病，把 disc1/disc2 搞反。
       */
      const cachedMeta = this.store.get(sig) || {};
      const cachedDiscNumber = cachedMeta.discNumber;
      const cachedDiscTotal = cachedMeta.discTotal;
      let meta = null;
      for (let attempt = 0; attempt < 2 && !meta; attempt++) {
        try {
          meta = await fetchDiscMetadata(toc, {
            hint,
            cachedDiscNumber,
            cachedDiscTotal,
            // 歌词降级链诊断日志：命中源/逐字与否/行数/质量分写进 debug.log，
            // 用户据此判断"为什么这首还是 LRC"（见 README §3.7）
            log: (m) => this.log(m),
            onStage: (stage) => this._emit('cd:metadata-progress', { stage }),
            onLyrics: (done, total) => this._emit('cd:metadata-progress', { stage: 'lyrics', done, total })
          });
        } catch (e) {
          this.log('metadata fetch attempt ' + (attempt + 1) + ' failed: ' + e.message);
          if (attempt === 0) await sleep(800);
        }
      }
      // 骨架（没拿到任何专辑名）等同失败：不要拿它覆盖用户已有的信息
      if (!meta || (!meta.album && !(meta.sources || []).length)) {
        this._notice('notice.onlineFailed', null, '在线信息获取失败（已保留基础曲目信息）');
        return null;
      }

      // 换碟竞态：抓取期间用户已经换了碟/弹出 → 结果作废，不要写错碟的缓存
      if (this.signature !== sig) {
        this.log('metadata: signature changed during fetch (' + sig + ' -> ' + this.signature + ') -> discard');
        return null;
      }

      meta.signature = sig;
      meta.fetchedAt = new Date().toISOString();
      if (meta.coverBuffer) {
        try { this.store.saveCover(sig, meta.coverBuffer); meta.hasCover = true; } catch (e) { meta.hasCover = false; }
        delete meta.coverBuffer;
      }
      try { this.store.save(meta); } catch (e) { /* 缓存失败不影响播放 */ }
      this.metadata = meta;
      this._emit('cd:metadata', { metadata: meta, fromCache: false });
      this.log('metadata: fetched via ' + (meta.sources || []).join(',') +
        ' tracks=' + (meta.tracks || []).length +
        ' album=' + (meta.album || '-') + ' cover=' + !!meta.hasCover);
      return meta;
    } catch (e) {
      this._notice('notice.onlineFailedErr', { err: e.message }, '在线信息获取失败：' + e.message);
      return null;
    } finally {
      if (this._fetching === sig) this._fetching = null;
    }
  }

  /**
   * 缓存命中但缺歌词的碟：后台补抓歌词（v10.4）。
   *
   * 与 _fetchMetadataBackground 的分工：
   *   - 那个负责"整张碟从零抓"（首次读碟、用户点重新获取）；
   *   - 这个只补"缺歌词的轨"，专辑名 / 封面 / 曲目名一律不动 ——
   *     缓存已经给了这些，再整体重抓有把用户手动改过的内容覆盖掉的风险。
   *
   * 约定：
   *   1) 并发去重（_lyricsFilling），同一张碟不会同时补抓两轮；
   *   2) 换碟竞态：抓取期间 signature 变了 → 结果作废；
   *   3) 只把歌词字段补进"本来没有歌词"的轨，已有歌词（含用户手写的）不覆盖；
   *   4) 全程不阻塞播放：由读盘仪式 fire-and-forget 调用；
   *   5) 抓完落盘 + 推 cd:metadata{lyricsFilled:true}，渲染端强制刷新歌词视图
   *      （same-key 保护会挡住"不 fresh 的 setLyrics"，见 app.js onMetadata）。
   *
   * @param {string} sig
   * @param {object} meta  缓存元数据（_beginReading 里已 store.get 到的那份）
   * @param {object} toc   本碟 TOC
   */
  async _fillLyricsBackground(sig, meta, toc) {
    if (this._lyricsFilling === sig) {
      this.log('lyrics: already filling ' + sig + ' -> skip');
      return null;
    }
    this._lyricsFilling = sig;
    try {
      const r = await fetchLyricsOnly(meta, (toc && toc.tracks) || [], {
        log: (m) => this.log(m),
        onProgress: (done, total) =>
          this._emit('cd:metadata-progress', { stage: 'lyrics', done, total })
      });
      if (!r || !r.filled) {
        this.log('lyrics: 补抓无所获 ' + sig);
        return null;
      }
      // 换碟竞态：抓取期间用户已经换了碟 / 弹出 → 不写错碟的缓存
      if (this.signature !== sig) {
        this.log('lyrics: signature changed during fill (' + sig + ' -> ' + this.signature + ') -> discard');
        return null;
      }
      const byNum = new Map();
      for (const t of (r.tracks || [])) byNum.set(Number(t.number), t);
      let merged = 0;
      const tracks = ((meta && meta.tracks) || []).map((tr) => {
        const fresh = byNum.get(Number(tr.number));
        // 只补空缺：已有 lyrics / lyricsData 的轨（含用户手写、TTML）原样带回
        if (!fresh || tr.lyrics || tr.lyricsData) return tr;
        if (!fresh.lyrics && !fresh.lyricsData) return tr;
        merged++;
        return Object.assign({}, tr, {
          lyrics: fresh.lyrics || null,
          lyricsSynced: !!fresh.lyricsSynced,
          lyricsTranslation: fresh.lyricsTranslation || null,
          lyricsData: fresh.lyricsData || null,
          lyricsSources: fresh.lyricsSources || null,
          lyricsSource: fresh.lyricsSource || null,
          neteaseSongId: fresh.neteaseSongId || tr.neteaseSongId || null
        });
      });
      if (!merged) return null;
      const next = Object.assign({}, meta, {
        tracks,
        lyricsFilledAt: new Date().toISOString()
      });
      try { this.store.save(next); } catch (e) { /* 落盘失败也照样推给界面 */ }
      this.metadata = next;
      this._emit('cd:metadata', { metadata: next, fromCache: false, lyricsFilled: true });
      this.log('lyrics: cache 补抓完成 ' + sig + ' filled=' + merged);
      return next;
    } catch (e) {
      this.log('lyrics: 补抓失败 ' + (e && e.message ? e.message : e));
      return null;
    } finally {
      if (this._lyricsFilling === sig) this._lyricsFilling = null;
    }
  }

  /**
   * 手动重新获取在线元数据（编辑面板的"重新获取"按钮，或按关键词人工匹配）。
   *
   * 与自动抓取的区别：
   *   - 强制忽略本地缓存重新联网；
   *   - 可传入 hint（专辑名/歌手），用于冷门碟、翻录碟、MB 无收录的碟；
   *   - 若该碟已被手动编辑过（manual），只补空缺字段，不覆盖人工内容。
   *
   * @param {object} [opts] { hint:{album,artist} }
   */
  async refetchMetadata(opts = {}) {
    if (!this.toc || !this.signature || this.signature === '__demo__') {
      return { ok: false, reason: 'no-disc' };
    }
    const sig = this.signature;
    const manual = (this.metadata && this.metadata.manual) || null;
    const meta = await this._fetchMetadataBackground(sig, this.toc, {
      hint: opts.hint || {},
      force: true
    });
    if (!meta) return { ok: false, reason: 'fetch-failed' };
    // 拿到骨架但没有专辑名 → 对用户而言仍是"没找到"
    if (!meta.album) return { ok: false, reason: 'no-match', metadata: meta };

    // 人工编辑过的内容优先：把 manual 覆盖回去，逐轨歌词/标题等也不被清掉
    if (manual) {
      meta.manual = manual;
      this._applyManualOverrides(meta, manual);
      try { this.store.save(meta); } catch (e) { /* 忽略 */ }
      this.metadata = meta;
      this._emit('cd:metadata', { metadata: meta, fromCache: false, refreshed: true });
    }
    if (meta.album) this._notice('notice.onlineGot', { album: meta.album }, '已获取在线信息：' + meta.album);
    else this._notice('notice.onlineNone', null, '未找到匹配的在线信息');
    return { ok: true, metadata: meta };
  }

  /**
   * 把用户手动填过的字段盖回新抓取结果上。
   * manual 的形状沿用编辑面板：{ album?, artist?, year?, discNumber?, discTotal?, tracks?[], cover? }
   */
  _applyManualOverrides(meta, manual) {
    if (!manual || typeof manual !== 'object') return meta;
    /**
     * ★ 碟号也在"人工优先"之列。
     * 用户手动改过的碟号是最权威的（TOC 本身没有碟号，只能靠人判断），
     * 重抓时绝不能被在线源的结果覆盖掉，否则用户白改。
     */
    for (const k of ['album', 'artist', 'albumIntro', 'artistIntro', 'year', 'discNumber', 'discTotal']) {
      if (manual[k] != null && manual[k] !== '') meta[k] = manual[k];
    }
    if (manual.tracks && typeof manual.tracks === 'object') {
      const byNum = new Map();
      const list = Array.isArray(manual.tracks) ? manual.tracks : Object.values(manual.tracks);
      for (const t of list) {
        if (t && t.number != null) byNum.set(Number(t.number), t);
      }
      for (const tr of meta.tracks || []) {
        const m = byNum.get(tr.number);
        if (!m) continue;
        if (m.title) tr.title = m.title;
        if (m.artist != null) tr.artist = m.artist;
        if (m.lyrics) {
          tr.lyrics = m.lyrics;
          tr.lyricsSynced = !!m.lyricsSynced;
          tr.lyricsSource = m.lyricsSource || 'manual';
          /**
           * ★ 歌词模型与候选源列表也要盖回去。
           * 用户可能在编辑面板挑过别的平台的歌词（lyrics:select-source）、
           * 或粘过 TTML（lyrics:add-ttml）——这些选择必须和手改文本一样
           * 不被在线刷新冲掉。快照里没有模型（用户只改了文本）时清掉
           * 新鲜的模型，否则旧模型会盖住用户刚改的 LRC。
           */
          tr.lyricsData = m.lyricsData || null;
          tr.lyricsSources = Array.isArray(m.lyricsSources) && m.lyricsSources.length
            ? m.lyricsSources
            : null;
        }
      }
    }
    return meta;
  }

  /* ---------- 权威传输状态 ---------- */

  trackDurationSec(trackNumber) {
    const t = this.toc && this.toc.tracks ? this.toc.tracks.find((x) => x.number === trackNumber) : null;
    if (!t) return 0;
    if (t.durationSec != null && t.durationSec > 0) return t.durationSec;
    return Math.max(0, (t.endFrame - t.startFrame) / 75);
  }

  trackCount() {
    return this.toc ? this.toc.tracks.filter((t) => t.audio).length : 0;
  }

  _setAnchor(sec) {
    this._anchor = { sec: Math.max(0, Number(sec) || 0), at: Date.now() };
  }

  /** 权威轨内位置（秒） */
  _positionSec() {
    let sec = this._anchor.sec;
    if (this.playState === 'playing') sec += (Date.now() - this._anchor.at) / 1000;
    const dur = this.trackDurationSec(this.currentTrack);
    if (dur > 0) sec = Math.min(sec, dur);
    return Math.max(0, sec);
  }

  /** 用权威值校正锚点（带死区） */
  _correctAnchor(sec) {
    const dur = this.trackDurationSec(this.currentTrack);
    let target = Math.max(0, Number(sec) || 0);
    if (dur > 0) target = Math.min(target, dur);
    if (Math.abs(target - this._positionSec()) <= POSITION_DEADBAND) return false;
    this._setAnchor(target);
    return true;
  }

  /** 对外广播完整传输快照——渲染端所有播放控件都以它为唯一真相 */
  _emitState(reason) {
    this._emit('cd:state', {
      state: this.playState,
      track: this.currentTrack,
      positionSec: this._positionSec(),
      durationSec: this.trackDurationSec(this.currentTrack),
      trackCount: this.trackCount(),
      engine: this.engine,
      mode: this.playMode,
      reason: reason || ''
    });
  }

  /* ---------- 播放控制 ---------- */

  setPlayMode(mode) {
    const allowed = ['normal', 'repeat-one', 'repeat-all', 'shuffle'];
    this.playMode = allowed.indexOf(mode) >= 0 ? mode : 'normal';
    return this.playMode;
  }

  /**
   * 起播指定轨道
   * @param {number} trackNumber
   * @param {number} [fromSec] 轨内起始秒数（续播/定位后继续播）
   */
  async playTrack(trackNumber, fromSec) {
    if (!this.toc) return;
    const n = Number(trackNumber) || 1;
    const t = this.toc.tracks.find((x) => x.number === n);
    if (!t || !t.audio) return;

    const dur = this.trackDurationSec(n);
    let sec = Math.max(0, Number(fromSec) || 0);
    if (dur > 0) sec = Math.min(sec, Math.max(0, dur - 0.05));

    this.currentTrack = n;
    this._setAnchor(sec);

    if (this.engine === 'demo') {
      this.playState = 'playing';
      this._emit('cd:demo-play', { track: n, seconds: sec });
      this._emitState('play');
      return;
    }

    if (!this.player) {
      // 懒起播（RAW 能力测试通过时，仪式不预建播放器）。
      // 引擎偏好在此二次生效：'mci' 不试 RAW；'raw' 强制 RAW；
      // 'auto' 沿用仪式结论（rawCapable===false 说明测过不可用）。
      const pref = this._enginePreference();
      let rawOk = false;
      let rawForced = false;
      if (pref === 'mci') {
        this.log('playTrack: 引擎偏好 MCI，跳过 RAW');
      } else if (pref === 'raw') {
        // 手动固定 RAW：起播失败也**不回落 MCI**（强制语义，v10.3）——
        // 宁可明确没声音 + 提示，也不违背用户"读盘后不做任何主动切换"的设定。
        rawForced = true;
        rawOk = await this._startRawPlayer();
      } else if (this.rawCapable !== false) {
        rawOk = await this._startRawPlayer();
      }
      if (!rawOk && !rawForced) {
        const mciOk = await this._startMciPlayer();
        if (!mciOk) {
          this.playState = 'stopped';
          this._emitState('play-failed');
          this._notice('notice.noDigitalAudio', null, '无法读取光盘音频：光驱不支持数字读取或已被占用');
          return;
        }
      } else if (!rawOk && rawForced) {
        this.playState = 'stopped';
        this._emitState('play-failed');
        this._notice('notice.rawStartFailed', null, 'RAW 起播失败（已固定 RAW 引擎，不会自动切换 MCI）');
        return;
      }
    }

    try {
      /**
       * ★ 先置位播放态，再让播放器起泵。
       *   onChunk 的守卫是"playState !== 'playing' 即丢弃"（防暂停后管道残留）。
       *   旧实现把置位放在 await 之后，靠"worker 消息必晚于微任务"的隐式时序
       *   保证首块不被丢 —— 时序依赖太隐蔽：读取路径一变快（或换成同步桩），
       *   轨首第一秒就凭空消失。结构性保证：先置位，后起泵。
       */
      this.playState = 'playing';
      if (this.engine === 'raw') await this.player.playTrack(n, sec);
      else if (this.engine === 'mci') await this.player.playTrack(n, sec);
      this._setAnchor(sec);
      this._emitState('play');
    } catch (e) {
      this.playState = 'stopped';
      this._emitState('play-error');
      this._notice('notice.playFailed', { err: e.message }, '播放失败：' + e.message);
    }
  }

  async _testRawRead() {
    // 试读第一个音频轨的数据，判断光驱是否支持 RAW 数字读取。
    // 优先选音频轨：CD-Extra 等混合盘首轨可能是数据轨，数据轨未必能以 CDDA 模式读取，
    // 拿数据轨做能力测试会把支持 RAW 的光驱误判成不支持。
    let handle = null;
    try {
      const t = this.toc.tracks.find((x) => x.audio) || this.toc.tracks[0];
      if (!t) return false;
      // MCI TOC 的 startFrame 已是 LBA；raw TOC 是绝对帧号（track1=150）
      const lba = this.toc.mciOrigin !== undefined ? t.startFrame : Math.max(0, t.startFrame - 150);
      handle = native.openCdDevice(this.drive);
      /**
       * ★ 采样窗口必须能跳过"数字静音前奏"（2026-10 用户光驱实测修复）。
       *   旧实现只读轨首 2 个扇区判全零 → 回退 MCI。但 CD-DA 的静音本身就是
       *   全零数据，与驱动"假成功"的表现一模一样：实测那张碟轨首 2 帧是
       *   静音（全零），同一位置读 75 扇区却拿到真音频 —— 只读 2 帧等于
       *   把完全能用的光驱误判成"不支持数字提取"，用户侧就是"歌词一切
       *   正常，播放却回退 MCI"。
       *   现在按 75 扇区（1 秒，与播放块同大小）窗口从轨首向后找，
       *   最多 8 个窗口；与播放看门狗 ZERO_CHUNK_LIMIT=8 对齐：
       *   能力测试判不了的静音长度，播放中本来也会切 MCI，口径一致。
       */
      const PROBE_SECTORS = 75;
      const PROBE_WINDOWS = 8;
      const trackEnd = this.toc.leadout != null ? this.toc.leadout : lba + PROBE_SECTORS * PROBE_WINDOWS;
      let st = null;
      let probeLba = lba;
      let probedBytes = 0;
      let probeSync = 0;        // 命中窗口的 sync 合规扇区数（诊断用）
      let probeForm = 'be16';   // 命中窗口的数据形态（detectPcmForm）
      let sawNonZero = false;   // 见过非零（区分"全零"与"垃圾"两种失败形态）
      let garbageWindows = 0;   // 两种字节序都不像音频波形的窗口数
      for (let w = 0; w < PROBE_WINDOWS; w++) {
        const pos = lba + w * PROBE_SECTORS;
        if (pos + 2 >= trackEnd) break; // 别读出轨（末轨附近）
        const chunk = native.rawRead(handle, pos, PROBE_SECTORS);
        const s = pcmStats(chunk, true); // 能力测试拿到的是未经 swapEndian 的大端数据
        probedBytes += s.bytes;
        /**
         * ★ 数据形态判别（v10.2，用户 F 盘实体光驱实测定论）。
         *   "非零"不等于"是音频"，但反过来"没有 sync 头"也不等于垃圾 ——
         *   实测该光驱返回的是**无同步头的小端 16bit PCM**（USB 桥接固件
         *   行为），v9 的 sync 铁证会把它误判成伪造数据。
         *   现在统一交给 audio-stats.detectPcmForm：
         *     be16/le16 → 真音频（标准大端 / 小端直通），判可用；
         *     silence   → 静音前奏，继续向后找；
         *     garbage   → 两种字节序都不像音频波形（伪造数据），继续向后找。
         *   8 个窗口全是垃圾 → 判不可用回退 MCI（比放白噪音好得多）。
         */
        const form = detectPcmForm(chunk);
        if (form === 'be16' || form === 'le16') {
          st = s; probeForm = form; probeSync = cddaSyncCount(chunk); probeLba = pos; break;
        }
        if (form === 'garbage') {
          sawNonZero = true;
          garbageWindows++;   // 伪造数据，继续向后找
        }
      }
      if (!st) {
        if (sawNonZero) {
          this.log('raw capability test: ' + garbageWindows +
            ' 个窗口返回非零但两种字节序都不像音频波形（' + probedBytes +
            ' bytes，驱动伪造数据/非音频流）-> use MCI');
        } else {
          this.log('raw capability test: 轨首 ' + PROBE_WINDOWS + ' 秒窗口全部返回全零数据（' +
            probedBytes + ' bytes，不支持数字音频提取）-> use MCI');
        }
        return false;
      }
      // 记录实际生效的读取方法：'ioctl' | 'spti'（IOCTL_RAW_READ 失败后
      // 自动回退 SPTI READ CD）。物理光驱排障时这一行是关键证据。
      const method = native.rawReadMethod ? native.rawReadMethod(handle) : 'ioctl';
      this.rawReadMethod = method || 'ioctl';
      const skipNote = probeLba > lba ? '，跳过 ' + (probeLba - lba) + ' 帧静音前奏' : '';
      const modeNote = probeForm === 'le16'
        ? '，小端 16bit PCM（该光驱返回 little-endian 数据，已启用直通解码：不做字节交换）'
        : '，sync=' + probeSync + '/' + (st.bytes / 2352);
      if (method === 'spti') {
        this.log('raw capability test ok (track ' + t.number + ', ' + st.bytes +
          ' bytes, peak=' + st.peak + ', nonZero=' + (st.nonZeroRatio * 100).toFixed(1) +
          '%) [IOCTL_RAW_READ 不可用，已回退 SPTI READ CD]' + skipNote + modeNote);
      } else {
        this.log('raw capability test ok (track ' + t.number + ', ' + st.bytes +
          ' bytes, peak=' + st.peak + ', nonZero=' + (st.nonZeroRatio * 100).toFixed(1) +
          '%)' + skipNote + modeNote);
      }
      return true;
    } catch (e) {
      // ERAWREAD 带完整诊断（两条路径的 win32 错误码 + SCSI sense），原样透出，
      // 物理光驱"说能用却没声/回退 MCI"的排障全靠这一行。
      const extra = e.diag ? ' [' + JSON.stringify(e.diag) + ']' : '';
      this.log('raw capability test failed: ' + e.message + extra + ' -> use MCI');
      return false;
    } finally {
      if (handle) { try { native.closeDevice(handle); } catch (e) { /* 忽略 */ } }
    }
  }

  _lbaOffset() {
    // MCI 兜底读到的 TOC 首轨是 LBA 0；raw TOC 是绝对帧 150
    return this.toc && this.toc.mciOrigin !== undefined ? 0 : 150;
  }

  /**
   * 引擎偏好（设置项，活读取）：
   *   'auto' —— 自动探测（默认）：RAW 能力测试过了就用 RAW，否则 MCI
   *   'raw'  —— 强制 RAW 数字读取（起播失败仍会回退 MCI，别让用户没声音）
   *   'mci'  —— 强制 MCI 系统播放（RAW 数据异常/白噪音时的逃生门）
   */
  _enginePreference() {
    const v = this.settings && this.settings.enginePreference;
    return (v === 'raw' || v === 'mci') ? v : 'auto';
  }

  async _startRawPlayer() {
    if (this.engine === 'raw') return true;
    let firstChunkLogged = false;
    try {
      const player = new RawPlayer({
        drive: this.drive,
        toc: this.toc,
        lbaOffset: this._lbaOffset(),
        log: (m) => this.log(m),
        // 暂停/停止后不再推送：IPC 管道里残留的数据块到达渲染端仍会被调度播出，
        // 表现为"点了暂停还响一会儿"。起播路径不受影响（playState 先于首个数据块置位）。
        onChunk: (chunk) => {
          if (this.playState !== 'playing') return;
          /**
           * 首块数据诊断日志：用户报"进入 RAW 模式但没声音"时，这一行直接
           * 区分三种根因 —— 数据有没有流出主进程、内容是不是全零、帧号对不对。
           * 只记第一块，避免每秒一条刷爆日志。
           */
          if (!firstChunkLogged) {
            firstChunkLogged = true;
            const st = pcmStats(chunk.samples);
            const sync = cddaSyncCount(chunk.samples);
            // 数据形态说明（worker 逐块判别，v10.2）：
            //   le16    —— 小端 PCM 直通解码（USB 桥接光驱固件行为，真音频）
            //   garbage —— 两种字节序都不像音频波形 → 看门狗即将止损
            //   be16/silence —— 标准形态，无需额外说明
            const formNote = chunk.decode === 'le16'
              ? '（小端 16bit PCM：该光驱返回 little-endian 数据，已直通解码，无需字节交换）'
              : chunk.decode === 'garbage'
                ? '（非音频波形！驱动返回伪造数据，将回退 MCI）'
                : '';
            this.log('raw chunk #1: track=' + chunk.track + ' absFrame=' + chunk.absFrame +
              ' bytes=' + st.bytes + ' peak=' + st.peak +
              ' nonZero=' + (st.nonZeroRatio * 100).toFixed(1) + '%' +
              ' sync=' + sync + '/' + (st.bytes / 2352) +
              (st.allZero ? '（全零！该光驱不支持数字音频提取，将回退 MCI）' : '') +
              formNote);
          }
          this.send('cd:audio', chunk);
        },
        onError: (msg) => this._onReadError(msg)
      });
      await player.start();
      this.player = player;
      this.engine = 'raw';
      this._emit('cd:engine', { engine: 'raw', volumeSupported: true });
      this.log('engine -> raw (digital read ok)');
      return true;
    } catch (e) {
      this.log('raw player start failed: ' + e.message + ' -> will try MCI fallback');
      return false;
    }
  }

  /**
   * 运行时切换播放引擎（设置页「播放引擎」手动切换，RAW 数据异常时的逃生门）。
   * 记住当前曲目与听感位置 → 停旧引擎 → 起新引擎 → 从同一点续播。
   * 切 RAW 前会先跑能力测试：白噪音/读不出数据的光驱不该被硬切进 RAW。
   *
   * ★ v10.3 两处稳健性修复：
   *   1) 能力测试提前到"停旧引擎"之前 —— 旧实现先 close 再测，测试不过时
   *      旧引擎已经停了，用户落到"没声音 + 提示已留在原引擎"的自相矛盾状态；
   *   2) 新引擎起播失败时回滚原引擎 —— 宁可切回去，也不留用户在无声状态。
   * @param {'raw'|'mci'} engine
   * @returns {Promise<{ok:boolean, engine?:string, error?:string}>}
   */
  async switchEngine(engine) {
    if (engine !== 'raw' && engine !== 'mci') return { ok: false, error: 'bad-engine' };
    if (this.engine === 'demo') return { ok: false, error: 'demo-mode' };
    if (!this.toc) return { ok: false, error: 'no-disc' };
    if (this.engine === engine && this.player) return { ok: true, engine };

    const prevEngine = this.engine;
    const track = this.currentTrack || 1;
    const sec = this._positionSec();
    const wasPlaying = this.playState === 'playing';
    this.log('switchEngine: ' + (this.engine || 'null') + ' -> ' + engine +
      '（track=' + track + ' sec=' + sec.toFixed(2) + ' playing=' + wasPlaying + '）');

    // 先测能力（不停旧引擎）：测不过就原样返回，播放不中断
    if (engine === 'raw') {
      const capable = await this._testRawRead();
      this.rawCapable = capable;
      if (!capable) {
        this.log('switchEngine: RAW 能力测试不过，放弃切换（原引擎保持不动）');
        this._notice('notice.rawSwitchFailed', null, '无法切换到 RAW：该光驱不支持数字读取（或数据异常）');
        return { ok: false, error: 'raw-incapable' };
      }
    }

    // 停旧引擎（先停再起，避免两套声音叠加）
    try { if (this.player) await this.player.close(); } catch (e) { /* 忽略 */ }
    this.player = null;
    this.engine = null;

    // 起新引擎
    let ok = false;
    if (engine === 'raw') {
      ok = await this._startRawPlayer();
    } else {
      ok = await this._startMciPlayer();
    }
    if (!ok) {
      // 起播失败 → 回滚原引擎，别让用户没声音
      let rolled = false;
      if (prevEngine === 'raw') rolled = await this._startRawPlayer();
      else if (prevEngine === 'mci') rolled = await this._startMciPlayer();
      if (rolled && wasPlaying) {
        try { await this.playTrack(track, sec); } catch (e) { /* playTrack 内部已上报 */ }
      }
      if (rolled) {
        this._notice('notice.switchFailedRolled', { engine: engine.toUpperCase() },
          '切换到 ' + engine.toUpperCase() + ' 引擎失败：光驱不支持或已被占用（已回退原引擎）');
      } else {
        this._notice('notice.switchFailed', { engine: engine.toUpperCase() },
          '切换到 ' + engine.toUpperCase() + ' 引擎失败：光驱不支持或已被占用');
      }
      return { ok: false, error: 'start-failed', engine: this.engine };
    }

    // 原本在播就从同一点续播；原本没播就保持停止态
    if (wasPlaying) {
      try { await this.playTrack(track, sec); } catch (e) { /* playTrack 内部已上报 */ }
    }
    this._emitState(wasPlaying ? 'play' : 'ready');
    return { ok: true, engine: this.engine };
  }

  async _startMciPlayer() {
    if (this.engine === 'mci') return true;
    try {
      const player = new MciPlayer({
        drive: this.drive,
        toc: this.toc,
        log: (m) => this.log(m),
        // 权威位置回报（带死区校正，不直接驱动进度条）
        onPosition: (p) => {
          if (this.engine !== 'mci' || this.player !== player) return;
          if (typeof p.sec === 'number' && p.track === this.currentTrack) {
            this._correctAnchor(p.sec);
          }
          // 广播的是校正后的服务层锚点：它与 p.sec 的差已被压缩到死区以内，
          // 渲染端再叠一层 easeTo() 平滑，进度条就不会抖。
          this.send('cd:position', {
            track: p.track,
            sec: this._positionSec(),
            state: this.playState
          });
        },
        onRemoved: () => this._onMciDiscRemoved(),
        onTrackEnd: (track) => this._onTrackEnd(track)
      });
      const ok = await player.open();
      if (!ok) {
        this.log('mci player open failed');
        return false;
      }
      this.player = player;
      this.engine = 'mci';
      this._emit('cd:engine', { engine: 'mci', volumeSupported: false });
      this.log('engine -> mci (fallback)');
      return true;
    } catch (e) {
      this.log('mci player failed: ' + e.message);
      return false;
    }
  }

  async _onReadError(msg) {
    if (msg === '__skip_notice__') {
      if (!this._skipNoticeSent) {
        this._skipNoticeSent = true;
        this._notice('notice.sectorsSkipped', null, '部分扇区读取异常已跳过（光盘可能轻微划伤）');
      }
      return;
    }
    // RAW 读取连续失败：先判定是不是光盘被弹出，避免"填静音继续播"造成卡死/无限重播
    if (msg === '__read_stalled__') {
      await this._onReadStalled();
      return;
    }
    /**
     * 稳定播放期（看门狗起播窗口外）的连续全零数据（v10.3）。
     * 全零是数据事实而非启发式误判，大概率是介质被取走/虚拟光驱卸载了镜像 ——
     * 但按"读盘后不做主动切换"的约定，不切 MCI，而是走介质验证：
     * 盘真的不在 → 取盘流程；盘还在 → 提示后停播（不无限放静音）。
     */
    if (msg === '__read_silent__') {
      this.log('raw read: 稳定播放期连续全零 -> 验证介质');
      const wasPlaying = this.playState === 'playing';
      await this.stopPlayback();
      const present = await this._verifyMediaPresent();
      if (present) {
        this._notice('notice.silenceStopped', null,
          '读取到连续静音数据，播放已停止（光盘可能严重划伤或光驱不支持数字读取）');
      } else {
        await this._handleDiscRemoved('removed', { wasPlaying });
      }
      return;
    }
    /**
     * 引擎偏好为手动 RAW 时，任何 RAW 故障都不回退 MCI（用户明确要求
     * "强制使用该模式，读盘后不做任何主动切换处理"）—— 停播并提示，
     * 把决策权交还用户（真的想用 MCI 时去设置页切换）。
     */
    if (this._enginePreference() === 'raw') {
      this.log('raw read fatal (manual-raw pref): ' + msg + ' -> stop, no engine switch');
      this.stopPlayback();
      this._notice('notice.rawReadFault', { err: msg }, 'RAW 读取故障：' + msg + '（已固定 RAW 引擎，不会自动切换）');
      return;
    }
    // RAW 读取彻底失败（起播窗口内的数据异常 / 读取线程故障）→ 尝试切换到 MCI 继续播放，避免直接停摆
    const track = this.currentTrack || 1;
    const sec = this._positionSec();
    this.log('raw read fatal: ' + msg + ' -> trying MCI switch, track=' + track);
    try {
      if (this.player) await this.player.close();
    } catch (e) { /* 忽略 */ }
    this.player = null;
    this.engine = null;
    const mciOk = await this._startMciPlayer();
    if (mciOk) {
      try {
        await this.playTrack(track, sec);
        // 垃圾数据（白噪音）与"读不出数据"是两种故障，通知文案要能区分 ——
        // 后者说"不支持"，前者要点明"数据异常"，用户才知道该去设置里固定 MCI。
        const garbage = /伪造数据|数据形态非音频/.test(msg);
        if (garbage) {
          this._notice('notice.mciGarbage', null,
            '光驱返回的音频数据异常（白噪音），已自动切换为模拟播放（可在设置里固定 MCI 引擎）');
        } else {
          this._notice('notice.mciFallback', null,
            '光驱不支持数字读取，已切换为模拟播放（音量需用系统调节）');
        }
        return;
      } catch (e) {
        this.log('mci switch play failed: ' + e.message);
      }
    }
    this.stopPlayback();
    this._emit('cd:notice', { text: msg });
  }

  /** 本轨播完：只上报，不自行切轨（切轨决策统一由渲染端按播放模式执行） */
  _onTrackEnd(track) {
    const now = Date.now();
    if (now - this._endGuard < 1500) return;
    this._endGuard = now;
    this.log('track end reported: ' + track);
    this.playState = 'stopped';
    this._setAnchor(0);
    this._emitState('track-end');
    this._emit('cd:track-end', { track });
  }

  /** MCI 播放器轮询判定光盘被取出（MCI 模式下探测循环已停手，取盘靠这里） */
  _onMciDiscRemoved() {
    if (this.engine !== 'mci') return;
    this.log('mci player reports disc removed');
    this._handleDiscRemoved('removed');
  }

  /** RAW 读取停滞：由服务层判定介质是否还在，而不是继续填静音推进 */
  async _onReadStalled() {
    await this._watchMedia();
  }

  /**
   * 播放器报告的"真实听感位置"。
   * 暂停/恢复必须以它为准：服务层的墙钟锚点与播放器本地时钟之间可能差一个校正死区，
   * 旧实现直接用 _positionSec() 记录暂停点，恢复后位置就会跟暂停前对不上。
   */
  _playerPositionSec() {
    const p = this.player;
    if (!p) return null;
    if (typeof p.audibleSec === 'function') return p.audibleSec();
    if (typeof p.positionSec === 'function') return p.positionSec();
    return null;
  }

  /**
   * 暂停。
   * @param {{sec?:number}} [opts] 渲染端上报的"真实听感位置"。
   *
   * ★ 权威来源按引擎分流 —— 这是本次修复的关键取舍：
   *
   *   **MCI 路径**：声音由系统声卡直接输出，渲染端手里没有任何本地音频
   *   （`App.engine` 为 null），它给的 `heard` 只是个墙钟估计值。
   *   真正的权威是播放器**回读 `status cd position`** 拿到的 MCI 落点
   *   （见 mci-player.pause()）。所以 MCI 一律以 `player.audibleSec()` 为准。
   *
   *   **RAW 路径**：渲染端握着 AudioContext 的调度队列，是真权威
   *   （主进程的已读游标最多超前一个 5 秒预读缓冲），所以沿用 `heard`。
   *
   * 旧实现不分引擎、一律用 `heard`：在 MCI 上等于用一个估计值覆盖真实回读值，
   * 暂停点因此整体偏后，续播也从偏后的位置起 —— 正是用户反馈的症状。
   *
   * ★ 响应性：先把状态切到 paused 并立即广播一次 `cd:state`，
   *   再执行暂停命令。MCI 的 `pause cd` 是同步阻塞调用（几十到几百毫秒），
   *   等它返回才广播会让界面与系统媒体控件"迟钝一小段时间"。
   *   命令返回后用回读到的精确位置**再补发一次**，数字随后收敛到准确值。
   */
  async pause(opts) {
    if (this.playState !== 'playing') {
      // 已经是暂停/停止：把当前权威状态再广播一次，纠正可能错乱的界面
      this._emitState('pause-noop');
      return;
    }
    const heard = (opts && typeof opts.sec === 'number' && isFinite(opts.sec)) ? Math.max(0, opts.sec) : null;

    if (this.engine === 'demo') {
      const demoSec = heard != null ? heard : this._positionSec();
      this.playState = 'paused';
      this._setAnchor(demoSec);
      this._emit('cd:demo-pause', { track: this.currentTrack });
      this._emitState('pause');
      return;
    }

    // 位置必须在切换到 paused 之前结算：_positionSec() 在暂停态不再累加墙钟，
    // 先置状态再取值会永远拿到 0
    const secBefore = this._positionSec();

    // ① 乐观广播：让界面与 SMTC 立刻反映"已暂停"，不必等 MCI 命令返回
    this.playState = 'paused';
    this._setAnchor(heard != null ? heard : secBefore);
    this._emitState('pause');

    // ② 真正停声（MCI 路径下这一步是同步阻塞的）
    if (this.player) {
      try { await this.player.pause(); } catch (e) { /* 忽略 */ }
    }

    /**
     * ③ 用暂停后的权威位置重新定锚。
     *   MCI → 播放器回读到的真实落点；RAW → 渲染端上报的听感位置。
     *   两者都拿不到时才退到本地墙钟 secBefore（"已送出"的下界，
     *   宁可略微偏前也绝不偏后 —— 偏前只是重复听半秒，偏后是漏内容）。
     */
    let sec;
    let source;
    const playerAfter = this._playerPositionSec();
    if (this.engine === 'mci' && playerAfter != null) {
      sec = playerAfter;
      source = 'mci-readback';
    } else if (heard != null) {
      sec = heard;
      source = 'renderer';
      if (this.player && typeof this.player.setAudibleSec === 'function') {
        try { this.player.setAudibleSec(sec); } catch (e) { /* 忽略 */ }
      }
    } else {
      sec = secBefore;
      source = 'wall';
      if (this.player && typeof this.player.setAudibleSec === 'function') {
        try { this.player.setAudibleSec(sec); } catch (e) { /* 忽略 */ }
      }
    }
    this.playState = 'paused';
    this._setAnchor(sec);
    this.log('pause: heard=' + (heard == null ? '-' : heard.toFixed(3)) +
      ' source=' + source +
      ' wall=' + secBefore.toFixed(3) +
      ' player=' + (playerAfter == null ? '-' : playerAfter.toFixed(3)) +
      ' -> anchor=' + sec.toFixed(3));
    // ④ 精确补发：数字收敛到设备真实停下的那一秒
    this._emitState('pause-synced');
  }

  async resume(opts) {
    if (this.playState === 'playing') {
      this._emitState('resume-noop');
      return;
    }
    // 续播起点：优先渲染端指定值，其次锚点（暂停时已被钉在听感位置）
    const asked = (opts && typeof opts.sec === 'number' && isFinite(opts.sec)) ? Math.max(0, opts.sec) : null;
    const sec = asked != null ? asked : this._positionSec();

    if (this.engine === 'demo') {
      this.playState = 'playing';
      this._setAnchor(sec);
      this._emit('cd:demo-resume', { track: this.currentTrack, seconds: sec });
      this._emitState('resume');
      return;
    }

    // 播放器未建立（如就绪后尚未播过）→ 直接起播当前轨
    if (!this.player) {
      await this.playTrack(this.currentTrack, sec);
      return;
    }

    // MCI 路径：播放器内部已把暂停点钉死在 _pausedSec，并由 play cd from 物理重起；
    // 这里先让播放器读完它自己的暂停点，再统一按引擎取锚点。
    if (this.engine !== 'mci' && asked != null && typeof this.player.setAudibleSec === 'function') {
      // RAW：以渲染端的听感位置为准对齐起点，杜绝"续播位置比界面多走几秒"
      try { this.player.setAudibleSec(asked); } catch (e) { /* 忽略 */ }
    }
    // 先置位播放态再恢复起泵：pump 重启后的首块数据不能被 onChunk 的
    // playState 守卫丢弃（同 playTrack 的注释，不依赖微任务时序）
    this.playState = 'playing';
    try {
      await this.player.resume();
    } catch (e) { /* 忽略 */ }

    /**
     * ★ 锚点同样按引擎分流：
     *   MCI → 播放器回读到的物理起播点（resume() 里已用 play cd from 对齐）；
     *   RAW → 渲染端指定值（或暂停时钉好的锚点）。RAW 播放器自报的位置是超前量，
     *         用它当锚点会让界面数字从暂停点"往前跳"，所以绝不能用。
     */
    const playerSaid = this._playerPositionSec();
    let anchor = sec;
    let source = 'asked';
    if (this.engine === 'mci' && playerSaid != null) {
      anchor = playerSaid;
      source = 'mci-readback';
    }
    this.playState = 'playing';
    this._setAnchor(anchor);
    this.log('resume: asked=' + (asked == null ? '-' : asked.toFixed(3)) +
      ' playerSaid=' + (playerSaid == null ? '-' : playerSaid.toFixed(3)) +
      ' source=' + source +
      ' -> anchor=' + anchor.toFixed(3));
    // 先播一帧再广播：状态与位置同时到位，界面不会先跳一下再被拉回
    this._emitState('resume');
  }

  async stopPlayback() {
    if (this.player) {
      try { await this.player.stop(); } catch (e) { /* 忽略 */ }
    }
    if (this.engine === 'demo') this._emit('cd:demo-stop', { track: this.currentTrack });
    this.playState = 'stopped';
    this._setAnchor(0);
    // 碟仍在 → 保持 ready；只在无碟时才回 idle
    if (this.phase === 'playing' || this.phase === 'paused') {
      this.phase = this.signature ? 'ready' : 'idle';
    }
    this._emitState('stop');
  }

  async closePlayer() {
    if (this.player) {
      try { await this.player.close(); } catch (e) { /* 忽略 */ }
      this.player = null;
      this.engine = null;
    }
  }

  /**
   * 按轨道内秒数定位。
   * 语义：播放中 → 从新位置继续播；暂停中 → 停在暂停态的新位置；
   *       停止中 → 起播（MCI 无法在 stopped 下静默定位，统一为起播更可预期）。
   */
  async seekTo(seconds) {
    if (!this.toc) return;
    const n = this.currentTrack;
    const dur = this.trackDurationSec(n);
    let sec = Math.max(0, Number(seconds) || 0);
    if (dur > 0) sec = Math.min(sec, Math.max(0, dur - 0.05));

    // 停止态定位 → 从该位置起播（MCI 无法在 stopped 下静默定位，统一语义为起播）
    if (this.playState === 'stopped') {
      await this.playTrack(n, sec);
      return;
    }

    if (this.engine === 'demo') {
      this._setAnchor(sec);
      this._emit('cd:demo-seek', { track: n, seconds: sec });
      if (this.playState === 'stopped') this.playState = 'playing';
      this._emitState('seek');
      return;
    }

    if (this.player) {
      try {
        if (typeof this.player.seekToSeconds === 'function') await this.player.seekToSeconds(sec);
        else await this.player.seekToFrame(this._frameOfSec(n, sec));
      } catch (e) { /* 忽略 */ }
      // MCI 在 stopped 态定位必然起播；其它引擎保持原状态
      if (this.engine === 'mci' && this.playState === 'stopped') this.playState = 'playing';
    } else {
      this.playState = 'playing';
    }
    /**
     * ★ 锚点优先取播放器**回读到的实际落点**。
     *   驱动会把请求的帧贴到扇区边界上，直接采用请求值会让界面数字
     *   与真正出声的位置差上一小段；这段差值随后被 LRC 歌词消费，
     *   表现就是"快进之后歌词跑偏"。回读不可用时才退到请求值。
     */
    let anchor = sec;
    if (this.engine === 'mci') {
      const landed = this._playerPositionSec();
      if (landed != null) anchor = landed;
    }
    this._setAnchor(anchor);
    this._emitState('seek');
  }

  _frameOfSec(trackNumber, sec) {
    const t = this.toc && this.toc.tracks.find((x) => x.number === trackNumber);
    if (!t) return null;
    return Math.min(Math.max(t.startFrame + Math.round(sec * 75), t.startFrame), Math.max(t.startFrame, t.endFrame - 1));
  }

  currentTrackNumber() {
    return this.currentTrack || 1;
  }

  /* ---------- 托盘 ---------- */

  /** MCI 方式开关舱门（虚拟光驱等无底层 IOCTL 支持的设备） */
  async _mciDoor(letter, action) {
    try {
      const alias = 'sg_door_' + letter;
      const open = native.mciSend(`open ${letter}: type cdaudio alias ${alias} wait`);
      if (open.code !== 0) return false;
      try {
        const c = native.mciSend(`set ${alias} door ${action} wait`);
        return c.code === 0;
      } finally {
        try { native.mciSend(`close ${alias}`); } catch (e) { /* 忽略 */ }
      }
    } catch (e) {
      return false;
    }
  }

  async _trayControl(action) {
    let ok = false;
    let handle = null;
    try {
      handle = native.openCdDevice(this.drive);
      const code = action === 'eject' ? native.IOCTL_CDROM_EJECT_MEDIA
        : action === 'load' ? native.IOCTL_CDROM_LOAD_MEDIA
          : native.IOCTL_CDROM_CLOSE_DOOR;
      native.trayControl(handle, code);
      ok = true;
    } catch (e) {
      ok = false;
    } finally {
      if (handle) { try { native.closeDevice(handle); } catch (e) { /* 忽略 */ } }
    }
    return ok;
  }

  async eject() {
    if (this.engine === 'demo') {
      this._exitDemo();
      return;
    }
    // 标记为"软件内主动出舱"：后续回退读盘界面不受"外部弹出"开关影响
    this._selfEjecting = true;
    // 先停播放（保留 player，弹出失败可继续播）
    if (this.player) {
      try { await this.player.stop(); } catch (e) { /* 忽略 */ }
    }
    this.playState = 'stopped';
    this._setAnchor(0);
    this._emitState('eject');
    this.phase = 'ejecting';
    this._emit('cd:phase', { phase: 'eject' });

    /*
     * 出舱流程（与播放引擎解耦）：
     *   1) 先试物理 IOCTL 出舱 —— 真实光驱，RAW / MCI 引擎下都可用；
     *   2) 失败再用 MCI 舱门指令兜底 —— 虚拟光驱 / 无舱门设备。
     *      ★ 不能只依赖"当前是否 MCI 引擎"：RAW 可用时播放器是懒加载的，
     *        碟片就绪阶段 player 可能还是 null，而虚拟光驱同样可能支持 RAW 读取；
     *   3) 只要具备 MCI 复核手段，就验证盘是否真的被取出 ——
     *      虚拟光驱 / 无舱门设备常常"命令返回成功但盘仍在"，不校验会误判为已弹出。
     */
    let ok = await this._trayControl('eject');
    if (!ok) {
      if (this.player && typeof this.player.eject === 'function') {
        try { ok = await this.player.eject(); } catch (e) { ok = false; }
      }
      if (!ok) ok = await this._mciDoor(this.drive, 'open');
    }

    if (ok && this._canVerifyViaMci()) {
      const present = await this._discPresentViaMci();
      if (present) {
        // 盘未取出：视为无舱门（多为虚拟光驱），保留碟片状态并继续播放，给出明确指引
        this.phase = 'ready';
        this._emit('cd:phase', { phase: 'ready' });
        this._notice('notice.noEject', null,
          '此光驱不支持弹出（虚拟光驱通常没有舱门，请在虚拟光驱软件中卸载镜像）');
        // 重新起播当前轨，避免停在 stopped 后无法恢复
        const track = this.currentTrack || 1;
        try { await this.playTrack(track, 0); } catch (e) { /* 忽略 */ }
        this._selfEjecting = false;   // 出舱并未发生：必须恢复探测，否则再也感知不到换碟
        return;
      }
    }

    if (!ok) {
      this.phase = 'ready';
      this._emit('cd:phase', { phase: 'ready' });
      this._notice('notice.ejectFailed', null, '出舱失败，请检查光驱状态');
      this._selfEjecting = false;   // 出舱失败：恢复探测
      return;
    }

    await sleep(1200);
    await this._handleDiscRemoved('ejected');
    this._selfEjecting = false;
  }

  /** 是否具备经 MCI 复核"盘是否真的被取出"的手段 */
  _canVerifyViaMci() {
    return this.engine === 'mci' ||
      (!!this.player && typeof this.player.isMediaPresent === 'function') ||
      this.detectedVia === 'mci';
  }

  /**
   * 在 MCI 侧确认光盘是否仍在（虚拟光驱/无盘时仍可读到介质）。
   * 播放器持有 cdaudio 实例时走播放器；否则（RAW 懒加载、尚未起播）
   * 临时开一个 MCI 实例复核，开不了实例时不阻拦出舱流程。
   */
  async _discPresentViaMci() {
    if (this.player && typeof this.player.isMediaPresent === 'function') {
      return this.player.isMediaPresent();
    }
    if (this.engine === 'raw') return true;   // 真实光驱物理出舱即视为取出
    try {
      const alias = 'sg_probe_' + this.drive;
      const open = native.mciSend(`open ${this.drive}: type cdaudio alias ${alias} wait`);
      if (open.code !== 0) return true;
      try {
        const mp = native.mciSend(`status ${alias} media present wait`);
        const s = String(mp.text).trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0') return false;
        const mode = String(native.mciSend(`status ${alias} mode wait`).text).trim().toLowerCase();
        return mode !== 'open' && mode !== 'no disc' && mode !== 'not ready';
      } finally {
        try { native.mciSend(`close ${alias}`); } catch (e) { /* 忽略 */ }
      }
    } catch (e) {
      return true;
    }
  }

  async closeDoor() {
    let ok = await this._trayControl('close');
    if (!ok && this.detectedVia === 'mci') {
      ok = await this._mciDoor(this.drive, 'closed');
    }
    if (!ok) this._notice('notice.closeDoorFailed', null, '关舱失败（虚拟光驱通常没有舱门）');
    return ok;
  }

  /* ---------- 演示模式 ---------- */

  useDemo() {
    if (this._reading) return;
    this._reading = true;
    this.stopPlayback();
    this.closePlayer();
    this.drive = null;
    this.toc = DEMO_TOC;
    this.signature = '__demo__';
    this.metadata = DEMO_META;
    this.engine = 'demo';
    this.demoRequested = true;
    this.phase = 'reading';
    this.playState = 'stopped';
    this.currentTrack = 1;
    this._setAnchor(0);

    this._emit('cd:phase', { phase: 'insert', demo: true });
    setTimeout(async () => {
      try {
        if (!this._reading) return;
        this._emit('cd:phase', { phase: 'reading', stage: 'toc', demo: true });
        await sleep(750);
        if (!this._reading) return;
        this._emit('cd:metadata', { metadata: DEMO_META, fromCache: true, demo: true });
        this._emit('cd:phase', { phase: 'reveal', hasCover: false, demo: true });
        await sleep(1150);
        if (!this._reading) return;
        this.phase = 'ready';
        this._emit('cd:phase', { phase: 'ready', demo: true });
        this._emit('cd:engine', { engine: 'demo', volumeSupported: true });
        this._emitState('ready');
        if (this.autoPlay) {
          this._emit('cd:land', { page: 'nowplaying', autoplay: true });
          this.playTrack(1);
        } else {
          this._emit('cd:land', { page: 'library', autoplay: false });
        }
      } finally {
        this._reading = false;
      }
    }, 900);
  }

  _exitDemo() {
    this.stopPlayback();
    this.signature = null;
    this.toc = null;
    this.metadata = null;
    this.engine = null;
    this.phase = 'idle';
    this.demoRequested = false;
    this._emit('cd:phase', { phase: 'idle', reason: 'ejected' });
  }

  /* ---------- 状态查询 ---------- */

  getState() {
    return {
      phase: this.phase,
      playState: this.playState,
      track: this.currentTrack,
      positionSec: this._positionSec(),
      durationSec: this.trackDurationSec(this.currentTrack),
      drive: this.drive,
      signature: this.signature,
      engine: this.engine,
      volumeSupported: this.engine !== 'mci',
      trackCount: this.trackCount(),
      mode: this.playMode,
      demo: this.signature === '__demo__',
      hasMetadata: !!(this.metadata && this.metadata.tracks && this.metadata.tracks.length),
      hasToc: !!this.toc
    };
  }

  getMetadata() {
    return this.metadata;
  }

  getToc() {
    return this.toc;
  }

  dispose() {
    if (this._probeTimer) clearInterval(this._probeTimer);
    this.closePlayer();
  }
}

module.exports = { CdService };
