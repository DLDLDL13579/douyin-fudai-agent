#!/bin/bash
# 抖音福袋 · 全维度健康监控守护（2026-11-10 用户定稿「持续优化监控系统各个方面」）
#
# 设计原则：
#   ① 只读检测 + 精准拉起，绝不批量 kill、绝不动用户进程
#   ② 每 5 分钟一轮，异常写告警文件 + 日志，正常只记心跳
#   ③ 单实例锁，避免多份守护互相打架
#   ④ 所有阈值都可用环境变量覆盖，便于调参
#
# 监控维度：
#   A 服务存活      hunter/supervisor/cache/runtime/public/readonly 数量
#   B 端口监听      9750/9752 必须 LISTEN，9751 必须 0，8899/8898 必须 1
#   C 登录态        check-alive.sh 双端口
#   D 日志推进      两号日志 mtime 不得停滞超过阈值（守候期豁免）
#   E 效果回归      no-panel / need-follow 占比超阈值告警
#   F 看板一致性    byAccount 合计 == todayTotal
#   G 资源          load / 内存 / 磁盘，超阈值告警
#   H 中奖          wins.jsonl 出现新记录，立即告警
#
# 用法：
#   bash scripts/health-guard.sh              # 常驻
#   DY_HEALTH_ONCE=1 bash scripts/health-guard.sh   # 只跑一轮（排查用）

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

DATA="$ROOT/data"
ACC_MAIN="$ROOT/accounts/main/work"
ACC_MAIN3="$ROOT/accounts/main3/work"
LOG="$ROOT/douyin-auto/health-guard.log"
ALERT="$ROOT/douyin-auto/health-alerts.jsonl"
LOCK="/tmp/fudai-health-guard.lock"

INTERVAL="${DY_HEALTH_INTERVAL:-300}"        # 5 分钟一轮
LOG_STALL_SEC="${DY_HEALTH_LOG_STALL:-420}"  # 日志停滞阈值（超过则告警，守候期豁免）
LOAD_WARN="${DY_HEALTH_LOAD:-12}"            # load 5 分钟均值告警线
MEM_WARN="${DY_HEALTH_MEM:-20}"              # 内存空闲百分比下限
DISK_WARN_GB="${DY_HEALTH_DISK_GB:-5}"       # 磁盘可用下限 GiB
NOPANEL_PCT="${DY_HEALTH_NOPANEL:-25}"       # no-panel 占比告警线
NEEDFOLLOW_PCT="${DY_HEALTH_NEEDFOLLOW:-65}" # need-follow 占比告警线

mkdir -p "$ROOT/douyin-auto"

say(){ echo "[health $(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
alert(){
  local dim="$1"; shift
  local msg="$*"
  say "🚨 ALERT[$dim] $msg"
  printf '{"at":"%s","dim":"%s","msg":"%s"}\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$dim" "${msg//\"/\\\"}" >> "$ALERT"
  # 📱 2026-11-10 用户定稿：中奖与严重异常推 Server酱。
  #    只在「登录失效 / 服务全挂 / 磁盘告急」三类推，避免日常噪音。
  case "$dim" in
    C|H) send_push "[$dim] $msg" ;;
    G) case "$msg" in *磁盘*) send_push "[$dim] $msg" ;; esac ;;
  esac
}
send_push(){
  local body="$1"
  if [ -x "$(command -v node)" ] && [ -f "$ROOT/scripts/notify-serverchan.mjs" ]; then
    ( node "$ROOT/scripts/notify-serverchan.mjs" --title "抖音福袋·异常告警" --desp "$body" >>"$LOG" 2>&1 ) &
  fi
}

# ── 单实例锁 ───────────────────────────────────────────────────────────
# 🔴 2026-11-10 16:22 修锁缺陷：原实现「检查存在 → 写 PID」两步非原子，
#    同一秒启动两个实例会都通过检查（实测出现 2~3 个守护并存）。
#    改用 mkdir 原子性：mkdir 在同一路径只有一个能成功，天然互斥。
#    并校验锁内 PID 是否真在跑，崩溃残留会被接管。
LOCKDIR="${LOCK}.d"
acquired=0
for _try in 1 2 3; do
  if mkdir "$LOCKDIR" 2>/dev/null; then
    echo $$ > "$LOCKDIR/pid"
    acquired=1
    break
  fi
  # 锁已存在：看持有者是否还活着
  _oldpid=$(cat "$LOCKDIR/pid" 2>/dev/null || echo 0)
  if [ "${_oldpid:-0}" -gt 1 ] && kill -0 "$_oldpid" 2>/dev/null; then
    echo "[health] 已有守护实例 PID=${_oldpid}，本进程退出"
    exit 0
  fi
  # 陈旧锁（持有者已死）→ 清掉重试
  rm -rf "$LOCKDIR" 2>/dev/null
  sleep 1
done
if [ "$acquired" != "1" ]; then
  echo "[health] 抢锁失败，退出"
  exit 1
fi
cleanup(){ rm -rf "$LOCKDIR"; }
trap cleanup EXIT INT TERM

run_once(){
  local fails=0

  # ── B 端口监听 ──────────────────────────────────────────────────────
  port_listen(){ lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -c LISTEN; }
  # ⚠ 不用 local：autoheal 段也在 run_once 内引用这些值，local 在嵌套函数/子shell里会丢
  P9750=$(port_listen 9750); P9751=$(port_listen 9751)
  P9752=$(port_listen 9752); P8899=$(port_listen 8899); P8898=$(port_listen 8898)
  p9750=$P9750; p9751=$P9751; p9752=$P9752; p8899=$P8899; p8898=$P8898

  # ── A 服务存活 ──────────────────────────────────────────────────────
  local n_hunter n_sup n_cache n_runtime n_public n_readonly
  # ⚠ macOS 的 pgrep 不支持 -c（只支持 BSD 风格），统一用 pgrep|wc -l
  cnt(){ pgrep -f "$1" 2>/dev/null | wc -l | tr -d ' '; }
  n_hunter=$(cnt 'node hunter35\.mjs')
  n_sup=$(cnt 'run-h35\.sh')
  n_cache=$(cnt 'run-cache-cleaner\.sh')
  n_runtime=$(cnt 'runtime-cleaner\.sh')
  n_public=$(cnt 'run-public\.sh')
  n_readonly=$(cnt 'public-readonly\.mjs')

  [ "$n_hunter" -ne 2 ] && { alert A "hunter 进程 $n_hunter 个（期望2）"; fails=$((fails+1)); }
  [ "$n_sup" -ne 2 ]    && { alert A "supervisor $n_sup 个（期望2）"; fails=$((fails+1)); }
  [ "$n_cache" -ne 1 ]  && { alert A "cache-cleaner $n_cache 个（期望1）"; fails=$((fails+1)); }
  [ "$n_runtime" -ne 1 ]&& { alert A "runtime-cleaner $n_runtime 个（期望1）"; fails=$((fails+1)); }
  [ "$n_public" -lt 1 ] && { alert A "run-public $n_public 个（期望≥1）"; fails=$((fails+1)); }
  [ "$n_readonly" -lt 1 ]&&{ alert A "public-readonly $n_readonly 个（期望≥1）"; fails=$((fails+1)); }

  # ── A2 自动拉起（只拉起缺失的，绝不影响正在跑的）────────────────────
  if [ "${DY_HEALTH_AUTOHEAL:-1}" = "1" ]; then
    if [ "$n_hunter" -lt 2 ] && [ "$n_sup" -lt 2 ]; then
      say "🔧 自动拉起：hunter/supervisor 缺失"
      # 主实例
      if [ -n "$(lsof -nP -iTCP:9750 -sTCP:LISTEN 2>/dev/null)" ]; then :; else
        nohup bash "$ROOT/scripts/run-h35.sh" "$ACC_MAIN" main 9750 \
          >> "$ACC_MAIN/supervisor.log" 2>&1 < /dev/null &
        say "  → 已拉起主实例"
      fi
      sleep 3
      # 账号实例
      if [ -n "$(lsof -nP -iTCP:9752 -sTCP:LISTEN 2>/dev/null)" ]; then :; else
        nohup bash "$ROOT/scripts/run-h35.sh" "$ACC_MAIN3" main3 9752 \
          >> "$ACC_MAIN3/supervisor.log" 2>&1 < /dev/null &
        say "  → 已拉起 main3"
      fi
    fi
    if [ "${P8899:-0}" -lt 1 ]; then
      say "🔧 自动拉起：看板 8899"
      nohup bash "$ROOT/web/run-web.sh" 8899 >> /tmp/fudai-web-boot.log 2>&1 < /dev/null &
    fi
    if [ "${P8898:-0}" -lt 1 ] || [ "${n_public:-0}" -lt 1 ]; then
      say "🔧 自动拉起：公网守护"
      nohup bash "$ROOT/web/run-public.sh" >> /tmp/fudai-public-boot.log 2>&1 < /dev/null &
    fi
    if [ "$n_cache" -lt 1 ]; then
      say "🔧 自动拉起：cache-cleaner"
      nohup bash "$ROOT/scripts/run-cache-cleaner.sh" >> "$ROOT/douyin-auto/h35.log" 2>&1 < /dev/null &
    fi
    if [ "$n_runtime" -lt 1 ]; then
      say "🔧 自动拉起：runtime-cleaner"
      nohup bash "$ROOT/scripts/runtime-cleaner.sh" >> "$ROOT/douyin-auto/runtime-cleaner.log" 2>&1 < /dev/null &
    fi
  fi

  [ "$p9750" -lt 1 ] && { alert B "9750 未监听"; fails=$((fails+1)); }
  [ "$p9752" -lt 1 ] && { alert B "9752 未监听"; fails=$((fails+1)); }
  [ "$p9751" -ne 0 ] && { alert B "9751 竟在监听（main2 已删除，不该有）"; fails=$((fails+1)); }
  [ "$p8899" -lt 1 ] && { alert B "看板 8899 未监听"; fails=$((fails+1)); }
  [ "$p8898" -lt 1 ] && { alert B "只读代理 8898 未监听"; fails=$((fails+1)); }

  # ── C 登录态 ────────────────────────────────────────────────────────
  local a1 a2
  a1=$(bash "$ROOT/scripts/check-alive.sh" 9750 2>&1 | tail -1)
  a2=$(bash "$ROOT/scripts/check-alive.sh" 9752 2>&1 | tail -1)
  case "$a1" in
    *LOGIN_EXPIRED*) alert C "主号 9750 登录失效：$a1"; fails=$((fails+1));;
    *EMPTY_PAGE*|*SUSPECT*) say "  9750 瞬态：$a1";;
  esac
  case "$a2" in
    *LOGIN_EXPIRED*) alert C "main3 9752 登录失效：$a2"; fails=$((fails+1));;
  esac

  # ── D 日志推进（守候期豁免）────────────────────────────────────────
  for pair in "main:$ACC_MAIN/h35.log" "main3:$ACC_MAIN3/h35.log"; do
    local acc="${pair%%:*}" f="${pair#*:}"
    [ -f "$f" ] || { alert D "$acc 日志不存在"; fails=$((fails+1)); continue; }
    local age=$(( $(date +%s) - $(stat -f '%m' "$f") ))
    if [ "$age" -gt "$LOG_STALL_SEC" ]; then
      # 守候期日志心跳 60s，停滞超阈值基本可判异常；再确认最后一条是否守候
      local last; last=$(tail -1 "$f")
      case "$last" in
        *守候开奖*) say "  $acc 日志停 ${age}s 但末行是守候心跳，豁免";;
        *) alert D "$acc 日志停滞 ${age}s（阈值 ${LOG_STALL_SEC}s），末行：${last:0:80}"; fails=$((fails+1));;
      esac
    fi
  done

  # ── E 效果回归（今日结果占比）──────────────────────────────────────
  local eff
  eff=$(node -e '
    try{
      const fs=require("fs");
      const L=fs.readFileSync("data/participations.jsonl","utf8").trim().split("\n")
        .map(x=>{try{return JSON.parse(x)}catch(e){return null}}).filter(Boolean);
      const now=new Date();
      const rows=L.filter(r=>{const t=new Date(r.at);
        return t.getFullYear()===now.getFullYear()&&t.getMonth()===now.getMonth()&&t.getDate()===now.getDate()});
      const n=rows.length; if(!n){console.log("0 0 0 0");process.exit(0)}
      const np=rows.filter(r=>r.result==="no-panel").length;
      const nf=rows.filter(r=>r.result==="need-follow").length;
      const jn=rows.filter(r=>r.result==="joined"||r.result==="maybe-joined").length;
      console.log(n+" "+Math.round(np/n*100)+" "+Math.round(nf/n*100)+" "+Math.round(jn/n*100));
    }catch(e){console.log("0 0 0 0")}
  ' 2>/dev/null)
  local e_total e_np e_nf e_jn
  read -r e_total e_np e_nf e_jn <<< "$eff"
  if [ "${e_total:-0}" -gt 20 ]; then
    [ "${e_np:-0}" -gt "$NOPANEL_PCT" ] && alert E "no-panel 占比 ${e_np}%（阈值${NOPANEL_PCT}%，共${e_total}条）"
    [ "${e_nf:-0}" -gt "$NEEDFOLLOW_PCT" ] && alert E "need-follow 占比 ${e_nf}%（阈值${NEEDFOLLOW_PCT}%，共${e_total}条）"
    # 🔴 2026-11-10 16:47 用户批评「参与率太低，巡检没发现」后新增：
    #    只看各结果占比还不够，必须有「参与率绝对值」这条硬指标。
    #    参与率低于阈值直接告警，不再需要人肉翻看板。
    local join_pct="${JOIN_MIN_PCT:-35}"
    if [ "${e_jn:-0}" -lt "$join_pct" ]; then
      alert E "🔴 参与率仅 ${e_jn}%（低于 ${join_pct}%，共${e_total}条）——详见 bash scripts/inspect.sh"
    fi
  fi

  # ── F 看板一致性 ────────────────────────────────────────────────────
  local chk
  chk=$(curl -s -m 6 http://127.0.0.1:8899/api/status 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{
        const j=JSON.parse(s);
        const sum=(j.byAccount||[]).reduce((n,a)=>n+a.total,0);
        const t=j.stats?.todayTotal||0;
        const coins=j.exec?.coins, fansOk=j.exec?.fansOk;
        console.log((sum===t?"ok":"mismatch")+" "+(coins===fansOk?"ok":"coin-mismatch")+" "+sum+" "+t);
      }catch(e){console.log("api-fail 0 0")}
    });
  ' 2>/dev/null)
  local c_acc c_coin c_sum c_tot
  read -r c_acc c_coin c_sum c_tot <<< "${chk:-api-fail 0 0}"
  [ "$c_acc" = "api-fail" ] && { alert F "看板 API 无响应"; fails=$((fails+1)); }
  [ "$c_acc" = "mismatch" ] && alert F "byAccount 合计 ${c_sum} ≠ todayTotal ${c_tot}"
  [ "$c_coin" = "coin-mismatch" ] && alert F "抖币记账不一致 exec.coins ≠ exec.fansOk"

  # ── G 资源 ──────────────────────────────────────────────────────────
  local load5
  load5=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $3}')
  local load_i=${load5%.*}
  # 🔴 2026-11-10 16:29 优化 load 判据：单看 load 数值会持续误报。
  #    实测 load 13~15 的大头是本机 DSH 进程（node dsh web，75% CPU，已跑近 6 小时），
  #    用户自己的 Chrome 42 个进程也占一部分；抓取 Chrome 实测仅 0~4%。
  #    真正该告警的是「抓取被拖慢」，所以加第二个条件：日志推进停滞。
  #    只有 load 超阈值 **且** 日志确实停滞，才判定为自己这边出问题。
  if [ "${load_i:-0}" -gt "$LOAD_WARN" ]; then
    local _stalled=0
    for pair in "main:$ACC_MAIN/h35.log" "main3:$ACC_MAIN3/h35.log"; do
      local _f="${pair#*:}"
      [ -f "$_f" ] || continue
      local _age=$(( $(date +%s) - $(stat -f '%m' "$_f") ))
      [ "$_age" -gt "$LOG_STALL_SEC" ] && _stalled=1
    done
    if [ "$_stalled" = "1" ]; then
      alert G "load5=${load5} 超阈值 ${LOAD_WARN} 且抓取日志停滞，疑似被拖慢"
    else
      say "  load5=${load5} 超阈值但抓取日志正常推进（大头可能是本机其他进程），不告警"
    fi
  fi

  local memfree
  memfree=$(memory_pressure 2>/dev/null | grep -i 'free percentage' | grep -oE '[0-9]+' | head -1)
  [ "${memfree:-100}" -lt "$MEM_WARN" ] && alert G "内存空闲 ${memfree}% 低于 ${MEM_WARN}%"

  local disk_gb
  disk_gb=$(df -g "$ROOT" 2>/dev/null | awk 'NR==2{print $4}')
  [ "${disk_gb:-99}" -lt "$DISK_WARN_GB" ] && alert G "磁盘可用 ${disk_gb}Gi 低于 ${DISK_WARN_GB}Gi"

  # ── I1 定期重新学习「黑名单 + 时段画像」（每 30 分钟）──────────────
  # 🔴 2026-11-11 09:43 用户定稿：不发福袋的进黑名单；常发的学开播时间，
  #    未开播就不探测。数据源 anchors.json（visits/fudaiTotal/hourly）。
  #    30 分钟一次足够——福袋数据本来就在持续累积，不必更密；
  #    hunter 侧有 mtime 热更新，写完立即生效，不需要重启。
  local _ab="$ROOT/data/auto-blacklist.json"
  local _ab_age=999999
  if [ -f "$_ab" ]; then
    _ab_age=$(( $(date +%s) - $(stat -f '%m' "$_ab") ))
  fi
  if [ "$_ab_age" -gt 1800 ]; then
    local _lres
    _lres=$(node "$ROOT/scripts/auto-blacklist.mjs" 2>&1 | tail -2)
    say "🧠 重新学习黑名单/时段画像：${_lres//$'\n'/ | }"
  fi

  # ── I2 定期刷新本地关注名单（每 6 小时）────────────────────────────
  # 🔴 2026-11-11 07:17：hunter35 的 fans-panel 校验依赖 data/following-cache.json，
  #    实测 5 小时后主号关注数从 181 涨到 190，新增的未进缓存，会导致
  #    「uid 拿不到 + 本地名单未命中」时误拦已关注的房间。
  #    刷新本身要开 CDP 页面，开销不小，6 小时一次足够（关注变化不频繁）。
  local _fc="$ROOT/data/following-cache.json"
  local _fc_age=999999
  if [ -f "$_fc" ]; then
    _fc_age=$(( $(date +%s) - $(stat -f '%m' "$_fc") ))
  fi
  # 🔴 2026-11-11 09:53 用户报「主号也关注不了」后的根因修复：
  #    实测主播「颖姐财经」确实在主号关注列表第一页，但本地缓存没有它，
  #    因为缓存是 6 小时才刷一次（08:20 刷的只到 190 人，09:53 已 197 人）。
  #    hunter 校验时查不到就判未关注 → 好端端的福袋被拦。
  #    6 小时太长，改为 20 分钟——刷一次只开 2 个 CDP 页面、整个流程约 20 秒，
  #    相对 20 分钟的抓取时长可忽略，换来的是「新关注的主播几乎立即能被识别」。
  if [ "$_fc_age" -gt 1200 ]; then
    say "🔄 关注名单缓存已 ${_fc_age}s 未更新，开始刷新"
    local _rres
    _rres=$(node "$ROOT/scripts/refresh-following.mjs" 2>&1 | tail -3)
    say "  刷新结果：${_rres//$'\n'/ | }"
  fi

  # ── H 中奖告警 ──────────────────────────────────────────────────────
  if [ -f "$DATA/wins.jsonl" ]; then
    local wn
    wn=$(wc -l < "$DATA/wins.jsonl" | tr -d ' ')
    local marker="$ROOT/douyin-auto/.wins-seen"
    local prev=0
    [ -f "$marker" ] && prev=$(cat "$marker" 2>/dev/null || echo 0)
    if [ "${wn:-0}" -gt "${prev:-0}" ]; then
      local latest
      latest=$(tail -1 "$DATA/wins.jsonl" 2>/dev/null | cut -c1-200)
      alert H "🎉 新中奖记录 ${wn} 条！最新：${latest}"
    fi
    echo "${wn:-0}" > "$marker"
  fi

  # ── I 补发队列（配额耗尽时中奖消息会入队，配额恢复后自动补发）──────
  local qfile="$ROOT/data/notify-queue.jsonl"
  if [ -f "$qfile" ]; then
    local qn; qn=$(wc -l < "$qfile" 2>/dev/null | tr -d ' ')
    if [ "${qn:-0}" -gt 0 ]; then
      say "📮 待补发消息 ${qn} 条，尝试补发"
      local qres
      qres=$(node -e '
        import("./scripts/notify-serverchan.mjs").then(async m=>{
          const r=await m.flushQueue({});
          console.log(JSON.stringify(r));
        }).catch(e=>console.log(JSON.stringify({err:String(e.message)})));
      ' 2>/dev/null)
      case "$qres" in
        *'"sent":0'*) say "  配额仍未恢复，${qn} 条继续等待";;
        *) say "  补发结果：$qres";;
      esac
    fi
  fi

  # ── 心跳 ────────────────────────────────────────────────────────────
  if [ "$fails" -eq 0 ]; then
    say "✅ 全项正常 | hunter=$n_hunter sup=$n_sup 端口 9750=$p9750 9752=$p9752 8899=$p8899 | 今日 ${e_total}条 no-panel=${e_np}% need-follow=${e_nf}% joined=${e_jn}% | load5=${load5} 内存=${memfree}% 磁盘=${disk_gb}Gi"
  else
    say "⚠️ 本轮 $fails 项异常"
  fi
}

if [ "${DY_HEALTH_ONCE:-0}" = "1" ]; then
  say "=== 单轮检测模式 ==="
  run_once
  exit 0
fi

say "=== 健康监控守护启动（间隔 ${INTERVAL}s）==="
while true; do
  run_once
  sleep "$INTERVAL"
done
