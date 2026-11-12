#!/bin/bash
# 采集端「有没有视力」自检 —— 登录态失效时整夜 0 福袋，与「真的没福袋」表现完全一样。
# 2026-11-03 在此栽过一次（盲跑 18 小时），固化成每次巡检必查。
PORT="${1:-9750}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# ⚠ 日志必须跟着端口走，否则查账号实例时会拿主实例的「守候开奖」误放行。
#    2026-11-05 02:57 踩过：9751 页面 len=20「直播加载中」，却因主实例在守候而报 OK。
#    2026-11-06 09:39 改为按 accounts/*/meta.json 的 port 反查账号目录：
#    账号可增删（main2 已删、main3 用 9752），写死端口→目录的映射必然再次失效。
DEFAULT_LOG="$ROOT_DIR/douyin-auto/h35.log"
if [ "$PORT" != "9750" ]; then
  ACC_DIR="$(node -e "
    const fs=require('fs'),p=require('path');
    const root='$ROOT_DIR/accounts';
    try{
      for(const n of fs.readdirSync(root)){
        const f=p.join(root,n,'meta.json');
        if(!fs.existsSync(f))continue;
        if(String(JSON.parse(fs.readFileSync(f,'utf8')).port||'')==='$PORT'){
          process.stdout.write(p.join(root,n,'work','h35.log'));break;
        }
      }
    }catch(e){}
  ")"
  [ -n "$ACC_DIR" ] && DEFAULT_LOG="$ACC_DIR"
fi
LOG_PATH="${DY_ALIVE_LOG:-$DEFAULT_LOG}"
# 🔴 2026-11-12 17:xx 修「CDP 无响应把自检与 health-guard 一起挂死」：
#    9750 常驻一个 https://www.douyin.com/user/self 身份页，CDP 永远不回；
#    旧版 l.find() 只取第一个 tab + send()/onopen 无超时 → node 永不退出，
#    health-guard 的 a1=$(... | tail -1) 命令替换永久等待（实测子 shell 卡 38 分钟）。
#    修法：①每个 CDP 调用与 ws.onopen 都加超时 ②遍历所有 page tab 选第一个真有响应的
#    ③35s 总超时兜底。⚠ 输出文本 / 判据 / 退出码一律不变，health-guard 与 inspect 靠文本前缀判断。
#    改用单引号 heredoc 喂 node stdin，JS 内可自由用双引号与 $，不再受 bash 双引号转义折磨。
DY_ALIVE_PORT="$PORT" DY_ALIVE_LOG="$LOG_PATH" node <<'ALIVE_JS'
"use strict";
const PORT = process.env.DY_ALIVE_PORT || "9750";
const LOG_PATH = process.env.DY_ALIVE_LOG || "";
const CDP_MS = 6000;      // 单个 CDP 调用默认超时
const HEALTH_MS = 3000;   // 选 tab 健康检查的调用超时（更快跳过坏标签）
const OPEN_MS = 4000;     // ws.onopen 超时
const TOTAL_MS = 35000;   // 总超时兜底：任何 await 卡住，35s 后必须退出，绝不连累命令替换

// 最后保险：unref 让正常路径自然退出不受影响；真死锁时强制退出并给出明确输出。
const DEADLINE = setTimeout(() => {
  console.log("ERR check-alive 总超时 35s（CDP 无响应）");
  process.exit(4);
}, TOTAL_MS);
DEADLINE.unref();

// 连一个 tab：onopen / send 均有超时；返回 {ws, send}，send 仍 resolve CDP 响应的 result。
function attach(tab) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(tab.webSocketDebuggerUrl); }
    catch (e) { return reject(e); }
    let i = 0; const cb = new Map();
    const send = (method, params = {}, ms = CDP_MS) => new Promise((res, rej) => {
      const k = ++i;
      const tm = setTimeout(() => { cb.delete(k); rej(new Error("timeout " + method)); }, ms);
      cb.set(k, (result) => { clearTimeout(tm); res(result); });
      try { ws.send(JSON.stringify({ id: k, method, params })); }
      catch (e) { clearTimeout(tm); cb.delete(k); rej(e); }
    });
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.id && cb.has(m.id)) { const f = cb.get(m.id); cb.delete(m.id); f(m.result); }
    };
    let opened = false;
    const openTm = setTimeout(() => {
      if (!opened) { try { ws.close(); } catch (_) {} reject(new Error("ws open timeout")); }
    }, OPEN_MS);
    ws.onopen = () => { opened = true; clearTimeout(openTm); resolve({ ws, send }); };
    ws.onerror = () => {
      if (opened) return;   // onopen 之后才来的 error 不许关掉已交付的 ws
      clearTimeout(openTm); try { ws.close(); } catch (_) {} reject(new Error("ws error"));
    };
  });
}

(async () => {
  try {
    const l = await (await fetch("http://127.0.0.1:" + PORT + "/json/list", { signal: AbortSignal.timeout(CDP_MS) })).json();
    const pages = (l || []).filter((t) => t.type === "page");
    if (!pages.length) { console.log("NO_PAGE"); process.exit(1); }

    // 🔴 遍历所有 page tab，选第一个「CDP 真有响应」的：旧版 l.find() 撞上
    //    /user/self 坏标签就永久挂住，现改用健康检查逐个排除。
    let picked = null;
    for (const tab of pages) {
      let c = null;
      try {
        c = await attach(tab);
        const ck = await c.send("Network.getCookies", { urls: ["https://live.douyin.com", "https://www.douyin.com"] }, HEALTH_MS);
        const probe = await c.send("Runtime.evaluate", { expression: "document.body.innerText.length", returnByValue: true }, HEALTH_MS);
        if (ck && probe) { picked = { ws: c.ws, send: c.send, ck }; break; }
        try { c.ws.close(); } catch (_) {}
      } catch (_) {
        try { c && c.ws.close(); } catch (__) {}
      }
    }
    if (!picked) {
      // 所有标签 CDP 都无响应：明确输出且带 EMPTY_PAGE 前缀（health-guard/inspect 兼容），绝不挂住
      console.log("EMPTY_PAGE len=0 (所有 " + pages.length + " 个标签 CDP 均无响应，标签可能卡死)");
      process.exit(5);
    }
    const ws = picked.ws, send = picked.send;
    const ck = picked.ck;
    const n = (ck.cookies || []).map((c) => c.name);
    const need = ["sessionid", "sid_tt", "uid_tt"];
    const miss = need.filter((x) => !n.includes(x));

    // ⚠ 页面长度必须在「稳定后」测：连续两次 >=350 且相差 <40 才算渲染完成，
    //    避免换房导航瞬间 len=14/342 被误报（2026-11-03 两次踩坑）。
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    let len = 0, prev = -1, stable = false, needLogin = false, loginStreak = 0, commentBox = 0, fansPanel = false;
    for (let a = 0; a < 8; a++) {
      let d = null;
      try {
        d = await send("Runtime.evaluate", { expression: "(()=>{const t=document.body.innerText||\"\";return JSON.stringify({len:t.length,needLogin:/需先登录|请先登录|登录后参与|登录后可参与|登录后才能/.test(t),commentBox:document.querySelectorAll(\"[placeholder*=说点什么],[contenteditable=true]\").length,fansPanel:/钻石加入粉丝团|酷炫勋章|专属礼物|进场特效/.test(t)})})()", returnByValue: true });
      } catch (_) { d = null; }
      let info = {};
      try { info = JSON.parse(d.result.value || "{}"); } catch (e) {}
      len = info.len || 0;
      // 单帧登录文案可能是导航瞬态，必须连续 2 帧才判真掉线（2026-11-09 9752 误报）。
      loginStreak = info.needLogin ? loginStreak + 1 : 0;
      if (loginStreak >= 2) needLogin = true;
      commentBox = info.commentBox || 0; fansPanel = !!info.fansPanel;
      if (len >= 350 && Math.abs(len - prev) < 40) { stable = true; break; }
      prev = len;
      await nap(1800);
    }

    // 🔴 服务端会话失效（硬判据，排最前、不受任何豁免）：Cookie 齐全 ≠ 服务端认可。
    if (needLogin) { console.log("LOGIN_EXPIRED needLogin=true (Cookie 齐全但服务端已判会话失效，需重新扫码)"); try { ws.close(); } catch (_) {} process.exit(2); }
    if (miss.length) { console.log("LOGIN_EXPIRED missing=" + miss.join(",")); try { ws.close(); } catch (_) {} process.exit(2); }

    // 🎯 守候开奖浮层占满页面：innerText 变短、评论框被移除属正常（须排在 LOGIN_SUSPECT 之前）。
    //    len<60 是空页面「直播加载中」，绝不能被豁免（02:57 的 9751 假 OK 漏洞）。
    let isDrawing = false;
    if (len >= 60) {
      try {
        const fs = require("fs");
        const tail = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean).slice(-6).join("\n");
        isDrawing = /守候开奖中|守候开奖 \d+s/.test(tail);
      } catch (e) {}
    }
    if (isDrawing) { console.log("OK len=" + len + " (守候开奖中，页面被开奖浮层占满属正常)"); try { ws.close(); } catch (_) {} return; }

    // 🔴 2026-11-11 修误报：房间粉丝团浮层盖住评论框 → 有这些特征时不判未登录。
    if (stable && commentBox === 0 && len > 350 && !fansPanel) { console.log("LOGIN_SUSPECT no-comment-box len=" + len + " (页面正常但无评论框，疑似未登录)"); try { ws.close(); } catch (_) {} process.exit(2); }
    if (!stable && len < 60) { console.log("EMPTY_PAGE len=" + len + " (重测 13 秒仍为空，标签可能卡死)"); try { ws.close(); } catch (_) {} process.exit(5); }
    if (!stable && len >= 60 && len < 350) { console.log("SUSPECT_SHORT_PAGE len=" + len + " (cookie 在但页面 13 秒未渲染完成)"); try { ws.close(); } catch (_) {} process.exit(3); }
    console.log("OK len=" + len + " (cookie 齐全)");
    try { ws.close(); } catch (_) {}
  } catch (e) {
    console.log("ERR " + e.message); process.exit(4);
  }
})();
ALIVE_JS
