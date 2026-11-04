# 抖音福袋自动参与系统

> 基于 headless Chrome 与 Chrome DevTools Protocol 的抖音直播间福袋自动发现、参与与数据看板系统。
> 零第三方运行时依赖，纯 Node.js 内置模块实现，支持 macOS / Windows、多账号并行与 7×24 长跑。

---

## 目录

- [一、项目定位](#一项目定位)
- [二、当前状态](#二当前状态)
- [三、技术架构](#三技术架构)
- [四、目录结构](#四目录结构)
- [五、快速开始](#五快速开始)
- [六、核心实现](#六核心实现)
- [七、配置参数表](#七配置参数表)
- [八、多账号并行](#八多账号并行)
- [九、Web 看板](#九web-看板)
- [十、数据报表](#十数据报表)
- [十一、Windows 绿色分发版](#十一windows-绿色分发版)
- [十二、已知问题与限制](#十二已知问题与限制)
- [十三、合规与安全声明](#十三合规与安全声明)
- [十四、开发历程与踩坑记录](#十四开发历程与踩坑记录)
- [十五、许可证](#十五许可证)

---

## 一、项目定位

抖音直播间会不定时发放「福袋」，用户需在倒计时内完成指定动作才能参与，常见条件有三类：

| 类型 | 参与条件 |
|:---|:---|
| 评论型 | 发送指定评论 |
| 评论 + 关注型 | 关注主播并发送评论 |
| 粉丝团型 | 加入粉丝团（通常消耗 1 抖币）并发送评论 |

人工盯守需要持续刷新几十个直播间，且福袋出现时间不可预测。本项目用 headless Chrome 直接驱动抖音网页版，通过一个 CDP 长连接完成「采集房间 → 评分排序 → 逐个常驻 → 检测福袋 → 点击参与 → 关注主播 / 加入粉丝团 → 守候开奖 → 记录结果」的完整闭环，并提供本地 Web 看板实时展示战况。

**设计取舍**：不使用 Playwright / Puppeteer / Selenium，不调用任何非公开接口，只依赖 Node.js 内置的 `WebSocket` 直连 CDP。这样整套运行时**零第三方依赖**，只需要 Node.js 22+ 和系统已安装的 Chrome，绿色分发包体积才能压到 20MB 级别。

---

## 二、当前状态

| 项 | 状态 |
|:---|:---|
| 基线版本 | `hunter35.mjs`（第 35 代抓取主程序，1846 行） |
| 运行模式 | macOS 本机双账号并行，7×24 守护 |
| 已验证 | 双实例同时运行、共享学习档案加锁、看板分账号统计、扫码登录与登录态持久化 |
| 参与范围 | 评论型 / 关注型 / 粉丝团型 / 人气红包，全部尝试参与 |
| 单文件 exe | **未产出**。交叉编译定制 Node 二进制需约 90 分钟且撑爆磁盘，改用等效绿色包 |
| 自学习效果 | **尚未达到高准确度**，学习档案中约 15% 主播有足够样本，仍在持续调优 |
| 平台验证 | macOS 完整长跑验证；Windows 绿色包通过静态检查与真实启动验证，未做 7×24 长跑 |

> 本项目是持续迭代中的工程系统，不是已稳定验证的通用产品。请勿把上述「已验证」理解为「全平台长期稳定」。

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
    P["第二个账号 9751"] -.追加写入.-> L
    P -.加锁读写.-> O
```

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

### 为什么用 CDP 而不是其他方案

1. **零依赖**：Node 22 起内置全局 `WebSocket`，无需 `ws` 包。
2. **可控**：直接发 `Runtime.evaluate` / `Input.dispatchMouseEvent` / `Network.setCookie`，能精确处理登录态持久化与坐标点击。
3. **低开销**：配合「暂停视频 + 暂停所有动画 + 视频透明」注入，实测抓取 Chrome CPU 从 **154% 降到 4.2%**。
4. **可观测**：福袋 DOM 快照、开奖结束截图、逐轮诊断日志都可直接从页面取。

代价是 DOM 选择器会随抖音改版失效，因此代码里保留了福袋 DOM 样本存档与 `check-alive` 自检，避免「选择器瞎了」被误判成「主播不发袋」。

---

## 四、目录结构

本仓库采用**源码白名单**发布，只包含可复现运行所需的文件：

```
.
├── README.md                      本文件
├── LICENSE                        MIT
├── .gitignore                     登录态 / 运行时数据排除规则
├── package.json                   项目元信息与 npm 脚本
├── ARCHITECTURE.md                架构说明
├── 使用手册.md                    操作手册
├── 功能验收.md                    验收清单
├── 开发教训清单.md                踩坑汇总
├── 关注主播名单.md                主播开播时间表
├── AGENTS.md                      完整开发日志（含逐日事故复盘）
├── docs/
│   ├── 分发说明.md                Windows 绿色包使用说明
│   └── incidents/                 事故排查归档（已脱敏）
├── data/
│   ├── threshold.json             分时段在线人数门槛
│   ├── pinned-hosts.json          指定主播与开播时段
│   └── wait-config.json           等待时长倍率与基线
├── scripts/
│   ├── app.mjs                    统一入口
│   ├── paths.mjs                  跨平台路径与 Chrome 探测
│   ├── hunter35.mjs               抓取主程序
│   ├── shared-json.mjs            跨进程安全写入
│   ├── account-manager.mjs        扫码登录与账号管理
│   ├── check-alive.mjs / .sh      采集端自检
│   ├── fudai.sh                   启动 / 停止 / 重启 / 多账号
│   ├── run-h35.sh                 7×24 守护
│   ├── status.sh                  状态速查
│   ├── data-report.mjs            控制台数据报表
│   ├── daily-report.mjs           Markdown 日报生成
│   ├── export-csv.mjs             CSV 导出
│   ├── backfill-anchors.mjs       学习档案回填
│   ├── blacklist-rooms.txt        黑名单房间
│   └── known-fudai-hosts.txt      VIP 房间池
└── web/
    ├── server.mjs                 看板服务
    └── run-web.sh                 看板守护
```

> 看板截图未纳入仓库：本机截图上印有真实账号昵称，属于身份信息，公开仓库不放。可在本地运行看板后自行截图。

**以下目录存在于本机但不在仓库中**（已由 `.gitignore` 排除）：

| 目录 | 内容 | 排除原因 |
|:---|:---|:---|
| `accounts/` | 各账号 Chrome profile、`meta.json`、独立日志 | 含登录 Cookie，最高风险 |
| `douyin-auto/` | 主实例运行目录、截图、日志、状态文件 | 含登录态与约 700MB 运行时产物 |
| `dist/` | Windows 绿色包与 `node.exe` | 21MB 二进制，不适合进源码仓库 |
| `node_modules/` | 开发期依赖 | 运行时零依赖，无需提交 |
| `data/*.jsonl` | 参与 / 中奖 / 未中奖 / 抖币消耗流水 | 含真实账号行为数据 |
| `reports/`、`exports/` | 生成的日报与 CSV | 运行时产物 |

---

## 五、快速开始

### 环境要求

| 项 | 要求 |
|:---|:---|
| Node.js | 22+（需内置全局 `WebSocket`） |
| 浏览器 | 系统已安装 Google Chrome 或 Microsoft Edge |
| 系统 | macOS / Windows / Linux（macOS 完整长跑验证） |
| 网络 | 能访问 `live.douyin.com` |
| 依赖 | **无 npm 依赖**，不需要 `npm install` |

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

这会打开一个有头 Chrome，扫码登录后程序会：

- 通过 `Network.setCookie` 把 `sessionid` / `sid_tt` / `uid_tt` 写成 30 天有效期的持久化 Cookie
- 写入 `data/login-state.json`
- 从 `/user/self` 读取昵称与抖音号，保存为账号显示名

> **不要**把生成的 `chrome-profile/`、`cookies.json`、`login-state.json` 提交到任何仓库。

### 4. 启动抓取

```bash
# 前台运行（观察日志）
node scripts/app.mjs hunter

# 7×24 后台守护（推荐）
nohup bash scripts/run-h35.sh "$PWD/douyin-auto" >> douyin-auto/h35-supervisor.log 2>&1 &

# 或用封装脚本
bash scripts/fudai.sh start
bash scripts/fudai.sh status
bash scripts/fudai.sh restart
bash scripts/fudai.sh stop
```

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

首页推荐流实测硬上限是 20 个房间，滚动 35 次、等待加到 1200ms 也拿不到更多。因此同时采集游戏 / 音乐 / 舞蹈 / 生活分类页，合计约 49–59 个候选：

```js
// 首页推荐流 + 分类页串行采集（并发会卡死 Chrome 渲染进程）
// 游戏分类 4_103、音乐 4_102、舞蹈 4_105、生活 4_107
```

### 6.2 评分与 VIP 主动探测

历史 92% 的成功参与集中在少数几个房间，而它们常年不在首页推荐流里。因此每轮主动探测最多 2 个不在首页的 VIP 房，探不到就冷却。评分维度：

- 历史可抢次数 `joinable` 给基础加分（45 次可抢 → +28）
- 发袋率 > 60% 额外加分
- 访问多次无福袋按 2-3 次 / 4-5 次 / 6 次以上分档惩罚
- 游戏娱乐类加分、带货类减分
- VIP 房强制排最前，且豁免在线人数门槛

**在播判定**：能解析到 `online >= 0` 就算在播。只按页面长度 `len > 400` 会误杀（实测某在播房间 `online=3465` 但 `len=358`）。

### 6.3 福袋识别

```js
// 实际使用的 DOM 选择器（抖音改版会失效，故有快照存档）
document.querySelectorAll('[class*="LMUtLyr9"]')      // 福袋图标容器
  ├─ [class*="KXLj31kc"]                             // 图标
  ├─ [class*="ycjwPFJI"]                             // 倒计时
  └─ 向上找 ShortTouchContainer                      // 点击容器
```

`ShortTouchContainer > .redpacket` 空占位表示「有福袋位但当前无福袋」，是正常状态，不是故障。

**去重窗口 12 分钟**：福袋倒计时实测最长 10 分钟，早期用「房间 + 倒计时」做 key，倒计时每秒变化导致同一个福袋被记录 21 次；6 分钟窗口仍会让同一福袋跨窗口重复。现在按「房间 + 账号 + 12 分钟滑动窗口」去重，抓取侧与看板 / 报表口径一致。

### 6.4 参与动作

| 场景 | 处理 |
|:---|:---|
| 评论型 | 点击福袋 → 找「一键发评论参与福袋」→ 点击 → 复查按钮状态 |
| 需要关注 | 先关注主播，成功判定包含「关注按钮消失」（实测抖音成功后按钮直接变「加粉丝团」，不显示「已关注」） |
| 粉丝团型 | 点击「加入粉丝团（1钻）」→ 关闭可能的阻挡弹窗 → 重扫参与按钮 → 记录 1 钻消耗 |
| 抖币不足 | 识别「钻石余额不足 / 请充值 / 扫码支付」，返回 `fans-no-coins`，但仍会再尝试一次参与按钮 |
| 人气红包 | 单独识别「人气红包」文案，点击「抢 / 抢红包」 |
| 倒计时不足 180 秒 | 跳过（实测点不开面板） |

### 6.5 守候开奖

参与成功后按福袋倒计时守候 `secLeft + 180` 秒（最长 1200 秒），扫描居中浮层文案判断中奖 / 未中奖，分别写入 `data/wins.jsonl` 与 `data/losses.jsonl`。**守候时长不受等待倍率影响**——砍半会提前离开、丢掉开奖结果。

循环结束后无条件截一张 `h35-DRAWEND-*.png`，即使文案改版导致检测漏判，也能事后人工核对。

### 6.6 跨进程安全的共享学习档案

双实例同时写 `data/anchors.json` 会互相抹掉成果。`scripts/shared-json.mjs` 用 `fs.openSync(lock, 'wx')` 独占创建锁 + 临时文件 `rename` 原子替换：

- 陈旧锁超过 5000ms 自愈
- 抢锁超时 3000ms，重试间隔 20ms
- 抢锁失败降级为无锁原子写，**绝不阻塞 7×24 主循环**
- 10 进程 × 100 次并发自增验证：结果恰好 1000，零丢失

---

## 七、配置参数表

所有用户可调参数集中在 `data/*.json`，代码只读不写死。历史上「同一个值在三处硬编码」的病发作过三次，故固化此规则。

### `data/threshold.json`

| 字段 | 当前值 | 含义 |
|:---|---:|:---|
| `day` | 8000 | 白天最低在线人数（含凌晨 0-6 点） |
| `night` | 50000 | 晚间最低在线人数 |
| `nightStart` | 19 | 晚间起始小时 |
| `nightEnd` | 24 | 晚间结束小时 |

### `data/wait-config.json`

| 字段 | 当前值 | 乘 `scale` 后 | 含义 |
|:---|---:|---:|:---|
| `scale` | 0.125 | — | 等待时间倍率，限制在 0.1–2 |
| `perRoomMinMs` | 480000 | 60 s | 普通房常驻 |
| `perRoomMaxMs` | 480000 | 60 s | 常驻上限 |
| `vipMinMs` | 480000 | 60 s | VIP 房常驻 |
| `highYieldMs` | 480000 | 60 s | 历史高频发袋房常驻 |
| `noFudaiNormalMs` | 600000 | 75 s | 无福袋提前换房（普通） |
| `noFudaiVipMinMs` | 600000 | 75 s | 无福袋提前换房（VIP） |
| `emptyRoundStepMs` | 480000 | 60 s | 空轮退避首轮 |
| `emptyRoundMaxMs` | 600000 | 75 s | 空轮退避上限 |

> **配置约束**：`noFudai*` 与 `emptyRound*` 乘完必须 ≥ 常驻时长，否则会出现「还没待够就被切走」或频繁重采触发限流。当前常驻统一 60 秒，这是用户最终定稿。

### `data/pinned-hosts.json`

每个主播一条：`{ "name": "显示名", "hours": [开播小时], "tier": "pinned" }`。探测窗口为「开播小时 + 往后 1 小时」，每天最多 5 次探测；探测一段时间仍未开播就当天不再探测。

### 其他配置

| 文件 | 用途 |
|:---|:---|
| `scripts/blacklist-rooms.txt` | 每行一个房间号，永不访问 |
| `scripts/known-fudai-hosts.txt` | VIP 房间池，追加后必须检查末尾换行（历史上粘过行） |

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

### 启动第二个账号

```bash
node scripts/account-manager.mjs add main2      # 扫码登录并写入 meta.json
bash scripts/fudai.sh start-acc main2 --force  # --force 用于内存紧张时跳过阈值
```

### 账号显示名统一

同一个主账号在数据里叫 `default`、实例列表里叫 `main`、UI 里叫「主实例」，三套代号曾导致用户分不清是谁抢的。现在 `web/server.mjs` 的 `accountLabels()` 从 `accounts/*/meta.json` 读昵称 + 抖音号后 4 位，统一成「昵称(尾4位)」，并在每条福袋事件上显示彩色账号徽标。`--account main` 与 `default` 在报表中归一为同一账号。

### 资源实测（16GB 机器）

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

启动后访问 `http://127.0.0.1:8899`，单屏 3×2 网格，包含：

| 卡片 | 内容 |
|:---|:---|
| 今日总览 | 遭遇 / 参与 / 中奖 / 参与率 |
| 福袋事件 | 每条带彩色账号徽标、房间名、结果、在线人数 |
| 最近日志 | 最近运行日志 |
| 指定主播状态 | 在播 / 未开播 / 待探测、开播时间、历史发袋 |
| 学习档案 | 主播数、已访问、充足样本、零产出房间、掌幅度 |
| 账号 · 今日战绩 · 运行实例 | 分账号遭遇/参与，各实例端口与状态 |

接口：`GET /api/status` 返回 JSON，含 `byAccount`、`accountLabels`、`recentEvents`（带 `accountLabel` / `accountShort`）、`instances`、`stats` 等字段。

统计口径：全局权威数据源是 `data/participations.jsonl`，日志只用于实时状态。**「按天」必须用本地时区**——记录里的 `at` 是 UTC ISO 字符串，北京 0-8 点的记录 UTC 日期还是前一天，直接用 `startsWith(本地日期)` 会整批漏掉。项目内统一用 `localDay()` / `isLocalDay()` 处理。

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

---

## 十一、Windows 绿色分发版

仓库内**不含** `dist/douyin-fudai-windows.zip`（21MB，自带 `node.exe`）。它是本机打包产物，如需在另一台 Windows 电脑使用，需自行按 `docs/分发说明.md` 生成，或向维护者索取。

绿色包结构：

```
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

| # | 问题 | 现状 / 影响 |
|:---|:---|:---|
| 1 | DOM 选择器脆弱 | 抖音改版会让 `[class*="LMUtLyr9"]` 等选择器静默失效，表现是 `candCount=0`；已用 DOM 快照存档 + 自检缓解，但需人工跟进改版 |
| 2 | 学习准确度不足 | 历史学习档案 370 主播、355 已访问，仅约 54 个（15%）有足够样本；316 个零产出房间消耗了 489 次访问。自我进化机制存在但效果尚未量化达标 |
| 3 | 单文件 exe 缺失 | `@yao-pkg/pkg` 交叉编译需从源码构建 Node base binary，实测 3800+ 目标文件、约 90 分钟且撑爆磁盘（临时目录 12GB），改用等效绿色包 |
| 4 | 开机自启受限 | macOS 上 `~/Downloads` 属 TCC 保护目录，launchd 启动的进程「能写不能读」（exit 126）。当前靠 `nohup` + while-true 守护，电脑重启后需手工拉起 |
| 5 | 双实例内存紧平衡 | 空闲内存常低于 200MB，swap 2.6–3.9GB，load 13–16 |
| 6 | 粉丝团福袋受抖币余额约束 | 账号无抖币时抖音弹「钻石余额不足，请充值」，系统无法代付，返回 `fans-no-coins`，需用户自行充值 |
| 7 | 中奖记录稀少 | 当前 `wins.jsonl` 无记录，`losses.jsonl` 有未中奖流水；开奖检测文案覆盖面仍需更多真实样本验证 |
| 8 | 历史统计口径 | 12 分钟滑动窗口与本地时区修复前的历史数字不可直接采信，参与率曾被严重低估 |
| 9 | 归档诊断脚本 | 本机 `scripts/` 下有大量 `test-*/diag-*` 历史脚本仍写死 macOS 绝对路径，**未纳入本仓库** |
| 10 | 日志跨天复用 | `h35.log` 只有 `HH:MM:SS` 且跨天追加，判断「某行属于哪个进程」必须结合启动行与进程时间，不能只按时间戳过滤 |
| 11 | `status.sh` 统计口径 | 读单实例日志，与看板全局统计数字可能不同，属已知差异 |

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

仓库自带 `scripts/precommit-check.mjs` 门禁，扫描暂存区全部内容，命中真实账号昵称 / 抖音号 / Cookie 值 / token 前缀即以非零退出拒绝提交：

```bash
node scripts/precommit-check.mjs     # 提交前手动跑
# 或装成本机钩子（仓库已含该脚本，克隆后自行启用）
cp scripts/precommit-check.mjs .git/hooks/ 2>/dev/null || true
echo 'node scripts/precommit-check.mjs' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

门禁的模式串用片段拼接构造，脚本自身不含任何完整敏感串，因此可安全放进公开仓库。

### 使用边界

- 本项目是**个人自动化工具**，仅用于自己的账号，不提供任何批量注册、刷量、破解、绕过风控或代抢服务。
- 项目不调用抖音非公开接口，所有操作都在真实浏览器页面上完成，与普通用户手动点击等价。
- 抖音网页版的结构、规则与用户协议可能随时变化，**使用者需自行确认并承担合规责任**。平台若明确禁止自动化访问，应停止使用。
- 加入粉丝团会消耗抖币等虚拟资产，相关授权由使用者自行决定。
- 作者不对账号受限、资产消耗、数据丢失或任何间接损失负责。

### 如果凭据曾误入仓库

若怀疑 Cookie 或 token 被提交过，**删除文件无效，必须立即轮换凭据**（重新扫码登录使旧 session 失效），并清理 Git 历史。本仓库首版发布前已做全文扫描，未发现凭据入库。

---

## 十四、开发历程与踩坑记录

完整的逐日复盘在 `AGENTS.md`（约 40KB）与 `docs/incidents/`，这里列影响最大的几条：

| 日期 | 事件 | 结论 |
|:---|:---|:---|
| 2026-11-02 | 去重 key 用「房间+倒计时」 | 倒计时每秒变，同一福袋被记 21 次；改 12 分钟滑动窗口 |
| 2026-11-02 | 「暂停视频省 CPU 99%」的旧结论 | 实测反例：视频已 paused 但 Chrome 仍 154% CPU；真正开销在弹幕与礼物动画，三连注入后降到 4.2% |
| 2026-11-02 | 指定主播从未被探测 | 排序时 `lastFudaiAt` 为空导致永远排末位；改为候选直接取配置全集 |
| 2026-11-03 | 登录态失效盲跑 18 小时 | 「看不见」与「没有」表现一样；固化 `check-alive` 为巡检第 0 步 |
| 2026-11-04 | 跨天统计双重 UTC 陷阱 | `toISOString()` 取 UTC 日期 + 记录存 UTC 却按本地日期比字符串，两个 bug 方向相反；统一 `localDay` / `isLocalDay` |
| 2026-11-04 | `DATA_DIR` 的 TDZ | 配置读取在声明之前，被空 `catch` 吞掉，配置「看起来生效、实际没读」；配置读取必须显式验证读到的值 |
| 2026-11-04 | 多账号「数据混乱」 | 数据层每条都带 `account`，乱在展示层漏字段 + 冗余数据源口径不一致；逐个盘点读写入口 |
| 2026-11-04 | 粉丝团「跳过」真相 | 截图显示是「钻石余额不足，请充值」，不是策略跳过；验证失败后仍应重扫参与按钮 |

**通用教训**：性能结论必须当场实测；配置读取必须验证读到的值；任何「零结果」怀疑先自检采集端；新增维度后必须盘点所有读写入口。

---

## 十五、许可证

[MIT](LICENSE) © 2026 邓林

详见 [LICENSE](LICENSE)。本项目按「现状」提供，不附带任何明示或暗示的担保。
