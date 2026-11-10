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
  echo "[public] 已有守护实例（锁 ${LOCK}），本进程退出"; exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

# 若 8898 已被别的进程占着，不重复起（起也只会 EADDRINUSE 刷日志）
proxy_up() { curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/status"; }
tunnel_pid=""

# ── 公网可达性探测（2026-11-09 18:51 事故）──────────────────────────────
# 坑：cloudflared 进程活着、metrics ha_connections=1，但 edge 侧 HTTP/2 已静默断开，
# 公网全返 530；而旧逻辑只看 find_tunnel_pid 进程是否存在 → 永远不重起，故障无限期挂着。
# 修法：定期探一次公网，连续确认后精确 kill 这一条 8898 隧道让守护重建。
# ⚠ 三重防误杀（quick tunnel 新域名在 edge 生效前也会短暂返 530）：
#   ① 隧道重建后 GRACE_SEC=90 秒内不做僵死判定；
#   ② 每 PROBE_INTERVAL=120 秒才探一次，不给外网加压；
#   ③ 连续 STALE_CONFIRM=2 次异常才动手，单次网络抖动绝不重启。
# 绝不用进程名批量杀 cloudflared（会连带杀掉 DSH 3080 与 dsh.dlcqp.asia 命名隧道）。
PROBE_INTERVAL=120
GRACE_SEC=90
STALE_CONFIRM=2
TUNNEL_STARTED_AT=0
STALE_STREAK=0
LAST_PROBE_AT=0
LAST_TUNNEL_PID=""

probe_public_code() {
  local u; u="$(cat "$URL_FILE" 2>/dev/null | tr -d '\r\n')"
  [ -z "$u" ] && return 0
  curl -s -m 12 -o /dev/null -w '%{http_code}' "$u/" 2>/dev/null
}

kill_stale_tunnel() {
  local p; p="$(find_tunnel_pid)"
  if [ -n "$p" ]; then
    echo "[public $(date '+%H:%M:%S')] 精确重启僵死隧道 pid=$p"
    kill "$p" 2>/dev/null
    for _ in 1 2 3 4 5; do kill -0 "$p" 2>/dev/null || break; sleep 1; done
  fi
}

# 只找「指向本只读端口」的 cloudflared，绝不误杀 DSH 的 3080 隧道
find_tunnel_pid() {
  # 2026-11-09 18:30：DSH 会话被 macOS seatbelt 限制时 /bin/ps 报
  # Operation not permitted，原 ps|grep 永远返回空 → 守护误判「隧道不在」，
  # 每 10 秒重复 spawn cloudflared，形成隧道风暴。pgrep 在该上下文仍可用。
  # 精确匹配 8898 只读入口，绝不触碰 DSH 的 3080 / 命名隧道。
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "tunnel --url http://127.0.0.1:$PORT" 2>/dev/null | head -1
  else
    ps -eo pid,args 2>/dev/null | grep -F "tunnel --url http://127.0.0.1:$PORT" | grep -v grep | awk '{print $1}' | head -1
  fi
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
    if [ "$live_pid" != "$LAST_TUNNEL_PID" ]; then
      # 新隧道刚起：给 edge 充分生效时间，僵死计数清零
      LAST_TUNNEL_PID="$live_pid"
      TUNNEL_STARTED_AT=$(date +%s)
      STALE_STREAK=0
    fi
    tunnel_pid="$live_pid"
  else
    echo "[public $(date '+%H:%M:%S')] 隧道不在，拉起"
    start_tunnel
    LAST_TUNNEL_PID="$tunnel_pid"
    TUNNEL_STARTED_AT=$(date +%s)
    STALE_STREAK=0
    sleep 8
  fi
  # 每次循环把最新域名写盘，方便随时取用
  U=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$T_LOG" 2>/dev/null | tail -1)
  if [ -n "$U" ]; then echo "$U" > "$URL_FILE"; fi

  # 公网可达性巡检：低频 + 宽限期 + 连续确认，只在确认僵死后精确重启
  now_ts=$(date +%s)
  if [ $((now_ts - TUNNEL_STARTED_AT)) -ge "$GRACE_SEC" ] &&
     [ $((now_ts - LAST_PROBE_AT)) -ge "$PROBE_INTERVAL" ]; then
    LAST_PROBE_AT=$now_ts
    code="$(probe_public_code)"
    if [ -z "$code" ] || [ "$code" = "200" ]; then
      STALE_STREAK=0
    else
      STALE_STREAK=$((STALE_STREAK + 1))
      echo "[public $(date '+%H:%M:%S')] 公网 HTTP $code 连续 ${STALE_STREAK}/${STALE_CONFIRM} 次"
      if [ "$STALE_STREAK" -ge "$STALE_CONFIRM" ]; then
        kill_stale_tunnel
        STALE_STREAK=0
        LAST_TUNNEL_PID=""
        # 清空旧域名，避免下一轮拿已失效域名探测误判
        : > "$URL_FILE"
        sleep 8
      fi
    fi
  fi
  sleep 10
done
