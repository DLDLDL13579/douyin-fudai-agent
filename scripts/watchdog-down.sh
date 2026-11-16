#!/bin/bash
# 抖音福袋 · 停机看门狗（2026-11-16 用户定稿「只加停机告警」）
#
# 为什么需要这个：2026-11-16 11:21 电脑重启，全部服务停了 74 分钟无人知晓。
#   health-guard.sh 虽然有自动拉起能力，但它自己也随重启消失，
#   重启后没有任何东西在跑，等于监护人和被监护人一起躺平。
#
# 本脚本由 DSH 会话侧启动（或手动 nohup），职责单一：
#   检测「服务是否全停」，若停则推 Server酱到手机，并留下告警记录。
#   严格只读 + 只发通知，绝不自己拉起任何服务（拉起由用户或我决定）。
#
# 判据：连续 CONFIRM 次检测到「hunter 进程 0 个 且 9750/9752 端口都不监听」，
#   才判定为停机。单次抖动（如正在重启）不报，避免误报浪费免费配额。
#
# 用法：
#   nohup bash scripts/watchdog-down.sh >> douyin-auto/watchdog.log 2>&1 &
#   DY_WD_ONCE=1 bash scripts/watchdog-down.sh    # 只跑一轮（排查用）
#   DY_WD_INTERVAL=300 / DY_WD_CONFIRM=2 / DY_WD_REPEAT_MIN=30 可调

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

LOG="$ROOT/douyin-auto/watchdog.log"
STATE="$ROOT/douyin-auto/.watchdog-state"
LOCKDIR="/tmp/fudai-watchdog.lock.d"

INTERVAL="${DY_WD_INTERVAL:-180}"      # 3 分钟一轮
CONFIRM="${DY_WD_CONFIRM:-2}"          # 连续 2 次确认才报（约 6 分钟）
REPEAT_MIN="${DY_WD_REPEAT_MIN:-30}"   # 同一故障最短重复提醒间隔（分钟）

mkdir -p "$ROOT/douyin-auto"

say(){ echo "[watchdog $(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# 单实例锁（mkdir 原子性，与 health-guard 同款思路）
acquired=0
for _try in 1 2 3; do
  if mkdir "$LOCKDIR" 2>/dev/null; then echo $$ > "$LOCKDIR/pid"; acquired=1; break; fi
  _old=$(cat "$LOCKDIR/pid" 2>/dev/null || echo 0)
  if [ "${_old:-0}" -gt 1 ] && kill -0 "$_old" 2>/dev/null; then
    echo "[watchdog] 已有实例 PID=${_old}，退出"; exit 0
  fi
  rm -rf "$LOCKDIR" 2>/dev/null; sleep 1
done
[ "$acquired" = "1" ] || { echo "[watchdog] 抢锁失败"; exit 1; }
trap 'rm -rf "$LOCKDIR"' EXIT INT TERM

send_push(){
  local title="$1" body="$2"
  if [ -f "$ROOT/scripts/notify-serverchan.mjs" ]; then
    # ⚠ 必须带 --from-hunter：notify-serverchan 只认这一个「自动链路」标记，
    #   否则会给标题加「【测试】」前缀（那是防手工误发真实中奖消息的保护）。
    #   watchdog 是自动告警，不是手工测试，走自动链路。
    ( node "$ROOT/scripts/notify-serverchan.mjs" --from-hunter --title "$title" --desp "$body" \
        >> "$LOG" 2>&1 ) &
    say "  → 已提交推送：$title"
  else
    say "  ⚠ notify-serverchan.mjs 不存在，无法推送"
  fi
}

check_once(){
  # hunter 进程数（用 pgrep，macOS 的 ps 在 TCC 下可能受限）
  local n_hunter=0
  n_hunter=$(pgrep -f 'node hunter35\.mjs' 2>/dev/null | wc -l | tr -d ' ')
  # 端口
  local p9750 p9752
  p9750=$(lsof -nP -iTCP:9750 -sTCP:LISTEN 2>/dev/null | grep -c LISTEN)
  p9752=$(lsof -nP -iTCP:9752 -sTCP:LISTEN 2>/dev/null | grep -c LISTEN)
  # 看板
  local p8899
  p8899=$(lsof -nP -iTCP:8899 -sTCP:LISTEN 2>/dev/null | grep -c LISTEN)

  local down=0
  # 停机判据：抓取全无（这是核心）。看板缺不影响抢袋，单独记但不单独触发。
  if [ "${n_hunter:-0}" -eq 0 ] && [ "${p9750:-0}" -lt 1 ] && [ "${p9752:-0}" -lt 1 ]; then
    down=1
  fi
  echo "$n_hunter $p9750 $p9752 $p8899 $down"
}

run_once(){
  local r n_h p750 p752 p899 down
  r=$(check_once)
  read -r n_h p750 p752 p899 down <<< "$r"

  # 读状态：streak=连续停机次数, last_alert=上次告警时间戳
  local streak=0 last_alert=0
  if [ -f "$STATE" ]; then
    streak=$(sed -n 's/^streak=//p' "$STATE" 2>/dev/null | head -1)
    last_alert=$(sed -n 's/^last_alert=//p' "$STATE" 2>/dev/null | head -1)
  fi
  streak=${streak:-0}; last_alert=${last_alert:-0}

  if [ "$down" = "1" ]; then
    streak=$((streak+1))
    say "🔴 检测到抓取全停（第 ${streak}/${CONFIRM} 次）：hunter=${n_h} 9750=${p750} 9752=${p752} 8899=${p899}"
    if [ "$streak" -ge "$CONFIRM" ]; then
      local now age_min
      now=$(date +%s)
      age_min=$(( (now - last_alert) / 60 ))
      if [ "$last_alert" -eq 0 ] || [ "$age_min" -ge "$REPEAT_MIN" ]; then
        send_push "抖音福袋·服务已停" "检测到抓取实例全部停止：hunter=${n_h} 个，9750/9752 均未监听，看板 8899=${p899}。电脑可能重启或崩溃，需手动拉起。时间 $(date '+%m-%d %H:%M')"
        last_alert=$now
      else
        say "  距上次告警仅 ${age_min} 分钟（<${REPEAT_MIN}），本次不重复推送"
      fi
    fi
  else
    if [ "${streak:-0}" -ge "$CONFIRM" ]; then
      say "✅ 服务已恢复：hunter=${n_h} 9750=${p750} 9752=${p752} 8899=${p899}"
      send_push "抖音福袋·服务已恢复" "抓取实例已恢复运行：hunter=${n_h} 个，9750=${p750} 9752=${p752}，看板 8899=${p899}。时间 $(date '+%m-%d %H:%M')"
    else
      say "✅ 正常：hunter=${n_h} 9750=${p750} 9752=${p752} 8899=${p899}"
    fi
    streak=0
  fi

  printf 'streak=%s\nlast_alert=%s\n' "$streak" "$last_alert" > "$STATE"
}

if [ "${DY_WD_ONCE:-0}" = "1" ]; then
  say "=== 单轮检测模式 ==="
  run_once
  exit 0
fi

say "=== 停机看门狗启动（间隔 ${INTERVAL}s，连续 ${CONFIRM} 次确认，重复提醒 ≥${REPEAT_MIN} 分钟）==="
while true; do
  run_once
  sleep "$INTERVAL"
done
