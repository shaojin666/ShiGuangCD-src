'use strict';
/* ============================================================
   floating.js —— 桌面悬浮歌词（渲染端）
   ------------------------------------------------------------
 * 三件事，刻意都做得很简单：

 * 1) **移动窗口 = CSS**。顶部 `#dragbar` 上是 `-webkit-app-region: drag`，
 *    和主窗口顶栏完全同一个原理，由 Chromium/系统直接搬窗口。
 *    这里**没有任何** mousemove + setPosition 的自绘拖动代码 ——
 *    之前那套不但每次事件要跨进程传一次坐标（鼠标轮询率可达 1000Hz，
 *    每秒几千次同步 IPC，CPU 占用奇高），还因为坐标换算与手势状态
 *    的各种边界情况，出现过"拖着拖着窗口自己变形/变大"。
 *    交给系统就没有这些问题。
 *    （v10.7：v10.6 曾在底板加过"长按拖动"，用户实测拖中间仍会把窗口
 *    拉伸，已整段移除 —— 移动窗口只认顶部拖动条，四角只认缩放。）

 * 2) **缩放窗口 = 四个角**。角落是小而明确的视觉符号，误判概率极低。
 *    只在按下角时才进入缩放模式；底板其余部分按下什么都不做
 *    （中键锁定、悬停显示控件都靠它）。
 *    ★ 浏览器里"窗口可缩放"(resizable) 一律关掉：它会引入一圈看不见的
 *      系统缩放边框，拖动时会冷不丁被系统接管去改尺寸 ——
 *      日志里确认过是这条路径在把窗口撑大。

 * 3) **歌词内容以推送为准**。三行各绑固定角色，每次推送都按角色覆盖文本。
 *    ★ 早期版本靠"三行轮转"做滚动，一旦漏收/多收一次推送，角色与内容就
 *      永久错位（表现就是"当前歌词对不上"，且不每次复现）。
 *      现在文本永远等于主进程推来的值，动画只决定"怎么显示"。
 * ============================================================ */

(() => {
  const root = document.documentElement;
  const body = document.body;
  const stage = document.getElementById('stage');
  const plate = document.getElementById('plate');
  const track = document.getElementById('track');
  const controls = document.getElementById('controls');
  const lockhint = document.getElementById('lockhint');
  const fsize = document.getElementById('fsize');
  const fsizeVal = document.getElementById('fsize-val');
  const custom = document.getElementById('custom');
  const swatches = document.getElementById('swatches');

  /** 三行固定角色：-1 上一行 / 0 当前行 / +1 下一行（永不轮转） */
  const byRole = {
    '-1': track.querySelector('[data-slot="0"]'),
    '0': track.querySelector('[data-slot="1"]'),
    '1': track.querySelector('[data-slot="2"]')
  };

  /**
   * 多语言（v10.11）：悬浮窗是独立窗口，拿不到主界面的 I18n 状态，
   * 语言由主进程随 float:init / float:lang 推过来。
   * 窗口在 body.ready 之后才显示（见文件末尾的 reveal），所以首帧前
   * 定语言不会闪一下简体中文。
   * 静态文案靠 HTML 上的 data-i18n* 由 I18n.apply() 统一回填，
   * 这里不需要逐条改文本。
   */
  function applyLang(lang) {
    if (!lang) return;
    I18n.setLang(lang, { silent: true });
    I18n.apply();
  }

  const NEAR_PX = 80;      // 鼠标靠近多少像素内淡入控件
  const HIDE_MS = 2200;    // 静止多久后淡出
  const FLOAT_MS = 5000;   // 换行后让"上下浮动"跑多久
  const THROTTLE_MS = 60;  // 悬停判定的 mousemove 节流

  let locked = false;
  let armed = false;
  let hideTimer = null;
  let floatTimer = null;
  let floatAlways = false; // 设置里手动打开 → 一直浮动
  let lastMoveAt = 0;
  let inited = false;
  let resizing = null;     // 正在缩放：'nw' | 'ne' | 'sw' | 'se'
  let lastX = 0;
  let lastY = 0;
  let lastMoveRun = 0;
  let pendingMove = null;
  let resizeRaf = 0;

  let lastPrev = '';
  let lastCur = '';
  let lastNext = '';
  let lastKey = '';   // renderLyrics 的去重键（行号 + 行起点 + 三行文本）

  /* ---------- 外观 ---------- */

  function applyColor(c) {
    if (typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c)) return;
    const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(c);
    const r = m ? parseInt(m[1], 16) : 233;
    const g = m ? parseInt(m[2], 16) : 227;
    const b = m ? parseInt(m[3], 16) : 216;
    root.style.setProperty('--fg', c);
    // 未唱词的暗态：与文字同色系、低透明度 —— 换任何颜色都有"暗→亮"的层次
    root.style.setProperty('--fg-dim', 'rgba(' + r + ',' + g + ',' + b + ',0.42)');
    root.style.setProperty('--glow-dim', 'rgba(' + r + ',' + g + ',' + b + ',0.16)');
    // 辉光：与文字同色，给两圈 —— 近的一圈偏实、远的一圈散。
    // ★ 必须写成两个变量：text-shadow 是逗号分隔的多层列表，
    //   把两个颜色塞进同一个变量展开后第二层没有偏移量，整条声明会作废
    //   （computed 变成 none，辉光直接消失）。
    root.style.setProperty('--glow-in', 'rgba(' + r + ',' + g + ',' + b + ',0.55)');
    root.style.setProperty('--glow-out', 'rgba(' + r + ',' + g + ',' + b + ',0.28)');
    // 底板跟着文字亮度走：浅色字配深底板、深色字配浅底板，任何颜色都有对比度
    const lum = m ? (0.299 * r + 0.587 * g + 0.114 * b) / 255 : 1;
    const dark = lum >= 0.5;
    root.style.setProperty('--plate-bg', dark ? 'rgba(14, 14, 18, 0.82)' : 'rgba(248, 246, 240, 0.9)');
    root.style.setProperty('--chip-bg', dark ? 'rgba(14, 14, 18, 0.9)' : 'rgba(248, 246, 240, 0.94)');
    root.style.setProperty('--chip-line', dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)');
    if (custom.value !== c) custom.value = c;
    const list = swatches.querySelectorAll('.sw');
    for (let i = 0; i < list.length; i++) {
      list[i].classList.toggle('on', list[i].dataset.color.toLowerCase() === c.toLowerCase());
    }
  }

  /**
   * 字号：只改 --fs，一个像素都不动窗口。
   * 文字变大变挤是用户自己拉窗口该管的事。
   */
  function applySize(px) {
    const n = Math.max(12, Math.min(64, Math.round(Number(px) || 22)));
    root.style.setProperty('--fs', n + 'px');
    if (fsize.value !== String(n)) fsize.value = String(n);
    fsizeVal.textContent = String(n);
  }

  /* ---------- 歌词 ---------- */

  /** 重新触发一次入场动画（先摘 class 再强制回流，否则不会重播） */
  function replayLineIn() {
    track.classList.remove('adv');
    void track.offsetWidth;
    track.classList.add('adv');
  }

  /**
   * "上下浮动"很贵：透明置顶窗口 + 动画 = 合成器每帧重混窗口背后的桌面，
   * 窗口越大越费。所以只在**换行后的几秒内**跑，用户正在看的那一下才有效果，
   * 静止时完全不跑。设置里手动打开才会一直浮动。
   */
  function pulseFloat() {
    if (floatAlways) { body.classList.add('float-on'); return; }
    body.classList.add('float-on');
    if (floatTimer) clearTimeout(floatTimer);
    floatTimer = setTimeout(() => {
      floatTimer = null;
      if (!floatAlways) body.classList.remove('float-on');
    }, FLOAT_MS);
  }

  function setFloatAnim(on) {
    floatAlways = on === true;
    if (floatTimer) { clearTimeout(floatTimer); floatTimer = null; }
    if (floatAlways) body.classList.add('float-on');
    else body.classList.remove('float-on');
  }

  /**
   * 写入歌词。文本永远来自推送值、逐角色覆盖 —— 不做任何"增量推断"，
   * 所以漏收一次推送、收到重复推送、跳播、换碟都不会让三行错位。
   *
   * 逐字模式（info.words 非空）：当前行拆成词 span，每个词按
   * "词的绝对时间 - 推送时刻播放位置"设 animation-delay / duration，
   * 跑一次 CSS 填充补间。不为逐字开高频 IPC（见 setLyrics 的注释）——
   * 行内拖动进度条时悬浮窗的词填充会停在旧状态，直到下一行重新推送，
   * 这是刻意接受的近似：悬浮窗是副显，精确词同步不值得付出 CPU 代价。
   */
  function renderLyrics(info) {
    if (!info) return;
    const text = info.text || '';
    const prev = info.prev || '';
    const next = info.next || '';
    const tr = info.tr || '';
    const ro = info.ro || '';
    const words = (Array.isArray(info.words) && info.words.length) ? info.words : null;
    const bg = (Array.isArray(info.bg) && info.bg.length) ? info.bg : null;

    body.classList.toggle('playing', !!info.playing);
    plate.classList.toggle('has-text', !!text);
    /*
     * 去重键带上行号与行起点：同一行被重复推送（暂停后续播、刷新元数据）
     * 时跳过重建；而"拖回进度重播同一行"时键虽相同 —— 那种情况压根不会
     * 重新推送（主界面只在行号变化时 emit），所以没有重建需求。
     * 键里也带上译/音/对唱签名：它们随行推送，变了就该重建（v10.6）。
     * v10.7：duet 结构（has + 主 agent）与行/条目 agent 也进键 ——
     *   换一首对唱结构不同的歌，类名（duet-line / bg-duet）必须重算。
     */
    const bgSig = bg ? bg.map((b) => ((b && b.agent) || '') + ':' + ((b && b.text) || '')).join('\u0001') : '';
    const duetSig = (info.duet && info.duet.has) ? ('D' + (info.duet.main || '')) : '';
    const key = (info.index || 0) + '|' + (info.t != null ? info.t : '') + '|' + text + '|' + prev + '|' + next +
                '|' + tr + '|' + ro + '|' + bgSig + '|' + duetSig + '|' + (info.agent || '');
    if (key === lastKey) return;
    lastKey = key;

    // 只有"正好接着上一句往下走"才播入场动画；跳播/换碟/首次直接落位
    const advance = !!lastCur && text === lastNext && text !== lastCur;

    byRole['-1'].textContent = prev;
    byRole['1'].textContent = next;
    buildCurrentLine(text, tr, ro, words, bg, info);
    lastPrev = prev;
    lastCur = text;
    lastNext = next;

    if (advance) { replayLineIn(); pulseFloat(); }
    else track.classList.remove('adv');
  }

  /*
   * 英文词间空格（v10.6，与主界面 lyrics-view.js 同规则）：
   * TTML / 增强 LRC 的词级数据里词与词之间没有空格字符，直接挨着放会把
   * "hello world" 显示成 "helloworld"。
   *   - 仅当两侧都是拉丁字母/数字（含拉丁扩展区，覆盖法德西等变音）→ 补；
   *   - CJK 词之间不补（否则"遥远"会变成"遥 远"）。
   */
  function needsSpace(prev, cur) {
    if (!prev || !cur) return false;
    if (/\s$/.test(prev) || /^\s/.test(cur)) return false;
    if (/-$/.test(prev) || /^-/.test(cur)) return false;
    return /[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]$/.test(prev) &&
           /^[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]/.test(cur);
  }

  /**
   * 当前行：逐字模式拆词 span + 译文/罗马音小字 + 对唱（背景人声）块；
   * 经典模式整行纯文本。
   * v10.7 对唱排版（与主界面 lyrics-view.js 同规则）：
   *   - 歌曲含对唱（info.duet.has）时，行按 agent 打 duet-line 类（靠左），
   *     bg 块按 agent 打 bg-duet（靠左）/ bg-main（跟随宿主，靠右）；
   *   - 不含对唱：整行居中，bg 块也不打类（CSS 不启用左右规则）。
   * bg 词（.bw）同样跑填充补间（bw-fill，暗一档的亮度），不再静态展示。
   */
  function buildCurrentLine(text, tr, ro, words, bg, info) {
    const line = byRole['0'];
    line.textContent = '';
    line.classList.remove('duet-line');
    if (!text) return;
    const duet = (info && info.duet && info.duet.has) ? info.duet : null;
    if (duet && info.agent && info.agent !== duet.main) line.classList.add('duet-line');
    if (words) {
      const at = (typeof info.at === 'number' && isFinite(info.at)) ? info.at : (info.t || 0);
      let n = 0;
      let prevX = '';
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (!w || typeof w.x !== 'string' || !w.x) continue;
        if (n > 0 && needsSpace(prevX, w.x)) {
          line.appendChild(document.createTextNode(' '));
        }
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = w.x;
        if (typeof w.e === 'number' && w.e <= at) {
          span.classList.add('sung');           // 推送时已经唱过：直接落终态
        } else {
          const from = Math.max(at, w.t || 0);  // 唱到一半的词：补间剩下一段
          // 取整到毫秒：秒相减的浮点误差会产出 400.00000000000034ms 这种值
          const delay = Math.round(Math.max(0, (w.t || 0) - at) * 1000);
          const dur = Math.max(60, Math.round((w.e - from) * 1000));
          if (delay > 0) span.style.animationDelay = delay + 'ms';
          span.style.animationDuration = dur + 'ms';
        }
        line.appendChild(span);
        prevX = w.x;
        n++;
      }
      if (!n) line.textContent = text;
    } else {
      line.textContent = text;
    }
    /* 对唱（背景人声）：每条一个块。v10.7 起词级时间也用于跑 bw-fill
       补间（暗一档的"已唱"亮度），排版左右由 duet-line / bg-duet /
       bg-main 类控制（见 floating.css）。 */
    if (bg) {
      const at = (typeof info.at === 'number' && isFinite(info.at)) ? info.at : (info.t || 0);
      for (let i = 0; i < bg.length; i++) {
        const b = bg[i];
        if (!b || typeof b.text !== 'string' || !b.text) continue;
        const blk = document.createElement('span');
        blk.className = 'bg';
        if (duet) blk.classList.add(b.agent && b.agent !== duet.main ? 'bg-duet' : 'bg-main');
        const bwords = (Array.isArray(b.words) && b.words.length) ? b.words : null;
        if (bwords) {
          if (!appendBgWords(blk, bwords, at)) blk.textContent = b.text;
        } else {
          blk.textContent = b.text;
        }
        line.appendChild(blk);
      }
    }
    if (tr) {
      const t = document.createElement('span');
      t.className = 'tr';
      t.textContent = tr;
      line.appendChild(t);
    }
    if (ro) {
      const r = document.createElement('span');
      r.className = 'ro';
      r.textContent = ro;
      line.appendChild(r);
    }
  }

  /**
   * 对唱块内的词（v10.7）：与主线词同构 —— 拆 span、按绝对时间写
   * animation-delay / duration，跑 bw-fill 补间（终点亮度比主线暗一档）。
   * 已唱过的词直接落终态（.sung）。
   * @returns {number} 实际插入的词数
   */
  function appendBgWords(container, list, at) {
    let prevX = '';
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (!w || typeof w.x !== 'string' || !w.x) continue;
      if (n > 0 && needsSpace(prevX, w.x)) {
        container.appendChild(document.createTextNode(' '));
      }
      const span = document.createElement('span');
      span.className = 'bw';
      span.textContent = w.x;
      if (typeof w.e === 'number' && w.e <= at) {
        span.classList.add('sung');
      } else {
        const from = Math.max(at, w.t || 0);
        const delay = Math.round(Math.max(0, (w.t || 0) - at) * 1000);
        const dur = Math.max(60, Math.round((w.e - from) * 1000));
        if (delay > 0) span.style.animationDelay = delay + 'ms';
        span.style.animationDuration = dur + 'ms';
      }
      container.appendChild(span);
      prevX = w.x;
      n++;
    }
    return n;
  }

  /**
   * 译/音显隐（v10.6，设置页开关经主进程推来）。
   * 只切 body 类、不重建歌词：显隐完全由 CSS（.no-tr .tr / .no-ro .ro）控制，
   * 反复切换零布局成本。undefined 表示"载荷里没带这项"，不动它。
   */
  function setShowOpts(showTr, showRo) {
    if (typeof showTr === 'boolean') body.classList.toggle('no-tr', !showTr);
    if (typeof showRo === 'boolean') body.classList.toggle('no-ro', !showRo);
  }

  /* ---------- 悬停显示 / 自动隐藏 ---------- */

  function armHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      controls.classList.remove('show');
      lockhint.classList.remove('show');
    }, HIDE_MS);
  }

  function showControls() {
    if (locked) return;
    if (!controls.classList.contains('show')) controls.classList.add('show');
    armHide();
  }

  function showLockHint() {
    if (!locked) return;
    if (!lockhint.classList.contains('show')) lockhint.classList.add('show');
    armHide();
  }

  /**
   * 文字块（而不是整个底板）的矩形。
   * 锁定态下"布防"范围要用它：底板等于整个窗口，若拿底板当布防范围，
   * 锁定后指针一进窗口就布防，点击几乎全被吞掉，穿透就失去意义了。
   */
  function textRect() { return track.getBoundingClientRect(); }

  function nearText(x, y) {
    const r = textRect();
    if (!r.width && !r.height) return true;
    const nx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
    const ny = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
    return Math.max(nx, ny) <= NEAR_PX;
  }

  function inText(x, y) {
    const r = textRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function onMove(x, y) {
    if (locked) {
      // 只有指针进入**文字块**才布防，好让中键点击收得到
      const inside = inText(x, y);
      if (inside && !armed) {
        armed = true;
        window.cd.invoke('float:arm').catch(() => {});
      } else if (!inside && armed) {
        armed = false;
        window.cd.invoke('float:rearm').catch(() => {});
      }
      if (nearText(x, y)) showLockHint();
      else lockhint.classList.remove('show');
      return;
    }
    if (nearText(x, y)) {
      body.classList.remove('away');
      showControls();
    } else if (!resizing) {
      armHide();
    }
  }

  /* ---------- 锁定 ---------- */

  function applyLocked(next) {
    locked = !!next;
    body.classList.toggle('locked', locked);
    body.classList.toggle('unlocked', !locked);
    controls.classList.remove('show');
    lockhint.classList.remove('show');
    if (!locked) {
      if (armed) { armed = false; window.cd.invoke('float:rearm').catch(() => {}); }
      body.classList.remove('away');
      showControls();
    }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (resizing) endResize();
  }

  /* ---------- 缩放（仅四角） ---------- */

  /**
   * 每帧最多发一次。
   * ★ pointermove 按鼠标轮询率触发（可达 1000Hz），而主进程每次要做
   *   多次同步 IPC，不合帧就是每秒几千次往返。合帧后仍逐帧跟手。
   * 坐标不经过渲染端：主进程按锚点 + 系统光标重算目标位置，
   * 不存在增量累加导致的自我放大。
   */
  function resizeStep() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (resizing) {
        window.cd.invoke('float:resize', { edge: resizing }).catch(() => {});
      }
    });
  }

  function endResize() {
    if (!resizing) return;
    resizing = null;
    if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
    window.cd.invoke('float:resize-end').catch(() => {});
  }

  // 把手：pointerdown 落点带 data-edge 才算缩放，其余一律不算
  stage.addEventListener('pointerdown', (e) => {
    if (locked || e.button !== 0) return;
    const edge = e.target && e.target.dataset ? (e.target.dataset.edge || '') : '';
    if (!edge) return;
    resizing = edge;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    window.cd.invoke('float:resize-start', { edge: edge }).catch(() => {});
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    if (e.buttons === 0) { endResize(); return; }   // 漏掉的松手兜底
    resizeStep();
  });
  stage.addEventListener('pointerup', endResize);
  stage.addEventListener('pointercancel', endResize);
  window.addEventListener('blur', endResize);

  /* ---------- 事件 ---------- */

  document.addEventListener('mousemove', (e) => {
    lastMoveAt = Date.now();
    lastX = e.clientX;
    lastY = e.clientY;
    if (resizing) return;
    // 悬停判定要节流：锁定态下 forward:true 会把指针的每一个 move
    // 都从合成器转发到渲染进程，一甩鼠标每秒能来上百个。
    const now = Date.now();
    const wait = THROTTLE_MS - (now - lastMoveRun);
    if (wait <= 0) {
      lastMoveRun = now;
      onMove(e.clientX, e.clientY);
    } else if (!pendingMove) {
      pendingMove = setTimeout(() => {
        pendingMove = null;
        lastMoveRun = Date.now();
        onMove(lastX, lastY);
      }, wait);
    }
  }, { passive: true });

  document.addEventListener('mouseleave', () => {
    if (resizing) endResize();
    if (locked) {
      if (armed) { armed = false; window.cd.invoke('float:rearm').catch(() => {}); }
      lockhint.classList.remove('show');
    } else {
      body.classList.add('away');
      controls.classList.remove('show');
    }
  });

  document.addEventListener('mousedown', (e) => {
    // 鼠标中键 = 锁定 / 解锁（两种状态都响应）
    if (e.button === 1) {
      e.preventDefault();
      window.cd.invoke('float:lock', !locked).then(applyLocked);
      return;
    }
    if (locked && armed) {           // 锁定态的其它按键：立刻恢复穿透
      armed = false;
      window.cd.invoke('float:rearm').catch(() => {});
    }
  });

  // 右键不要弹出系统菜单
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // 锁定态下也可以按 Esc 解锁
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && locked) {
      window.cd.invoke('float:lock', false).then(applyLocked);
    }
  });

  /* ---------- 控件 ---------- */

  let sizeDirty = false;
  let sizeTimer = null;
  function saveSize() {
    if (sizeTimer) { clearTimeout(sizeTimer); sizeTimer = null; }
    if (!sizeDirty) return;
    sizeDirty = false;
    window.cd.invoke('float:save', { size: Number(fsize.value) }).catch(() => {});
  }

  swatches.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('.sw') : null;
    if (!b) return;
    applyColor(b.dataset.color);
    window.cd.invoke('float:save', { color: b.dataset.color }).catch(() => {});
    armHide();
  });

  custom.addEventListener('input', () => {
    applyColor(custom.value);
    window.cd.invoke('float:save', { color: custom.value }).catch(() => {});
  });

  fsize.addEventListener('input', () => {
    applySize(fsize.value);
    armHide();
    // 落盘节流：settings.update() 是同步写文件，拖滑杆时每帧写会卡成幻灯片
    sizeDirty = true;
    if (sizeTimer) clearTimeout(sizeTimer);
    sizeTimer = setTimeout(saveSize, 400);
  });
  fsize.addEventListener('change', saveSize);

  document.getElementById('close').addEventListener('click', (e) => {
    e.stopPropagation();
    window.cd.invoke('float:close').catch(() => {});
  });

  /* ---------- 来自主进程的推送 ---------- */

  window.cd.on('float:init', (cfg) => {
    if (!cfg) return;
    applyLang(cfg.lang);
    applyColor(cfg.color);
    applySize(cfg.size);
    setFloatAnim(cfg.float === true);
    setShowOpts(cfg.showTr, cfg.showRo);   // v10.6：译/音显隐
    // 顺序要紧：先把歌词填进去再摆锁定态，
    // applyLocked() 会 showControls()，先跑它会让控件条在首帧就冒出来。
    lastPrev = '';
    lastCur = '';
    lastNext = '';
    lastKey = '';
    renderLyrics(cfg.lyrics);
    applyLocked(cfg.locked);
    if (!inited) {
      inited = true;
      controls.classList.remove('show');
      lockhint.classList.remove('show');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          body.classList.add('ready');
          window.cd.invoke('float:reveal').catch(() => { /* 旧版本没有这个通道 */ });
        });
      });
    }
  });

  window.cd.on('float:lang', (p) => applyLang(p && p.lang));
  window.cd.on('float:lyrics', renderLyrics);
  window.cd.on('float:lock', (st) => applyLocked(st && st.locked));
  window.cd.on('float:opts', (o) => {
    if (!o) return;
    setFloatAnim(o.float === true);
    setShowOpts(o.showTr, o.showRo);   // v10.6：译/音显隐（缺项不动）
  });

  /* 兜底：锁定态下提示一定要消失（点击穿透时鼠标事件不一定稳定送达） */
  setInterval(() => {
    if (locked && lockhint.classList.contains('show') && Date.now() - lastMoveAt > 3000) {
      lockhint.classList.remove('show');
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }
  }, 1000);

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => body.classList.add('ready'));
  }

  window.cd.invoke('float:ready').catch(() => { /* 忽略 */ });
})();
