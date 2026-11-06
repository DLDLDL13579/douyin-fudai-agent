#!/usr/bin/env node
/**
 * 补记抖币消费历史（2026-11-06 用户报告「钻石消耗记录失败，0 钻」）
 *
 * 背景：joinFansGroup 旧判据只有 ok（验证读到「已加入」文案）才写 coin-spend.jsonl，
 *   但该验证表达式 51 次抛 __err:Uncaught、仅 1 次成功。而参与按钮就位 hasJoinBtn
 *   才是真加入信号：52 次加入尝试里 50 次随后 joined，今日 16 条 fans-join:joinBtn
 *   记录全部 result=joined。故 49 次真实消费被整批漏记，文件甚至从未生成。
 *
 * 补记依据：data/participations.jsonl 里 steps 含 'fans-join:joinBtn' 且 result 为
 *   joined/maybe-joined 的记录 —— 每一条都代表一次真实加入粉丝团并消耗 1 抖币。
 *
 * ⚠ 只取 participations.jsonl。douyin-auto/h35-results.jsonl 是同一批数据的旧副本，
 *   实测 40 条与 participations 的 at|url 100% 重叠；合并会重复计 40 钻。
 * ⚠ 补记条目带 backfill:true / source:'participations.jsonl#fans-join:joinBtn'，
 *   与运行时实时写入的条目可区分，不伪造成当时就记了。
 * ⚠ 幂等：按 at|account|room 去重，重跑不会产生重复记录。
 * ⚠ 只读运行时数据、只追加 coin-spend.jsonl；不改写 participations、不改配置。
 *
 * 用法：node scripts/backfill-coin-spend.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SRC = path.join(DATA, 'participations.jsonl');
const DST = path.join(DATA, 'coin-spend.jsonl');
const DRY = process.argv.includes('--dry-run');

const readJsonl = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
};

const rows = readJsonl(SRC);
const hits = rows.filter((r) =>
  (Array.isArray(r.steps) && r.steps.some((s) => String(s).includes('fans-join:joinBtn')))
  && (r.result === 'joined' || r.result === 'maybe-joined')
  && r.at && r.url);

// 既有记账（含运行时实时写入）的 key，用于幂等
const existing = new Set(readJsonl(DST).map((r) =>
  `${r.at}|${r.account || 'default'}|${r.room || ''}`));

const builds = hits.map((r) => ({
  at: r.at,
  account: r.account || 'default',
  room: (r.url || '').split('/').pop() || '',
  action: 'join-fans-group',
  coins: 1,
  backfill: true,
  source: 'participations.jsonl#fans-join:joinBtn',
  note: '补记：加入粉丝团（参与按钮就位并参与成功，消耗1抖币）',
}));

const fresh = builds.filter((b) => !existing.has(`${b.at}|${b.account}|${b.room}`));
const sum = readJsonl(DST).reduce((n, r) => n + (Number(r.coins) || 0), 0);

console.log(`参与记录 ${rows.length} 条，命中真加入 ${hits.length} 条`);
console.log(`既有记账 ${existing.size} 条 / 合计 ${sum} 钻`);
console.log(`本次补记 ${fresh.length} 条 / +${fresh.reduce((n, b) => n + b.coins, 0)} 钻`);
if (fresh.length) {
  const t = fresh.map((b) => b.at).sort();
  console.log(`时间范围 ${t[0]} → ${t.slice(-1)[0]}`);
  const byAcc = {};
  for (const b of fresh) byAcc[b.account] = (byAcc[b.account] || 0) + 1;
  console.log(`分账号 ${JSON.stringify(byAcc)}`);
}

if (DRY) {
  console.log('\n--dry-run：未写入任何文件');
  process.exit(0);
}
if (!fresh.length) {
  console.log('\n无新增，文件保持不变');
  process.exit(0);
}
fs.appendFileSync(DST, fresh.map((b) => JSON.stringify(b)).join('\n') + '\n', 'utf8');
const after = readJsonl(DST);
console.log(`\n已写入 ${DST}`);
console.log(`现有 ${after.length} 条 / 合计 ${after.reduce((n, r) => n + (Number(r.coins) || 0), 0)} 钻`);
console.log(`其中补记 ${after.filter((r) => r.backfill).length} 条`);
