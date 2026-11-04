#!/bin/bash
# 用法: run-h35.sh <工作目录> [账号名] [端口]
#   不带账号名：原单账号模式，日志与数据写在 <工作目录>，profile 用 <工作目录>/chrome-profile
#   带账号名：  传给 hunter35.mjs --account，profile 与端口来自 accounts/<账号名>/
cd "$(dirname "$0")"
BASE="$1"
ACCOUNT="$2"
CACHE_MAX_MB=500      # 双源采集后缓存增长更快（3.5h 涨 700MB），阈值降到 500
PNG_KEEP_DAYS=1       # 诊断截图保留天数（3天→1天：每天 100+ 张，实测 3 天积到 580MB）

# ⚠ profile 路径与 hunter35.mjs 必须一致：
#   非账号模式 → <工作目录>/chrome-profile
#   账号模式   → accounts/<名字>/profile（不是 <工作目录>/chrome-profile）
#   2026-11-03 发现两者不一致，supervisor 一直在清理一个不存在的目录，缓存回收完全失效。
# 应用根 = scripts 的上一级；不再写死 macOS 绝对路径（绿色包/多机分发需要）
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ACC_ROOT="$ROOT_DIR/accounts"
if [ -n "$ACCOUNT" ]; then
  PROFILE="$ACC_ROOT/$ACCOUNT/profile"
else
  PROFILE="$BASE/chrome-profile"
fi

# 端口：显式传入 > meta.json 登记 > 9750

if [ -n "${3:-}" ]; then
  PORT="$3"
elif [ -n "$ACCOUNT" ] && [ -f "$ACC_ROOT/$ACCOUNT/meta.json" ]; then
  PORT=$(node -e "try{console.log(require('$ACC_ROOT/$ACCOUNT/meta.json').port||9750)}catch(e){console.log(9750)}")
else
  PORT=9750
fi

# 判断 Chrome 是否已退出（不用 pgrep -f，避免自匹配）
# ⚠ 端口不能写死 9750：多账号并行时每个实例端口不同，写死会让实例 B 永远看到
#   「Chrome 在跑」，从而跳过缓存回收，缓存无限增长。
chrome_running() {
  ps -eo args | grep -F "remote-debugging-port=$PORT" | grep -v grep >/dev/null 2>&1
}

while true; do
  # ── 1. 清理过期诊断截图，防止 7×24 跑下来撑爆磁盘
  # 清理所有诊断截图（原规则只匹配 h35-*.png，导致 h34-/h20-/ac- 等旧前缀永久堆积：
    # 实测 664 张截图里 495 张是 10-29~10-31 的旧文件，占用 580MB 却一张都没被清）
    find "$BASE" -maxdepth 1 -name '*.png' -mtime +$PNG_KEEP_DAYS -delete 2>/dev/null

  # ── 2. Chrome 缓存超阈值时回收（Cache/Code Cache 可安全删除，不含登录态）
  if ! chrome_running; then
    for d in "Default/Cache" "Default/Code Cache" "Default/GPUCache" "GraphiteDawnCache"; do
      if [ -d "$PROFILE/$d" ]; then
        SZ=$(du -sm "$PROFILE/$d" 2>/dev/null | awk '{print $1}')
        if [ "${SZ:-0}" -gt "$CACHE_MAX_MB" ]; then
          rm -rf "${PROFILE:?}/$d" 2>/dev/null
          echo "[supervisor] 清理 Chrome 缓存 $d ${SZ}MB at $(date '+%m-%d %H:%M:%S')" >> "$BASE/h35.log"
        fi
      fi
    done
    # 日志超过 20MB 就截断保留最近 5000 行
    if [ -f "$BASE/h35.log" ]; then
      LSZ=$(du -sm "$BASE/h35.log" 2>/dev/null | awk '{print $1}')
      if [ "${LSZ:-0}" -gt 20 ]; then
        tail -5000 "$BASE/h35.log" > "$BASE/h35.log.tmp" 2>/dev/null && mv "$BASE/h35.log.tmp" "$BASE/h35.log"
      fi
    fi
  fi

  # ── 3. 启动主程序（门槛由 data/threshold.json 决定，不在此硬编码）
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
