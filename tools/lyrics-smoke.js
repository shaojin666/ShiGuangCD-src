'use strict';
/*
 * lyrics-smoke.js —— 逐字歌词降级链联网自检工具。
 *
 * 用途：不装 Electron、不开光驱，直接验证 fetchLyricsRich 六源降级链
 * 在你当前网络下的真实表现 —— 也就是回答用户那句"我要如何测试新版功能"。
 *
 * 它复刻应用内的同一条链路（require 的就是 main/metadata/lyrics.js 本体，
 * 不是 mock），所以它说什么，应用里就是什么。
 *
 * 用法
 * ------------------------------------------------------------
 *   # 单曲自检（参数与读碟时传给降级链的字段一一对应）
 *   node tools/lyrics-smoke.js --title "匆匆那年" --artist "王菲" --duration 415
 *
 *   # 已知平台 ID（等价于网易云专辑详情精确对应，绝不搜索）
 *   node tools/lyrics-smoke.js --netease-id 260140
 *   node tools/lyrics-smoke.js --qq-mid 003OUlho2HcRHC
 *
 *   # 内置试样集（覆盖华语/日语/欧美/间奏/对唱，验证降级是否按设计工作）
 *   node tools/lyrics-smoke.js --preset
 *
 *   # 试样集里挑几类跑（逗号分隔）
 *   node tools/lyrics-smoke.js --preset zh,en
 *
 * 输出解读（与 debug.log 里的 lyrics[...] 行同格式）
 * ------------------------------------------------------------
 *   逐字 34行 质量118 译/对唱     ← 拿到了词级时间轴，界面走逐字渲染
 *   行级 42行 质量60             ← 只有 LRC，界面走经典逐行渲染（设计内降级）
 *   六源均未命中                  ← 没收录或网络不可达
 *   lyrics[amll] 失败：...        ← 该源连不上（超时/网络错），会继续尝试后续源
 */

const path = require('path');
const { fetchLyricsRich } = require(path.join(__dirname, '..', 'main', 'metadata', 'lyrics.js'));

/* ---------- 参数解析 ---------- */

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset') { o.preset = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { o[key] = true; continue; }
    o[key] = next;
    i++;
  }
  return o;
}

/* ---------- 试样集 ---------- */
/*
 * 选样原则：每个用例对应一种真实场景，跑完能回答一类问题。
 * 预期结果不是写死的"必须逐字"，而是给出参照 —— 逐字源的覆盖规律是
 * 华语/日语流行曲收录好，欧美碟常退 LRCLIB，这属于设计内降级。
 */
const PRESETS = [
  {
    tag: 'zh',
    name: '华语流行（网易云 yrc 逐字主力场景）',
    title: '匆匆那年', artist: '王菲', durationSec: 415
  },
  {
    tag: 'zh',
    name: '华语流行（另一首，验证稳定复现）',
    title: '演员', artist: '薛之谦', durationSec: 253
  },
  {
    tag: 'jp',
    name: '日语流行（AMLL TTML 高覆盖场景）',
    title: 'Lemon', artist: '米津玄師', durationSec: 255
  },
  {
    tag: 'en',
    name: '欧美流行（大概率降级 LRCLIB 行级，属设计内）',
    title: 'Yellow', artist: 'Coldplay', durationSec: 269
  },
  {
    tag: 'edge',
    name: '边界：纯音乐/冷门曲（验证六源均未命中时的日志）',
    title: '小星星变奏曲 第一乐章', artist: '莫扎特', durationSec: 180
  }
];

/* ---------- 打印 ---------- */

function fmtTime(s) {
  if (s == null || !isFinite(s)) return '  ?  ';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return String(m).padStart(2, '0') + ':' + r.toFixed(2).padStart(5, '0');
}

function printModel(model, elapsed) {
  if (!model || !model.lines || !model.lines.length) {
    console.log('  ✗ 无结果');
    return;
  }
  const tags = [];
  if (model.lines.some((l) => l && l.tr)) tags.push('译');
  if (model.lines.some((l) => l && l.ro)) tags.push('音');
  if (model.lines.some((l) => l && l.bg && l.bg.length)) tags.push('对唱');
  const inst = model.lines.filter((l) => l && l.instrumental).length;
  if (inst) tags.push('间奏×' + inst);
  console.log('  ' + (model.isWordByWord ? '★ 逐字' : '· 行级') +
    '  ' + model.lines.length + '行' +
    '  质量' + Math.round(model.quality || 0) +
    '  源=' + (model.source || '?') +
    (tags.length ? '  ' + tags.join('/') : '') +
    '  (' + elapsed + 'ms)');

  // 前几行预览：行级看文本，逐字看词时间轴
  const show = Math.min(4, model.lines.length);
  for (let i = 0; i < show; i++) {
    const l = model.lines[i];
    if (!l) continue;
    const head = '    ' + fmtTime(l.t);
    if (model.isWordByWord && l.words && l.words.length) {
      const ws = l.words.slice(0, 8).map((w) => w.x + '@' + fmtTime(w.t).trim()).join(' ');
      console.log(head + ' ' + (l.text || '') + '   [词] ' + ws +
        (l.words.length > 8 ? ' …共' + l.words.length + '词' : ''));
    } else {
      console.log(head + ' ' + (l.text || '') +
        (l.tr ? '   [译] ' + l.tr : '') +
        (l.ro ? '   [音] ' + l.ro : '') +
        (l.bg && l.bg.length ? '   [对唱] ' + l.bg.map((b) => b.text || '').join(' ') : '') +
        (l.instrumental ? '   [间奏]' : ''));
    }
  }
  if (model.lines.length > show) console.log('    …其余 ' + (model.lines.length - show) + '行');
}

/* ---------- 主流程 ---------- */

async function runOne(o) {
  console.log('');
  console.log('── ' + (o.name || [o.title, o.artist].filter(Boolean).join(' - ')) +
    (o.tag ? '  [' + o.tag + ']' : ''));
  console.log('   入参: ' + JSON.stringify({
    title: o.title || '', artist: o.artist || '',
    durationSec: o.durationSec || 0,
    neteaseSongId: o.neteaseSongId || undefined,
    qqMid: o.qqMid || undefined
  }));
  const log = (m) => console.log('   ' + m);
  const t0 = Date.now();
  let model = null;
  try {
    model = await fetchLyricsRich({
      title: o.title || '',
      artist: o.artist || '',
      album: o.album || '',
      durationSec: o.durationSec || 0,
      neteaseSongId: o.neteaseSongId || null,
      qqMid: o.qqMid || null,
      log
    });
  } catch (e) {
    console.log('  ✗ 链路整体异常: ' + (e && e.message ? e.message : e));
    return null;
  }
  printModel(model, Date.now() - t0);
  return model;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('逐字歌词降级链自检（tools/lyrics-smoke.js）');
  console.log('链路: AMLL TTML → 网易云 yrc → QQ QRC → 酷狗 KRC → 网易云 lrc → LRCLIB');

  if (args.preset) {
    let set = PRESETS;
    if (typeof args.tag === 'string' && args.tag.trim()) {
      const want = args.tag.split(',').map((s) => s.trim()).filter(Boolean);
      set = PRESETS.filter((p) => want.indexOf(p.tag) >= 0);
      if (!set.length) {
        console.error('没有匹配 tag 的试样，可用 tag: ' + PRESETS.map((p) => p.tag).join(', '));
        process.exit(2);
      }
    }
    const results = [];
    for (const p of set) {
      results.push({ preset: p, model: await runOne(p) });
    }
    // 汇总表
    console.log('');
    console.log('── 汇总');
    for (const r of results) {
      const m = r.model;
      const p = r.preset;
      console.log('  [' + p.tag + '] ' + (p.title || '') + ' - ' + (p.artist || '') + ': ' +
        (!m ? '无结果' :
          (m.isWordByWord ? '逐字' : '行级') + ' ' + m.lines.length + '行 质量' +
          Math.round(m.quality || 0) + ' (' + (m.source || '?') + ')'));
    }
    const wordByWord = results.filter((r) => r.model && r.model.isWordByWord).length;
    console.log('');
    console.log('逐字命中 ' + wordByWord + '/' + results.length +
      '。逐字源对华语/日语流行覆盖好；欧美碟降级为行级 LRC 属设计内行为。');
    return;
  }

  if (!args.title && !args['netease-id'] && !args['qq-mid']) {
    console.error('用法:');
    console.error('  node tools/lyrics-smoke.js --title "曲名" --artist "歌手" --duration 秒');
    console.error('  node tools/lyrics-smoke.js --netease-id 260140');
    console.error('  node tools/lyrics-smoke.js --qq-mid 003OUlho2HcRHC');
    console.error('  node tools/lyrics-smoke.js --preset [--tag zh,en]');
    process.exit(2);
  }

  await runOne({
    title: typeof args.title === 'string' ? args.title : '',
    artist: typeof args.artist === 'string' ? args.artist : '',
    album: typeof args.album === 'string' ? args.album : '',
    durationSec: Number(args.duration) || 0,
    neteaseSongId: args['netease-id'] ? Number(args['netease-id']) : null,
    qqMid: typeof args['qq-mid'] === 'string' ? args['qq-mid'] : null
  });
}

main().catch((e) => {
  console.error('自检工具自身出错: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
