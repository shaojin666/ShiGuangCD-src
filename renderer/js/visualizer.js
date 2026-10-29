'use strict';
/* ============================================================
   visualizer.js —— 界面动效层（只读音频，不参与播放链路）
   ------------------------------------------------------------
   1) 从渲染端已经存在的 AudioContext 上「旁路」接一个 AnalyserNode。
      AnalyserNode 本身是直通节点，末端再挂一个 0 增益节点收尾，
      既保证图被拉动（能取到数据），又不会有任何额外声音，
      因此对听感零影响：主进程播放逻辑、Transport、IPC 一概不动。
   2) 低频能量 + 慢速基线做节拍判定，输出：
        pulse  0→1 的鼓点脉冲（随后按时间衰减）
        dir    震动方向（每次鼓点正负交替）
        level  整体响度
        bass   低频能量
   3) 每帧把这些量写成 <html> 上的 CSS 变量（--beat / --beat-dir / --level / --bass），
      背景、歌词、唱片只读这几个变量，避免多套动画各写各的。
   4) MCI 路径下声音由系统声卡直出，渲染端没有本地音频 → live=false：
      背景依旧跟随专辑封面，但**不伪造鼓点**，动效量平滑归零。
   ============================================================ */

const Visualizer = (() => {
  const FFT_SIZE = 1024;
  /** 参与节拍判定的低频上限（Hz）—— 鼓点基本都在这附近 */
  const BASS_HZ = 240;
  /** 两次鼓点之间的最小间隔（秒） */
  const MIN_BEAT_GAP = 0.19;

  const S = {
    engine: null,
    analyser: null,
    sink: null,
    ctx: null,
    freq: null,
    bassBins: 6,

    bass: 0,
    bassAvg: 0,
    level: 0,
    pulse: 0,
    dir: 1,
    live: false,
    beat: false,
    beats: 0,
    lastBeatAt: -9,

    artUrl: '',
    artFront: null,

    enabled: true,
    raf: 0,
    lastT: 0,
    started: false,
    _lastVars: {}
  };

  function root() {
    return (typeof document !== 'undefined' && document.documentElement) ? document.documentElement : null;
  }

  /** 引擎 / 传输状态都可能还没初始化（TDZ），一律包在 try 里取 */
  function currentEngine() {
    try { return (typeof App !== 'undefined' && App) ? App.engine : null; } catch (e) { return null; }
  }

  function isPlaying() {
    try { return (typeof Transport !== 'undefined' && Transport) ? Transport.status === 'playing' : false; }
    catch (e) { return false; }
  }

  /* ---------- 挂载 / 摘除分析节点 ---------- */

  function detach() {
    const eng = S.engine;
    try { if (eng && eng.gain && S.analyser) eng.gain.disconnect(S.analyser); } catch (e) { /* 未连接 */ }
    try { if (S.analyser && S.sink) S.analyser.disconnect(S.sink); } catch (e) { /* 已断开 */ }
    try { if (S.sink && S.ctx) S.sink.disconnect(S.ctx.destination); } catch (e) { /* 已断开 */ }
    S.analyser = null;
    S.sink = null;
    S.ctx = null;
    S.freq = null;
    S.engine = null;
    S.live = false;
  }

  function attach(eng) {
    S.engine = eng;
    const ctx = eng && eng.ctx;
    if (!ctx || !eng.gain || typeof ctx.createAnalyser !== 'function') return;
    try {
      const an = ctx.createAnalyser();
      an.fftSize = FFT_SIZE;
      an.smoothingTimeConstant = 0.72;
      an.minDecibels = -86;
      an.maxDecibels = -20;
      // 0 增益收尾：AnalyserNode 直通输入，接 destination 会让同一路声音出现两次，
      // 这里用一个静音汇点把分析分支"拉进渲染图"，听感完全不变。
      const sink = ctx.createGain();
      sink.gain.value = 0;
      eng.gain.connect(an);
      an.connect(sink);
      sink.connect(ctx.destination);
      S.analyser = an;
      S.sink = sink;
      S.ctx = ctx;
      S.freq = new Uint8Array(an.frequencyBinCount || (FFT_SIZE / 2));
      const binHz = (ctx.sampleRate || 44100) / FFT_SIZE;
      S.bassBins = Math.max(2, Math.min(24, Math.round(BASS_HZ / binHz)));
      S.live = true;
    } catch (e) {
      // 老实现 / 受限环境没有 Analyser：静默降级为"无动效数据"
      S.analyser = null;
      S.live = false;
    }
  }

  function syncEngine() {
    const eng = currentEngine();
    if (eng === S.engine) return;
    detach();
    attach(eng);
  }

  /* ---------- 频谱分析 ---------- */

  function analyse(dt, nowSec) {
    let bassRaw = 0;
    let levelRaw = 0;

    if (S.live && S.analyser && S.freq && isPlaying()) {
      try {
        S.analyser.getByteFrequencyData(S.freq);
        let bs = 0;
        for (let i = 0; i < S.bassBins; i++) bs += S.freq[i];
        bassRaw = bs / (S.bassBins * 255);
        let all = 0;
        const step = 4;
        let n = 0;
        for (let i = 0; i < S.freq.length; i += step) { all += S.freq[i]; n++; }
        levelRaw = n ? all / (n * 255) : 0;
      } catch (e) {
        S.live = false;
      }
    }

    // 平滑：起音快、回落慢，听起来才是"跟着音乐"而不是"跳数字"
    const kUp = 0.45;
    const kDown = 0.09;
    S.bass += (bassRaw - S.bass) * (bassRaw > S.bass ? kUp : kDown);
    S.level += (levelRaw - S.level) * (levelRaw > S.level ? 0.4 : 0.07);

    // 慢速基线：安静的段落不会误触发，响的段落自动抬高阈值
    S.bassAvg += (S.bass - S.bassAvg) * (bassRaw > S.bassAvg ? 0.03 : 0.12);
    const thresh = Math.max(0.055, S.bassAvg * 1.32);

    S.beat = false;
    if (S.live && S.bass > thresh && nowSec - S.lastBeatAt > MIN_BEAT_GAP) {
      S.beat = true;
      S.beats++;
      S.lastBeatAt = nowSec;
      S.pulse = 1;
      S.dir = -S.dir;              // 每次鼓点反向，歌词就是"抖"而不是"膨胀"
    }

    S.pulse = Math.max(0, S.pulse - dt * 2.7);
  }

  /* ---------- 每帧 ---------- */

  function frame(t) {
    S.raf = requestAnimationFrame(frame);
    const dt = S.lastT ? Math.min(0.1, Math.max(0.001, (t - S.lastT) / 1000)) : 0.016;
    S.lastT = t;
    syncEngine();
    if (S.enabled) analyse(dt, t / 1000);
    else { S.level = 0; S.bass = 0; S.pulse = 0; }
    publish();
  }

  function publish() {
    const r = root();
    if (!r || !r.style || !r.style.setProperty) return;
    setVar(r, '--beat', S.pulse.toFixed(3));
    setVar(r, '--beat-dir', S.pulse > 0.001 ? String(S.dir) : '1');
    setVar(r, '--level', S.level.toFixed(3));
    setVar(r, '--bass', S.bass.toFixed(3));
  }

  /** 只在值真的变了时才写样式，避免每帧无谓地让样式层失效 */
  function setVar(r, name, value) {
    if (S._lastVars[name] === value) return;
    S._lastVars[name] = value;
    r.style.setProperty(name, value);
  }

  /* ---------- 专辑封面背景 ---------- */

  function bgLayers() {
    return [
      document.getElementById('bg-art-a'),
      document.getElementById('bg-art-b')
    ];
  }

  /**
   * 把当前播放碟的封面设为背景（模糊 + 取色）。
   * 两层交叉淡入：换碟时不会出现空白闪烁。
   */
  function setCover(url) {
    const next = url || '';
    if (next === S.artUrl) return;
    S.artUrl = next;
    const layers = bgLayers();
    if (!layers[0] || !layers[1]) return;
    const front = S.artFront === layers[0] ? layers[1] : layers[0];
    const back = S.artFront === layers[0] ? layers[0] : layers[1];
    if (!next) {
      front.classList.remove('on');
      back.classList.remove('on');
      S.artFront = null;
      return;
    }
    front.style.backgroundImage = 'url("' + next + '")';
    // 先把新层的图铺上，下一帧再淡入（避免淡入过程中出现空色块）
    requestAnimationFrame(() => {
      front.classList.add('on');
      back.classList.remove('on');
      S.artFront = front;
    });
  }

  /* ---------- 开关 ---------- */

  function setEnabled(on) {
    S.enabled = on !== false;
    if (!S.enabled) {
      S.level = 0; S.bass = 0; S.pulse = 0;
      publish();
    }
  }

  function start() {
    if (S.started) return;
    S.started = true;
    if (typeof requestAnimationFrame !== 'function') return;   // 无 rAF 环境（如单测）直接降级
    S.raf = requestAnimationFrame(frame);
  }

  return {
    start,
    setCover,
    setEnabled,
    /** 供界面读取当前动效量（0→1） */
    level: () => S.level,
    bass: () => S.bass,
    pulse: () => S.pulse,
    isLive: () => S.live,
    isPlaying: isPlaying,
    beatCount: () => S.beats
  };
})();