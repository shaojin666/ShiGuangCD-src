'use strict';
/*
 * tests/lyrics-parse.test.js —— 统一歌词模型解析器单测。
 *
 * 用**真实样本** fixture 验证四种逐字格式 + LRC：
 *   - amll-yoasobi-shukufuku.ttml   AMLL TTML DB 真实返回（YOASOBI《祝福》）
 *   - netease-yrc-aiichen.json      网易云 /api/song/lyric/v1 真实返回（艾辰《错位时空》类）
 *   - qq-musicu-jay.json            QQ musicu 真实返回（周杰伦《七里香》）
 *   - kugou-krc-qilixiang.txt       酷狗 KRC 解密后明文（周杰伦《七里香》）
 *   - kugou-krc-encrypted.b64       酷狗 KRC 加密原文（验证 krcDecrypt 往返）
 * QQ QRC 逐字样本匿名接口不开放（qrc 字段为空），用严格对齐真实格式的合成样本。
 *
 * 运行：node tests/lyrics-parse.test.js
 */

const fs = require('fs');
const path = require('path');
const M = require('../main/metadata/lyrics-model');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}
function section(name) { console.log('\n---- ' + name + ' ----'); }

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

/* ================================================================
 * 1) TTML（AMLL 真实样本）
 * ================================================================ */
section('TTML 解析（AMLL 真实样本：祝福 / YOASOBI）');
{
  const ttml = fixture('amll-yoasobi-shukufuku.ttml');
  const model = M.finalizeModel(M.parseTTML(ttml));
  ok(!!model, '解析成功');
  ok(model.source === 'amll', 'source=amll');
  ok(model.isWordByWord === true, '词级标记');
  ok(model.lines.length > 40, '行数 > 40（实际 ' + model.lines.length + '）');

  const l1 = model.lines[0];
  ok(Math.abs(l1.t - 0.917) < 0.01, '首行起点 00:00.917（实际 ' + l1.t.toFixed(3) + '）');
  ok(l1.text.indexOf('遥') === 0, '首行文本以「遥」开头');
  ok(l1.words.length >= 10, '首行词数 ≥ 10（实际 ' + l1.words.length + '）');
  ok(l1.words[0].x === '遥' && Math.abs(l1.words[0].t - 0.917) < 0.01, '首词「遥」时间对齐');
  // 词时间单调且落在行区间内
  let mono = true;
  for (let i = 1; i < l1.words.length; i++) {
    if (l1.words[i].t < l1.words[i - 1].t - 0.001) mono = false;
  }
  ok(mono, '词时间单调递增');
  ok(l1.tr && l1.tr.indexOf('遥远星球') >= 0, '翻译挂接（' + String(l1.tr).slice(0, 20) + '…）');
  ok(l1.ro && l1.ro.indexOf('ha ru ka') >= 0, '罗马音挂接（' + String(l1.ro).slice(0, 24) + '…）');

  const transLines = model.lines.filter((l) => l.tr).length;
  ok(transLines > 40, '多数行有翻译（' + transLines + '/' + model.lines.length + '）');

  // 背景人声（x-bg）应折进主行的 bg
  const bgLines = model.lines.filter((l) => l.bg && l.bg.length);
  ok(bgLines.length >= 1, '背景人声折叠（' + bgLines.length + ' 行）');
  if (bgLines.length) {
    const bg = bgLines[0].bg[0];
    const anyDare = bgLines.some((l) => l.bg.some((b) => b.text.indexOf('誰') >= 0));
    ok(anyDare, 'bg 文本含「誰」（' + bgLines[1].bg[0].text + '）');
    ok(bg.words.length >= 3, 'bg 有词级时间');
    // x-bg 内嵌的 x-translation 子 span 不应混进 bg 词文本
    const bg2 = bgLines[1].bg[0];
    ok(bg2.tr === '并非他人之物' && bg2.text.indexOf('并非他人之物') < 0, 'bg 译/音轨与词文本分离');
  }

  // 间奏插入：样本中 L5(11.47) → L6(23.971) 有 12s 空隙
  const inst = model.lines.filter((l) => l.instrumental);
  ok(inst.length >= 1, '间奏行插入（' + inst.length + ' 处）');
  if (inst.length) {
    ok(inst[0].text === '♪', '间奏占位文本');
    ok(inst[0].e - inst[0].t > 1, '间奏区间有时长');
  }
  ok(model.quality >= 120, '质量分 ≥ 120（实际 ' + model.quality + '）');
}

/* ================================================================
 * 2) 网易云 yrc（真实样本，混合格式）
 * ================================================================ */
section('网易云 yrc 解析（真实样本）');
{
  const fx = JSON.parse(fixture('netease-yrc-aiichen.json'));
  const model = M.finalizeModel(M.parseNeteaseYrc(fx.yrc, {
    translation: fx.tlyric, romanization: fx.romalrc
  }));
  ok(!!model, '解析成功');
  ok(model.source === 'netease', 'source=netease');
  ok(model.isWordByWord === true, '词级标记');

  // 第一条真实歌词行：[15250,3470](15250,340,0)填…
  const lyric = model.lines.find((l) => l.text.indexOf('填') === 0 && l.words.length > 5);
  ok(!!lyric, '找到首个多词行');
  if (lyric) {
    ok(Math.abs(lyric.t - 15.25) < 0.01, '行起点 15.25s（实际 ' + lyric.t.toFixed(2) + '）');
    ok(Math.abs(lyric.e - 18.72) < 0.01, '行终点 18.72s（实际 ' + lyric.e.toFixed(2) + '）');
    ok(lyric.words[0].x === '填' && Math.abs(lyric.words[0].t - 15.25) < 0.01, '首词「填」绝对毫秒换算');
    ok(lyric.words.length >= 10, '词数 ≥ 10（实际 ' + lyric.words.length + '）');
    // yrc 词时间是绝对毫秒：第 2 词应 > 行起点，而不是 0
    ok(lyric.words[1].t > 15, '词时间为绝对毫秒（非行内偏移）');
  }
  // JSON 元数据行（{"t":-1000,"c":[…]}）必须被跳过
  ok(!model.lines.some((l) => l.text.indexOf('作词') >= 0), 'JSON 制作信息行被跳过');
  // 负时间行（版权声明 [0,7030] 之前的行）也应不在模型里
  ok(model.lines.every((l) => l.t >= 0), '无负时间行');

  // 译文/罗马音挂接：用《紅蓮華》（五轨齐全：yrc+ytlrc+yromalrc+tlyric+romalrc）
  const gurenge = JSON.parse(fixture('netease-yrc-gurenge.json'));
  const gm = M.finalizeModel(M.parseNeteaseYrc(gurenge.yrc, {
    translation: gurenge.ytlrc, romanization: gurenge.yromalrc
  }));
  const gWithTr = gm.lines.filter((l) => l.tr).length;
  ok(gWithTr > 25, 'yrc 专用译文轨挂接（' + gWithTr + '/' + gm.lines.length + ' 行）');
  ok(!!gm.lines[0].tr && gm.lines[0].tr.indexOf('坚强') >= 0, '首行译文（' + gm.lines[0].tr + '）');
  const gWithRo = gm.lines.filter((l) => l.ro).length;
  ok(gWithRo > 25, 'yrc 专用罗马音轨挂接（' + gWithRo + ' 行）');
  ok(!!gm.lines[0].ro && gm.lines[0].ro.indexOf('tsu yo ku') >= 0, '首行罗马音（' + String(gm.lines[0].ro).slice(0, 24) + '…）');
  // 首行起点 0.93s 与译文轨 [00:00.930] 严格对应
  ok(Math.abs(gm.lines[0].t - 0.93) < 0.01, 'gurenge 首行起点 0.93s（实际 ' + gm.lines[0].t.toFixed(2) + '）');

  // 纯 LRC 回退解析（旧接口形态）
  const lrcModel = M.finalizeModel(M.parseLrcText('[00:01.00]测试行一\n[00:03.00]测试行二', { source: 'netease' }));
  ok(lrcModel && lrcModel.lines.length === 2 && lrcModel.isWordByWord === false, 'LRC 行级回退');
}

/* ================================================================
 * 3) 酷狗 KRC（真实样本 + 解密往返）
 * ================================================================ */
section('酷狗 KRC 解析（真实样本）');
{
  const enc = fixture('kugou-krc-encrypted.b64').trim();
  const dec = M.krcDecrypt(enc);
  const plain = fixture('kugou-krc-qilixiang.txt');
  ok(dec.trim() === plain.trim(), 'krcDecrypt 与 fixture 明文一致');

  const model = M.finalizeModel(M.parseKrc(plain));
  ok(!!model, '解析成功');
  ok(model.source === 'kugou', 'source=kugou');
  ok(model.isWordByWord === true, '词级标记');

  // 真实行：[28137,6304]<0,448,0>窗<448,825,0>外…
  const win = model.lines.find((l) => l.text.indexOf('窗外') === 0);
  ok(!!win, '找到「窗外」行');
  if (win) {
    ok(Math.abs(win.t - 28.137) < 0.01, '行起点 28.137s（实际 ' + win.t.toFixed(3) + '）');
    // ★ 词偏移是行内相对：第一词 <0,448> 起点 = 行起点 + 0
    ok(Math.abs(win.words[0].t - 28.137) < 0.01, '首词时间 = 行起点 + 0 偏移（实际 ' + win.words[0].t.toFixed(3) + '）');
    // 第二词 <448,825>：起点 = 28.137 + 0.448 = 28.585
    ok(Math.abs(win.words[1].t - 28.585) < 0.01, '次词时间 = 行起点 + 448ms 偏移（实际 ' + win.words[1].t.toFixed(3) + '）');
    ok(win.words[1].x === '外', '次词文本「外」');
  }
  // 元数据行 [id:$00000000] 不应成为歌词行
  ok(!model.lines.some((l) => l.text.indexOf('$00000000') >= 0), 'KRC 元数据行被跳过');
}

/* ================================================================
 * 4) QQ QRC（合成样本：严格对齐真实格式）
 * ================================================================ */
section('QQ QRC 解析（合成样本，格式对齐真实）');
{
  // 真实 QRC 形态：[行起,行长](词起,词长)文本(词起,词长)文本…
  const qrc = [
    '[0,4000](0,800)GNZ48(800,400)女(1200,400)王(1600,400)派(2000,400)对(2400,400)来(2800,400)了',
    '[4200,3000](4200,500)站(4700,500)在(5200,500)舞(5700,500)台(6200,500)中(6700,500)央'
  ].join('\n');
  const model = M.finalizeModel(M.parseQrc(qrc, {
    translation: '[00:00.00]GNZ48 女王派来袭\n[00:04.20]站在舞台中央'
  }));
  ok(!!model, '解析成功');
  ok(model.lines.length === 2, '两行');
  ok(model.lines[0].text === 'GNZ48女王派对来了', '行文本拼接（实际 ' + model.lines[0].text + '）');
  ok(model.lines[0].words.length === 7, '词数 7（实际 ' + model.lines[0].words.length + '）');
  ok(model.lines[0].words[0].x === 'GNZ48' && Math.abs(model.lines[0].words[0].t - 0) < 0.01, '首词时间');
  ok(Math.abs(model.lines[0].words[1].t - 0.8) < 0.01, '词时间为绝对毫秒');
  ok(model.lines[0].words[1].x === '女', '次词文本');
  ok(!!model.lines[0].tr && model.lines[0].tr.indexOf('GNZ48') >= 0, '翻译挂接');
  ok(Math.abs(model.lines[1].t - 4.2) < 0.01, '第二行起点');

  // 3DES 加密 hex 路径（用 Node crypto 造一个密文，与 qq-music.qrcDecrypt 互通）
  const crypto = require('crypto');
  const zlib = require('zlib');
  const key = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'utf8');
  const deflated = zlib.deflateSync(Buffer.from('[0,2000](0,1000)加(1000,1000)密', 'utf8'));
  // des-ede3 块大小 8：明文需零填充到 8 的倍数（与真实密文形态一致）
  const padLen = (8 - (deflated.length % 8)) % 8;
  const padded = Buffer.concat([deflated, Buffer.alloc(padLen)]);
  const c = crypto.createCipheriv('des-ede3', key, Buffer.alloc(0));
  c.setAutoPadding(false);
  const cipherHex = Buffer.concat([c.update(padded), c.final()]).toString('hex');
  const { qrcDecrypt } = require('../main/metadata/qq-music');
  const back = qrcDecrypt(cipherHex);
  ok(back === '[0,2000](0,1000)加(1000,1000)密', '3DES hex 解密往返（' + String(back).slice(0, 20) + '）');
  const encModel = M.finalizeModel(M.parseQrc(back));
  ok(encModel && encModel.lines[0].text === '加密', '解密后模型文本');
}

/* ================================================================
 * 5) 后处理与降级
 * ================================================================ */
section('后处理：对唱折叠 / 间奏 / 质量分 / toLrc');
{
  // 对唱：两个 agent 时间重叠
  const ttml = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">' +
    '<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head>' +
    '<body dur="0:20">' +
    '<p begin="00:01.000" end="00:04.000" ttm:agent="v1"><span begin="00:01.000" end="00:02.000">你好</span><span begin="00:02.000" end="00:04.000">世界</span></p>' +
    '<p begin="00:02.000" end="00:04.000" ttm:agent="v2"><span begin="00:02.000" end="00:03.000">我也</span><span begin="00:03.000" end="00:04.000">很好</span></p>' +
    '<p begin="00:20.000" end="00:23.000" ttm:agent="v1"><span begin="00:20.000" end="00:21.000">尾声</span></p>' +
    '</body></tt>';
  const model = M.finalizeModel(M.parseTTML(ttml));
  const mainLines = model.lines.filter((l) => !l.instrumental);
  ok(mainLines.length === 2, '对唱行折叠进主行（' + mainLines.length + ' 主行 + 间奏占位）');
  const host = mainLines[0];
  ok(host.bg && host.bg.length === 1, '主行带 1 条背景人声');
  if (host.bg) {
    ok(host.bg[0].text === '我也很好', 'bg 文本（实际 ' + host.bg[0].text + '）');
    ok(host.bg[0].words.length === 2, 'bg 有词级');
  }
  // 尾奏前空隙 4→20 = 16s → 间奏
  const inst = model.lines.filter((l) => l.instrumental);
  ok(inst.length === 1, '间奏插入 1 处');
  ok(model.quality > 100, '对唱加分生效（' + model.quality + '）');

  // toLrc 降级
  const lrc = M.toLrc(model);
  ok(/^\[00:01\.00\]你好世界$/m.test(lrc), 'toLrc 主行');
  ok(/^\[00:02\.00\]我也很好$/m.test(lrc), 'toLrc 含 bg 行');
  ok(!/♪/.test(lrc), 'toLrc 不含间奏行');
}

/* ================================================================
 * 5.5) v10.7：amll 对唱排版（bg 平铺 / analyzeDuet 主 agent 判定）
 * ================================================================ */
section('v10.7：对唱 bg 平铺 + analyzeDuet（主右对左排版依据）');
{
  // 重叠对唱，且对唱行自带背景人声（x-bg）
  const ttml = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml/ttml#metadata">' +
    '<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head>' +
    '<body dur="0:30">' +
    '<p begin="00:05.000" end="00:10.000" ttm:agent="v1"><span begin="00:05.000" end="00:10.000">主唱句</span></p>' +
    '<p begin="00:06.000" end="00:10.000" ttm:agent="v2"><span begin="00:06.000" end="00:10.000">对唱句</span>' +
    '<span ttm:role="x-bg" begin="00:08.000" end="00:09.000"><span begin="00:08.000" end="00:09.000">背景声部</span></span></p>' +
    '<p begin="00:20.000" end="00:25.000" ttm:agent="v1"><span begin="00:20.000" end="00:25.000">尾声</span></p>' +
    '</body></tt>';
  const model = M.finalizeModel(M.parseTTML(ttml));
  const host = model.lines.find((l) => l.text === '主唱句');
  ok(!!host, '宿主行存在');
  ok(host && host.agent === 'v1', '宿主保留自身 agent=v1（主唱）');
  ok(host && host.bg.length === 2, '对唱行 + 其 x-bg 平铺成 2 条 bg（实际 ' + (host && host.bg.length) + '）');
  if (host && host.bg.length === 2) {
    ok(host.bg[0].agent === 'v2' && host.bg[0].text === '对唱句', 'bg0 = 对唱主线（agent=v2）');
    ok(host.bg[1].agent === 'v2' && host.bg[1].text === '背景声部', 'bg1 = 对唱自带的 x-bg（跟随对唱侧，agent=v2）');
    ok(host.bg[1].words.length === 1, 'bg1 保留词级时间');
  }
  const d1 = M.analyzeDuet(model);
  ok(d1.hasDuet === true, '重叠对唱 → hasDuet');
  ok(d1.mainAgent === 'v1', 'mainAgent=主线频次最高者 v1（实际 ' + d1.mainAgent + '）');

  // 交替对唱（不重叠）：3 条 agent 行 v1/v2/v1 → 主 v1
  const alt = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml/ttml#metadata">' +
    '<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head>' +
    '<body dur="0:30">' +
    '<p begin="00:01.000" end="00:05.000" ttm:agent="v1"><span begin="00:01.000" end="00:05.000">一句</span></p>' +
    '<p begin="00:06.000" end="00:10.000" ttm:agent="v2"><span begin="00:06.000" end="00:10.000">二句</span></p>' +
    '<p begin="00:11.000" end="00:15.000" ttm:agent="v1"><span begin="00:11.000" end="00:15.000">三句</span></p>' +
    '</body></tt>';
  const altModel = M.finalizeModel(M.parseTTML(alt));
  const d2 = M.analyzeDuet(altModel);
  ok(d2.hasDuet === true && d2.mainAgent === 'v1', '交替对唱 → hasDuet，mainAgent=v1（2>1）');
  ok(altModel.lines.filter((l) => l.agent).length === 3, '交替对唱不折叠（3 条 agent 行）');

  // 无对唱：纯 x-bg（无 agent）
  const bgOnly = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml/ttml#metadata">' +
    '<body dur="0:20">' +
    '<p begin="00:01.000" end="00:05.000"><span begin="00:01.000" end="00:05.000">主唱</span>' +
    '<span ttm:role="x-bg" begin="00:02.000" end="00:04.000"><span begin="00:02.000" end="00:04.000">和声</span></span></p>' +
    '</body></tt>';
  const bgModel = M.finalizeModel(M.parseTTML(bgOnly));
  const d3 = M.analyzeDuet(bgModel);
  ok(d3.hasDuet === false, '纯背景人声（无 agent）不算对唱 → 整体居中');
  ok(bgModel.lines[0].bg[0].agent === undefined, 'x-bg 条目无 agent（渲染端 bg-main 靠右跟随宿主）');
}

/* ================================================================
 * 6) 边界与脏数据
 * ================================================================ */
section('边界与脏数据');
{
  ok(M.parseTTML('') === null, '空 TTML → null');
  ok(M.parseTTML('<html>no</html>') === null, '非 TTML → null');
  ok(M.parseNeteaseYrc('[abc]') === null, '畸形 yrc → null');
  ok(M.parseQrc('[1,2]没有标签') === null, '无词标签 QRC → null');
  ok(M.parseLrcText('没有时间轴的纯文本') === null, '无时间轴 LRC → null');
  // 多时间标签行 → 复制成多行
  const multi = M.finalizeModel(M.parseLrcText('[00:01.00][00:10.00]重复行\n[00:05.00]正常行'));
  ok(multi.lines.length === 3, '多时间标签展开（' + multi.lines.length + '）');
  // offset 校正
  const off = M.finalizeModel(M.parseLrcText('[offset:500]\n[00:10.00]整体后移半秒'));
  ok(Math.abs(off.lines[0].t - 9.5) < 0.01, 'offset 校正（实际 ' + off.lines[0].t.toFixed(2) + '）');
  // 脏词时间（词在行外）不崩溃
  const weird = M.finalizeModel(M.parseKrc('[0,1000]<99999,100>越界词'));
  ok(weird !== null && weird.lines.length === 1, '越界词时间不崩溃');
}

console.log('\n' + (fail ? fail + ' 个断言未通过' : 'ALL PASS（' + pass + ' 断言）'));
process.exit(fail ? 1 : 0);
