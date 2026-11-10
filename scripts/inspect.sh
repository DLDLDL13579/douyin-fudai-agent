#!/bin/bash
# 抖音福袋 · 全面巡检（2026-11-10 16:36 用户批评「这么明显的错误都没巡检到，需要覆盖全面」后重写）
#
# 原巡检的失职：只检查「进程在不在、端口通不通、内存够不够」，
# 完全没有检查「到底抢到没有、为什么没抢到」——
# 于是 45% need-follow + 19% no-panel 这种致命的参与率问题，
# 连续多轮巡检都报「全项正常」。
#
# 本脚本的分层设计：
#   L0 服务层：进程、端口、登录态
#   L1 产出层：今日参与率、各结果占比、分账号战绩、分时段趋势
#   L2 归因层：每个亏损类别的根因分布、是否在恶化、是否为新引入
#   L3 质量层：日志异常、看板一致性、资源压力、推送队列
#   L4 结论层：明确列出「最该修的一件事」，而不是罗列一堆数字
#
# 用法：
#   bash scripts/inspect.sh            # 完整巡检
#   bash scripts/inspect.sh --brief    # 只输出结论与亏损 Top3

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"
BRIEF=0
[ "${1:-}" = "--brief" ] && BRIEF=1

hr(){ printf '─%.0s' $(seq 1 60); echo; }
say(){ echo "$*"; }

echo "════ 抖音福袋巡检 $(date '+%m-%d %H:%M:%S') ════"

# ────────────────────────────────────────────────────────────
# L0 服务层
# ────────────────────────────────────────────────────────────
echo
say "【L0 服务层】"
# ⚠ 2026-11-10 19:47：这台机器 ps 受限（返回空），只能用 pgrep。
#    实测巡检整轮跑时 H 偶尔变 4（实际 2 个 hunter），是 pgrep -f 匹配到了
#    同轮里其它命令行含该串的瞬时子进程。用「排除自己 + 只数 node 进程」收紧。
cnt(){
  # 只排除「巡检脚本自身这一轮里的瞬时子进程」：
  #   - 命令行含 scripts/inspect.sh 的（就是我自己）
  #   - 纯 grep 进程
  # 不排除 health-guard.sh —— 它本身就是要数的守护之一。
  pgrep -f "$1" 2>/dev/null | while read -r _p; do
    _cmd=$(ps -p "$_p" -o args= 2>/dev/null)
    [ -z "$_cmd" ] && { echo "$_p"; continue; }
    case "$_cmd" in
      *inspect.sh*) ;;
      grep\ *|grep) ;;
      *) echo "$_p" ;;
    esac
  done | wc -l | tr -d ' '
}
pl(){ lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -c LISTEN; }

H=$(cnt 'node hunter35\.mjs'); S=$(cnt 'run-h35\.sh')
C=$(cnt 'run-cache-cleaner\.sh'); R=$(cnt 'runtime-cleaner\.sh')
P=$(cnt 'run-public\.sh'); RO=$(cnt 'public-readonly\.mjs'); HG=$(cnt 'health-guard\.sh')
say "  进程  hunter=$H(2) sup=$S(2) cache=$C(1) runtime=$R(1) public=$P(1) readonly=$RO(1) health=$HG(1)"
P9750=$(pl 9750); P9751=$(pl 9751); P9752=$(pl 9752); P8899=$(pl 8899); P8898=$(pl 8898)
say "  端口  9750=$P9750(1) 9751=$P9751(0) 9752=$P9752(1) 8899=$P8899(1) 8898=$P8898(1)"

L0BAD=0
[ "$H" -ne 2 ] && L0BAD=$((L0BAD+1))
[ "$S" -ne 2 ] && L0BAD=$((L0BAD+1))
[ "$P9750" -lt 1 ] && L0BAD=$((L0BAD+1))
[ "$P9752" -lt 1 ] && L0BAD=$((L0BAD+1))
[ "$P9751" -ne 0 ] && L0BAD=$((L0BAD+1))
[ "$P8899" -lt 1 ] && L0BAD=$((L0BAD+1))

# 登录态（每个号都要查，不能被瞬态吓到）
for pp in 9750 9752; do
  A=$(bash "$ROOT/scripts/check-alive.sh" "$pp" 2>&1 | tail -1)
  case "$A" in
    *LOGIN_EXPIRED*) say "  ⛔ $pp 登录失效：$A"; L0BAD=$((L0BAD+1));;
    *OK*)            say "  ✅ $pp $A";;
    *)               say "  ⚠️  $pp $A";;
  esac
done
# 🔴 2026-11-10 19:25 补：验证看板读的日志与真实日志是否同一份。
#    用户 19:07 指出「日志时间似乎不对」，查实是看板读了冻结的旧文件
#    （douyin-auto/h35.log 从 10:31 起没内容），而巡检只查 accounts/*/work/h35.log，
#    两者不是同一份 → 巡检看不到看板的问题。这条补上这个盲区。
CHKLOG=$(curl -s -m 6 http://127.0.0.1:8899/api/status 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const j=JSON.parse(s);
    const t=(j.logTail||"").split("\n").filter(Boolean).pop()||"";
    const m=t.match(/^\[(\d\d):(\d\d):(\d\d)\]/);
    if(!m){console.log("NOSTAMP");process.exit(0)}
    const now=new Date();
    const lm=+m[1]*3600+ +m[2]*60+ +m[3];
    const nm=now.getHours()*3600+now.getMinutes()*60+now.getSeconds();
    let diff=nm-lm; if(diff<0)diff+=86400;
    console.log(diff);
  }catch(e){console.log("API_FAIL")}
});' 2>/dev/null)
case "$CHKLOG" in
  API_FAIL|NOSTAMP|"") say "  ⚠️ 看板日志不可校验：$CHKLOG";;
  *) if [ "$CHKLOG" -gt 120 ]; then
       say "  ⛔ 看板日志落后真实时间 ${CHKLOG}s（可能读了冻结的旧文件）"
       L0BAD=$((L0BAD+1))
     else
       say "  ✅ 看板日志与真实时间同步（差 ${CHKLOG}s）"
     fi;;
esac

say "  L0 结论：$([ "$L0BAD" -eq 0 ] && echo '服务全部正常' || echo "$L0BAD 项异常")"

# ────────────────────────────────────────────────────────────
# L1 产出层（原巡检完全缺失的部分）
# ────────────────────────────────────────────────────────────
echo
say "【L1 产出层 · 到底抢到没有】"
L1=$(node -e '
const fs=require("fs");
let L=[];
try{
  L=fs.readFileSync("data/participations.jsonl","utf8").trim().split("\n")
    .map(x=>{try{return JSON.parse(x)}catch(e){return null}}).filter(Boolean);
}catch(e){}
const now=new Date();
const isToday=(iso)=>{const t=new Date(iso);
  return t.getFullYear()===now.getFullYear()&&t.getMonth()===now.getMonth()&&t.getDate()===now.getDate()};
const today=L.filter(r=>isToday(r.at));
const n=today.length;
if(!n){console.log("NODATA");process.exit(0)}
const c={};
today.forEach(r=>{c[r.result||"?"]=(c[r.result||"?"]||0)+1});
const joined=(c["joined"]||0)+(c["maybe-joined"]||0);
const order=Object.entries(c).sort((a,b)=>b[1]-a[1]);
console.log("TOTAL "+n+" JOINED "+joined+" RATE "+(joined/n*100).toFixed(1));
order.forEach(([k,v])=>console.log("R "+k+" "+v+" "+(v/n*100).toFixed(1)));
// 分账号
const acc={};
today.forEach(r=>{const a=r.account||"?";acc[a]=acc[a]||{n:0,j:0};acc[a].n++;if(r.result==="joined"||r.result==="maybe-joined")acc[a].j++});
Object.entries(acc).forEach(([a,v])=>console.log("A "+a+" "+v.n+" "+v.j+" "+(v.j/v.n*100).toFixed(1)));
// 分时段（近3小时 vs 更早）——按真实时间戳算，不用整点窗口
// ⚠ 2026-11-10 19:08 修正：原用 getHours()>=h-2 会让 19:08 时的窗口变成 17~19 点，
//   只覆盖约 2 小时；且整点边界会把 16:59 的记录算进「更早」。改用 Date.now()-3h。
const _cut=Date.now()-3*3600*1000;
const recent=today.filter(r=>new Date(r.at).getTime()>=_cut);
const older=today.filter(r=>new Date(r.at).getTime()<_cut);
if(recent.length)console.log("P recent "+recent.length+" "+(recent.filter(r=>r.result==="joined"||r.result==="maybe-joined").length/recent.length*100).toFixed(1));
if(older.length)console.log("P older "+older.length+" "+(older.filter(r=>r.result==="joined"||r.result==="maybe-joined").length/older.length*100).toFixed(1));
// 亏损类别明细
["need-follow","no-panel","fans-skip-daytime","fans-skip-account","fans-unverified","fans-no-coins","packet-skipped"].forEach(k=>{
  if(c[k])console.log("LOSS "+k+" "+c[k]);
});
// wins
try{
  const w=fs.readFileSync("data/wins.jsonl","utf8").trim().split("\n").filter(Boolean);
  const wt=w.map(x=>{try{return JSON.parse(x)}catch(e){return null}}).filter(Boolean).filter(r=>isToday(r.at));
  console.log("WINS "+wt.length);
}catch(e){console.log("WINS 0")}
' 2>/dev/null)

if echo "$L1" | grep -q NODATA; then
  say "  今日尚无参与记录"
else
  TOT=$(echo "$L1" | awk '/^TOTAL/{print $2}')
  JN=$(echo "$L1"  | awk '/^TOTAL/{print $4}')
  RT=$(echo "$L1"  | awk '/^TOTAL/{print $6}')
  say "  今日遭遇 ${TOT} · 参与成功 ${JN} · 参与率 ${RT}%"
  say "  结果分布："
  echo "$L1" | awk '/^R /{printf "    %-22s %4s  %s%%\n", $2, $3, $4}'
  say "  分账号："
  echo "$L1" | awk '/^A /{printf "    %-8s %4s次 %4s中  %s%%\n", $2, $3, $4, $5}'
  say "  分时段："
  echo "$L1" | awk '/^P /{if($2=="recent")printf "    近3小时  %4s次  %s%%\n",$3,$4; else printf "    更早      %4s次  %s%%\n",$3,$4}'
  WN=$(echo "$L1" | awk '/^WINS/{print $2}')
  [ "${WN:-0}" -gt 0 ] && say "  🎉 今日中奖 ${WN} 次！" || say "  今日中奖 0"
fi

# ────────────────────────────────────────────────────────────
# L2 归因层（回答「为什么」）
# ────────────────────────────────────────────────────────────
echo
say "【L2 归因层 · 为什么没抢到】"
L2=$(node -e '
const fs=require("fs");
let L=[];
try{L=fs.readFileSync("data/exec-actions.jsonl","utf8").trim().split("\n").map(x=>{try{return JSON.parse(x)}catch(e){return null}}).filter(Boolean)}catch(e){}
const now=new Date();
const isToday=(iso)=>{const t=new Date(iso);return t.getFullYear()===now.getFullYear()&&t.getMonth()===now.getMonth()&&t.getDate()===now.getDate()};
const t=L.filter(r=>isToday(r.at)&&r.action==="follow");
const by={};
t.forEach(r=>{const k=(r.account||"?")+"|"+(r.verifyHow||r.state||"?");by[k]=(by[k]||0)+1});
Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([k,v])=>console.log("F "+k+" "+v));
// no-panel 形态
let P=[];
try{P=fs.readFileSync("data/participations.jsonl","utf8").trim().split("\n").map(x=>{try{return JSON.parse(x)}catch(e){return null}}).filter(Boolean)}catch(e){}
const np=P.filter(r=>isToday(r.at)&&r.result==="no-panel");
const st={};
np.forEach(r=>{const s=JSON.stringify(r.steps||[]);st[s]=(st[s]||0)+1});
Object.entries(st).sort((a,b)=>b[1]-a[1]).slice(0,5).forEach(([k,v])=>console.log("NP "+v+" "+k.slice(0,120)));
' 2>/dev/null)
say "  关注判定分布（谁在拦）："
echo "$L2" | awk '/^F /{printf "    %-28s %s\n", $2, $3}'
NPF=$(echo "$L2" | awk '/^NP /{print; exit}')
if [ -n "$NPF" ]; then
  say "  no-panel 主形态："
  echo "$L2" | awk '/^NP /{printf "    %s次  %s\n", $2, substr($0, index($0,$3))}'
fi

# 与昨日对比，判断是否恶化
L2B=$(node -e '
const fs=require("fs");
let L=[];
try{L=fs.readFileSync("data/participations.jsonl","utf8").trim().split("\n").map(x=>{try{return JSON.parse(x)}catch(e){return null}}).filter(Boolean)}catch(e){}
function day(o){const d=new Date();d.setDate(d.getDate()-o);
  return L.filter(r=>{const t=new Date(r.at);return t.getFullYear()===d.getFullYear()&&t.getMonth()===d.getMonth()&&t.getDate()===d.getDate()})}
const y=day(1);const n=y.length;
if(!n)process.exit(0);
const j=y.filter(r=>r.result==="joined"||r.result==="maybe-joined").length;
const nf=y.filter(r=>r.result==="need-follow").length;
const np=y.filter(r=>r.result==="no-panel").length;
console.log("Y "+n+" "+(j/n*100).toFixed(1)+" "+(nf/n*100).toFixed(1)+" "+(np/n*100).toFixed(1));
' 2>/dev/null)
[ -n "$L2B" ] && say "  昨日对照：$(echo "$L2B" | awk '{print "遭遇"$2" 参与率"$3"% need-follow"$4"% no-panel"$5"%"}')"

# ────────────────────────────────────────────────────────────
# L3 质量层
# ────────────────────────────────────────────────────────────
echo
say "【L3 质量层】"
L3BAD=0
for f in accounts/main/work/h35.log accounts/main3/work/h35.log; do
  acc=$(echo "$f" | cut -d/ -f2)
  [ -f "$f" ] || { say "  ⛔ $acc 日志不存在"; L3BAD=$((L3BAD+1)); continue; }
  S2=$(grep -n '=== hunter35' "$f" | tail -1 | cut -d: -f1)
  T=$(tail -n +"$S2" "$f")
  FT=$(echo "$T" | grep -c FATAL || true)
  TO=$(echo "$T" | grep -c '开奖检测.*异常' || true)
  DC=$(echo "$T" | grep -c '🔌' || true)
  CF=$(echo "$T" | grep -c '抖币消费记账失败' || true)
  AGE=$(( $(date +%s) - $(stat -f '%m' "$f") ))
  say "  $acc  FATAL=$FT timeout=$TO 断连=$DC 抖币失败=$CF 日志停=${AGE}s"
  [ "$FT" -gt 0 ] && L3BAD=$((L3BAD+1))
  [ "$CF" -gt 0 ] && L3BAD=$((L3BAD+1))
  [ "$AGE" -gt 600 ] && { say "    ⚠️ 日志停滞超过 10 分钟"; L3BAD=$((L3BAD+1)); }
done

# 看板一致性
CHK=$(curl -s -m 6 http://127.0.0.1:8899/api/status 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s);
    const sum=(j.byAccount||[]).reduce((n,a)=>n+a.total,0);
    const t=j.stats?.todayTotal||0;
    console.log("sum="+sum+" total="+t+" coins="+(j.exec?.coins===j.exec?.fansOk?"ok":"MISMATCH")+" wins="+(j.stats?.wins||0));
  }catch(e){console.log("API_FAIL")}
});' 2>/dev/null)
case "$CHK" in
  API_FAIL*) say "  ⛔ 看板 API 无响应"; L3BAD=$((L3BAD+1));;
  *) say "  看板 $CHK"
     echo "$CHK" | grep -q 'MISMATCH' && L3BAD=$((L3BAD+1));;
esac

# 公网
U=$(cat /tmp/fudai-public-url.txt 2>/dev/null)
if [ -n "$U" ]; then
  G=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$U/" 2>/dev/null)
  PB=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$U/api/action" 2>/dev/null)
  say "  公网 GET=$G POST=$PB"
  [ "$G" != "200" ] && L3BAD=$((L3BAD+1))
fi

# 资源
LOAD5=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $3}')
MEMF=$(memory_pressure 2>/dev/null | grep -i 'free percentage' | grep -oE '[0-9]+' | head -1)
DISK=$(df -g "$ROOT" 2>/dev/null | awk 'NR==2{print $4}')
say "  资源 load5=$LOAD5 内存=${MEMF}% 磁盘=${DISK}Gi"
[ "${MEMF:-100}" -lt 20 ] && { say "    ⚠️ 内存吃紧"; L3BAD=$((L3BAD+1)); }
[ "${DISK:-99}" -lt 5 ] && { say "    ⚠️ 磁盘告急"; L3BAD=$((L3BAD+1)); }

# 推送队列
QN=0
[ -f data/notify-queue.jsonl ] && QN=$(wc -l < data/notify-queue.jsonl 2>/dev/null | tr -d ' ')
[ "${QN:-0}" -gt 0 ] && say "  📮 待补发推送 ${QN} 条（配额恢复后自动发）"

say "  L3 结论：$([ "$L3BAD" -eq 0 ] && echo '无异常' || echo "$L3BAD 项需关注")"

# ────────────────────────────────────────────────────────────
# L4 结论层
# ────────────────────────────────────────────────────────────
echo
hr
say "【L4 结论 · 最该修的一件事】"

if [ "$L0BAD" -gt 0 ]; then
  say "  🔴 优先修服务：$L0BAD 项异常（进程/端口/登录），抓取已受影响"
elif echo "$L1" | grep -q NODATA; then
  say "  🟡 今日无数据，先确认采集端是否真的在跑"
else
  # 找出占比最高的亏损类别
  TOPLOSS=$(echo "$L1" | awk '/^LOSS /{print $3, $2}' | sort -rn | head -1)
  TOPN=$(echo "$TOPLOSS" | awk '{print $1}')
  TOPK=$(echo "$TOPLOSS" | awk '{print $2}')
  RATEI=$(echo "$RT" | cut -d. -f1)
  if [ "${TOPN:-0}" -lt 5 ]; then
    say "  🟢 无显著亏损类别，参与率 ${RT}%"
  elif [ "${RATEI:-0}" -lt 40 ]; then
    case "$TOPK" in
      need-follow)  say "  🔴 参与率 ${RT}%（偏低），最大亏损是 need-follow ${TOPN} 次";;
      no-panel)     say "  🔴 参与率 ${RT}%（偏低），最大亏损是 no-panel ${TOPN} 次——面板打不开，需抓真实快照";;
      fans-skip*)   say "  🟡 参与率 ${RT}%，最大亏损是白天粉丝团策略跳过 ${TOPN} 次（用户已确认维持，不算故障）";;
      *)            say "  🔴 参与率 ${RT}%（偏低），最大亏损是 ${TOPK} ${TOPN} 次";;
    esac
  else
    say "  🟢 参与率 ${RT}%，最大亏损类别 ${TOPK}（${TOPN} 次），可接受"
  fi
fi

# 趋势提示
RECENT=$(echo "$L1" | awk '/^P recent/{print $4}')
OLDER=$(echo "$L1" | awk '/^P older/{print $4}')
if [ -n "${RECENT:-}" ] && [ -n "${OLDER:-}" ]; then
  DIFF=$(echo "$RECENT $OLDER" | awk '{printf "%.1f", $1-$2}')
  SIGN=$(echo "$DIFF" | awk '{print ($1>0)?"+":""}')
  say "  趋势：近3小时 ${RECENT}% vs 更早 ${OLDER}%（${SIGN}${DIFF} 个百分点）"
fi

echo
say "════ 巡检结束 $(date '+%H:%M:%S') ════"
