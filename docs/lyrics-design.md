# 逐字歌词功能设计（v4 · 第二棒）

> 目标：为 ShiGuangCD 接入多源逐字歌词，统一歌词模型，设计质量降级链，
> 并在原版界面（nowplaying + 桌面悬浮窗）上完善显示：词级高亮、翻译、对唱、间奏。
> 3D 歌词仍为后续独立页面主题，本棒不做。

> **实现状态（已完成）**：下面第五节的计划基本落地，两处与计划不同，以代码为准：
> ① 悬浮窗**没有**共用 `lyrics-view.js`——它是独立页面/渲染进程，逐字靠主进程换行时
> 推送一次词级时间轴（`words/t/e/tr/at`），渲染端换算成 CSS `animation-delay/duration`
> 跑补间（`renderer/js/floating.js` 的 `buildCurrentLine`）。刻意不开高频 IPC：
> 透明置顶窗口每帧跨进程推送会把 CPU 拖死，而 CSS 动画由合成器执行、不需要精确时钟。
> ② 降级链是"全部源并发跑完按质量分挑最优"，不是计划字的"依次尝试"——
> 先成功的往往是低级源，会挡住后面的高分源。
> 测试除计划的两个套件外，另增 `tests/floating.test.js`（主进程白名单）与
> `tests/floating-view.test.js`（渲染端 DOM 桩 + vm 加载真实文件）。

---

## 一、调研结论（已实测验证的源与接口）

| 源 | 获取方式 | 逐字格式 | 翻译/罗马音 | 质量 |
|---|---|---|---|---|
| **AMLL TTML DB** | `GET https://api.amll.dev/v1/lyrics/get?ncmMusicId=xxx` 或 `?qqMusicId=xxx` → `{status:200,data:{lyrics:"<tt…>",format:"ttml"}}`；搜索 `GET /v1/lyrics/search?musicName=&artistName=` | TTML XML：`<p begin end ttm:agent itunes:key>` + 词级 `<span begin end>` | `<span ttm:role="x-translation">` / `x-roman` | ★★★★★ 人工校对、含对唱 agent 与背景人声 |
| **网易云 yrc** | `GET https://music.163.com/api/song/lyric/v1?id=xxx&yv=1&ytv=1&yrv=1…` → `yrc.lyric`（混合格式：JSON 元数据行 + 经典 yrc 文本行）、`tlyric`、`romalrc` | `[lineStartMs,lineDurMs](wordStartMs,wordDurMs,0)text`（**绝对毫秒**） | `ytlrc` 优先于 `tlyric`；`yromalrc` 优先于 `romalrc` | ★★★★ |
| **QQ QRC** | `POST https://u.y.qq.com/cgi-bin/musicu.fcg` `{"lyric":{"module":"music.musichallSong.PlayLyricInfo","method":"GetPlayLyricInfo","param":{"songMID","songID"}}}` → `lyric.data.{lyric,trans,qrc,roma}`（均 base64；qrc 可能为 3DES 加密 hex） | `[lineStartMs,lineDurMs](wordStartMs,wordDurMs)text`（**绝对毫秒**，文本在标签后） | `trans` / `roma` | ★★★★ |
| **酷狗 KRC** | **两段式**（2026-11 keyword 入口全灭后的配方，参考 minerradio）：① 歌曲搜索 `GET https://songsearch.kugou.com/song_search_v2`（WebFilter 客户端免登录）→ `FileHash` + `MixSongID/EMixSongID`；② hash 直查 `GET https://krcs.kugou.com/search?hash=…&album_audio_id=…&duration=<秒>`（与 lyrics.kugou.com 同 API 不同 host，互为灾备）→ candidates（官方推荐打头，10~20 个版本）；③ 下载 `GET /download?…&fmt=krc&charset=utf8` → base64；解密：去 `krc1` 头 → XOR 16 字节 key → zlib inflate | `[lineStartMs,lineDurMs]<offsetMs,durMs>text`（词时间为**行内相对偏移**） | 内嵌 `[language:base64]`（type 0=罗马音，1=翻译） | ★★★★ |
| **LRCLIB**（保留） | 现有逻辑 | 无（行级 LRC） | 无 | ★★ 海外兜底 |

关键坑（已踩）：
- **酷狗歌词 keyword 入口 2026-11 起全灭**：`lyrics.kugou.com/search?keyword=…` 对任何关键词恒返回 404（连纯歌名也 404），`client=pc` 时代的老配方双双失效。hash 直查（`krcs.kugou.com/search?hash=…`）不受影响 —— 现行两段式即"先 songsearch 拿 FileHash，再 hash 直查候选"。`SongName/SingerName` 带 `<em>` 高亮标签，匹配前必须剥除。`album_audio_id` 优先取纯数字 `MixSongID`（酷狗据此给官方推荐排序分），退化 `EMixSongID`。KRC 解密不变：`krc1` 头 + XOR `[64,71,97,119,94,50,116,71,81,54,49,45,206,210,110,105]` + `zlib.inflateRawSync`。
- 候选**逐个顺延**是必须的：`candidates[0]` 是"官方推荐"但个别版本只有 LRC 无 KRC 或下载失败 —— 封顶 3 个 KRC + 2 个 LRC 控制耗时；酷狗逐字覆盖率很高，多试两个候选命中率差别巨大。
- 网易云 **旧** `/api/song/lyric` 不返回 yrc；逐字必须走 `/api/song/lyric/v1`（yv=1）。且 v1 的 `lrc.lyric` 是 **JSON 结构**（`{"t":ms,"c":[{"tx":…}]}`），不是经典 LRC 文本。
- AMLL API 限流约 50 次/秒/IP，429 不重试；未收录返回 `{status:404}`。
- QQ musicu 的 `qrc` 字段对匿名请求多为空（仅部分歌曲有），拿到时可能是 base64 明文 XML 或 3DES 加密 hex，两种都要支持。
- **编辑面板"切换歌词源"报"未知错误"**（v7 修）：根因是 IPC 边界两层吞异常 —— 渲染端 `.catch(() => null)` 把 invoke 的 reject 原因扔掉，主进程 `withLyrics` 管道未包 try/catch，store 读/写或序列化一炸就变成无原因的 reject。修法：渲染端三处 catch 透出 `'IPC: ' + 消息`；主进程 `withLyrics` 全段兜底，store.get/store.save/fn(meta) 分别归因（`store-read-failed:` / `save-failed:` / `internal:` / `unexpected:`），绝不 reject。**教训：IPC 边界的 catch 必须是排障信使，不是垃圾桶**——吞掉的异常会以"未知错误"的形式在用户侧爆炸，而开发者侧零线索。

## 二、统一歌词模型（`lyrics-model.js`）

主进程解析各源后归一化为同一结构，随元数据缓存落盘，渲染端只认这一种：

```js
{
  v: 1,                       // 模型版本
  source: 'amll'|'netease'|'qq'|'kugou'|'lrclib'|'manual',
  isWordByWord: false,        // 是否有词级时间
  agents: { v1: {id:'v1', name:'', type:'person'}, … },  // 对唱角色（TTML）
  lines: [
    {
      t: 12.34, e: 15.67,     // 起止（秒，可被渲染端覆盖）
      text: '主唱文本',
      tr: '中文翻译',           // 可选
      ro: 'romaji',            // 可选罗马音
      agent: 'v1',            // 可选：对唱角色 id
      part: 'chorus'|null,    // 可选：段落标记
      words: [{t:12.34,e:12.9,x:'文字'}],          // 词级（逐字）
      bg: [{t:…,e:…,text:…,words:[…],tr:…}]        // 可选：背景人声/和声
    }
  ],
  quality: 120                // 质量分（见降级链）
}
```

设计要点：
- **间奏（instrumental）**：各源均无显式间奏标记。解析时对相邻行空隙 > `INSTRUMENTAL_GAP_SEC`（默认 8s）**插入间奏行**（`{t, e, text:'♪', instrumental:true}`），渲染端统一按"无人声行"处理（不高亮、点击不跳转）。这样"间奏"信息对所有源一致可用。
- **对唱（duet）**：TTML 的 `ttm:agent`。folia 的做法：时间重叠的不同 agent 行折叠进主行的 `bg`（背景人声数组）。折叠阈值：`candidate.start < main.end && candidate.end > main.start`。渲染端主行 + bg 行双行显示、分色。
- **对唱角色名**：`agents` 表给出显示名（如 "主唱"/"feat."），没有名字时按 v1/v2 编号。
- **降级为经典 LRC**：`toLrc(model)` 生成 `[mm:ss.xx]文本`（词级信息丢弃），保证任何下游（旧渲染、导出）可用。
- **模型裁剪**：schema.js 白名单重建时透传 `tracks[i].lyricsData`（结构化），超长行数/词数裁剪防脏数据炸缓存。

## 三、质量打分与降级链（`fetchLyricsRich`）

每轨按序尝试，**取质量分最高者**（同分取先到者）：

```
score = (isWordByWord ? 100 : 0)
      + (有翻译 ? 10 : 0) + (有罗马音 ? 5 : 0)
      + (有对唱 agent ? 5 : 0) + (有背景人声 ? 5 : 0)
      + min(行数, 60) * 0.1          # 内容完整性微调
```

源优先级（设计序，实际由分数裁决）：
1. **AMLL TTML**（ncmMusicId / qqMusicId 任一命中）——词级+翻译+罗马音+对唱+背景人声，通常 130+
2. **网易云 yrc**（songId）——词级+翻译+罗马音，通常 115+
3. **QQ QRC**（mid）——词级+翻译，通常 110+
4. **酷狗 KRC**（两段式：songsearch 拿 FileHash → krcs hash 直查，标题+歌手+时长匹配选中歌曲；候选逐个顺延）——词级+内嵌翻译，通常 105+
5. **网易云 lrc/tlyric**（原逻辑）——行级+翻译，15+
6. **LRCLIB**（原逻辑）——行级，10+
7. 无 → 界面提示"暂无歌词"

匹配纪律（防错贴，沿用原项目的严格哲学）：
- 有 `neteaseSongId`（专辑详情精确对应）时，1/2/5 直接用 ID，绝不搜索。
- 无 ID 时：AMLL 用 `musicName+artistName` 搜索，候选按 标题归一化匹配 + 时长差 ≤3s 选取；酷狗同理（songsearch 候选按 name/artist/durationSec 打分，选中后拿 hash 直查，duration 参数参与）。
- QQ 需 mid：无 mid 时跳过（CD 场景极少有 QQ ID），保留接口能力。
- 任一源超时（AMLL 5s / 网易云 8s / QQ 6s / 酷狗 5s×N）即放弃该源，不阻塞其它源与读盘。酷狗新路径是"1 发 songsearch + 1 发 hash 直查 + 封顶 5 发下载"，整体仍在数秒内。

## 四、渲染端显示（基于原版界面）

### nowplaying.js（歌词页 / 并行视图）
- `lrc-line` 结构升级：主行 `.lrc-main`（词级 `<i>` span）+ 可选 `.lrc-tr`（翻译小字）+ 可选 `.lrc-bg`（对唱/背景人声行，次要色）。
- **词级高亮**：`highlight(posSec)` 内对每个 word 计算 `min(1, (pos - w.t)/(w.e - w.t))`，写入 CSS 变量 `--wp`（0~1），主行用两层文本叠加 + `clip-path/width` 实现"已唱亮 / 未唱暗"填充（不动 DOM 结构，只改 style）。
- **间奏行**：`instrumental` 行不高亮、无词级、文案 `♪ 间奏 ♪`，hover 提示时间。
- **对唱**：主行与 bg 行都参与词级高亮；bg 行颜色 `--lrc-bg-fg`。
- 纯文本歌词（无时间轴）保持现有景深展示。
- 点击跳转、浏览态、鼠标放大镜、3D 景深（--d/--ad）**全部保留**，只增强数据源。

### floating.js（桌面悬浮歌词）
- 三行结构不变（prev/cur/next），当前行若有翻译，追加第四个小字行 `.float-tr`（淡入淡出）。
- 词级高亮以简化形式呈现：当前行文本按词进度做 mask 填充（`background-clip:text` 两层）。
- 间奏/对唱：间奏显示 `♪`；对唱时当前行文本 = 主行 + " / " + bg 首行文本（紧凑优先）。

## 五、文件改动清单

主进程：
- `main/metadata/lyrics-model.js` **新增**：统一模型 + 5 种解析器（TTML/yrc/QRC/KRC/LRC）+ `toLrc` + `score`
- `main/metadata/amll.js` **新增**：AMLL API 客户端（get/search + 缓存）
- `main/metadata/qq-music.js` **新增**：musicu 歌词 + 关键词搜歌（ct/cv 头 + 3DES/QRC 解密）
- `main/metadata/kugou.js` **新增**：两段式歌词链路（songsearch 拿 FileHash → krcs hash 直查候选 → KRC/LRC 下载解密）+ 旧 keyword 路径兜底
- `main/metadata/netease.js`：`getLyric` 扩展（v1 接口拿 yrc/ytlrc/yromalrc，旧接口兜底），返回结构化
- `main/metadata/lyrics.js`：`fetchLyricsRich()`（单发降级链）+ `fetchLyricsRichAll()`（全收集，供选源），保留 `fetchLyricsFromLrclib` / `fetchLyricsForTracks` 旧导出
- `main/metadata/lyrics-select.js` **新增**：源管理后端（selectSource / addTtml / removeSource + 指纹去重）
- `main/metadata/lyrics-model.js`：`applyModelToTrack`（模型→轨道字段，选源/贴 TTML 共用）
- `main/metadata/schema.js`：tracks 透传 `lyricsData` / `lyricsSources`（白名单重建，带裁剪）
- `main/metadata/fetch.js`：`attachLyrics` 接入 `fetchLyricsRichAll`，保留 LRCLIB 兜底分支
- `main/ipc.js`：`lyrics:select-source` / `lyrics:add-ttml` / `lyrics:remove-source` / `app:open-external`（仅放行 http/https）；`meta:save` 的 manual 改存快照对象（修"已编辑会被刷新覆盖"失效 bug）
- `main/cd/cd-service.js`：`_applyManualOverrides` 恢复歌词模型/候选列表

渲染端：
- `renderer/js/lyrics-view.js` **新增**：歌词渲染引擎（行/词/翻译/对唱/间奏 + 高亮计算），nowplaying 与 floating 共用
- `renderer/js/nowplaying.js`：接入 lyrics-view；`applyLyricToggles` 按有无译/音轨显隐按钮
- `renderer/js/edit.js`：歌词源管理 UI（候选行点选 / 手动源删除 / TTML 粘贴与工具按钮 / LRC 手动编辑）
- `renderer/js/app.js`：`Sizes` 增 `trScale` → `--lyric-tr-scale`
- `renderer/js/settings.js`：字号区第三根滑条「翻译」；恢复默认改按键遍历（原下标三元在三个滑条下会写错）
- `renderer/css/panels.css`：源管理行 / TTML 区样式；`pages.css`：`.np-lyrics{overflow-x:hidden}`、`.lrc-line{overflow-wrap:anywhere}`、`.lrc-tr` 乘 `--lyric-tr-scale`

测试：
- `tests/lyrics-parse.test.js`：5 种解析器对**真实 fixture**（AMLL/网易云/酷狗为真实样本，QQ 为严格格式合成样本）逐项断言
- `tests/lyrics-fallback.test.js`：降级链单发/全收集双模式（mock 各源：全部失败→部分失败→质量分裁决→间奏插入→对唱折叠→全收集候选降序）
- `tests/lyrics-select.test.js` **新增**：源管理后端（选源白名单/越界/坏模型、TTML 解析/空/坏文本/指纹去重/删手动源/回退）
- `tests/ui-contract.test.js` **新增**：前端契约静态断言（横向溢出防护、trScale 链路、翻译开关显隐纪律）
- `tests/renderer.test.js`：编辑面板源管理 UI（16c）、三档字号滑条（17b）；26b 段按生产序列先发 `cd:position` 再 tick（修偶发竞态）
- `tests/fixtures/`：已存 4 个真实样本（amll-yoasobi-shukufuku.ttml / netease-yrc-aiichen.json / qq-musicu-jay.json / kugou-krc-qilixiang.txt + 加密原文）

文档：README §歌词 章节重写（源、降级链、缓存、渲染规则、§3.7.5 源管理）。

## 五·补、诊断日志与联网自检（实现状态：已完成）

用户侧反馈"删了碟片重读还是 LRC"时，需要能自己定位卡在哪一级，故补：

- **日志贯穿**：`cd-service.js` 把 `this.log` 传进 `fetchDiscMetadata` → `attachLyrics`
  → `fetchLyricsRich`（此前没传，降级链在应用里**完全无日志**，是最大排障盲区）。
  `lyrics.js` 的 `won(label, title, model, log)` 在命中时输出一行：
  `lyrics[曲名] 源 逐字/行级 N行 质量M 译/音/对唱/间奏×k`；六源全空输出
  `六源均未命中（可能未收录或网络不可达）`。`trySource` 只在**抛异常**
  （超时/网络错）时记 `失败：`，返回 null（源可达但没数据）静默——
  "没收录"与"连不上"因此可区分。LRCLIB 双保险触发也记一行。
- **冒烟工具** `tools/lyrics-smoke.js`：纯 Node（http.js 不依赖 Electron），
  `require` 的就是 `fetchLyricsRich` 本体。`--preset` 跑内置试样集
  （华语/日语/欧美/边界），输出与 debug.log 同格式 + 词级时间预览 + 耗时。
  实测参照（2024）：匆匆那年→amll 逐字 32 行；演员→netease 逐字 47 行；
  Lemon→netease 行级（无 yrc，设计内降级）；Yellow→netease 逐字 42 行；
  小星星变奏曲→六源均未命中。
- 使用手册见 README §3.7.4（三个前提：确认新包 / 清 `<userData>/metadata/` 缓存 /
  看 `debug.log` 的 `lyrics[` 行）。

## 五·补二、歌词源管理与手动编辑（实现状态：已完成）

编辑面板要"看到并管理所有来源"，降级链因此拆成双入口：

| 入口 | 行为 | 调用方 |
|---|---|---|
| `fetchLyricsRich` | **单发**：命中即返回（旧行为） | LRCLIB 兜底等旧路径 |
| `fetchLyricsRichAll` | **全收集**：六源全跑，返回 `{best, candidates}`，候选按质量降序（稳定排序，同分源表在前者胜） | `fetch.js` 的 `attachLyrics` |

`attachLyrics` 把 `candidates` 存进轨道的 `lyricsSources`（schema 的
`lyricsSourcesModel` 白名单：每份过 `lyricsDataModel`，最多 8 份），
`best` 照旧进 `lyricsData`。网易云 yrc 与 lrc 是**两份不同候选**
（质量不同，用户可能就想要行级那份）。

**为什么选源/贴 TTML 全在主进程做**（`lyrics-select.js`）：模型→LRC 的
`toLrc`、TTML 解析 `parseTTML` 只在主进程有；渲染端只发指令
（`lyrics:select-source` / `lyrics:add-ttml` / `lyrics:remove-source`），
不回传整份歌词数据，渲染端拿回传的 meta 局部刷新单轨 DOM。

- `addTtml`：解析→`finalizeModel`→白名单→打 `ttml-manual` 标→入列并启用；
  重复粘贴按内容指纹（行数+首行时间+末行文本）去重——**只改词级时间、
  行时间不变视为同一份**（行时间取自 `<p>` 的 begin，这是实测过的行为）。
- `removeSource`：只删手动源；删的正是当前项时回退到剩余质量最高，
  删空了则歌词整体清空（不留半截数据）。
- **manual 快照 bug**：`meta:save` 原写 `manual: true`（布尔），
  `_applyManualOverrides` 要求对象直接 return——"已编辑不被刷新覆盖"
  从未生效。改为存快照对象（tracks 全量），歌词 IPC 后也刷新快照。

**翻译字号 `trScale`**：设置第三根滑条（0.6~1.8，默认 1），
`Sizes` 写 `<html>` 的 `--lyric-tr-scale`，只有 `.lrc-tr` 消费
（主字号不牵连）。悬浮窗是独立 document，不继承该变量——
它有独立的 px 字号控制，不同步是有意为之。

**页面右移修复**：`.np-lyrics` 只有 `overflow-y:auto` 时 `overflow-x`
被计算成 auto，鼓点缩放（`scale 1.11 + translateX ±4px`，`--beat`
写在 `<html>` 上被所有 `.lrc-inner` 继承）与激活行 150% 宽光晕撑出
隐藏横向滚动区。修法=`overflow-x:hidden` + `.lrc-line{overflow-wrap:anywhere}`，
`tests/ui-contract.test.js` 静态锁回归。

**测试注入的一个坑**（renderer 26b 段）：`NowPlaying.tick(pos)` 只驱动
高亮，RAF 循环读的是 `Transport.positionSec()`（墙钟锚点）。测试只 tick
不发 `cd:position` 时两者不一致，rAF 到期就会把高亮覆盖回去——**偶发失败**。
修法是测试按生产序列先 `emit('cd:position', {sec})` 再 tick
（`correctFrom` 带 0.3s 死区，本就是干这个的）。

## 五·补三、酷狗两段式重做与物理光驱 SPTI 回退（实现状态：已完成）

### 酷狗 KRC 获取率（keyword 入口全灭 → 两段式）

用户反馈"很多歌酷狗上都有逐字歌词却拿不到"。根因不是酷狗没歌词，是
`lyrics.kugou.com/search?keyword=…` 对**任何**关键词恒返回 404（2026-11
起，连纯歌名也 404）——旧入口整个死了，而 hash 直查活得好好的。

解法（参考 minerradio）：`songsearch.kugou.com/song_search_v2`
（WebFilter 客户端免登录）拿 `FileHash` + `album_audio_id` →
`krcs.kugou.com/search?hash=…` 直查候选（官方推荐打头，实测 10~20 个
版本）→ 逐个顺延下载 KRC（封顶 3）+ LRC 兜底（封顶 2）。

真实网络抽查（重做后复测）：Lemon 57 行 / 七里香 38 行 / 红莲华 57 行 /
残酷天使 50 行 / Yesterday Once More 62 行 / 夜曲 84 行，全部首候选即
命中，单首 330~730ms。乱词对照正确 miss（乱词返回 1 行垃圾候选，被
`accept()` 质量门槛拒收）。

用户场景修复实证：Lemon 在 `fetchLyricsRichAll` 中从"网易云行级 质量15"
升级为"酷狗逐字 57 行 质量121"，以质量分胜出进入 `lyricsSources` 供切换。

异常语义：songsearch/krcs 抛异常（超时/网络错）→ 本源自此刻中止，
**不**静默重试、**不**试旧 keyword 入口（两个入口同属酷狗，一个炸另
一个大概率也炸，静默重试会搅浑诊断日志），由 `trySource` 记一行
`lyrics[kugou] 失败：…`。

### 物理光驱 RAW 读取回退 MCI → SPTI READ CD 链

用户实测物理光驱仍回退 MCI。`IOCTL_CDROM_RAW_READ` 在部分物理光驱
（尤其 SATA/USB 桥接）上能力不完整：报错，或"成功但全零"。底层
READ CD(0xBE) SCSI 指令却是好的 —— 直接对端口驱动发 SCSI 命令即可
绕过类驱动缺陷（EAC / cdrdao 同款思路）。

`main/native.js` 新增回退链（按句柄缓存生效方法，命中后零额外开销）：

```
IOCTL_CDROM_RAW_READ（单次全量，首选）
  └ 失败 → SPTI：IOCTL_SCSI_PASS_THROUGH(0x4D004) + READ CD(0xBE)
            （IOCTL_SCSI_GET_ADDRESS(0x41018) 取 PathId/TargetId/Lun；
             ≤27 扇区/块拆分：27×2352=63,504 < 64KB， storport/ATAPI
             MaximumTransferLength 经典上限）
      └ 再失败 → mode='broken'，后续直接抛带完整诊断的 ERAWREAD
```

要点：
- SCSI_PASS_THROUGH 的 `DataBufferOffset` 是 **ULONG_PTR**（x64 下
  sizeof=52，Cdb@36；32 位版才是 44，混用会因 Length 字段不匹配被
  驱动拒收）。选非 DIRECT 版本：偏移而非指针，且系统负责缓冲对齐，
  纯手工 Buffer 布局即可（结构 52 + Filler 4 + sense 32 @56 + data @88）。
- CDB 主通道选择 `0xF8` = Sync+Header+UserData+EDC/ECC，输出与
  IOCTL_CDROM_RAW_READ 逐字节一致（2352 全扇区），上层字节序翻转
  逻辑不用动（Linux 内核 `sr_read_cd` 对 2352 用同值）。
- 句柄以 `GENERIC_READ|GENERIC_WRITE` 打开（SPTI 的 Access 位要求），
  被拒时退回只读（旧路径照常，SPTI 不可用而已）。
- 诊断：ERAWRITE 错误带两条路径的 win32 错误码 + SCSI sense
  （key/asc/ascq），cd-service 能力测试与 worker 读取失败都会透出；
  `rawReadMethod(handle)` 报告实际生效方法（'ioctl' | 'spti'），
  记入 capability test 日志，物理光驱排障时是关键证据。

## 六、验收标准

1. 五种源解析器对真实/合成 fixture 全断言通过（词数、起止时间、翻译挂接、对唱折叠、间奏插入）。
2. 降级链单测：高分源胜出、超时跳过、纯音乐/空歌词正确传递。
3. 现有 18 个测试套件不回归（ALL PASS）。
4. 手工验证点（用户侧）：中文碟（网易云/AMLL）、日文碟（翻译+罗马音）、对唱歌曲、有间奏的曲子、海外碟（LRCLIB）、无歌词碟的提示。
5. 打包交付 zip。
