#!/usr/bin/env node
/**
 * 抖音福袋 · 数据报表
 *
 * 用法：
 *   node data-report.mjs            今日汇总
 *   node data-report.mjs --all      全部历史
 *   node data-report.mjs --account <名字>   只看某账号
 *
 * 数据来源（自动合并）：
 *   data/participations.jsonl      新数据层（带 account 字段）
 *   douyin-auto/h35-results.jsonl  旧记录（视为 default 账号）
 *   data/wins.jsonl                中奖记录
 */
import fs from 'node:fs';
import path from 'node:path';

// 📅 本地时区日期（YYYY-MM-DD）。
//    ⚠ 不能用 new Date().toISOString().slice(0,10)——那是 UTC 日期，
//    北京 00:00-08:00 期间 UTC 还停在前一天，会让「今日战果」全部算错。
const localDay = (d = new Date()) => {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().slice(0, 10);
};
// ⚠ 记录里的 at 是 UTC ISO 字符串，不能用 startsWith(本地日期) 比较：
//    北京 00:09 的记录存成前一日 16:09Z，会被整个漏掉。
const isLocalDay = (iso, day) => {
  if (!iso) return false;
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && localDay(d) === day;
};


import { APP_ROOT } from './paths.mjs';
const ROOT = APP_ROOT;
let NAMES = {};
try { NAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'room-names.json'), 'utf8')) || {}; } catch {}
const dispRoom = (room) => (NAMES[room] ? NAMES[room] + '(' + room + ')' : room);
const PARTICIPATIONS = path.join(ROOT, 'data', 'participations.jsonl');
const WINS = path.join(ROOT, 'data', 'wins.jsonl');
const LEGACY = path.join(ROOT, 'douyin-auto', 'h35-results.jsonl');

const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const accIdx = argv.indexOf('--account');
const onlyAccount = accIdx >= 0 ? argv[accIdx + 1] : null;

// 账号显示名：报表里不显示 default / main2 这种内部代号，统一显示抖音昵称 + 号尾 4 位
const ACC_LABELS = (() => {
  const m = {};
  const dir = path.join(ROOT, 'accounts');
  if (!fs.existsSync(dir)) return m;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, d.name, 'meta.json'), 'utf8')); } catch {}
    const id = meta.douyinId || '';
    const nm = meta.nickname || meta.displayName || d.name;
    m[d.name] = nm + (id.length >= 4 ? '(' + id.slice(-4) + ')' : '');
  }
  if (m.main) m.default = m.main;
  return m;
})();
const accLabel = (a) => ACC_LABELS[a] || (a === 'default' ? '主实例' : a);

function readJsonl(p) {
  const out = [];
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}


/** 按「房间 + 6 分钟窗口」去重：旧版本同一个福袋会被重复记录多次 */
function dedupRows(rows) {
  // 12 分钟滑动窗口 + 账号维度，与 web/server.mjs 口径统一。
  // 原实现用固定 6 分钟桶，桶边界会把同一个福袋切成两条，
  // 且多账号同房间各抢一次会被误合并成一条。
  const WIN = 12 * 60 * 1000;
  const last = new Map();
  const out = [];
  const sorted = [...rows].sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());
  for (const r of sorted) {
    const room = (r.url || '').split('/').pop() || '';
    const t = new Date(r.at || 0).getTime();
    if (!t) { out.push(r); continue; }
    const key = room + '|' + (r.account || 'default');
    const prev = last.get(key);
    if (prev !== undefined && Math.abs(t - prev) < WIN) continue;
    last.set(key, t);
    out.push(r);
  }
  return out;
}

// 合并数据源
const rows = dedupRows([
  ...readJsonl(PARTICIPATIONS),
  ...readJsonl(LEGACY).map((r) => ({ ...r, account: 'default' })),
]);

const today = localDay();
// 账号别名：主号在数据里叫 default，账号目录里叫 main，两者是同一个号
const normAcc = (a) => (a === 'main' ? 'default' : a);
const wantAcc = onlyAccount ? normAcc(onlyAccount) : null;
const matchAcc = (a) => !wantAcc || normAcc(a || 'default') === wantAcc;

const filtered = rows.filter((r) => {
  if (!matchAcc(r.account)) return false;
  if (!showAll && !isLocalDay(r.at, today)) return false;
  return true;
});

const wins = readJsonl(WINS).filter((w) => {
  if (!matchAcc(w.account)) return false;
  if (!showAll && !isLocalDay(w.at, today)) return false;
  return true;
});

// 统计
const byResult = {};
const byAccount = {};
const byRoom = {};
let joined = 0, total = 0;
for (const r of filtered) {
  const res = r.result || 'unknown';
  byResult[res] = (byResult[res] || 0) + 1;
  total++;
  if (res === 'joined' || res === 'maybe-joined') joined++;
  const acc = r.account || 'default';
  byAccount[acc] = byAccount[acc] || { total: 0, joined: 0 };
  byAccount[acc].total++;
  if (res === 'joined' || res === 'maybe-joined') byAccount[acc].joined++;
  const room = (r.url || '').split('/').pop();
  if (room) {
    byRoom[room] = byRoom[room] || { total: 0, joined: 0 };
    byRoom[room].total++;
    if (res === 'joined' || res === 'maybe-joined') byRoom[room].joined++;
  }
}

const scope = showAll ? '全部历史' : `今日（${today}）`;
console.log(`════════ 抖音福袋 · 数据报表 ════════`);
console.log(`范围: ${scope}${onlyAccount ? `  账号: ${onlyAccount}` : ''}`);
// 旧数据提示：2026-11-02 修复前，去重 key 用倒计时，同一个福袋会被重复计数
const hasLegacy = rows.some((r) => !r.account || r.account === 'default');
console.log('ℹ️  已按「房间+账号+12分钟滑动窗口」去重，重复记录不会重复计数\n');

console.log('【总览】');
console.log(`  福袋遭遇: ${total} 次`);
console.log(`  成功参与: ${joined} 次`);
console.log(`  参与率:   ${total ? ((joined / total) * 100).toFixed(1) : 0}%`);
console.log(`  中奖记录: ${wins.length} 次\n`);

if (Object.keys(byAccount).length > 1 || onlyAccount === null) {
  console.log('【分账号】');
  for (const [acc, s] of Object.entries(byAccount)) {
    console.log(`  ${accLabel(acc).padEnd(20)} 遭遇 ${String(s.total).padStart(3)} 次   参与 ${String(s.joined).padStart(3)} 次`);
  }
  console.log();
}

console.log('【结果分布】');
for (const [k, v] of Object.entries(byResult).sort((a, b) => b[1] - a[1])) {
  const label = {
    'maybe-joined': '参与成功(待确认)',
    'joined': '参与成功(已确认)',
    'skip-fans': '粉丝团型(跳过)',
    'fans-no-coins': '抖币不足(需充值)',
    'fans-unverified': '粉丝团加入未确认',
    'no-panel': '未找到面板',
    'need-follow': '需要关注(抢不到)',
    'btn-still': '按钮未消失',
  }[k] || k;
  console.log(`  ${label.padEnd(18)} ${v} 次`);
}
console.log();

if (Object.keys(byRoom).length) {
  console.log('【房间排行（按成功参与次数）】');
  const top = Object.entries(byRoom)
    .filter(([, s]) => s.joined > 0)
    .sort((a, b) => b[1].joined - a[1].joined)
    .slice(0, 8);
  if (!top.length) console.log('  暂无成功记录');
  for (const [room, s] of top) {
    console.log(`  ${dispRoom(room).padEnd(34)} 参与 ${String(s.joined).padStart(3)} 次 / 遭遇 ${s.total} 次`);
  }
  console.log();
}

if (wins.length) {
  console.log('【中奖记录】');
  for (const w of wins.slice(-10)) {
    console.log(`  ${new Date(w.at).toLocaleString('zh-CN')}  ${w.room}  ${(w.text || '').slice(0, 40)}`);
  }
  console.log();
} else {
  console.log('【中奖记录】暂无（中奖是低概率事件，需要长期积累）\n');
}

// 账号目录一览
const ACC_DIR = path.join(ROOT, 'accounts');
if (fs.existsSync(ACC_DIR)) {
  const names = fs.readdirSync(ACC_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (names.length) {
    console.log('【已注册账号】');
    for (const n of names) {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(ACC_DIR, n, 'meta.json'), 'utf8')); } catch {}
      console.log(`  ${accLabel(n).padEnd(20)} 端口 ${String(meta.port || '-').padEnd(5)} ${meta.lastLogin ? '已登录' : '未登录'}`);
    }
  }
}
console.log('════════════════════════════════════');
