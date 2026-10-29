'use strict';
/*
 * preload.js —— 通过 contextBridge 暴露最小化 API。
 *
 * Copyright (C) 2026 ShiGuang Studio
 * SPDX-License-Identifier: GPL-3.0-or-later
 * 本程序是自由软件：你可以依据 GNU 通用公共许可证（GPLv3 或更高版本）
 * 再分发和/或修改它。协议全文见项目根目录的 LICENSE。
 */

const { contextBridge, ipcRenderer } = require('electron');

const ON_CHANNELS = [
  'cd:phase', 'cd:state', 'cd:engine', 'cd:metadata', 'cd:metadata-progress',
  'cd:audio', 'cd:position', 'cd:notice', 'cd:land', 'cd:demo-play', 'cd:demo-seek',
  /* 轨道播完通知。此前该通道未被列入白名单，渲染端订阅被静默丢弃，
     导致 MCI 路径永远收不到"本轨结束"，自动切歌/停止失效。 */
  'cd:track-end', 'cd:demo-stop', 'cd:demo-pause', 'cd:demo-resume',
  /* 窗口状态（最大化 / 全屏），供渲染端切换自绘按钮图标 */
  'app:win-state',
  /* 桌面悬浮歌词：主进程推给悬浮窗 */
  'float:init', 'float:lyrics', 'float:lock', 'float:opts',
  /* 语言切换：设置页改语言后主进程把新语言推给悬浮窗（独立窗口） */
  'float:lang',
  /* 桌面悬浮歌词：主进程推给主窗口（传输条按钮跟着变） */
  'floating:state'
];

const INVOKE_CHANNELS = [
  'cd:get-state', 'cd:get-metadata', 'cd:get-toc',
  'cd:play-track', 'cd:pause', 'cd:resume', 'cd:stop', 'cd:seek', 'cd:set-mode',
  'cd:eject', 'cd:close-door', 'cd:use-demo', 'cd:refetch-metadata',
  /* 运行时切换播放引擎（设置页 MCI / RAW 切换，v9） */
  'cd:switch-engine',
  'meta:list', 'meta:get', 'meta:save', 'meta:remove', 'meta:save-cover',
  'settings:get', 'settings:set', 'app:open-logs', 'app:log', 'app:open-external',
  /* 歌词源管理（编辑面板）：主进程 ipc.js 有注册，但这里漏过——
     渲染端 invoke 直接被白名单拒掉，报"未知通道 lyrics:select-source"，
     用户侧表现为切换歌词源恒失败的"未知错误"。 */
  'lyrics:select-source', 'lyrics:add-ttml', 'lyrics:remove-source',
  /* 无边框窗口的自绘控件 */
  'app:win-minimize', 'app:win-toggle-maximize', 'app:win-close', 'app:win-fullscreen',
  'app:win-state', 'app:set-theme', 'app:set-float-anim',
  /* 悬浮歌词译/音显隐开关（v10.6） */
  'app:set-float-show',
  /* 开机自启开关（设置页，v10.5） */
  'app:set-auto-launch',
  /* 桌面悬浮歌词：主窗口侧开关 / 推歌词 */
  'floating:toggle', 'floating:open', 'floating:close', 'floating:lyrics',
  /* 桌面悬浮歌词：悬浮窗自身 */
  'float:ready', 'float:close', 'float:lock', 'float:position',
  'float:resize', 'float:resize-end', 'float:resize-start',
  'float:save', 'float:arm', 'float:rearm',
  /* 主进程：渲染端首帧排好后，窗口才显示（避免先闪一个空容器） */
  'float:reveal',
  /* 全屏歌词字体仓库（v10.8 M4）：上传 / 列表 / 删除 / 读取 */
  'fl:save-font', 'fl:list-fonts', 'fl:delete-font', 'fl:read-font'
];

contextBridge.exposeInMainWorld('cd', {
  on(channel, cb) {
    if (!ON_CHANNELS.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.includes(channel)) return Promise.reject(new Error('未知通道 ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  }
});
