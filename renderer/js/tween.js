'use strict';
/* ============================================================
   tween.js —— 轻量补间（v10.12，替代 GSAP）
   ------------------------------------------------------------
   为什么自己写：全项目只用到 GSAP 的 9 个 fromTo + 11 个 killTweensOf，
   且全部是「事件触发、一次性衰减到 0」；timeline / 插件 / scroll / FLIP
   一个都没用。GSAP 71KB 换来的是通用引擎，这里只需要一个数值插值器。

   两种目标：
     1) 元素上的 CSS 数值变量（--fl-pop 等）：每帧 style.setProperty。
        刻意**不走** transition / animation —— .fl-line 自己带
        `transition: opacity .28s, font-size .35s, color .35s`，
        若用内联 transition 做补间会把这三条整个覆盖掉（行的淡入
        会突然变硬切）。走 style 写入则与 GSAP 完全同一条通路。
     2) 普通 JS 对象（运镜的 cut / intro 代理对象）：每帧改属性。

   缓动：只有项目用到的四条，多项式实现，与 GSAP 的 powerN.out 同式
   （power2=三次、power3=四次），数值逐点一致 —— 见 tests/tween.test.js
   的对照断言。

   与 GSAP 的语义差异（有意为之）：
     - 没有 killTweensOf：同一个目标再次 fromTo 就是「打断并重来」，
       和 `killTweensOf(x); fromTo(x, …)` 等价，所以调用点少一行。
     - clearProps 走字符串或数组，语义同 GSAP（补间结束移除内联值）。
   ============================================================ */

window.Tween = (function () {

  /* GSAP 的 power1/2/3 分别对应二次/三次/四次幂；本项目只用了 2、3 与 sine */
  const EASES = {
    'power2.out': function (t) { return 1 - Math.pow(1 - t, 3); },
    'power3.out': function (t) { return 1 - Math.pow(1 - t, 4); },
    'sine.out': function (t) { return Math.sin((t * Math.PI) / 2); },
    'linear': function (t) { return t; }
  };
  const DEF_EASE = 'power2.out';

  const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
    ? window.requestAnimationFrame.bind(window)
    : function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); };
  const caf = (typeof window !== 'undefined' && window.cancelAnimationFrame)
    ? window.cancelAnimationFrame.bind(window)
    : function (id) { clearTimeout(id); };

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /** 目标 → 正在跑的补间（WeakMap：元素销毁后自动回收，不占内存） */
  const live = new WeakMap();

  function isEl(t) { return !!t && t.nodeType === 1; }

  /** 统一成元素数组：单个元素 / NodeList / HTMLCollection 都吃 */
  function listOf(target) {
    if (!target) return [];
    if (isEl(target)) return [target];
    if (typeof target.length === 'number' && typeof target !== 'string') {
      return Array.prototype.filter.call(target, isEl);
    }
    return [];
  }

  function write(node, key, v) {
    if (isEl(node)) node.style.setProperty(key, String(v));
    else node[key] = v;
  }

  function clearProps(node, keys) {
    if (!isEl(node) || !keys) return;
    const list = typeof keys === 'string' ? keys.split(/[\s,]+/) : keys;
    for (let i = 0; i < list.length; i++) {
      if (list[i]) node.style.removeProperty(list[i]);
    }
  }

  /* ---------- 单个目标的补间 ---------- */

  function start(node, from, to, dur, ease, delay, opt) {
    stop(node);
    const keys = Object.keys(to);
    const base = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = typeof from[k] === 'number' ? from[k] : parseFloat(from[k]);
      base[k] = isFinite(v) ? v : 0;
      write(node, k, base[k]);          // 起点立即落地（打断时不残留旧值）
    }

    /* 零时长 = 立即置位（等价 GSAP 的 duration:0 set），不必等一帧 */
    if (dur <= 0 && delay <= 0) {
      for (let i = 0; i < keys.length; i++) write(node, keys[i], to[keys[i]]);
      if (opt && opt.clearProps) clearProps(node, opt.clearProps);
      return;
    }

    const t0 = now() + delay;
    const state = { keys: keys, dead: false, id: 0 };
    state.cancel = function () {
      state.dead = true;
      caf(state.id);
    };
    live.set(node, state);

    /* 用 now() 而不是 rAF 的时间戳参数：jsdom 里两者时间基准不一致
       （时间戳可能是从 0 起算的计数器），会导致补间永远停在起点。 */
    function step() {
      if (state.dead) return;
      const t = now() - t0;
      if (t < 0) { state.id = raf(step); return; }   // 还在 delay 里
      const p = dur <= 0 ? 1 : Math.min(1, t / dur);
      const k = ease(p);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        write(node, key, base[key] + (to[key] - base[key]) * k);
      }
      if (p >= 1) {
        live.delete(node);
        if (opt && opt.clearProps) clearProps(node, opt.clearProps);
        return;
      }
      state.id = raf(step);
    }

    state.id = raf(step);
  }

  /* ---------- 对外 ---------- */

  /* 控制键：与 CSS 属性区分开（GSAP 的调用习惯是把 duration/ease 写进
     目标对象里，本项目 9 个调用点全是这么写的；也接受第 4 个参数，两种都认） */
  const CTRL = { duration: 1, dur: 1, ease: 1, delay: 1, stagger: 1, clearProps: 1 };

  function pick(a, b, dflt) {
    if (a != null) return a;
    if (b != null) return b;
    return dflt;
  }

  /**
   * 从 from 补间到 to。
   * @param {Element|NodeList|object} target 元素 / 元素集合 / 普通对象
   * @param {object} from 起始值，可含 CSS 变量名（'--fl-pop'）与普通属性（opacity）
   * @param {object} to   终值（同一批键）；也可把 duration / ease / delay 写在这里
   * @param {{duration?:number,dur?:number,ease?:string,delay?:number,stagger?:number,clearProps?:string|string[]}} [opt]
   *        duration 单位秒（与 GSAP 一致）；stagger 为相邻元素的依次延迟（秒）
   */
  function fromTo(target, from, to, opt) {
    if (!target || !from || !to) return;
    const o = opt || {};

    /* 控制参数既可在 to 里（GSAP 风格），也可在第 4 个参数里（本模块风格） */
    const cfg = {
      duration: pick(o.duration, pick(to.duration, to.dur), pick(o.dur, null)),
      ease: pick(o.ease, to.ease),
      delay: pick(o.delay, to.delay, 0),
      stagger: pick(o.stagger, to.stagger, 0),
      clearProps: pick(o.clearProps, to.clearProps)
    };

    /* 真正要补间的键：滤掉控制键，避免给元素写出 style="duration: 550" 这种垃圾 */
    const end = {};
    const keys = Object.keys(to);
    for (let i = 0; i < keys.length; i++) {
      if (!CTRL[keys[i]]) end[keys[i]] = to[keys[i]];
    }
    if (!Object.keys(end).length) return;

    const dur = (cfg.duration != null ? cfg.duration : 0.3) * 1000;
    const ease = EASES[cfg.ease] || EASES[DEF_EASE];
    const delay = (cfg.delay || 0) * 1000;
    const stagger = (cfg.stagger || 0) * 1000;
    const clear = cfg.clearProps ? { clearProps: cfg.clearProps } : null;

    const els = listOf(target);
    if (els.length) {
      for (let i = 0; i < els.length; i++) {
        start(els[i], from, end, dur, ease, delay + i * stagger, clear);
      }
      return;
    }
    if (typeof target === 'object') start(target, from, end, dur, ease, delay, clear);
  }

  /** 停止目标上的补间（当前值留下，不归零） */
  function stop(target) {
    const st = live.get(target);
    if (st) { st.cancel(); live.delete(target); }
  }

  /**
   * 停止并抹掉内联值（切主题 / 销毁时用）。
   * 变量被移除后回落到 CSS 里的 `var(--fl-pop, 0)`，即初始态。
   * @param {Element|NodeList} target
   * @param {string|string[]} [extra] 额外要清理的内联属性（如 'opacity'）
   */
  function reset(target, extra) {
    const els = listOf(target);
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const st = live.get(el);
      const keys = (st && st.keys) || [];
      stop(el);
      for (let k = 0; k < keys.length; k++) el.style.removeProperty(keys[k]);
      clearProps(el, extra);
    }
  }

  /** 取缓动函数（导出给测试与调试） */
  function ease(name) { return EASES[name] || EASES[DEF_EASE]; }

  return { fromTo: fromTo, stop: stop, reset: reset, ease: ease, eases: Object.keys(EASES) };
})();
