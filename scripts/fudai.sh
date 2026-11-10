#!/bin/bash
# 抖音福袋 · 统一管理入口
#
# 用法:
#   ./fudai.sh                 查看帮助
#   ./fudai.sh status          系统状态（进程/账号/今日战果）
#   ./fudai.sh start           启动抓取任务
#   ./fudai.sh stop            停止抓取任务
#   ./fudai.sh restart         重启抓取任务
#   ./fudai.sh migrate         把现有登录态迁移为 default 账号（需 --force 确认停任务）
#   ./fudai.sh start-acc <名字> 启动指定账号的抓取实例（与主实例并行）
#   ./fudai.sh stop-acc <名字>  停止指定账号的抓取实例
#   ./fudai.sh start-all       启动所有已注册账号（错峰 30 秒）
#   ./fudai.sh stop-all        停止所有已注册账号
#   ./fudai.sh watch <房间号>   手动加入关注（同步进 VIP 池）
#   ./fudai.sh unwatch <房间号> 移除关注
#   ./fudai.sh watched         查看手动关注与自动 VIP 池
#   ./fudai.sh web             启动/检查 Web 看板
#   ./fudai.sh open            输出看板地址
#   ./fudai.sh accounts        账号管理（透传给 account-manager.mjs）
#   ./fudai.sh report [--all]  数据报表
#   ./fudai.sh export [--all]  导出 CSV 到 exports/
#   ./fudai.sh log [行数]      查看实时日志
#   ./fudai.sh follow          查看待手动关注清单

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
BASE="$ROOT/douyin-auto"
WEB_PORT=8899

# 精确匹配，避免误杀同名进程（曾误伤过 WorkBuddy 的 server.mjs）
proc_pids() {
  # ⚠ 不能写 grep -v -- '--account'：那会把多账号模式的进程排除掉，
  #   导致 stop 杀不掉它们，残留进程继续抢 Chrome 端口造成双实例。
  #   2026-11-03 实际踩过：stop 后 72217（--account main）仍在跑，与新进程抢 9750。
  ps -eo pid,args | grep -F "node hunter35.mjs" | grep -v grep | awk '{print $1}'
}
web_pids() {
  ps -eo pid,args | grep -F "node server.mjs $WEB_PORT" | grep -v grep | awk '{print $1}'
}
running() { [ -n "$(proc_pids)" ]; }
# 只看默认主实例（不带 --account）。多账号并行时 cmd_start 不能用 running()，
# 否则账号实例在跑就会被误判成「主实例已在运行」，restart 后主实例起不来。
main_running() {
  ps -eo pid,args | grep -F "node hunter35.mjs" | grep -v grep | grep -v -- "--account " | awk '{print $1}' | grep -q .
}
web_running() { curl -s -m 2 -o /dev/null "http://127.0.0.1:$WEB_PORT/" 2>/dev/null; }

list_accounts() {
  [ -d "$ROOT/accounts" ] || return
  find "$ROOT/accounts" -maxdepth 1 -mindepth 1 -type d -exec basename {} \; 2>/dev/null | sort
}
account_enabled() {
  local m="$ROOT/accounts/$1/meta.json"
  [ -f "$m" ] || return 1
  node -e "const m=require('$m');process.exit(m.enabled===false?1:0)" 2>/dev/null
}
account_pids() {
  ps -eo pid,args | grep -F "node hunter35.mjs --account $1" | grep -v grep | awk '{print $1}'
}

cmd_status() {
  echo "════════ 抖音福袋 · 系统状态 ════════"
  echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
  echo
  echo "【抓取任务】"
  if running; then
    for p in $(proc_pids); do
      ps -o pid=,etime= -p "$p" | awk '{printf "  ✅ 运行中  PID %s  时长 %s\n", $1, $2}'
    done
  else
    echo "  ❌ 未运行（用 ./fudai.sh start 启动）"
  fi
  if lsof -nP -iTCP:9750 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  ✅ Chrome 9750 监听中"
  else
    echo "  ❌ Chrome 9750 未监听"
  fi
  echo
  echo "【Web 看板】"
  if web_running; then echo "  ✅ http://127.0.0.1:$WEB_PORT"; else echo "  ❌ 未运行（用 ./fudai.sh web 启动）"; fi
  echo
  echo "【今日战果】"
  node "$SCRIPTS/data-report.mjs" 2>/dev/null | sed -n '/【总览】/,/^$/p' | sed 's/^/  /'
  echo
  echo "【账号】"
  node "$SCRIPTS/account-manager.mjs" list 2>/dev/null | sed 's/^/  /'
  echo "════════════════════════════════════"
}

cmd_start() {
  if main_running; then echo "主实例已在运行"; return; fi
  cd "$ROOT" || exit 1
  # ⚠ 不要用 --account 模式：那会把工作目录切到 accounts/<名字>/work/，
  #   h35.log、h35-results.jsonl、状态文件全跑到那里，而看板和巡检读的是 douyin-auto/，
  #   表现为「日志几分钟不更新」的假死（2026-11-03 实际踩过两次）。
  #   登录态已经通过「把 accounts/<名字>/profile/Default 复制到 douyin-auto/chrome-profile/Default」
  #   同步到主 profile，所以直接走默认模式即可。
  nohup bash scripts/run-h35.sh "$BASE" >> "$BASE/h35-supervisor.log" 2>&1 &
  # ⚠ 不能只 sleep 固定秒数就判断：Chrome 拉起需要 8-15 秒（node 内部要轮询
  #   CDP 端口就绪 120 次×500ms 才进主循环），原来只等 6 秒，会误报「启动失败」——
  #   2026-11-03 08:58 实际踩过：脚本报失败，但进程和 Chrome 其实都在正常运行。
  #   改为最多等 40 秒的轮询。
  for _i in $(seq 1 20); do
    sleep 2
    if running; then echo "✅ 已启动（约 $((_i*2)) 秒就绪）"; return; fi
  done
  echo "❌ 启动失败，查看 $BASE/h35-supervisor.log"
}

supervisor_pids() {
  ps -eo pid,args | grep -F "run-h35.sh" | grep -v grep | grep -v run-web | awk '{print $1}'
}

# stop [main-only]
#   默认：全量停（主实例 + 所有账号实例 + 所有 Chrome），用于彻底关机/排障。
#   main-only：只停默认主实例（9750），保留账号实例。
#   ⚠ 2026-11-04 教训：多账号并行时直接 ./fudai.sh restart 会把账号实例也一起杀掉，
#     因为它内部调的是全量 cmd_stop。restart 已改为走 main-only。
cmd_stop() {
  local only_main="${1:-}"
  local sp nps
  sp=$(supervisor_pids); nps=$(proc_pids)
  if [ -z "$sp" ] && [ -z "$nps" ]; then echo "抓取任务未在运行"; return; fi

  if [ "$only_main" = "main-only" ]; then
    # 只停默认主实例：supervisor（无账号名参数）+ 不带 --account 的 node + 9750 Chrome。
    # 账号实例的 supervisor 命令行含 accounts/<名字>/work，node 含 --account <名字>，
    # 两者都要保留，否则重启主实例会连带把正在抢福袋的第二个号杀掉。
    for p in $sp; do
      local args
      args=$(ps -o args= -p "$p" 2>/dev/null)
      case "$args" in *"accounts/"*) continue ;; esac
      kill -9 "$p" 2>/dev/null
    done
    sleep 1
    for p in $nps; do
      local a2
      a2=$(ps -o args= -p "$p" 2>/dev/null)
      case "$a2" in *"--account "*) continue ;; esac
      kill -9 "$p" 2>/dev/null
    done
    for _p in $(ps -eo pid,args | grep -F 'remote-debugging-port=9750' | grep -v grep | awk '{print $1}'); do
      kill -9 "$_p" 2>/dev/null
    done
  else
    # 全量停
    # ⚠ 必须先杀 supervisor：否则它发现 node 退出后 20 秒又拉起一个新的，
    #   造成「停了又活」甚至双实例（2026-11-02 实际踩过两次）
    for p in $sp; do kill -9 "$p" 2>/dev/null; done
    sleep 1
    for p in $nps; do kill -9 "$p" 2>/dev/null; done
    # ⚠ 不能只杀 9750：多账号并行时每个实例端口不同（9750/9751/…），
    #   写死端口会留下账号实例的 Chrome 孤儿进程，继续占着 profile 锁。
    for _p in $(ps -eo pid,args | grep -E 'remote-debugging-port=97(5|6)[0-9]' | grep -v grep | awk '{print $1}'); do
      kill -9 "$_p" 2>/dev/null
    done
  fi
  sleep 3
  if [ -n "$(supervisor_pids)$(proc_pids)" ]; then
    echo "⚠️ 仍有残留进程"
    ps -eo pid,args | grep -E 'node hunter35\.mjs|run-h35\.sh' | grep -v grep | cut -c1-70
  else
    echo "✅ 已停止（supervisor 与 node 均已清理）"
  fi
}

cmd_start_all() {
  local accs; accs=$(list_accounts)
  if [ -z "$accs" ]; then
    echo "还没有注册账号。用 ./fudai.sh accounts add <名字> 扫码添加。"
    echo "（当前单账号任务仍在运行，不受影响）"
    return
  fi
  local n=0
  for acc in $accs; do
    account_enabled "$acc" || { echo "  跳过 ${acc}（已禁用）"; continue; }
    if [ -n "$(account_pids "$acc")" ]; then echo "  已在运行: $acc"; continue; fi
    local work="$ROOT/accounts/$acc/work"
    mkdir -p "$work"
    nohup bash "$SCRIPTS/run-h35.sh" "$work" "$acc" >> "$work/supervisor.log" 2>&1 &
    echo "  已启动: ${acc}（端口见 accounts/$acc/meta.json）"
    n=$((n+1))
    # 错峰 30 秒：多账号同时抓首页容易触发风控
    [ "$n" -lt "$(echo "$accs" | wc -l | tr -d ' ')" ] && sleep 30
  done
  echo "本轮启动 $n 个账号"
}

# 启动单个账号的抓取实例。与主实例并行运行，各自独立采集与参与。
# 用账号模式时 hunter35 会把日志写到 accounts/<名字>/work/，
# 看板通过 instancesInfo() 聚合展示，不会像早期那样「看不见」。
# 内存前置检查。实测每个抓取实例的 headless Chrome 占 1.4-2.0GB，
# 而本机 16GB 里用户自己的 Chrome 常占 3.4GB。双实例把 swap 打满后，
# 两个实例都会出现「页面空白 len=20」的加载超时，反而降低福袋发现率。
# 2026-11-03 实测：双实例时 load 58、swap 7.0G/8G；停掉一个后 load 降到 13。
mem_ok() {
  local swapused freemb
  swapused=$(sysctl -n vm.swapusage 2>/dev/null | sed -E 's/.*used = ([0-9.]+)M.*/\1/' | cut -d. -f1)
  freemb=$(vm_stat 2>/dev/null | awk '/Pages free/{gsub(/\./,"",$3); print int($3*4096/1048576)}')
  echo "  当前 swap 已用 ${swapused:-?}MB，空闲内存 ${freemb:-?}MB"
  if [ "${swapused:-0}" -gt 6144 ]; then echo "  ⚠ swap 已用超过 6GB"; return 1; fi
  if [ "${freemb:-99999}" -lt 900 ]; then echo "  ⚠ 空闲内存不足 900MB"; return 1; fi
  return 0
}

cmd_start_acc() {
  local acc="${1:-}" force="${2:-}"
  if [ -z "$acc" ]; then
    echo "用法: ./fudai.sh start-acc <账号名> [--force]"
    echo "可用账号:"; list_accounts | sed 's/^/  /'
    return
  fi
  [ -d "$ROOT/accounts/$acc" ] || { echo "账号「${acc}」不存在"; return; }
  account_enabled "$acc" || { echo "账号「${acc}」已禁用（meta.json enabled=false）"; return; }
  if [ -n "$(account_pids "$acc")" ]; then echo "账号「${acc}」已在运行"; return; fi
  echo "启动前资源检查:"
  if ! mem_ok; then
    if [ "$force" = "--force" ]; then
      echo "  --force 已指定，忽略内存告警继续启动"
    else
      echo "  ❌ 内存不足，已拒绝启动。确认要跑就加 --force:"
      echo "     ./fudai.sh start-acc $acc --force"
      return
    fi
  fi
  local work="$ROOT/accounts/$acc/work"
  mkdir -p "$work"
  nohup bash "$SCRIPTS/run-h35.sh" "$work" "$acc" >> "$work/supervisor.log" 2>&1 &
  for _i in $(seq 1 25); do
    sleep 2
    if [ -n "$(account_pids "$acc")" ]; then
      echo "✅ 账号「${acc}」已启动（约 $((_i*2)) 秒就绪），日志 $work/h35.log"
      return
    fi
  done
  echo "❌ 账号「${acc}」启动失败，查看 $work/supervisor.log"
}

cmd_stop_acc() {
  local acc="${1:-}"
  [ -z "$acc" ] && { echo "用法: ./fudai.sh stop-acc <账号名>"; return; }
  # ⚠ 不能 grep 完整中文路径：ps 会把非 ASCII 字节转义成 M-iM^BM^S 这种形式，
  #   grep 中文路径必然 0 匹配，supervisor 杀不掉 → 它 20 秒后又把 node 拉起来，
  #   表现为「stop 成功但进程还在」（2026-11-03 实际踩过）。
  #   只用 ASCII 片段（run-h35.sh + 账号名）匹配。
  for p in $(ps -eo pid,args | grep -F "run-h35.sh" | grep -F "accounts/$acc/work" | grep -v grep | awk '{print $1}'); do
    kill -9 "$p" 2>/dev/null
  done
  sleep 1
  for p in $(account_pids "$acc"); do kill -9 "$p" 2>/dev/null; done
  local port; port=$(node -e "try{console.log(require('$ROOT/accounts/$acc/meta.json').port||9751)}catch(e){console.log(9751)}")
  for p in $(ps -eo pid,args | grep -F "remote-debugging-port=$port" | grep -v grep | awk '{print $1}'); do
    kill -9 "$p" 2>/dev/null
  done
  sleep 2
  if [ -n "$(account_pids "$acc")" ]; then echo "⚠️ 「${acc}」仍有残留进程"; else echo "✅ 账号「${acc}」已停止"; fi
}

cmd_stop_all() {
  local accs; accs=$(list_accounts)
  if [ -z "$accs" ]; then echo "没有注册账号"; return; fi
  for acc in $accs; do
    local pids; pids=$(account_pids "$acc")
    if [ -n "$pids" ]; then
      for p in $pids; do kill "$p" 2>/dev/null; done
      echo "  已停止: $acc"
    fi
  done
  sleep 2
  # 清理账号模式残留的 Chrome
  pkill -f 'accounts/.*/profile' 2>/dev/null
  echo "完成"
}

cmd_migrate() {
  local force="${1:-}"
  if [ -d "$ROOT/accounts/default" ]; then
    echo "accounts/default 已存在，无需迁移"
    return
  fi
  if running; then
    if [ "$force" != "--force" ]; then
      echo "⚠️  检测到旧模式抓取任务正在运行（douyin-auto/）"
      echo "    迁移需要先停止任务，会中断约 1 分钟，然后从新路径启动"
      echo "    确认执行: ./fudai.sh migrate --force"
      return
    fi
    echo "停止旧任务..."
    cmd_stop
    sleep 4
  fi
  echo "导入现有登录态到 accounts/default ..."
  node "$SCRIPTS/account-manager.mjs" import default || { echo "导入失败"; return; }
  echo
  echo "✅ 迁移完成。后续用这些命令:"
  echo "   ./fudai.sh start-all     启动账号模式"
  echo "   ./fudai.sh accounts list 查看账号"
}

# 用户手动指定的关注房间（与系统自动发现的 VIP 池共用，但分开记录来源）
WATCH_FILE() { echo "$ROOT/douyin-auto/watch-rooms.txt"; }

cmd_watch() {
  local room="${1:-}"
  if [ -z "$room" ]; then
    echo "用法: ./fudai.sh watch <房间号>"
    echo "       ./fudai.sh unwatch <房间号>"
    echo "       ./fudai.sh watched"
    return
  fi
  # 支持两种：纯数字房间号（6位以上）或抖音号（字母数字，如 dehua66888）
  if ! echo "$room" | grep -qE '^([0-9]{6,}|[A-Za-z][A-Za-z0-9_]{2,})$'; then
    echo "格式不对：应为 6 位以上数字房间号，或抖音号（如 dehua66888）"
    return
  fi
  local f; f=$(WATCH_FILE)
  touch "$f"
  if grep -qx "$room" "$f" 2>/dev/null; then
    echo "该房间已在关注列表中"
    return
  fi
  echo "$room" >> "$f"
  # 同步进系统 VIP 池，让其参与优先级排序与主动探测
  local vf="$ROOT/scripts/known-fudai-hosts.txt"
  if ! grep -qx "$room" "$vf" 2>/dev/null; then
    echo "$room" >> "$vf"
    echo "✅ 已加入关注列表并同步进 VIP 池: $room"
  else
    echo "✅ 已加入关注列表（VIP 池中已存在）: $room"
  fi
  echo "   下次重启抓取任务后生效（或 ./fudai.sh restart）"
}

cmd_unwatch() {
  local room="${1:-}"
  [ -z "$room" ] && { echo "用法: ./fudai.sh unwatch <房间号>"; return; }
  local f; f=$(WATCH_FILE)
  if [ -f "$f" ]; then
    grep -vx "$room" "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
  fi
  local vf="$ROOT/scripts/known-fudai-hosts.txt"
  if [ -f "$vf" ]; then
    grep -vx "$room" "$vf" > "$vf.tmp" 2>/dev/null && mv "$vf.tmp" "$vf"
  fi
  echo "✅ 已从关注列表与 VIP 池移除: $room"
}

cmd_watched() {
  echo "【手动关注列表】"
  local f; f=$(WATCH_FILE)
  if [ -s "$f" ]; then
    sed 's/^/  /' "$f"
  else
    echo "  暂无（用 ./fudai.sh watch <房间号> 添加）"
  fi
  echo
  echo "【系统自动发现的 VIP 池】"
  local vf="$ROOT/scripts/known-fudai-hosts.txt"
  if [ -s "$vf" ]; then
    nl -ba "$vf" | sed 's/^/  /'
  else
    echo "  空"
  fi
}

cmd_web() {
  if web_running; then echo "看板已在运行: http://127.0.0.1:$WEB_PORT"; return; fi
  cd "$ROOT" || exit 1
  nohup bash web/run-web.sh "$WEB_PORT" > /tmp/fudai-web.log 2>&1 &
  sleep 4
  if web_running; then echo "✅ 看板已启动: http://127.0.0.1:$WEB_PORT"; else echo "❌ 启动失败，查看 /tmp/fudai-web.log"; fi
}

cmd_log() {
  local n="${1:-30}"
  tail -n "$n" "$BASE/h35.log" 2>/dev/null || echo "日志不存在"
}

cmd_follow() {
  if [ -f "$BASE/should-follow.md" ]; then cat "$BASE/should-follow.md"; else echo "暂无待关注清单"; fi
}

case "${1:-}" in
  status)   cmd_status ;;
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_stop main-only; sleep 2; cmd_start ;;
  start-acc)  cmd_start_acc "${2:-}" "${3:-}" ;;
  stop-acc)   cmd_stop_acc "${2:-}" ;;
  start-all)  cmd_start_all ;;
  stop-all)   cmd_stop_all ;;
  migrate)  cmd_migrate "${2:-}" ;;
  watch)    cmd_watch "${2:-}" ;;
  unwatch)  cmd_unwatch "${2:-}" ;;
  watched)  cmd_watched ;;
  web)      cmd_web ;;
  open)     echo "http://127.0.0.1:$WEB_PORT" ;;
  accounts) shift; node "$SCRIPTS/account-manager.mjs" "$@" ;;
  report)   shift; node "$SCRIPTS/data-report.mjs" "$@" ;;
  export)   shift; node "$SCRIPTS/export-csv.mjs" "$@" ;;
  log)      shift; cmd_log "${1:-30}" ;;
  follow)   cmd_follow ;;
  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
