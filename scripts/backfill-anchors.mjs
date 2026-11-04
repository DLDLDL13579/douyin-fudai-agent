#!/usr/bin/env node
/**
 * 主播档案回填
 *
 * 从全部历史 results 文件重建 data/anchors.json，
 * 这样不用等新数据，立刻就有主播习惯可用。
 *
 * 用法：node backfill-anchors.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './paths.mjs';

const ROOT = APP_ROOT;
const DATA_DIR = path.join(ROOT, 'data');
const OUT = path.join(DATA_DIR, 'anchors.json');
const LOG = path.join(ROOT, 'douyin-auto', 'h35.log');

// 1) 从日志里提取主播名（房间 -> 主播名）
const hostMap = {};
if (fs.existsSync(LOG)) {
  const txt = fs.readFileSync(LOG, 'utf8');
  // 日志已改为「昵称(房间号)」格式，两种都要兼容
  for (const m of txt.matchAll(/✓\s+.*?\((\d{6,})\)\s+在线-?\d+/g)) {
    const name = m[0].match(/✓\s+(.+?)\(\d{6,}\)/);
    if (name && !hostMap[m[1]]) hostMap[m[1]] = name[1].trim();
  }
  for (const m of txt.matchAll(/✓\s+(\d{6,})\s+在线-?\d+\s+(\S+)/g)) {
    if (!hostMap[m[1]]) hostMap[m[1]] = m[2];
  }
}

// 2) 汇总所有 results
const files = fs.readdirSync(path.join(ROOT, 'douyin-auto'))
  .filter((f) => f.endsWith('-results.jsonl'))
  .map((f) => path.join(ROOT, 'douyin-auto', f));

const anchors = {};
let total = 0;

for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try { r = JSON.parse(t); } catch { continue; }
    if (!r.result) continue;
    const room = (r.url || '').split('/').pop();
    if (!room || !/^\d{6,}$/.test(room)) continue;

    const at = r.at || new Date().toISOString();
    const rec = anchors[room] || {
      host: hostMap[room] || '',
      firstSeen: at,
      fudaiTotal: 0,
      joinable: 0,
      fans: 0,
      hourly: {},
      lastFudaiAt: '',
    };
    rec.fudaiTotal++;
    if (r.result === 'joined' || r.result === 'maybe-joined') rec.joinable++;
    else if (r.result === 'skip-fans' || r.result === 'fans-no-coins' || r.result === 'fans-unverified') rec.fans++;
    const h = String(new Date(at).getHours());
    rec.hourly[h] = (rec.hourly[h] || 0) + 1;
    if (!rec.lastFudaiAt || at > rec.lastFudaiAt) rec.lastFudaiAt = at;
    if (!rec.firstSeen || at < rec.firstSeen) rec.firstSeen = at;
    anchors[room] = rec;
    total++;
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(anchors, null, 1));

console.log(`已处理 ${total} 条历史记录，生成 ${Object.keys(anchors).length} 个主播档案`);
console.log(`输出: ${OUT}\n`);
console.log('房间          主播                  总福袋  可抢  粉丝团  活跃时段');
console.log('─'.repeat(78));
const sorted = Object.entries(anchors).sort((a, b) => b[1].fudaiTotal - a[1].fudaiTotal);
for (const [room, r] of sorted) {
  const hours = Object.entries(r.hourly).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([h, c]) => `${h}点(${c})`).join(' ');
  console.log(
    room.padEnd(14) + (r.host || '-').slice(0, 20).padEnd(21) +
    String(r.fudaiTotal).padStart(6) + String(r.joinable).padStart(6) +
    String(r.fans).padStart(7) + '  ' + hours
  );
}
