'use strict';
/* ============================================================
   scene.js —— 读盘仪式（一镜到底）控制器
   ============================================================ */

const Scene = (() => {
  const el = document.getElementById('ceremony');
  const discOuter = document.getElementById('disc-outer');
  const discFace = document.getElementById('disc-face');
  const titleEl = document.getElementById('ceremony-title');
  const subEl = document.getElementById('ceremony-sub');
  const readRing = document.querySelector('#ceremony-read-ring .arc');
  let hideTimer = null;
  let currentPhase = 'none';

  const RING_CIRC = 766.4; // 2π × 122

  function show() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    // 必须清掉 hide()/fadeOutQuick() 留下的过渡类：
    // 否则"退出读盘界面 → 再放入光盘"时，仪式层会一直停在淡出态看不见
    el.classList.remove('ph-none', 'ph-hidden', 'ph-fading');
    el.classList.add('shown');
  }

  function hide() {
    el.classList.add('ph-hidden');
    hideTimer = setTimeout(() => {
      el.classList.remove('shown', 'ph-hidden');
      el.classList.add('ph-none');
    }, 1000);
  }

  /* 落地瞬间：快速淡出（与正在播放页的唱片做同位置衔接） */
  function fadeOutQuick() {
    el.classList.add('ph-fading');
    hideTimer = setTimeout(() => {
      el.classList.remove('shown', 'ph-fading');
      el.classList.add('ph-none');
    }, 650);
  }

  function setPhase(p) {
    if (currentPhase === p) return;
    currentPhase = p;
    for (const c of ['ph-idle', 'ph-insert', 'ph-reading', 'ph-reveal', 'ph-eject']) {
      el.classList.remove(c);
    }
    if (p && p !== 'none') el.classList.add('ph-' + p);
  }

  function setCover(url) {
    if (url) {
      discFace.style.backgroundImage = 'url("' + url + '")';
      discFace.classList.add('has-cover');
    } else {
      discFace.style.backgroundImage = '';
      discFace.classList.remove('has-cover');
    }
  }

  function setReadingProgress(f) {
    const v = Math.max(0, Math.min(1, f));
    readRing.style.strokeDashoffset = String(RING_CIRC * (1 - v));
  }

  function setText(title, sub) {
    titleEl.textContent = title || '';
    subEl.textContent = sub || '';
  }

  function discRect() {
    return discOuter.getBoundingClientRect();
  }

  return {
    show,
    hide,
    fadeOutQuick,
    setPhase,
    setCover,
    setReadingProgress,
    setText,
    discRect
  };
})();
