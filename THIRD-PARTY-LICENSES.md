# 第三方组件与许可

拾光 CD（ShiGuangCD）以 **GNU General Public License v3.0 or later** 发布，全文见 [LICENSE](LICENSE)。
下表列出随安装包一同分发的第三方组件，以及它们与本项目协议的关系。

## 随包分发

| 组件 | 版本 | 许可 | 与本项目（GPLv3）的关系 |
|---|---|---|---|
| [Electron](https://www.electronjs.org/) | 22.3.27 | MIT | 兼容。MIT 允许被 GPL 作品包含，分发时保留其版权声明即可 |
| [Chromium](https://www.chromium.org/) | 随 Electron | BSD-3-Clause 等 | 兼容（BSD 系为 GPL 兼容许可） |
| [koffi](https://koffi.dev/) | 3.0.2 | MIT | 兼容。用于 `main/native.js` 调用 Windows 原生 API |
| [Three.js](https://threejs.org/) | r149 | MIT | 兼容。仅「镜台」3D 主题按需懒加载 |

## 动画：不再依赖第三方库

v10.12 起移除了 GSAP 3.13.0。原因有两条：

1. **许可**：GSAP 用的是 GreenSock 自有的 Standard "No Charge" 许可，属专有许可，
   与 GPLv3 不兼容（GPL 要求整个作品都能按 GPLv3 再分发，而 GSAP 不允许被重新授权）；
2. **用不上**：全项目只调用 9 次 `fromTo` + 11 次 `killTweensOf`，全部是
   "事件触发 → 衰减到 0" 的数值插值，timeline / 插件 / scroll / FLIP 一个都没用。

现由 `renderer/js/tween.js`（约 210 行，本项目自有代码，随本协议以 GPLv3 发布）承担，
缓动曲线与 GSAP 的 `power2.out` / `power3.out` / `sine.out` 逐点一致（见 `tests/tween.test.js`）。
因此本项目的随包组件中**已无 GPL 不兼容项**。

## 仅开发期使用（不随包分发）

| 组件 | 许可 | 用途 |
|---|---|---|
| [jsdom](https://github.com/jsdom/jsdom) | MIT | `npm test` 的 DOM 环境 |
| [electron-builder](https://www.electron.build/) | MIT | 打包 |

## 数据来源

- 元数据：[MusicBrainz](https://musicbrainz.org/)（CC0 / CC BY-NC-SA，按库方条款使用）
- 词级歌词：[amll-ttml-db](https://github.com/Steve-xmh/amll-ttml-db) 及各公共歌词库

歌词与封面版权归原始权利人所有，本项目仅做本地匹配与展示，不重新分发这些内容。
