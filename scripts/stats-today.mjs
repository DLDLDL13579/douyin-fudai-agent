/**
 * 今日战绩统计（2026-11-11 01:18）
 *
 * 独立成文件的原因：inspect.sh 原先把这段 JS 内联在 `node -e '...'` 里，
 * 而 JS 里的空字符串 '' 与外层 bash 单引号冲突，导致引号被吞、
 * node 收到语法错误的源码（r.url|| 后面直接断掉）。
 * 独立文件后彻底摆脱引号嵌套问题。
 *
 * 输出格式（每行一个字段，便于 bash 读取）：
 *   RAW <原始条数>
 *   TOTAL <dedup后条数>
 *   JOINED <参与成功>
 *   RATE <参与率>
 *   R <result> <count>   （每个结果一行）
 *   A <account> <total> <joined>
 *   P recent <n> <rate>
 *   P older <n> <rate>
 *   WINS <n>
 */

import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJsonl(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').trim().split('\n')
      .map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const now = new Date();
const isToday = (iso) => {
  const t = new Date(iso);
  return t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
};

/** 与 web/server.mjs 的 dedupRows 完全一致：房间+账号+12分钟滑动窗口 */
function dedupRows(rows) {
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

const L = readJsonl('data/participations.jsonl');
const rawToday = L.filter((r) => isToday(r.at));
const today = dedupRows(rawToday);
const n = today.length;

console.log('RAW ' + rawToday.length);
console.log('TOTAL ' + n);
if (!n) process.exit(0);

const isJoin = (r) => r.result === 'joined' || r.result === 'maybe-joined';
const joined = today.filter(isJoin).length;
console.log('JOINED ' + joined);
console.log('RATE ' + (joined / n * 100).toFixed(1));

const c = {};
for (const r of today) c[r.result || '?'] = (c[r.result || '?'] || 0) + 1;
for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1])) {
  console.log('R ' + k + ' ' + v);
}

const acc = {};
for (const r of today) {
  const a = r.account || 'default';
  acc[a] = acc[a] || { n: 0, j: 0 };
  acc[a].n++;
  if (isJoin(r)) acc[a].j++;
}
for (const [a, v] of Object.entries(acc)) {
  console.log('A ' + a + ' ' + v.n + ' ' + v.j + ' ' + (v.j / v.n * 100).toFixed(1));
}

// 近3小时（真实时间戳，不用整点）
const cut = Date.now() - 3 * 3600 * 1000;
const recent = today.filter((r) => new Date(r.at).getTime() >= cut);
const older = today.filter((r) => new Date(r.at).getTime() < cut);
if (recent.length) console.log('P recent ' + recent.length + ' ' + (recent.filter(isJoin).length / recent.length * 100).toFixed(1));
if (older.length) console.log('P older ' + older.length + ' ' + (older.filter(isJoin).length / older.length * 100).toFixed(1));

const wins = readJsonl('data/wins.jsonl').filter((r) => isToday(r.at));
console.log('WINS ' + wins.length);
