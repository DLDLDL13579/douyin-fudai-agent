#!/bin/bash
# 用法: run-h35.sh <工作目录> [账号名] [端口]
#   不带账号名：原单账号模式，日志与数据写在 <工作目录>，profile 用 <工作目录>/chrome-profile
#   带账号名：  传给 hunter35.mjs --account，profile 与端口来自 accounts/<账号名>/
cd "$(dirname "$0")"
BASE="$1"
ACCOUNT="$2"
# ⚠ 2026-11-07 移除此处的 CACHE_MAX_MB / PNG_KEEP_DAYS 与 while 内的清理段：
#   它们写在阻塞式 `node hunter35.mjs` 之前，7×24 下 hunter 永不退出 → 清理段
#   从未执行过。实测累计 1516 张 / 474MB 截图，其中 110 张 / 41MB 已过期。
#   运行时清理由两个独立守护负责（各带单实例锁，本 supervisor 只负责拉起）：
#     scripts/run-cache-cleaner.sh  → CDP Network.clearBrowserCache 清 Chrome 缓存
#     scripts/runtime-cleaner.sh    → 过期截图 + 日志轮转
#   与 11-06 的缓存清理失效是同一病根，修法一致。

# 应用根 = scripts 的上一级；不再写死 macOS 绝对路径（绿色包/多机分发需要）
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ACC_ROOT="$ROOT_DIR/accounts"

# 端口：显式传入 > meta.json 登记 > 9750
if [ -n "${3:-}" ]; then
  PORT="$3"
elif [ -n "$ACCOUNT" ] && [ -f "$ACC_ROOT/$ACCOUNT/meta.json" ]; then
  PORT=$(node -e "try{console.log(require('$ACC_ROOT/$ACCOUNT/meta.json').port||9750)}catch(e){console.log(9750)}")
else
  PORT=9750
fi

# ── 运行时清理守护（11-06 缓存 / 11-07 截图与日志）
# ⚠ 两次踩同一个坑：清理段原本写在 while 顶部、还要求 ! chrome_running，
#   但下面的 node hunter35.mjs 是阻塞式前台运行，7×24 下永不退出 →
#   清理代码从未执行。缓存涨到 1.16GB 触发磁盘告警，截图堆到 1516 张 / 474MB。
# 修法：一律拆成独立守护，各带单实例锁，本 supervisor 只负责启动即拉起。
#   run-cache-cleaner.sh → CDP Network.clearBrowserCache（运行时清，不动登录态）
#   runtime-cleaner.sh   → 过期截图 + 日志轮转
# 用 nohup 让守护脱离 supervisor，重启 / 被杀时清理不受影响。
if [ -f "$ROOT_DIR/scripts/run-cache-cleaner.sh" ]; then
  nohup bash "$ROOT_DIR/scripts/run-cache-cleaner.sh" >> "$BASE/h35.log" 2>&1 < /dev/null &
fi
# 过期截图 + 日志轮转守护（2026-11-07，同样单实例锁）
if [ -f "$ROOT_DIR/scripts/runtime-cleaner.sh" ]; then
  nohup bash "$ROOT_DIR/scripts/runtime-cleaner.sh" >> "$BASE/runtime-cleaner.log" 2>&1 < /dev/null &
fi

while true; do
  # ── 启动主程序（门槛由 data/threshold.json 决定，不在此硬编码）
  # ⚠ 清理逻辑一律放在独立守护里，不要写回这个 while：
  #   下面 node hunter35.mjs 是阻塞式前台运行，7×24 下不退出，
  #   写在它之后的任何清理代码都永远不会执行（11-06 缓存、11-07 截图两次踩坑）。
  if [ -n "$ACCOUNT" ]; then
    DY_NIGHT_START=19 DY_NIGHT_END=24 \
    DY_ROOMS=1 DY_BATCH_MIN=12 DY_PORT="$PORT" \
    node hunter35.mjs --account "$ACCOUNT"
  else
    DY_NIGHT_START=19 DY_NIGHT_END=24 \
    DY_ROOMS=1 DY_BATCH_MIN=12 DY_PORT=9750 \
    node hunter35.mjs
  fi
  echo "[supervisor] hunter35 exited rc=$? at $(date '+%H:%M:%S')" >> "$BASE/h35.log"
  sleep 20
done
