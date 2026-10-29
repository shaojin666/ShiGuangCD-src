'use strict';
/*
 * fetch.js —— 在线元数据编排（大陆地区可用方案）。
 *
 * ============ 为什么旧实现"完全没反应" ============
 * 旧流程只有一条主路径 MusicBrainz → 封面 → LRCLIB，而 MusicBrainz 那一步
 * 因为解析字段写错（读 data.discs 而实际是 data.releases）**恒定为空**，
 * 于是整个在线获取 100% 落到骨架分支，用户看到的就是"联网获取元数据无效"。
 * 其次封面走 Cover Art Archive，国内访问 archive.org 极不稳定；
 * 歌词走 LRCLIB，华语覆盖也一般。
 *
 * ============ 现在的方案 ============
 *   阶段 1  本地缓存      命中即用，完全不联网（二次读同一张碟秒开）
 *   阶段 2  MusicBrainz   唯一能按光盘 TOC 指纹精确匹配的源（海外碟命中率最高）
 *   阶段 3  网易云        华语专辑主力源：补全专辑名/歌手/年份/曲目/封面/歌词
 *   阶段 4  iTunes        英文碟兜底
 *   阶段 5  骨架          "轨道 N"，仍可播放、可手动编辑
 *
 * 每个阶段都单独计时与降级：任一源失败或超时都不会阻塞其它源，
 * 更不会阻塞读盘就绪（本函数在后台跑，`cd:land` 早已发出）。
 *
 * 封面候选顺序：MusicBrainz(CAA) → 网易云 → iTunes；先到先得，失败自动换下一个。
 * 歌词候选顺序：网易云（华语优先、含逐轨 songId）→ LRCLIB（海外兜底）。
 */

const { validateMetadata } = require('./schema');
const { getBuffer, withTimeout } = require('./http');
const { lookupByToc, searchRelease } = require('./musicbrainz');
const netease = require('./netease');
const itunes = require('./itunes');
const { fetchLyricsForTracks, fetchLyricsFromLrclib, fetchLyricsRichAll } = require('./lyrics');
const { applyModelToTrack } = require('./lyrics-model');

/**
 * 各阶段超时（ms）。
 * 取值原则：宁可缺一项信息，不可卡住整条链路；但也要给真实网络留足余量
 * （MusicBrainz 高峰期单次可到 10~15 秒，网易云通常 <1 秒）。
 */
const STAGE_TIMEOUT = {
  // 见 fetchDiscMetadata 内注释：MB 是海外源，12s 内拿不到就放弃，
  // 不能让它饿死后面更快更稳的国内源。
  mb: 12000,
  netease: 12000,
  itunes: 8000,
  // 封面单候选超时收紧：Cover Art Archive（archive.org）在大陆经常直接
  // TLS 重置，旧值 9s 会让三个 CAA 候选白等近 30s。4.5s 足够判定其不可达，
  // 超时后立刻换网易云候选（国内 <1s）。
  cover: 4500,
  lyrics: 40000
};

/**
 * CAA（Cover Art Archive）在大陆的可达性很差：实测 https://coverartarchive.org
 * 经 307 跳到 archive.org/ia 后经常 "socket disconnected before TLS handshake"。
 * 因此它只作为**海外碟的兜底**，且排在网易云之后；给一个更短的独立超时，
 * 避免它拖垮整体。
 */
const CAA_TIMEOUT = 3500;

function emptySkeleton(toc) {
  return {
    source: 'unknown',
    sources: [],
    album: null,
    artist: null,
    year: null,
    genres: [],
    trackCount: toc && toc.tracks ? toc.tracks.length : 0,
    coverUrl: null,
    // ★ 碟号：CD 的 TOC 里**没有**碟号（这是物理格式的限制，见 inferDiscNumber），
    //   这里先给 1 作为中性默认值，后续由在线源推断或用户手动指定覆盖。
    discNumber: 1,
    discTotal: null,
    tracks: (toc && toc.tracks ? toc.tracks : []).map((t, i) => ({
      number: t.number || (i + 1),
      title: `轨道 ${t.number || (i + 1)}`,
      artist: '',
      durationSec: t.durationSec != null ? t.durationSec : null,
      lyrics: null,
      lyricsSynced: false
    }))
  };
}

/**
 * 推断本张碟的碟号。
 *
 * ★ 必须先说清楚一个物理事实：**标准 CD 的 TOC 里不含碟号**。
 *   TOC 只描述"这张碟上有几轨、每轨从哪个扇区开始"，
 *   它无法告诉软件"这是某专辑的第 2 张碟"。旧实现因此完全忽略碟号，
 *   遇到多碟专辑就把各碟轨号相同的前 N 首互相串味。
 *
 * 可用的推断线索（按可靠性排序）：
 *   1) 用户已手动编辑过的碟号（缓存 manual.discNumber）——最权威；
 *   2) hint.discNumber（编辑面板显式指定）；
 *   3) 上次缓存里记下的 discNumber；
 *   4) 都没有 → 保持 1（中性默认，交给编辑面板由用户修正）。
 *
 * @returns {{discNumber:number, discTotal:(number|null), from:string}}
 */
function inferDiscNumber(opts = {}) {
  const pick = (v) => {
    const n = Number(v);
    return isFinite(n) && n >= 1 ? Math.floor(n) : null;
  };
  const hint = opts.hint || {};
  if (pick(hint.discNumber)) return { discNumber: pick(hint.discNumber), discTotal: pick(hint.discTotal), from: 'hint' };
  if (pick(opts.cachedDiscNumber)) return { discNumber: pick(opts.cachedDiscNumber), discTotal: pick(opts.cachedDiscTotal), from: 'cache' };
  return { discNumber: 1, discTotal: null, from: 'default' };
}

/**
 * 从源曲目表里取"本张碟"的曲目子集。
 *
 * ★ 这是修复多碟错配的核心动作：
 *   源可能给的是一整张 multi-disc release 的曲目（各碟轨号都是 1..N）。
 *   必须先按碟号切出本碟，再交给按轨号匹配的 applyTracks —— 否则
 *   disc2 的 1..N 会顶掉 disc1 的 1..N（正是"前五首歌词和 disc2 一样"的成因）。
 *
 * 判定规则：
 *   - 源曲目**没有任何**碟号信息 → 原样返回（单碟专辑的常见情形）；
 *   - 有碟号信息 → 只返回 discNumber === 目标碟号 的那些。
 *
 * @param {Array} sourceTracks
 * @param {number} discNumber 目标碟号（1 起）
 * @returns {Array} 子集（可能为空数组 —— 说明源里根本没有这张碟）
 */
function filterTracksByDisc(sourceTracks, discNumber) {
  if (!Array.isArray(sourceTracks) || !sourceTracks.length) return [];
  const tagged = sourceTracks.some((t) => Number(t && t.discNumber) >= 1);
  if (!tagged) return sourceTracks.slice();   // 源未标碟号：视为单碟，整体返回
  const want = Math.floor(Number(discNumber)) || 1;
  return sourceTracks.filter((t) => (Number(t && t.discNumber) >= 1 ? Math.floor(Number(t.discNumber)) : 1) === want);
}

/**
 * 判断源曲目表是否明确标了碟号，以及一共几张碟。
 * @returns {{tagged:boolean, discTotal:number}}
 */
function discInfoOf(sourceTracks, declaredTotal) {
  const list = Array.isArray(sourceTracks) ? sourceTracks : [];
  const tagged = list.some((t) => Number(t && t.discNumber) >= 1);
  let total = Number(declaredTotal) >= 1 ? Math.floor(Number(declaredTotal)) : 0;
  for (const t of list) {
    const d = Number(t && t.discNumber);
    if (isFinite(d) && d >= 1) total = Math.max(total, Math.floor(d));
  }
  return { tagged, discTotal: total || 1 };
}

/** 合并某个源的结果（后到的只补空缺，不覆盖已有值） */
function mergeInto(target, incoming, sourceName) {
  if (!incoming) return target;
  const filled = [];
  if (!target.album && incoming.album) { target.album = incoming.album; filled.push('album'); }
  if (!target.artist && incoming.artist) { target.artist = incoming.artist; filled.push('artist'); }
  if (!target.albumIntro && incoming.albumIntro) { target.albumIntro = incoming.albumIntro; filled.push('albumIntro'); }
  if (!target.artistIntro && incoming.artistIntro) { target.artistIntro = incoming.artistIntro; filled.push('artistIntro'); }
  if (!target.year && incoming.year) { target.year = incoming.year; filled.push('year'); }
  if (!target.coverUrl && incoming.coverUrl) { target.coverUrl = incoming.coverUrl; filled.push('cover'); }
  if (!target.company && incoming.company) target.company = incoming.company;
  if ((!target.genres || !target.genres.length) && incoming.genres && incoming.genres.length) {
    target.genres = incoming.genres;
  }
  /* ★ 碟号：目标已有明确值就保留；否则被源给出的值补上。
     注意 discTotal 同理 —— 多碟发行才有多张，单碟缺省不写。 */
  if (Number(incoming.discNumber) >= 1 && !(Number(target.discNumber) >= 1 && target.discNumber !== 1)) {
    target.discNumber = Math.floor(Number(incoming.discNumber));
    filled.push('discNumber');
  }
  if (Number(incoming.discTotal) >= 1 && !(Number(target.discTotal) >= 1)) {
    target.discTotal = Math.floor(Number(incoming.discTotal));
  }
  for (const k of ['releaseMbid', 'releaseGroupMbid', 'mbDiscId', 'neteaseAlbumId', 'itunesAlbumId']) {
    if (!target[k] && incoming[k]) target[k] = incoming[k];
  }
  if (!target.sources.includes(sourceName)) target.sources.push(sourceName);
  return filled;
}

/**
 * 用某个源的曲目表替换/补全骨架曲目。
 *
 * 优先级规则：
 *   - 若该源曲目数与 TOC 一致，且时长吻合度达标 → 直接采用它的曲目名与歌手；
 *   - 若曲目数与 TOC 不一致 → 按轨号逐条对应（不能整体替换，否则 TOC 轨号会错位）。
 * 时长永远以 TOC（物理）为准，元数据的时长只用于缺值时补齐。
 *
 * ★ 调用前必须先用 filterTracksByDisc 把源曲目切到本碟
 *   （多碟专辑各碟轨号都是 1..N，不切碟就会互相串味）。
 */
function applyTracks(target, sourceTracks, tocTracks) {
  if (!sourceTracks || !sourceTracks.length) return false;
  const byNum = new Map();
  for (const t of sourceTracks) {
    if (t.number != null) byNum.set(Number(t.number), t);
  }
  let applied = 0;
  for (const tr of target.tracks) {
    const src = byNum.get(tr.number) || sourceTracks[tr.number - 1];
    if (!src || !src.title) continue;
    tr.title = src.title;
    if (src.artist) tr.artist = src.artist;
    if ((tr.durationSec == null || tr.durationSec <= 0) && src.durationSec) {
      tr.durationSec = src.durationSec;
    }
    if (src.neteaseSongId) tr.neteaseSongId = src.neteaseSongId;
    if (src.itunesTrackId) tr.itunesTrackId = src.itunesTrackId;
    if (src.recordingMbid) tr.recordingMbid = src.recordingMbid;
    applied++;
  }
  return applied > 0;
}

/**
 * 按时长吻合来逐轨改名（用于网易云轨数与 TOC 不一致的情况）。
 *
 * 场景：MB 记录标准版 12 轨，网易云收录 Deluxe 版 13 轨（末尾多一首 Bonus）。
 * 此时不能按"第 N 个"直接对应——网易云的顺序可能插入曲目导致整体错位。
 * 做法：对每条 TOC 轨，在源曲目里找**时长最接近**且差值 ≤ 6 秒的那一条。
 *
 * 约束：只有当整体命中率 ≥ 60% 时才采纳，否则说明两张碟确实不是同一版本，
 * 就保持骨架的"轨道 N"，不冒险乱贴名字。
 *
 * ★ 同样要求调用前已按碟切好 sourceTracks（见 filterTracksByDisc）。
 */
function applyTracksByDuration(target, sourceTracks, tocTracks, tolSec = 6) {
  if (!sourceTracks || !sourceTracks.length) return false;
  const used = new Set();
  const plan = []; // 先算好，命中率达标才落地，避免"半贴半不贴"
  for (const tr of target.tracks) {
    const tocT = tocTracks[tr.number - 1];
    const wantDur = (tocT && tocT.durationSec) || tr.durationSec;
    if (!wantDur) continue;
    let best = null;
    let bestDiff = Infinity;
    for (const src of sourceTracks) {
      if (!src.durationSec || used.has(src.neteaseSongId || src.number)) continue;
      const diff = Math.abs(src.durationSec - wantDur);
      if (diff < bestDiff) { bestDiff = diff; best = src; }
    }
    if (best && bestDiff <= tolSec && best.title) {
      used.add(best.neteaseSongId || best.number);
      plan.push({ tr, best });
    }
  }
  const need = Math.ceil(target.tracks.length * 0.6);
  if (plan.length < need) return false;
  for (const { tr, best } of plan) {
    tr.title = best.title;
    if (best.artist) tr.artist = best.artist;
    if (best.neteaseSongId) tr.neteaseSongId = best.neteaseSongId;
    if (best.itunesTrackId) tr.itunesTrackId = best.itunesTrackId;
    if (best.recordingMbid) tr.recordingMbid = best.recordingMbid;
  }
  return true;
}

/** 封面多候选下载：按顺序试，第一个成功即返回 */
async function downloadCoverFrom(candidates, onStage) {
  for (const cand of candidates) {
    if (!cand || !cand.url && !cand.fetch) continue;
    if (onStage) onStage('cover');
    const timeout = cand.timeout || STAGE_TIMEOUT.cover;
    try {
      const buf = await withTimeout(
        cand.fetch ? cand.fetch() : getBuffer(cand.url).then((r) => r && r.body),
        timeout, '封面'
      );
      if (buf && buf.length > 512) return buf;
    } catch (e) { /* 换下一个候选 */ }
  }
  return null;
}

/**
 * 获取一张光盘的完整在线元数据。
 *
 * @param {object} toc  TOC 结构（含 tracks[].durationSec / startFrame）
 * @param {object} opts
 *   - onStage(name)          阶段回调，用于刷新读盘动画文案
 *   - onLyrics(done, total)  歌词进度回调
 *   - hint {album, artist, discNumber, discTotal}
 *                            可选：用户手动给的搜索关键词与碟号（"重新获取"面板用）
 *   - cachedDiscNumber       可选：上次缓存里记录的碟号（用户编辑过的最可靠）
 *   - force                  可选：忽略……（缓存由服务层判断，这里不做）
 * @returns {Promise<object>} 规范化元数据（匹配失败时返回骨架）
 */
async function fetchDiscMetadata(toc, opts = {}) {
  const onStage = opts.onStage || (() => {});
  const onLyrics = opts.onLyrics || (() => {});
  const log = opts.log || (() => {});
  const hint = opts.hint || {};

  const result = emptySkeleton(toc);
  const tocTracks = (toc && toc.tracks) || [];

  /**
   * ★ 第一步：先把"本碟碟号"定下来。
   *
   * 这是修复多碟专辑错配的前置条件 —— 所有后续按碟切分、按碟匹配
   * 都以这个值为准。来源优先级见 inferDiscNumber 的注释。
   */
  const disc = inferDiscNumber(opts);
  result.discNumber = disc.discNumber;
  if (disc.discTotal) result.discTotal = disc.discTotal;
  const wantDisc = disc.discNumber;

  /* ---------- 阶段 2：MusicBrainz 按 TOC 精确匹配 ---------- */
  /**
   * ★ 关键设计：MB 只负责"能不能按 TOC 精确认碟"，不代表它是主源。
   *
   * MusicBrainz 是海外服务，实测单次 1.8s~20s 波动极大，且**华语 CD 收录很差**
   * （大量中文碟在 MB 里根本没有对应 DiscID）。旧实现把所有后续步骤
   * （网易云搜索词、封面、歌词）都挂在"MB 成功"之后，于是：
   *   - MB 慢 → 整条链路等到超时，其它可用的国内源全被饿死；
   *   - MB 未收录华语碟 → 网易云连搜索词都拿不到，直接跳过。
   * 这就是"联网获取元数据无效"在真实使用中反复出现的原因。
   *
   * 现在把 MB 的超时收到 12s（够用且不至于拖垮体验），并且——无论 MB 成败——
   * 只要用户给了 hint，网易云都会独立开搜，不再依赖 MB 结果。
   *
   * ★ 关于碟号：MB 的 discid 接口会返回该 release 的 media[]（每张碟一项，
   *   position 即碟号）。传入碟号提示后，pickBestRelease / lookupByToc
   *   就能在多碟发行里选对本碟对应的那一份曲目表，而不是盲取第一张。
   */
  let mbMeta = null;
  try {
    onStage('musicbrainz');
    mbMeta = await withTimeout(lookupByToc(toc, { discHint: wantDisc }), STAGE_TIMEOUT.mb, 'MusicBrainz');
  } catch (e) {
    mbMeta = null;
  }
  /**
   * hint 交叉校验：用户在编辑面板明确填了「专辑名/歌手」时，他是最权威的信息源。
   *
   * 若 MB 按 TOC 匹配出的专辑名/歌手与 hint 明显对不上，宁可相信用户 —— 
   * 因为 TOC 匹配偶尔会命中"同一个 DiscID 的另一个版本"或压根是无关发行
   * （实测过：一张随机 TOC 撞上某张菲律宾专辑，进而污染了后续所有步骤）。
   * 这种情况下丢弃 MB 结果，让网易云按 hint 去搜，结果反而更贴近实物。
   */
  if (mbMeta && (hint.album || hint.artist)) {
    const n = netease.norm;
    const albumOk = !hint.album || n(mbMeta.album) === n(hint.album) ||
      n(mbMeta.album).indexOf(n(hint.album)) >= 0 || n(hint.album).indexOf(n(mbMeta.album)) >= 0;
    const artistOk = !hint.artist ||
      n(mbMeta.artist).indexOf(n(hint.artist)) >= 0 || n(hint.artist).indexOf(n(mbMeta.artist)) >= 0;
    // 只要 hint 给出的字段里"有任意一个明确不匹配"，就认为 MB 认错了碟
    const albumMismatch = !!hint.album && !albumOk;
    const artistMismatch = !!hint.artist && !artistOk;
    if (albumMismatch || artistMismatch) {
      mbMeta = null;
    }
  }
  if (mbMeta) {
    mergeInto(result, mbMeta, 'musicbrainz');
    /**
     * ★ 按碟切分后再套用曲目。
     *
     * MB 的多碟发行，media[] 里每个 medium 是**一张碟**、轨号各自从 1 开始。
     * 若 mbMeta 只是"本碟那一份"（lookupByToc 已按 discHint 选好 medium），
     * 那么它给的 tracks 已经只含本碟；但为稳妥起见仍过一遍 filterTracksByDisc
     * —— 若该源的 tracks 带了 discNumber，就只保留本碟的（防止源混入多碟）。
     */
    const mbTracks = filterTracksByDisc(mbMeta.tracks, wantDisc);
    if (mbTracks.length) applyTracks(result, mbTracks, tocTracks);
    /**
     * MB 若是多碟发行但无法确定本碟（tracks 标了碟号却都没有本碟号），
     * 说明这张 TOC 在该 release 里对不上任何已登记的碟 —— 记录 discTotal
     * 供渲染端提示"该专辑共 N 张碟"，但不采用其曲目名（避免错位）。
     */
    const info = discInfoOf(mbMeta.tracks, mbMeta.discTotal);
    if (info.discTotal > 1) result.discTotal = info.discTotal;
  }

  /* ---------- 阶段 3：网易云（华语主力，也可补全 MB 拿不到的封面/歌词） ---------- */
  /**
   * 搜索关键词优先级：用户手动指定 > MB 结果。
   * 注意：**没有关键词就不搜网易云**（宁缺毋滥）。因为按 TOC 时长盲搜的
   * 准确率太低，容易把毫不相干的专辑信息糊到用户碟上，比"没信息"更糟。
   * 真正的兜底路径是编辑面板里的"按关键词搜索"，由用户提供专辑名/歌手。
   */
  const kwAlbum = hint.album || result.album || '';
  const kwArtist = hint.artist || result.artist || '';
  const keyword = [kwAlbum, kwArtist].filter(Boolean).join(' ').trim();

  let neAlbum = null;
  let nePickScore = 0;
  /**
   * ★ 网易云切碟后的"本碟曲目表"。
   *
   * 网易云的专辑详情是**一张碟一个扁平 songs 数组**，多碟专辑里
   * disc1/disc2 的轨号都是 1..N（碟号在每首歌的 cd 字段）。
   * 因此拿到详情后必须先 tracksOfDisc(详情, 本碟号) 切出本碟，
   * 后续所有按轨号的匹配与歌词挂接都用这份子集 —— 这是根治
   * "disc1 前五首歌词与 disc2 一致"的关键一步。
   */
  let neTracks = [];
  if (keyword) {
    try {
      onStage('netease');
      const candidates = await withTimeout(
        netease.searchAlbums(keyword, 10), STAGE_TIMEOUT.netease, '网易云搜索'
      );
      const pick = netease.pickAlbum(candidates, {
        album: kwAlbum || result.album,
        artist: kwArtist || result.artist,
        trackCount: tocTracks.length
      });
      if (pick) {
        const detail = await withTimeout(
          netease.getAlbum(pick.candidate.id), STAGE_TIMEOUT.netease, '网易云专辑详情'
        );
        if (detail) {
          // ★ 先切到本碟，再做时长吻合判定与曲目套用
          const discGroups = netease.groupByDisc(detail.tracks);
          neTracks = netease.tracksOfDisc(detail.tracks, wantDisc);
          /**
           * 若本碟号在网易云里不存在（例如用户手里是 disc2，但网易云把
           * 双碟合成了一个 1 碟 30 轨的条目不标碟号），退化为整体曲目表，
           * 并让后续的时长匹配来把关（不许错位就不贴）。
           */
          if (!neTracks.length) neTracks = detail.tracks.slice();

          const ratio = netease.durationMatchRatio(neTracks, tocTracks);
          const countOk = neTracks.length === tocTracks.length;
          const n = netease.norm;
          /**
           * 采用条件分三种情况。
           *
           * ★ 这里的关键教训（真实踩坑）：
           *   旧实现把"轨数一致"当成硬性前提，导致一张 5 轨的宇多田光精选集分卷碟，
           *   因为网易云收录的是 18 轨完整版而被**整个跳过** ——
           *   专辑名和艺人都完全对得上，却拿不到封面、歌词、艺术家。
           *
           *   现实里"同一张专辑在不同平台轨数不同"极其常见：
           *   精选集分卷、Deluxe 版多 Bonus、单曲碟 vs 专辑版……
           *   所以判定必须以**名称/艺人**为准，轨数只影响"要不要采用它的曲目名"。
           *
           *  (a) MB 未命中（网易云是唯一身份来源）—— 要求严格：
           *      轨数一致且时长吻合，或名称与艺人高度一致。
           *  (b) MB 已命中 —— 网易云是"补封面/歌词/艺人"的补全源：
           *      只要**专辑名吻合**（或一方包含另一方）就采信。
           *      歌手对不上也不阻止（日文碟常见 MB 罗马字 vs 网易云日文原名）。
           *  (c) 其它情况 —— 拒绝。
           */
          const nameOk = !kwAlbum ||
            n(detail.name) === n(kwAlbum) ||
            n(detail.name).indexOf(n(kwAlbum)) >= 0 ||
            n(kwAlbum).indexOf(n(detail.name)) >= 0;
          const artistOk = !kwArtist || !detail.artist ||
            n(detail.artist).indexOf(n(kwArtist)) >= 0 || n(kwArtist).indexOf(n(detail.artist)) >= 0;

          // ★ 多碟专辑：碟总数以网易云为准（它能直接给出 cd 的最大值）
          if (discGroups.size > 1) result.discTotal = Math.max(result.discTotal || 1, discGroups.size);

          if (!result.album) {
            // (a) MB 未命中：严格判定
            if (countOk && ratio >= 0.5) {
              neAlbum = detail;
              nePickScore = pick.score + ratio * 3;
            } else if (nameOk && artistOk) {
              neAlbum = detail;
              nePickScore = pick.score;
            }
          } else if (nameOk) {
            // (b) MB 已命中：名称吻合即采信（拿到封面/歌词/艺人）
            neAlbum = detail;
            nePickScore = pick.score + ratio;
          }
        }
      }
    } catch (e) {
      neAlbum = null;
    }
  }
  if (neAlbum) {
    mergeInto(result, {
      album: neAlbum.name,
      artist: neAlbum.artist,
      year: neAlbum.year,
      genres: neAlbum.genres,
      coverUrl: neAlbum.coverUrl,
      company: neAlbum.company,
      // ★ 专辑介绍：网易云专辑详情的 description（v10.4）。
      //   没有介绍的专辑该项为 null，界面据此隐藏"专辑"页的介绍区。
      albumIntro: neAlbum.description || null,
      neteaseAlbumId: neAlbum.id,
      // ★ 碟号由网易云带出（多碟专辑的 cd 字段 → discTotal）
      discNumber: wantDisc,
      discTotal: neAlbum.discTotal
    }, 'netease');
    /**
     * 曲目覆盖策略（三种情况）：
     *
     *   1) 轨数一致且时长吻合 → 整体采用网易云曲目名（最贴合实物碟）。
     *   2) 轨数相同但时长对不上 → 可能是另一版本，交给时长逐轨比对把关。
     *   3) 轨数差异较大 → **完全不动曲目名**。
     *
     * 第 3 条是这次新加的，理由是个真实案例：用户的 5 轨精选集分卷碟，
     * 网易云对应的是 18 轨完整版。此时"按时长就近匹配"毫无意义 ——
     * 18 首歌里随便挑时长最接近的，很容易把完全不同的歌名贴上去，
     * 比"保留 MB 给的正确名字"糟得多。
     * 封面/歌词/艺人照常采用，只是曲目名不动。
     *
     * ★ 注意 allTracks 与 neTracks 的区别：
     *   neTracks 是"本碟"那一份（已按碟号切好），ratios/count 都用它算；
     *   把它传给 applyTracks 就绝不会再把别的碟的曲目串进来。
     */
    const trackDiff = Math.abs(neTracks.length - tocTracks.length);
    if (neTracks.length === tocTracks.length &&
        netease.durationMatchRatio(neTracks, tocTracks) >= 0.5) {
      applyTracks(result, neTracks, tocTracks);
    } else if (trackDiff <= 2) {
      // 差异很小时才尝试按时长逐轨对应（Deluxe 多 1~2 首的典型情况）
      applyTracksByDuration(result, neTracks, tocTracks);
    }
    // trackDiff > 2：不碰曲目名，保留 MB 的结果
    result.neteaseAlbumId = neAlbum.id;
  }

  /* ---------- 阶段 4：iTunes 兜底（英文碟） ---------- */
  if (!result.album || !result.coverUrl) {
    try {
      onStage('itunes');
      const term = [kwAlbum || result.album, kwArtist || result.artist].filter(Boolean).join(' ');
      if (term) {
        const cands = await withTimeout(itunes.searchAlbums(term, 8), STAGE_TIMEOUT.itunes, 'iTunes');
        // 只在曲目数一致时候选，避免错配
        const exact = (cands || []).filter((c) => c.trackCount === tocTracks.length);
        if (exact.length) {
          const detail = await withTimeout(itunes.getAlbum(exact[0].id), STAGE_TIMEOUT.itunes, 'iTunes 曲目');
          if (detail) {
            mergeInto(result, {
              album: detail.name,
              artist: detail.artist,
              year: detail.year,
              coverUrl: detail.coverUrl,
              genres: detail.genres,
              itunesAlbumId: detail.id
            }, 'itunes');
            // iTunes 一般给单碟曲目表；仍按碟过滤以保持一致
            const itTracks = filterTracksByDisc(detail.tracks, wantDisc);
            if (itTracks.length) applyTracks(result, itTracks, tocTracks);
          }
        }
      }
    } catch (e) { /* 兜底源失败可接受 */ }
  }

  /* ---------- 阶段 5：MusicBrainz 文本检索兜底 ---------- */
  if (!result.album && (hint.album || hint.artist)) {
    try {
      const rel = await withTimeout(searchRelease(hint.album, hint.artist), STAGE_TIMEOUT.mb, 'MB 检索');
      if (rel) mergeInto(result, rel, 'musicbrainz-search');
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 歌手介绍（网易云歌手接口，v10.4） ---------- */
  /**
   * 专辑详情只有专辑简介，没有歌手简介 —— 歌手介绍要按 artistId 再问一次
   * 歌手接口。这是纯增强字段：拿不到不影响任何既有行为，因此独立 try/catch
   * + 独立超时，绝不阻塞后面的封面与歌词阶段。
   */
  if (neAlbum && neAlbum.artistId && !result.artistIntro) {
    try {
      const artist = await withTimeout(
        netease.getArtistDetail(neAlbum.artistId), STAGE_TIMEOUT.netease, '网易云歌手'
      );
      if (artist && artist.briefDesc) {
        result.artistIntro = artist.briefDesc;
      }
    } catch (e) { /* 歌手介绍缺失可接受 */ }
  }

  /* ---------- 封面下载（多候选，先到先得） ---------- */
  /**
   * 候选顺序**有意把网易云排在 CAA 前面**。
   * Cover Art Archive 在大陆实测经常 TLS 直接重置（5~6s 才失败），
   * 若排在前面，即使网易云 0.2s 就能给图，也要先白等好几秒。
   * 因此：国内可达的源优先，海外的 CAA 只作兜底，且用更短超时。
   */
  const coverCandidates = [];
  if (neAlbum && neAlbum.coverUrl) {
    coverCandidates.push({ fetch: () => netease.downloadCover(neAlbum.coverUrl) });
  }
  if (result.coverUrl && !(neAlbum && neAlbum.coverUrl)) {
    // iTunes 或其它源给的直链
    coverCandidates.push({ url: result.coverUrl });
  }
  if (result.releaseMbid) {
    coverCandidates.push({
      url: `https://coverartarchive.org/release/${result.releaseMbid}/front-500`,
      timeout: CAA_TIMEOUT
    });
  }
  if (result.releaseGroupMbid) {
    coverCandidates.push({
      url: `https://coverartarchive.org/release-group/${result.releaseGroupMbid}/front-500`,
      timeout: CAA_TIMEOUT
    });
  }
  let coverBuffer = null;
  try {
    coverBuffer = await downloadCoverFrom(coverCandidates, onStage);
  } catch (e) { /* 无封面不影响 */ }
  if (coverBuffer) result.coverBuffer = coverBuffer;

  /* ---------- 歌词（网易云优先，LRCLIB 兜底） ---------- */
  try {
    onStage('lyrics');
    await attachLyrics(result, neAlbum, neTracks, tocTracks, wantDisc, onLyrics, log);
  } catch (e) { /* 歌词缺失不影响 */ }

  // 若某轨仍无标题，退回"轨道 N"，保证界面永远有可显示文本
  result.tracks.forEach((tr, i) => {
    if (!tr.title || !String(tr.title).trim()) tr.title = `轨道 ${tr.number || (i + 1)}`;
  });
  result.trackCount = tocTracks.length || result.tracks.length;
  result.source = result.sources.length ? result.sources[0] : 'unknown';
  // ★ 碟号兜底：确保出口一定带一个合法的 1 起碟号
  if (!(Number(result.discNumber) >= 1)) result.discNumber = wantDisc;
  return validateMetadata(result);
}

/**
 * 挂接歌词（多源逐字降级链）。
 *
 * 主路径是 lyrics.js 的 fetchLyricsRichAll（全收集模式）：跑完所有源，
 * 按质量分取最优写进 lyricsData，同时把**全部候选**存进 lyricsSources，
 * 供编辑面板的"歌词源管理"让用户手动切换：
 *   AMLL TTML DB → 网易云 yrc → QQ QRC → 酷狗 KRC → 网易云 lrc → LRCLIB
 * 拿到的是**统一歌词模型**（lyrics-model.js 的 finalizeModel 输出），同时：
 *   - tr.lyricsData  结构化逐字模型（渲染端 lyrics-view.js 的主输入）
 *   - tr.lyrics      经典 LRC 文本（由模型 toLrc 生成，兜底旧渲染/导出）
 *   - tr.lyricsTranslation 译文 LRC（浮动条等旧消费者）
 *
 * ★ 多碟专辑必须用**本碟**曲目子集（neAlbumTracks 已被上层按碟号切好）建
 *   number → songId 映射。旧实现用整张专辑扁平 songs 建 Map，多碟时轨号
 *   1..N 重复，后一张碟会覆盖先一张 —— disc1 前 N 首全部拿到 disc2 的歌词。
 *
 * ★ 整体截止时间：每首歌最坏要走完 6 个源（约 10s），12 首就是 120s+，
 *   远超 STAGE_TIMEOUT.lyrics。这里给整阶段一个 deadline，超时后不再开新歌，
 *   已拿到歌词的轨不受影响（读盘就绪不依赖歌词，用户可先听）。
 *
 * ★ log：歌词降级链的诊断日志（lyrics.js 的 won/trySource 产出）。应用里由
 *   cd-service 传入，写进 debug.log —— 用户据此判断"为什么这首是 LRC"：
 *   命中源、逐字/行级、行数、质量分、译/音/对唱标记，一行说清。
 */
async function attachLyrics(result, neAlbum, neAlbumTracks, tocTracks, discNumber, onProgress, log) {
  const total = result.tracks.length;
  let done = 0;
  let anyFilled = false;
  const wantDisc = Math.floor(Number(discNumber)) || 1;
  const deadline = Date.now() + STAGE_TIMEOUT.lyrics;

  // 1) 网易云专辑曲目表 → number → songId（仅本碟！）
  const discTracks = (neAlbumTracks && neAlbumTracks.length)
    ? neAlbumTracks
    : (neAlbum && neAlbum.tracks ? netease.tracksOfDisc(neAlbum.tracks, wantDisc) : []);
  const idByNum = new Map();
  for (const t of discTracks) idByNum.set(Number(t.number), t.neteaseSongId);

  // 2) 需要歌词的轨：没有结构化模型、也没有经典 LRC 的才处理
  const placeholder = /^轨道\s*\d+$/;
  const queue = result.tracks.filter((tr) => {
    if (tr.lyricsData || tr.lyrics) return false;
    if (!tr.title || placeholder.test(String(tr.title).trim())) return false;
    return true;
  });

  let idx = 0;
  const worker = async () => {
    while (idx < queue.length) {
      if (Date.now() > deadline) break; // 整体超时：不再开新歌
      const tr = queue[idx++];
      const songId = tr.neteaseSongId || idByNum.get(Number(tr.number)) || null;
      try {
        /**
         * ★ 全收集模式（fetchLyricsRichAll）：跑完所有源，把全部候选存进
         *   tr.lyricsSources —— 编辑面板的"歌词源管理"据此让用户看到
         *   所有获取到的歌词并手动挑一个（见 lyrics-select.js）。
         *   代价是每首多问酷狗/LRCLIB 约 1~3s，由上面的 deadline 兜底。
         */
        const got = await withTimeout(
          fetchLyricsRichAll({
            title: tr.title,
            artist: tr.artist || result.artist || '',
            album: result.album || '',
            durationSec: tr.durationSec || 0,
            neteaseSongId: songId,
            log
          }),
          Math.max(3000, deadline - Date.now()),
          '歌词降级链'
        );
        if (got && got.best && got.best.lines && got.best.lines.length) {
          tr.lyricsSources = got.candidates;
          applyModelToTrack(tr, got.best);
          anyFilled = true;
        }
      } catch (e) { /* 单曲失败继续 */ }
      done++;
      if (onProgress) onProgress(done, total);
    }
  };
  const conc = Math.min(3, Math.max(1, queue.length));
  await Promise.all(Array.from({ length: conc }, worker));

  // 3) 兜底：仍一无所有的轨走老 LRCLIB 路径（fetchLyricsRich 内部已含 LRCLIB，
  //    这里是整链异常时的双保险，正常不会触发）
  const pending = result.tracks.filter((tr) => !tr.lyrics && !tr.lyricsData && !placeholder.test(String(tr.title || '').trim()));
  if (pending.length && Date.now() < deadline) {
    if (log) log('lyrics[兜底] ' + pending.length + '轨走 LRCLIB 双保险（降级链整体异常时触发）');
    try {
      const list = await withTimeout(
        fetchLyricsForTracks(pending, {
          onProgress: (d) => {
            if (onProgress) onProgress(done + d, total);
          }
        }),
        Math.max(3000, deadline - Date.now()),
        'LRCLIB'
      );
      list.forEach((res, i) => {
        if (res && pending[i]) {
          pending[i].lyrics = res.lyrics;
          pending[i].lyricsSynced = res.synced;
          pending[i].lyricsSource = 'lrclib';
          anyFilled = true;
        }
      });
    } catch (e) { /* 忽略 */ }
  }

  return anyFilled;
}

/**
 * 歌词补抓：缓存命中但缺歌词的碟专用（v10.4）。
 *
 * 场景：老版本存的缓存、或上次抓取时歌词阶段整体超时的碟 —— 命中缓存后
 * 完全不联网，歌词永远是空的，用户只能手动打开编辑面板点"重新获取"。
 * 本函数只补歌词，不动专辑名 / 封面 / 曲目名等任何已有字段。
 *
 * 步骤与完整抓取一致（同一套网易云选碟 + 同一套 attachLyrics 降级链）：
 *   1) 用缓存里的专辑名 + 歌手搜网易云，pickAlbum 选碟；
 *   2) 拿专辑详情，按本碟碟号切出曲目表（建 number → songId 映射）；
 *   3) 用缓存曲目建骨架（带上已有歌词，attachLyrics 会自动跳过），
 *      跑降级链，只把缺歌词的轨挂上歌词。
 *
 * @param {object} meta       缓存里的元数据（只要 album/artist/discNumber/tracks）
 * @param {Array}  tocTracks  本碟 TOC 轨（用于选碟时的轨数/时长判定）
 * @param {object} [opts]     { log, onProgress(done,total) }
 * @returns {Promise<{filled:number, tracks:Array|null}>}
 */
async function fetchLyricsOnly(meta, tocTracks, opts = {}) {
  const log = opts.log || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const wantDisc = Math.floor(Number(meta && meta.discNumber)) || 1;
  const kwAlbum = (meta && meta.album) || '';
  const kwArtist = (meta && meta.artist) || '';
  const keyword = [kwAlbum, kwArtist].filter(Boolean).join(' ').trim();
  if (!keyword) return { filled: 0, tracks: null };

  /* 1) 网易云选碟（与完整抓取同参数：专辑名 / 歌手 / TOC 轨数） */
  let neAlbum = null;
  let neTracks = [];
  try {
    const candidates = await withTimeout(
      netease.searchAlbums(keyword, 10), STAGE_TIMEOUT.netease, '网易云搜索'
    );
    const pick = netease.pickAlbum(candidates || [], {
      album: kwAlbum,
      artist: kwArtist,
      trackCount: (tocTracks || []).length
    });
    if (pick) {
      const detail = await withTimeout(
        netease.getAlbum(pick.candidate.id), STAGE_TIMEOUT.netease, '网易云专辑详情'
      );
      if (detail) {
        neAlbum = detail;
        // ★ 必须先切到本碟再做映射：多碟专辑扁平 songs 里轨号各自从 1 开始，
        //   不切碟会把 disc2 的歌词贴到 disc1 的同号轨上。
        neTracks = netease.tracksOfDisc(detail.tracks, wantDisc);
        if (!neTracks.length) neTracks = detail.tracks.slice();
      }
    }
  } catch (e) {
    log('lyrics-only: 网易云选碟失败 ' + (e && e.message ? e.message : e));
    return { filled: 0, tracks: null };
  }
  if (!neAlbum) {
    log('lyrics-only: 未匹配到网易云专辑（keyword=' + keyword + '）');
    return { filled: 0, tracks: null };
  }

  /* 2) 骨架：缓存曲目原样带上（含已有歌词 → 降级链自动跳过，不会重抓/覆盖） */
  const skeleton = {
    album: kwAlbum,
    artist: kwArtist,
    tracks: ((meta && meta.tracks) || []).map((t) => ({
      number: t.number,
      title: t.title,
      artist: t.artist || kwArtist,
      durationSec: t.durationSec,
      lyrics: t.lyrics || null,
      lyricsData: t.lyricsData || null
    }))
  };

  /* 3) 降级链（与完整抓取同一个 attachLyrics） */
  try {
    await attachLyrics(skeleton, neAlbum, neTracks, tocTracks || [], wantDisc, onProgress, log);
  } catch (e) {
    log('lyrics-only: 降级链异常 ' + (e && e.message ? e.message : e));
    return { filled: 0, tracks: null };
  }

  let filled = 0;
  for (const tr of skeleton.tracks) {
    if (tr.lyrics || tr.lyricsData) filled++;
  }
  return { filled, tracks: skeleton.tracks };
}

module.exports = {
  fetchDiscMetadata,
  fetchLyricsOnly,
  emptySkeleton,
  mergeInto,
  applyTracks,
  applyTracksByDuration,
  filterTracksByDisc,
  inferDiscNumber,
  discInfoOf
};
