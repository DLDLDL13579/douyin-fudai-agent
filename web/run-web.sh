#!/bin/bash
# 看板守护：进程退出 10 秒后自动重启
#
# ⚠️ 单实例锁（2026-11-03 加的）：历史上有 12 个 supervisor 同时在跑 ——
#    `./fudai.sh web` 每次被调用都会新起一个，旧的不清理。它们互相抢 8899 端口，
#    抢不到的 server.mjs 立即退出，10 秒后又来，形成无限重启风暴。
#    实测代价：fseventsd 吃掉 50% CPU，系统负载冲到 56（8 核机器），
#    而真正在提供服务的只有 1 个 server。
#    锁用 mkdir 实现（原子操作），进程退出时自动清理。
cd "$(dirname "$0")" || exit 1
PORT="${1:-8899}"
LOCK="/tmp/fudai-web-${PORT}.lock"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[supervisor] 已有看板守护实例（锁 ${LOCK}），本进程退出"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

while true; do
  # 端口被占用说明已有 server 在服务（可能是外部手工起的），不要再去抢。
  # 少了这个判断，多个 supervisor 同时跑时会变成「抢不到端口→立即退出→10 秒后再抢」的
  # 无限重启风暴：进程创建/销毁不停，fseventsd 与系统负载被打满，而实际只有一个 server 在服务。
  if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    node server.mjs "$PORT"
    echo "[supervisor] web exited rc=$? at $(date '+%m-%d %H:%M:%S')" >> "/tmp/fudai-web-supervisor.log"
  fi
  sleep 10
done
