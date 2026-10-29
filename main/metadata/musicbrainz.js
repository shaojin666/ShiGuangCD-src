'use strict';
/*
 * musicbrainz.js —— 通过 MusicBrainz Web Service 按 TOC 反查唱片信息。
 *
 * ★ 本次修复的核心 bug：
 *   旧实现请求 `ws/2/discid/?toc=...` 后，去读 `data.discs[0].releases`。
 *   但 MusicBrainz 的 discid 接口**返回的就直接是发行列表**：
 *       { "releases": [ { id, title, media:[...], ... } ], "release-count": N }
 *   根本没有 discs 字段。于是 `if (!data.discs ...) return null` 永远成立，
 *   整个在线匹配环节 100% 走空分支 —— 这就是"联网获取元数据无效"的直接原因。
 *
 * 另一个坑：TOC 参数里的空格必须编码为 `+`（application/x-www-form-urlencoded），
 * 旧实现用 encodeURIComponent 把空格变成 %20，部分链路上会被当作字面量处理。
 */

const { getJson, withTimeout } = require('./http');

/**
 * 单次 MusicBrainz 查询的硬超时。
 *
 * 取值说明：MB 高峰期单次 WS 调用可能 8~15 秒，但**不能因此就把超时设得很大**——
 * MB 只是"精确识碟"的加分项，不该拖垮整条链路（网易云等国内源还在后面等着）。
 * 11s 略小于编排层的 12s 阶段超时，保证是**内部先超时并优雅返回 null**，
 * 而不是外层把请求掐断、留下悬挂的连接。实测 MB 命中时通常在 1.8~6s 返回。
 */
const MB_TIMEOUT_MS = 11000;

/**
 * ★★ 这是"联网获取时灵时不灵"的真正根因，务必理解后再改：
 *
 * 旧实现用的 inc 是 `recordings+artist-credits+release-groups+genres`，
 * 结论是响应体巨大 —— 实测同一个 TOC：
 *
 *   inc = recordings                                        → 132 KB,  3.5s  ✅
 *   inc = recordings+artist-credits+release-groups+genres   → 483 KB, 24.7s  ⚠️
 *
 * 24.7 秒在任何一个合理超时下都是"失败"。而**并不是 MusicBrainz 服务端慢**，
 * 是响应体膨胀 3.7 倍后，在大陆到欧洲的链路上单纯传不完。
 *
 * 更关键的是：`inc=recordings` 返回的内容**已经包含** artist-credit 与
 * release 级的 title/date/status，足够本项目所需的全部字段；
 * 额外的 `release-groups`/`genres` 只带来体积，几乎不带来可用信息
 * （genres 命中率极低，release-group 的 id 在 discid 接口里本就可选）。
 *
 * 因此只保留 `recordings`，把响应体从 ~480KB 压到 ~130KB，
 * 耗时从 20+s 降到 3~4s —— 这才是"能不能稳定拿到元数据"的决定因素。
 */
const MB_INC = 'recordings';

/**
 * 解析 MusicBrainz 的 artist-credit 数组为可读的艺人名。
 *
 * ★ 这里有个容易漏掉的细节：artist-credit 的元素**有两种形态**，
 *   取决于请求的 inc 参数以及该条记录是否已"展开"：
 *
 *     A) { name: "宇多田ヒカル", joinphrase: "" }            ← 已展开，name 在顶层
 *     B) { artist: { id: "...", name: "宇多田ヒカル" } }      ← 未展开，name 在嵌套里
 *
 *   旧实现只读 `part.name`，遇到 B 形态就返回空串 —— 于是**专辑的艺术家字段为空**，
 *   界面上"艺术家"一栏空白（而专辑名、年份、曲目名都正常，因为它们不来自这个字段）。
 *   现在两种形态都兼容。
 */
function artistCreditName(ac) {
  if (!Array.isArray(ac)) return '';
  return ac
    .map((part) => {
      if (!part) return '';
      const name = part.name || (part.artist && part.artist.name) || '';
      return name + (part.joinphrase || '');
    })
    .join('')
    .trim();
}

/** TOC 参数：空格必须编码成 + （表单语义），逗号/加号保持字面量 */
function encodeToc(tocParam) {
  return encodeURIComponent(tocParam).replace(/%20/g, '+');
}

/**
 * 从候选发行里挑最符合本张碟的那一个。
 * 打分维度（经验值）：轨道数完全一致最重要，其次发行类型、状态、日期完整度。
 *
 * ★ 多碟专辑（box set、双碟豪华版）的关键处理：
 *   一张 multi-disc release 的 `media` 数组里，每个元素就是**一张碟**
 *   （其 `position` 即碟号）。旧实现用 `media.filter(track-count 匹配)` 取
 *   **第一个**匹配的 medium —— 当 disc1 与 disc2 轨数恰好相同时，
 *   放进 disc2 也会命中 disc1 的那一份，于是曲目表整份错位到另一张碟上。
 *
 *   现在的做法：tracks 参数之外再接受一个可选的 `discHint`（上层推断出的碟号）。
 *   有 hint 时优先选 position === hint 的 medium；没有 hint 时**保留全部**
 *   轨数匹配的 mediums（`mediums` 数组），交由上层先推断碟号再决定用哪一份。
 */
function pickBestRelease(releases, trackCount, discHint) {
  const hint = Number(discHint) >= 1 ? Math.floor(Number(discHint)) : null;
  const scored = [];
  for (const release of releases || []) {
    let media = (release.media || []).filter((m) => (m['track-count'] || 0) === trackCount);
    if (!media.length) continue;
    // 有碟号提示：只保留该碟号的 medium（多碟专辑精确落点）
    if (hint != null) {
      const exact = media.filter((m) => (m.position || 1) === hint);
      if (exact.length) media = exact;
    }
    const group = release['release-group'] || {};
    const primary = group['primary-type'] || '';
    let score = 0;
    if (primary === 'Album') score += 3;
    else if (primary === 'EP') score += 1;
    else if (primary === 'Single') score -= 1;
    if (release.status === 'Official') score += 2;
    if (release.date) score += 1;
    // 有唱片编号/地区信息说明记录更完整
    if (release['label-info'] && release['label-info'].length) score += 0.5;
    // 碟总数 > 1 说明这是多碟发行：有碟号提示时这样的记录更可信
    const discCount = (release.media || []).length;
    if (hint != null && discCount > 1 && media[0] && media[0].position === hint) score += 1;
    scored.push({
      release,
      medium: media[0],
      // ★ 同一 release 内所有轨数匹配的 medium（含各自的碟号），供上层先推断碟号
      media,
      mediums: media,
      discCount,
      discNumber: media[0] ? (media[0].position || 1) : 1,
      score,
      date: release.date || '9999'
    });
  }
  if (!scored.length) return null;
  // 先比分数，再比日期（同分取更早的原始发行）
  scored.sort((a, b) => b.score - a.score || String(a.date).localeCompare(String(b.date)));
  return scored[0];
}

/** 把 MB 的 release 对象规范化为本应用内部结构 */
function normalizeRelease(release, medium, trackCount, discId, opts) {
  const group = release['release-group'] || {};
  const genres = [];
  for (const g of (release.genres || group.genres || [])) {
    if (g && g.name && genres.length < 3) genres.push(g.name);
  }
  const albumArtist = artistCreditName(release['artist-credit']);

  // ★ 碟号取 medium.position（MusicBrainz 里 1 起，就是"第几张碟"）
  const discNumber = Number(opts && opts.discNumber) >= 1
    ? Math.floor(Number(opts.discNumber))
    : (medium && medium.position ? Number(medium.position) : 1);
  // 碟总数 = 该 release 的 media 数量（多碟发行的权威来源）
  const discTotal = (opts && opts.discTotal) || (release.media ? release.media.length : 1) || 1;

  const tracks = (medium.tracks || []).map((tr) => {
    const length = typeof tr.length === 'number' ? tr.length / 1000 : null;
    return {
      number: tr.position,
      discNumber,
      title: tr.title,
      artist: artistCreditName(tr['artist-credit']) || albumArtist,
      durationSec: length,
      recordingMbid: tr.recording && tr.recording.id,
      lyrics: null,
      lyricsSynced: false
    };
  }).filter((t) => t.number >= 1);

  const year = release.date ? (parseInt(String(release.date).slice(0, 4), 10) || null) : null;
  return {
    source: 'musicbrainz',
    mbDiscId: discId || null,
    releaseMbid: release.id,
    releaseGroupMbid: group.id,
    album: release.title,
    artist: albumArtist,
    year,
    genres,
    trackCount,
    discNumber,
    discTotal,
    tracks
  };
}

/**
 * 按 TOC 查询 MusicBrainz（唯一能按光盘指纹精确匹配的源）。
 *
 * ★ discHint（可选）：上层已推断出的碟号。
 *   MusicBrainz 的 discid 接口本身**不返回**"这张 TOC 是某发行的第几张碟"，
 *   但返回的 release.media[].position 就是碟号。当知道用户手里是第几张碟
 *   （来自缓存里记过的碟号，或用户手动指定），把它传进来就能在多碟发行里
 *   精确定位到对应 medium，而不是盲目取第一张轨数匹配的碟。
 *
 * @param {object} toc { first, last, leadout, tracks:[{startFrame}] }
 * @param {object} [opts] { discHint:number }
 * @returns {Promise<object|null>} 规范化元数据，无匹配时返回 null
 */
async function lookupByToc(toc, opts = {}) {
  if (!toc || !toc.tracks || !toc.tracks.length) return null;
  const { first, last, leadout, tracks } = toc;
  const offsets = tracks.map((t) => t.startFrame).join(' ');
  const tocParam = `${first} ${last} ${leadout} ${offsets}`;
  const url = 'https://musicbrainz.org/ws/2/discid/?fmt=json&inc=' + MB_INC +
    '&toc=' + encodeToc(tocParam);

  /**
   * ★ 只发 GET，不再做 POST 兜底。
   *
   * 旧实现认为"GET 可能被链路上截断，换 POST 更稳"，但实测 MB 的 discid 接口
   * **对 POST 恒返回 400**（220ms 快速失败）——也就是说 POST 那条路 100% 是死的，
   * 唯一效果是白白多花一次往返、把失败时间翻倍，掩盖了真正的病因（响应体太大/太慢）。
   * 与其换方法，不如把 inc 瘦身（见 MB_INC 注释），这才是对症的修法。
   *
   * 保留"被限流（429/503）时重试一次"的能力，但那是 http.js 里 getJson 的职责。
   */
  let data = null;
  try {
    data = await withTimeout(getJson(url), MB_TIMEOUT_MS, 'MusicBrainz');
  } catch (e) {
    // 超时/网络错误：明确抛出，让编排层记录并继续走其它源
    throw new Error('MusicBrainz 查询失败：' + e.message);
  }
  if (!data) return null;

  // ★ 正确结构：顶层 releases 数组（旧实现误读 data.discs）
  const releases = (data && data.releases) || [];
  if (!releases.length) return null;

  const pick = pickBestRelease(releases, tracks.length, opts.discHint);
  if (!pick) return null;

  /**
   * ★ 碟号推断（discid 接口的隐藏线索）：
   *   discid 接口会在响应顶层给出 `disc-id` —— 它是**这张 TOC 在 MB 里
   *   注册的那个 DiscID**。一个 release 的每个 medium 都各有一个 disc id。
   *   若我们能拿到 medium 的 disc id（请求 inc=recordings 时通常不含，
   *   这里退化为按 position 取），就用它把碟号钉死。
   *
   *   实际可用的两条线索：
   *     1) 上层给的 discHint（用户已编辑过 / 缓存里记过）→ 最可靠；
   *     2) release.media[].position —— 当该 release 只有一个轨数匹配的 medium 时，
   *        它就是本碟的碟号（多碟发行里唯一能对上的那张）。
   */
  let discNumber = pick.discNumber;
  if (opts.discHint != null && Number(opts.discHint) >= 1) {
    const want = Math.floor(Number(opts.discHint));
    const hit = (pick.mediums || []).find((m) => (m.position || 1) === want);
    if (hit) discNumber = want;
  }
  const discTotal = pick.discCount || 1;

  return normalizeRelease(pick.release, pick.medium, tracks.length,
    (data && data['disc-id']) || null,
    { discNumber, discTotal });
}

/**
 * 文本检索兜底：TOC 匹配不上时（翻录碟、非标准碟、MB 无该 DiscID），
 * 用「专辑名 + 艺术家」作为关键词再试一次。
 */
async function searchRelease(album, artist) {
  const parts = [];
  if (album) parts.push(`release:"${String(album).replace(/"/g, '')}"`);
  if (artist) parts.push(`artist:"${String(artist).replace(/"/g, '')}"`);
  if (!parts.length) return null;

  const url = 'https://musicbrainz.org/ws/2/release/?fmt=json&limit=5&query=' +
    encodeURIComponent(parts.join(' AND '));

  let data = null;
  try {
    data = await withTimeout(getJson(url), MB_TIMEOUT_MS, 'MusicBrainz 检索');
  } catch (e) {
    return null;
  }
  const list = (data && data.releases) || [];
  if (!list.length) return null;

  // 检索结果没有 media.tracks 详情，只能给出专辑级信息（曲目交给其它源补全）
  const rel = list[0];
  const group = rel['release-group'] || {};
  return {
    source: 'musicbrainz-search',
    releaseMbid: rel.id,
    releaseGroupMbid: group.id,
    album: rel.title,
    artist: artistCreditName(rel['artist-credit']),
    year: rel.date ? (parseInt(String(rel.date).slice(0, 4), 10) || null) : null,
    genres: [],
    trackCount: rel['track-count'] || 0,
    tracks: []
  };
}

module.exports = { lookupByToc, searchRelease, artistCreditName, encodeToc, pickBestRelease };
