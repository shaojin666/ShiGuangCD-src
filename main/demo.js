'use strict';
/*
 * demo.js —— 演示光盘（无光驱时体验界面与一镜到底动画）。
 * 通过 --demo 启动，或在"未检测到光驱"时由用户手动进入。
 * 音频由渲染进程合成（DemoAudio），不涉及真实硬件。
 */

const DEMO_TOC = {
  first: 1,
  last: 3,
  leadout: 74000,
  tracks: [
    { number: 1, startFrame: 150, endFrame: 22000, durationSec: 291.3, audio: true },
    { number: 2, startFrame: 22000, endFrame: 48000, durationSec: 346.7, audio: true },
    { number: 3, startFrame: 48000, endFrame: 74000, durationSec: 346.7, audio: true }
  ]
};

const L1 = [
  '[00:00.00]（序曲 · 唱机）',
  '[00:12.00]唱针落下，第一道光的纹理',
  '[00:24.00]沿着轨道的方向缓缓展开',
  '[00:40.00]房间安静下来',
  '[01:02.00]只剩转速与心跳同频',
  '[01:30.00]（间奏）',
  '[02:10.00]序曲 · 唱机',
  '[02:40.00]（尾声）'
].join('\n');

const L2 = [
  '[00:00.00]（午后的唱片店）',
  '[00:14.00]推开门，风铃晃了一下',
  '[00:32.00]货架深处有一张陌生的封面',
  '[00:55.00]老板说，这张碟等了很久',
  '[01:18.00]阳光从窗缝斜进来',
  '[01:42.00]落在转动的光盘上',
  '[02:08.00]我们都没有说话',
  '[02:36.00]（间奏）',
  '[03:10.00]午后 · 唱片店',
  '[03:40.00]（尾声）'
].join('\n');

const L3 = [
  '[00:00.00]（归途）',
  '[00:15.00]路灯一盏一盏亮起来',
  '[00:38.00]地铁穿过城市的下半层',
  '[01:04.00]耳机里的歌正好放到第三节',
  '[01:30.00]想起今天下午的旋律',
  '[02:00.00]归途总是比去时快一些',
  '[02:30.00]（间奏）',
  '[03:10.00]归途',
  '[03:38.00]（尾声）'
].join('\n');

const DEMO_META = {
  signature: '__demo__',
  source: 'demo',
  album: '拾光 · 演示碟',
  artist: 'ShiGuang Studio',
  year: 2026,
  genres: ['Ambient'],
  trackCount: 3,
  hasCover: false,
  tracks: [
    { number: 1, title: '序曲 · 唱机', artist: 'ShiGuang Studio', durationSec: 291.3, lyrics: L1, lyricsSynced: true, lyricsSource: 'demo' },
    { number: 2, title: '午后的唱片店', artist: 'ShiGuang Studio', durationSec: 346.7, lyrics: L2, lyricsSynced: true, lyricsSource: 'demo' },
    { number: 3, title: '归途', artist: 'ShiGuang Studio', durationSec: 346.7, lyrics: L3, lyricsSynced: true, lyricsSource: 'demo' }
  ]
};

module.exports = { DEMO_TOC, DEMO_META };
