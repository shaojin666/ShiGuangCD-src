'use strict';
/* ============================================================
   fl-themes.js —— 全屏歌词演出层「主题注册表」
   ------------------------------------------------------------
   主题是演出层的可插拔视觉单元。一个主题 = 一段 CSS（写在
   fl-stage.css 的 #fl-stage[data-theme="xxx"] 作用域里）
   + 一组可选 JS 钩子（本文件注册）。

   为什么 CSS 与 JS 分离：
   - 每帧热路径（行定位 / 词填充 / 鼓点）全部由 CSS 消费变量完成，
     主题 JS 钩子只做"一次性编排"（入场、换行重音、3D 挂载），
     不进逐帧路径 —— 这是 60fps 的纪律线。
   - 主题想改视觉，90% 的情况只需在 fl-stage.css 加一段
     [data-theme] 规则，不用动 JS。

   本文件只放轻量 CSS 级主题（流光/倾诉/回环/群唱/凝彩）。
   3D 主题「镜台 Mirror」在 fl-theme-mirror.js（独立文件，按需
   懒加载 three.js，逻辑量大单放），同样通过本注册表注册。

   主题契约（register 的 def）：
     id      唯一标识（同时作为 #fl-stage 的 data-theme 值）
     name    面板显示名
     desc    面板一句话说明
     type    'css' | 'canvas' | '3d'（面板标签用）
     icon    面板主题卡图标（内联 SVG 字符串）
     params  [{key,label,min,max,step,def,fmt}]  可选参数滑条（M2）
     mount(ctx) → handle | Promise<handle>      可选
       ctx = { stage, fx, lyrics, bg, setVar, loadScript, tween, data }
       handle = {
         onLine?(rec, idx)    当前行切换时调用（rec 为 FlLyrics 行记录）
         onLyrics?(built)     歌词重建后调用（built 为 FlLyrics.build 结果）
         onParam?(key,val)    用户在面板拖动本主题参数滑条时调用（M3，
                              需要重算内部量的主题用，如镜台粒子密度）
         frame?(dt, info)     每帧调用（info={pos,pulse,bass,level}）——
                              仅确实需要逐帧逻辑的主题才实现；Lumen 不需要。
         dispose?()           切走时清理（3D 主题必须释放 GL 上下文）
       }

   单写入纪律（与 fl-stage.css 末「帧内写入白名单」对应）：
     - 主题的 frame() 里只允许写 CSS 变量 / transform / opacity；
     - 严禁写 width/height/top/left/margin/font-size 等触发布局的属性；
     - .fl-line 的 transform 由舞台控制器的定位链路独占，主题
       （含补间模块）不得直接写 line.el.style.transform —— 要"打一拍"
       就动画一个私有变量（如 --fl-pop），让 CSS 去合成。
   ============================================================ */

window.FlThemes = (function () {

  const reg = new Map();   // id → def
  const order = [];        // 面板展示顺序

  function register(def) {
    if (!def || typeof def.id !== 'string' || !def.id) return false;
    if (reg.has(def.id)) return false;
    reg.set(def.id, def);
    order.push(def.id);
    return true;
  }

  function get(id) { return reg.get(id) || null; }
  function list() { return order.map((id) => reg.get(id)).filter(Boolean); }
  /** 默认主题 = 注册顺序第一个（流光） */
  function defaultTheme() { return reg.get(order[0]) || null; }
  function has(id) { return reg.has(id); }

  /* ---------- 主题上下文 ---------- */

  /**
   * 构造 mount(ctx) 的上下文。
   * @param {HTMLElement} stage #fl-stage 元素
   */
  function makeCtx(stage) {
    return {
      stage: stage,
      fx: stage.querySelector('#fl-fx'),
      lyrics: stage.querySelector('#fl-lyrics'),
      bg: stage.querySelector('#fl-bg'),
      /** 补间模块（renderer/js/tween.js）；测试环境未加载时为 null —— 主题必须容忍 */
      tween: (typeof window !== 'undefined' && window.Tween) ? window.Tween : null,
      /** 在舞台元素上写 CSS 变量（主题私有变量也走这里，统一出口） */
      setVar(name, value) { stage.style.setProperty(name, value); },
      /** 懒加载脚本（镜台主题按需拉 three.js；CSP script-src 'self' 允许自源注入） */
      loadScript(src) {
        return new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('load failed: ' + src));
          document.head.appendChild(s);
        });
      },
      /** 当前歌词构建结果（FlLyrics.build 返回值，见 fl-lyrics.js） */
      data: null
    };
  }

  /* ---------- 内置主题 ---------- */

  /* 图标：四角星（流光） */
  const IC_SPARK =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 2.6l2.1 5.6 5.6 2.1-5.6 2.1L12 18l-2.1-5.6L4.3 10.3l5.6-2.1z"/>'
    + '<path d="M18.6 15.6l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/></svg>';

  /**
   * 流光 Lumen（默认主题）
   * 视觉几乎全在 CSS（fl-stage.css 的 [data-theme="lumen"] 段）：
   *   当前行放大 + 光晕、随鼓点呼吸（--fl-beat）、行随播放进度滑行。
   * 这里的 JS 只做两件 CSS 做不到的事：
   *   1) 换行时给新当前行一个 补间「弹一下」的重音（动画 --fl-pop，
   *      不碰 transform —— 定位链路独占 transform，见文件头纪律）；
   *   2) 打开演出层时的入场重音。
   */
  register({
    id: 'lumen',
    name: '流光',
    nameKey: 'theme.lumen.name',
    desc: '当前行放大发光，光晕随鼓点呼吸',
    descKey: 'theme.lumen.desc',
    type: 'css',
    icon: IC_SPARK,
    mount(ctx) {
      const tween = ctx.tween;
      /** 弹一下：只动画私有变量，CSS 侧 scale(calc(1 + var(--fl-pop)*0.025)) */
      function pop(el, from, dur) {
        if (!tween || !el) return;
        try {
          tween.fromTo(el, { '--fl-pop': from }, { '--fl-pop': 0, duration: dur, ease: 'power2.out' });
        } catch (e) { /* 补间异常不影响演出 */ }
      }
      return {
        onLine(rec) { pop(rec && rec.el, 0.9, 0.55); },
        onLyrics(built) {
          // 歌词就绪后给当前行一个入场重音（没有当前行时轻弹第一行）
          const recs = built && built.recs;
          if (!recs || !recs.length) return;
          const el = (recs[0] && recs[0].el) || null;
          pop(el, 0.6, 0.9);
        },
        dispose() { /* 无持久资源 */ }
      };
    }
  });

  /* 图标：声波（倾诉） */
  const IC_WAVE =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.6" stroke-linecap="round" aria-hidden="true">'
    + '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>';

  /* 图标：轨道环（回环） */
  const IC_ORBIT =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.5" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="9.2" ry="4.2" '
    + 'transform="rotate(-22 12 12)"/><circle cx="20.4" cy="8.6" r="1.5" fill="currentColor" stroke="none"/></svg>';

  /* 图标：多声轨（群唱） */
  const IC_CHORUS =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" aria-hidden="true">'
    + '<path d="M5 20V11M12 20V4M19 20v-6"/></svg>';

  /**
   * 倾诉 Whisper
   * 私语感：小字、冷色、非当前行朦胧；全部词 span 以三组相位错峰
   * 轻摇（5.2s 周期，CSS keyframes 动画 translate——.fl-w 的 translate
   * 是自由属性，不碰定位链路）。JS 只做：
   *   1) 换行时给新当前行一次「呼吸」（补间动画私有变量 --fl-whisper-breath，
   *      CSS 侧只消费变量，不写 transform）；
   *   2) 歌词就绪时首行词逐个浮出（--fl-whisper-y 同样走变量，
   *      keyframes 里 var() 随动画实时求值）。
   */
  register({
    id: 'whisper',
    name: '倾诉',
    nameKey: 'theme.whisper.name',
    desc: '小字朦胧，像声波一样轻轻摇摆',
    descKey: 'theme.whisper.desc',
    type: 'css',
    icon: IC_WAVE,
    params: [
      { key: 'sway', labelKey: 'theme.whisper.p.sway', label: '摇摆幅度', min: 0, max: 14, step: 0.5, def: 7, unit: 'px' },
      { key: 'soft', labelKey: 'theme.whisper.p.soft', label: '朦胧度', min: 0, max: 2, step: 0.1, def: 0.9, unit: 'px' }
    ],
    mount(ctx) {
      const tween = ctx.tween;
      /** 呼吸：只动画私有变量（CSS 侧 --fl-whisper-breath 进 glow 强度 calc） */
      function breath(el) {
        if (!tween || !el) return;
        try {
          tween.fromTo(el, { '--fl-whisper-breath': 1 }, { '--fl-whisper-breath': 0, duration: 1.2, ease: 'sine.out' });
        } catch (e) { /* 补间异常不影响演出 */ }
      }
      return {
        onLine(rec) { breath(rec && rec.el); },
        onLyrics(built) {
          // 首行词逐个浮出：y 走私有变量（keyframes 里实时求值），opacity 直接补间
          const recs = built && built.recs;
          if (!tween || !recs || !recs.length) return;
          /* v10.9：弹出方式（line/word）启用时，入场整体交给揭示链——
             .fl-in 的落入动画 + 词的 w-on 门控。这里若再写 inline
             opacity 会压过揭示规则（内联样式 > 样式表），
             词门控就漏了（未唱的词会被补间强行拉亮）。 */
          if (ctx.stage && ctx.stage.dataset.reveal && ctx.stage.dataset.reveal !== 'all') return;
          const first = recs[0];
          if (!first || !first.el) return;
          const ws = first.el.querySelectorAll('.fl-w');
          if (!ws.length) return;
          try {
            tween.fromTo(ws,
              { '--fl-whisper-y': 10, opacity: 0 },
              { '--fl-whisper-y': 0, opacity: 1, duration: 0.75, stagger: 0.055, ease: 'power2.out', clearProps: 'opacity' });
          } catch (e) { /* 忽略 */ }
        },
        dispose() {
          /* 入场补间可能还在跑（切主题/关舞台）——停掉并清掉内联值。
             clearProps 管善终，这里管中途：内联 opacity 若残留，会压过
             后续主题或 v10.9 揭示规则的样式表门控（未唱的字被拉亮）；
             内联 --fl-whisper-y 若残留，字会停在被推开的偏移上。 */
          if (!tween || !ctx.lyrics) return;
          try { tween.reset(ctx.lyrics.querySelectorAll('.fl-w'), 'opacity'); } catch (e) { /* 忽略 */ }
        }
      };
    }
  });

  /**
   * 回环 Orbit
   * 跑道感：行随距离向一侧扇出（translate 独立变换属性，不碰
   * transform 定位链），带倾斜（rotate）与景深缩放（scale）；
   * 整条跑道随一个 14s 周期的相位变量缓慢漂移（frame() 15fps
   * 节流写 --fl-orbit-phase——慢漂移对帧率不敏感，省算力）。
   * JS 只做：换行轻踢（--fl-orbit-kick）、相位漂移、入口编排。
   */
  register({
    id: 'orbit',
    name: '回环',
    nameKey: 'theme.orbit.name',
    desc: '歌词沿跑道扇出，整条随节奏缓慢漂移',
    descKey: 'theme.orbit.desc',
    type: 'css',
    icon: IC_ORBIT,
    params: [
      { key: 'spread', labelKey: 'theme.orbit.p.spread', label: '扇出幅度', min: 0, max: 2.4, step: 0.05, def: 1.1, unit: 'vw' },
      { key: 'tilt', labelKey: 'theme.orbit.p.tilt', label: '倾斜角', min: 0, max: 24, step: 0.5, def: 8, unit: '°' }
    ],
    mount(ctx) {
      const tween = ctx.tween;
      let clock = 0;
      let lastPhase = -1;
      return {
        onLine(rec) {
          if (!tween || !rec || !rec.el) return;
          try {
            tween.fromTo(rec.el, { '--fl-orbit-kick': 1 }, { '--fl-orbit-kick': 0, duration: 0.7, ease: 'power3.out' });
          } catch (e) { /* 忽略 */ }
        },
        frame(dt) {
          // 相位漂移：14s 一个完整周期；15fps 节流（正弦慢变，低帧无感）
          clock += dt;
          const beat = 1 / 15;
          if (clock - lastPhase < beat) return;
          lastPhase = clock;
          ctx.setVar('--fl-orbit-phase', Math.sin(clock * (Math.PI * 2 / 14)).toFixed(3));
        },
        onLyrics(built) {
          // 入场：当前行从跑道深处摆回（kick 反向大值 → 0）
          const recs = built && built.recs;
          if (!tween || !recs || !recs.length || !recs[0] || !recs[0].el) return;
          try {
            tween.fromTo(recs[0].el, { '--fl-orbit-kick': 2.6 }, { '--fl-orbit-kick': 0, duration: 1.1, ease: 'power3.out' });
          } catch (e) { /* 忽略 */ }
        },
        dispose() { ctx.setVar('--fl-orbit-phase', '0'); }
      };
    }
  });

  /**
   * 群唱 Chorus
   * 合唱台：对唱歌曲里两条声线分立左右（duet-line 右、主唱左），
   * 当前行若带背景人声（.fl-bg），bg 块飞向两侧「翅膀」并放大，
   * 主行居中收小——形成一堵合唱墙。滑入动画走私有变量
   * --fl-chorus-slide（CSS 侧换算成 translate 独立属性的 X 分量）。
   */
  register({
    id: 'chorus',
    name: '群唱',
    nameKey: 'theme.chorus.name',
    desc: '对唱分列左右，背景人声飞向两侧成合唱墙',
    descKey: 'theme.chorus.desc',
    type: 'css',
    icon: IC_CHORUS,
    params: [
      { key: 'gap', labelKey: 'theme.chorus.p.gap', label: '分列间距', min: 6, max: 46, step: 1, def: 24, unit: 'vw' },
      { key: 'lift', labelKey: 'theme.chorus.p.lift', label: '人声放大', min: 0.8, max: 1.4, step: 0.02, def: 1.12, unit: '×' }
    ],
    mount(ctx) {
      const tween = ctx.tween;
      function markBg(rec) {
        const el = rec && rec.el;
        if (!el) return;
        const hasBg = !!(rec.bgs && rec.bgs.length);
        el.classList.toggle('has-bg', hasBg);
        if (!hasBg || !tween) return;
        try {
          tween.fromTo(el, { '--fl-chorus-slide': 1 }, { '--fl-chorus-slide': 0, duration: 0.85, ease: 'power2.out' });
        } catch (e) { /* 忽略 */ }
      }
      return {
        onLine(rec) { markBg(rec); },
        onLyrics(built) {
          // 歌词就绪时按当前行补一次标记（open 时可能已有当前行）
          const recs = built && built.recs;
          if (!recs || !recs.length) return;
          const cur = recs.find((r) => r.el && r.el.classList.contains('active'));
          if (cur) markBg(cur);
        },
        dispose() { /* 无持久资源 */ }
      };
    }
  });

  /* 图标：棱镜（三角形 + 入射/出射光线） */
  const IC_PRISM =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 3.4L20.6 19H3.4z"/><path d="M2.6 8.6h6.2M15.2 8.6h6.2"/>'
    + '<path d="M14 12.6h2.4M7.6 12.6H10" opacity="0.65"/></svg>';

  /**
   * 凝彩 Prism
   * 棱镜感：当前行是一道被折射的光带——红青色散边缘（stretch
   * 控制错位量）、玻璃质渐变底（sheen 控制强度），背景一座
   * 40s 慢转的棱镜光锥（CSS conic-gradient，transform 旋转，
   * 合成器执行）。JS 只做换行时的一次「耀斑」（补间动画私有
   * 变量 --fl-prism-flare，CSS 侧只消费变量）。
   */
  register({
    id: 'prism',
    name: '凝彩',
    nameKey: 'theme.prism.name',
    desc: '歌词化作棱镜光带，色散边缘随节奏耀斑',
    descKey: 'theme.prism.desc',
    type: 'css',
    icon: IC_PRISM,
    params: [
      { key: 'stretch', labelKey: 'theme.prism.p.stretch', label: '色散强度', min: 0, max: 1.6, step: 0.05, def: 0.7, unit: 'px' },
      { key: 'sheen', labelKey: 'theme.prism.p.sheen', label: '玻璃光泽', min: 0, max: 1, step: 0.05, def: 0.5, unit: '' }
    ],
    mount(ctx) {
      const tween = ctx.tween;
      /** 耀斑：只动画私有变量（CSS 侧进 active 行光边亮度 calc） */
      function flare(el) {
        if (!tween || !el) return;
        try {
          tween.fromTo(el, { '--fl-prism-flare': 1 }, { '--fl-prism-flare': 0, duration: 0.9, ease: 'power2.out' });
        } catch (e) { /* 补间异常不影响演出 */ }
      }
      return {
        onLine(rec) { flare(rec && rec.el); },
        onLyrics(built) {
          const recs = built && built.recs;
          if (!recs || !recs.length) return;
          flare(recs[0] && recs[0].el);
        },
        dispose() { /* 无持久资源 */ }
      };
    }
  });

  /* ============================================================
     v10.9 · 3D 运镜 rig（跃迁 Warp / 星环 Halo 共用）
     ------------------------------------------------------------
     镜头语言（电影感运镜，全部作用在 #fl-lyrics 这一个元素上）：
       1) 基础环绕：正弦轨道——镜头绕场景中心缓慢左右/上下扫；
       2) 鼓点推近：低频把镜头往前顶、脉冲再补一小段（音乐驱动运镜）；
       3) 指针视差：鼠标位置映射成镜头偏移（低通平滑，不跳变）；
       4) 换行切镜：补间一次性「鞭打」（whip）——yaw/pitch 快速
          踢一下再归零，像电影换镜头的微晃；
       5) 入场揭示：歌词就绪时镜头从深处推近（intro 1→0）。
     纪律（与文件头一致）：
       - 唯一写入点是 frame() 里 #fl-lyrics 的 transform 一次
         （合成属性；will-change 由主题 CSS 加）——绝不碰
         .fl-line 的 transform（定位链路由舞台独占）；
       - 补间只踢 JS 对象（cut/intro），不进逐帧路径；
       - 参数滑条值每帧从 stage 的 inline --fl-p-* 读（与镜台
         density() 同模式，不读 computed style）；
       - 补间模块缺失（测试环境）时切镜静默降级，演出不中断。
     ============================================================ */
  function makeCamRig(ctx, opt) {
    const lyrics = ctx.lyrics;
    const stage = ctx.stage;
    const tween = ctx.tween;
    if (!lyrics) return { onLine() {}, onLyrics() {}, frame() {}, dispose() {} };
    let clock = 0;
    let px = 0, py = 0, tpx = 0, tpy = 0;          // 指针视差：现值 / 目标值
    /* 切镜通道：旋转（yaw/pitch）+ 平移（push=Z 轴穿梭 / x,y=横向闪避）。
       全部由补间一次性编排踢回零，帧内只读——热路径无补间。 */
    const cut = { yaw: 0, pitch: 0, push: 0, x: 0, y: 0 };
    const intro = { v: 1 };                         // 入场推近（1→0）
    let alive = true;

    function onMove(e) {
      if (!alive) return;
      tpx = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
      tpy = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
    }
    stage.addEventListener('pointermove', onMove, { passive: true });

    /** 读主题参数滑条现值（inline --fl-p-*，与镜台 density() 同模式） */
    function amp(key, def) {
      const v = parseFloat(stage.style.getPropertyValue('--fl-p-' + key));
      return isFinite(v) && v >= 0 ? v : def;
    }

    return {
      /** 换行穿梭：镜头向前穿过刚就位的行、横向闪到另一侧——方向交替
          （来回编织），像在歌词行之间穿行。强度读 --fl-p-dash（0=关）。 */
      dash(dir) {
        if (!alive) return;
        const k = amp('dash', 1);
        if (k <= 0.001 || !tween) return;
        try {
          tween.fromTo(cut,
            { yaw: dir * opt.kickYaw, pitch: -dir * opt.kickPitch,
              push: opt.dashPush * k, x: dir * opt.dashX * k, y: -dir * opt.dashY * k },
            { yaw: 0, pitch: 0, push: 0, x: 0, y: 0, duration: 1.15, ease: 'power3.out' });
        } catch (e) { /* 补间异常不影响演出 */ }
      },
      /** 入场：镜头从深处推近（歌词就绪/切轨重建时） */
      intro() {
        if (!tween) { intro.v = 0; return; }
        try {
          tween.fromTo(intro, { v: 1 }, { v: 0, duration: 1.5, ease: 'power2.out' });
        } catch (e) { intro.v = 0; }
      },
      frame(dt, info) {
        if (!alive) return;
        clock += dt;
        const sway = amp('sway', 1);
        const push = amp('push', 1);
        // 指针低通（帧率无关的一阶惯性）
        const k = Math.min(1, dt * 6);
        px += (tpx - px) * k;
        py += (tpy - py) * k;
        const bass = (info && info.bass) || 0;
        const pulse = (info && info.pulse) || 0;
        const yaw = Math.sin(clock * 0.13) * opt.swayYaw * sway + px * opt.parallax * sway + cut.yaw;
        const pitch = Math.sin(clock * 0.19 + 1.3) * opt.swayPitch * sway - py * opt.parallax * 0.72 * sway + cut.pitch;
        const crane = Math.sin(clock * 0.11 + 0.7) * opt.crane * sway + cut.y;
        const dolly = Math.sin(clock * 0.07) * opt.dolly * push
          + bass * opt.bassPush + pulse * opt.pulsePush + cut.push
          - intro.v * opt.introBack;
        /* 变换顺序（CSS 从左到右即矩阵从左乘）：先沿本地 Z 推轨，
           再环绕/俯仰——transform-origin 在屏幕中心，等于一架
           三脚架上的电影摄影机。写入走合成层，不触布局。 */
        lyrics.style.transform = 'rotateX(' + pitch.toFixed(2) + 'deg) rotateY(' + yaw.toFixed(2)
          + 'deg) translate3d(' + cut.x.toFixed(1) + 'px, ' + crane.toFixed(1) + 'px, ' + dolly.toFixed(1) + 'px)';
      },
      dispose() {
        alive = false;
        stage.removeEventListener('pointermove', onMove);
        if (tween) { try { tween.stop(cut); tween.stop(intro); } catch (e) { /* 忽略 */ } }
        lyrics.style.transform = '';
      }
    };
  }

  /* 图标：跃迁（隧道——同心椭圆向深处收拢 + 速度线） */
  const IC_WARP =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-linecap="round" aria-hidden="true">'
    + '<ellipse cx="12" cy="12" rx="10.4" ry="6.8" stroke-width="1.2" opacity="0.45"/>'
    + '<ellipse cx="12" cy="12" rx="6.6" ry="4.4" stroke-width="1.4" opacity="0.72"/>'
    + '<ellipse cx="12" cy="12" rx="2.8" ry="1.9" stroke-width="1.7"/>'
    + '<path d="M2.6 6.4h3M2.6 17.6h3" stroke-width="1.4"/></svg>';

  /* 图标：星环（倾斜环 + 环上卫星点） */
  const IC_HALO =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-linecap="round" aria-hidden="true">'
    + '<ellipse cx="12" cy="12" rx="9.6" ry="4.2" stroke-width="1.4" transform="rotate(-18 12 12)"/>'
    + '<circle cx="12" cy="12" r="2.3" stroke-width="1.5"/>'
    + '<circle cx="19.4" cy="8.6" r="1.3" fill="currentColor" stroke="none"/></svg>';

  /**
   * 跃迁 Warp（v10.9 · 3D 运镜）
   * 歌词赛道：行按与当前行的距离（--ad）沉入 Z 轴深处并微微后仰，
   * 未唱的行在雾中变小；唱到的行「跃迁」到镜前最大最亮。逐字
   * 弹出（word 模式）时，未唱的词沉在 -46px 深处，唱到才向观众
   * 弹出——歌词本身在三维空间里演出。
   * 运镜：见 makeCamRig（环绕 + 鼓点推近 + 指针视差 + **换行穿梭**）。
   * v10.9.1：行距拉近（字更大看得清），换行时镜头向前穿过刚就位的
   * 行、横向闪到另一侧——在歌词行之间穿行（dash 参数可调强度）。
   * 三维空间：#fl-stage 出 perspective， rig 是 #fl-lyrics
   * （JS 每帧写一次 transform），.fl-line 只用 translate/rotate
   * 独立属性——定位链的 transform 始终归舞台。
   */
  register({
    id: 'warp',
    name: '跃迁',
    nameKey: 'theme.warp.name',
    desc: '歌词赛道沉入深处，唱到的行跃迁到镜前，镜头在行间穿梭（3D 运镜）',
    descKey: 'theme.warp.desc',
    type: '3d',
    icon: IC_WARP,
    params: [
      { key: 'depth', labelKey: 'theme.warp.p.depth', label: '景深强度', min: 0, max: 2.4, step: 0.05, def: 1, unit: '×' },
      { key: 'sway', labelKey: 'theme.warp.p.sway', label: '运镜幅度', min: 0, max: 2.4, step: 0.05, def: 1, unit: '×' },
      { key: 'push', labelKey: 'theme.warp.p.push', label: '推轨幅度', min: 0, max: 2.4, step: 0.05, def: 1, unit: '×' },
      { key: 'dash', labelKey: 'theme.warp.p.dash', label: '穿梭强度', min: 0, max: 2.4, step: 0.05, def: 1, unit: '×' }
    ],
    mount(ctx) {
      const rig = makeCamRig(ctx, {
        swayYaw: 4.6, swayPitch: 2.5, crane: 14, dolly: 26,
        parallax: 2.4, bassPush: 14, pulsePush: 6, introBack: 150,
        kickYaw: 2.6, kickPitch: 1.2, dashPush: 150, dashX: 24, dashY: 8
      });
      let n = 0;
      return {
        onLine() { rig.dash((n++ % 2 === 0) ? 1 : -1); },
        onLyrics() { rig.intro(); },
        frame(dt, info) { rig.frame(dt, info); },
        dispose() { rig.dispose(); }
      };
    }
  });

  /**
   * 星环 Halo（v10.9 · 3D 运镜）
   * 环幕：歌词行排在一条绕镜头旋转的圆环上——按与当前行的角度差
   * （--d 带符号、含滑行）排布，行面朝环心（= 观众）。歌唱进度
   * 推进时，整条环幕缓缓转动，未唱的行从镜头两侧掠过、沉入环
   * 的背后；当前行永远停在镜面正前方。镜头在环心附近环绕、推
   * 轨、升降——像在星环里穿行。
   * v10.9.1：环半径拉近（字更大），换行时镜头横向闪避、穿过旋转
   * 而来的行隙——在歌词行之间穿梭（dash 参数可调强度）。
   * 圆环几何用多项式近似（Chromium 108 无 CSS sin/cos）：
   *   sin θ ≈ θ - θ³/6，cos θ - 1 ≈ -θ²/2 + θ⁴/24，θ = --d × 步距。
   * 误差在 |θ|≤45° 内 < 2%，肉眼不可辨；全部走 CSS 变量，
   * 零逐帧 JS 写入（热路径只多 rig 的一次 transform）。
   */
  register({
    id: 'halo',
    name: '星环',
    nameKey: 'theme.halo.name',
    desc: '歌词排成环幕绕镜旋转，镜头在星环中穿行（3D 运镜）',
    descKey: 'theme.halo.desc',
    type: '3d',
    icon: IC_HALO,
    params: [
      { key: 'radius', labelKey: 'theme.halo.p.radius', label: '环半径', min: 0.4, max: 2, step: 0.05, def: 1, unit: '×' },
      { key: 'spread', labelKey: 'theme.halo.p.spread', label: '环距角', min: 5, max: 20, step: 0.5, def: 11, unit: '°' },
      { key: 'sway', labelKey: 'theme.halo.p.sway', label: '运镜幅度', min: 0, max: 2.4, step: 0.05, def: 1, unit: '×' },
      { key: 'dash', labelKey: 'theme.halo.p.dash', label: '穿梭强度', min: 0, max: 2.4, step: 0.05, def: 1, unit: '×' }
    ],
    mount(ctx) {
      const rig = makeCamRig(ctx, {
        swayYaw: 3.4, swayPitch: 2, crane: 10, dolly: 18,
        parallax: 2, bassPush: 10, pulsePush: 4, introBack: 120,
        kickYaw: 2, kickPitch: 0.9, dashPush: 90, dashX: 46, dashY: 12
      });
      let n = 0;
      return {
        onLine() { rig.dash((n++ % 2 === 0) ? 1 : -1); },
        onLyrics() { rig.intro(); },
        frame(dt, info) { rig.frame(dt, info); },
        dispose() { rig.dispose(); }
      };
    }
  });

  /* ---------- 文案（i18n）----------
     主题名 / 描述 / 参数名在设置页、演出层面板、Toast 三处都会出现，
     统一从这里取，避免三处各翻一遍导致文案分叉。
     def.name / def.desc 保留中文原文作为兜底（i18n 未就绪时仍可用）。 */

  function nameOf(def) {
    if (!def) return '';
    return (def.nameKey && typeof T === 'function') ? T(def.nameKey) : (def.name || '');
  }

  function descOf(def) {
    if (!def) return '';
    return (def.descKey && typeof T === 'function') ? T(def.descKey) : (def.desc || '');
  }

  function paramLabel(def, p) {
    if (!p) return '';
    return (p.labelKey && typeof T === 'function') ? T(p.labelKey) : (p.label || p.key || '');
  }

  return { register, get, list, has, defaultTheme, makeCtx, nameOf, descOf, paramLabel };
})();
