# 抖音直播间福袋自动发现与参与系统：headless Chrome + CDP

> 用 headless Chrome 与 Chrome DevTools Protocol 驱动抖音网页版直播间，自动采集房间、识别福袋、点击参与、关注主播或加入粉丝团、守候开奖并写入本地数据看板；运行时零第三方依赖，纯 Node.js 内置模块实现。

**一句话定位**：这是一个**个人自动化工具**，不是通用产品，也不是已稳定验证的商业系统。它在整个体系里的位置是「抖音福袋」项目的**公开源码白名单仓库**：只放可复现运行所需的脚本、配置模板与文档，账号登录态、运行数据、截图产物一律不入库。

- 本仓库：<https://github.com/DLDLDL13579/douyin-fudai-agent>
- 仓库元数据：公开仓库，默认分支 `main`，主语言 JavaScript。核心代码 `hunter35.mjs` 3443 行 + `web/server.mjs` 1744 行，配套 161 个 `.mjs` 脚本与 6 个独立守护。
- 同一 GitHub 账号下的其他技术仓库：<https://github.com/DLDLDL13579/our-nest-miniprogram>、<https://github.com/DLDLDL13579/av-anomaly-detection>。
- 迁移记录（`AGENTS.md`）：2026-11-02 从 `个人项目/杂活/douyin-auto` 与 `/tmp/douyin-probe` 整体迁入本工作区，`/tmp` 副本会被系统清理，故不再分两处存放；脚本内 207 处绝对路径已同步改写。

> 本文以代码与配置文件为准。`AGENTS.md`、`ARCHITECTURE.md`、`LICENSE`、`package.json`、`data/wait-config.json`、`scripts/run-h35.sh`、`web/run-web.sh` 均按源文件核对；文档与代码不一致之处，已在「十二、已知问题与限制」逐条点明。

---

## 目录

- [一、项目定位](#一项目定位)
- [二、现状 / 状态表](#二现状--状态表)
- [三、技术架构](#三技术架构)
- [四、目录结构](#四目录结构)
- [五、快速开始](#五快速开始)
- [六、核心实现](#六核心实现)
- [七、配置参数表](#七配置参数表)
- [八、多账号并行](#八多账号并行)
- [九、Web 看板](#九web-看板)（本地看板 / 公网只读看板 / 接口与运维）
- [十、数据报表](#十数据报表)
- [十一、Windows 绿色分发版](#十一windows-绿色分发版)
- [十二、已知问题与限制](#十二已知问题与限制)（核心限制 / 运行时特性 / 已知缺陷 / 统计口径）
- [十三、合规与安全声明](#十三合规与安全声明)
- [十四、开发历程与踩坑记录](#十四开发历程与踩坑记录)
- [十五、归属与许可证](#十五归属与许可证)

---

## 一、项目定位

抖音直播间会不定时发放「福袋」，用户需在倒计时内完成指定动作才能参与，常见条件有三类：

| 类型 | 参与条件 |
|:---|:---|
| 评论型 | 发送指定评论 |
| 评论 + 关注型 | 关注主播并发送评论 |
| 粉丝团型 | 加入粉丝团（通常消耗 1 抖币）并发送评论 |

人工盯守需要持续刷新几十个直播间，且福袋出现时间不可预测。本项目用 headless Chrome 直接驱动抖音网页版，通过一个 CDP 长连接完成「采集房间 → 评分排序 → 逐个常驻 → 检测福袋 → 点击参与 → 关注主播 / 加入粉丝团 → 守候开奖 → 记录结果」的完整闭环，并提供本地 Web 看板实时展示战况。

**当前授权范围（`AGENTS.md`「策略要点」，2026-11-04 用户最终定稿）**：评论型、评论+关注型、粉丝团型**全部都抢**；粉丝团福袋需先点「加入粉丝团（1钻）」再参与，关注型需先关注，人气红包也抢。最早的「只抢前两种」「5 万以上才加粉丝团」两条限制均已解除，抖币消耗已获用户授权。

**设计取舍**：不使用 Playwright / Puppeteer / Selenium，不调用任何非公开接口，只依赖 Node.js 内置的 `WebSocket` 直连 CDP。这样整套运行时**零第三方依赖**，只需要 Node.js 22+ 和系统已安装的 Chrome，绿色分发包体积才能压到 20MB 级别。`AGENTS.md` 亦写明「脚本零第三方依赖，只要 `node` 和系统 Chrome；用 Node 内置 `WebSocket` 直连 CDP」。

---

## 二、现状 / 状态表

> 本节数据截至 **2026-11-17 13:06**，按 `data/*.jsonl`、`git log`、源码行数实测。

| 项 | 现状 |
|:---|:---|
| 基线版本 | `hunter35.mjs` 第 35 代抓取主程序，**3443 行**；看板 `web/server.mjs` **1744 行** |
| 运行模式 | macOS 本机 **双账号并行 7×24 守护**（主号 9750 + main3 9752），`main2` 已于 2026-11-06 按用户指令删除 |
| 守护体系 | 6 个独立守护进程：`run-h35.sh`×2（supervisor）、`run-cache-cleaner.sh`、`runtime-cleaner.sh`、`health-guard.sh`、`watchdog-down.sh`、`run-public.sh`、`run-web.sh` |
| 参与范围 | 评论型 / 评论+关注型 / 粉丝团型（**限已加过团的直播间**）；人气红包只识别不抢 |
| 累计战绩 | **成功参与 1955 次**（覆盖 218 个独立房间、15 天） |
| 开奖记录 | **1845 次开奖，中奖 0 次**（中奖率 0.00%） |
| 抖币消费 | 132 条加团记录（每次 1 钻） |
| 单文件 exe | **未产出**。需交叉编译定制 Node 二进制、本机磁盘与时间成本过高；改用自带 `node.exe` 的绿色包（21 MB） |
| 自学习效果 | 学习档案 `data/anchors.json` 记录房间发袋率 / 时段分布，用于排序与常驻时长；样本仍在累积 |
| 平台验证 | macOS 完整长跑验证（连续 15 天不间断）；Windows 绿色包通过静态检查与真实启动验证，未做 7×24 长跑 |
| 分支状态 | 公开仓库、默认分支 `main`、MIT LICENSE |

**分阶段完成度**：

| 阶段 | 内容 | 状态 |
|:---|:---|:---|
| P1 | 账号管理层：多 profile 目录、CLI 增删查、扫码登录、导入现有登录态 | ✅ 已完成 |
| P2 | 数据层：`participations.jsonl` + `wins.jsonl` + `losses.jsonl` + 报表工具 | ✅ 已完成 |
| P3 | 展示层：本地看板 8899 + **公网只读看板**（Cloudflare 临时隧道 → 8898 只读代理） | ✅ 已完成 |
| P4 | 多账号并行：独立端口、共享学习档案加锁、看板分账号统计 | ✅ 已完成并长跑验证 |
| P5 | 策略可观测性：每次决策记录 policyId / decisionId / 反事实线索 | ✅ 已完成 |
| P6 | **中奖闭环验证** | ⚠️ **未达成**：1845 次开奖 0 中奖，检测逻辑经截图交叉验证为真未中奖，非漏判 |

> ⚠️ **必须诚实说明**：本系统在「成功参与」环节已高度可靠（1955 次），但在「中奖」环节至今 **0 次命中**。
> 2026-11-17 已针对该问题做策略调整（详见「六、核心实现」末尾的「策略演进」），效果待观察。
> 任何把本系统描述为「能稳定中奖」的说法都与实测数据不符。

---

## 三、技术架构

```mermaid
flowchart TD
    A["Node.js 主程序 hunter35.mjs"] --> B["CDP WebSocket 直连"]
    B --> C["headless Chrome 9750"]
    C --> D["抖音首页 + 分类页采集"]
    D --> E["候选池 约 50 间"]
    E --> F["评分排序 + VIP 主动探测"]
    F --> G["逐个常驻 当前 60 秒"]
    G --> H{"检测到福袋?"}
    H -->|是| I["识别类型并参与"]
    I --> J["关注主播 / 加入粉丝团"]
    J --> K["守候开奖"]
    K --> L["写入全局 jsonl"]
    H -->|否| G
    L --> M["Web 看板 8899"]
    L --> N["日报 / 数据报表 / CSV"]
    O["共享学习档案 anchors.json"] -.加锁读写.-> F
    P["第二个账号 独立端口"] -.追加写入.-> L
    P -.加锁读写.-> O
```

> 图注：端口 9750 来自 `scripts/run-h35.sh` 的默认值，8899 来自 `web/run-web.sh` 的默认值；常驻 60 秒来自 `data/wait-config.json` 的 `scale=0.125 × perRoomMinMs=480000`。原图把第二个账号标为固定 9751，已按 `run-h35.sh`「显式传入 > `meta.json` 登记 > 9750」的端口规则改为「独立端口」。

### 组件职责

| 组件 | 文件 | 职责 |
|:---|:---|:---|
| 应用入口 | `scripts/app.mjs` | 统一分派 `main` / `status` / `login` / `hunter` / `web` 五种模式 |
| 路径与平台 | `scripts/paths.mjs` | 应用根定位、Chrome 探测（含 Edge 兜底）、端口检测、进程终止、目录初始化 |
| 抓取主程序 | `scripts/hunter35.mjs` | 房间采集、评分、福袋识别、参与、关注、开奖守候、学习档案更新 |
| 共享写入 | `scripts/shared-json.mjs` | 跨进程安全的文件锁 JSON 读写，防止双实例互相抹掉学习成果 |
| 账号管理 | `scripts/account-manager.mjs` | 扫码登录、读取账号昵称与抖音号、维护 `accounts/<name>/meta.json` |
| 存活自检 | `scripts/check-alive.mjs` / `.sh` | 检查 Cookie 与页面渲染状态，区分「掉线」与「真的没福袋」 |
| Web 看板 | `web/server.mjs` | 本地 HTTP 服务，聚合日志与 jsonl，渲染单屏 3×2 看板 |
| 守护脚本 | `scripts/run-h35.sh`、`scripts/fudai.sh`、`web/run-web.sh` | while-true 拉起、单实例锁、启动/停止/重启 |
| 报表 | `scripts/data-report.mjs` / `daily-report.mjs` / `export-csv.mjs` | 控制台战况、Markdown 日报、Excel 可直接打开的 CSV |

> 上述 `scripts/*.mjs` 与 `web/server.mjs` 的职责描述来自上一版 README 与 `AGENTS.md`，具体以各文件源码为准。

### 为什么用 CDP 而不是其他方案

1. **零依赖**：Node 22 起内置全局 `WebSocket`，无需 `ws` 包。
2. **可控**：直接发 `Runtime.evaluate` / `Input.dispatchMouseEvent` / `Network.setCookie`，能精确处理登录态持久化与坐标点击。
3. **低开销**：配合「暂停视频 + 暂停所有动画 + 视频透明」三连注入降低抓取 Chrome 的 CPU。
4. **可观测**：福袋 DOM 快照、开奖结束截图、逐轮诊断日志都可直接从页面取。

代价是 DOM 选择器会随抖音改版失效，因此代码里保留了福袋 DOM 样本存档与 `check-alive` 自检，避免「选择器瞎了」被误判成「主播不发袋」。

**CPU 降载口径以 `AGENTS.md` 为准**：早期记录称「暂停视频后 CPU 降到 0.2%」已被当晚实测推翻——视频明明是 `paused:true`，抓取 Chrome 仍吃 154% CPU（渲染进程单个 53.8%），真正开销在弹幕滚动、礼物特效、点赞动画这些持续重绘；正确做法是「暂停视频 + 暂停所有动画 + 视频透明」三连，实测 **64.7% → 31.3%**。`AGENTS.md` 明确要求「性能结论必须当场实测，不要沿用历史数字」。上一版 README 写的「154% → 4.2%」与之一致性不足，见「十二、已知问题」。

---

## 四、目录结构

本仓库采用**源码白名单**发布。仓库文件树记录共 **35 个文件**，一级分布为 `scripts:18`、`根文件:10`、`data:3`、`docs:2`、`web:2`。下表按仓库文件树与仓库内文档合并列出：

```text
.
├── README.md                      本文件
├── LICENSE                        MIT（Copyright (c) 2026 邓林）
├── .gitignore                     登录态 / 运行时数据排除规则
├── package.json                   项目元信息与 npm 脚本
├── ARCHITECTURE.md                架构说明与分阶段计划
├── AGENTS.md                      项目说明与完整开发日志（含逐日事故复盘）
├── 使用手册.md                    操作手册
├── 功能验收.md                    验收清单
├── 开发教训清单.md                踩坑汇总
├── 关注主播名单.md                主播开播时间表
├── data/
│   ├── threshold.json             分时段在线人数门槛（唯一数据源）
│   ├── pinned-hosts.json          指定主播与开播时段
│   └── wait-config.json           等待时长倍率与基线
├── docs/
│   ├── 分发说明.md                Windows 绿色包使用说明
│   └── incidents/
│       └── 2026-11-03-凌晨到晚间排查记录.md   事故排查归档（已脱敏）
├── scripts/
│   ├── app.mjs                    统一入口（上一版 README 记载）
│   ├── paths.mjs                  跨平台路径与 Chrome 探测
│   ├── hunter35.mjs               抓取主程序
│   ├── shared-json.mjs            跨进程安全写入
│   ├── account-manager.mjs        扫码登录与账号管理
│   ├── check-alive.mjs            采集端自检
│   ├── check-alive.sh             自检 shell 入口（见文件树）
│   ├── fudai.sh                   启动 / 停止 / 重启 / 多账号（见文件树）
│   ├── run-h35.sh                 7×24 守护（源文件已核对）
│   ├── status.sh                  状态速查（见文件树）
│   ├── data-report.mjs            控制台数据报表
│   ├── daily-report.mjs           Markdown 日报生成
│   ├── export-csv.mjs             CSV 导出
│   ├── backfill-anchors.mjs       学习档案回填
│   ├── blacklist-rooms.txt        黑名单房间（见文件树）
│   └── known-fudai-hosts.txt      VIP 房间池（见文件树）
└── web/
    ├── server.mjs                 看板服务（run-web.sh 中以 node server.mjs 调用）
    └── run-web.sh                 看板守护（源文件已核对）
```

> 看板截图未纳入仓库：本机截图上印有真实账号昵称，属于身份信息，公开仓库不放。可在本地运行看板后自行截图。

**以下目录存在于本机但不在仓库中**（`.gitignore` 逐字排除）：

| 目录 | 内容 | 排除原因 |
|:---|:---|:---|
| `accounts/` | 各账号 Chrome profile、`meta.json`、独立日志 | 含登录 Cookie，最高风险 |
| `douyin-auto/` | 主实例运行目录、截图、日志、状态文件 | 含登录态与约 700MB 运行时产物 |
| `dist/` | Windows 绿色包与 `node.exe` | 21MB 二进制，不适合进源码仓库 |
| `node_modules/` | 开发期依赖 | 运行时零依赖，无需提交 |
| `data/*.jsonl` | 参与 / 中奖 / 未中奖 / 抖币消耗流水 | 含真实账号行为数据 |
| `reports/`、`exports/` | 生成的日报与 CSV | 运行时产物 |

`.gitignore` 还逐项排除 `scripts/profile*/`、`scripts/cookies.json`、`scripts/*cookies*.json`、`**/chrome-profile/`、`**/Cookies`、`**/Cookies-journal`、`**/Cookies.bak*`、`**/SingletonCookie`、`**/login-state.json`、`**/Local Storage/`、`**/Session Storage/`、`.env`、`.env.*`、`*.token`、`*.pem`、`*.key`，以及 `*.log`、`*.tmp`、`nohup.out` 等运行产物。文件头写明：提交时只用显式白名单 `git add <具体文件>`，禁止 `git add .`。

---

## 五、快速开始

### 环境要求

| 项 | 要求 |
|:---|:---|
| Node.js | 22+（需内置全局 `WebSocket`；`package.json` 的 pkg 目标亦为 `node22-*`） |
| 浏览器 | 系统已安装 Google Chrome 或 Microsoft Edge（`scripts/paths.mjs` 含 Edge 兜底） |
| 系统 | macOS / Windows / Linux（上一版 README 记 macOS 完整长跑验证） |
| 网络 | 能访问 `live.douyin.com` |
| 依赖 | **无 npm 依赖**，不需要 `npm install` |
| 登录态 | 需自备有效 Cookie；`ARCHITECTURE.md` 记 headless 环境下二维码会被手机端判过期，唯一可用的登录方式是从真实 Chrome 搬运 cookie 或按需有头扫码 |

> 以下命令来自上一版 README 与 `ARCHITECTURE.md`，**可用性以各脚本源码为准**。

### 1. 克隆仓库

```bash
git clone https://github.com/DLDLDL13579/douyin-fudai-agent.git
cd douyin-fudai-agent
```

### 2. 初始化目录

`scripts/paths.mjs` 的 `ensureDirs()` 会在首次启动时创建运行目录与 `data/`，并把仓库内的配置模板复制过去。也可手动检查：

```bash
node -e "import('./scripts/paths.mjs').then(m=>{m.ensureDirs();console.log('APP_ROOT =',m.APP_ROOT)})"
```

### 3. 扫码登录

```bash
node scripts/app.mjs login
```

这会打开一个**有头** Chrome，扫码登录后程序会：

- 通过 `Network.setCookie` 把 `sessionid` / `sid_tt` / `uid_tt` 写成 30 天有效期的持久化 Cookie
- 写入 `data/login-state.json`
- 从 `/user/self` 读取昵称与抖音号，保存为账号显示名

> **不要**把生成的 `chrome-profile/`、`cookies.json`、`login-state.json` 提交到任何仓库。

`ARCHITECTURE.md` 对这一步的解释是：扫码必须用有头 Chrome，会短暂弹出 Chrome 窗口，与「不要抢焦点」冲突，因此只能**一次性、按需触发**，不能常驻。

### 4. 启动抓取

```bash
# 前台运行（观察日志）
node scripts/app.mjs hunter

# 7×24 后台守护（推荐，AGENTS.md 与上一版 README 同一行命令）
BASE="$PWD/douyin-auto"
nohup bash scripts/run-h35.sh "$BASE" >> "$BASE/h35-supervisor.log" 2>&1 &
tail -f "$BASE/h35.log"

# 或用封装脚本
bash scripts/fudai.sh start
bash scripts/fudai.sh status
bash scripts/fudai.sh restart
bash scripts/fudai.sh stop
```

`ARCHITECTURE.md` 给出的 `cd scripts` 后的等价命令：

```bash
./fudai.sh status
./fudai.sh start
./fudai.sh web
./fudai.sh accounts list
./fudai.sh accounts add N
./fudai.sh accounts import N
./fudai.sh start-all
./fudai.sh report --all
./fudai.sh follow
```

> 重启必须用 `./fudai.sh stop`。`AGENTS.md` 记录：手工 kill 只杀 supervisor 时，已经脱离成父进程 1 的 node 子进程会变成孤儿继续跑，造成双实例抢同一个 Chrome 端口；2026-11-02 实际踩过，两个 hunter35 同时运行、日志互相覆盖。

### 5. 启动看板

```bash
node scripts/app.mjs web          # 或 bash web/run-web.sh 8899
# 浏览器打开 http://127.0.0.1:8899
```

### 6. 每日必做：先自检，再看数据

```bash
bash scripts/check-alive.sh
```

输出含义：

| 输出 | 含义 | 处理 |
|:---|:---|:---|
| `OK len=N` | Cookie 齐全、页面渲染正常 | 继续 |
| `LOGIN_EXPIRED missing=...` | 登录态失效，福袋不可见 | 立即重新扫码登录 |
| `SUSPECT_SHORT_PAGE` | Cookie 在但页面像未登录页 | 截图确认 |
| `EMPTY_PAGE` | 页面 13 秒仍为空 | 标签可能卡死，重建标签 |
| `ERR ...` | CDP 端口无响应 | 检查 Chrome 是否在运行 |

> 这一条是血的教训：登录态失效后系统曾**盲跑 18 小时、整夜 0 福袋**，而「看不见」和「真的没有」在日志里表现完全一样。任何「今天怎么一个福袋都没有」的怀疑，第一步都必须是自检。

---

## 六、核心实现

### 6.1 房间池双源采集

首页推荐流实测硬上限是 20 个房间，滚动 35 次、等待加到 1200ms 也拿不到更多（`AGENTS.md`）。因此同时采集分类页，合计约 49–59 个候选：

```js
// 首页推荐流 + 分类页串行采集（并发会卡死 Chrome 渲染进程）
// 游戏分类 4_103、音乐 4_102、舞蹈 4_105、生活 4_107
```

`AGENTS.md` 记录的具体数字：首页推荐流 20 个 + 游戏分类页 `https://live.douyin.com/categorynew/4_103` 合计 49 个，采集耗时只多约 15 秒；四个分类页按轮次轮流采集，不并发（之前 4 标签并发会让 Chrome 渲染进程卡死，采集 timeout、直播间永远 `len=20`，已回退串行）。当前 README 记「6 个轮次里游戏占 3」以适配用户指定的 6 个游戏类主播。

### 6.2 评分与 VIP 主动探测

历史 92% 的成功参与集中在少数几个房间，而它们常年不在首页推荐流里。因此每轮主动探测最多 2 个不在首页的 VIP 房，探不到就冷却 30 分钟，防止硬探触发限流。评分维度：

- 历史可抢次数 `joinable` 给基础加分（45 次可抢 → +28）
- 发袋率 > 60% 额外加分；访问多次无福袋按 2-3 次 / 4-5 次 / 6 次以上分档惩罚
- 游戏娱乐类加分、带货类减分
- VIP 房强制排最前，且豁免在线人数门槛（仅留 500 人绝对底线）
- 官方媒体直播间跳过（央视、CCTV、新华、人民网等），福袋金额太小

`AGENTS.md` 的房间优先级：粉丝团型房间降权 → VIP 房优先 → 最近没去过的普通房优先 → 分数。VIP 扣分封顶 20，避免被 dry/fans 惩罚压到负分。

**在播判定**：能解析到 `online >= 0` 就算在播。只按页面长度 `len > 400` 会误杀（实测某在播房间 `online=3465` 但 `len=358`）。首页出现但拿不到在线数的 VIP 房也要进候选，不能因为 `online=-1` 被过滤掉。

**架构真相（`AGENTS.md`）**：数字房间号是「某一场直播」的唯一 ID，主播下播后该房间永久失效，探测只会一直返回 `null`；所以只有**抖音号形式**的直播间能长期盯。

### 6.3 福袋识别

```js
// 实际使用的 DOM 选择器（抖音改版会失效，故有快照存档）
document.querySelectorAll('[class*="LMUtLyr9"]')      // 福袋图标容器
  ├─ [class*="KXLj31kc"]                             // 图标
  ├─ [class*="ycjwPFJI"]                             // 倒计时
  └─ 向上找 ShortTouchContainer                      // 点击容器
```

`ShortTouchContainer > .redpacket` 空占位表示「有福袋位但当前无福袋」，是正常状态，不是故障。识别到福袋会把真实 DOM 存进 `data/fudai-dom-samples.jsonl`，用于抖音改版后比对选择器。

**去重窗口 12 分钟**：福袋倒计时实测最长 10 分钟，早期用「房间 + 倒计时」做 key，倒计时每秒变化导致同一个福袋被记录 21 次；6 分钟窗口仍会让同一福袋跨窗口重复。现在按「房间 + 账号 + 12 分钟滑动窗口」去重，抓取侧与看板 / 报表口径一致。

### 6.4 参与动作

| 场景 | 处理 |
|:---|:---|
| 评论型 | 点击福袋 → 找「一键发评论参与福袋」→ 点击 → 复查按钮状态 |
| 需要关注 | 先关注主播，成功判定包含「关注按钮消失」（实测抖音成功后按钮直接变「加粉丝团」，不显示「已关注」） |
| 粉丝团型 | 点击「加入粉丝团（1钻）」→ 关闭可能的阻挡弹窗 → 重扫参与按钮 → 记录 1 钻消耗到 `data/coin-spend.jsonl` |
| 抖币不足 | 识别「钻石余额不足 / 请充值 / 扫码支付」，返回 `fans-no-coins`，但仍会再尝试一次参与按钮 |
| 人气红包 | 单独识别「人气红包」文案，点击「抢 / 抢红包」 |
| 倒计时不足 180 秒 | 跳过（实测点不开面板） |

`joinFansGroup` 的按钮文案用 `startsWith` 匹配「加入粉丝团（1钻）」这类带括号后缀的写法；参与成功后才关注该主播。

### 6.5 守候开奖

参与成功后按福袋倒计时守候，扫描居中浮层文案判断中奖 / 未中奖，分别写入 `data/wins.jsonl` 与 `data/losses.jsonl`。**守候时长不受 `scale` 影响**——砍半会提前离开、丢掉开奖结果。`data/wait-config.json` 的 `note` 逐字写明：2026-11-05 新增 `drawBufferSec` / `drawMaxSec` / `drawFallbackSec` 三个守候开奖参数，仍不受 `scale` 影响；倒计时解析失败时的兜底从 600 秒提到 900 秒。

循环结束后无条件截一张 `h35-DRAWEND-*.png`，即使文案改版导致检测漏判，也能事后人工核对。

### 6.6 跨进程安全的共享学习档案

双实例同时写 `data/anchors.json` 会互相抹掉成果。`scripts/shared-json.mjs` 用 `fs.openSync(lock, 'wx')` 独占创建锁 + 临时文件 `rename` 原子替换：

- 陈旧锁超过 5000ms 自愈
- 抢锁超时 3000ms，重试间隔 20ms
- 抢锁失败降级为无锁原子写，**绝不阻塞 7×24 主循环**
- 10 进程 × 100 次并发自增验证：结果恰好 1000，零丢失

> 以上四项参数来自上一版 README，请以 `shared-json.mjs` 源码为准。

---

### 6.7 策略演进（截至 2026-11-17）

系统的策略不是一次性设计，而是按实测数据持续调整。当前生效的组合：

| 时段 | 在线人数门槛 | 粉丝团策略 |
|:---|:---|:---|
| 白天（0-18 点，含凌晨） | **≥100 人**，不设上限 | 只抢「本账号已加过团」的直播间 |
| 晚间（19-24 点） | **≥20000 人** | 同上 |

**关注门禁**：抢福袋**之前**必须确认已关注，判据是三条同时成立 —— 页面渲染完成（`bodyLen>=200`）+ DOM 直查无「关注」按钮 + 头部有已关注态组件（`+加粉丝团` / `加会员` / `1粉丝团`）。三者缺一按「不确定」拦截，宁可少抢也不虚报。

**粉丝团白名单**：判定源是 `data/coin-spend.jsonl` 的 `action=join-fans-group` 历史记录，**按账号隔离**。当前主号 73 个房间、main3 42 个房间可抢粉丝团福袋；其余房间遇到粉丝团福袋记 `fans-skip-not-member` 跳过，不花钻。

**被否决的策略**（有实测依据，不要重试）：

| 策略 | 否决原因 |
|:---|:---|
| 白天只抢 200 人以下小房 | 小房福袋密度过低，1 小时只遇到几个，产出不足以覆盖机会成本 |
| `max_time` 链式翻页拉全关注列表 | 相邻页重叠 19/20，拉 293 人要 95 秒以上，福袋倒计时等不起 |
| 遇 `fans-panel` 就 reload 重判 | 实测 6 次触发 0 次挽回，反而引入导航副作用 |
| 用 Escape 键关闭粉丝团浮层 | 会让页面多出一层全局导航，头部组件被替换，验证彻底失效 |
| VIP 豁免在线门槛（`vipExempt:true`） | 实测会让大量低人气 VIP 房白占常驻时间，当前 `false` 硬卡 |

---

## 七、配置参数表

所有用户可调参数集中在 `data/*.json`，**代码只读不写死**。历史上「同一个值在多处硬编码」的病发作过三次（门槛三份、去重两份、主播名单两份），每次都是改一处漏一处，故固化为硬规则：**任何用户可调的配置值，出生即放 `data/*.json`**。

> 本节数值均为 2026-11-17 13:06 实测读取，与本机运行时完全一致。

### `data/threshold.json` — 分时段在线人数门槛

| 字段 | 当前值 | 单位 | 含义 |
|:---|---:|:---|:---|
| `day` | **100** | 人 | 白天最低在线人数（含凌晨 0-6 点） |
| `night` | **20000** | 人 | 晚间最低在线人数 |
| `nightStart` | 19 | 时 | 晚间起始小时 |
| `nightEnd` | 24 | 时 | 晚间结束小时 |
| `vipExempt` | `false` | 布尔 | VIP 房是否豁免门槛。`false` = 所有房间（含 VIP）一律按 day/night 硬卡 |

**调整历史**：1000 → 5000 → 3000 → 10000 → 8000 → **100**（2026-11-10）→ 夜间 50000 → **20000**（2026-11-10 晚，因 50000 门槛下 60 个房间只有 3 个达标）。
2026-11-17 曾短暂尝试「白天上限 200 人抢小房」，实测小房福袋密度过低，同日回退。

### `data/wait-config.json` — 等待与守候

| 字段 | 当前值 | 单位 | 乘 `scale` 后 | 含义 |
|:---|---:|:---|---:|:---|
| `scale` | 0.125 | 倍率 | — | 等待时间倍率，代码限制在 0.1–2 |
| `drawBufferSec` | 60 | 秒 | **不受 scale 影响** | 守候开奖附加缓冲 |
| `drawMaxSec` | 1200 | 秒 | 不受 scale 影响 | 守候开奖上限 |
| `drawFallbackSec` | 900 | 秒 | 不受 scale 影响 | 倒计时解析失败时的兜底 |
| `perRoomMinMs` / `perRoomMaxMs` | 480000 | 毫秒 | **60 秒** | 普通房常驻 |
| `vipMinMs` | 480000 | 毫秒 | 60 秒 | VIP 房常驻 |
| `highYieldMs` | 480000 | 毫秒 | 60 秒 | 历史高频发袋房常驻 |
| `noFudaiNormalMs` | 600000 | 毫秒 | 75 秒 | 无福袋提前换房（普通） |
| `noFudaiVipMinMs` | 600000 | 毫秒 | 75 秒 | 无福袋提前换房（VIP） |
| `emptyRoundStepMs` / `emptyRoundMaxMs` | 480000 / 600000 | 毫秒 | 60 / 75 秒 | 空轮退避首轮 / 上限 |
| `postDrawWaitSec` | 120 | 秒 | — | 开奖后同房间继续蹲新福袋（不设轮数上限） |

**`probeQuota`（按账号的探测资源倾斜）**：

| 账号 | `pinned` | `other` | `candLimit` | `perMsScale` | `quietSkipResults` |
|:---|---:|---:|---:|---:|:---:|
| `main` | 2 | 4 | 8 | 1.5 | — |
| `main3` | 1 | 1 | 3 | 1 | `true` |

`quietSkipResults:true` 让该账号「注定抢不到」的结果（`need-follow` / `fans-skip-daytime` / `fans-skip-not-member`）写入降噪档案 `data/probe-skip.jsonl`，不再污染看板参与率。

> **配置约束**：`noFudai*` 与 `emptyRound*` 乘完必须 ≥ 常驻时长，否则会出现「还没待够就被切走」或频繁重采触发限流。
> **守候开奖永远不乘 `scale`**：砍半会提前离开、丢失开奖结果。

### `data/follow-config.json` — 关注门禁与粉丝团策略

| 字段 | 当前值 | 含义 |
|:---|:---|:---|
| `enabled` | `true` | 关注功能总开关 |
| `requireFollowBeforeJoin` | `true` | 抢福袋**之前**必须关注（面板是全屏遮罩，打开后关注按钮就点不到了） |
| `allowInconclusive` | `false` | 关注态不确定时是否放行。`false` = 宁可少抢也不虚报 |
| `verifyRetryMs` | 4000 | 点击关注后的验证重试间隔 |
| `retryCooldownMs` | 45000 | 关注拦截后的同房间重试冷却 |
| `maxFailsPerRoom` | 3 | 同房间最多重试次数（主号） |
| `maxFailsPerRoomByAccount.main3` | 1 | main3 关注写操作受限，重试纯浪费，降到 1 |
| `sharedProbePool` | `true` | 两账号共享探测池，避免同房间重复探测 |
| `daySkipFansGroup` | **`false`** | 白天是否完全不碰粉丝团。2026-11-17 置 false，由下条接管 |
| `fansJoinedOnly` | **`true`** | **粉丝团福袋只抢「本账号以前加过粉丝团」的直播间**（续团也抢） |
| `skipFollowAccounts` / `skipFansGroupAccounts` | `[]` | 账号级免关注 / 免粉丝团白名单（当前均为空） |

**`fansJoinedOnly` 的实现**：判定源是 `data/coin-spend.jsonl` 里 `action=join-fans-group` 的历史记录，**按账号隔离**（主号 73 个房间、main3 42 个房间）。没加过的房间遇到粉丝团福袋记 `fans-skip-not-member` 跳过，不花钻、不在面板上反复试探。

### `data/danmu-config.json` — 拟人化弹幕

| 字段 | 当前值 | 含义 |
|:---|:---|:---|
| `enabled` | `true` | 弹幕总开关 |
| `accounts` | `["main"]` | 只让主号发弹幕（避免机器账号特征） |
| `minIntervalSec` / `maxIntervalSec` | 90 / 220 | 两次弹幕的间隔区间 |
| `maxPerWait` | 3 | 单次守候最多发几条 |
| `skipChance` | 0.35 | 随机跳过概率，让节奏像真人 |

内置 6 类共 70 条文案，按房间氛围分类抽取。

### `data/notify-config.json` — Server酱 中奖推送

| 项 | 值 |
|:---|:---|
| 接口 | `https://sctapi.ftqq.com/{key}.send` |
| 触发条件 | **仅真中奖**（`--win --from-hunter`）；手工调用默认 dry-run |
| 免费额度 | 5 条/天 |
| 安全 | `sendKey` 只存本地，永不入库、永不打印 |

### `data/hot-rooms-config.json` — 跨账号热房信号

| 字段 | 当前值 | 含义 |
|:---|:---|:---|
| `enabled` | `true` | 热房共享总开关 |
| `fudaiTtlSec` / `liveTtlSec` | 300 / 180 | 福袋信号 / 在播信号的存活时间 |
| `maxSignalAgeSec` | 240 | 超过此龄的信号直接丢弃 |
| `insertMaxPerGap` / `roundInsertCap` | 2 / 4 | 每次插入上限 / 每轮插入上限 |

一个账号发现「正在发福袋」的房间后会写入 `data/hot-signal-*.json`，另一个账号在下一次选房时插队进入，让探测资源真正共享。

### `scripts/run-h35.sh` — supervisor 实际值

| 常量 | 值 | 作用 |
|:---|---:|:---|
| `CACHE_MAX_MB` | 500 | Chrome 缓存超阈值回收 |
| `PORT` 默认 | 9750 | 显式传入 > `meta.json` 登记 > 9750 |
| 日志截断 | 20 MB，保留 5000 行 | `tail -5000` 覆写 `h35.log` |
| 重启间隔 | 20 秒 | hunter35 退出后重新拉起 |
| 6 小时自转 | `HUNTER_MAX_RUN_MS` | 主动退出释放 Chrome 内存（`rc=0` 属健康） |

> 2026-11-07 起，截图清理与日志轮转已从 supervisor 的 while 循环中**移出**，改由独立的 `runtime-cleaner.sh` 负责。原因：写在阻塞式 `node hunter35.mjs` 之前的代码在 7×24 下永不执行，是死代码。

### 其他配置与文件

| 文件 | 用途 |
|:---|:---|
| `scripts/blacklist-rooms.txt` | 每行一个房间号，永不访问 |
| `scripts/known-fudai-hosts.txt` | VIP 房间池，**追加后必须检查末尾换行**（历史上粘过行） |
| `data/auto-blacklist.json` | 自动学习出的「不发福袋」房间黑名单 |
| `data/hour-windows.json` | 学习出的各房间开播时段，未开播时不去探测 |
| `data/probing-cache.json` | 关注名单缓存（每小时后台全量刷新） |
| `package.json` | `type: module`、`bin: scripts/app.mjs`、`scripts` 含 `start` / `status` / `build:win` |

---

## 八、多账号并行

### 架构

| 项 | 实现 |
|:---|:---|
| 账号资料 | `accounts/<name>/`，各自独立 `profile`，Cookie 互不干扰 |
| 端口隔离 | 主实例 9750，账号实例从 `meta.json` 读端口并显式传 `DY_PORT` |
| 每实例独立 | 工作目录下的 `recent-rooms.json`、`dry-rooms.json`、`vip-cooldown.json`、`h35.log` 等 |
| 全局共享（追加安全） | `data/participations.jsonl`、`wins.jsonl`、`losses.jsonl`、`coin-spend.jsonl`，每条带 `account` |
| 全局共享（覆盖写，需加锁） | `data/anchors.json`、`data/room-names.json` |

`ARCHITECTURE.md` 补充两条设计约束：抖音对同一 IP 多账号同时活跃有风控，故**默认单账号运行**、多账号逐个启用，每个账号独立端口（9750、9751、9752…），若同时启用需错开采集时间；P4 的 `start-all` 采用错峰 30 秒。

### 启动第二个账号

```bash
node scripts/account-manager.mjs add main2      # 扫码登录并写入 meta.json
bash scripts/fudai.sh start-acc main2 --force  # --force 用于内存紧张时跳过阈值
```

### 账号显示名统一

同一个主账号在数据里叫 `default`、实例列表里叫 `main`、UI 里叫「主实例」，三套代号曾导致用户分不清是谁抢的。现在 `web/server.mjs` 的 `accountLabels()` 从 `accounts/*/meta.json` 读昵称 + 抖音号后 4 位，统一成「昵称(尾4位)」，并在每条福袋事件上显示彩色账号徽标。`--account main` 与 `default` 在报表中归一为同一账号。

### 资源实测（16GB 机器，上一版 README 数据）

| 指标 | 单实例 | 双实例 |
|:---|---:|---:|
| 主 Chrome RSS | 1081 MB | 1081 MB |
| 第二 Chrome RSS | — | 993 MB |
| 空闲内存 | 约 400 MB | 123–154 MB |
| swap 已用 | 1617 MB | 1618 MB |
| load | 7.46 | 11.48 |

双实例下空闲内存长期低于 200MB，属紧平衡。`start-acc` 的 `mem_ok()` 阈值（空闲 900MB）会拒绝启动，需 `--force`。

---

## 九、Web 看板

### 9.1 本地看板

启动后访问 `http://127.0.0.1:8899`，单屏多卡布局（桌面 3×2、手机自动堆叠）：

| 卡片 | 内容 |
|:---|:---|
| 今日总览 | 主号参与率（大字）+ 主/探测号/合计（小字）、中奖数、门槛 |
| 福袋事件 | 每条带彩色账号徽标、房间名、结果、在线人数；`cd` 回升视为新福袋 |
| 最近日志 | 最近运行日志 |
| 指定主播状态 | 在播 / 未开播 / 待探测、开播时间、历史发袋、未到时段标记 |
| 历史总数据 | 6 分区，复用 `dedupRows` 后的 `rows`，与 `stats.allTotal/allJoined` 同源恒等；保留已删除账号 main2 的历史 |
| 账号 · 今日战绩 · 运行实例 | 分账号遭遇/参与、各实例端口与状态 |

**看板侧的两个统计口径修正**（历史上出过错）：

1. **`dedupRows` 用 12 分钟滑动窗口**，不是固定桶。固定 6 分钟桶的边界会把同一个福袋切成两个（实测同一福袋横跨 02:14–02:21，正好跨过 02:18 边界）。
2. **去重 key 含账号维度**。原为「房间+12分钟」，两个账号同房间各抢一次会被合并成 1 次。

**`dedupEventRows()` 只用于事件流水**（`cd` 回升 = 新福袋），统计仍用保守的 `dedupRows`。

### 9.2 公网只读看板

手机等外网设备可通过 Cloudflare 临时隧道访问同一份数据：

```
公网 <随机>.trycloudflare.com
   ↓ quick tunnel（只连 8898）
127.0.0.1:8898  public-readonly.mjs（只读代理）
   ↓
127.0.0.1:8899  正式看板
```

| 特性 | 说明 |
|:---|:---|
| 权限 | **GET 白名单，POST / 非白名单路径一律 403**。手机上没有启停按钮是设计如此，不是故障 |
| 守护 | `web/run-public.sh` 单实例锁 `/tmp/fudai-public.lock`，域名写入 `/tmp/fudai-public-url.txt` |
| 自愈 | 隧道僵死（Cloudflare error 1033 / `retry-after: 120`）会被守护检测并重建 |
| 域名 | **临时域名，隧道重建后会变**。要固定需配自有域名的命名隧道 |

> ⚠️ **绝不要 `pkill -f cloudflared`**：会连带杀掉本机其他 quick tunnel 与命名隧道，断掉远程访问。
> 停公网入口只能按 `tunnel --url http://127.0.0.1:8898` 精确匹配。

### 9.3 接口与运维

`GET /api/status` 返回 JSON，含 `stats`、`byAccount`、`accountLabels`、`recentEvents`、`instances`、`pinned`、`threshold`、`exec` 等字段。

`run-web.sh` 特性：单实例 `mkdir` 原子锁、端口占用检查（不抢已监听端口）、10 秒自愈重启。
历史事故：曾同时跑 12 个 supervisor 互相抢 8899，`fseventsd` 吃 50% CPU、8 核机器 load 冲到 56，而真正提供服务的只有 1 个 server。

**「按天」必须用本地时区**——记录里的 `at` 是 UTC ISO 字符串，北京 0-8 点的记录 UTC 日期还是前一天，直接用 `startsWith(本地日期)` 会整批漏掉。项目内统一用 `localDay()` / `isLocalDay()`。

---

## 十、数据报表

```bash
node scripts/data-report.mjs                  # 今日战况，含分账号统计
node scripts/data-report.mjs --all           # 全部历史
node scripts/data-report.mjs --account main2  # 只看某个账号（main 与 default 等价）
node scripts/daily-report.mjs                # 生成 reports/YYYY-MM-DD.md
node scripts/export-csv.mjs                  # 导出今日 CSV（带 BOM，Excel 可直接打开）
node scripts/export-csv.mjs --all            # 导出全部历史
```

三份报表与看板使用同一套「房间 + 账号 + 12 分钟滑动窗口」去重逻辑，保证数字一致。

> 历史统计口径提醒（`AGENTS.md`）：12 分钟窗口与本地时区修复前的数字不可直接采信，参与率曾被严重低估；修复前「房间 + 倒计时」去重曾把同一福袋记录 21 次。

---

## 十一、Windows 绿色分发版

仓库内**不含** `dist/douyin-fudai-windows.zip`（21MB，自带 `node.exe`）。它是本机打包产物，如需在另一台 Windows 电脑使用，需自行按 `docs/分发说明.md` 生成，或向维护者索取。`AGENTS.md` 亦记「Windows 绿色版：`dist/douyin-fudai-windows.zip`（自带 `node.exe`，双击 `START.bat`）」。

绿色包结构：

```text
portable/
├── START.bat              启动（含登录态检查）
├── STATUS.bat             状态查询
├── node.exe               Node v22.23.4 win-x64
├── README-使用说明.md
├── scripts/               核心脚本
├── web/                   看板
└── data/                  配置与学习档案
```

**跨电脑使用注意**：旧版本存在「提示登录态已保存，随后又说未检测到登录态」的问题。根因是 Chrome 96+ 把 Cookie 放在 `Default/Network/Cookies`，而旧判定只看 `Default/Cookies`。现已改为三重判定（`login-state.json` + 两个 Cookie 路径）。换电脑时保留 `douyin-auto/chrome-profile/`，用新版覆盖即可，无需重新扫码。

---

## 十二、已知问题与限制

> 本节按 **2026-11-17 13:06** 实测状态整理，已剔除上一版中已修复或已失效的条目。剩下的每条都标注了真实依据。

### 12.1 核心限制（必须知道）

| # | 问题 | 现状与影响 |
|:---|:---|:---|
| 1 | **1845 次开奖 0 中奖** | 截至 2026-11-17，`losses.jsonl` 记录 1845 次未中奖，`wins.jsonl` 为 **0 条**。已用截图交叉验证（`h35-DRAWEND-*.png` 中弹窗文案为 `没抽中福袋｜送你一个好运气~`），**确认是真未中奖，不是检测漏判**。根因推断为参与高度集中在大房（top10 房间占 43.4% 参与量，单房最多 258 次），上万人参与的福袋把中奖率稀释到接近 0 |
| 2 | **DOM 选择器脆弱** | 抖音改版会让 `[class*="LMUtLyr9"]` 等选择器静默失效，表现是 `candCount=0`。已用 DOM 快照存档（`fudai-dom-samples.jsonl`）+ `check-alive.sh` 自检缓解，但改版后仍需人工跟进 |
| 3 | **开机自启受限** | macOS 的 `~/Downloads` 属 TCC 保护目录，launchd 启动的进程「能写不能读」（实测 `ls`/`head` 均 `Operation not permitted`，`date > 文件` 却成功，exit 126）。当前靠 `nohup` + supervisor 守护，**电脑重启后需手工拉起或由守护会话拉** |
| 4 | **`candCount=0` 有四种可能原因** | (a) 采集端失效 (b) 真的没福袋 (c) **服务端登录态失效** (d) 账号不可见。前两种靠自检区分；第三种必须看页面是否有「需先登录」文案（Cookie 存在 ≠ 会话有效）；第四种必须做同房间双账号对照实验才能定性 |
| 5 | **粉丝团福袋受抖币余额约束** | 账号无抖币时抖音弹「钻石余额不足，请充值」，系统无法代付，返回 `fans-no-coins`。当前策略为「只抢已加过团的直播间」，已最大化规避 |
| 6 | **`fansJoinedOnly` 依赖历史记录** | 白名单来自 `coin-spend.jsonl`。若手动清理过该文件，会退化为「所有粉丝团福袋都不抢」，需重新加团才能恢复 |

### 12.2 运行时特性（容易误判为故障）

| # | 现象 | 正确解读 |
|:---|:---|:---|
| 7 | 进程每隔 6 小时自己退出 | `hunter35.mjs` 有主动自转逻辑，运行满 6 小时 `process.exit(0)` 释放 Chrome 内存，supervisor 20 秒后拉起。**`rc=0` 是健康状态**，`rc=143` 是手工 SIGTERM |
| 8 | 自检报 `LOGIN_SUSPECT` / `EMPTY_PAGE` | 导航瞬态。判据是 `needLogin=false` 即未掉线。VIP 主动探测期间（页面停「直播加载中」）尤其常见，等 28 秒探测周期走完自行恢复 |
| 9 | 双实例内存紧平衡 | 空闲内存常低于 200MB、swap 2–4 GB 属正常区间；`free <20%` 才算真压力 |
| 10 | `load` 瞬时很高 | 需看 `top -l 2` 第二快照归因。实测大头常是用户自己的 Chrome、`WindowServer`、`mds_stores`（Spotlight）、`dsh web` 本身，抓取 Chrome 的 GPU 进程通常接近 0% |
| 11 | 日志只有 `HH:MM:SS` 且跨天追加 | 判断「某行属于哪个进程」**必须**先找最后一条 `=== hunter35` 启动行再切尾部，不能只按时间字符串过滤（会混入旧进程记录） |
| 12 | `main3` 大量 `need-follow` | 该账号关注列表只有 14 人，遇到未关注主播必然拦截。已通过 `quietSkipResults` 降噪，不进看板参与率 |
| 13 | `pinned` 卡片显示「未到时段」 | 用户指定主播不在开播时段，属正确行为，不是 bug |

### 12.3 已知缺陷与待办

| # | 问题 | 说明 |
|:---|:---|:---|
| 14 | `ws-dead` 无 CDP 重连 | `collectRooms().grab()` 遇到 WebSocket 断开不重连，只能等 supervisor 重启。开奖检测路径已有重连（2026-11-09 加），采集路径尚未 |
| 15 | `scripts/fudai.sh` 账号参数有缺陷 | `account_pids('main')` 前缀匹配会把 `main3` 也算进去；`cmd_restart` 账号归属也有错位。**规避方式**：重启主实例用 `bash scripts/fudai.sh restart`，不要用 `stop-acc main` |
| 16 | 归档诊断脚本未入库 | 本机 `scripts/` 下有大量 `test-*/diag-*` 历史脚本仍写死 macOS 绝对路径，**未纳入本仓库**。核心脚本已由 `scripts/paths.mjs` 统一路径 |
| 17 | 单文件 exe 缺失 | 交叉编译需从源码构建 Node base binary，实测 3800+ 目标文件、约 90 分钟且撑爆磁盘（临时目录 12GB），改用等效绿色包 |
| 18 | `status.sh` 与看板口径不同 | `status.sh` 读单实例日志，看板读全局 jsonl 并做 12 分钟去重，两者数字天然不同，属已知差异 |
| 19 | 明文凭据文件会产生 | `.gitignore` 已逐项排除 `scripts/cookies.json`、`**/Cookies`、`.env`、`*.token`、`*.pem`、`**/login-state.json`。**若 Cookie 曾误入仓库，删除文件无效，必须重新扫码使旧 session 失效并清理 Git 历史** |

### 12.4 历史统计口径提醒

| # | 说明 |
|:---|:---|
| 20 | **跨天统计必须用本地日**：北京时间 0-8 点期间 UTC 还停在前一天，用 `toISOString().slice(0,10)` 取「今天」会错位；用 `startsWith(today)` 比 UTC ISO 字符串更会漏掉整批记录。正确做法是转本地日期再比 |
| 21 | **2026-11-04 之前的参与率不可信**：当时去重 key 含每秒变化的倒计时，同一个福袋会被记 21 次，参与率被严重低估 |
| 22 | **`need-follow` 次数 ≠ 丢袋数**：45 秒重试能挽回相当比例（实测今日 15 次中 8 次挽回）。统计损失要同时看拦截数与挽回数 |
| 23 | **`wins.jsonl` 与 `h35-results.jsonl` 的关系**：后者是 100% 重叠的旧副本，`backfill-coin-spend.mjs` 只取 `participations.jsonl`，合并会虚增消费 |

---

## 十三、合规与安全声明

### 上传范围

本仓库采用**源码白名单**发布。以下内容**从未进入 Git 提交**：

- 任何账号的 `sessionid` / `sid_tt` / `uid_tt` 等登录 Cookie
- `chrome-profile/` 与 `accounts/` 下的 Chrome 用户资料
- `scripts/cookies.json` 等明文凭据文件
- 真实参与流水、中奖记录、房间学习档案等运行数据
- 本机绝对路径与真实账号昵称 / 抖音号（注释中的示例已脱敏）

`.gitignore` 采用默认排除 + 显式放行策略。**提交时只用 `git add <具体文件>`，禁止 `git add .`**。

上一版 README 声称仓库自带 `scripts/precommit-check.mjs` 门禁，扫描暂存区全部内容，命中真实账号昵称 / 抖音号 / Cookie 值 / token 前缀即以非零退出拒绝提交：

```bash
node scripts/precommit-check.mjs
cp scripts/precommit-check.mjs .git/hooks/ 2>/dev/null || true
echo 'node scripts/precommit-check.mjs' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

> 注意：该脚本未见诸已核对的源文件清单（见「十二」第 17 条），上述命令请先在仓库内确认文件存在再执行。

### 使用边界

- 本项目是**个人自动化工具**，仅用于自己的账号，不提供任何批量注册、刷量、破解、绕过风控或代抢服务。
- 项目不调用抖音非公开接口，所有操作都在真实浏览器页面上完成，与普通用户手动点击等价。
- 抖音网页版的结构、规则与用户协议可能随时变化，**使用者需自行确认并承担合规责任**。平台若明确禁止自动化访问，应停止使用。
- 加入粉丝团会消耗抖币等虚拟资产，相关授权由使用者自行决定。
- 作者不对账号受限、资产消耗、数据丢失或任何间接损失负责。

### 如果凭据曾误入仓库

若怀疑 Cookie 或 token 被提交过，**删除文件无效，必须立即轮换凭据**（重新扫码登录使旧 session 失效），并清理 Git 历史。上一版 README 记「本仓库首版发布前已做全文扫描，未发现凭据入库」。

---

## 十四、开发历程与踩坑记录

完整的逐日复盘在 `AGENTS.md`（上一版 README 记约 40KB）与 `docs/incidents/`，这里列影响最大的几条：

| 日期 | 事件 | 结论 |
|:---|:---|:---|
| 2026-11-02 | 去重 key 用「房间+倒计时」 | 倒计时每秒变，同一福袋被记 21 次；改 12 分钟滑动窗口 |
| 2026-11-02 | 「暂停视频省 CPU 99%」的旧结论 | 实测反例：视频已 paused 但 Chrome 仍 154% CPU；真正开销在弹幕与礼物动画，三连注入后按 `AGENTS.md` 记录降到 31.3% |
| 2026-11-02 | 指定主播从未被探测 | 排序时 `lastFudaiAt` 为空导致永远排末位；改为候选直接取配置全集、按来源分池固定分配名额 |
| 2026-11-02 | 用户指定 6 个主播在线数仅 5847-9831，全低于晚间 10000 门槛 | VIP 豁免在线门槛、F 值检测同步豁免、扣分封顶 20、VIP 永远排最前，共 8 项修复 |
| 2026-11-02 | `checkOnline` 只等 16 秒即判未在播 | 主力房连续失败 9 次险被自动淘汰；改为 24 秒、区分「真下播」与「探测失败」（后者只等 3 分钟且不计失败次数） |
| 2026-11-03 | 登录态失效盲跑 18 小时 | 「看不见」与「没有」表现一样；固化 `check-alive` 为巡检第 0 步 |
| 2026-11-03 | supervisor 清理了不存在的 profile 目录 | 账号模式 profile 是 `accounts/<名字>/profile`，缓存回收曾完全失效；端口写死 9750 也会让实例 B 跳过回收 |
| 2026-11-03 | 12 个看板 supervisor 抢 8899 | `fseventsd` 50% CPU、负载 56；加 `mkdir` 单实例锁 + 端口占用判断 |
| 2026-11-04 | 跨天统计双重 UTC 陷阱 | `toISOString()` 取 UTC 日期 + 记录存 UTC 却按本地日期比字符串，两个 bug 方向相反；统一 `localDay` / `isLocalDay` |
| 2026-11-04 | `DATA_DIR` 的 TDZ | 配置读取在声明之前，被空 `catch` 吞掉，配置「看起来生效、实际没读」；配置读取必须显式验证读到的值 |
| 2026-11-04 | 多账号「数据混乱」 | 数据层每条都带 `account`，乱在展示层漏字段 + 冗余数据源口径不一致；逐个盘点读写入口 |
| 2026-11-04 | 粉丝团「跳过」真相 | 截图显示是「钻石余额不足，请充值」，不是策略跳过；验证失败后仍应重扫参与按钮 |
| 2026-11-04 | 核心脚本跨平台化 | `scripts/paths.mjs` 统一应用根、数据目录、Chrome 探测、端口检测、进程终止；`hunter35.mjs` / `account-manager.mjs` / `web/server.mjs` / `app.mjs` / `check-alive.mjs` 不再含硬编码绝对路径 |
| 2026-11-05 | **关注点击被全屏遮罩挡住** | 73 次关注 71 次失败（45 次 `no-btn`）：旧代码只在福袋面板打开后关注，而面板是全屏遮罩，`elementFromPoint` 命中不到左上角按钮。改为**抢前在干净页面关注**，实测 3/4 能点上且持久 |
| 2026-11-05 | **「已关注」的 DOM 表现不是「已关注」三个字** | 干净对照实测：未关注时左上角是 `关注 G` 按钮；已关注后变成 `+加粉丝团`，页面既不显示「已关注」也不显示「互相关注」。旧探针只认文字，把已关注误判成 `no-btn`，当天 4 个福袋因此丢失 |
| 2026-11-05 | **`check-alive.sh` 报假 OK** | 9751 的 `len=20`（直播加载中）被「守候开奖」豁免规则放行，而该规则读的是**主实例**日志。修复：日志路径随端口切换；`len<60` 的空页面绝不被任何状态豁免 |
| 2026-11-05 | **Cookie 存在 ≠ 已登录** | main2 三项 Cookie 齐全且 `expires` 到 2027-01，但页面写着「需先登录」。旧自检只查 Cookie 名，连续 5 小时报 OK。修复：加「需先登录」文案 + 无评论框两条判据，排在 Cookie 判定之前且不受豁免 |
| 2026-11-05 | **SwiftShader 让 GPU 进程空转 260~377% CPU** | 首版就带着的两个无注释启动参数强制 CPU 软件光栅化。受控对照：swiftshader 512% → `--disable-gpu` 19%，页面渲染无损（福袋识别靠 DOM 不靠像素）。改后 load 13.3 → 4.51 |
| 2026-11-05 | **守候开奖冗余 180s → 60s** | 117 次守候样本：64 次检出弹窗全部**提前**（中位 -17s），180s 在成功路径上从未用到，只在漏判时白等。改 `drawBufferSec:60`，配置化且不乘 `scale` |
| 2026-11-06 | **截图/日志清理是死代码** | `run-h35.sh` 的清理段写在阻塞式 `node hunter35.mjs` 之前，7×24 下永不执行。与缓存事故同一病根。拆出独立 `runtime-cleaner.sh` 守护 |
| 2026-11-06 | **抖币记账三 bug** | `ev()` 返回 JSON 字符串被当对象读 / 验证表达式弹层切换 51 次 `__err` / `if(ok)` 才记账但真加入信号是 `hasJoinBtn`。修后 4 次真实粉丝团全部对象格式、0 次 `__err` |
| 2026-11-10 | **参与率被噪声稀释到 18%** | 三因素：(a) main3 的 193 条真实 `need-follow` 计入统计 (b) `pinned` 读的是冻结的旧日志 (c) pinned 主播确实不在时段。修复后 18.1% → 73~75% |
| 2026-11-10 | **白天门槛改为 100 人** | 用户定稿：白天 100、晚间 20000（50000 门槛下 60 个房间只有 3 个达标，大量空转） |
| 2026-11-13 | **抖音改了头部文案** | 从 `+加粉丝团/加会员` 变成 `1粉丝团 / 1粉丝团1钻石点亮`，旧正则匹配不到，7 个已关注房间被判 `no-follow-btn`。权威校验原本只在 `fans-panel` 分支，现合并到统一路径 |
| 2026-11-14 | **公网看板 530** | Cloudflare error 1033、`retry-after: 120`，隧道进程活着但边缘已死；旧守护的 `find_tunnel_pid` 有缺陷导致无法重建。修好后守护可全自动重建 |
| 2026-11-16 | **电脑重启导致停机 74 分钟** | TCC 限制使开机自启不可行，重启后所有服务消失。新增 `watchdog-down.sh`：连续 2 次确认抓取全停即推 Server酱告警，恢复时也推一条 |
| 2026-11-16 | **已关注被拦的真根因是「拉不全」** | 主号关注 289 人，但 `fetchFollowingSet` 用 `offset` 翻页，而抖音**完全忽略 offset**，每页都返同一批 20 人。uid 提取又恒为空（98/98 次），只能比昵称 → 第 283 位的「魅一」两路都查不到 → 误判未关注 |
| 2026-11-17 | **尝试 `max_time` 链式翻页拉全，否决** | 实测相邻页重叠 19/20，靠 `stall>=12` 硬扛，拉 293 人要 95 秒以上 — 福袋倒计时等不起。**最终定稿只拉第一页 20 人**：第一页就是「最近关注的那批」，而误判场景本质就是「刚关注不久、缓存没刷到」 |
| 2026-11-17 | **`fans-panel` 分支抢在「已关注」判定之前** | 用户质问「主号不是可以关注吗，需关注就关注啊」。CDP 实测某房间：无关注按钮、粉丝团浮层词 0 命中、头部有 `+加粉丝团` — 明明是已关注，却因 `fansPanel` 被判拦截。修法：条件加 `!st.followed`，已关注时不进该分支 |
| 2026-11-17 | **白天抢小房的尝试与回退** | 假设「大房参与人数上万稀释中奖率」，改为白天只抢 200 人以下。**实测小房福袋密度过低**（1 小时只遇到几个），当日回退到 100 人以上 |

**`AGENTS.md` 里的其他运维结论**（保留备查）：

- **标签级卡死自愈**：Chrome 某个标签坏掉后加载任何直播间都是 `len=20`「直播加载中」，重试和 reload 都无效，但新标签访问同一房间完全正常（`len=330+`）；修复是页面空白时立即关闭并重建标签。
- **大房间在线数**：大型赛事页显示「137.2万人看过」而不是「在线观众 1234」，原解析只认后者导致 `online=-1`，已加兜底匹配。
- **发袋率学习**：`anchors.json` 新增 `visits`，每次常驻 +1；按访问次数分档惩罚（2-3 次 +12、4-5 次 +30、6 次以上 +45），发袋率 >60% 则 -15。
- **空轮退避**：没有任何房间达到门槛时按 2/4/6/8/10 分钟递增，避免每 32 秒抓一次页面触发限流。
- **房间池四状态文件**：`recent-rooms.json`、`vip-cooldown.json`、`fans-only-rooms.json`、`dry-rooms.json`。
- **命中率历史基线**：早期 266 次福袋记录中成功参与 61 次、集中在 2 个房间，粉丝团型跳过 63 次。该统计来自「跳过粉丝团」的旧策略，当前策略下已不适用。

**通用教训**：性能结论必须当场实测；配置读取必须验证读到的值；任何「零结果」怀疑先自检采集端；新增维度后必须盘点所有读写入口。

---

## 十五、归属与许可证

- **归属**：本仓库为作者邓林的个人项目源码白名单发布，**非第三方副本**；`LICENSE` 原文为 `MIT License`，`Copyright (c) 2026 邓林`。
- **许可证**：[MIT](LICENSE)。权限、条件与免责声明以 `LICENSE` 全文为准（允许使用、复制、修改、合并、发布、分发、再许可与销售；须保留版权与许可声明；软件按「现状」提供，不含任何明示或暗示担保）。
- **外部组件**：运行时零第三方 npm 依赖，依赖的是 Node.js 22+ 内置的 `WebSocket` 与系统安装的 Google Chrome / Microsoft Edge；绿色分发包内置 `node.exe`。这些外部软件的权利归各自原作者，不在 MIT 授权范围内。
- **数据归属**：`accounts/`、`data/*.jsonl`、`chrome-profile/` 等运行数据与登录态不属于本仓库内容，也未随源码发布。

本项目按「现状」提供，不附带任何明示或暗示的担保。
