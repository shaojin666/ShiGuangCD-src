'use strict';
/*
 * tests/lyrics-select.test.js —— 歌词源管理（编辑面板后端）离线单测。
 *
 * 覆盖 lyrics-select.js 三个操作：
 *   selectSource  从候选里挑一个启用（含白名单重过、越界/坏模型拒绝）
 *   addTtml       粘贴 TTML → 解析入列并启用（含空文本/坏 XML/指纹去重）
 *   removeSource  删手动候选（在线候选拒删；删当前项回退质量最高剩余）
 *
 * TTML 用 tests/fixtures 下的真实样本（祝福，AMLL 格式），
 * 解析器/白名单都是真实代码，不发任何网络请求。
 *
 * 运行：node tests/lyrics-select.test.js
 */

const fs = require('fs');
const path = require('path');
const { selectSource, addTtml, removeSource, MANUAL_SOURCE } =
  require(path.join(__dirname, '..', 'main', 'metadata', 'lyrics-select'));

const TTML_SHUKUFUKU = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'amll-yoasobi-shukufuku.ttml'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n---- ' + name + ' ----'); }

/** 造一个带两候选手动 meta 的测试碟 */
function makeMeta() {
  const amll = {
    v: 1, source: 'amll', isWordByWord: true, quality: 130,
    lines: [
      { t: 0, e: 3, text: '遥', words: [{ t: 0, e: 1, text: '遥' }, { t: 1, e: 3, text: '远' }] },
      { t: 3, e: 6, text: '星', words: [{ t: 3, e: 6, text: '星' }] }
    ]
  };
  const lrc = {
    v: 1, source: 'netease', isWordByWord: false, quality: 60,
    lines: [{ t: 0, e: 3, text: '第一行' }, { t: 3, e: 6, text: '第二行' }]
  };
  return {
    signature: 'sig-select', album: '选源测试', artist: '测试艺术家', year: 2021, trackCount: 1,
    tracks: [{
      number: 1, title: '祝福', artist: 'YOASOBI', durationSec: 181,
      lyrics: '[00:00.00]第一行\n[00:03.00]第二行', lyricsSynced: true,
      lyricsSource: 'netease', lyricsData: lrc, lyricsSources: [amll, lrc]
    }]
  };
}

function main() {

  /* ================================================================
   * 1) selectSource
   * ================================================================ */
  section('selectSource：启用列表里的候选');

  {
    const meta = makeMeta();
    const r = selectSource(meta, 1, 0); // 切到 amll
    ok(r.ok, '返回 ok');
    ok(meta.tracks[0].lyricsData.source === 'amll', 'lyricsData 已切到 amll');
    ok(meta.tracks[0].lyricsSource === 'amll', 'lyricsSource 同步');
    ok(/^\[00:00\.00\]遥/.test(meta.tracks[0].lyrics),
      'LRC 文本按新模型重建（toLrc 用行文本）', meta.tracks[0].lyrics);
    ok(Array.isArray(meta.tracks[0].lyricsSources) && meta.tracks[0].lyricsSources.length === 2,
      '候选列表不动（只是换启用项）');
  }

  {
    const meta = makeMeta();
    delete meta.tracks[0].lyricsSources;
    const r = selectSource(meta, 1, 0);
    ok(!r.ok && r.error === 'no-sources', '无候选列表 → no-sources', r);
  }

  {
    const meta = makeMeta();
    ok(selectSource(meta, 1, 5).error === 'bad-index', '越界 index → bad-index');
    ok(selectSource(meta, 1, -1).error === 'bad-index', '负 index → bad-index');
    ok(selectSource(meta, 99, 0).error === 'track-not-found', '轨不存在 → track-not-found');
  }

  {
    // 缓存文件可能被手改：结构不合法的候选必须拒收，不能把脏数据写进 lyricsData
    const meta = makeMeta();
    meta.tracks[0].lyricsSources[1] = { v: 1, source: 'x', lines: [{ t: 'abc' }] };
    const r = selectSource(meta, 1, 1);
    ok(!r.ok && r.error === 'bad-model', '坏模型 → bad-model', r);
    ok(meta.tracks[0].lyricsData.source === 'netease', '拒收后启用项保持原样');
  }

  /* ================================================================
   * 2) addTtml
   * ================================================================ */
  section('addTtml：粘贴 TTML 入列并启用');

  {
    const meta = makeMeta();
    const r = addTtml(meta, 1, TTML_SHUKUFUKU);
    ok(r.ok, '真实 TTML 解析成功');
    ok(r.index === 2 && meta.tracks[0].lyricsSources.length === 3, '追加到候选列表末尾');
    ok(meta.tracks[0].lyricsSources[2].source === MANUAL_SOURCE, '候选打上手动标记');
    ok(meta.tracks[0].lyricsData.source === MANUAL_SOURCE, '粘贴后立即启用');
    ok(meta.tracks[0].lyricsSource === MANUAL_SOURCE, 'lyricsSource 同步');
    ok(/遥/.test(meta.tracks[0].lyrics), 'LRC 文本由新模型重建');
  }

  {
    const meta = makeMeta();
    ok(addTtml(meta, 1, '').error === 'empty', '空文本 → empty');
    ok(addTtml(meta, 1, '   \n  ').error === 'empty', '纯空白 → empty');
    ok(addTtml(meta, 1, '这不是 XML').error === 'not-ttml-or-empty',
      '非 TTML 文本 → not-ttml-or-empty（parseTTML 不抛错，返 null 收敛）');
    ok(meta.tracks[0].lyricsSources.length === 2, '失败不改动候选列表');
    ok(meta.tracks[0].lyricsData.source === 'netease', '失败不改变启用项');
    ok(addTtml(meta, 42, TTML_SHUKUFUKU).error === 'track-not-found', '轨不存在 → track-not-found');
  }

  {
    // 带 BOM / 前后空白也要能解析（从网页工具复制常带这些）
    const meta = makeMeta();
    const r = addTtml(meta, 1, '\uFEFF' + TTML_SHUKUFUKU + '\n\n');
    ok(r.ok, 'BOM + 尾随空白不影响解析');
  }

  {
    // 同一份 TTML 重复粘贴 → 指纹去重，替换而不是堆叠
    const meta = makeMeta();
    const r1 = addTtml(meta, 1, TTML_SHUKUFUKU);
    const r2 = addTtml(meta, 1, TTML_SHUKUFUKU);
    ok(r1.ok && r2.ok, '两次粘贴都成功');
    ok(r2.replaced === true && r2.index === r1.index, '第二次是替换（replaced）', r2);
    ok(meta.tracks[0].lyricsSources.length === 3, '列表长度不增长', meta.tracks[0].lyricsSources.length);
    ok(meta.tracks[0].lyricsData.source === MANUAL_SOURCE, '替换后仍启用手动源');
  }

  {
    // 不同打轴的 TTML 应各占一行（指纹不能误判）。
    // 注意：行时间取自 <p> 的 begin——只改词级 span 的 begin 指纹不变
    // （同一行歌词，属正确去重）；要造"不同打轴"必须挪 <p> 的行时间。
    const meta = makeMeta();
    addTtml(meta, 1, TTML_SHUKUFUKU);
    const tweaked = TTML_SHUKUFUKU.replace('<p begin="00:00.917" end="00:03.669"',
      '<p begin="00:05.917" end="00:03.669"');
    const r2 = addTtml(meta, 1, tweaked);
    ok(r2.ok && !r2.replaced, '不同打轴 → 追加为新候选', r2);
    ok(meta.tracks[0].lyricsSources.length === 4, '列表增长到 4', meta.tracks[0].lyricsSources.length);
  }

  {
    // 只改词级时间、行时间不变 → 指纹相同 → 视为同一份（去重不误伤）
    const meta = makeMeta();
    addTtml(meta, 1, TTML_SHUKUFUKU);
    const retimed = TTML_SHUKUFUKU.replace('<span begin="00:00.917" end="00:01.169">遥</span>',
      '<span begin="00:01.917" end="00:02.169">遥</span>');
    const r2 = addTtml(meta, 1, retimed);
    ok(r2.ok && r2.replaced === true, '仅词级微调 → 指纹相同按替换处理', r2);
    ok(meta.tracks[0].lyricsSources.length === 3, '列表不增长', meta.tracks[0].lyricsSources.length);
  }

  /* ================================================================
   * 3) removeSource
   * ================================================================ */
  section('removeSource：只删手动候选，删当前项则回退');

  {
    const meta = makeMeta();
    const r = addTtml(meta, 1, TTML_SHUKUFUKU); // index 2，已启用
    ok(r.ok, '先贴一份 TTML');
    const d = removeSource(meta, 1, 0); // 在线 amll 候选 → 拒删
    ok(!d.ok && d.error === 'not-manual', '在线候选 → not-manual', d);
    ok(meta.tracks[0].lyricsSources.length === 3, '拒删后列表不动');
  }

  {
    // 删的手动源不是当前启用项 → 启用项保持
    const meta = makeMeta();
    addTtml(meta, 1, TTML_SHUKUFUKU);          // index 2 手动（addTtml 会自动启用它）
    selectSource(meta, 1, 1);                  // 再切回 netease，让手动源沦为非当前项
    const d = removeSource(meta, 1, 2);
    ok(d.ok, '删手动候选成功');
    ok(meta.tracks[0].lyricsSources.length === 2, '列表回到 2');
    ok(meta.tracks[0].lyricsData.source === 'netease', '非当前项被删 → 启用项保持',
      meta.tracks[0].lyricsData.source);
    ok(/^\[00:00\.00\]第一行/.test(meta.tracks[0].lyrics), 'LRC 文本不变');
  }

  {
    // 删的正是当前启用项 → 回退到剩余里质量最高的（amll 130 > netease 60）
    const meta = makeMeta();
    addTtml(meta, 1, TTML_SHUKUFUKU);          // index 2 手动，addTtml 后即为当前启用项
    const d = removeSource(meta, 1, 2);
    ok(d.ok, '删除当前启用的手动源');
    ok(meta.tracks[0].lyricsData.source === 'amll',
      '回退到质量最高的剩余候选（amll 130 > netease 60）', meta.tracks[0].lyricsData.source);
    ok(/^\[00:00\.00\]遥/.test(meta.tracks[0].lyrics), 'LRC 文本同步回退',
      meta.tracks[0].lyrics);
  }

  {
    // 只剩手动源且被删 → 歌词清空，不留半截数据
    const meta = makeMeta();
    meta.tracks[0].lyricsSources = null;
    addTtml(meta, 1, TTML_SHUKUFUKU);
    const d = removeSource(meta, 1, 0);
    ok(d.ok, '唯一候选被删');
    ok(meta.tracks[0].lyricsSources === null, '候选列表清空为 null');
    ok(meta.tracks[0].lyricsData === null && meta.tracks[0].lyrics === null,
      '歌词数据一并清空', { d: meta.tracks[0].lyricsData, l: meta.tracks[0].lyrics });
    ok(meta.tracks[0].lyricsSynced === false, '同步标记复位');
  }

  {
    const meta = makeMeta();
    ok(removeSource(meta, 1, 9).error === 'bad-index', '越界 → bad-index');
    ok(removeSource(meta, 42, 0).error === 'track-not-found', '轨不存在 → track-not-found');
  }

  console.log('\n' + (fail ? fail + ' 个断言未通过' : 'ALL PASS（' + pass + ' 断言）'));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
