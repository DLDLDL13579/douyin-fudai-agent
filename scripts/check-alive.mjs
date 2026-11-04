#!/usr/bin/env node
/**
 * 采集端「有没有视力」自检（跨平台版，2026-11-04）
 *
 * 原 check-alive.sh 是 bash + node -e，Windows 上跑不了。
 * 这里改成纯 ESM 脚本，逻辑与判据完全一致：
 *
 * 判定优先级（三次误报后固化下来的）：
 *   1. Cookie 缺失 → LOGIN_EXPIRED（硬证据，最优先）
 *   2. 日志显示正在「守候开奖」→ OK（开奖浮层会占满页面，长度必然变短）
 *   3. 页面长度连续稳定且 >=350 → OK
 *   4. 重测 13 秒仍 <60 → EMPTY_PAGE（标签可能卡死）
 *   5. 重测 13 秒仍未达 350 → SUSPECT_SHORT_PAGE
 *
 * 用法：node scripts/check-alive.mjs [端口]
 * 退出码：0=OK  2=登录失效  3=页面可疑  4=连不上  5=空页
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATH, isPortOpen } from './paths.mjs';

const PORT = Number(process.argv[2] || PATH.basePort);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const cb = this.pending.get(m.id); this.pending.delete(m.id); cb(m);
      }
    };
  }
  send(method, params = {}, timeout = 25000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const tm = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout ' + method)); }, timeout);
      this.pending.set(id, (m) => { clearTimeout(tm); res(m); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const done = (msg, code) => { console.log(msg); process.exit(code); };

(async () => {
  // 端口不通 → 抓取进程没在跑
  if (!(await isPortOpen(PORT, 1200))) done(`ERR 端口 ${PORT} 未监听（抓取进程未运行）`, 4);

  let tabs;
  try {
    tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch (e) {
    done('ERR 无法连接 CDP: ' + e.message, 4);
  }
  const page = tabs.find((t) => t.type === 'page');
  if (!page) done('NO_PAGE', 4);

  let cdp;
  try {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    cdp = new CDP(ws);

    // ── 1. Cookie 检查（硬证据）
    const ck = await cdp.send('Network.getCookies', { urls: ['https://live.douyin.com', 'https://www.douyin.com'] });
    const names = (ck.result?.cookies || []).map((c) => c.name);
    const need = ['sessionid', 'sid_tt', 'uid_tt'];
    const miss = need.filter((x) => !names.includes(x));
    if (miss.length) done(`LOGIN_EXPIRED missing=${miss.join(',')}`, 2);

    // ── 2. 页面长度：连续采样到稳定
    let len = 0, prev = -1, stable = false;
    for (let a = 0; a < 8; a++) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: '(document.body?document.body.innerText:"").length',
        returnByValue: true,
      });
      len = r.result?.result?.value || 0;
      if (len >= 350 && Math.abs(len - prev) < 40) { stable = true; break; }
      prev = len;
      await sleep(1800);
    }

    // ── 3. 守候开奖状态：页面被开奖浮层占满，长度必然变短，属正常
    try {
      const tail = fs.readFileSync(PATH.log, 'utf8').split('\n').filter(Boolean).slice(-6).join('\n');
      if (/守候开奖中|守候开奖 \d+s/.test(tail)) {
        done(`OK len=${len} (守候开奖中，页面被开奖浮层占满属正常)`, 0);
      }
    } catch {}

    if (stable) done(`OK len=${len} (cookie 齐全)`, 0);
    if (len < 60) done(`EMPTY_PAGE len=${len} (重测 13 秒仍为空，标签可能卡死)`, 5);
    done(`SUSPECT_SHORT_PAGE len=${len} (cookie 在但页面 13 秒未渲染完成)`, 3);
  } catch (e) {
    done('ERR ' + e.message, 4);
  } finally {
    if (cdp) cdp.close();
  }
})();
