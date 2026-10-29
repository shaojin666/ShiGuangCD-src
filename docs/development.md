# 拾光 · CD（ShiGuang CD）

一款为 CD 光盘而生的优雅桌面播放器。核心不是"另一个 CD 播放器"，而是把**读盘前、读盘中、读盘后**三个阶段做成一条一镜到底的仪式：
光盘从画面外滑入托盘 → 镜头推近、激光扫描、进度环收拢 → 揭晓专辑 → 唱片无缝"落"到正在播放页。

- 兼容 **Windows 7 – Windows 11**（x64）
- 读盘后自动联网获取专辑封面 / 专辑名 / 曲目 / **逐字歌词**，并**保存在本地**，下次读同一张碟直接调用
- **多碟专辑支持**：自动识别碟号并据此精确匹配曲目与歌词，音乐库卡片封面右下角显示 `D1/2` 角标便于区分
- 允许手动编辑专辑信息（含**碟号**）与歌词（仅保存在本地，不会被在线刷新覆盖）
- **适配 Windows 系统媒体控件（SMTC）**：系统媒体弹窗 / 锁屏 / 键盘媒体键显示**当前歌曲名与专辑封面**，并可直接播放 / 暂停 / 上一首 / 下一首
- 音乐库主页 + 独立歌词页（封面、歌名、专辑名、**逐字**高亮滚动，支持译文 / 罗马音 / 对唱 / 间奏）
- 基础音量、顺序 / 单曲 / 列表 / 随机四种播放顺序，其余复杂功能一概不做

---

## 一、需要什么版本的 Node.js

| 场景 | 版本要求 | 说明 |
|---|---|---|
| **构建 / 开发**（打包安装程序、跑 npm install） | **Node ≥ 14.18，建议 Node 18 / 20 LTS** | ① electron-builder 23.6.0 要求 node >= 14；② 实测 koffi 3.0.2 的安装脚本 `cnoke.cjs` 使用了 `require("node:fs")` 这类 `node:` 前缀写法（Node 14.18+ 才支持），**Node 13 下 npm install 必然失败**（报 "Cannot find module 'node:fs'" 一类的 koffi 错误） |
| **在 Windows 7 本机上做开发** | **不可行（不推荐）** | Win7 最高只能装 Node 13.14.0，而 koffi 3.0.2 安装脚本要求 Node ≥ 14.18，因此在 Win7 上无法完成 `npm install`。**Win7 机器只做运行，不做构建** |
| **最终用户运行应用** | **不需要装 Node** | 应用内置 Electron 22 自带的 Node 16.17.2，与用户机器能否安装新版 Node 完全无关 |

> 结论：**构建机用 Win10 / Win11 + Node 18 / 20 LTS**，产出安装包后拷到 Win7 安装运行即可。

### 为什么锁定 Electron 22

Electron 官方博客明确：**Electron 22 是最后一个支持 Windows 7 / 8 / 8.1 的主版本**；Electron 23 起（Chromium 109+）仅支持 Windows 10+。
本项目锁定 **electron@22.3.27**（22.x 的最后一个补丁版，Chromium 108 / Node 16.17.2），并在入口处关闭了与 Win7 相关的实验特性（`CalculateNativeWinOcclusion`），自动播放策略也已放开（`autoplay-policy=no-user-gesture-required`），保证"读盘后直接播放"无需任何点击。

---

## 二、CD 读取是怎么实现的（认真考虑过的部分）

### 1. 原生层（main/native.js，基于 koffi 3.0.2）

用 **koffi**（N-API FFI）直接调用 Windows 原生 API，不经过第三方驱动：

- `kernel32.dll`
  - `CreateFileW` / `CloseHandle` —— 以 `\\\\.\\X:` 打开光驱（`GENERIC_READ | FILE_SHARE_READ | FILE_SHARE_WRITE`）
  - `GetDriveTypeW` —— 枚举 A–Z 盘符，`DRIVE_CDROM (5)` 即光驱
  - `DeviceIoControl` —— 下发 SCSI 控制码
- `winmm.dll`
  - `mciSendStringW` —— MCI 回退播放路径（见下）

关键 IOCTL（均在源码中写死并注释，取值经 Wine ntddcdrm.h / DDK6000 IOCTL 表 / 《CD Cracking Uncovered》三方交叉确认，`tests/native.test.js` 逐项回归）：

| 控制码 | 用途 |
|---|---|
| `IOCTL_CDROM_READ_TOC = 0x24000` | 读取光盘目录（TOC，Vista 起官方废弃但仍可用） |
| `IOCTL_CDROM_READ_TOC_EX = 0x24054` | 读取 TOC 的现代路径（XP 起，优先使用） |
| `IOCTL_CDROM_RAW_READ = 0x2403E` | 原始扇区读取（数字音频抽取，METHOD_OUT_DIRECT） |
| `IOCTL_CDROM_EJECT_MEDIA = 0x24808` | 弹出托盘 |
| `IOCTL_CDROM_LOAD_MEDIA = 0x2480C` | 关舱/加载 |
| `IOCTL_STORAGE_LOAD_MEDIA = 0x2D480C` | 关舱（取代已废弃的 `IOCTL_CDROM_CLOSE_DOOR`） |
| `IOCTL_STORAGE_CHECK_VERIFY = 0x2D4800` / `CHECK_VERIFY2 = 0x2D0804` | 介质存在性轻量探测 |

> ★ **历史事故记录（根因即常量写错）**：旧版把所有 CD-ROM IOCTL 漏掉了 `FILE_READ_ACCESS` 位
> （写成 `0x2xxxx` 而非正确的 `0x24xxx`），`RAW_READ` 误用 `0x38000`，`CLOSE_DOOR` 用了废弃值
> `0x20010`，`CONTROL_DATA_TRACK` 误用 `0x08`（那是四声道位，数据轨标志应为 `0x04`）。
> 后果：`readToc()` 永远失败 → 全部走 MCI 兜底 → RAW 播放链路形同虚设。
> 旧测试套件用假 native 模块注入 `require.cache`，真实 native.js 从未被加载，所以常量错误
> 一路绿灯。现新增 `tests/native.test.js`（Module._load 注入假 koffi，加载真实 native.js）盯防此类回归。

**RAW 读取的两个关键语义**（踩过坑的地方，源码已按此实现）：

1. `RAW_READ_INFO.DiskOffset` 是**字节偏移 = LBA × 2048**，Windows 驱动会 `>>11` 后当作 LBA 直接下发给 `READ_CD`；
2. MMC 规范里 CD 的 **LBA = 绝对帧号 − 150**（第一轨起始帧 150 = 0:02.00）。因此读取音频必须传 `lba = startFrame - lbaOffset`，否则会偏一个扇区起点、播放错位。
   `lbaOffset` 由 TOC 来源决定：**raw TOC（绝对帧）= 150，MCI 兜底 TOC（首帧已是 LBA 0）= 0**。旧实现硬编码 150，在 MCI 兜底读到的目录上会整体错位 2 秒。

每个扇区 2352 字节为 **CD-DA 大端 16bit 双声道采样**，读取后在 worker 线程转成小端 Int16LE 再推给渲染进程（Web Audio 直接消费）。例外：部分 USB 桥接光驱返回的是**小端 16bit PCM**（v10.2 实测），worker 按波形判据识别后**直通不解码**（详见 §5.6）。

TOC 结构：4 字节头 + 100 × 8 字节 `TRACK_DATA`；`Address[4]` 为 MSF（分/秒/帧，`lba = min×4500 + sec×75 + frame`）。源码内置了 **MSF 字节序自适应**（用第一轨起始地址是否 ≈150 判定主/备解析）。

**物理光驱 RAW 回退 MCI 的根治：SPTI READ CD 链**（v6 新增，EAC / cdrdao 同款思路）。部分物理光驱（尤其 SATA/USB 桥接）的 cdrom 类驱动对 `IOCTL_CDROM_RAW_READ` 支持不完整——报错，或"成功但全零"——而底层 READ CD(0xBE) SCSI 指令是好的。`native.js` 因此内置三级策略（按句柄缓存生效方法，命中后零额外开销）：

```
IOCTL_CDROM_RAW_READ（首选；>27 扇区自动按 27 边界拆分后拼接）
  └ 失败，或"成功但全零" → SPTI：IOCTL_SCSI_PASS_THROUGH(0x4D004) + READ CD(0xBE)
            （IOCTL_SCSI_GET_ADDRESS(0x41018) 取 PathId/TargetId/Lun；
             ≤27 扇区/块拆分：27×2352=63,504 < 64KB，ATAPI MaximumTransferLength 经典上限）
      └ 再失败 → mode='broken'，后续调用直接抛带完整诊断的 ERAWREAD
```

- **"成功但全零"也要切 SPTI**（v7 补强）：类驱动缺陷有两种表现——抛错，和返回成功但数据全零。后者早期只被能力测试判死刑走 MCI，同一台光驱的 READ CD 从未被尝试。现在 IOCTL 拿到全零会用 SPTI 验证一次：有真数据 → 永久切 SPTI；SPTI 也全零 → 多半是真正的数字静音段（CD-DA 静音就是全零），退回 ioctl 路径交给上层看门狗，不误切。

- SCSI_PASS_THROUGH 的 `DataBufferOffset` 是 **ULONG_PTR**（x64 下字段内容到 52 字节，但结构体对齐为 8、sizeof 补 4 字节尾部填充 = **56**，Cdb@36；32 位/WOW64 版是 44 字节的 SCSI_PASS_THROUGH32 布局）。v10 修复：旧代码 Length 写 52（按内容结尾而非 sizeof），storport 以 1306 revision mismatch 拒收、SCSI 命令从未发出——详见 §5.5。选非 DIRECT 版本，偏移而非指针、系统负责缓冲对齐。
- CDB 主通道选择 `0xF8`（Sync+Header+UserData+EDC/ECC，完整 2352 字节扇区），输出与 RAW_READ 逐字节一致，上层字节序翻转不用动。
- 句柄以 `GENERIC_READ|GENERIC_WRITE` 打开（SPTI 的 Access 位要求），被拒时退回只读。
- **两条路径统一按 ≤27 扇区拆分**（v7）：播放 worker 按 75 扇区（176KB）单笔请求曾超过 storport 64KB 传输上限，部分 miniport 直接拒掉——表现为"能力测试过、播放中连片失败"。现在 IOCTL 入口也自动拆分，`rawReadIoctlSingle` 保留单笔形态仅供诊断工具验证上限。
- 诊断：ERAWRITE 带两条路径的 win32 错误码 + SCSI sense（key/asc/ascq）；`rawReadMethod(handle)` 报告实际生效方法（ioctl/spti），cd-service 能力测试日志会写明「IOCTL_RAW_READ 不可用，已回退 SPTI READ CD」——物理光驱排障的关键证据。
- **物理光驱排障工具**（v7 新增）：`tools/raw-diag.bat`（双击运行，Windows 专用，纯 Node 无需构建）。逐项打印驱动器枚举、打开权限路径、TOC、IOCTL 2/75 扇区（单笔）、SPTI 2/27 扇区、SPTI 变体、checkMedia、rawRead 全链、MCI 兜底——每步带错误码/sense/数据是否全零。把窗口全部内容回传即可定位"为什么回退 MCI"。v9 起增加「RAW 数据质量定性」：sync 头合规数、全零扇区计数、PCM 峰值/非零率、同 LBA 双读一致性、2 扇区 vs 75 扇区内容一致性、轨中段复读，并把 1 秒原始数据落盘 `raw-dump-<盘符>.bin` —— **专治"RAW 模式白噪音"**（打印机会把结论直接写在输出里）。**v10 修复 SPTI 结构体布局后**，SPTI 探测项增加：数据质量速检、`Length=44` 旧布局实证探测（确定驱动到底按哪种 Length 校验）、SPTI 原始数据落盘 `raw-dump-<盘符>-spti.bin`。**v10.2 起判据改为波形平滑度**（MASD/RMS，小端/大端双口径 + `detectPcmForm` 四态判定），结论直接区分：标准大端 / 小端 PCM（直通解码即可播）/ 伪造垃圾（切 MCI）/ 全零。

### 2. 读取线程（main/cd/reader-worker.js）

RAW 读取是**同步阻塞**的系统调用，直接放在主进程会卡 UI。因此：
- 独立 `worker_thread` 持有设备句柄，按 **75 扇区（0.5 秒）一块**读取（native 层自动拆成 ≤27 扇区的多笔系统调用，规避 64KB 传输上限）；
- 结果通过 `postMessage` 的 **transferable buffer** 零拷贝回传主进程；
- 坏扇区**重试 3 次**后填充静音跳过（轻微划伤不影响连续播放），并一次性提示用户；
- 主进程 `RawPlayer` 做 **约 10 秒预读缓冲**，保证 CD 读取抖动不造成卡顿。背压以"已读超前量（秒）"计算（旧实现用只增不减的块计数，20 块后预读会永久停摆）。

> ★ **每条回复必须回带 `reqId`**（踩过的坑，值得写进协议文档）：主进程 `_request()`
> 靠 `reqId` 把回复认领给等待中的 Promise。`open` 的回复曾漏带 `reqId`，被
> `_onMessage` 当无效消息丢弃 —— `RawPlayer.start()` 的 Promise 永远不落地，
> 起播路径整体挂起，表现为"**日志说 RAW 数字读取可用，点播放却什么都没发生、
> 没有声音也没有报错**"（能力测试走主进程直读，所以日志一切正常）。
> 既有 `raw-player.test.js` 的假 Worker 反而回带了 `reqId`，把这条 bug 遮住了；
> 现在由 `raw-pipeline.test.js` 用**真实 worker 源码**做全链路回归。
> 另外 `start()` 带 10 秒启动超时：worker 加载失败时快速失败回退 MCI，绝不久久挂起。

### 3. MCI 回退路径（main/cd/mci-player.js）

部分老旧光驱不支持 `RAW_READ`（或设备被占用）。此时自动回退到 **winmm MCI**（`open cdaudio` / `play` / `stop`），由声卡侧播放。
代价：**MCI 路径下应用内没有音量控制**（音量条会禁用并给出提示）。

MCI 的时间轴不再靠"原点猜测"：`open()` 后逐轨查询 `status cd position track N` / `status cd length track N`，直接建立 **MCI 自身 MSF 时间轴上的「轨道起点 → 时长」映射表**，`play` / `seek` / `position` 全部在同一条时间轴上换算（旧实现 `position` 用 `-origin`、`play from` 用 `+origin`，起播会偏整整 4 秒）。位置由本地锚点时钟维护，250ms 轮询只做**死区校正**，因此进度条不会因为轮询抖动来回跳。

> ★ **位置权威链**（暂停点 / 续播点 / 定位落点为什么要"回读设备"）见 [§三·六](#三六播放位置精度暂停--续播--定位--歌词同步)。
> 一句话：本地墙钟只是平滑器，**`status cd position` 的回读值才是权威**；
> 所有会改变设备位置的命令（`play` / `pause` / 定位）返回后都必须回读并硬对齐。

### 4. 状态机（main/cd/cd-service.js）

`探测循环（2s）→ insert（滑入 1s）→ reading（目录+元数据）→ reveal（揭晓 1.15s）→ ready → land（落地）`。
探测阶段就读完真实 TOC；读盘仪式只是**节奏化呈现**，不会让用户干等硬件。

**两套状态严格分离**（这是播放控件准确的前提）：

| 字段 | 取值 | 含义 |
|---|---|---|
| `phase` | `idle / insert / reading / reveal / ready / eject / no-drive` | 光盘生命周期 |
| `playState` | `stopped / playing / paused` | 传输状态 |

旧实现把 `playState` 混进 `phase`（`stopPlayback()` 直接把 phase 置为 `idle`），
于是"播完/手动停止"会被探测循环误判成"碟已不在"，立刻重走一遍读盘仪式并自动续播。

### 5. 播放状态唯一真相（renderer/js/transport.js）

播放控件（进度条 / 时间 / 播放图标 / 轨道行）**只读 `Transport.snapshot()`**，不再各处各算一套。

- 位置 = **锚点 + 墙钟**（`anchorSec + anchorAt + running`），暂停即冻结，恢复即续走，永远单调连续；
- 数据源有优先级：主进程 `cd:state` 权威快照（状态/曲目变化无条件采纳）> 引擎自身位置（RAW 的 AudioContext 调度位置 / Demo 的 AudioContext 时间）> MCI 轮询 `cd:position`（仅死区校正）> 本地墙钟兜底；
- 播放 / 暂停**只发 IPC**，等主进程回权威状态再更新界面，不做会撒谎的乐观更新；
- 切轨 / 定位允许乐观更新，但会进入 **1 秒保护期**，期间忽略轮询软校正，杜绝"跳过去又被拉回"；
- 进度条 `step=0.05`，拖动期间展示预览值、`pointerup/change` 才真正提交定位。

#### 暂停 / 续播为什么现在是准的（三个独立的坑）

1. **预读缓冲必须一起丢掉，而且必须"当帧静音"。** RAW 路径最多预读 5 秒音频，旧实现暂停时
   只冻结主进程时钟，渲染端 `AudioContext` 队列里排着的音频照播不误——表现为
   "点了暂停还要等一两秒才安静"。这里有个容易踩的细节：`AudioContext.suspend()`
   **不是当帧生效的**（要等音频线程下一轮调度），所以只调 `suspend()` 仍然会漏出小半秒声音。
   现在的顺序是：
   1. 先读听感帧 → 2. 置 `paused` → 3. **`GainNode` 12ms 短斜坡降到 0（当帧静音，
      斜坡是为了不爆音）** → 4. `flush()` 丢弃未播缓冲 → 5. 最后才 `suspend()`。
   `resume()` 反向操作（20ms 斜坡恢复音量），并从暂停点**重新起读**。
2. **暂停点必须取播放器报告的位置。** 服务层墙钟与播放器本地时钟之间可能差一个校正死区，
   直接拿 `_positionSec()` 当暂停点，恢复后就跟暂停前对不上。
   现在统一取 `player.audibleSec()`，且**必须在切到 paused 之前结算**（暂停态不再累加墙钟）。
3. **★ 暂停点必须由渲染端裁决。** 主进程手里只有"已读游标"和本地墙钟，
   **它并不知道耳朵听到了哪一秒**——预读缓冲 + IPC 延迟 + 读取抖动都会让两者错开。
   结果就是"进度条显示 13s，续播却从 15s 开始，进度条再一路加速追上去"。
   现在点暂停时，渲染端先读一次 `AudioEngine.positionSec()`（基于 `AudioContext.currentTime`
   与已调度队列，是唯一真实的听感位置），把它同时用于：
   - 钉死界面上的数字（`Transport.setPosition`）
   - 作为 `cd:pause { sec }` 的参数回传主进程

   主进程据此对齐播放器与权威锚点，续播从同一秒起读。界面数字与耳朵听到的是同一个数。

配套的三处修正：
- `AudioEngine.positionFrame()` 不再把"已读游标"当位置。此前只要当前时刻没落在任何已调度块内
  （刚恢复、断流、尚未起播），它就返回 `nextAbsFrame`——最多超前整个预读缓冲，
  暂停点会莫名往前跳几秒。
- `feed()` 在暂停态直接丢弃数据块。主进程暂停后 IPC 管道里仍可能躺着若干已发出的块，
  不丢弃就会出现"点了暂停还响一会儿"。
- 进度条校正改为**渐进式**（`Transport.easeTo`）：有残余偏差时一小步一小步消化，
  不再一次性跳变，也不会出现"用更快的速度追音频"。

#### 播放期间绝不做全量探测

旧实现每 2 秒对每个光驱做一次 `CreateFile + IOCTL_CDROM_READ_TOC`。这是**同步**调用，
和 RAW 读取线程争用同一设备，无响应时能把主线程堵住数百毫秒~数秒——
"点了暂停/切歌要等一两秒才响应"的真凶就在这里。
现在播放/暂停期间探测循环直接让路，改由**读取线程健康度看门狗**判断介质是否还在。

#### 切歌后不会"读不出声音"

`RawPlayer.pump()` 旧实现把 `this.generation === gen` 写进了 while 条件：
一旦切轨 / 定位 / 暂停推进了代次，正在跑的 pump 会退出，
但 `finally` 里又因为代次不匹配而**不复位 `pumping`**，
于是下一次 `pump()` 被 `if (this.pumping) return` 挡在门外 —— 播放中手动切歌会彻底断流。
现在代次只用于"作废过期的在途数据块"，循环本身只看"是否仍在播放"。

### 5.1 光盘被物理弹出（外部弹出）

| 场景 | 检测手段 | 行为 |
|---|---|---|
| RAW 播放中 | ①读取线程连续报错 / 超过 4s 无推进；②**每 2 秒向设备显式问一次"盘还在吗"**（`IOCTL_STORAGE_CHECK_VERIFY2`，在读取线程里执行，不占主线程）。任一命中后再读一次 TOC 复核 | 主动停播 + 清状态 |
| MCI 播放中 | `MciPlayer` 状态轮询（`media present` / 指令连续失败），另有约 6 秒一次的 `isMediaPresent()` 兜底复核 | 主动停播 + 清状态 |
| 未播放 | 探测循环（此时无读取争用，可以安全做全量扫描） | 回到待机 |

- ★ **为什么要显式问一次"盘还在吗"**：相当一部分光驱（虚拟光驱、部分 USB 外置光驱）
  在无介质时 `IOCTL_CDROM_RAW_READ` **依然返回成功**，只是数据全为零。
  此时读取线程一路"成功"、光标持续推进，健康度看门狗永远判定健康——
  光盘被拿走了软件还在继续播。`checkMedia()` 就是为这种情况准备的。
  设备不支持该指令时返回 `null`（无法判定），此时只依赖健康度，不会误判为弹出。
- ★ **"读取成功"不等于"有音频"——垃圾/静音数据的三层防线**（用户实测事故的根因）：
  ① **能力测试校验内容**（`cd-service._testRawRead`）：按 75 扇区（1 秒，与播放块
  同大小）窗口从首轨轨首向后采样，**跳过数字静音前奏**（v8 修复：用户实测碟
  轨首 2 帧就是静音，旧实现只读 2 帧 → 误判"不支持"回退 MCI，而同一位置读
  75 扇区全是真音频），最多 8 个窗口——与看门狗 8 秒口径对齐；全部窗口整块
  全零才判定"该光驱不支持数字音频提取"，回退 MCI——否则会进入 RAW 模式却
  全程静音，日志还写着"数字读取可用"。**CD-DA 的静音本身就是全零**，与驱动
  "假成功"表现一模一样，只能用"窗口内有没有数据"区分，采样窗口必须足够大；
  ② **数据形态判别**（v9 引入 sync 校验，v10.2 改为波形判据）：
  "非零"也不等于"是音频"——部分光驱/驱动返回成功且非零，但内容是伪造的垃圾。
  v9 用 CD-DA sync 头（每个 2352B 扇区前 12 字节必是 `00 FF*10 00`）做铁证，
  **非零但一个 sync 头都没有 → 判垃圾继续向后找**，8 个窗口全是垃圾才回退 MCI。
  但 v10.2 用户实测证明：**纯 CD-DA 音频扇区可以整个 2352 字节都是 PCM 采样**
  （588 立体声帧正好占满，没有同步头的空间），第三方读取实现对 CD-DA 的描述
  就是 "2,352 bytes of headerless PCM"——**无 sync 头的真音频确实存在**。
  现在统一由 `audio-stats.detectPcmForm` 按**波形平滑度**（相邻采样平均绝对差
  MASD ÷ RMS，真实音频 <0.7，字节序搞反/随机垃圾 ≈1.1+）四态判别：
  `be16`（标准大端，sync 铁证优先）/ `le16`（小端直通）/ `silence`（全零近静音）
  / `garbage`（两种字节序都不像音频波形）——详见 §5.6；
  ③ **播放中的双重看门狗**（`raw-player.pump`）：连续 8 块（8 秒）全零、
  或连续 4 块（4 秒）被 worker 判为 `garbage`（两种字节序都不像音频波形），
  触发 `onError` → 服务层切换 MCI 续播
  （通知文案区分"不支持数字读取"与"数据异常（白噪音）"）。垃圾阈值比全零短：
  白噪音是正在往外喷的噪声，多响一秒都是折磨。单块全零/垃圾仍然放行——
  CD 上极短的数字静音是合法内容。
  > **v10.2 实证结论（用户 F 盘实体光驱实测定论）**：该光驱（USB 桥接固件）
  > 返回的是**小端 16bit PCM**——安静前奏时低 8 位就是全部内容、高字节恒为
  > 符号扩展（0x00/0xFF），看上去像"8bit 降质"（v10.1 的 raw8 误判来源），
  > 音乐变响后高字节开始变化、raw8 随即失效 → 又变白噪音（用户实测复现）。
  > 三个证据链定案：① IOCTL 与 SPTI 两条路径前 27 扇区逐字节相同（数据同源，
  > DiskOffset 无错位）；② 响段小端视角 L-R 相关度 0.942（真音乐），大端视角
  > 0.015（噪声）；③ MASD/RMS 小端 0.283 vs 大端 1.146（4 倍差距）。
  > **修复 = le16 直通解码**：不做字节交换，样本原样下发（见 §5.6）。
- 旧实现在读取失败时**填静音继续推进**，于是弹出光盘后进度条照走、轨末判定照触发，
  表现就是"音频卡死 + 无限重播下一轨"。现在连续 3 次失败就停下来判定介质，不再硬撑。
- 弹出事件带 `external` 标记：**用户在机箱上按出舱键**才是外部弹出，
  软件内点"出舱"不受影响。事件里的 `returnToScene` 决定是否退回读盘界面，
  由设置项「弹出光盘后回到读盘界面」控制（默认开）。

### 5.2 无光盘也能进主页面

读盘界面右上角有一个**隐藏的 × 按钮**：鼠标移动到右上角约 170px 内才淡入显示，
点击后直接进入音乐库。放入光盘时会自动重新走读盘仪式（修复了 `Scene.show()`
不清 `ph-hidden` 的 bug——否则淡出过一次就再也淡不回来了）。

### 5.3 音乐库右键编辑

卡片右键 → 「编辑信息 / 从音乐库移除」。编辑**不需要光盘在光驱里**：
直接按签名读写本地 `metadata/<sig>.json`。
「已编辑」标记从音乐库卡片移到了**编辑面板标题栏内部**，库页面保持干净。
编辑非当前光盘时不会动到正在播放页，「重新获取在线信息」按钮也会隐藏（它必须要有真实 TOC）。

每轨展开后有三区：**歌词来源**（全部候选点选启用、手动源可删）、
**添加 TTML**（AMLL TTML Tool 快捷按钮 + 粘贴保存）、**LRC 文本框**（经典手动编辑）。
详见 §3.7.5。

### 5.4 播放引擎：RAW / MCI 与运行时切换（v9）

两种引擎的取舍：

| 引擎 | 出声方式 | 音质 / 数据 | 适用 |
| --- | --- | --- | --- |
| RAW | 按扇区直读 CD-DA，进程内解码播放 | 完整 PCM，音乐律动可视化的数据来源 | 绝大多数物理光驱 |
| MCI | Windows `mcicda` 系统播放 | 声音由系统声卡直接输出，进程内拿不到音频数据 | RAW 不可用 / 数据异常时的兜底 |

**设置项「播放引擎」**（`enginePreference`，三选一）：

- `auto`（默认）：能力测试驱动 —— 过了就用 RAW，不过回退 MCI；
- `raw`：跳过能力测试强制 RAW（能力测试误判时的直通道；起播失败仍回退 MCI，不会没声音）；
- `mci`：跳过能力测试直接 MCI（**RAW 输出异常时的逃生门**）。

选 `raw` / `mci` 会**立即生效**：`cd:switch-engine` 通道记住当前曲目与听感位置 →
停旧引擎 → 起新引擎（切 RAW 前先跑一次能力测试，白噪音光驱不会被硬切进去）→
从同一点续播。没插光盘时只记住偏好，下次读碟时生效。
切换在演示模式（`--demo`）下不可用。

> 白噪音自救路径：RAW 模式下出现"电视雪花"声 → 设置 → 播放引擎 → MCI。
> v9 的能力测试/看门狗已能自动识别大部分伪造数据（sync 头校验，见 §5.1），
> 自动切换 + 手动切换是双保险。

### 5.5 SPTI 直读修复：Length=56（v10）

第三方播放器（iTunes / foobar2000 / EAC）播放 CD **并不是走 MCI**——它们在
Windows 上通过 SPTI（`IOCTL_SCSI_PASS_THROUGH`）直接对光驱发 MMC `READ CD`
（0xBE）命令读 CD-DA，这是物理光驱拿到原始 PCM 的正道。本软件的 RAW 链路
同样具备这条路径（`IOCTL_CDROM_RAW_READ` 失败时自动回退 SPTI），但 v9 及以前
SPTI 在所有光驱上一律失败：

```
SPTI READ CD 读 2 扇区: 失败 → 0x51a [winCode=1306]
```

**根因是 `SCSI_PASS_THROUGH` 结构体的 Length 字段写错**（`main/native.js`）：

- 真实结构（ntddscsi.h，现行 MSDN / mingw-w64 / wine 三处头文件一致）中
  `DataBufferOffset` 是 **ULONG_PTR**（指针宽度），x64 布局为
  `Length@0 / DataIn@8 / DataTransferLength@12 / TimeOutValue@16 /
  DataBufferOffset u64@24 / SenseInfoOffset@32 / Cdb[16]@36`；
- 字段内容到 52 字节，但**含 8 字节成员的结构体对齐为 8，sizeof 要补 4 字节
  尾部填充 = 56**（gcc 实测验证）。旧代码按"内容结尾"写 Length=52，
  storport 校验 `Length != sizeof(SCSI_PASS_THROUGH)` 即以
  `STATUS_REVISION_MISMATCH`（`ERROR_REVISION_MISMATCH=1306`，
  "two revision levels are incompatible"）拒收——**SCSI 命令根本没发到光驱**，
  与"驱动不支持 SPTI"无关；
- 修复：Length 52 → 56（字段偏移与缓冲区常量本就正确，一线改动）；
- CDB 主通道选择 `0xF8`（完整 2352 字节扇区）经 Linux 内核 `sr_read_cd`
  确认（2352→0xF8 / 2048→0x10 / 2336→0x58 / 2340→0x78），无需改动。

v10 的诊断工具会实证三种 Length（56/44/52）哪种被驱动接受，并对 SPTI 读回的
数据做质量定性（sync 数 / PCM 双字节序峰值 / 波形平滑度 / 形态判定 / 落盘），
据此在 v10.1/v10.2 精准接线管线（字节序与解码路径以实测数据为准，见 §5.1 的
v10.2 实证结论与 §5.6 的 le16 直通适配）。

### 5.6 小端 16bit PCM 直通：le16 解码（v10.2）

**用户实测形态**（F 盘实体光驱，`raw-dump-F.json` + `raw-dump-F-spti.json` 逐字节分析）：

| 观察 | 数值 |
| --- | --- |
| SPTI READ CD 27 扇区 / IOCTL 75 扇区 | 均成功，前 27 扇区逐字节相同（两条路径同源） |
| sync 头 | 0/27（纯 CD-DA 音频扇区无同步头，588 帧占满 2352B） |
| 波形平滑度 MASD/RMS | 小端视角 0.283（真音乐） vs 大端视角 1.146（噪声），4 倍差距 |
| 立体声相关度（响段） | 小端 L-R 0.942（真音乐） vs 大端 0.015（噪声） |
| 振幅包络 | 0.2s 静音 → 安静前奏（RMS 26-96）→ 0.7s 鼓点（837）→ 满音量（3068-3430），教科书级音乐结构 |

**根因**：该光驱的数字提取路径（USB 桥接固件）把 CD-DA **按小端 16bit PCM 输出**。
数据是真的音乐，只是字节序与标准 CD-DA 相反——旧管线一律 `swapEndian`
（大端假设）把音频字节对调，全程白噪音（v9 症状）。
安静前奏时低 8 位就是全部内容、高字节恒为符号扩展，看上去像"8bit 降质"，
v10.1 的 raw8 判据因此在轨首误判为降质数据；音乐变响后高字节开始变化、
符号扩展率骤降，raw8 随即失效 → 又变白噪音（用户实测复现的完整闭环）。

**适配**（判据同源：能力测试 / 播放看门狗 / reader-worker 解码共用
`audio-stats.detectPcmForm`）：

- **能力测试**（`cd-service._testRawRead`）：窗口数据经 `detectPcmForm` 判为
  `le16`（无 sync 但小端视角波形平滑）→ 放行（日志记录"小端 16bit PCM
  （该光驱返回 little-endian 数据，已启用直通解码：不做字节交换）"）；
- **解码**（`reader-worker.decodeRaw`）：`le16` 数据**原样直通**（字节层面
  零改动，样本值逐字节等于光驱输出）——这正是用户 F 盘光驱要的解码路径；
- **播放看门狗**（`raw-player.pump`）：`le16` 块豁免垃圾判定（无 sync 是这种
  光驱的正常形态，不是伪造证据），全零仍按原口径 8 秒止损；
- **首块日志**：le16 模式打印适配说明，不再误报"驱动返回垃圾数据"。

判别力依据：真实音频相邻采样高度相关（MASD/RMS 0.15~0.35），字节序搞反或
随机垃圾时失去相关性（≈1.1+），阈值 0.7 有充分间隔；判据**逐块独立、无跨块
记忆**（argmin 在安静段/响段都不翻转，跨块记忆反可能在模糊块上粘错字节序）。
已知盲区：线性斜坡型伪造数据（相邻差恒定）平滑度极高会被误判为音频——
测试 fixture 因此一律用真随机（PRNG）构造垃圾数据。若光驱输出的是**伪造
垃圾**，波形判据判 `garbage` → 4 秒止损切 MCI，设置页「播放引擎 → MCI」
是直通道。

---

## 三、在线元数据（大陆地区方案）

> 旧版只有一个源（MusicBrainz）+ 一个封面源（Cover Art Archive）+ 一个歌词源（LRCLIB），
> 且 MusicBrainz 的解析字段写错（读 `data.discs`，实际返回的是 `data.releases`），
> 导致整条链路**恒为空** —— 这就是"联网获取元数据无效"的直接原因。
> 下面是为大陆网络环境重新设计并实测过的方案。

### 3.1 多源编排（`main/metadata/fetch.js`）

按优先级依次尝试，**任一源失败/超时都不阻塞其它源**，全部失败才退回骨架：

| 阶段 | 源 | 作用 | 超时 |
|---|---|---|---|
| 1 | 本地缓存 | 命中即用，**完全不联网**（同一张碟二次读盘秒开） | — |
| 2 | **MusicBrainz** | 按 TOC 指纹精确认碟（海外碟命中率最高） | 12s |
| 3 | **网易云音乐** | 华语主力源：专辑名/歌手/年份/流派/公司/**封面**/**逐轨 LRC** | 12s |
| 4 | **iTunes** | 英文碟兜底 | 8s |
| 5 | 骨架 | `轨道 N`，仍可播放、可手动编辑 | — |

- **封面候选顺序：网易云 → iTunes → Cover Art Archive**。
  Cover Art Archive（`coverartarchive.org` → `archive.org`）在大陆实测经常
  直接 TLS 重置，因此**降到兜底位**并给了更短的独立超时（3.5s），
  避免它把国内可达的网易云封面白白拖慢。
- **歌词候选顺序（逐字降级链，详见 §3.7）：AMLL TTML → 网易云 yrc → QQ QRC → 酷狗 KRC → 网易云 LRC → LRCLIB**，同一首歌多源都命中时按质量分取最优，不是"谁先成功用谁"。
- 网易云用的是 `api/v1/album/{id}` —— `api/album/{id}` 已加密，会返回 `code:-462`。

### 3.2 关键实测数据（为什么旧版"时灵时不灵"）

同一个 TOC 请求 MusicBrainz，`inc` 参数直接决定成败：

| `inc` 参数 | 响应体 | 耗时 | 结果 |
|---|---|---|---|
| `recordings` | 132 KB | **3.5s** | ✅ 含曲目名、歌手、年份 |
| `recordings+artist-credits+release-groups+genres`（旧版） | 483 KB | **24.7s** | ⚠️ 超出任何合理超时 |

**结论：不是 MusicBrainz 服务端慢，是响应体在跨国链路上传不完。**
现在只保留 `recordings`（它本身已包含 artist-credit 与 release 元信息），
整条链路从 **24~38s 降到 3~6s**，且稳定命中。
（另：MB 的 discid 接口对 POST 恒返回 400，旧版的"POST 兜底"是死路，已移除。）

### 3.3 首次读碟自动保存

1. 读盘就绪后**后台**发起抓取（不阻塞播放，`cd:land` 早已发出）；
2. 失败自动重试一次；
3. 结果立即落盘：`<userData>/metadata/{签名}.json` + `{签名}.jpg`
   （签名 = TOC 的 sha1 前 20 位）；
4. 换碟竞态保护：抓取期间若用户已换碟，结果作废，绝不写错碟的缓存。

### 3.4 华语 / 冷门 / 翻录碟

这类碟在 MusicBrainz 大多**没有对应 DiscID**，纯靠 TOC 查不到。
因此编辑面板内置了「**按关键词搜索**」：填专辑名/歌手后直接走网易云，
并带**时长吻合度校验**（`durationMatchRatio`）防止把 Deluxe / Live 版错认成原版。
当用户提供了关键词时，还会对 MusicBrainz 的结果做**交叉校验** ——
若 MB 认出的碟与关键词明显不符（实测会遇到 TOC 撞上无关发行的情况），
以用户输入为准，丢弃 MB 结果。

#### 3.4.1 ★ 为什么"专辑名/年份/曲目名拿到了，封面和歌词却没有"

这是一个真实踩过的坑，值得单独记下来，因为它解释了最常见的一类投诉。

**症状**：某张碟能显示专辑名、年份、每轨曲目名，但**封面空白、歌词显示"暂无歌词"、
艺术家一栏也是空的**。

**根因**：这三样东西（封面 / 歌词 / 艺术家）**都由网易云提供**，
而恰恰是网易云那一阶段被跳过了 —— 只跑了 MusicBrainz，所以只有它能给的字段是好的。

**为什么被跳过？** 旧实现把"曲目数一致"当成了匹配的硬门槛：

```js
// 旧逻辑（有问题）
const d = Math.abs(c.trackCount - want.trackCount);
if (d === 0) score += 6;
else if (d === 1) score += 2;
else score -= Math.min(d, 5);        // ← 差异大直接重罚
```

案例：一张**宇多田光精选集的分卷碟**，用户手里是 **5 轨**，
而网易云收录的是 **18 轨**完整版。名称、艺人全对，但 |18−5|=13 被罚 −5 分，
`pickAlbum` 低于可信门槛 → 返回 null → **网易云阶段整个跳过** →
封面、歌词、艺术家全部丢失。（同时 MusicBrainz 那边 CAA 封面源在国内又基本不可达。）

**修复**：把轨数的角色从「门槛」改成「加分项」。

- 专辑身份由 **名称 + 艺人** 确认，轨数一致只是佐证（+3），不一致**不再扣分**。
- 网易云的采用条件分三种：
  1. **MB 未命中** → 严格（轨数一致且时长吻合，或名称+艺人高度一致）；
  2. **MB 已命中** → 只要**专辑名吻合**就采信（用来补封面/歌词/艺人），
     不再要求艺人名逐字相同（日文碟常见 MB 罗马字 vs 网易云日文原名的差异）；
  3. 其它 → 拒绝。
- **曲目名是否覆盖**单独判断：轨数一致且时长吻合才整体采用；
  差异 ≤2 轨才尝试按时长逐轨对应；**差异更大时完全不碰**（保留 MB 的正确名字，
  避免把 18 首歌里时长最接近的名字错贴到第 1 轨）。

**顺带修掉的两个相关缺陷**：

| 缺陷 | 后果 | 修复 |
|---|---|---|
| `artistCreditName()` 只读 `part.name` | MB 的 artist-credit 有两种形态：`{name}`（已展开）与 `{artist:{name}}`（未展开）。遇到后者解析出空串 → **艺术家栏永久空白** | 两种形态都兼容 |
| 缓存有效性判定过松（`tracks.length > 0` 即命中） | 骨架数据也有曲目（"轨道 N"），于是一次失败抓取的**空壳会被写进缓存，此后这张碟永远命中空壳、再也不联网** | 要求缓存有实质内容（有专辑名 / 有来源 / 有 manual 标记）才算命中，空壳自动丢弃重抓 |

### 3.5 ★ 多碟专辑（碟号检测与精确匹配）

多碟专辑（双碟豪华版、box set、精选集分卷）是最容易出错的一类，值得单独说明。

#### 3.5.1 症状与根因

**症状**：一张 2 碟专辑，先放 disc2 抓取正常；再放 disc1，结果 **disc1 的前几首
歌词与曲目名和 disc2 完全一致**，剩下的却正常。

**根因**（两层）：

1. **CD 的 TOC 里根本没有碟号**。这是物理格式的限制 —— TOC 只描述"这张碟有几轨、
   每轨从哪个扇区开始"，无法说明"这是某专辑的第 2 张碟"。旧实现因此完全忽略碟号。
2. **在线源把多碟压成了一个扁平数组**。网易云的专辑详情 `songs[]` 把各碟的歌混在
   一起，每首歌的 `no` 是**碟内轨号**（disc1 与 disc2 都各有一套 1..N），
   碟号另存在 `cd` 字段里 —— 而旧实现只读 `no`、丢掉 `cd`。
   于是内部 `number` 相同的曲目互相覆盖（Map 后写入的 disc2 覆盖 disc1），
   disc1 按轨号匹配时拿到的全是 disc2 的歌名与歌词。

#### 3.5.2 修复方案

| 环节 | 做法 |
|---|---|
| **网易云** `getAlbum` | 解析每首歌的 `cd` 字段为 `discNumber`，轨号仍用碟内 `no`；另给出 `discTotal`（`cd` 最大值）。缺失 `cd` 时按"轨号回落"（1 之后又出现 1）推断换碟 |
| **MusicBrainz** `pickBestRelease` / `lookupByToc` | 多碟发行的 `media[]` 每个元素就是一张碟，其 `position` 即碟号。接受 `discHint` 后优先选 `position === hint` 的 medium；并把 `mediums` 列表带出，用 `discTotal = media.length` |
| **编排层** `fetchDiscMetadata` | 先由 `inferDiscNumber` 定下本碟碟号（优先级：用户 hint > 缓存记录 > 默认 1），再用 `filterTracksByDisc` / `netease.tracksOfDisc` **先切碟、再按轨号匹配** |
| **歌词挂接** `attachLyrics` | 用**本碟子集**建 `轨号 → songId` 映射，杜绝各碟 1..N 互相覆盖（这正是"disc1 前五首歌词 = disc2"的直接成因） |
| **持久化** `schema.js` | 新增专辑级 `discNumber`/`discTotal` 与轨级 `discNumber`；碟号非法值一律兜底为 1 |
| **编辑面板** `edit.js` | 新增「碟号 / 碟总数」字段，**默认填检测值、可手动修改**；"重新获取"与"按关键词搜索"都会把当前碟号作为 hint 传下去 |
| **音乐库** `library.js` | 多碟专辑（`discTotal > 1` 或碟号 > 1）在封面**右下角**显示 `D1/2` 角标；手动改过碟号的用强调色标注；单碟专辑不显示 |

#### 3.5.3 用户如何自救

若某张碟仍对错了碟（例如在线源没标碟号），只需：

1. 右键音乐库卡片 →「编辑信息」，把**碟号**改成正确的值；
2. 点「**按关键词搜索**」（或「重新获取在线信息」）——
   软件会按新碟号重新切分曲目与歌词，一次修好；
3. 保存的碟号会写入本地，之后重抓也会沿用（缓存碟号参与推断）。

> 测试覆盖：`tests/metadata.test.js` 的 #18–#26 专门验证碟号抽取、
> 按碟切分、disc1/disc2 端到端不串味，以及**对照用例**（不切碟会复现原 bug）。

### 3.6 其它

- 需要联网；**不需要任何 API Key**。
- 未知碟返回骨架（"轨道 N"），依然可播放、可手动编辑。
- **手动编辑**（编辑面板）会打上 `manual` 标记，之后的在线刷新不会覆盖手动内容。
- MusicBrainz 要求标识 UA 与 ≤1 req/s，`http.js` 里已做 per-host 限速
  （基于时间戳计算，避免等待量线性累积）。打包前请把 `DEFAULT_UA` 改成你的联系方式。

### 3.7 逐字歌词：六源降级链与统一模型

旧版只有一个歌词源（LRCLIB，行级 LRC）。现在做的是**逐字（word-by-word）歌词**：
每个词带自己的起止时间，播放时逐词填充发光，同时保留译文、罗马音、对唱、间奏信息。
歌词格式的完整技术笔记（各源格式细节 / 解析器坑 / 测试注入术）见
[`docs/lyrics-design.md`](lyrics-design.md)，这里只说设计。

#### 3.7.1 六个源与质量分

| 优先级 | 源 | 格式 | 词级 | 译文 | 罗马音 | 对唱 |
|---|---|---|---|---|---|---|
| 1 | **AMLL**（[amlldb](https://github.com/Steve-xmh/amll-ttml-db)） | TTML | ✅ | ✅ | ✅ | ✅（x-bg） |
| 2 | **网易云音乐** | yrc | ✅ | ✅ | ✅ | ❌ |
| 3 | **QQ 音乐** | QRC | ✅ | ✅ | ❌ | ❌ |
| 4 | **酷狗音乐** | KRC | ✅ | ✅（内嵌 language 轨） | ✅（内嵌） | ❌ |
| 5 | **网易云音乐** | LRC | ❌ | ✅（译文行） | ❌ | ❌ |
| 6 | **LRCLIB** | LRC | ❌ | ❌ | ❌ | ❌ |

**质量分**（`lyrics-model.js` 的 `qualityOf`）：词级打底 100，译文 +10、罗马音 +5、对唱 +5、背景人声 +5。
同一首歌**所有源都跑完再挑最高分**，不是谁先成功用谁 —— 先成功的往往是低级源，
它会挡住后面质量更高的源。所以三个源是**并发**发的（`fetch.js` 的 `attachLyrics`），
整体套一个 deadline（`STAGE_TIMEOUT.lyrics`），超时不再开新的请求。

**酷狗是两段式链路**（v6 重做）：`lyrics.kugou.com/search?keyword=…` 自 2026-11 起
对任何关键词恒返回 404，旧入口整个死了。现行配方：`songsearch.kugou.com`
拿 `FileHash` → `krcs.kugou.com/search?hash=…` 直查候选（官方推荐打头，
实测 10~20 个版本）→ 逐个顺延下载 KRC（封顶 3 个）+ LRC 兜底（封顶 2）。
真实抽查 6/6 首华语/日语/英文歌拿到逐字，单首 330~730ms。

#### 3.7.2 统一歌词模型

六个源五种格式，全部收敛到同一个模型再进缓存（`schema.js` 的 `lyricsDataModel` 白名单重建，
脏数据直接返回 null，不会把缓存写坏）：

```js
{ v: 1, source: 'amll'|'netease'|'qq'|'kugou'|'lrclib', isWordByWord: true,
  agents: ['歌手A', '歌手B'],                    // 对唱角色（TTML ttm:agent）
  lines: [{ t, e, text, tr, ro, agent,          // 起止秒 / 行文本 / 译文 / 罗马音 / 角色
            words: [{ t, e, x }],               // 词级时间轴（起止秒 + 词文本）
            bg: [{ t, e, text, tr, ro, words }],// 对唱/背景人声（时间重叠的折叠行，词级独立）
            instrumental: true }],              // 间奏（相邻行空隙 > 8s 推断）
  quality: 130 }
```

- **间奏**没有源会显式给出，按"相邻行空隙 > 8 秒"推断出 `{text:'♪', instrumental:true}` 行。
- **对唱**：TTML 里时间重叠的不同 `ttm:agent` 行，折进主行的 `bg` 数组，主界面在主行下方以小字显示。
- **译文/罗马音**是行级挂接（`tr` / `ro`），x-bg 里嵌的子级译/音轨分离到 `bgEntry.tr/ro`，不混进人声文本。

#### 3.7.3 匹配纪律（宁可没歌词，不可给错歌词）

- **有 `neteaseSongId` / `qqMid` 绝不搜索**——专辑曲目表给的精确 ID 没有匹配歧义，
  搜索反而可能命中同名的另一首歌。
- 搜索候选必须**标题命中**且（歌手命中或时长差 ≤3s），否则拒收。
- **单行歌词视为脏数据拒收**（下载到半截 / 接口返回错误页的典型形态），
  精确 ID 源放行——它没有匹配歧义，单行也只能是这首歌确实只有一句。
- 全部源失败返回 `null`，界面显示"暂无歌词"，**不抛异常、不卡播放**。

#### 3.7.4 如何验证：日志判读与冒烟工具

**"为什么我这张碟还是 LRC？"** —— 三个前提、一处日志、一个工具，按顺序查。

**前提 1：确认跑的是新包。** 源码里应同时存在这两个文件（旧版没有）：

```
main/metadata/lyrics-model.js     # 统一歌词模型（六源解析器的公共出口）
renderer/js/lyrics-view.js        # 主界面逐字渲染
```

**前提 2：清掉旧缓存。** 元数据缓存落在 `<userData>/metadata/<signature>.json`，
里面带 `lyricsData` 字段。在音乐库右键"删除碟片信息"删的就是它；
直接删文件也一样（应用重启后重新读碟即重新抓取）。
**只重插碟不清缓存是不会重新抓歌词的**——缓存命中时整条降级链根本不跑。

**前提 3：看日志。** `main/index.js` 的 Logger 把降级链的每一步写进
`debug.log`（`<userData>/debug.log`），每行带时间戳。歌词相关行一律以 `lyrics[` 开头：

| 日志行 | 含义 | 界面结果 |
|---|---|---|
| `lyrics[匆匆那年] amll 逐字 32行 质量103` | AMLL 命中，**词级时间轴** | 逐字渲染 |
| `lyrics[演员] netease 逐字 47行 质量105 译/对唱` | 网易云 yrc 命中，带译文+对唱 | 逐字渲染 + 译/对唱小字 |
| `lyrics[Lemon] netease 行级 47行 质量15 译` | 只有 LRC（设计内降级） | 经典逐行渲染 |
| `lyrics[小星星变奏曲] 六源均未命中（可能未收录或网络不可达）` | 六个源都没数据 | "暂无歌词" |
| `lyrics[amll] 失败：timeout` | 该源**连不上**（超时/网络错），已继续尝试后续源 | 取决于其它源 |

行尾的 `质量` 是 §3.7.1 的质量分（词级 100 起，译/音/对唱/间奏加分），
**多源都命中时日志里只报最终胜出的那个**（同分取先到者）。
"连不上"（`失败：`）与"没收录"（静默跳过）在日志里可区分——
前者是网络问题，后者是这首歌确实没有逐字数据。

**冒烟工具：不装 Electron、不开光驱验证降级链。**

```
node tools/lyrics-smoke.js --title "匆匆那年" --artist "王菲" --duration 415
node tools/lyrics-smoke.js --netease-id 260140        # 已知平台 ID（等价精确 ID 路径）
node tools/lyrics-smoke.js --preset                   # 内置试样集（华语/日语/欧美/边界）
node tools/lyrics-smoke.js --preset --tag zh,en       # 试样集按 tag 挑
```

它 `require` 的就是应用内的 `fetchLyricsRich` 本体（非 mock），
输出与 `debug.log` 同格式：命中源、逐字/行级、行数、质量分、译/音/对唱标记、
前几行的词级时间预览、耗时。**它说什么，应用里就是什么。**

**逐字覆盖规律（实测参照，非缺陷）**：华语/日语流行曲在 AMLL/网易云 yrc 收录好，
基本都能逐字；欧美碟常退到行级 LRC（设计内降级，见试样集汇总行）；
古典乐、现场版、冷门专辑六个源都可能没有——这时显示"暂无歌词"是正确行为。

**仍显示 LRC 时的排查清单**：① 日志里有没有 `lyrics[` 行？没有 → 缓存命中或
压根没进歌词阶段（看 `metadata` 相关行）；有 → 看它报的是哪一级。② 报的是
`netease 行级`？这首歌确实没有 yrc。③ 报 `失败：timeout`？网络问题，
换网络环境或稍后再试。④ 什么都没报但界面是 LRC？检查是否跑的旧包（前提 1）。

#### 3.7.5 歌词源管理：全收集、手动选源、TTML 粘贴

降级链默认按质量分取最优（`fetchLyricsRich`，命中即返回）。**编辑面板**需要看到
"这张盘到底抓到了几份歌词"，因此主进程另有全收集入口
`fetchLyricsRichAll`：**六个源全部跑完**，所有候选按质量降序存入轨道的
`lyricsSources` 字段（最多 8 份，网易云 yrc 与 lrc 算两份不同候选），
胜出者仍进 `lyricsData`。单发入口行为不变（旧调用方无感）。

**编辑面板 → 展开某一轨 → 「歌词来源」区**（`renderer/js/edit.js` + `main/metadata/lyrics-select.js`）：

| 操作 | 行为 |
|---|---|
| 点某一行 | 启用该源（IPC `lyrics:select-source`），模型→LRC 转换只在主进程做，播放页歌词视图即时跟着换 |
| 「删」（仅手动源） | 删掉自己粘贴的 TTML（IPC `lyrics:remove-source`）；删的正是当前项时自动回退到剩余里质量最高的。**在线抓来的候选不给删**——下回抓取还会有，不想要选别的即可 |
| 「打开 AMLL TTML Tool ↗」 | 浏览器打开 <https://amll-ttml-tool.stevexmh.net/>（打轴工具），打好轴导出 .ttml 后把全文粘进下方文本框 |
| 「保存 TTML 歌词」 | IPC `lyrics:add-ttml`：解析→白名单重建→打 `ttml-manual` 标记→入候选列并启用。同一份重复粘贴按内容指纹去重（替换而非堆叠） |
| LRC 文本框 | 经典手动编辑。**改动即丢弃该轨的结构化歌词与候选列表**（否则统一模型仍按词级渲染，用户的修改"看起来没生效"）；没碰歌词的轨原样带回 `lyricsData`/`lyricsSources` |

> **manual 快照修复（真 bug）**：`meta:save` 原写 `manual: true`（布尔），
> 而刷新时的 `_applyManualOverrides` 要求 `manual` 是对象——"已编辑"徽章承诺的
> "在线刷新不会覆盖"从未生效。现在存编辑内容快照（含歌词模型与候选列表），
> 选源/贴 TTML 后也会刷新快照。

> **preload 白名单漏通道（真 bug，v8 修）**：`lyrics:select-source` 等三个通道
> 在 `ipc.js` 有注册，但 `preload.js` 的 `INVOKE_CHANNELS` 白名单漏了它们——
> 渲染端 invoke 被 preload 直接拒掉（"未知通道"），而渲染端旧的
> `.catch(() => null)` 把原因吞了，用户侧只看到恒失败的"未知错误"。
> 同类漏网还有 `app:open-external`（AMLL 工具按钮）。现由
> `tests/ui-contract.test.js` 的**契约测试**盯防：ipcMain.handle 注册的每个
> invoke 通道都必须出现在白名单里，漏一个测试就红。

**翻译开关与字号**：歌词视图的「译 / 音」按钮按模型有无译文/罗马音轨**自动显隐**
（`nowplaying.js` 的 `applyLyricToggles`——没有译文的歌词不显示开关）；
字号在**设置 → 歌词与唱片大小 →「翻译」**滑条（`trScale`，0.6~1.8，默认 1），
只作用于译文小字（`.lrc-tr` 乘 `--lyric-tr-scale`），不牵连主字号。

**逐字播放页面右移已修复**：根因是 `.np-lyrics` 只有 `overflow-y: auto`
（`overflow-x` 被计算成 auto），鼓点缩放（`scale 1.11 + translateX ±4px`）与
激活行 150% 宽的光晕把歌词区撑出**隐藏的横向滚动区**——长句播放时整页看着往右跑。
现已显式 `overflow-x: hidden` + `.lrc-line { overflow-wrap: anywhere }`
（`tests/ui-contract.test.js` 锁回归）。

## 三·五、Windows 系统媒体控件（SMTC）适配

**需求**：按下键盘媒体键、或鼠标悬停任务栏音量图标时，Windows 弹出的媒体控件要显示**正在播放的歌曲名与专辑封面**。

**实现方式：不写任何原生代码。**
Electron 22 = Chromium 108，在 Windows 10/11 上 Chromium 会把渲染进程的
`navigator.mediaSession`（Media Session API）**自动桥接**到系统 SMTC。
因此只需在渲染端正确驱动这套 Web API，系统弹窗、锁屏界面、键盘媒体键即可全部生效。
（Chromium 于 M90 前后补齐了 SMTC 元数据/封面支持，Electron 22 远高于该版本。）

> ⚠ **重要前提（第一版遗漏，v7.1 修复）**：仅调用 `mediaSession` API **是不够的**。
> Chromium 只为「**页面上真正在播放 `<audio>`/`<video>` 元素**」注册 SMTC 会话；
> 若页面里没有任何媒体元素在播放，`metadata` 与 `playbackState` 会被**静默忽略**
> （`playbackState` 恒为 `'none'`），系统弹窗里根本看不到本应用。
> 详见下文"静音锚定音频"。

**新增模块：`renderer/js/smtc.js`**

| 能力 | 对应 API |
|---|---|
| 歌曲名 / 歌手 / 专辑 | `navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork })` |
| 专辑封面 | `MediaMetadata.artwork = [{ src, sizes, type }]` |
| 播放 / 暂停 / 停止状态 | `navigator.mediaSession.playbackState` |
| 弹窗进度条 | `navigator.mediaSession.setPositionState({ duration, playbackRate, position })` |
| 媒体键控制 | `navigator.mediaSession.setActionHandler(action, fn)` |

### 静音锚定音频（silent anchor）★ 关键

本播放器的声音**不走 `<audio>`**：

| 引擎 | 出声方式 | 对 Chromium 而言 |
|---|---|---|
| MCI | Windows `mciSendString` 直接输出 | 页面"一片寂静"，**不注册 SMTC 会话** |
| RAW | WebAudio 播 PCM | 纯 AudioContext 不做 SMTC 桥接 |
| Demo | 合成音频 | 接近标准媒体播放 |

因此在 MCI / RAW 路径下，只设 `mediaSession.metadata` 会**完全无效**——
这正是"SMTC 没生效"的根因（Chromium issue 40619497 / 944538、
Howler.js issue #1661 均有相同记录）。

**解法**：在页面里放一个隐藏的 `<audio>`（`renderer/js/smtc.js` 的 `ensureAnchor()`），
循环播放一段**运行时生成的无声音频**（`makeSilentUrl()`，WAV，16bit/单声道/8kHz，Blob URL）：

- 播放时让它 `play()`，暂停/停止/出舱时让它 `pause()`，用它**占住 SMTC 会话**；
- **真正的静音来自"内容本身无声"，而不是 `muted` 属性**——`muted` 的元素
  Chromium 不会授予音频焦点，同样不激活 SMTC；
- 实际声音仍由 MCI / WebAudio 原样输出，两者互不干扰。

配套改动：`renderer/index.html` 的 CSP 增加 **`media-src 'self' blob: data:`**
（否则 blob 音频源会被 CSP 拦截，锚定失效 → SMTC 依然不出现）。

**开销说明（可放心）**：静音锚定音频对**音质零影响**——它与音乐走两条独立通道
（音乐走 MCI/WebAudio，它只是一段 **全 0 采样**的 8kHz 单声道流，不参与音乐的数据通路），
叠加到输出上等价于加 0。性能上它只有约 16 KB 内存、一个几乎不耗 CPU 的循环缓冲，
且仅在播放中存在（暂停/停止/出舱即 `pause()`，开销归零），不落盘、不联网。

### 设置开关：系统媒体控件（SMTC）

设置面板提供「**系统媒体控件**」开关（`settings.json` 的 `smtcEnabled`，**默认开启**）。

- **开启**（默认）：系统媒体弹窗 / 键盘媒体键显示歌曲名与封面。
- **关闭**：立刻清空系统媒体控件，并**完全不再创建 / 启停静音锚定音频**（彻底停用、零开销）；
  此后所有 SMTC 推送变为空操作。**不影响播放与音质**。

开关即时生效（无需重启）：`Smtc.setEnabled(bool)` → `Smtc.clear()` 释放锚点；
重新开启时再由 `App.setSmtcEnabled()` 调 `syncSmtc()` 按当前播放态恢复。

**两个必须处理的坑（本模块已专门解决）：**

1. **封面来源必须是浏览器可抓取的 URL。**
   本项目封面走自定义协议 `cover://<signature>/`，SMTC / Chromium **不接受自定义协议**。
   `smtc.js` 里用 `fetch(cover://…)` → `Blob` → `FileReader.readAsDataURL()` 转成 **data URL** 再交给 SMTC。
   为此做了两处配套改动：
   - `main/index.js`：`cover` 协议注册时已带 `supportFetchAPI: true`（无需改动，本次沿用）；
   - `renderer/index.html` 的 CSP：`connect-src` 追加 `cover:`，`img-src` 追加 `blob:`（允许渲染端 fetch 该协议）。
   - 封面按 CD 签名缓存（`state.coverDataUrl`），同一张碟切歌不会重复抓取。

2. **媒体键回调必须在同一事件循环内同步切换 `playbackState`。**
   Chromium 规定：系统点"播放/暂停"后，若回调里同步把 `playbackState` 改成对应值才算成功，
   异步稍后才改会被判为失败（系统弹窗状态卡住）。因此 `smtc.js` 的 handler 里
   **先**同步置 `playbackState`，**再**异步调用 `App.togglePlay()` 等真正的控制函数。

**接入点（`renderer/js/app.js` 的 `syncSmtc()`）** 覆盖全生命周期：

| 时机 | 行为 |
|---|---|
| 元数据到达（`onMetadata`） | 写入歌曲名 / 歌手 / 专辑 / 封面 |
| 权威状态变化（`onState`） | 同步曲目、播放状态、进度 |
| 切轨（`playTrack`） | 立即刷新歌曲名与封面 |
| 暂停 / 续播（`togglePlay`） | 同步 `playbackState` |
| 播完停止（`stopAll`） | 置 `playbackState=none` |
| 出舱 / 无碟（`onPhase` 的 `eject` / `idle`） | `Smtc.clear()` 清空系统控件 |
| 心跳（`tickLoop`，约 1s 一次） | 刷新系统弹窗进度条 |

**媒体键映射**：`play` / `pause` → `App.togglePlay()`；`previoustrack` → `App.prev()`；
`nexttrack` → `App.next()`；`stop` → `App.stop()`；
`seekbackward` / `seekforward` / `seekto` → `App.seekBy()` / `App.seekTo()`。

**多碟专辑**：专辑名会自动附加 `· DISC n` 与 `· 当前曲/总数`（如 `某专辑 · DISC 2 · 3/12`），
与音乐库卡片上的 `D1/2` 角标相呼应，便于在系统弹窗里认出是哪张碟。

### 排查：SMTC 是否真的生效了

渲染端会把 SMTC 的关键动作写进主进程的诊断日志
（`%APPDATA%\ShiGuangCD\debug.log`，行首带 `[renderer] [smtc]`）。
播放一张碟后打开该日志，正常应能看到：

```
[renderer] [smtc] bindActions: mediaSession 可用，开始挂载媒体键处理
[renderer] [smtc] anchor: created, src=blob:file:///...
[renderer] [smtc] anchor: playing（SMTC 会话应已激活）
[renderer] [smtc] metadata -> title=xxx | artist=xxx | artwork=yes
```

对照排查：

| 日志现象 | 含义 / 处理 |
|---|---|
| 完全没有 `[smtc]` 行 | `smtc.js` 未加载（检查 `index.html` 的 `<script>` 顺序） |
| `不支持 mediaSession` | 系统/内核不支持（Win7 属正常） |
| 有 `anchor: created` 但**没有** `anchor: playing` | 静音音频未能起播——多半是 CSP 拦了 `blob:`（确认 `media-src` 含 `blob:`）或自动播放被拦 |
| `anchor: play() 被拒` | 自动播放策略拦截；确认主进程 `autoplay-policy=no-user-gesture-required` 生效 |
| 有 `anchor: playing` 但系统弹窗仍无本应用 | 系统媒体控件被其它播放器占用/遮挡；按 Win+G 或点任务栏音量图标查看 |

### 诊断日志的量（必须可控）

`debug.log` 是**只追加、没有任何轮转**的，而且每行都是同步 `appendFileSync`。
渲染端所有诊断都经 `app:log` → `logger.w()` 这一个出口，所以量由调用方自己克制：

- ⚠ ★ **"正常但会反复发生"的消息一律用 `diagOnce(key, msg)`**。
  典型就是 `anchor: playing`：锚定音频是一段 **1 秒**静音 WAV + `loop`，
  Chromium 在**每次循环重播**时都会再派发一次 `playing`（元素从 `ended` 回到播放态）——
  也就是每秒一条、每天 86400 条，而且每条还要跨进程一次同步 IPC。
  这条消息只是"会话已激活"的一次性确认，记一次就够。
  同理适用于"持续失败"的状态：`makeSilentUrl` 失败 / `create` 失败 / `play()` 被拒 ——
  它们失败后每次调用都会重试，不去重就是刷屏。key 里带上 message，不同原因各记一次。
- ★ **真正罕见、每次都值得看的异常继续用 `diag()`**：`anchor audio error`、
  `metadata 写入失败`。
- ★ `metadata ->` 只在**元数据真的变了**时记（`state.lastMetaKey` 是单项缓存），
  所以是每首歌一条。循环播放同一张碟时来回切歌会重复记，这是对的 ——
  每次换歌都必须重新写 `navigator.mediaSession.metadata`，那些行不是刷屏。
- ★ 兜底：`logger` 每次启动清空文件，且单次运行超过 **8MB** 就截断
  （每 200 行才 `statSync` 一次，不给每行都加一次系统调用）。
  用户挂机一周也不至于把日志堆到几十 MB。宁可丢历史，也不要写满磁盘。

> 兼容性说明：本适配仅依赖标准 Web API，**在 Windows 10/11 上生效**；
> Windows 7 上没有可用的 SMTC 桥接，模块会自动静默降级（`Smtc.supported === false`），
> 不影响播放功能，也不需要任何额外依赖。

## 三·六、播放位置精度（暂停 / 续播 / 定位 / 歌词同步）★

这一节解释一个曾经"怎么修都修不好"的问题：**暂停后再播放，进度会比暂停时快几秒；
按暂停键会迟钝一小段时间；LRC 歌词在暂停或快进后整体跑偏。**

三个症状其实是**同一个结构性缺陷**的不同表现：**两套互不同步的时钟从不做硬对齐。**
MCI 播放路径下，声音由 Windows 声卡直接输出：

- **MCI 内部时钟** —— 设备真正播到了哪一帧（唯一权威，只能用 `status cd position` 问它）；
- **应用墙钟** —— `main/cd/mci-player.js` 与 `main/cd/cd-service.js` 各自的"锚点 + 已过毫秒"推算。

旧实现让这两套时钟各走各的，并且只在偏差超过 **0.45 秒**时才做一次校正——
于是小偏差永远不被纠正，每一轮"暂停 → 播放"就把新的偏差叠加上去。

### 关键机制：命令返回后必须"回读"

`mciSendStringW` 是**同步阻塞调用**（`main/native.js`）。执行 `pause cd` 期间，
MCI 还会再往前播一点点（几十到几百毫秒）。旧代码是**在发命令之前**量一次本地时钟，
然后把它当作暂停点 —— 这个值系统性超前于设备真正停下的位置，且**从不回读核实**。

修复后的规则：**凡是能让设备改变位置的命令（`play` / `pause` / 定位），
命令返回后一律回读 `status cd position`，并用回读值硬对齐本地时钟（无死区）。**

| 动作 | 旧实现 | 现在 |
|---|---|---|
| 暂停 | 命令**前**量本地时钟，不回读；`_pausedSec` 从不写入 | 先冻结时钟 → 发 `pause cd` → **回读真实落点**作为暂停点，写入 `_pausedSec` |
| 续播 | `resume cd`（MCI 从**它自己**的内部位置继续），锚点却钉在应用时钟上 → 两套基准，误差累积 | `play cd from <暂停点> to <轨末>` **物理重起**，起播位置完全由应用决定；之后回读校验落点 |
| 定位 | 直接信任请求值 | 回读驱动**实际落点**（驱动会把帧贴到扇区边界），用它定锚 |
| 起播 | 不回读 | 回读一次；与请求值差 > 0.3s 即对齐本地时钟 |
| 轮询校正死区 | `mci-player` 0.45s / `cd-service` 0.45s / 渲染端 0.8s | `mci-player` **0.15s** / `cd-service` **0.15s** / 渲染端 **0.3s** |

### 权威来源按引擎分流

这是取舍的核心 —— **两种引擎的"真实听感位置"在完全不同的地方**：

| 引擎 | 声音从哪来 | 谁是权威 | 为什么 |
|---|---|---|---|
| `raw` | 渲染端 WebAudio 解码播出 | **渲染端**上报的 `sec` | 渲染端握着 AudioContext 调度队列；主进程的已读游标最多超前一个 5 秒预读缓冲 |
| `mci` | **Windows 声卡直接输出** | **播放器回读的设备位置** | 渲染端没有任何本地音频，它给的墙钟只是估计值（还会超前） |

旧实现不分引擎、一律采信渲染端上报值 —— 在 MCI 上等于用估计值覆盖真实回读值。
`renderer/js/app.js` 的 `audibleSec()` 现在在 MCI 路径优先采用主进程轮询回读的设备位置。

### 暂停为什么"迟钝"

渲染端 `togglePlay()` 只对 `AudioEngine`/`DemoAudio` 能"当帧静音"；MCI 路径下
`App.engine` 为 `null`，真正让声音停下的是主进程那条**同步阻塞**的 `pause cd`。
旧实现要等它返回才广播 `cd:state`，界面与系统媒体控件就慢了半拍。

现在 `cd-service.pause()` **先**把状态切到 `paused` 并立即广播一次 `cd:state`
（`reason: 'pause'`），**再**执行暂停命令，命令返回后用回读到的精确位置
**补发一次**（`reason: 'pause-synced'`）。界面立刻响应，数字随后收敛到准确值。

### LRC 歌词为什么跟着好了

`renderer/js/nowplaying.js` 的歌词高亮完全由 `Transport.positionSec()` 驱动
（`tick(posSec) → highlight(posSec)`，按 `[mm:ss.xx]` 命中行）。
**歌词是位置的下游消费者** —— 位置偏几秒，命中行就整体错位。位置修好，歌词自然对齐，
因此这个文件一行未改。

### 设备不支持回读时怎么办

部分**虚拟光驱**不支持 `status cd position`。此时 `_readMciRelSec()` 返回 `null`，
所有回读路径 **静默回退**到原有的本地时钟语义，并写一行诊断日志
（`mci: status cd position unavailable -> fall back to local clock`）。
**不抛异常、不阻塞、不影响播放** —— 只是退回到修复前的精度。

## 三·七、暂停为什么"点了还响一会儿"（已修）

现象：点暂停后声音还要再响一秒左右，暂停点也偏后。

原因在 `renderer/js/app.js` 的 `togglePlay()` 暂停分支里**两行的顺序**：
代码注释写的是"先让引擎立刻暂停，再改界面状态"，但实际调用的是
`syncEngineToTransport()` —— 那个函数是**根据 `Transport.status` 决定引擎该做什么**的，
而此刻 `Transport.status` 还是 `'playing'`，于是它走的是 `play()` / `resume()` 分支：
引擎继续播放、预读缓冲留在队列里（`AudioEngine.feed()` 的"丢弃在途块"也因此不生效）。

修复：暂停分支直接调用引擎的 `pause()`（当帧静音 + 丢弃预读 + 冻结上下文），
再改 `Transport` 状态；位置仍取"耳朵听到的那一秒"，语义不变。

`tests/renderer.test.js` 的 `#19b` 就是这条的回归用例（"暂停态不再入队 / 引擎已进入 paused"）。

## 四、界面（第六、八条需求）

### 4.1 页面结构

- **音乐库主页**：专辑卡片网格（封面 / 专辑名 / 艺术家 / 年份·曲目数；多碟专辑的封面右下角带 `D1/2` 碟号角标），点击非当前碟会提示"请放入这张光盘"，放入后自动开播；点击当前碟直接播放。
- **正在播放页 = 自动隐藏标签页 + 常驻传输条**
  - 顶部**标签切换器**：`唱片` / `歌词` / `曲目` 三个标签页共用一块舞台，切换只换内容、不重建 DOM（切页不丢进度条与歌词滚动位置）。
  - 标签栏**可自动隐藏**：静止 2.6s 后淡出（顶部只留一条细提示线），鼠标靠近 250px 内即淡入；设置里的「标签栏自动隐藏」关掉后常驻显示。
  - 底部**传输条常驻**，两行栅格：
    - 第一行 `[迷你碟 + 歌名] … [上一曲 播放 下一曲] … [音量 + 沉浸]` 用 `1fr auto 1fr`：中间一列按内容定宽、两侧等分，**任何窗口宽度（含全屏）下主控都严格居中**。
    - 第二行 `[ 进度条 … 播放模式 · 并行 · 编辑信息 · 出舱 ]`。
  - 迷你唱片在任何标签页下都随播放状态旋转。
  - 播放命令一律仍走原有通道（`cd:play-track` / `cd:pause` / `cd:resume` / `cd:seek` …），界面重构没有改动任何播放语义。

### 4.1.1 封面与歌词并排（并行视图）

- 传输条第二行的「并行」按钮（或设置里的同名开关）在**标签页**与**并排**两种视图间切换。
- 并排时舞台用 `flex-basis: 0` + `flex-grow` 分空间：唱片与歌词各占一半，未激活的标签页宽度为 0，切换靠 `flex-grow` 过渡，**不需要两套布局**。
- 标签栏同步"合二为一"：并排时 `唱片` / `歌词` 两个标签的 `max-width / padding / opacity` 收到 0，中间浮出合并按钮「唱片 + 歌词」（`.np-tab` 上挂了对应过渡，所以是动画而不是跳变）。
- **并行时也能自由切标签**：布局偏好（并行）与"看哪一块"（标签）是两件事。
  并行状态下点「曲目」直接看曲目表，并行偏好原样保留；再点浮出的「唱片 + 歌词」胶囊回到并排；
  在并排状态下点同一颗胶囊才是"退出并行"。标签栏的高亮也按这套语义（互斥）刷新。

### 4.1.2 歌词的手动浏览

- **点击某行 → 跳转到该行时间**（`App.seek(t)`）。用 pointerdown/up 的位移（>6px）与按住时长（>600ms）区分"点击"与"拖动滚动"，拖动不会误触发跳转。
- **浏览态**：滚轮 / 触摸 / 按下滚动条即进入，停止操作 4.2s 后自动回到跟随播放进度。
  - **所有行回到同一个字号**（19px，当前行不再额外放大），景深压到很浅、去掉了鼓点缩放 —— 看歌词时字不会忽大忽小。
  - **鼠标放大镜**：浏览态下鼠标附近的歌词行按距离放大（半径 150px，`scale(1 + --mz × 0.16)`），方便读小字；离开即复位。
  - 浏览态期间不抢滚动位置；退出时重新把当前行对到中间，并自动恢复 3D + 鼓点样式。

### 4.1.3 切换标签后歌词要"回正"

症状：从「唱片」切到「歌词」时，当前行经常偏在下方，看到的全是还没播到的行 —— 而且这些行因为离当前行远，3D 后撤让它们显得很小。

根因：标签切换 / 并行切换是**宽度动画**。歌词页在宽度 0 的那几百毫秒里，歌词行是按"极窄的换行结果"排版的，`offsetTop` 完全是错的；而只换行才触发的 `highlight()` 在"当前行没变"时直接返回，不会再纠正滚动位置，于是错误状态一直留着。

修复：加一个 `recenterUntil` 时间戳。切标签 / 切并行 / 退出浏览态 / 换碟歌词之后都调 `requestRecenter()`，在这段时间内每次 `tick()` 都重新量一次 `offsetTop` 并把当前行拉回中间；动画结束、宽度稳定后自然就对上了。`centerActiveLine()` 另外加了 `clientHeight < 20` 的保护（0 宽 0 高时量到的偏移没有意义）。
- `--mz` 每行一个、只在数值变化时写入，且几何位置（`offsetTop + 高度/2`）按需缓存，不在 `pointermove` 里反复触发布局。

### 4.1.4 沉浸模式

- 传输条右上角的按钮（或设置里的同名开关）。开启后：顶栏与传输条在鼠标静止 2.6s 后整体淡出（`translateY` + `opacity`），**两者都是绝对/独立定位，收起时其余组件的位置完全不变**（播放页、唱片、歌词、进度都不跳动）。
- 鼠标移向上下两条"驻留带"（播放页顶 150px / 底 190px）即重新现身；指针停在可见的顶栏或传输条上时不会收起。
- 打开设置 / 编辑面板等浮层时保持可见，避免找不到出口。状态存 `settings.json` 的 `immersiveMode`。
- ★ **静止时连鼠标指针一起隐藏**（`html.cursor-away`，与外壳退场同时发生）。此时屏幕上只剩唱片与歌词，留一个光标杵在画面中间很突兀，全屏播放时尤其明显。
  - ⚠ **光标必须与外壳分开控制**（`showCursor()`）：`onMove` 里只有"靠近驻留带"才会唤回外壳，在画面中间移动只是重新计时、外壳保持隐藏。若把光标挂在 `immersive-away` 上，用户在中间晃鼠标就会看到"鼠标明明在动、屏幕上却没有指针"。所以只要指针一动就先摘 `cursor-away`，外壳爱不爱回来是另一回事。
  - ⚠ CSS 写 `html.cursor-away, html.cursor-away * { cursor: none !important }`，不能只写 `html.cursor-away`：`cursor` 虽然继承，但项目里有 `* { cursor: default !important }` 和 `input, textarea { cursor: text !important }` 会顶掉继承值，指针移到输入框/按钮上又会冒出来。关闭沉浸模式时必须一并摘掉 `cursor-away`，否则光标一直消失而界面并非沉浸态。

### 4.1.5 音乐库两种风格

- **只在设置里切换**（`settings.json` 的 `libraryStyle`）：`grid`（原版网格）/ `flow`（CoverFlow）。
- CoverFlow 实现：横向滚动容器 + `perspective`，每项按"离视口中线的距离"写两个 CSS 变量：
  - `--pos` 钳在 ±1.15 → 旋转最多约 64°（与 CoverFlow 一致，不会转成看不见的侧面一条线）；
  - `--adist` 钳在 0~4 → Z 轴后撤、缩放、淡出。
  - 间距 `flowStep()` **从布局实测**（相邻两项的 `offsetLeft` 之差），CSS 里改宽度或全屏放大都不用同步改 JS 常量。
  - 左右留出半屏 padding（`calc(50% - var(--flow-item) / 2)`），第一张 / 最后一张也能滚到正中；进入视图时把当前在播的那张碟设为焦点并居中。
  - 每张封面带镜像倒影（`scaleY(-1)` + 向下淡出的 mask），焦点项加黄铜描边。
  - 几何测量走 `requestAnimationFrame` 节流，只在数值变化时写样式。
- **焦点导航**：滚轮（纵向或横向都算，累计 40px 挪一格）、`← / →`、`Home / End`、`Enter`。
  单击某张碟 = 先把它对到正中成为焦点，再走原来的单击逻辑（当前碟直接播、否则弹出"请放入这张光盘"）。
- 两种风格共用同一份卡片内容与同一套交互：单击 → 播放/提示插碟；右键 → 编辑信息 / 从音乐库移除。

### 4.1.6 播放页快捷键

| 按键 | 动作 |
| --- | --- |
| `空格` / `K` | 播放 · 暂停 |
| `←` / `→` | 上一曲 · 下一曲 |
| `↑` / `↓` | 音量 ±5% |
| `L` | 在「唱片 / 歌词」之间切换 |

生效条件：正在播放页、没有浮层打开、读盘场景未显示、光标不在输入框里。
音乐库 CoverFlow 页的 `← / → / Home / End / Enter` 归焦点导航（两套按键按当前页分流，互不干扰）。
列表写在设置面板的「快捷键」分组里。

### 4.1.7 全屏放大与可读性

- 尺寸统一走 CSS 变量：`--disc-base` / `--lyric-base` / `--lyric-active-base` / `--lyric-manual-base` 是各布局的**基准**，`--disc-scale` / `--lyric-scale` 是**用户缩放**。各处只改 base，所以设置里调一次，普通 / 并行 / 全屏 / 矮窗口全部等比跟随。
- 全屏（`html.is-fullscreen`，由主进程 `app:win-state` 驱动）：唱片 340→440px（并排 244→330px）、歌词 17→22px（当前行 21→28px）、曲名 14→16px、播放键 58→70px、CoverFlow 单项 `--flow-item` 224→300px。
- ⚠ ★★ **全屏/分屏相关的规则必须只作用于 `.on` 的面板**，否则会凭空偷走宽度：
  - 未激活的面板靠 `.np-panel:not(.on) { padding: 0 }`（优先级 **0,2,0**）收成 0 宽。
  - 但 `html.is-fullscreen .np-panel-lyrics { padding-left/right: 90px }` 是 **0,2,1**（只多一个元素选择器 `html`）→ 压过上面那条 → **隐藏**的歌词 / 曲目面板各被塞进 180px 内边距，两个合计从当前面板抢走 360px，唱片与歌曲信息整体左移（实测偏移 −180px）。
  - 同理 `#page-nowplaying.split .np-panel-lyrics { flex-grow: 1.15; padding: 0 26px }` 是 **1,2,0**，也压过 `:not(.on)` → 分屏模式下切到「曲目」时，没显示的歌词面板照样占 734px，把唱片面板挤到 681px。
  - 两处都已加 `.on` 限定。**新增全屏/分屏面板规则时一律带上 `.on`。**
- ⚠ ★ **标签栏（`.np-tab`）的尺寸只能走变量**（`--tab-pad-x / --tab-pad-y / --tab-fs`），不要在别处直接写它的 `padding` / `font-size`。原因同源：全屏规则带 `#page-nowplaying`（优先级 1,2,1）会盖掉收起态的 `padding: 0`，而 **padding 是盒宽度的硬下限**（`max-width: 0` 也压不下去），于是本该 0 宽的隐藏标签各占 52px，标签栏凭空多出 104px、可见标签被推偏。
- 播放页与歌词区不显示滚动条（`overflow` 保留，歌词居中与手动浏览都要用）：`#page-nowplaying { overflow: hidden }` + `.np-lyrics { scrollbar-width: none }`。
- 浅色主题遇到深色封面时可读性：主题底色字加深（`--text-dim: #554e43`）、歌词与曲目面板加 `--read-scrim` 压暗层（浅色主题 0.86，不透明度远高于深色主题）、曲目行自带 `--glass` 底色。

### 4.1.8 尺寸手动调整（设置面板）

设置 → 外观 → 「歌词与唱片大小」：歌词 70%–180%、唱片 60%–160%，旁边有实时百分比，另有「**恢复默认**」按钮一键回到 100%/100%（即当前这套配置）。
实现只写 `<html>` 上的两个 scale 变量，不重渲染任何 DOM，所以拖动滑杆是即时生效的。

### 4.1.9 桌面悬浮歌词（`main/floating.js` + `renderer/floating.html`）

开关在**传输条右上角、音量条左边**的那个小窗图标（`#np-floating`）；状态存在 `settings.json` 的 `floatingLyrics`，下次启动自动恢复。

- **独立窗口**：`frame:false` + `transparent:true` + `skipTaskbar` + `alwaysOnTop('screen-saver')`，默认落在主屏右下角，初始 760×132（之后完全由用户拖边缘决定）。**不透明的部分就是歌词底板 `#plate`，它铺满整个窗口。**
  - ★ 不要调 `setVisibleOnAllWorkspaces`：跨虚拟桌面的可见性会让合成器一直维护这个置顶透明层，是常驻性能开销的主要来源之一。
- **状态回传**：主进程把"是否开着 / 是否锁定"通过 `floating:state` 推回主窗口，所以在悬浮窗里用 ✕ 关掉后，传输条上的按钮状态也跟着变。
- ★ 窗口**移动**不占主进程任何逻辑，**只有缩放**才走 `float:resize*` 三个通道。整份 `main/floating.js` 里只有一处 `setBounds`，就在 `float:resize` 内 —— 出现"窗口自己变大"时，先确认是不是走到了这一处。
- **窗口 == 黑色底板**：底板 `#plate` 是 `position:absolute; inset:0`，铺满整个窗口。所以"窗口比歌词容器大一圈、点透明处也在操作歌词界面"这个老问题从根上不存在 —— 两者本来就是同一个矩形。
  - ★ 窗口尺寸**完全由用户决定**，程序不再改：**拖四个角的小把手**（`.grip-nw/ne/sw/se`）缩放。几何停在 400ms 后（或松手时）落盘到 `floatingW/H/X/Y`。
  - ★★ **`resizable` 必须 `false`**。开着它，Windows 会给无边框窗口套一圈**看不见的系统缩放边框**：拖动时指针一旦落到那一圈，系统就接管去改尺寸 —— 这正是"拖动时窗口匀速变大"的真凶（实测日志抓到 `by=native` 的尺寸增长，位置在 x=1214 屏幕最右侧）。现在系统边框不存在，缩放只由四个角负责。
  - ★★ **缩放命中区只能是四个角，不能是整条边**。之前右边缘 / 下边缘也各放了一条常驻的 6px 拉杆 —— 底板铺满整个窗口、没有标题栏，用户想挪窗口只能抓黑色区域，于是一抓就落在边条上：表现为"左右拖 → 变宽、上下拖 → 变高"，而用户以为自己在拖窗口。角落是小而明确的视觉符号，误判概率极低。
  - ★★ **四角缩放必须"钉住对角"**，不能按四条独立的 if 推 —— 实测这里推错过两次（把 `sw` 当成右边被拖、把 `ne` 当成右边被钉），表现是拉某个角时整个窗口朝反方向跑。正确规则见 `float:resize` 里的表：角在**左**边（`nw`/`sw`）时往左拖是变宽，宽的增量要反号；位置只由被钉死的那两条边决定，尺寸被夹到上下限时对边也不跑位。
  - ★ **字号滑杆只改 `--fs`，一个像素都不动窗口**。遇到长歌词请用户自己拉宽/拉高窗口。若用"按内容自动改窗口"那套，切歌与长度突变就会让窗口乱飘、调字号时容器乱跳。
  - ★ 窗口在渲染端首帧排好之前不显示（`show:false` → `float:reveal`），避免先闪一个空底板。
  - ★ **不要用 `useContentSize`**。它让构造函数的 `width/height` 表示"内容区尺寸"，而 `getBounds()` / `setBounds()` 用的是"窗口尺寸"（含不可见系统边框）。两者混用时，存进 `floatingW` 的其实是窗口尺寸，下次又被当成内容尺寸喂回去 —— 每开一次窗口就长一圈边框那么宽，是一个稳定复现的"匀速变大"。
  - ★ **几何审计日志按"每次操作一行"记**，不能每次变化都记一行：缩放是逐帧 `setBounds`，一次两秒的拖动能产生上百行，既是无谓开销，又会把真正出问题的那行淹掉。正常缩放在**松手时**汇总成一行（`by=resize`）；`unexpected`（不是我们发起的尺寸变化）实时记但限流每秒一行。`by=` 取值：`open`（开窗）/ `resize`（四角把手）/ `unexpected`。
  - ⚠ 若要取所在显示器的工作区，`screen.getDisplayNearestPoint()` 要的是点对象 `{x, y}`，而 `win.getPosition()` 返回数组 `[x, y]` —— 传错类型会抛 `conversion failure`。统一走 `workAreaAt(x, y)` 包装。
- **底板透明的两种情况**：已锁定（`body.locked`）；以及未锁定但**鼠标不在窗口上**（`body.away`，由 `mouseleave` 触发）—— 平时不留一块灰色板子，鼠标靠近才"浮现"。
- **歌词来源**：播放页通过 `NowPlaying.setLineListener()` 订阅"当前行变化"，**只在换行时**才 `floating:lyrics` 推一次（不做每帧推送），内容为当前行 + 前后各一行。
  - **逐字增强**：统一模型（`lyricsData`）命中时，推送里额外带当前行的词级时间轴（`words:[{t,e,x}]` + 行起止 `t/e` + 译文 `tr` + 推送时刻位置 `at`）。悬浮窗把词的绝对时间换算成 CSS `animation-delay/duration` 自己跑填充补间 —— **刻意不为逐字开高频 IPC**：透明置顶窗口每帧跨进程推送会把 CPU 拖死，而 CSS 动画由合成器执行、不需要精确时钟。行内 seek 时词填充会停在旧状态直到下一行重新推送，这是刻意接受的近似（悬浮窗是副显，精确词同步不值得那个代价）。
  - 主进程 `setLyrics` 是白名单关口：words 逐词收敛（缺 t/e、空文本、NaN/Infinity 全部丢弃，上限 120 个）—— 字段坏了顶多少逐字效果，不会让悬浮窗整行不渲染。
  - ⚠ ★ 换碟 / 重新加载歌词后必须**主动 `emitLine()` 一次（内容为空）**。`emitLine()` 只在 `highlight()` 发现"行号变了"时才被调用，而换碟时 `activeIdx` 是从 `-2` 重置的 —— 不主动发这一次，桌面悬浮歌词会一直停在这首歌的旧歌词上，直到新歌唱到"下一句"才更新。这正是"切歌后当前歌词对不上"的一个成因。
  - ★ 另一条更隐蔽的成因：三行曾经靠**轮转**来做滚动（旧当前行→上一行、旧下一行→当前行）。只要漏收一次推送、或收到一次重复推送，角色与内容就**永久错位**，而且不每次复现、极难查。现在三行各绑固定角色（`data-slot` 0/1/2），每次推送都**按角色覆盖文本**，动画只决定"怎么显示"、不参与"显示什么"，因此不可能对不上。
- **视觉**：三行普通流布局、垂直居中，上下行为 0.56× 的暗色幽灵行，当前行带辉光。顺序推进到下一句时当前行做一段 0.5s 的轻微上移入场（`#track.adv`），跳播 / 换碟 / 首次则直接落位不做位移。
  - ⚠ ★★ **辉光必须用两个独立变量（`--glow-in` / `--glow-out`），不能把两个颜色塞进同一个变量再用逗号分隔。** `text-shadow` 本身是逗号分隔的多层列表，`0 0 4px var(--glow)` 展开后第二层只剩一个颜色、没有任何偏移量 → **整条声明作废**，`getComputedStyle().textShadow` 变成 `none`，表现就是"辉光莫名其妙消失了"且不报任何错。这是本项目踩过的最隐蔽的一个 CSS 坑。
  - ★ 入场动画要"先摘 class 再强制回流"（`replayLineIn()`），否则连续两次 `add()` 同一 class 不会重播。
- **「歌词缓慢浮动」默认不常驻，改为"换行后跑 5 秒"**（`pulseFloat()` → 5s 后摘掉 `body.float-on`；设置 → 外观里的开关打开则改为一直浮动）。
  - ★★ 这条 9s 无限动画非常贵：窗口是 `transparent` + `alwaysOnTop`，合成器必须把窗口**背后那一片桌面**每帧重新混合一次，窗口越大每帧代价越高 —— 实测"窗口越大空闲占用越高"就是它造成的。既然常驻太贵，就把它**限制在用户真正在看的那一下**：每次换行后跑 5 秒（正好覆盖这一句的停留时间），之后自动停，静止时开销为零。效果看得见，代价有上限。
  - ★ `will-change: transform` 也只在动画真正开启时才加（`body.float-on` 命中才加），停掉后自动回到 `auto`，合成器随即释放那个 GPU 图层。
  - ★ 辉光是静态的，不产生这个开销，所以任何时候都开着。
- **颜色 / 字号**：文字颜色由用户在悬浮窗里选（5 个预设 + 取色器），字号 12–64；底板颜色按所选文字的**亮度**自动切换（浅色字配深底板、深色字配浅底板），辉光用同色两个透明度。改动写回 `settings.json`。
  - ⚠ 预设色必须用 **CSS 属性选择器**（`.sw[data-color="#c9a56a"]`）上色，不能用内联 `style` —— CSP 的 `style-src 'self'` 会拦掉 style 属性（表现就是色块全白）。
  - ⚠ 可调变量必须声明在 **`:root`** 而不是 `html, body`：body 上的声明会盖住 `<html>` 的行内值，JS 写进去的变量就永远不生效。
- **移动窗口 = 顶部拖动条 `#dragbar` 上的 `-webkit-app-region: drag`**，和主窗口顶栏**完全同一个原理**，由 Chromium/系统直接搬窗口。渲染端**没有任何** mousemove + `setPosition` 的自绘拖动代码，`float:drag` / `float:drag-start` / `float:drag-end` 三个通道与 `dragAnchor` 已整段删除。
  - ★★ 这是"大胆去掉冗余"的收益最大的一处：自绘拖动每个事件都要跨进程传坐标（鼠标轮询率可达 1000Hz，每秒几千次同步 IPC，CPU 占用奇高），还因为坐标换算与手势状态的边界情况出现过"拖着拖着窗口自己变形"。交给系统就没有这些问题。
  - ★ 拖动条只占顶部 22px，**底板其余部分是普通区域**，这样中键锁定、鼠标悬停显示控件的事件才收得到 —— `app-region: drag` 的区域不会把鼠标事件送给页面，这正是不能把整块底板都设成 `drag` 的原因。悬停时拖动条中间浮出一条淡手柄提示，让用户知道这里能拖。
- **缩放窗口 = 四个角**（`.grip-nw/ne/sw/se`）。角落命中区 16px、悬停时显示金色小三角，明确提示"这里可以拉"；必须 `app-region: no-drag`，否则与拖动条语义冲突。锁定态下 `pointer-events:none` 且透明。
  - ★★ 缩放走 **pointer 事件 + `setPointerCapture` + 锚点 + 系统光标绝对坐标**：按下立刻发 `float:resize-start`，主进程用 `screen.getCursorScreenPoint()` 记锚点（窗口几何 + 此刻光标位置）；之后渲染端每次只发"还在拖"这个**不带坐标**的信号，主进程用系统光标重算目标矩形。
    - **绝不用增量**：Chromium 里 `clientX` 是"事件生成那一刻"的光标位置减当时的窗口原点，`screenX` 是"派发那一刻"用**当前**窗口原点换算的；我们通过 IPC 移动窗口后原点变了，`dx = 本次 − 上次` 里混进窗口自身的位移 → 每步翻倍的正反馈，窗口会一路自己飞走 / 越拉越大。
    - **也不信渲染端的 screenX**：窗口刚被移动过时它是错位的。
    - 锚点必须在**按下那一刻**记，不能等第一次 pointermove —— 否则"按下 → 第一个 move"之间的那段位移会被吃掉。
  - ★★ **缩放 IPC 必须用 `requestAnimationFrame` 合帧**。`pointermove` 按鼠标轮询率触发（可达 1000Hz），主进程每次要做 4 次同步 IPC（`getCursorScreenPoint` / `getBounds` / `getDisplayNearestPoint` / `setBounds`）—— 1000Hz × 4 = 每秒 4000 次同步往返。合帧后：1000Hz 突发 300 个事件只发 1 次 IPC，60Hz 正常拖动仍 1:1 跟手、终点精确。
  - ★ 手势**绝不能卡住**（卡住 = 之后鼠标每动一下窗口都在跟 = "它自己在长大"）。`pointerup` / `pointercancel` / 窗口 `blur` 三个出口都调同一个 `endResize()` 收尾。
- **未锁定**：控件条在鼠标靠近 80px 内淡入、静止 2.2s 后淡出。
  - ★ `settings.update()` 是**同步写文件**，一次缩放能产生上百个事件。几何必须先攒在 `pendingGeo` 里、停手 400ms（或收到 `float:resize-end`）再落盘，否则每帧一次磁盘 IO，手感会变成幻灯片。字号滑杆同理（`sizeDirty` + 400ms 节流 + `change` 立即补写）。
- **鼠标中键 = 锁定 / 解锁**，这是唯一能改状态的手势（Esc 也可解锁作为兜底）。
  - 已锁定 → `win.setIgnoreMouseEvents(true, { forward: true })`：**所有点击穿透到下面的窗口**，鼠标移动仍送达渲染端，所以"靠近才显示提示"照常可用，而且此时只显示「已锁定 · 按鼠标中键解锁」。
  - 提示另有一层兜底巡检：锁定状态下超过 3s 没有收到 mousemove 就强制收起，避免提示赖着不走（点击穿透时鼠标事件不一定稳定送达）。
  - ★ 性能：锁定态下 `forward:true` 会把指针的**每一个** move 事件从合成器转发到渲染进程，一甩鼠标每秒能来上百个。渲染端对 mousemove 做 ~60ms 节流（拖动/缩放中不节流，保证跟手），主进程的 `float:arm` / `float:rearm` 也做成幂等 —— `setIgnoreMouseEvents` 每调一次都要重建窗口的输入接收状态，不便宜。
  - ★ Electron 的点击穿透是整窗粒度的：一旦穿透就收不到任何按键，中键自然也收不到。所以鼠标移进**可见文字块**时会临时"布防"（`float:arm` → 允许事件到达），收到非中键按键立刻 `float:rearm` 恢复穿透。
  - ★ 布防范围必须用**文字块**（`#track` 的矩形）而不是底板：底板现在等于整个窗口，若拿底板当范围，锁定后指针一进窗口就布防，点击几乎全被吞掉，穿透就失去意义了。
- **关闭用 `destroy()` 而不是 `close()`**：`close()` 是异步销毁，紧接着的"重新打开"会拿到一个还没销毁的旧窗口，等旧窗口的 `closed` 事件迟到触发时引用已被置空 —— 表现就是"关掉之后就再也打不开"。
- 主窗口关闭 / 应用退出时自动收起悬浮窗，避免它挡住退出流程。

### 4.1.10 逐字歌词渲染（`renderer/js/lyrics-view.js`）

播放页歌词区的逐字能力。**经典 LRC 路径原样保留**——只有统一模型（`lyricsData`）命中才走逐字引擎，
老歌词（LRCLIB / 手动编辑的 LRC）与以前完全一致。3D 歌词是后续独立的页面主题，这里不做。

- **数据流**：`setLyrics(meta)` 发现 `lyricsData` → `LyricsView.load(model)` 建行
  （返回与旧 `lrcLines` 同构的 recs，所以滚动 / 浏览 / 跳转逻辑一行没改）→ `highlight(pos)`
  在逐字模式下委派 `LyricsView.update(pos)`。
- **渲染**：每行 `.lrc-inner > .lrc-w`（词 span，`dataset.t/e`）+ `.lrc-bg`（对唱，词级独立填充）
  + `.lrc-tr` / `.lrc-ro` 小字（译文 0.56em / 罗马音 0.5em 斜体）；间奏行 `.inst` 带 ♪ 呼吸动画。
- **逐字填充**：`linear-gradient` + `background-clip:text`，每帧只改词 span 的 `--wp`（0~1）
  一个 CSS 变量，**不重建任何文本节点**。
  - ★★ **心跳 120ms（8fps）不够词级**——一个词最短约 150ms，8fps 下填充会一跳一跳。
    所以 lyrics-view **自跑 `requestAnimationFrame`**（60fps），主心跳仍然调用 `update(pos)` 兜底：
    `update` 对相同位置**幂等**（内部比对当前行号与每词 `--wp`，相同则什么都不写），双通道调用安全。
  - ★ 窗口/标签页不可见时（`box.offsetParent === null`）RAF 循环跳过绘制，不白烧 CPU。
- **译 / 音开关**：歌词头右侧「译」「音」两颗小钮（`.lrc-tg`），切 `no-tr` / `no-ro` class 控制显隐；
  模型没有对应轨时按钮直接隐藏（`applyLyricToggles`）。逐字模式下默认显示译文。
- **对唱**：TTML 时间重叠的不同 agent 行折进主行 `bg` 数组，主行下方 0.62em 小字独立逐字填充，
  不与主行抢亮度。
- **间奏**：相邻行空隙 > 8s 推断出的 `{text:'♪', instrumental:true}` 行，呼吸动画 + 不高亮。

### 4.1.11 全屏歌词演出层（v10.8–v10.9.2，`renderer/js/fl-*.js`）

正在播放页播放控件旁的「全屏」入口按钮，点击后**新界面覆盖整个软件窗口**，旧歌词界面
**真正停止渲染**（`html.fl-active` + 心跳让位，不是简单遮挡）。原版界面完整保留，
两者共存——退出（顶栏最左向左箭头）即回音乐库/播放页。

- **架构：行定位 + 词填充**。全部歌词行一次构建、绝对定位 `top:50%`，每帧只写两个
  CSS 变量（`--d` 行距 / `--ad` 绝对距离）做 smoothstep 插值，窗口 ±8 行外的行挂
  `.fl-out` 真卸载开销；词级填充只写当前行词 span 的 `--wp`，`linear-gradient` +
  `background-clip:text`，**不重建任何文本节点**——与播放页逐字引擎同一套纪律。
- **顶栏**：Windows 三大金刚键 + 软件全屏键，自动隐藏、鼠标靠近才出现，空闲时
  **隐藏鼠标指针**。左上角 ⌂ 唤出主题面板，最左向左箭头退出回音乐库。
- **播放控件**：底部小胶囊（左下，轻点播放/暂停、长按拖进度、滚轮音量，默认隐藏），
  其余播控（上/下一曲、模式）合并为右下一个按钮弹菜单。
- **主题（少而精，8 个）**：全部注册在 `fl-themes.js`（镜台 Mirror 外置
  `fl-theme-mirror.js`）：

  | 主题 | 类型 | 要点 |
  | --- | --- | --- |
  | 流光 Lumen | 2D | 封面色板派生光晕，默认主题 |
  | 倾诉 Whisper | 2D | 字卡呼吸 + 译音淡入 |
  | 回环 Orbit | 2D | 环形排布 + 慢公转 |
  | 群唱 Chorus | 2D | 对唱左右分列 + 背景人声墙 |
  | 凝彩 Prism | 2D | 玻璃棱镜色散 + 旋转光锥 |
  | 镜台 Mirror | 3D | Three.js 点云星海 + 网格地平线，**三级降级** |
  | 跃迁 Warp | 3D | 歌词赛道沉入 Z 深处，唱到的行跃迁到镜前（CSS 3D + 运镜；v10.9.1 拉近行距 + 换行穿梭） |
  | 星环 Halo | 3D | 歌词排成环幕绕镜旋转，镜头在星环中穿行（CSS 3D + 运镜；v10.9.1 环半径拉近 + 换行穿梭） |

  主题面板带**参数滑条**（粒子密度 / 色散强度 / 玻璃光泽等，按主题声明），
  舞台级变量 `--fl-p-<key>` 是唯一真相源，改动即时持久化到 `flParams`。
  主题动画只允许走两条路：**独立变换属性**（`translate`/`rotate`/`scale`，
  主题 CSS 块严禁重写 `.fl-line` 的 `transform`——定位归基础规则）与
  CSS keyframes 内 `var()` 实时求值；补间（`tween.js`，v10.12 起取代 GSAP）
  只做一次性编排，不进逐帧热路径。
- **镜台三级降级链**（任何机器都能演出）：`hasWebGL()` 预探 → three.js 点云（GL）
  → Canvas2D 星云 → 纯 CSS（`--fl-mirror-ripple`）。GL 不可用时**连 three.min.js
  都不下载**（省 608KB，也免了 three.js 的上下文错误噪音）。GL 模式下还有
  **画质自适应**：启动档位（核数/屏幕面积/DPR 推定）+ FPS 滑动窗口升降档
  （<42fps 持续 2.5s 降、>57fps 持续 6s 升），只调 `setDrawRange` 与像素比，
  不重建场景；dispose 全套释放（含 `forceContextLoss`，防上下文配额耗尽）。
- **字体系统（M4）**：演出层字体与主界面**完全独立**。可选系统已装字体
  （canvas 宽度法 + `document.fonts.check` 双保险探测），或上传个人字体
  （ttf/otf/woff/woff2，≤32MB，魔数校验，存 `userData/fonts/`）——自定义字体
  经 `fl:read-font` 拿 dataURL 注入 `@font-face`，用户选择永远排在默认链
  前面兜底（拼写变异的字体名也摔不坏）。上传/删除在设置面板「全屏歌词」区。
- **快捷键**（演出层打开期间播放快捷键整体让位）：`Esc` 退出、`F` 全屏、
  `T` 主题面板、`Space` 播放/暂停、`↑↓` 音量、`←→` 上下曲。
- **测试**：`tests/fl-stage.test.js`（jsdom 全链路：外壳/停辍守卫/行定位/词填充/
  快捷键让位/面板/胶囊/三大主题参数/镜台三级降级与 FPS 自适应/字体系统、
  **v10.9.1 菜单内嵌封面与选歌面板**）、
  `tests/fl-fonts.test.js`（主进程字体仓库：魔数/去重/上限/原子写）、
  `tests/ui-contract.test.js`（架构纪律锁：单写入/禁 transform/懒加载/白名单/CSP、
  **v10.9.1 选歌面板契约锁**）。
  另有真浏览器验证（Xvfb + SwiftShader 真 GL / 桩降级 / 真 TTF 上传渲染）。

### 4.1.12 演出层 v10.9 反馈轮（1 修复 + 2 新功能）

- **修复：退出演出层后鼠标失效**。根因是 `close()` 里调了不存在的
  `App.navigate`（navigate 是顶层函数）抛 TypeError，跳过 closeTimer，
  透明全屏层留在原地吃掉鼠标——快捷键仍有效（不走 DOM），所以现象是
  "键盘能操作、鼠标点不动界面"。修复：**双保险**（`typeof App.navigate`
  与 `typeof navigate` 都判，谁在用谁）+ try/catch 包住导航调用，
  **导航失败绝不影响关闭流程**。回归用例在 `tests/fl-stage.test.js`
  第 9 组与真浏览器复现脚本。
- **右下角专辑封面 + 弹出光盘**。播控区右下新增竖排容器（`.fl-bottom-right`）：
  上方**专辑封面**（有封面显图、无封面露占位光盘），下方播控菜单钮。
  菜单新增「**弹出光盘**」——先撤演出层再发 `cd:eject`，退碟仪式回到主界面
  正常演出。封面 URL 收敛到 `coverUrlOf()`（signature 缺失不拼坏 URL），
  元数据事件驱动 `FlCapsule.sync`（同曲目数/同时长也刷新封面）。
- **全局弹出方式**（设置面板「全屏歌词」区 + 面板 chip 三选一，同键
  `flReveal`）：`all` 全部显示 / `line` 整行弹出 / `word` 逐字弹出。
  架构上是 `.fl-line`（定位链）内嵌 `.fl-in`（揭示链）的**双层结构**——
  揭示状态每帧由当前行号 `cur` 无状态推导（`rv-on ⟺ i===cur`），
  `all` 模式整段跳过零成本；词门控只用 opacity/filter + `w-on` 类，
  **不侵占主题的 translate/rotate**。演出层面板 chip 与设置下拉互为出口，
  `dataset.reveal` 是真相源。
- **两个 3D 运镜主题**（folia 逐字演出路线的立体化）：歌词本身在三维
  空间里排布，**镜头真的在动**——
  - **跃迁 Warp**：行按与当前行的距离（`--ad`）沉入 Z 深处并微微后仰，
    未唱的行在雾中变小；唱到的行「跃迁」到镜前最大最亮。
  - **星环 Halo**：歌词行排在一条绕镜头旋转的**圆环**上（按 `--d` 带符号
    角度差排布，行面朝环心=观众），当前行永远停在镜面正前方，未唱的行
    从镜头两侧掠过、沉入环的背后。
  - **运镜 rig**（`makeCamRig`，两主题共用）：基础正弦环绕（yaw/pitch）
    + 升降 crane + 鼓点推近（bass/pulse）+ 指针视差（低通平滑）+
    换行切镜鞭打（方向交替）+ 入场推近。rig 就是 `#fl-lyrics` 自身
    （**不新增 DOM**），JS 每帧只写一次 transform——写入走合成层，
    不触布局。实测运镜中帧率 ≥30fps（headless 软件渲染）。
  - **3D 上下文纪律**：`opacity<1` / `filter` 会把子树**拍平**（词的
    translateZ 全废）——两个主题把 `.fl-line` 的 opacity 钉成 1，距离
    衰减改由 Z 景深 + 透视 + **字色 alpha** 承担；窗口剔除仍是 `.fl-out`
    的 `opacity:0 !important`（基础规则压过主题）。
  - **为什么不是 three.js 文字**：CJK 字体转 JSON 体积不可行——两个主题
    都用 CSS 3D + JS 运镜，文字保持系统字体清晰渲染、无下载、无降级链。
    圆环几何用**多项式近似**（Chromium 108 无 CSS `sin()/cos()`）：
    `sin θ ≈ θ-θ³/6`、`cos θ-1 ≈ -θ²/2+θ⁴/24`，|θ|≤45° 误差 <2%。
  - 与弹出方式**联动**：word 模式下未唱的词沉在 Z 深处（Warp -46px /
    Halo -40px），唱到才向观众弹出——逐字演出本身就是 3D 的。
- **版本号** 1.7.0 → 1.8.0。

### 4.1.13 演出层 v10.9.1 微调轮（封面归位 + 选歌 + 运镜拉近穿梭）

- **专辑封面移入二级菜单内**。右下角三个点钮的菜单里，最上方是一块
  **176×176 的大号封面**（圆角 14px，有封面显图、无封面露占位光盘），
  封面**下方**是歌名与艺术家（大字号居中、超长省略）；封面块位于
  播放/切歌按钮**上方**——菜单从下往上弹出时视觉动线自然。
- **播放顺序与弹出光盘并排最下方**。原竖排的两个菜单项改为底部
  **一行两个**（`.fl-menu-item.half`，各占一半宽）：左「顺序播放」
  （循环箭头图标，点击轮换播放模式）、右「弹出光盘」。
- **选歌功能**。顶栏新增「选歌」按钮（购物篮图标，快捷键 `L`），
  弹出 `#fl-tracks` 面板：曲目列表由 **TOC 定曲目数与时长**（权威），
  元数据补标题/艺术家；行 = 序号（`01` 补零）+ 歌名/艺术家 + 时长，
  **当前曲目金色高亮**并 `scrollIntoView` 跟进；点行走
  `App.playTrack(n)` 切歌（与主界面同链路：Transport.optimisticTrack
  + `cd:play-track` IPC）并关闭面板。`Escape` 只层面板不退出演出层。
- **运镜拉近**（解决"字太小看不清"）：Warp 行距 Z 系数 -110px →
  **-64px**；Halo 环半径 620px → **380px**；两主题 rig 的
  推近/升降/鼓点幅度整体上调——同样的歌词，离观众近了一大截。
- **运镜在歌词间穿梭**（dash）：rig 的 cut 通道从「单轴鞭打」扩为
  五通道（yaw/pitch/push/x/y），换行切镜时除鞭打外追加
  **正向冲刺**（`dashPush`，歌词向观众涌来）+ **横向闪避**
  （`dashX`，左右交替编织）+ 微沉（`dashY`），方向逐行交替——
  观感就是镜头在歌词行与行之间穿梭。补间一次性编排
  （1.15s power3.out），不进逐帧热路径。参数滑条新增
  「**穿梭强度**」（0–2.4×，**拉到 0 即关闭**，回归 v10.9 观感）。
- **版本号** 1.8.0 → 1.8.1（内部开发线；对外发布打包回到 **1.0.0** 正式版）。

### 4.1.14 演出层 v10.9.2 收尾（设置双栏 + 图标 + 版本号 1.0.0）

- **设置面板双栏化**。原来六大组（外观 / 全屏歌词 / 播放 / 系统 / 快捷键 / 关于）
  纵向罗列，一屏滚不完；改为**左侧分类导航（带图标）+ 右侧设置内容**：
  点左栏分类切换右栏对应分组，右栏独立滚动，左栏常驻。
  实现是**组装层重组**——所有设置行的构建逻辑一行未动（body 里仍是
  `.set-section` 标题 + 行的顺序结构），构建完按 `.set-section` 切分成
  分类页（`.set-page`）套上 `.set-nav`；新增分类 = 加一个 `section()` +
  在 `NAV` 登记一行（键名与标题一致即自动对上）。双栏样式只作用于
  `.set-panel`，不碰通用 `.panel-body`（编辑面板等不受影响）。
- **选歌按钮图标**：顶栏「选歌」从购物篮换成**音乐符号**（双音符），
  与「选歌」语义一致。
- **版本号**：`package.json` 1.8.1 → **1.0.0**（对外正式版版本号）。

### 4.2 深色 / 浅色主题

- 所有颜色走 CSS 变量：`:root`（深色）为默认，`html[data-theme="light"]` 覆写整组变量，因此新增界面元素只需写语义变量。
- 入口有两处：设置面板「界面主题」分段选择器、顶栏月亮/太阳快切按钮；写入 `settings.json` 的 `theme` 字段（`settings:set { theme }`），主进程同时用 `setBackgroundColor()` 同步窗口底色，避免无边框窗口露出未绘制区域。
- 启动时主进程直接按已保存的主题设置 `backgroundColor`，不会先闪一下深色。

### 4.3 无边框窗口与自绘控件

- `BrowserWindow({ frame: false })`；顶栏同时是拖拽区（`-webkit-app-region: drag`），导航/按钮为 `no-drag`。读盘场景盖住顶栏时，`#ceremony-drag` 补一条等高拖拽条（右侧 260px 让给 `no-drag`，保证右上角"靠近才显示"的退出按钮仍能收到 mousemove）。
- 右上角分两组：
  - **工具键**（`.tool-group`）：`全屏 ⇄ 退出全屏` · `深色 ⇄ 浅色` · `设置` —— 三个一直相邻；
  - **窗口键**（`.win-controls`）：`最小化` · `最大化 ⇄ 向下还原` · `关闭`，关闭键贴住窗口右上角（不用负 margin，避免图标被切角）。
- 图标/提示由主进程推送的 `app:win-state` 切换。
- ⚠ ★★ **全屏按钮的图标必须"落定后核对"**，不能在事件里读一次就发（`main/index.js` 的 `pushWinStateSettle`）。
  `enter-full-screen` / `leave-full-screen` 触发的那一刻，`win.isFullScreen()` 可能还返回**旧值**
  （切换带动画，状态尚未落定）。把这一读当结果发出去，渲染端图标就会**慢一拍**：
  进全屏后仍显示"进入全屏"图标，退出全屏后又变成"退出全屏"图标 —— 必须再点一次才恢复。
  做法：事件里先发一次（不卡手），落定（300ms）后回读核对，**只在真的不一致时补发**。
- ⚠ 核对必须**无条件**安排，不能因为"这次读到的值和上次一样"就跳过 ——
  那恰恰是最容易漏的一种：过期读若刚好等于上次发的值，跳过核对就等于动画落定后没人再发一次，
  图标会**永久**停在旧状态。回归用例见 `tests/winstate.test.js` 第 4 组（专门盯这个）。

### 4.4 音画律动（`renderer/js/visualizer.js`）

- 在渲染端**已有的 AudioContext 上旁路**一个 `AnalyserNode`（`fftSize=1024`），末端接 0 增益节点收尾：分析分支被渲染图拉动，但**不会有任何额外声音**，播放链路零改动。
- 低频能量（≤240Hz）+ 慢速基线做节拍判定，输出 `pulse`（0→1 衰减）、`dir`（每次鼓点正负交替 → 震动）、`level`、`bass`，每帧写成 `<html>` 上的 CSS 变量 `--beat / --beat-dir / --level / --bass`。
- **歌词**（`.lrc-line`）：当前行最近且字号更大，两侧按行距依次 `translateZ` 后撤 + `rotateX` 倾斜 + 淡出（景深）；当前行的 `.lrc-inner` 单独承担 `scale(1 + beat*0.11)` 与左右抖动 —— 分成两层是因为 3D 那一层有 0.5s 过渡，会把鼓点反应拖慢。
- **背景**：当前碟的封面以两层交叉淡入做全窗背景，`blur(64px) saturate(165%)` 是**静态**的，每帧只改 `transform`（`scale(1.12 + beat*0.05)`），由合成器负责，不重算滤镜。
- **唱片**：播放态由 `setPlayState()` 显式给 `.disc-spin` 加 `.is-spinning`，`animation-play-state` 随之切换 —— 暂停/停止即刻停转（`.np-wrap .disc-spin` 默认 `paused`，读盘场景的唱片不受影响）。
- **降级**：MCI 路径下声音由系统声卡直出，渲染端没有本地音频 → `live=false`，背景照旧跟随封面，但**不伪造鼓点**，动效量平滑归零。设置里的「音画律动」可整体关闭（低配机器）。

### 4.5 设置项一览（`settings.json`）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `theme` | `dark` | `dark` / `light` |
| `tabAutoHide` | `true` | 播放页标签栏是否自动隐藏 |
| `visualFx` | `true` | 背景 / 歌词的鼓点律动 |
| `immersiveMode` | `false` | 顶栏与传输条自动隐藏 |
| `splitView` | `false` | 封面与歌词并排显示 |
| `libraryStyle` | `grid` | `grid` / `flow`（CoverFlow） |
| `lyricScale` | `1` | 歌词大小 0.7–1.8（设置面板可调） |
| `discScale` | `1` | 唱片大小 0.6–1.6（设置面板可调） |
| `floatingLyrics` | `false` | 桌面悬浮歌词开关 |
| `floatingColor` / `floatingSize` | `#e9e3d8` / `22` | 悬浮歌词颜色与字号（悬浮窗内可改） |
| `floatingFloat` | `false` | 歌词缓慢上下浮动。**默认关闭** —— 透明置顶窗口 + 无限动画会让合成器每帧重混窗口背后的桌面，CPU 开销大且随窗口变大而升高 |
| `floatingW/H/X/Y` | `null` | 悬浮歌词窗口的位置与大小，**只由用户拖动 / 拉角决定**，程序不自行修改 |
| `floatingX` / `floatingY` | `null` | 悬浮歌词窗口位置（拖动后记忆） |
| `enginePreference` | `auto` | 播放引擎偏好：`auto` 能力测试驱动 / `raw` 强制 RAW / `mci` 跳过测试直接 MCI。选 `raw` / `mci` 时设置页会**立即切换**并原位续播；RAW 输出异常（白噪音）时切 `mci` 是逃生门 |
| `flTheme` | `lumen` | 全屏歌词演出主题：`lumen` 流光 / `whisper` 倾诉 / `orbit` 回环 / `chorus` 群唱 / `prism` 凝彩 / `mirror` 镜台 / `warp` 跃迁 / `halo` 星环 |
| `flReveal` | `all` | 歌词弹出方式：`all` 全部显示 / `line` 整行弹出 / `word` 逐字弹出。**对所有主题生效**（含 3D 主题） |
| `flSize` | `34` | 演出层歌词字号 24–56px |
| `flShowTr` / `flShowRo` | `true` | 演出层翻译 / 罗马音显隐（与主界面、悬浮窗各自独立） |
| `flParams` | `{}` | 演出层各主题参数现值 `{ 主题id: { key: 值 } }`，自由合并 |
| `flFont` | `null` | 演出层字体偏好。`null` = 系统默认字体链；`{kind:'system'\|'custom', name, id?}`，自定义字体存 `userData/fonts/`（ttf/otf/woff/woff2，≤32MB，魔数校验） |

其余为原有项（`autoPlay` / `defaultVolume` / `ejectReturnToScene` / `smtcEnabled`），行为未变。

### 4.6 全局 UI 规则

- **不用 emoji**、不用廉价渐变色（仅黄铜单色点缀）、`user-select: none`、图片 `-webkit-user-drag: none`、全站 `cursor: default`。
- CSP 仍是 `style-src 'self'`：没有注入 `<style>` 或 `style` 属性，所有动态量走 CSSOM（`setProperty` / `el.style.x`），与原有约束一致。
- **标签页隐藏用 `pointer-events` 而不是 `visibility`**：`visibility` 可以被子元素的 `visible` "顶回来"，一旦未激活的标签页用它显示，就会越过父级 `.page` 的 `visibility: hidden`，变成"看不见但仍然拦截点击"的透明层，音乐库的单击 / 右键会被它整片吃掉。

## 五、运行 / 构建

```bash
# 安装依赖（国内网络建议加 --registry=https://registry.npmjs.org）
npm install --registry=https://registry.npmjs.org

# 直接运行（无光驱时自动进入"未检测到光驱"，可点"体验演示模式"）
npm start
# 或：演示模式（合成音频 + 内置演示碟，体验完整仪式）
npm run demo

# 冒烟测试：xvfb 环境下按时间线截图到 smoke-shots/
npm run smoke

# 打包 Windows 安装程序（NSIS + zip，x64）
# ⚠ 必须在 Windows x64 上执行（electron-builder 无法在 Linux 上产出 win 安装包）
npm run dist
```

构建产物：`dist/ShiGuangCD-Setup-1.0.0.exe` 与 `dist/ShiGuangCD-1.0.0-win.zip`。

### 在 Win10 构建、装到 Win7 的完整流程

1. 在 **Win10 / Win11 x64** 机器上安装 **Node.js 18 LTS**（或 20 LTS）。
2. 解压源码包，执行：
   ```bash
   npm install --registry=https://registry.npmjs.org
   npm run dist
   ```
   - koffi 3.0.2 默认安装**预编译二进制**（`@koromix/koffi-win32-x64`），无需编译器；
   - 若预编译下载失败会自动回退 CMake 源码编译，此时需要先装 **Visual Studio Build Tools**（"使用 C++ 的桌面开发"工作负载）+ CMake。
3. 把 `dist/ShiGuangCD-Setup-1.0.0.exe` 拷到 **Win7 x64** 安装运行。
4. **Win7 运行前提**（缺一可能启动失败/读盘失败）：
   - 安装 **Microsoft Visual C++ 2015–2022 Redistributable (x64)**（提供 `vcruntime140.dll` 等，koffi 与 Electron 都依赖它）；
   - **Win7 SP1 且打过系统更新**（含 Universal CRT 更新 KB2999226，正常更新的机器都满足）；
   - 若双击无反应或提示缺 DLL，先装 VC 运行库、打全更新，再重试。

**备用方案（万一 koffi 预编译二进制在 Win7 上加载失败）**：在 Win10 构建机上**从源码编译 koffi**——安装 VS2022/2019 Build Tools（C++ 桌面工作负载）+ CMake，然后把 `package.json` 中 koffi 版本改为 **`3.1.5`**（该版本起 Windows 强制本地编译，没有预编译二进制，正好保证产物出自你的本机工具链）再 `npm install`。编译产物是 N-API `.node` 模块，Electron 22 内置 Node 16.17.2 可直接加载，与 ABI 无关；运行时同样需要上面第 4 条的 VC 运行库。

### 读盘问题排查（重要）

应用会把探测细节写入诊断日志：`%APPDATA%\ShiGuangCD\debug.log`（每 2 秒一次探测记录，包括识别到的驱动器、每次打开/读 TOC 的结果、播放引擎回退）。遇到"读不到 CD / 没有放入光盘提示"时：

1. 先看应用是否显示"未检测到光驱"（启动后的仪式场景）；
2. 把 `debug.log` 发给开发者即可定位：`drives=[...]` 为空说明系统层面就没枚举到光驱；`skip (错误码)` 说明能枚举到但打开/读目录失败，错误码能区分"无介质""权限"还是"驱动不支持"。

日志里与播放相关的关键行（便于定位"暂停/续播对不上""弹出检测不到"）：

| 关键字 | 含义 |
|---|---|
| `engine -> raw` / `engine -> mci` | 最终选用的播放引擎 |
| `pause: heard=... player=... wall=... -> anchor=...` | 暂停点三个候选值的实际取值（heard 是渲染端上报的听感位置） |
| `resume: from=... player=... -> anchor=...` | 续播起点 |
| `watch: media check says absent` | 设备明确报告"没有介质"，随后会读 TOC 复核 |
| `watch: 该光驱不支持介质探测指令` | 只能依赖读取健康度判定（多见于虚拟光驱） |
| `watch: raw read stalled` | 读取连续失败或长时间无推进 |

设置面板 → 「诊断日志」→ **打开日志目录** 可直接跳到该文件。

## 六、已知限制（如实说明）

- 仅支持 **x64**（Win7 32 位系统不支持，Electron 22 的 Win7 支持也是 x64 为主）。
- **RAW 数字读取**需要光驱支持；不支持时会自动回退 MCI（此时音量条禁用）。
- **光盘识别（TOC）有两条路径**：优先底层 IOCTL（`IOCTL_CDROM_READ_TOC_EX`，失败回退旧的 `IOCTL_CDROM_READ_TOC`，物理光驱走这条）；再失败自动回退 **MCI cdaudio**——Windows 自带播放器能播的盘（包括多数虚拟光驱挂载的音频碟）都能被识别。
- **播放引擎自动适配（RAW 优先）**：读盘后**无论 TOC 经哪条路径读到**，都会先按 75 扇区窗口试读检测 RAW 数字读取能力（跳过静音前奏，见 §5.1）——只有 RAW 能拿到 PCM 采样（音乐律动可视化的数据来源），MCI 的声音由系统声卡直接输出、进程内拿不到音频数据。RAW 不可用（虚拟光驱 / 部分 USB 光驱）才回退 MCI（音量条禁用）；RAW 播放中途失败也会自动切到 MCI 续播，并提示"已切换为模拟播放"。**能力测试会校验读回内容**：采样窗口全部整块全零（光驱"返回成功但无音频"）同样判不支持、回退 MCI；播放中连续 8 秒全零也会触发切换。**小端 PCM 光驱自动适配**（v10.2）：读回数据无 sync 头但小端视角波形平滑（MASD/RMS <0.7，USB 桥接光驱返回 little-endian 数据的实测形态，见 §5.6）→ 判可用并走 le16 直通解码（样本原样下发，不做字节交换），看门狗同步豁免、不再误报白噪音。首块数据推送时日志会记录 `raw chunk #1: ... peak=... nonZero=...%`（le16 模式附带直通说明），排查"没声音"时看这一行即可区分"数据没流出 / 内容全零 / 链路正常"。
- **光盘签名与帧号约定无关**：raw TOC 用绝对帧（首轨 = 150），MCI TOC 用 LBA（首轨 = 0），签名计算前先减去首轨起始帧——否则"这次 RAW 读到、下次 MCI 兜底"会被误判成换碟，重新走一遍读盘仪式。
- **弹出/关舱**：物理光驱走 IOCTL；虚拟光驱没有舱门，会提示"请在虚拟光驱软件中卸载镜像"且不中断当前碟片状态。
- 在线元数据需要联网；MusicBrainz 对无网络 / 冷门碟可能匹配不到（此时显示"轨道 N"骨架）。
- **位置精度依赖设备回读**：少数虚拟光驱不支持 `status cd position`。此时位置回退到本地时钟推算（精度与修复前相同），日志中会写一行 `mci: status cd position unavailable`。物理光驱与主流虚拟光驱均支持该查询。
- 本项目在 Windows 上的原生调用（koffi 3.0.2）已实测 Node 16 下可正常加载；Electron 22 内置 Node 16.17.2，同一条路径。**koffi 3.0.2 安装脚本需要 Node ≥ 14.18**，因此安装依赖必须用 Node 18/20（Win7 + Node 13 无法 npm install，见第一节）。
- 冒烟截图（smoke-shots/）是在 Linux + xvfb 的演示模式下生成的，用于验证 UI 各阶段；真实读盘请在 Windows 光驱上验证。

## 七、目录结构

```
cd-player/
├── main/
│   ├── index.js            # 入口：窗口、cover: 协议、设置、冒烟截图
│   ├── native.js           # koffi 原生绑定（kernel32 / winmm）
│   ├── ipc.js              # IPC 注册
│   ├── demo.js             # 演示碟（TOC / 元数据 / 内置 LRC）
│   ├── fl-fonts.js         # 全屏歌词字体仓库（userData/fonts/，魔数校验 + 原子清单）
│   ├── cd/
│   │   ├── cd-service.js   # 服务状态机：探测 → 仪式 → 播放引擎
│   │   ├── raw-player.js   # RAW 流式播放（预读缓冲 + 全零看门狗）
│   │   ├── mci-player.js   # MCI 回退播放
│   │   ├── audio-stats.js  # PCM 统计（静音数据判定，能力测试/看门狗共用）
│   │   └── reader-worker.js# worker 线程扇区读取（回复必须回带 reqId）
│   └── metadata/
│       ├── http.js         # 极简 https 客户端（限速 / 超时 / 重定向 / gzip+br / postJson）
│       ├── fetch.js        # 编排：缓存 → MB → 网易云 → iTunes → 骨架；歌词降级链入口
│       ├── musicbrainz.js  # MusicBrainz TOC 反查（精确识碟）
│       ├── netease.js      # 网易云（华语主力：专辑/曲目/封面/歌词）
│       ├── itunes.js       # iTunes（英文碟兜底）
│       ├── amll.js         # AMLL TTML DB（逐字歌词首选源，质量最高）
│       ├── qq-music.js     # QQ 音乐 QRC（逐字 + 译文，3DES 解密）
│       ├── kugou.js        # 酷狗 KRC（逐字，krc1 解密 + language 轨）
│       ├── lyrics.js       # LRCLIB 歌词（海外兜底）+ 六源降级链 fetchLyricsRich / fetchLyricsRichAll
│       ├── lyrics-model.js # 统一歌词模型：五源解析 / 间奏推断 / 对唱折叠 / toLrc 回退
│       ├── lyrics-select.js # 歌词源管理后端：选源 / 贴 TTML / 删手动源（编辑面板 IPC 落地）
│       ├── schema.js       # 元数据规范化（白名单重建，含 lyricsData / lyricsSources）
│       └── store.js        # 本地缓存仓库
├── renderer/
│   ├── index.html
│   ├── css/ base / scene / pages / panels
│   └── js/ audio / transport / scene / library / nowplaying / edit / settings / smtc / app
│       ├── lyrics-view.js  # 逐字歌词引擎（词级填充 / 译文 / 罗马音 / 对唱 / 间奏，RAF 自循环）
│       └── fl-*.js         # 全屏歌词演出层（v10.8–v10.9.2）：
│           ├── fl-stage.js     # 舞台外壳：开关 / 行定位 / 词填充 / 停渲守卫 / 快捷键让位 / 弹出方式 / 选歌面板挂载
│           ├── fl-lyrics.js    # 歌词模型 → DOM 行构建（一次构建，帧内只写变量；.fl-line > .fl-in 双层）
│           ├── fl-themes.js    # 主题注册表 + 参数管线（--fl-p-*）+ makeCamRig 共用运镜（含换行穿梭 dash）
│           ├── fl-theme-mirror.js # 镜台 3D（three.js 懒加载 + 三级降级 + FPS 自适应）
│           ├── fl-capsule.js   # 底部小胶囊 + 播控菜单（菜单内大号封面 / 歌名艺术家 / 播放顺序与弹出光盘并排）
│           ├── fl-panel.js     # 主题面板（主题卡 / 参数滑条 / 字号 / 译音 / 弹出方式 chip）
│           ├── fl-tracks.js    # 选歌面板（TOC 定曲目 / 元数据补标题 / 当前高亮 / 点击切歌）
│           └── fl-fonts.js     # 演出层字体（系统探测 / 上传 / @font-face 注入）
│       ├── tween.js            # 补间引擎（v10.12 取代 GSAP，零依赖，不进逐帧热路径）
│       └── vendor/three.min.js # Three.js r149（镜台按需懒加载）
├── preload.js              # contextBridge（白名单通道）
├── tools/generate-icon.js  # 纯 Node 生成应用图标（node tools/generate-icon.js）
├── tools/lyrics-smoke.js   # 逐字歌词降级链联网自检（node tools/lyrics-smoke.js --preset）
├── docs/lyrics-design.md   # 逐字歌词设计笔记（各源格式细节 / 解析器坑 / 测试注入术）
├── tests/                  # 纯逻辑自检：`npm test`（不需要光驱、不需要 Windows）
│   └── 含 lyrics-select（源管理后端）/ fl-stage + fl-fonts（全屏歌词演出层）/ ui-contract（前端契约：溢出防护/trScale/演出层架构纪律）等 28 个套件
└── build/                  # icon.png（窗口/任务栏用）/ icon.ico（打包用，7 档）
```

### 应用图标（`tools/generate-icon.js`）

纯 Node 实现，只用内置 `zlib`，**没有任何图像依赖**（项目里也没装 sharp/canvas）。
改完配色或结构直接 `node tools/generate-icon.js` 重新生成；
加 `--preview <路径>` 会额外输出一张尺寸对照图，用来肉眼确认小尺寸还认得出来。

设计是**圆形深色 CD + 扁平化**：只有实心色块，没有渐变、没有高光、没有斜面描边。
但结构照搬了真实 CD 的比例，所以全是纯色也一眼还是"一张 CD"：

| 部分 | 半径占比 | 说明 |
|---|---|---|
| 中心孔 | 0 – 0.125 | **透明**（真 CD 是 7.5mm/60mm，那里本来就是空的） |
| 夹持区 | 0.125 – 0.34 | 哑光面，略亮于盘面 |
| 金色细环 | 0.34 – 0.432 | 唯一的强调色（`--accent`），压在夹持区与数据区的分界上 |
| 数据区 | 0.432 – 0.922 | 主色，占面积最大 |
| 外缘 | 0.922 – 1.0 | 浅一档，把圆轮廓在浅色背景上"压住" |
| 圆外 | — | **透明**（不填深色方块，否则浅色任务栏上就是一块方砖） |

⚠ 踩过的坑，改这个脚本时注意：

- ★ **色块之间的明度差必须拉得开**。图标不像界面 —— `--surface-2`(#1a1a1f) 和
  `--surface-3`(#202027) 这种只差几个值的深色，放到图标上会糊成一个黑剪影。
  这里用的是 #28→#3E→#56 这样的阶梯。
- ★ **超采样合成时，颜色归一的分母是"命中色块的样本数"**。
  写成 `总样本数 - 命中数` 的话，内部整片覆盖的像素分母为 0，`r/0` 得到 `Infinity`，
  写进 Buffer 变成 `0` —— 整块盘面全黑、只剩边缘有颜色，而且**不报任何错**。
- ★ **抗锯齿用 4×4 超采样**。之前按半径硬阈值判边缘，16px 任务栏尺寸下是明显的台阶锯齿。
- ★ **ICO 必须给全尺寸档位**（16/24/32/48/64/128/256）。Windows 会挑"最接近但不超过"
  请求尺寸的那一帧；只塞一张 256 的话，16px 任务栏图标就是缩放出来的，金环会糊成灰线。
- 图标同时被 `main/index.js` 的 `BrowserWindow({ icon })` 引用，所以任务栏按钮和
  Alt+Tab 显示的也是这一张（只换打包图标、不想动任务栏的话，得把这两处解耦）。

## 八、自检用例

`npm test`（或 `node tests/run.js [套件名]`）。全部为纯逻辑测试，**不需要光驱、不需要 Windows**：

| 套件 | 覆盖内容 |
|---|---|
| `transport` | 位置锚点 / 暂停冻结 / 切轨归零 / 定位保护期 / 拖动预览 / 切页不丢进度 |
| `service` | 传输状态机：停播不重读、暂停恢复连续、定位语义、轨末去重、**★ MCI 暂停点取播放器回读值（而非渲染端墙钟估计值）、暂停乐观广播 + `pause-synced` 精确补发、MCI 定位锚点取回读落点（#10b/#10c）** |
| `mci` | MCI 时间轴映射、起播/定位帧号、暂停保状态、回退换算、**★ 位置权威链：暂停点=回读落点（A）、连续 5 轮暂停/续播不累积且弃用 `resume cd`（B）、定位落点回读（C）、0.15s 死区校正（D）、不支持 `status cd position` 时静默回退不抛异常（E）** |
| `raw-player` | 暂停丢预读、恢复从暂停点重读、背压、介质健康度看门狗、**主动介质探测（含超时）**、**渲染端指定听感位置后续播严格对齐**、**垃圾数据（两种字节序都不像音频波形）看门狗止损**、**★ le16 数据看门狗豁免 + decode 透传 + 全零仍止损（v10.2）** |
| `raw-pipeline` | **RAW 全链路集成**（真实 RawPlayer + 真实 reader-worker + 真实 CdService，假 native 只模拟光驱）：数据块从光驱流到 `cd:audio`、LBA/absFrame 帧号约定、`swapEndian` 字节序、内容非零；**全零光驱 → 能力测试判不过回退 MCI**；**播放中连续全零 → 看门狗切 MCI 续播**；**播放中垃圾数据 → 看门狗切 MCI**；**★ 小端 16bit PCM 光驱 → 波形判据放行 → le16 直通字节级正确（样本与光驱输出逐一相同）→ 不误报白噪音（v10.2）**；**worker 启动无响应 → 超时回退 MCI（不起播挂起）** |
| `audio-stats` | 数据形态判据单测（纯函数）：pcmStats 字节序口径、cddaSyncCount 双形态容忍、**★ waveformScore 波形平滑度判据（正确字节序 <0.4 vs 错误 >0.9，4 倍差距）+ detectPcmForm 四态判别（be16/le16/silence/garbage）+ 75 块无翻转回归 + 用户真实 dump 回归（v10.2）** |
| `engine` | 渲染端 AudioContext 位置换算、队列回收、Uint8Array 兼容 |
| `eject` | 外部弹出检测（含"读取一路成功但盘已不在"）、回退开关、软件内出舱不受影响、移除只处理一次 |
| `metadata` | **离线**元数据链路（http 层全部打桩）：MB 结构解析、TOC 编码、多版本选优、骨架兜底、合并语义、按时长逐轨对应、**封面 Buffer 穿透 `validateMetadata`**、hint 交叉校验、**track 数量不同的同名专辑仍须命中（精选集分卷回归）**、**artist-credit 的两种形态解析**、全源不可达时优雅降级、**首次读碟落盘与 force 刷新不被去重挡下**、**★ 多碟专辑碟号抽取/切分/端到端不串味（#18–#26）** |
| `native` | 原生层（koffi 打桩）：符号装载、能力位、`MCI_OPEN` 参数形态、全零/短读等异常返回 |
| `engine-select` | 引擎预选：**RAW 数字提取可用 → raw；全零/失败 → MCI 回退**；回退后仍可播放、能力缓存不反复探测；**垃圾前缀后转真音频 → 跳窗命中**；**★ 小端 16bit PCM 数据（无 sync 但小端波形平滑）→ 判可用并记录 le16 模式；静音前缀后转小端 PCM → 跳窗命中（v10.2）** |
| `winstate` | 全屏图标"落定后核对"（事件里读到过期值必须被纠正；过期值恰好等于上次值也要补发） |
| `lyrics-parse` | 五源解析器（真实样本 + 真实 `lyrics-model.js`）：TTML 词级/x-bg 对唱/嵌套子 span、yrc 五轨、QRC 全局偏好与 3DES、KRC 行内偏移与 language 轨、LRC 多标签与 offset；**统一模型字段、间奏推断、`toLrc` 回退（bg 行按自身时间戳输出）** |
| `lyrics-fallback` | **离线**降级链（歌词客户端全部打桩，零真实请求）：六源优先级、单源失败不阻塞/全失败返回 null、**匹配纪律（精确 ID 绝不搜索 / 标题命中 / 拒收不相干）**、单行歌词规则（搜索源拒收、精确 ID 放行）、schema 出口 |
| `floating` | 悬浮窗主进程侧（假 electron 注入）：`setLyrics` 白名单（tr/at/t/e/words 透传、脏词过滤、120 上限）、IPC 通道、`float:init` 带歌词 |
| `floating-view` | 悬浮窗渲染端（手搓 DOM 桩 + vm 加载真实 `floating.js`）：词 span 的动画时间换算（已唱→终态 / 唱半→补间剩余 / 未唱→延迟）、60ms 下限、译文小字、去重键、行序推进判定 |
| `renderer` | jsdom 全链路：切歌/切页/拖动/暂停/轨末/演示引擎/右键菜单/设置开关、**暂停点取 AudioContext 听感位置**、**暂停态丢弃残留块**、**★ Windows SMTC 适配（歌曲名/专辑封面写入系统控件、封面 `cover://`→data URL、媒体键映射、出舱清空、静音锚定音频随播放态启停撑起 SMTC 会话、设置开关关闭后彻底停用为零开销并可重新开启）**、**★ MCI 位置精度（暂停点/续播点取设备回读值而非超前墙钟、切轨/停止/定位清空上一轨回读值、LRC 歌词跟随校正后的位置命中正确行）（#24–#26）**、**★ 逐字歌词端到端（词 span 构建 / `--wp` 填充随位置变化 / 译音开关 / 对唱 bg / 间奏行）（#26b）**、**★ 手动编辑保存对逐字模型的保留与让位（#16b）** |
| `fl-stage` | jsdom 全屏歌词演出层：外壳构建/开关/退碟强制关闭、歌词装载（词级/经典/空态/切轨重建）、每帧行定位（`--d`/`--ad`）与词填充（`--wp`）与窗口剔除、**旧界面停渲守卫**、快捷键让位（Esc/F/T/Space/方向键）、主题面板（主题卡/字号/译音/持久化）、M2 三大主题与参数滑条（含补间编排）、**★ M3 镜台三级降级链（GL/2D/CSS 各分支 + FPS 升降档自适应 + drawRange 调档 + dispose 释放 + 异步挂载代次守卫）与凝彩 Prism**、小胶囊（轻点/长按拖进度/滚轮/菜单）、**★ M4 字体系统（默认链/系统字体/自定义注入/删除回退/上传/设置区构建）**、**★ v10.9：退出修复回归（导航双保险，closeTimer 不漏）/ 全局弹出方式 flReveal（all/line/word 状态机 + 词门控 + whisper 冲突处理）/ 两个 3D 运镜主题（warp/halo 注册与 rig transform）**、**★ v10.9.1：菜单内大号封面（播放切歌上方 + 歌名/艺术家 + 播放顺序与弹出光盘并排最下方）/ 选歌面板（TOC 权威 + 当前高亮 + 点击切歌）/ 运镜拉近（warp -64px、halo 380px）/ 换行穿梭 dash 五通道 + 穿梭强度参数** |
| `fl-fonts` | 主进程字体仓库（真实文件系统 + 临时目录）：魔数校验（ttf/otf/woff/woff2，垃圾与 html 拒收）、save/list/read/remove 全流程、MIME 撒谎时听魔数、同名同内容去重、24 个容量上限与 32MB 体积上限、index.json 原子写与幽灵条目自清理 |
| `i18n` | 多语言：五份词典键集合/数量/占位符/非空四项对齐、取词与三级回退（当前语言→简体中文→键名）、语言 id 归一化 20 组、`<html lang>`、静态标注键全部可查、切换后静态节点重排、`onChange` 广播时机、主进程 `cd:notice` 的 key 全部有词条 |

> `renderer` 套件需要 `jsdom`（已列入 devDependencies）；未安装时会自动跳过而不是报错。
> `metadata` 套件**一个真实网络请求都不发**，全部走内存打桩，可在无网环境稳定运行。

---

## 九、多语言（v10.11）

### 9.1 为什么是自己写 400 行，而不是引 i18next

需求只有一件事：**五门语言、一个下拉、切换即生效**。引入第三方库要多 30~80KB、要处理
打包/沙箱/CSP 三处兼容，而真正的成本从来不在"取词"，在**把文案从代码里搬出来**。
所以取词层刻意做到最小：`T('key', { n: 12 })` + `{n}` 占位替换 + 三级回退，
其余全部是词典数据。

### 9.2 三条不可退让的纪律

1. **回退链是硬要求**：`当前语言 → 简体中文 → key 本身`。任何一门语言漏一条，
   界面上要么是中文（用户至少能读），要么是键名（开发期一眼看得见），
   绝不允许出现空白。
2. **切换语言不碰播放链路**：整条重排链路（`relayoutLang`）只做 `textContent` /
   `title` / `aria-label` 与面板重建，**不发任何播放 IPC、不动 Transport**。
   测试里显式断言"切到英文后曲目号 / 传输状态 / 歌词行数三项不变"，
   防止以后有人顺手在重排里塞个 `refresh()` 把播放打断。
3. **文案只有一份**：主题名、主题参数名这类被三处界面共用的文案，统一走
   `FlThemes.nameOf/descOf/paramLabel`（主题 `def` 上挂 `nameKey/descKey/labelKey`）。
   此前它们分别在 `fl-themes.js`、`fl-theme-mirror.js`、`fl-panel.js` 各写一遍，
   加语言时必须只改一处，否则迟早分叉。

### 9.3 静态文案与动态文案的分工

- **静态**（写死在 HTML 里的按钮、占位符）：`data-i18n` / `data-i18n-title` /
  `data-i18n-aria` / `data-i18n-placeholder`，由 `I18n.apply()` 一次回填。
  新增一个按钮文案 = 加一个属性，不用写 JS，也不会忘记 `title` 与 `aria-label`。
- **动态**（JS 构建的面板、拼装的行）：直接 `T('key')`。这类面板本来就有
  "按需重建"的传统（设置 / 主题 / 选歌 / 编辑面板每次 `open()` 都重建），
  所以语言切换只需要调各自的 `rerender()` / `refresh()` / `applyLang()`。

### 9.4 全屏演出层为什么不重建外壳

`#fl-stage` 的外壳只构建一次，上面挂着 7 个按钮的监听器、主题挂载状态、
`--fl-*` CSS 变量与正在跑的 RAF。语言切换若 `innerHTML` 重建，这些东西全部要重来一遍，
主题会闪一下、3D 上下文要重新申请。所以外壳走 `applyShellText()` **原地回填**
`title` / `aria-label`；只有内部面板（主题面板 / 选歌 / 胶囊菜单）按需重建。

### 9.5 悬浮歌词是第二个渲染进程

它拿不到主窗口的 `I18n` 实例。做法是：主进程在 `float:init` 里带上 `lang`，
设置页改语言时 `settings:set` 命中 `lang` 就再推一条 `float:lang`。
悬浮窗在 `float:init` 里先 `setLang(silent)` 再填内容，而窗口本身要等
`body.ready` 才 `show`，所以首帧就是正确语言，不会闪一下中文。

### 9.6 主进程的提示语怎么办

`cd:notice` 由主进程产生（读盘异常、引擎回退、出舱失败…），文案原本是硬编码中文。
本轮给载荷加了 `key` + `vars`：`_notice('notice.ejectFailed', null, '出舱失败…')`。
渲染端 `Toast(ev.key ? T(ev.key, ev.vars) : ev.text)` —— 词典仍然只有渲染端一份，
主进程不引 i18n，避免两套翻译各自漂移；`text` 保留作兜底与日志排查。

### 9.7 踩过的坑

- **`T` 是顶层 `const`，不挂 window**。jsdom 测试里各文件必须**拼成一次 eval**
  （和 `renderer.test.js` 早年的做法一致），分开 eval 拿不到词法绑定。
- **中文契约测试会集体失效**。`ui-contract` / `v10.4`~`v10.7` 里原先断言的是
  `/labelBlock\('播放引擎'/`、`b.textContent === '恢复默认'` 这类字面量。
  改造后一律改成「键用对了 + 词典里有对应中文」双查——**契约不能因为搬家就放松**。
- **`relayoutLang` 里的模块判空**不能用 `window.NowPlaying`：那些模块是顶层
  `const`（多数显式挂 window，但 `Transport`/`App` 等并非全部），必须用
  `typeof X !== 'undefined'` 的词法引用。
- **设置面板重建会跳回第一页**。用户改完语言看到的是"外观"页而不是原来那一页，
  所以 `activePage` 要跨重建保留。

---

## 十、动画（v10.12）：为什么敢自己写

### 10.1 先量化，再决定

先数清楚 GSAP 到底在干什么，再谈替不替换。全仓库（除 vendor）只有 9 个调用点：

| 处 | 目标 | 从 → 到 | 时长 / 缓动 |
|---|---|---|---|
| 流光 `pop` | 行元素 `--fl-pop` | 0.9 → 0 | 0.55s power2.out |
| 倾诉 `breath` | 行元素 `--fl-whisper-breath` | 1 → 0 | 1.2s sine.out |
| 倾诉入场 | 词 span `--fl-whisper-y` + `opacity` | 10→0 / 0→1（stagger 0.055） | 0.75s power2.out |
| 回环 `kick` | 行元素 `--fl-orbit-kick` | 1 → 0 | 0.7s power3.out |
| 回环入场 | 行元素 `--fl-orbit-kick` | 2.6 → 0 | 1.1s power3.out |
| 群唱 `slide` | 行元素 `--fl-chorus-slide` | 1 → 0 | 0.85s power2.out |
| 凝彩 `flare` | 行元素 `--fl-prism-flare` | 1 → 0 | 0.9s power2.out |
| 运镜 `dash` | JS 对象 `cut`（5 通道） | → 0 | 1.15s power3.out |
| 运镜 `intro` | JS 对象 `intro` | 1 → 0 | 1.5s power2.out |

模式高度一致：**事件触发、一次性衰减到 0、5 条缓动**。没有 timeline、没有插件、
没有 scroll-driven、没有 FLIP。71KB 的通用引擎，在这里只当一个「数值插值器」用。

### 10.2 性能上其实没有差别

这 7 处元素动画的目标是 **CSS 数值变量**（`--fl-pop` 之类），CSS 再拿它进 `calc()`。
浏览器没法把自定义属性的数值变化交给合成器，所以无论 GSAP 还是手写 rAF，
每帧做的都是同一件事：`style.setProperty('--fl-pop', 0.42)` → 触发一次样式重算。
**GSAP 在这条路径上没有加速空间**，它快的那些场景（transform/opacity 合成、timeline 复用）
本项目一个都没用到。

### 10.3 为什么不走「`@property` + transition」这条更"原生"的路

第一版设计正是它：注册 `@property --fl-pop { syntax:'<number>' }`，然后给元素加
`transition: --fl-pop 550ms cubic-bezier(...)`，由浏览器驱动补间，省掉 JS ticker。
Chromium 里实测可行（0.9 → 0，200ms 时读到 0.254，900ms 精确归零）。

但它撞上一条现成的 CSS：`.fl-line` 自带

```css
transition: opacity 0.28s ease, font-size 0.35s var(--fl-ease), color 0.35s ease;
```

`transition` 是不可拆分的单值属性，**内联写一条就整体覆盖样式表里的三条**——
行切换时那 0.28s 的淡入会突然变成硬切。绕法有两个：从 `getComputedStyle` 反读三条再拼回去
（每处换行一次额外样式重算，且依赖计算值字符串解析），或者给每个元素加独立包裹层（DOM 结构要改）。
两者都比「40 行 rAF」更脆。

顺带记一笔：`@property` 的 `inherits` 必须是 `true`。`--fl-whisper-breath` 消费在
`.fl-line.active::after`（伪元素经原始元素继承）、`--fl-chorus-slide` 消费在 `.fl-bg` 子元素，
写成 `false` 会让它们读到初始值，效果直接消失。而「继承」意味着每帧的变量写入要沿子树传播——
这也是它并不比手写 rAF 便宜的原因之一。

**最终选择**：沿用 GSAP 原本的写入通路（每帧 `style.setProperty`），只把引擎换成自己的。
行为等价、零风险，还顺手把 `killTweensOf` 的 11 处调用消灭了（重复 `fromTo` 天然就是打断重来）。

### 10.4 缓动对齐是硬指标

多项式实现与 GSAP 完全同式：`power2.out = 1-(1-t)³`、`power3.out = 1-(1-t)⁴`、
`sine.out = sin(πt/2)`。用 `gsap.parseEase()` 在 0…1 上取 101 个点比对：

    power2.out   最大偏差 0
    power3.out   最大偏差 0
    sine.out     最大偏差 2.36e-16（浮点噪声）

真浏览器 A/B（Playwright，同页同时钟同参数，0.6s 补间）逐点最大互差 **0.0027 / 1.0**，
差异来自两个引擎的子帧相位（一个 16ms 的 tick 偏移），曲线形状一致。

### 10.5 踩到的两个坑

- **`duration` 的位置**。GSAP 的签名是 `fromTo(target, fromVars, toVars)`，`duration`/`ease`
  写在 `toVars` 里；我第一版只认第 4 个参数，9 个调用点的时长全被忽略、退回默认 0.3s。
  肉眼几乎看不出来（0.3s 也是"弹一下"），是 A/B 对比时 GSAP 提前收尾才暴露的。
  现在两种写法都认，且控制键会被过滤掉——否则会给元素写出 `style="duration: 550"`。
- **`performance.now()` vs rAF 时间戳**。jsdom 里两者基准不同（测试把 `performance.now`
  换成了受控 CLOCK，rAF 时间戳却是从 0 起算），用时间戳参数会让补间永远停在起点。
  统一用 `now()` 计时，顺便让测试可以「拨表」推进动画。

### 10.6 测试怎么锁

- `tests/tween.test.js`（43 条）：缓动对照 GSAP 采样值、元素/对象两种目标、GSAP 风格参数、
  stagger、打断重来、`clearProps`/`reset`、静态契约（零依赖 / 不写 transition / 不用 WAAPI）。
- `fl-stage.test.js` 第 16 节：走真实 `App.init` 链路，换行后当前行确实被写入 `--fl-pop`
  并衰减归零，且全程不写内联 `transition`。
- 顺带修了一条**碰巧成立**的老断言：「非当前行填充值冻结」原先断言 `--wp === '0.000'`，
  这依赖「第 1 行在初始化时当过当前行」这个时序巧合；改成断言「不跟随 pos 上涨」后，
  既保留了抓「全曲同时填充」bug 的能力，又不再受初始化快慢影响（删掉 71KB 的 GSAP
  就让这条断言翻车了，正好暴露出来）。
