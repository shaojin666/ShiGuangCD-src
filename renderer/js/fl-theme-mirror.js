'use strict';
/* ============================================================
   fl-theme-mirror.js —— 主题「镜台 Mirror」（3D 点云演出）
   ------------------------------------------------------------
   为什么独立文件：本主题按需懒加载 three.min.js（608KB，不进
   首屏），逻辑量也最大；fl-themes.js 保持轻量，只放 CSS 级主题。
   本文件在 index.html 里以普通 <script> 引入（体积小），真正
   沉重的 three.js 由 mount() 里 ctx.loadScript 按需拉取。

   视觉：歌词悬浮在一座「镜台」前——Three.js 点云星海在脚下
   起伏，一道网格地平线延伸向雾中，整台机器随音乐鼓点呼吸、
   低频推动粒子扩散、换行时荡开一圈涟漪。歌词 DOM 层叠在
   3D 场景之前（z:3 > fx z:2），文字可读性不受影响。

   降级链（三级，任何一级失败自动落到下一级，演出不中断）：
     1) WebGL：three.js 点云星海（完整镜台）
     2) Canvas2D：星云粒子海 + 镜面地平线（仍华丽，无 GL 依赖）
     3) 纯 CSS：无 fx 层，仅保留 Mirror 的 CSS 文字效果

   画质自适应：
     - 启动档位由 CPU 核数 / 屏幕像素面积 / DPR 推定（高/中/低）；
     - 运行中 FPS 滑动窗口监测：< 42fps 持续 2.5s 降一档，
       > 57fps 持续 6s 升一档（hysteresis 防抖动）；
     - 档位只改「绘制粒子数 / 渲染像素比」，不重建场景
       （GL 按最高档分配 buffer，用 setDrawRange 调档）；
     - 用户参数 density（0.4~2.0）作为全局乘数叠在档位之上。

   性能纪律（与 fl-themes.js 文件头一致）：
     - 渲染由舞台控制器的单一 rAF 驱动（theme.frame），不自起循环；
     - 帧内不写任何 DOM 布局属性；涟漪包络自己算（不读回
       getComputedStyle——GSAP 在这里只服务 CSS 变量型主题）；
     - dispose 必须释放 GL 上下文（forceContextLoss），否则反复
       切主题会耗尽浏览器的 WebGL 上下文配额（约 16 个）。
   ============================================================ */

(function () {
  if (typeof window === 'undefined' || !window.FlThemes) return;
  const FlThemes = window.FlThemes;

  /* ---------- 图标：镜台（同心弧 + 地平线） ---------- */
  const IC_MIRROR =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.5" stroke-linecap="round" aria-hidden="true">'
    + '<path d="M3 17.5h18"/><path d="M6.5 17.5a5.5 5.5 0 0 1 11 0"/>'
    + '<path d="M9.5 17.5a2.5 2.5 0 0 1 5 0"/><circle cx="12" cy="6.2" r="1.4" fill="currentColor" stroke="none"/></svg>';

  /* ---------- 画质档位 ---------- */
  /* points: GL 粒子数（buffer 按高档分配，drawRange 下调）；
     nebula: Canvas2D 粒子数；dpr: 渲染像素比上限 */
  const TIERS = [
    { points: 1000, nebula: 260, dpr: 1.0 },
    { points: 2400, nebula: 520, dpr: 1.35 },
    { points: 4600, nebula: 900, dpr: 1.75 }
  ];
  const FPS_DOWN = 42, FPS_DOWN_HOLD = 2.5;   // 降档阈值 / 持续时间
  const FPS_UP = 57, FPS_UP_HOLD = 6;         // 升档阈值 / 持续时间

  /** 启动档位推定：核数少 / 像素面积大 → 低档 */
  function detectTier() {
    let cores = 4;
    try { cores = navigator.hardwareConcurrency || 4; } catch (e) { /* 忽略 */ }
    const area = (window.innerWidth || 1280) * (window.innerHeight || 720)
      * Math.pow(window.devicePixelRatio || 1, 2);
    if (cores <= 4 || area > 4.4e6) return 0;
    if (cores <= 8 || area > 2.4e6) return 1;
    return 2;
  }

  /** 读封面色板（--fl-c1..3），失败给默认金蓝锈 */
  function palette(stage) {
    const def = ['#c9a56a', '#7a8fb5', '#a65d54'];
    try {
      const cs = getComputedStyle(stage);
      const out = [];
      for (let i = 0; i < 3; i++) {
        const v = (cs.getPropertyValue('--fl-c' + (i + 1)) || '').trim();
        out.push(v || def[i]);
      }
      return out;
    } catch (e) { return def; }
  }

  /** 十六进制/任意 CSS 色 → THREE.Color（r149 接受 'red' 也接受 '#f0c') */
  function toColor(THREE, css) {
    try { return new THREE.Color(css); } catch (e) { return new THREE.Color('#ffffff'); }
  }

  /**
   * GL 可用性预探：mount 最前面调用。
   * 不可用就连 three.js 都不下载（省 608KB），也避免 three.js 的
   * WebGLRenderer 在拿不到上下文时往控制台倒一大串 error 噪音——
   * 降级是设计内的优雅路径，不是异常。
   */
  function hasWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (e) { return false; }
  }

  /* ============================================================
     WebGL 分支：Three.js 点云星海 + 网格地平线
     ============================================================ */
  function buildGL(ctx, THREE) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    } catch (e) {
      /* 失败尝试的画布绝不能留在 fx 里（否则降级后层里挂着死 canvas） */
      canvas.remove();
      throw new Error('WebGLRenderer failed');
    }
    ctx.fx.appendChild(canvas);
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 140);
    camera.position.set(0, 2.4, 9.5);

    const cols = palette(stage).map((c) => toColor(THREE, c));

    /* --- 粒子星海：GPU 波动（ShaderMaterial），buffer 按最高档分配 --- */
    const maxN = TIERS[TIERS.length - 1].points;
    const pos = new Float32Array(maxN * 3);
    const phase = new Float32Array(maxN);
    const pcol = new Float32Array(maxN * 3);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < maxN; i++) {
      const r = 3 + Math.pow(rnd(), 0.6) * 20;
      const a = rnd() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = Math.pow(rnd(), 1.6) * 7.2;
      pos[i * 3 + 2] = Math.sin(a) * r * 0.72 - 6;
      phase[i] = rnd() * Math.PI * 2;
      const c = cols[(rnd() * 3) | 0];
      const j = 0.82 + rnd() * 0.18;      // 明度抖动，避免糊成一片
      pcol[i * 3] = c.r * j; pcol[i * 3 + 1] = c.g * j; pcol[i * 3 + 2] = c.b * j;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(pcol, 3));
    geo.setDrawRange(0, TIERS[detectTier()].points);

    const uniforms = {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uBass: { value: 0 },
      uRipple: { value: 0 },
      uPixelRatio: { value: 1 }
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: [
        'attribute float aPhase;',
        'attribute vec3 aColor;',
        'uniform float uTime, uPulse, uBass, uRipple, uPixelRatio;',
        'varying vec3 vColor;',
        'varying float vFade;',
        'void main() {',
        '  vColor = aColor;',
        '  vec3 p = position;',
        '  // 呼吸：整体缓慢起伏 + 低频外扩 + 换行涟漪（从中心荡开）',
        '  float w = sin(uTime * 0.55 + aPhase) * 0.45;',
        '  p.y += w + uBass * 0.5 * sin(aPhase * 2.0);',
        '  float ring = length(p.xz);',
        '  p.xz *= 1.0 + uBass * 0.05 + uRipple * 0.06 * sin(ring * 0.35 - uTime * 2.0);',
        '  p.y += uRipple * 0.6 * exp(-ring * 0.12);',
        '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
        '  // 远处淡出（自管雾，避免 ShaderMaterial 手拼 fog chunks）',
        '  vFade = smoothstep(-46.0, -6.0, mv.z) * (0.55 + 0.45 * uPulse);',
        '  gl_PointSize = (2.2 + 2.6 * uPulse + uRipple * 2.0) * uPixelRatio * (26.0 / -mv.z);',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vColor;',
        'varying float vFade;',
        'void main() {',
        '  vec2 d = gl_PointCoord - 0.5;',
        '  float a = smoothstep(0.5, 0.06, length(d)) * vFade;',
        '  if (a < 0.01) discard;',
        '  gl_FragColor = vec4(vColor, a);',
        '}'
      ].join('\n')
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);

    /* --- 网格地平线：极坐标网格线，向雾中延伸 --- */
    const gridCol = toColor(THREE, cols[0]);
    const gridMat = new THREE.LineBasicMaterial({
      color: gridCol, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false
    });
    const gv = [];
    const RINGS = [6, 10, 15, 21, 28];
    for (let ri = 0; ri < RINGS.length; ri++) {
      const rr = RINGS[ri];
      const seg = 48;
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
        gv.push(Math.cos(a0) * rr, 0, Math.sin(a0) * rr * 0.72 - 6,
          Math.cos(a1) * rr, 0, Math.sin(a1) * rr * 0.72 - 6);
      }
    }
    for (let s = 0; s < 16; s++) {
      const a = (s / 16) * Math.PI * 2;
      gv.push(Math.cos(a) * 5, 0, Math.sin(a) * 3.6 - 6,
        Math.cos(a) * 30, 0, Math.sin(a) * 21.6 - 6);
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gv, 3));
    scene.add(new THREE.LineSegments(gridGeo, gridMat));

    /* --- 尺寸 / DPR / 档位 --- */
    let tier = detectTier();
    let dead = false;
    function resize() {
      const w = stage.clientWidth || window.innerWidth;
      const h = stage.clientHeight || window.innerHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIERS[tier].dpr));
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      uniforms.uPixelRatio.value = renderer.getPixelRatio();
    }
    resize();
    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    /* 上下文丢失：停渲但不崩（CSS 层仍在） */
    const onLost = (e) => { e.preventDefault(); dead = true; };
    canvas.addEventListener('webglcontextlost', onLost);

    /* --- FPS 自适应（滑动窗口 + hysteresis） --- */
    let fpsAcc = 0, fpsN = 0, holdDown = 0, holdUp = 0, adaptClock = 0;
    function adapt(dt) {
      fpsAcc += dt; fpsN++; adaptClock += dt;
      if (adaptClock < 0.5) return;
      const fps = fpsN / Math.max(0.001, fpsAcc);
      fpsAcc = 0; fpsN = 0; adaptClock = 0;
      if (fps < FPS_DOWN) { holdDown += 0.5; holdUp = 0; } else if (fps > FPS_UP) { holdUp += 0.5; holdDown = 0; }
      else { holdDown = 0; holdUp = 0; }
      if (holdDown >= FPS_DOWN_HOLD && tier > 0) {
        tier--; applyTier(); holdDown = 0; holdUp = 0;
      } else if (holdUp >= FPS_UP_HOLD && tier < TIERS.length - 1) {
        tier++; applyTier(); holdDown = 0; holdUp = 0;
      }
    }
    function applyTier() {
      const n = Math.max(120, Math.round(TIERS[tier].points * density()));
      geo.setDrawRange(0, Math.min(maxN, n));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIERS[tier].dpr));
      uniforms.uPixelRatio.value = renderer.getPixelRatio();
    }
    function density() {
      const v = parseFloat(ctx.stage.style.getPropertyValue('--fl-p-density'));
      return isFinite(v) && v > 0 ? v : 1;
    }

    /* --- 涟漪包络（onLine 触发，自己算，不读回 computed style） --- */
    let rippleT = -1;
    let clock = 0;

    return {
      mode: 'gl',
      onLine() { rippleT = 0; },
      onLyrics() { rippleT = 0; },
      frame(dt, info) {
        if (dead) return;
        clock += dt;
        uniforms.uTime.value = clock;
        // 脉冲平滑跟随（鼓点原始值跳变，直接喂会闪）
        const k = Math.min(1, dt * 9);
        const target = (info && info.pulse) || 0;
        uniforms.uPulse.value += (target - uniforms.uPulse.value) * k;
        uniforms.uBass.value = (info && info.bass) || 0;
        if (rippleT >= 0) {
          rippleT += dt;
          if (rippleT > 1.4) rippleT = -1;
        }
        uniforms.uRipple.value = rippleT >= 0
          ? Math.exp(-rippleT * 3.1) * (1 - rippleT / 1.4) : 0;
        // 相机缓慢摇摆（sin 位移，不扰定位链路——它不属于 DOM）
        camera.position.x = Math.sin(clock * 0.13) * 1.25;
        camera.position.y = 2.4 + Math.sin(clock * 0.21) * 0.32;
        camera.lookAt(0, 1.5, 0);
        renderer.render(scene, camera);
        adapt(dt);
      },
      onParam(key) { if (key === 'density') applyTier(); },
      dispose() {
        window.removeEventListener('resize', onResize);
        canvas.removeEventListener('webglcontextlost', onLost);
        try { renderer.dispose(); } catch (e) { /* 忽略 */ }
        try { renderer.forceContextLoss(); } catch (e) { /* 忽略 */ }
        geo.dispose(); mat.dispose(); gridGeo.dispose(); gridMat.dispose();
        /* 画布也移走：迟到 resolve 的在途挂载（已被代次守卫作废）
           靠这一手自己收拾干净，不依赖 disposeTheme 的 innerHTML 清空 */
        canvas.remove();
      }
    };
  }

  /* ============================================================
     Canvas2D 分支：星云粒子海 + 镜面地平线（降级一）
     ============================================================ */
  function buildNebula(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no 2d context');
    ctx.fx.appendChild(canvas);

    /* 预渲染软点 sprite（径向渐变一次，之后只 drawImage） */
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const sg = sprite.getContext('2d');
    const grad = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    sg.fillStyle = grad;
    sg.fillRect(0, 0, 64, 64);

    const cols = palette(stage);
    let W = 0, H = 0, dpr = 1;
    const maxN = TIERS[TIERS.length - 1].nebula;
    const P = [];
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < maxN; i++) {
      P.push({
        x: rnd(), y: rnd(),                 // 归一化坐标，resize 时换算
        r: 1.2 + rnd() * 3.4,
        vy: 0.008 + rnd() * 0.03,           // 每秒上浮（归一化）
        sw: 0.4 + rnd() * 1.2,              // 摆动角速度
        ph: rnd() * Math.PI * 2,
        a: 0.25 + rnd() * 0.6,
        c: cols[(rnd() * 3) | 0]
      });
    }
    let tier = detectTier();
    let clock = 0;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, TIERS[tier].dpr);
      W = stage.clientWidth || window.innerWidth;
      H = stage.clientHeight || window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
    }
    resize();
    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    function count() {
      const v = parseFloat(ctx.stage.style.getPropertyValue('--fl-p-density'));
      const d = isFinite(v) && v > 0 ? v : 1;
      return Math.max(40, Math.round(TIERS[tier].nebula * d));
    }

    /* FPS 自适应（与 GL 分支同参数） */
    let fpsAcc = 0, fpsN = 0, holdDown = 0, holdUp = 0, adaptClock = 0;
    function adapt(dt) {
      fpsAcc += dt; fpsN++; adaptClock += dt;
      if (adaptClock < 0.5) return;
      const fps = fpsN / Math.max(0.001, fpsAcc);
      fpsAcc = 0; fpsN = 0; adaptClock = 0;
      if (fps < FPS_DOWN) { holdDown += 0.5; holdUp = 0; } else if (fps > FPS_UP) { holdUp += 0.5; holdDown = 0; }
      else { holdDown = 0; holdUp = 0; }
      if (holdDown >= FPS_DOWN_HOLD && tier > 0) { tier--; resize(); holdDown = 0; holdUp = 0; }
      else if (holdUp >= FPS_UP_HOLD && tier < TIERS.length - 1) { tier++; resize(); holdDown = 0; holdUp = 0; }
    }

    let ripple = 0;
    return {
      mode: '2d',
      onLine() { ripple = 1; },
      onLyrics() { ripple = 1; },
      frame(dt, info) {
        clock += dt;
        const pulse = (info && info.pulse) || 0;
        const bass = (info && info.bass) || 0;
        if (ripple > 0) ripple = Math.max(0, ripple - dt * 1.6);

        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        // 拖尾：半透明底色覆盖（比 clearRect 多一层余晖，星云感）
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = 'rgba(8, 8, 12, 0.34)';
        g.fillRect(0, 0, W, H);

        // 镜面地平线：中线下方的渐变亮带 + 微动反射线
        const hy = H * 0.66;
        const hg = g.createLinearGradient(0, hy - 26, 0, H);
        hg.addColorStop(0, 'rgba(201,165,106,0)');
        hg.addColorStop(0.08, 'rgba(201,165,106,' + (0.16 + pulse * 0.1).toFixed(3) + ')');
        hg.addColorStop(1, 'rgba(122,143,181,0)');
        g.fillStyle = hg;
        g.fillRect(0, hy - 26, W, H - hy + 26);
        g.fillStyle = 'rgba(240,235,220,' + (0.1 + pulse * 0.14).toFixed(3) + ')';
        g.fillRect(0, hy - 1, W, 1.4);

        // 粒子
        g.globalCompositeOperation = 'lighter';
        const n = count();
        const rise = 1 + bass * 1.6;
        for (let i = 0; i < n; i++) {
          const p = P[i];
          p.y -= p.vy * dt * rise;
          if (p.y < -0.05) { p.y = 1.05; p.x = rnd(); }
          const x = (p.x + Math.sin(clock * p.sw + p.ph) * 0.02) * W;
          const y = p.y * H;
          const s = p.r * (1 + pulse * 0.5 + ripple * 0.8) * dpr;
          g.globalAlpha = Math.min(1, p.a * (0.5 + 0.5 * pulse) * (1 + ripple * 0.5));
          g.drawImage(sprite, x - s, y - s, s * 2, s * 2);
        }
        g.globalAlpha = 1;
        adapt(dt);
      },
      onParam() { /* 密度变化下帧自然生效（count() 每帧读） */ },
      dispose() {
        window.removeEventListener('resize', onResize);
        canvas.remove();   // 与 GL 分支同纪律：dispose 自管画布生命周期
      }
    };
  }

  /* ============================================================
     注册主题
     ============================================================ */
  FlThemes.register({
    id: 'mirror',
    /* 中文 name/desc/label 保留作兜底（词典缺项 / 直接读 def 的调试场景），
       界面一律走 FlThemes.nameOf/descOf/paramLabel —— 与其它主题同规矩 */
    name: '镜台',
    desc: '3D 点云星海作舞台，鼓点呼吸、换行涟漪（自动降级）',
    nameKey: 'theme.mirror.name',
    descKey: 'theme.mirror.desc',
    type: '3d',
    icon: IC_MIRROR,
    params: [
      { key: 'density', label: '粒子密度', labelKey: 'theme.mirror.p.density', min: 0.4, max: 2, step: 0.1, def: 1, unit: '×' }
    ],
    mount(ctx) {
      /* 降级链：GL → Canvas2D → 纯 CSS。每一级都包好异常，
         任何环境（无网测试 / 老旧机器 / GL 黑名单）都能落到
         一个能演出的形态。GL 预探失败时连 three.js 都不下载。 */
      return (async () => {
        let handle = null;
        if (hasWebGL()) {
          try {
            await ctx.loadScript('js/vendor/three.min.js');
            if (window.THREE) handle = buildGL(ctx, window.THREE);
          } catch (e) { handle = null; }
        }
        if (!handle) {
          try { handle = buildNebula(ctx); } catch (e2) { handle = null; }
        }
        if (!handle) {
          // 降级三：纯 CSS（fx 层留空），handle 仍提供 onLine 涟漪接口
          let rippleT = -1, clock = 0, lastV = -1;
          return {
            mode: 'css',
            onLine() { rippleT = 0; },
            onLyrics() { rippleT = 0; },
            frame(dt, info) {
              clock += dt;
              if (rippleT >= 0) { rippleT += dt; if (rippleT > 1.4) rippleT = -1; }
              const v = rippleT >= 0 ? Math.exp(-rippleT * 3.1) * (1 - rippleT / 1.4) : 0;
              // 只在变化时写（衰减到 0 后不再每帧写）
              if (Math.abs(v - lastV) > 0.004) {
                lastV = v;
                ctx.setVar('--fl-mirror-ripple', v.toFixed(3));
              }
              void info;
            },
            onParam() { /* 无 fx */ },
            dispose() { ctx.setVar('--fl-mirror-ripple', '0'); }
          };
        }
        return handle;
      })();
    }
  });
})();
