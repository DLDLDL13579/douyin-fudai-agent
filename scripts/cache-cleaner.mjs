/**
 * Chrome 运行时磁盘缓存回收（2026-11-06）
 *
 * 背景：run-h35.sh 原有缓存清理写在 while 顶部，且要求 ! chrome_running。
 * 但 node hunter35.mjs 是阻塞式前台运行，7×24 下 hunter / Chrome 都不退出，
 * 清理代码永远不执行 → Default/Cache 无限增长。实测 1 小时涨 415MB，
 * 两个 profile 的 Cache 合计 1.16GB，磁盘从 6.2Gi 掉到 4.5Gi 触发告警。
 *
 * 方案：用 CDP `Network.clearBrowserCache` 在 Chrome 运行时清缓存。
 *   - 官方 API，不动文件句柄、不重启、不碰 Cookie / 登录态
 *   - 实测两个实例 534/629MB → 2/2MB，磁盘 4.5Gi → 5.9Gi，自检仍 OK
 *   - 幂等，缓存已空时再调返回 OK
 *   - 🔧 2026-11-13：CDP 超时统一放宽到 15s（见下方 CDP_TIMEOUT_MS 注释）。
 *     原 4s 在大缓存时贴边超时，会造成「清不掉→更大→又超时」的连续 SKIP 自锁。
 *
 * 端口发现：accounts 下各账号 meta.json 的 port 字段 + 固定 9750 主实例，
 * 由配置单一数据源驱动，不写死账号名；连不上的端口静默跳过。
 *
 * 用法：node scripts/cache-cleaner.mjs
 * 退出码 0 恒成功（清理失败只记日志，绝不阻断 7×24 主循环）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACC_ROOT = path.join(ROOT, 'accounts');
// 🔧 2026-11-13 实测：9752 的 Cache 涨到 300~360MB 时 Network.clearBrowserCache 需
// 2.4~3.9s，原 4000ms 阈值贴边超时 → 连续 2 次 SKIP 后缓存越积越大形成自锁
// （北京 11-13 01:59~04:59 曾连跳 7 个周期）。清到 40MB 后同一调用仅 64ms。
// 放宽到 15s 给大缓存留足余量；本守护每 30 分钟才跑一次，多等几秒无副作用。
// 可用环境变量覆盖，便于不同机器按磁盘性能调整。
const CDP_TIMEOUT_MS = Math.max(4000, Math.min(60000, Number(process.env.DY_CACHE_CLEAN_TIMEOUT_MS) || 15000));

function ports() {
  const out = new Set([9750]);
  try {
    for (const name of fs.readdirSync(ACC_ROOT)) {
      const f = path.join(ACC_ROOT, name, 'meta.json');
      if (!fs.existsSync(f)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(f, 'utf8'));
        const p = Number(m.port);
        if (Number.isFinite(p) && p > 1024 && p < 65535) out.add(p);
      } catch { /* 单个 meta 损坏不影响其它实例 */ }
    }
  } catch { /* accounts/ 不存在也没关系 */ }
  return [...out].sort((a, b) => a - b);
}

async function clearOne(port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CDP_TIMEOUT_MS);
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal }).then((r) => r.json());
    const page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) return { port, ok: false, why: 'no-page' };

    const ws = await new Promise((resolve, reject) => {
      const w = new WebSocket(page.webSocketDebuggerUrl);
      const t = setTimeout(() => reject(new Error('ws-timeout')), CDP_TIMEOUT_MS);
      w.onopen = () => { clearTimeout(t); resolve(w); };
      w.onerror = () => { clearTimeout(t); reject(new Error('ws-error')); };
    });
    try {
      let id = 0;
      const pend = new Map();
      const onMsg = (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
      };
      ws.onmessage = onMsg;
      const call = (method, params = {}) => new Promise((resolve) => {
        const i = ++id;
        pend.set(i, resolve);
        ws.send(JSON.stringify({ id: i, method, params }));
        setTimeout(() => { if (pend.has(i)) { pend.delete(i); resolve({ error: { message: 'cdp-timeout' } }); } }, CDP_TIMEOUT_MS);
      });
      await call('Network.enable');
      const r = await call('Network.clearBrowserCache');
      return { port, ok: !r.error, why: r.error ? String(r.error.message) : '' };
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  } catch (e) {
    return { port, ok: false, why: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const results = await Promise.all(ports().map(clearOne));
const ts = new Date().toISOString();
for (const r of results) {
  console.log(`[cache-cleaner ${ts}] port=${r.port} ${r.ok ? 'OK' : 'SKIP ' + r.why}`);
}
process.exit(0);
