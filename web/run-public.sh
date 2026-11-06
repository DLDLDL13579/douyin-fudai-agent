#!/usr/bin/env bash
# 公网只读看板守护（2026-11-06）
#   两层：8898 只读代理 → 8899 原看板；cloudflared quick tunnel → 8898
#   单实例锁，任一进程退出 10 秒后自动拉起；不触碰 DSH 自己的 3080 / dsh.dlcqp.asia 隧道。
#   日志：/tmp/fudai-public-*.log；当前公网域名写在 /tmp/fudai-public-url.txt
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# cloudflared 二进制：优先环境变量，其次 DSH profile 自带的那份，最后 PATH。
# 不写死任何本机用户名或绝对路径（门禁会拦身份明文）。
find_cloudflared() {
  if [ -n "${DY_CLOUDFLARED:-}" ] && [ -x "$DY_CLOUDFLARED" ]; then echo "$DY_CLOUDFLARED"; return; fi
  local p="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/cloudflared/bin/cloudflared"
  if [ -x "$p" ]; then echo "$p"; return; fi
  command -v cloudflared 2>/dev/null || echo ''
}
CLOUDFLARED="$(find_cloudflared)"
if [ -z "$CLOUDFLARED" ]; then
  echo "[public] 找不到 cloudflared，退出。可设 DY_CLOUDFLARED=<路径>"; exit 1
fi
PORT="${DY_PUBLIC_PORT:-8898}"
UPSTREAM_PORT=8899
LOCK="/tmp/fudai-public.lock"
P_LOG=/tmp/fudai-readonly.log
T_LOG=/tmp/fudai-public-tunnel.log
URL_FILE=/tmp/fudai-public-url.txt

# 单实例锁：已有守护在跑就退出，避免多条隧道抢域名
if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "[public] 已有守护实例（锁 $LOCK），本进程退出"; exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

# 若 8898 已被别的进程占着，不重复起（起也只会 EADDRINUSE 刷日志）
proxy_up() { curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/status"; }
tunnel_pid=""

# 只找「指向本只读端口」的 cloudflared，绝不误杀 DSH 的 3080 隧道
find_tunnel_pid() {
  ps -eo pid,args | grep -F "tunnel --url http://127.0.0.1:$PORT" | grep -v grep | awk '{print $1}' | head -1
}

start_tunnel() {
  nohup "$CLOUDFLARED" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate --protocol http2 >> "$T_LOG" 2>&1 &
  tunnel_pid=$!
  echo "[public] 隧道已起 pid=$tunnel_pid"
}

echo "[public] 守护启动：127.0.0.1:$PORT(只读) → 127.0.0.1:$UPSTREAM_PORT(原看板) → cloudflared quick tunnel"
while true; do
  if ! proxy_up; then
    echo "[public $(date '+%H:%M:%S')] 只读代理不在，拉起"
    DY_PUBLIC_PORT="$PORT" nohup node "$ROOT/web/public-readonly.mjs" >> "$P_LOG" 2>&1 &
    sleep 3
  fi
  # 每轮都先按命令行查现存 PID：既认领手动起的隧道，也能发现子进程崩溃后重起
  live_pid=$(find_tunnel_pid)
  if [ -n "$live_pid" ]; then
    tunnel_pid="$live_pid"
  else
    echo "[public $(date '+%H:%M:%S')] 隧道不在，拉起"
    start_tunnel
    sleep 8
  fi
  # 每次循环把最新域名写盘，方便随时取用
  U=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$T_LOG" 2>/dev/null | tail -1)
  if [ -n "$U" ]; then echo "$U" > "$URL_FILE"; fi
  sleep 10
done
