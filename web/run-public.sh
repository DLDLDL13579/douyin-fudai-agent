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
    # 🔴 2026-11-14 15:50 修：原来只等 5 秒、无强杀兜底。
    #    实测 cloudflared 卡在 edge 断开态时对 SIGTERM 无响应（01:46 事故：发 TERM 后
    #    进程仍存活，导致守护误以为隧道还在、永远不重建，公网一直 530）。
    #    改为：TERM 后等 8 秒，仍在则 SIGKILL，再等 3 秒确认。
    for _ in 1 2 3 4 5 6 7 8; do kill -0 "$p" 2>/dev/null || break; sleep 1; done
    if kill -0 "$p" 2>/dev/null; then
      echo "[public $(date '+%H:%M:%S')] TERM 无效，SIGKILL pid=$p"
      kill -9 "$p" 2>/dev/null
      for _ in 1 2 3; do kill -0 "$p" 2>/dev/null || break; sleep 1; done
    fi
    if kill -0 "$p" 2>/dev/null; then
      echo "[public $(date '+%H:%M:%S')] ⚠ 警告：pid=$p 仍存活，本轮跳过重建"
      return 1
    fi
  fi
  return 0
}

# 只找「指向本只读端口」的 cloudflared，绝不误杀 DSH 的 3080 隧道
find_tunnel_pid() {
  # 2026-11-09 18:30：DSH 会话被 macOS seatbelt 限制时 /bin/ps 报
  # Operation not permitted，原 ps|grep 永远返回空 → 守护误判「隧道不在」，
  # 每 10 秒重复 spawn cloudflared，形成隧道风暴。pgrep 在该上下文仍可用。
  # 精确匹配 8898 只读入口，绝不触碰 DSH 的 3080 / 命名隧道。
  #
  # 🔴 2026-11-14 15:50 修两处（01:46 公网 530 事故复盘）：
  #    ① pgrep -f 会连「命令行里恰好含这串字」的进程一起匹配 ——
  #       实测连巡检用的 `bash -c ...grep tunnel --url...` 都被 pgrep 命中（pid 45777）。
  #       若把这类 PID 当隧道杀掉，轻则白杀，重则误伤。改为只认**可执行文件是
  #       cloudflared** 的进程：先取候选 PID，再校验 /proc 式 args 首段以 cloudflared 结尾。
  #    ② 原来永远 `head -1`，多隧道时只能看见一条 —— 实测 01:47 手动+守护各起一条后
  #       出现两条同时抢域名，却只能杀到一条。现在返回**全部** PID（空格分隔），
  #       调用方逐个精确清理。
  local pids out
  if command -v pgrep >/dev/null 2>&1; then
    pids="$(pgrep -f "tunnel --url http://127.0.0.1:$PORT" 2>/dev/null)"
  else
    pids="$(ps -eo pid,args 2>/dev/null | grep -F "tunnel --url http://127.0.0.1:$PORT" | grep -v grep | awk '{print $1}')"
  fi
  out=""
  for p in $pids; do
    [ -z "$p" ] && continue
    # 必须是 cloudflared 进程，排除 shell 包装层与 grep 自身
    local a; a="$(ps -o args= -p "$p" 2>/dev/null)"
    case "$a" in
      *cloudflared*tunnel*--url*"127.0.0.1:$PORT"*) out="$out $p" ;;
      *) ;;
    esac
  done
  echo "$out" | tr -s ' ' | sed 's/^ //'
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
  # 🔴 2026-11-14 15:52：find_tunnel_pid 现在返回多条（空格分隔），
  #    多隧道时只保留第一条作为「主隧道」，其余立刻精确清掉 —— 否则两条
  #    quick tunnel 同时抢同一个域名，公网会随机 530（01:47 实测过）。
  live_pids=$(find_tunnel_pid)
  live_pid=$(echo "$live_pids" | awk '{print $1}')
  extra_pids=$(echo "$live_pids" | awk '{$1=""; print $0}' | xargs 2>/dev/null)
  if [ -n "$extra_pids" ]; then
    echo "[public $(date '+%H:%M:%S')] 发现重复隧道，精确清理: $extra_pids"
    for xp in $extra_pids; do
      case "$(ps -o args= -p "$xp" 2>/dev/null)" in
        *cloudflared*tunnel*--url*"127.0.0.1:$PORT"*) kill -9 "$xp" 2>/dev/null ;;
      esac
    done
    sleep 2
  fi
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
        # 🔴 2026-11-14 15:52：按 kill 结果决定后续动作。
        #    原来无论 kill 成败都清 LAST_TUNNEL_PID + 清空域名文件 → 下一轮
        #    「发现新 PID」→ 重新计 90 秒宽限 → 问题被掩盖、公网一直挂着。
        #    现在：只有真的清掉了才重置状态；清不掉就保留域名继续报错。
        if kill_stale_tunnel; then
          STALE_STREAK=0
          LAST_TUNNEL_PID=""
          # 清空旧域名，避免下一轮拿已失效域名探测误判
          : > "$URL_FILE"
        else
          echo "[public $(date '+%H:%M:%S')] ⚠ 僵死隧道清不掉，保留计数继续告警"
          STALE_STREAK=$STALE_CONFIRM
        fi
        sleep 8
      fi
    fi
  fi
  sleep 10
done
