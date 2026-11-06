#!/bin/bash
# Chrome 运行时磁盘缓存守护（2026-11-06）
#
# 背景：run-h35.sh 原清理逻辑写在 while 顶部且要求 ! chrome_running，
# 但 hunter35.mjs 是阻塞前台运行、7×24 下 Chrome 永不退出 → 清理代码永不执行，
# Default/Cache 无限增长。实测 1 小时涨 415MB，两个 profile 合计 1.16GB，
# 磁盘 6.2Gi → 4.5Gi 触发 <5Gi 告警。
#
# 本守护：启动即清一次，之后每 30 分钟清一次，用 CDP Network.clearBrowserCache，
# 不动文件句柄、不重启 Chrome、不碰 Cookie / 登录态。
# 单实例锁：多个 supervisor 同时拉起也只有一个真正运行，绝不清重复、绝不堆积进程。
#
# 用法：nohup bash scripts/run-cache-cleaner.sh >> <log> 2>&1 < /dev/null &
# 停止：kill "$(cat /tmp/fudai-cache-cleaner.lock)"   （不要用 pkill -f）

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLEANER="$ROOT_DIR/scripts/cache-cleaner.mjs"
INTERVAL="${DY_CACHE_CLEAN_INTERVAL:-1800}"
LOCK="/tmp/fudai-cache-cleaner.lock"

if [ ! -f "$CLEANER" ]; then
  echo "[cache-cleaner] 找不到 $CLEANER，退出"
  exit 1
fi

# 单实例锁：锁文件里存活的 PID → 本进程直接退出
if [ -f "$LOCK" ]; then
  OLD=$(cat "$LOCK" 2>/dev/null)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "[cache-cleaner] 已有守护实例 PID $OLD，本进程退出"
    exit 0
  fi
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

echo "[cache-cleaner] 启动 PID $$ 间隔 ${INTERVAL}s at $(date '+%m-%d %H:%M:%S')"

while true; do
  node "$CLEANER"
  sleep "$INTERVAL" &
  wait $!
done
