#!/bin/bash
# 运行时清理守护：过期诊断截图 + 日志轮转（2026-11-07）
#
# 背景：run-h35.sh 的 while true 里，清理段写在 node hunter35.mjs 之前。
#   而 hunter35.mjs 是阻塞式前台运行，7×24 下永不退出 → 截图清理与日志轮转
#   **从未执行过**。实测 11-07 12:51 累计 1516 张 / 474MB 截图，其中
#   105 张 / 42MB 已超过 PNG_KEEP_DAYS=1 本该被清。
#   这与 11-06 的 Chrome 缓存清理失效是同一个病根，修法一致：独立守护。
#
# ⚠ 不负责 Chrome 缓存：那个由 scripts/cache-cleaner.mjs 用 CDP
#   Network.clearBrowserCache 在运行时清，实测能清掉磁盘 Cache 目录
#   （11-07 12:52 复验：9752 OK 后 Cache 107.7MB → 0.2MB）。
#   ⚠ 绝不用 rm -rf 删运行中 Chrome 的 Cache 目录。
#
# 单实例锁：/tmp/fudai-runtime-cleaner.lock，重复拉起自动退出。
# 用法：nohup bash scripts/runtime-cleaner.sh >> douyin-auto/runtime-cleaner.log 2>&1 < /dev/null &
#      DY_RUNTIME_CLEAN_INTERVAL=1800（默认 30 分钟）
#      DY_RUNTIME_CLEAN_DRY=1 只打印不删除，用于预演

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$ROOT_DIR/douyin-auto"
ACC_ROOT="$ROOT_DIR/accounts"
PNG_KEEP_DAYS="${DY_PNG_KEEP_DAYS:-1}"
LOG_MAX_MB=20
LOG_KEEP_LINES=5000
INTERVAL="${DY_RUNTIME_CLEAN_INTERVAL:-1800}"
DRY="${DY_RUNTIME_CLEAN_DRY:-0}"
LOCK="/tmp/fudai-runtime-cleaner.lock"

# ── 单实例锁 ──
if [ -e "$LOCK" ]; then
  OLD="$(cat "$LOCK" 2>/dev/null)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "[runtime-cleaner] 已有守护实例 PID ${OLD}，本进程退出"
    exit 0
  fi
  rm -f "$LOCK"
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[runtime-cleaner $(ts)] $*"; }

do_clean() {
  local n=0 bytes=0 f
  # 收集所有截图目录：主实例 BASE + 各账号 work（不写死账号名）
  local dirs=("$BASE")
  if [ -d "$ACC_ROOT" ]; then
    for d in "$ACC_ROOT"/*/work; do
      [ -d "$d" ] && dirs+=("$d")
    done
  fi

  # ── 1. 过期截图 ──
  for d in "${dirs[@]}"; do
    [ -d "$d" ] || continue
    while IFS= read -r -d '' f; do
      n=$((n + 1))
      bytes=$((bytes + $(stat -f %z "$f" 2>/dev/null || echo 0)))
      if [ "$DRY" = "1" ]; then
        log "DRY 删截图 $f"
      else
        rm -f "$f"
      fi
    done < <(find "$d" -maxdepth 1 -name '*.png' -mtime +"$PNG_KEEP_DAYS" -print0 2>/dev/null)
  done
  log "过期截图 $n 张 / $((bytes / 1024 / 1024)) MB (保留 ${PNG_KEEP_DAYS} 天内)"

  # ── 2. 日志轮转：超过 LOG_MAX_MB 就截断保留最近 LOG_KEEP_LINES 行 ──
  local lf lsz
  for lf in "$BASE"/h35.log "$BASE"/h35-supervisor.log "$BASE"/runtime-cleaner.log; do
    [ -f "$lf" ] || continue
    lsz=$(du -sm "$lf" 2>/dev/null | awk '{print $1}')
    [ "${lsz:-0}" -gt "$LOG_MAX_MB" ] || continue
    if [ "$DRY" = "1" ]; then
      log "DRY 轮转日志 $lf ${lsz}MB"
    else
      tail -"$LOG_KEEP_LINES" "$lf" > "$lf.tmp" 2>/dev/null && mv "$lf.tmp" "$lf"
      log "轮转日志 $lf ${lsz}MB → 保留 ${LOG_KEEP_LINES} 行"
    fi
  done
  # 各账号实例的日志
  for d in "$ACC_ROOT"/*/work; do
    [ -d "$d" ] || continue
    for lf in "$d"/h35.log "$d"/supervisor.log; do
      [ -f "$lf" ] || continue
      lsz=$(du -sm "$lf" 2>/dev/null | awk '{print $1}')
      [ "${lsz:-0}" -gt "$LOG_MAX_MB" ] || continue
      if [ "$DRY" = "1" ]; then
        log "DRY 轮转日志 $lf ${lsz}MB"
      else
        tail -"$LOG_KEEP_LINES" "$lf" > "$lf.tmp" 2>/dev/null && mv "$lf.tmp" "$lf"
        log "轮转日志 $lf ${lsz}MB → 保留 ${LOG_KEEP_LINES} 行"
      fi
    done
  done
}

log "启动 PID $$ 间隔 ${INTERVAL}s 截图保留 ${PNG_KEEP_DAYS} 天 dry=$DRY"
while true; do
  do_clean
  if [ "$DRY" = "1" ]; then
    log "DRY 模式只跑一轮，退出"
    exit 0
  fi
  sleep "$INTERVAL" &
  wait $!
done
