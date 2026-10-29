'use strict';
/*
 * lyrics-select.js —— 歌词源管理（编辑面板"歌词源管理"的后端）。
 *
 * 三个操作都直接修改传入的 meta 对象（调用方负责 store.save）：
 *   selectSource  从 tr.lyricsSources 候选里挑一个启用（写 lyricsData + 重建 LRC）
 *   addTtml       把用户粘贴的 TTML XML 解析成模型，入候选并启用
 *   removeSource  删掉**手动添加**的候选（source='ttml-manual'，在线抓来的不让删）
 *
 * 为什么选源/贴 TTML 都在主进程做：模型 → 经典 LRC 的转换（toLrc）、
 * TTML 解析（parseTTML）都只在主进程有；渲染端只发指令，不回传整份歌词数据。
 */

const { parseTTML, finalizeModel, applyModelToTrack } = require('./lyrics-model');
const { lyricsDataModel } = require('./schema');

/** 手动添加的候选打的 source 标（渲染端显示"手动 TTML"，removeSource 只认它） */
const MANUAL_SOURCE = 'ttml-manual';

function findTrack(meta, number) {
  const n = Number(number);
  if (!meta || !Array.isArray(meta.tracks) || !isFinite(n)) return null;
  return meta.tracks.find((t) => t && Number(t.number) === n) || null;
}

/**
 * 启用列表里的第 index 个候选。
 * @returns {{ok:true, track:object}|{ok:false, error:string}}
 */
function selectSource(meta, number, index) {
  const tr = findTrack(meta, number);
  if (!tr) return { ok: false, error: 'track-not-found' };
  const list = tr.lyricsSources;
  if (!Array.isArray(list) || !list.length) return { ok: false, error: 'no-sources' };
  const i = Number(index);
  if (!isFinite(i) || i < 0 || i >= list.length) return { ok: false, error: 'bad-index' };
  // 再过一遍白名单：缓存文件可能来自旧版本或手改，结构不能信
  const model = lyricsDataModel(list[i]);
  if (!model) return { ok: false, error: 'bad-model' };
  applyModelToTrack(tr, model);
  return { ok: true, track: tr };
}

/**
 * 添加用户粘贴的 TTML 歌词并启用。
 * 典型用法：某个源没有收录这首歌，用户在 AMLL TTML Tool 里自己打好轴，
 * 把导出的 TTML 复制进编辑面板保存。
 * @param {string} ttmlText TTML XML 原文
 * @returns {{ok:true, track:object, index:number}|{ok:false, error:string}}
 */
function addTtml(meta, number, ttmlText) {
  const tr = findTrack(meta, number);
  if (!tr) return { ok: false, error: 'track-not-found' };
  const xml = String(ttmlText == null ? '' : ttmlText).replace(/^\uFEFF/, '').trim();
  if (!xml) return { ok: false, error: 'empty' };
  let model = null;
  try {
    // 用户粘进来的可能是整个 .ttml 文件；解析器只认 <tt 根
    model = finalizeModel(parseTTML(xml));
  } catch (e) {
    return { ok: false, error: 'parse-failed: ' + (e && e.message ? e.message : e) };
  }
  const clean = lyricsDataModel(model);
  if (!clean) return { ok: false, error: 'not-ttml-or-empty' };
  clean.source = MANUAL_SOURCE;
  const list = Array.isArray(tr.lyricsSources) ? tr.lyricsSources.slice() : [];
  // 同一份 TTML 重复粘贴：按内容指纹去重（行数+首行时间+首行文本）
  const fp = fingerprint(clean);
  const dup = list.findIndex((m) => m && m.source === MANUAL_SOURCE && fingerprint(m) === fp);
  if (dup >= 0) {
    list[dup] = clean;
    tr.lyricsSources = list;
    applyModelToTrack(tr, clean);
    return { ok: true, track: tr, index: dup, replaced: true };
  }
  list.push(clean);
  tr.lyricsSources = list;
  applyModelToTrack(tr, clean);
  return { ok: true, track: tr, index: list.length - 1 };
}

/**
 * 删除手动添加的候选。在线抓来的候选不让删（删了下回抓取还会有，
 * 用户真想不要可以选别的源）。删的正是当前启用项时，回退到质量最高的剩余候选。
 * @returns {{ok:true, track:object}|{ok:false, error:string}}
 */
function removeSource(meta, number, index) {
  const tr = findTrack(meta, number);
  if (!tr) return { ok: false, error: 'track-not-found' };
  const list = tr.lyricsSources;
  if (!Array.isArray(list) || !list.length) return { ok: false, error: 'no-sources' };
  const i = Number(index);
  if (!isFinite(i) || i < 0 || i >= list.length) return { ok: false, error: 'bad-index' };
  if (!list[i] || list[i].source !== MANUAL_SOURCE) return { ok: false, error: 'not-manual' };
  const wasActive = tr.lyricsData && sameModel(tr.lyricsData, list[i]);
  list.splice(i, 1);
  tr.lyricsSources = list.length ? list : null;
  if (wasActive) {
    // 当前启用项被删：回退到剩余里质量最高的
    let best = null;
    for (const m of list) {
      if (!best || (m.quality || 0) > (best.quality || 0)) best = m;
    }
    if (best) applyModelToTrack(tr, best);
    else {
      tr.lyricsData = null;
      tr.lyrics = null;
      tr.lyricsSynced = false;
      tr.lyricsTranslation = null;
    }
  }
  return { ok: true, track: tr };
}

/** 内容指纹：行数 + 首行时间 + 末行文本（足够区分不同打轴，又不至于过严） */
function fingerprint(m) {
  if (!m || !Array.isArray(m.lines) || !m.lines.length) return '';
  const first = m.lines[0];
  const last = m.lines[m.lines.length - 1];
  return m.lines.length + '|' + (first.t || 0) + '|' + String(last.text || '').slice(0, 40);
}

/** 粗比对：同源、同行数、同首行时间即视为同一份（用于判断删的是不是当前项） */
function sameModel(a, b) {
  if (!a || !b) return false;
  if (String(a.source) !== String(b.source)) return false;
  if (!Array.isArray(a.lines) || !Array.isArray(b.lines)) return false;
  if (a.lines.length !== b.lines.length) return false;
  const at = a.lines[0] && a.lines[0].t;
  const bt = b.lines[0] && b.lines[0].t;
  return at === bt;
}

module.exports = { selectSource, addTtml, removeSource, MANUAL_SOURCE };
