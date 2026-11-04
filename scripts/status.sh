#!/bin/bash
# 抖音抢福袋任务状态与战况速查
WORK="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$WORK/douyin-auto"
SCRIPTS="$WORK/scripts"

echo "════════ 抖音抢福袋 · 状态速查 ════════"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo

# ── 1. 进程
echo "【进程】"
SUP=$(ps -eo pid,etime,args | grep -F 'run-h35.sh' | grep -v grep | head -1)
NODE=$(ps -eo pid,etime,args | grep -F 'node hunter35.mjs' | grep -v grep | head -1)
if [ -n "$SUP" ]; then echo "  supervisor: $(echo "$SUP" | awk '{print "PID "$1"  已运行 "$2}')"; else echo "  supervisor: ❌ 未运行"; fi
if [ -n "$NODE" ]; then echo "  hunter35:   $(echo "$NODE" | awk '{print "PID "$1"  已运行 "$2}')"; else echo "  hunter35:   ❌ 未运行"; fi
if lsof -nP -iTCP:9750 -sTCP:LISTEN >/dev/null 2>&1; then echo "  Chrome 9750: ✅ 监听中"; else echo "  Chrome 9750: ❌ 未监听"; fi
echo

# ── 2. 今日战况
echo "【今日战况】"
TODAY=$(date '+%Y-%m-%d')
if [ -f "$BASE/h35-results.jsonl" ]; then
  python3 - "$BASE/h35-results.jsonl" "$TODAY" <<'PY'
import sys, json
from collections import Counter
path, today = sys.argv[1], sys.argv[2]
rows = []
for line in open(path):
    line = line.strip()
    if not line: continue
    try: r = json.loads(line)
    except Exception: continue
    if str(r.get('at','')).startswith(today): rows.append(r)
c = Counter(r.get('result') for r in rows)
joined = c.get('joined',0) + c.get('maybe-joined',0)
skip = c.get('skip-fans',0) + c.get('skip-follow',0)
total = sum(c.values())
print(f"  今日处理福袋 {total} 次")
print(f"    参与成功  {joined} 次")
print(f"    粉丝团跳过 {skip} 次")
for k,v in c.most_common():
    if k not in ('joined','maybe-joined','skip-fans','skip-follow'):
        print(f"    {k}: {v}")
if total:
    print(f"  参与率 {joined/total*100:.0f}%（分母含跳过项）")
PY
else
  echo "  暂无记录文件"
fi
echo

# ── 3. 资源池
echo "【资源池】"
VF="$SCRIPTS/known-fudai-hosts.txt"
FF="$SCRIPTS/followed-rooms.txt"
BL="$SCRIPTS/blacklist-rooms.txt"
RR="$BASE/recent-rooms.json"
[ -f "$VF" ] && echo "  已知福袋房 VIP: $(grep -c . "$VF") 个" || echo "  已知福袋房 VIP: 0"
[ -f "$FF" ] && echo "  已关注主播:     $(grep -c . "$FF") 个（含未确认）" || echo "  已关注主播: 0"
[ -f "$BL" ] && echo "  黑名单房间:     $(grep -c . "$BL") 个" || echo "  黑名单房间: 0"
[ -f "$RR" ] && echo "  最近常驻记录:   $(python3 -c "import json;print(len(json.load(open('$RR'))))" 2>/dev/null || echo '?') 个（用于轮换去重）"
echo

# ── 4. 最近活动
echo "【最近活动】"
tail -6 "$BASE/h35.log" 2>/dev/null | sed 's/^/  /'
echo

# ── 5. 磁盘
echo "【磁盘】"
echo "  工作区占用: $(du -sh "$WORK" 2>/dev/null | awk '{print $1}')"
df -h "$WORK" 2>/dev/null | tail -1 | awk '{print "  磁盘可用: "$4"  使用率: "$5}'
# ── 6. 运行统计
echo "【运行统计】"
RC="$BASE/round-counter.txt"
[ -f "$RC" ] && echo "  累计轮次: $(cat "$RC")" || echo "  累计轮次: 未知"
echo -n "  最近候选: "
grep '📊 候选质量' "$BASE/h35.log" 2>/dev/null | tail -1 | sed 's/^\[[0-9:]*\] //' || echo "无"
echo

# ── 7. 状态文件
echo "【状态文件】"
for f in recent-rooms vip-cooldown dry-rooms fans-only-rooms; do
  P="$BASE/$f.json"
  if [ -f "$P" ]; then
    N=$(python3 -c "import json;d=json.load(open('$P'));print(len(d))" 2>/dev/null || echo "?")
    echo "  $f: $N 条"
  else
    echo "  $f: 未生成"
  fi
done
echo

# ── 8. 待关注
echo "【待手动关注】"
SF="$BASE/should-follow.md"
if [ -f "$SF" ]; then
  echo "  $(grep -c '^- \[ \]' "$SF" 2>/dev/null || echo 0) 个待关注条目（详见 should-follow.md）"
else
  echo "  无清单"
fi
echo "  注意: headless 环境无法自动关注，需在抖音 App 手动操作"
echo

echo "════════════════════════════════════"
