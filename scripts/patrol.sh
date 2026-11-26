#!/bin/bash
# 抖音福袋 · 每小时巡检（只读，零副作用）
# 用法：bash scripts/patrol.sh [full]
#   - 默认：前置短路——系统未恢复(boot未变且load>50)时只输出 SKIP 一行并退出
#   - full ：强制完整巡检
# 设计目标：一条命令替代过去每小时 4-5 次手工工具调用，输出稳定、便于自动判断。
# 2026-11-26 固化；所有检查均为只读，绝不重启/清理/改配置。

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

NOW="$(TZ='Asia/Shanghai' date '+%m-%d %H:%M:%S')"
BOOT="$(sysctl -n kern.boottime 2>/dev/null | grep -oE '(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]+ +[0-9]+ [0-9:]+ [0-9]{4}')"
LOAD1="$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"
BASE_BOOT='Mon Nov 23 02:42:33 2026'

# 前置短路：系统未恢复则静默跳过（除非 full）
if [ "$1" != "full" ] && [ "$BOOT" = "$BASE_BOOT" ]; then
  awk -v l="$LOAD1" 'BEGIN{exit !(l>50)}' && { echo "SKIP boot未变 load=$LOAD1 系统未恢复 $(date '+%H:%M')"; exit 0; }
fi

echo "=== 抖音福袋巡检 $NOW ==="
# 2026-11-26 扩展巡检范围：inode/swap（曾遇磁盘事故）、安全回归（防key泄露与鉴权失效复发）
echo "[系统] boot=$BOOT load=$LOAD1 free=$(memory_pressure 2>/dev/null|grep 'free percentage'|sed 's/.*: //') \
磁盘=$(df -h /|tail -1|awk '{print $4}') inode=$(df -i /|tail -1|awk '{print $5}') swap=$(sysctl -n vm.swapusage 2>/dev/null|grep -oE 'used = [0-9.]+M'|head -1)"

# 端口（只列关键端口）
printf '[端口] '
for p in 9750 9752 9751 8899 8898; do
  printf '%s=%s ' "$p" "$(lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null|grep -c LISTEN)"
done; echo

# 进程计数（grep -F + 双重排除，避免自匹配）
echo "[进程] hunter=$(ps -eo args|awk '/node hunter35\.mjs/ && !/awk/'|wc -l|tr -d ' ') \
supervisor=$(ps -eo args|awk '/bash scripts\/run-h35\.sh/ && !/awk/'|wc -l|tr -d ' ') \
cache=$(ps -eo args|awk '/run-cache-cleaner\.sh/ && !/awk/'|wc -l|tr -d ' ') \
runtime=$(ps -eo args|awk '/runtime-cleaner\.sh/ && !/awk/'|wc -l|tr -d ' ') \
watchdog=$(ps -eo args|awk '/watchdog-down\.sh/ && !/awk/'|wc -l|tr -d ' ') \
health=$(ps -eo args|awk '/health-guard\.sh/ && !/awk/ && !/bash -c/'|wc -l|tr -d ' ')(应1)"

# 采集端自检（超时保护）
SELF="$(bash scripts/check-alive.sh 9750 2>&1|tail -1)"
echo "[自检] $(echo "$SELF"|cut -c1-80)"

# 本段采集统计（按最后一条 === hunter35 启动行切段）
F=douyin-auto/h35.log
if [ -f "$F" ]; then
  L=$(grep -an '=== hunter35' "$F"|tail -1|cut -d: -f1)
  if [ -n "$L" ]; then
    T=$(tail -n +$L "$F")
    echo "[采集] 启动=$(printf '%s' "$T"|head -1|cut -c1-20) \
福袋=$(printf '%s' "$T"|grep -ac '★★ 福袋') \
joined=$(printf '%s' "$T"|grep -ac '结果: joined') \
空白=$(printf '%s' "$T"|grep -ac '页面空白') \
FATAL=$(printf '%s' "$T"|grep -c FATAL) \
记账失败=$(printf '%s' "$T"|grep -ac '抖币消费记账失败') \
日志停=$(($(date +%s)-$(stat -f '%m' "$F")))s"
  fi
fi

# 看板
curl -s --max-time 20 http://127.0.0.1:8899/api/status -o /tmp/patrol-status.json 2>/dev/null
node -e "try{const j=require('/tmp/patrol-status.json'),s=j.stats||{};console.log('[看板] 今日='+s.todayJoined+'/'+s.todayTotal+' 主号='+s.mainRate+'% coins='+j.exec?.coins+'/'+j.exec?.fansOk+' wins='+s.wins+' 门槛='+j.threshold?.value)}catch(e){console.log('[看板] 异常')}" 2>/dev/null
rm -f /tmp/patrol-status.json

# 公网（GET 应 200，POST 应 403）
PUB="$(cat /tmp/fudai-public-url.txt 2>/dev/null|tr -d '\r\n')"
if [ -n "$PUB" ]; then
  echo "[公网] GET=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$PUB/api/status" 2>/dev/null) \
POST=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$PUB/api/status" 2>/dev/null) 域名=$PUB"
else
  echo "[公网] 无域名文件"
fi

# 公网隧道进程数：公网 000 时能区分「隧道死了」vs「域名失效」
echo "[隧道] 8898隧道=$(ps -eo args|grep -F 'tunnel --url http://127.0.0.1:8898'|grep -v grep|grep -v 'bash -c'|wc -l|tr -d ' ') \
DSH隧道=$(ps -eo args|grep -F 'cloudflared tunnel'|grep -v grep|grep -v 'bash -c'|wc -l|tr -d ' ')（DSH不可动）"

# 安全回归（2026-11-26 P0 修复防复发）：仓库明文key必须空、web POST鉴权必须在
SEC_KEY=$(grep -oE '"sendKey": "[^"]*"' data/notify-config.json 2>/dev/null|grep -v '""'|wc -l|tr -d ' ')
SEC_TOKEN=$(grep -c "WEB_TOKEN" web/server.mjs 2>/dev/null|tr -d ' ')
echo "[安全] 仓库明文key=$SEC_KEY(应0) web鉴权=$SEC_TOKEN(应>0) .env.local=$([ -f .env.local ]&&echo 有||echo 无)"

# 内存大户（2026-11-26 根因修正）：Parallels 曾占13.9GB致系统狂换页load飙到300。内存中>4GB即告警。
TOPMEM="$(ps -eo rss,comm -r 2>/dev/null|awk 'NR>1 && NR<=4 && $1>4*1024*1024{printf "%s(%.1fG) ",$2,$1/1024/1024}')"
[ -n "$TOPMEM" ] && echo "[⚠内存大户] $TOPMEM —— 考虑关掉/调小虚拟机，这是load飙升主因"

echo "[中奖] $(cat data/wins.jsonl 2>/dev/null|wc -l|tr -d ' ') 条"
