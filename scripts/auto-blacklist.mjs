#!/usr/bin/env node
/**
 * 自动黑名单 + 时段画像（2026-11-11 09:42）
 *
 * 用户需求：「那种不发福袋的直播间就加入黑名单，经常发的就要记住且学习分析
 * 开播时间，未开播时就不去探测该直播间」
 *
 * 两件事：
 *   1. 自动黑名单：被访问 N 次以上却一次福袋都没见过的房间，写进
 *      data/auto-blacklist.json。与手写的 scripts/blacklist-rooms.txt 分开，
 *      用户手写的永不覆盖，自动清单可随时再生。
 *   2. 时段画像：从 anchors.json 的 hourly 统计出「这房间通常几点发福袋」，
 *      写进 data/hour-windows.json，供 hunter 判断「未开播就不探测」。
 *
 * 安全阀：hourly 数据来自历史观测，「没见过」不等于「不发」。
 *   所以只对「有明确 hourly 数据」的房间做时段规避，
 *   且 hunter 侧有 fallback：连续多轮无候选会 disregard 时段限制。
 *
 * 用法：node scripts/auto-blacklist.mjs [--dry] [--min-visits 6]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const DRY = process.argv.includes('--dry');
const mvIdx = process.argv.indexOf('--min-visits');
const MIN_VISITS = mvIdx > 0 ? Math.max(3, Number(process.argv[mvIdx + 1]) || 6) : 6;

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

const anchors = readJson(path.join(DATA, 'anchors.json'), {});
const manualBlack = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'scripts', 'blacklist-rooms.txt'), 'utf8')
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
})();

// ── 1. 自动黑名单：访问够多但从没见过福袋 ──────────────────────────
const autoBlack = [];
const hourWindows = {};
let zeroFudai = 0, candidateCount = 0;

for (const [room, a] of Object.entries(anchors)) {
  if (!a || typeof a !== 'object') continue;
  const visits = Number(a.visits) || 0;
  const fudai = Number(a.fudaiTotal) || 0;
  const joinable = Number(a.joinable) || 0;

  // 人写的黑名单优先级最高，已经拉黑的不用再评估
  if (manualBlack.includes(room)) continue;

  if (fudai === 0) {
    zeroFudai++;
    if (visits >= MIN_VISITS) {
      autoBlack.push({ room, visits, reason: `访问${visits}次零福袋` });
    }
    continue;
  }

  // ── 2. 时段画像：这房间通常在几点发福袋 ──────────────────────
  //   hourly 形如 {"0":32,"1":29,"22":11,"23":34}
  const hourly = a.hourly && typeof a.hourly === 'object' ? a.hourly : {};
  const hours = Object.keys(hourly).map(Number).filter((h) => Number.isFinite(h) && h >= 0 && h <= 23);
  if (!hours.length) continue;   // 没学过时段，不放假数据，交给 hunter 当「无限制」

  candidateCount++;
  hourWindows[room] = {
    host: a.host || '',
    fudaiTotal: fudai,
    joinable,
    // 只保留有过发袋记录的小时，不额外扩张窗口——
    // hunter 侧自己做 ±1 容差，配置改了不用重新生成
    hours: hours.sort((x, y) => x - y),
    hourly,
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  minVisits: MIN_VISITS,
  note: `自动生成，勿手改。规则：访问>=${MIN_VISITS}次且福袋数为0的房间拉黑（用户手写黑名单不参与评估）`,
  total: autoBlack.length,
  rooms: autoBlack,
};

console.log(`  零福袋房间: ${zeroFudai} 个，其中访问>=${MIN_VISITS}次的 ${autoBlack.length} 个 → 自动黑名单`);
console.log(`  有 hourly 画像的房间: ${candidateCount} 个 → 时段画像`);

if (DRY) {
  console.log('  [dry] 不写文件');
  console.log('  自动黑名单样本: ' + autoBlack.slice(0, 5).map((x) => x.room).join(', '));
  process.exit(0);
}

fs.writeFileSync(path.join(DATA, 'auto-blacklist.json'), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(DATA, 'hour-windows.json'), JSON.stringify({
  generatedAt: out.generatedAt,
  note: '自动生成，勿手改。hours 是该房间历史上发过福袋的小时，hunter 按其±1判断是否值得探测',
  total: Object.keys(hourWindows).length,
  rooms: hourWindows,
}, null, 1));

console.log(`  已写入 data/auto-blacklist.json 与 data/hour-windows.json`);
