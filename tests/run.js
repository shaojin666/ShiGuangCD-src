'use strict';
/*
 * tests/run.js —— 播放控件自检入口（纯逻辑，不需要光驱、不需要 Windows）。
 *
 *   node tests/run.js          跑全部
 *   node tests/run.js transport 只跑指定用例
 *
 * 说明：renderer.test.js 需要 jsdom（npm i jsdom），未安装时会自动跳过。
 */

const { execFileSync } = require('child_process');
const path = require('path');

const all = ['transport', 'service', 'mci', 'raw-player', 'engine', 'eject', 'metadata', 'native', 'engine-select', 'raw-pipeline', 'audio-stats', 'winstate', 'lyrics-parse', 'lyrics-fallback', 'lyrics-select', 'floating', 'floating-view', 'ui-contract', 'library-empty', 'v10.4', 'v10.5', 'v10.6', 'v10.7', 'fl-fonts', 'fl-stage', 'i18n', 'tween', 'renderer'];
const want = process.argv.slice(2);
const list = want.length ? want : all;

let failed = 0;
let skipped = 0;
for (const name of list) {
  const file = path.join(__dirname, name + '.test.js');
  console.log('\n========== ' + name + ' ==========');
  try {
    const out = execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: 'pipe' });
    process.stdout.write(out);
    if (/\[skip\]/.test(out)) { skipped++; continue; }   // 缺可选依赖，不算失败
    if (!/ALL PASS/.test(out)) failed++;
  } catch (e) {
    failed++;
    process.stdout.write((e.stdout || '') + (e.stderr || ''));
  }
}

const tail = skipped ? `全部用例通过（${skipped} 个套件因缺少可选依赖被跳过）` : '全部用例通过';
console.log('\n' + (failed ? failed + ' 个用例未通过' : tail));
process.exit(failed ? 1 : 0);
