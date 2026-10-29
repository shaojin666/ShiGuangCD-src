'use strict';
/*
 * 窗口状态推送（全屏图标）自检。
 *
 * 背景（一个真实修过的 bug）：
 *   自绘的全屏按钮图标由主进程推的 `app:win-state` 驱动，而
 *   `enter-full-screen` / `leave-full-screen` 触发的那一刻，
 *   `win.isFullScreen()` 可能还返回**旧值**（切换带动画，状态尚未落定）。
 *   把这一读当结果发出去，图标就会**慢一拍**：
 *   进全屏后仍显示"进入全屏"图标，退出全屏后又变成"退出全屏"图标，
 *   必须再点一次才恢复。
 *
 *   修法：事件里先发一次，落定（300ms）后回读核对，只在真的不一致时补发。
 *
 * 这里把那段逻辑原样搬过来验证（不依赖 Electron / 显示器），重点覆盖两类坑：
 *   ① 事件瞬间读到过期值 → 必须被纠正
 *   ② **过期值恰好等于上次发的值** → 最容易漏：若因此跳过核对，
 *      动画落定后就没人再发一次，图标会永久停在旧状态
 */

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ---- 被测逻辑：与 main/index.js 里的实现保持一致 ---- */

/**
 * @param win  假窗口：real=落定后的真实值，stale=事件瞬间会返回的过期值（null=不覆盖）
 * @param sent 收到的 fullScreen 序列
 */
function makePusher(win, sent) {
  let lastFullScreen = null;
  let fsSettle = null;

  function sendWinState() {
    if (!win || win.destroyed) return null;
    const st = { fullScreen: win.isFullScreen() };
    sent.push(st.fullScreen);
    return st;
  }

  function pushWinState() {              // 普通事件：发一次就好
    const st = sendWinState();
    if (st) lastFullScreen = st.fullScreen;
  }

  function pushWinStateSettle() {        // 全屏事件：无条件安排落定核对
    pushWinState();
    if (fsSettle) clearTimeout(fsSettle);
    fsSettle = setTimeout(() => {
      fsSettle = null;
      if (!win || win.destroyed) return;
      const now = win.isFullScreen();
      if (now !== lastFullScreen) {      // 事件瞬间读早了 → 补发一次正确的
        lastFullScreen = now;
        sendWinState();
      }
    }, 300);
  }

  return { pushWinState, pushWinStateSettle };
}

const mkWin = (real, stale) => ({
  destroyed: false, real, stale: stale === undefined ? null : stale,
  isFullScreen() { return this.stale !== null ? this.stale : this.real; }
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('# 1. 事件瞬间已经读到新值 → 不产生多余补发');
  {
    const win = mkWin(false); const sent = []; const p = makePusher(win, sent);
    win.real = true;
    p.pushWinStateSettle();
    await wait(420);
    check('恰好 1 条且为 true', sent.length === 1 && sent[0] === true, sent);
  }

  console.log('# 2. 进入全屏：事件瞬间读到过期值 false → 必须纠正');
  {
    const win = mkWin(false); const sent = []; const p = makePusher(win, sent);
    win.stale = false;                    // 事件瞬间的过期读
    p.pushWinStateSettle();               // → 发出 false（错）
    win.stale = null; win.real = true;    // 动画落定
    await wait(420);
    check('先发 false 再补发 true', sent.length === 2 && sent[0] === false && sent[1] === true, sent);
    check('最终落在 true', sent[sent.length - 1] === true, sent);
  }

  console.log('# 3. 退出全屏：事件瞬间读到过期值 true → 必须纠正');
  {
    const win = mkWin(true); const sent = []; const p = makePusher(win, sent);
    win.stale = true;
    p.pushWinStateSettle();               // → 发出 true（错）
    win.stale = null; win.real = false;
    await wait(420);
    check('先发 true 再补发 false', sent.length === 2 && sent[0] === true && sent[1] === false, sent);
    check('最终落在 false（不会停在"退出全屏"图标）', sent[sent.length - 1] === false, sent);
  }

  console.log('# 4. 过期值恰好等于上次发的值 → 仍必须安排核对（最容易漏的一类）');
  {
    // 上一轮 settle 已把 lastFullScreen 置为 true；这次事件的过期读也是 true
    const win = mkWin(true); const sent = []; const p = makePusher(win, sent);
    win.stale = true;                     // 过期读 = true
    p.pushWinStateSettle();               // 发 true，与上次相同 —— 不能因此跳过核对
    win.stale = null; win.real = false;   // 落定成 false
    await wait(420);
    check('仍然补发了 false', sent.length === 2 && sent[1] === false, sent);
    check('最终落在 false', sent[sent.length - 1] === false, sent);
  }

  console.log('# 5. 连续三次切换（每次事件都读到过期值）');
  {
    const win = mkWin(false); const sent = []; const p = makePusher(win, sent);
    let expect = false;
    for (const target of [true, false, true]) {
      win.stale = expect;
      p.pushWinStateSettle();
      win.stale = null; win.real = target; expect = target;
      await wait(420);
    }
    check('最终值 = true（与真实状态一致）', sent[sent.length - 1] === true, sent);
    check('每次切换各纠正一次，共 6 条', sent.length === 6, sent);
  }

  console.log('# 6. 普通窗口事件（restore 等）不安排核对');
  {
    const win = mkWin(false); const sent = []; const p = makePusher(win, sent);
    p.pushWinStateSettle(); await wait(420);
    sent.length = 0;
    p.pushWinState(); await wait(420);    // 只发一次，不核对
    p.pushWinState(); await wait(420);
    check('每次普通事件恰好 1 条、无补发', sent.length === 2 && sent.every((v) => v === false), sent);
  }

  console.log('# 7. 核对期间窗口被销毁 → 不抛异常、不发送');
  {
    const win = { destroyed: true, isFullScreen() { throw new Error('boom'); } };
    const sent = []; const p = makePusher(win, sent);
    let threw = false;
    try { p.pushWinStateSettle(); await wait(420); } catch (e) { threw = true; }
    check('不抛异常、不发送', !threw && sent.length === 0, { threw, sent });
  }

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})();