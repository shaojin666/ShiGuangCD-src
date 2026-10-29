'use strict';
/*
 * schema.js —— 元数据规范化与安全兜底。
 *
 * 所有在线来源拿到的字段都不可信：类型可能不对、可能缺字段、字符串可能有超长内容。
 * 落盘前统一过一遍，保证：
 *   1) 界面拿到的字段类型稳定（避免 undefined 直接渲染成 "undefined"）；
 *   2) 缓存文件不会因为脏数据在下次读取时解析异常；
 *   3) 曲目数组与 TOC 轨号一一对应，播放逻辑不会错位。
 */

function str(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/\u0000/g, '').trim();
  if (!s) return null;
  return max && s.length > max ? s.slice(0, max) : s;
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function intYear(v) {
  const n = parseInt(String(v == null ? '' : v).slice(0, 4), 10);
  if (!isFinite(n) || n < 1800 || n > 2100) return null;
  return n;
}

/**
 * 结构化逐字歌词（统一歌词模型）白名单重建。
 * 字段与 main/metadata/lyrics-model.js 的 finalizeModel 输出一致：
 *   { v, source, isWordByWord, agents?, lines[], quality }
 * 行内：{ t, e, text, tr?, ro?, agent?, part?, words[]?, bg[]?, instrumental? }
 * 词级：{ t, e, x }；bg 行额外可带 tr/ro。
 * 缓存文件可能来自旧版本或手写，逐字段收敛类型，任何异常都返回 null
 * （渲染端对 null 走经典 LRC 路径，不影响播放）。
 */
function lyricsDataModel(v) {
  const m = v;
  if (!m || typeof m !== 'object' || !Array.isArray(m.lines) || !m.lines.length) return null;
  const lines = [];
  for (const l of m.lines.slice(0, 800)) {
    if (!l || typeof l !== 'object') continue;
    const t = num(l.t), e = num(l.e);
    if (t == null || e == null || e < t) continue;
    const text = str(l.text, 500);
    if (!text) continue;
    const out = { t, e, text };
    const tr = str(l.tr, 500);
    if (tr) out.tr = tr;
    const ro = str(l.ro, 500);
    if (ro) out.ro = ro;
    if (l.agent) out.agent = str(l.agent, 32);
    if (l.part) out.part = str(l.part, 32);
    if (l.instrumental) out.instrumental = true;
    if (Array.isArray(l.words) && l.words.length) {
      const words = [];
      for (const w of l.words.slice(0, 400)) {
        if (!w || typeof w !== 'object') continue;
        const wt = num(w.t), we = num(w.e), wx = str(w.x, 100);
        if (wt == null || we == null || !wx) continue;
        words.push({ t: wt, e: we, x: wx });
      }
      if (words.length) out.words = words;
    }
    if (Array.isArray(l.bg) && l.bg.length) {
      const bg = [];
      for (const b of l.bg.slice(0, 20)) {
        if (!b || typeof b !== 'object') continue;
        const bt = num(b.t), be = num(b.e), btext = str(b.text, 500);
        if (bt == null || be == null || !btext) continue;
        const entry = { t: bt, e: be, text: btext };
        const btr = str(b.tr, 500);
        if (btr) entry.tr = btr;
        if (b.agent) entry.agent = str(b.agent, 32);
        if (Array.isArray(b.words) && b.words.length) {
          const bw = [];
          for (const w of b.words.slice(0, 400)) {
            if (!w || typeof w !== 'object') continue;
            const wt = num(w.t), we = num(w.e), wx = str(w.x, 100);
            if (wt == null || we == null || !wx) continue;
            bw.push({ t: wt, e: we, x: wx });
          }
          if (bw.length) entry.words = bw;
        }
        bg.push(entry);
      }
      if (bg.length) out.bg = bg;
    }
    lines.push(out);
  }
  if (!lines.length) return null;
  const model = {
    v: 1,
    source: str(m.source, 32) || 'unknown',
    isWordByWord: !!m.isWordByWord,
    lines,
    quality: num(m.quality) != null ? Math.round(num(m.quality)) : 0
  };
  if (m.agents && typeof m.agents === 'object') {
    const agents = {};
    for (const k of Object.keys(m.agents).slice(0, 20)) {
      const a = m.agents[k];
      if (a && typeof a === 'object') agents[k] = { id: str(a.id, 32) || k, name: str(a.name, 64) || '', type: str(a.type, 32) || '' };
    }
    if (Object.keys(agents).length) model.agents = agents;
  }
  return model;
}

/**
 * 歌词候选源列表白名单：每个候选过 lyricsDataModel，最多保留 8 个
 * （五源 × 逐字/行级，实际通常 1~3 个）。空/脏输入一律 null。
 */
function lyricsSourcesModel(v) {
  if (!Array.isArray(v) || !v.length) return null;
  const out = [];
  for (const m of v.slice(0, 8)) {
    const clean = lyricsDataModel(m);
    if (clean) out.push(clean);
  }
  return out.length ? out : null;
}

function trackList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((t, i) => ({
      number: Number(t && t.number) || (i + 1),
      // ★ 轨级碟号：多碟专辑里每轨属于哪张碟（1 起）。单碟专辑为 1 或不写。
      discNumber: Number(t && t.discNumber) >= 1 ? Math.floor(Number(t.discNumber)) : null,
      title: str(t && t.title, 300) || `轨道 ${Number(t && t.number) || (i + 1)}`,
      artist: str(t && t.artist, 200) || '',
      durationSec: num(t && t.durationSec) != null && num(t && t.durationSec) > 0
        ? Math.round(num(t && t.durationSec) * 1000) / 1000
        : null,
      startFrame: num(t && t.startFrame),
      endFrame: num(t && t.endFrame),
      lyrics: typeof (t && t.lyrics) === 'string' ? t.lyrics : null,
      lyricsSynced: !!(t && t.lyricsSynced),
      lyricsSource: str(t && t.lyricsSource, 32),
      lyricsTranslation: typeof (t && t.lyricsTranslation) === 'string' ? t.lyricsTranslation : null,
      // ★ 结构化逐字歌词（统一模型）：renderer 的 lyrics-view.js 只认这一种结构；
      //   lyricsData 存在时优先用它，缺失时回退经典 lyrics 字符串。
      lyricsData: lyricsDataModel(t && t.lyricsData) || null,
      // ★ 全部歌词候选源（fetchLyricsRichAll 的产物）：编辑面板的"歌词源管理"
      //   据此展示所有获取到的源并让用户手动挑一个。每个元素与 lyricsData
      //   同构（过同一个白名单）。没有收集到时为 null。
      lyricsSources: lyricsSourcesModel(t && t.lyricsSources),
      neteaseSongId: t && t.neteaseSongId ? Number(t.neteaseSongId) || null : null,
      recordingMbid: str(t && t.recordingMbid, 64)
    }))
    .filter((t) => t.number >= 1)
    .sort((a, b) => a.number - b.number);
}

/**
 * 碟号规范化：必须为 1 起的整数，非法值一律归到 1。
 * 之所以不用 null 而用 1，是因为界面要直接显示（"第 1 碟"），
 * 且单碟专辑事实上就是第 1 碟，给 1 不会产生歧义。
 */
function discNo(v, fallback) {
  const n = Number(v);
  if (isFinite(n) && n >= 1 && n <= 99) return Math.floor(n);
  return fallback != null ? fallback : 1;
}

/**
 * 碟总数规范化：单碟专辑可为 null（界面据此决定是否显示 "1/1"）。
 */
function discTotal(v) {
  const n = Number(v);
  if (isFinite(n) && n >= 1 && n <= 99) return Math.floor(n);
  return null;
}

/**
 * 规范化一份元数据对象。手动编辑（manual）内容原样保留，不做裁剪。
 * @param {object} meta
 * @returns {object}
 */
function validateMetadata(meta) {
  const m = meta || {};
  const out = {
    signature: str(m.signature, 64),
    source: str(m.source, 32) || 'unknown',
    sources: Array.isArray(m.sources) ? m.sources.map((s) => str(s, 32)).filter(Boolean) : [],
    album: str(m.album, 300),
    artist: str(m.artist, 300),
    /**
     * ★ 专辑介绍 / 歌手介绍（v10.4 新增）。
     * 来源：网易云专辑详情 description、网易云歌手 briefDesc；
     * 用户也可在编辑面板手改（manual 快照同样按 key 盖回，见 _applyManualOverrides）。
     * 上限 4000 字：介绍文本可能很长（有的歌手简介上万字），
     * 全量存进缓存 JSON 会让音乐库列表读取变卡，截断是刻意的取舍。
     */
    albumIntro: str(m.albumIntro, 4000),
    artistIntro: str(m.artistIntro, 4000),
    year: intYear(m.year),
    genres: Array.isArray(m.genres) ? m.genres.map((g) => str(g, 60)).filter(Boolean).slice(0, 5) : [],
    company: str(m.company, 200),
    trackCount: num(m.trackCount) || 0,
    /**
     * ★ 碟号 / 碟总数：多碟专辑精确匹配与界面角标的关键字段。
     *
     * 说明：CD 的 TOC 里不含碟号，这个值只能来自在线源推断或用户手动编辑。
     * 出口恒为 ≥1 的整数（默认 1），保证界面永远有可显示文本；
     * discTotal 为 null 时表示"未知/单碟"，界面据此决定是否显示 "x/y"。
     */
    discNumber: discNo(m.discNumber, 1),
    discTotal: discTotal(m.discTotal),
    hasCover: !!m.hasCover,
    coverUrl: str(m.coverUrl, 500),
    mbDiscId: str(m.mbDiscId, 64),
    releaseMbid: str(m.releaseMbid, 64),
    releaseGroupMbid: str(m.releaseGroupMbid, 64),
    neteaseAlbumId: m.neteaseAlbumId ? Number(m.neteaseAlbumId) || null : null,
    itunesAlbumId: m.itunesAlbumId ? Number(m.itunesAlbumId) || null : null,
    fetchedAt: str(m.fetchedAt, 40),
    /* 歌词补抓完成时间（缓存命中但缺歌词时后台补抓，v10.4）。
       与 fetchedAt 分开记：补抓不改动 fetchedAt，避免"重新获取"误判。 */
    lyricsFilledAt: str(m.lyricsFilledAt, 40),
    tracks: trackList(m.tracks)
  };
  // manual 标记：为真时后续在线刷新不得覆盖任何已有内容
  if (m.manual) out.manual = m.manual;
  if (m.mbDiscId) out.mbDiscId = m.mbDiscId;
  /*
   * ★ 封面二进制必须透传。
   * 本函数是"白名单重建"，旧实现没有带上 coverBuffer，导致
   * fetchDiscMetadata 明明下载到了封面（实测 34KB），经过这里就被丢掉，
   * 服务层的 `if (meta.coverBuffer)` 恒为 false —— 这是"封面永远存不下来"
   * 的直接原因。Buffer 不做裁剪，原样带出；落盘由服务层的 saveCover 负责，
   * 存盘前会被 delete 掉，不会进入 JSON。
   */
  if (Buffer.isBuffer(m.coverBuffer) && m.coverBuffer.length > 0) {
    out.coverBuffer = m.coverBuffer;
  }
  return out;
}

module.exports = { validateMetadata, str, num, intYear, discNo, lyricsDataModel, lyricsSourcesModel };
