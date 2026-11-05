#!/usr/bin/env node
/**
 * 抖音福袋 · 策略体检报告（离线、只读、不改写任何配置）
 *
 * 用法：
 *   node scripts/strategy-report.mjs                    今日
 *   node scripts/strategy-report.mjs --date 2026-11-05 指定本地日
 *   node scripts/strategy-report.mjs --all              全部历史
 *   node scripts/strategy-report.mjs --by policy        按参数版本分组
 *
 * 数据源：data/strategy-log.jsonl（由 hunter35.mjs 的 🧠 底座写入）
 *   candidates / room-enter / gate-skip / join-result / draw-result / room-exit
 *
 * 目标函数（用户 2026-11-05 定稿）：单位时间中奖期望
 *   = 中奖次数 / 总投入时间（小时）
 *   分母用 room-exit.stayedSec 的真实停留，而非 plannedStaySec 的计划值。
 *
 * ⚠ 本报告只呈现事实与候选优化方向，绝不自动改 data/*.json。
 *    样本不足时会明确标注「样本不足」，不做结论。
 */
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './paths.mjs';

const ROOT = APP_ROOT;
const LOG = path.join(ROOT, 'data', 'strategy-log.jsonl');
const localDay = (d = new Date()) => {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().slice(0, 10);
};
const isLocalDay = (iso, day) => {
  if (!iso) return false;
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && localDay(d) === day;
};

const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const dateIdx = argv.indexOf('--date');
const day = dateIdx >= 0 ? argv[dateIdx + 1] : localDay();
const byPolicy = argv.includes('--by') && argv[argv.indexOf('--by') + 1] === 'policy';

const readJsonl = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
      .map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};
const pct = (a, b) => b > 0 ? (a / b * 100).toFixed(1) + '%' : '—';
const r1 = (n) => Number(n || 0).toFixed(1);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const all = readJsonl(LOG);
const rows = showAll ? all : all.filter(r => isLocalDay(r.at, day));

console.log('');
console.log('════════════════════════════════════════════════════════════');
console.log('  抖音福袋 · 策略体检报告');
console.log('  范围：' + (showAll ? '全部历史' : day + '（本地日）') + '    目标函数：单位时间中奖期望');
console.log('════════════════════════════════════════════════════════════');
console.log('');

if (!rows.length) {
  console.log('  ⚠ data/strategy-log.jsonl 无' + (showAll ? '' : '该日') + '数据。');
  console.log('    底座仅在 hunter35 重启后开始写入；当前若仍在跑旧进程，属预期。');
  console.log('    可用 --all 查看是否有历史数据，或等主实例空闲窗口重启后再跑。');
  console.log('');
  process.exit(0);
}

const evCount = {};
rows.forEach(r => evCount[r.ev] = (evCount[r.ev] || 0) + 1);
console.log('【数据概览】');
console.log('  事件总数 ' + rows.length + '  ' + Object.entries(evCount).map(([k, v]) => k + ':' + v).join('  '));
const policies = [...new Set(rows.map(r => r.policyId).filter(Boolean))];
console.log('  参数版本 ' + policies.length + ' 个：' + policies.join(', '));
console.log('  账号 ' + [...new Set(rows.map(r => r.account))].join(', '));
console.log('');

// ── 核心：单位时间中奖期望 ──────────────────────────────────────
const exits = rows.filter(r => r.ev === 'room-exit');
const draws = rows.filter(r => r.ev === 'draw-result');
const joins = rows.filter(r => r.ev === 'join-result');
const gates = rows.filter(r => r.ev === 'gate-skip');
const totalStaySec = exits.reduce((t, r) => t + Number(r.stayedSec || 0), 0);
const wins = draws.filter(r => r.win).length;
const losses = draws.filter(r => !r.win).length;
const perHour = totalStaySec > 0 ? wins / (totalStaySec / 3600) : 0;

console.log('【核心指标 · 单位时间中奖期望】');
console.log('  房间停留总时长   ' + padL((totalStaySec / 3600).toFixed(1), 7) + ' 小时（来自 room-exit 真实耗时，共 ' + exits.length + ' 次）');
console.log('  参与次数         ' + padL(joins.length, 7) + ' 次，其中成功 ' + joins.filter(r => r.result === 'joined' || r.result === 'maybe-joined').length);
console.log('  开奖结果         ' + padL(draws.length, 7) + ' 次：中奖 ' + wins + ' / 未中 ' + losses + ' / 未检出 ' + (joins.filter(r => r.result === 'joined').length - draws.length));
console.log('  ★ 中奖期望       ' + padL(perHour.toFixed(3), 7) + ' 次/小时');
if (totalStaySec < 3600) console.log('  ⚠ 停留不足 1 小时，该比率仅供参考，样本量不足以支撑调参');
if (wins === 0 && draws.length > 0) console.log('  ⚠ 中奖 0 次：当前无法用它比较策略优劣，需累积样本；下列分维度指标仍可定位「时间浪费」');
console.log('');

// ── A. 时间维度 ───────────────────────────────────────────────
console.log('【A. 时间维度 · 哪些时段值得多巡】');
const byHour = {};
for (const r of exits) {
  const h = r.hour ?? new Date(r.at).getHours();
  byHour[h] ||= { stay: 0, n: 0, fudai: 0 };
  byHour[h].stay += Number(r.stayedSec || 0);
  byHour[h].n++;
  if (r.hadFudai) byHour[h].fudai++;
}
for (const r of joins) {
  const h = r.hour ?? new Date(r.at).getHours();
  byHour[h] ||= { stay: 0, n: 0, fudai: 0 };
  byHour[h].joins = (byHour[h].joins || 0) + 1;
}
for (const r of draws) {
  const h = r.hour ?? new Date(r.at).getHours();
  byHour[h] ||= { stay: 0, n: 0, fudai: 0 };
  if (r.win) byHour[h].wins = (byHour[h].wins || 0) + 1;
}
console.log('  ' + pad('时段', 8) + padL('停留h', 8) + padL('房间', 7) + padL('有福袋', 8) + padL('参与', 7) + padL('中奖', 7) + '  中奖/h');
Object.keys(byHour).sort((a, b) => a - b).forEach(h => {
  const v = byHour[h];
  const hrs = v.stay / 3600;
  const rate = hrs > 0 ? ((v.wins || 0) / hrs).toFixed(3) : '0.000';
  console.log('  ' + pad(h + '点', 8) + padL(hrs.toFixed(1), 8) + padL(v.n, 7) + padL(v.fudai, 8) + padL(v.joins || 0, 7) + padL(v.wins || 0, 7) + '  ' + rate);
});
console.log('');

// ── B. 房间维度 ───────────────────────────────────────────────
console.log('【B. 房间维度 · 时间花得值不值】');
const byRoom = {};
for (const r of exits) {
  byRoom[r.room] ||= { stay: 0, n: 0, fudai: 0, postDraw: 0, vip: 0, score: 0 };
  const v = byRoom[r.room];
  v.stay += Number(r.stayedSec || 0);
  v.n++;
  if (r.hadFudai) v.fudai++;
  v.postDraw += Number(r.postDrawRound || 0);
  if (r.isVip) v.vip++;
  v.score = r.score || 0;
}
for (const r of joins) {
  byRoom[r.room] ||= { stay: 0, n: 0, fudai: 0, postDraw: 0, vip: 0, score: 0 };
  byRoom[r.room].joins = (byRoom[r.room].joins || 0) + 1;
}
for (const r of draws) {
  byRoom[r.room] ||= { stay: 0, n: 0, fudai: 0, postDraw: 0, vip: 0, score: 0 };
  if (r.win) byRoom[r.room].wins = (byRoom[r.room].wins || 0) + 1;
}
const roomArr = Object.entries(byRoom).sort((a, b) => b[1].stay - a[1].stay);
console.log('  ' + pad('房间', 20) + padL('停留min', 10) + padL('次数', 7) + padL('有袋', 7) + padL('参与', 7) + padL('中奖', 7) + padL('再蹲', 7));
roomArr.slice(0, 12).forEach(([room, v]) => {
  console.log('  ' + pad(room, 20) + padL((v.stay / 60).toFixed(1), 10) + padL(v.n, 7) + padL(v.fudai, 7) + padL(v.joins || 0, 7) + padL(v.wins || 0, 7) + padL(v.postDraw, 7));
});
const waste = roomArr.filter(([, v]) => v.n >= 3 && v.fudai === 0);
const wasteSec = waste.reduce((t, [, v]) => t + v.stay, 0);
console.log('  → 常驻≥3 次且 0 福袋的房间 ' + waste.length + ' 个，耗掉 ' + (wasteSec / 3600).toFixed(1) + ' 小时（占总停留 ' + pct(wasteSec, totalStaySec) + '）');
if (waste.length) console.log('    候选降权名单：' + waste.slice(0, 6).map(([r]) => r).join(', '));
console.log('');

// ── C. 动作维度 ───────────────────────────────────────────────
console.log('【C. 策略动作维度】');
const postDrawTotal = exits.reduce((t, r) => t + Number(r.postDrawRound || 0), 0);
console.log('  开奖后循环蹲守   ' + postDrawTotal + ' 轮（postDrawWaitSec 当前值见 policy 快照）');
// 蹲守后是否真的又抢到：同一 decisionId 出现 >1 次 join-result
const joinById = {};
joins.forEach(r => { joinById[r.decisionId] = (joinById[r.decisionId] || 0) + 1; });
const reJoin = Object.values(joinById).filter(n => n > 1).length;
console.log('  同一次常驻内重复参与 ' + reJoin + ' 次（循环蹲守捞回的新福袋）');
console.log('  门槛硬卡拦截     ' + gates.length + ' 次，在线数明细：' + gates.slice(0, 8).map(r => r.online + '<' + r.minOnline).join(' '));
if (gates.length) {
  const near = gates.filter(r => r.minOnline > 0 && r.online >= r.minOnline * 0.5);
  console.log('    → 其中在线数已达门槛 50% 以上的 ' + near.length + ' 次，是「门槛是否偏高」的直接反事实线索');
}
console.log('');

// ── D. 参数版本对比 ───────────────────────────────────────────
console.log('【D. 参数版本 · 策略快照】');
const snap = rows.find(r => r.policyId);
if (byPolicy || policies.length > 1) {
  policies.forEach(pid => {
    const sub = rows.filter(r => r.policyId === pid);
    const e = sub.filter(r => r.ev === 'room-exit');
    const d = sub.filter(r => r.ev === 'draw-result');
    const sec = e.reduce((t, r) => t + Number(r.stayedSec || 0), 0);
    const w = d.filter(r => r.win).length;
    const rate = sec > 0 ? (w / (sec / 3600)).toFixed(3) : '0.000';
    console.log('  ' + pid + '  停留 ' + (sec / 3600).toFixed(1) + 'h  参与 ' + sub.filter(r => r.ev === 'join-result').length + '  中奖 ' + w + '  期望 ' + rate + '/h');
  });
  if (policies.length === 1) console.log('  ⚠ 只有 1 个参数版本，无法做 A/B 对比；改配置后重启即产生新 policyId');
} else {
  console.log('  当前只有 1 个参数版本，用 --by policy 可查看分组。');
}
console.log('  最早记录的快照字段：' + (snap ? ['policyId', 'hour', 'account', 'ev'].join(', ') : '无'));
console.log('');

// ── E. 优化建议（只陈述事实，不改配置）────────────────────────
console.log('【E. 优化候选 · 仅建议，不自动执行】');
const suggestions = [];
if (waste.length && wasteSec / Math.max(totalStaySec, 1) > 0.2)
  suggestions.push('房间选择：' + waste.length + ' 个零产出房间吃掉 ' + pct(wasteSec, totalStaySec) + ' 停留时间，可考虑降权');
const hours = Object.entries(byHour).filter(([, v]) => v.n >= 2 && v.stay >= 600);
if (hours.length >= 2) {
  const sorted = hours.sort((a, b) => (b[1].fudai / Math.max(b[1].stay, 1)) - (a[1].fudai / Math.max(a[1].stay, 1)));
  suggestions.push('时间分配：' + sorted[0][0] + '点单位时间福袋密度最高，' + sorted[sorted.length - 1][0] + '点最低，可考虑按时段调整巡房密度');
}
if (gates.length >= 3)
  suggestions.push('门槛：' + gates.length + ' 次福袋被在线数硬卡拦下，需结合中奖质量判断是否该调');
if (postDrawTotal > 0 && reJoin === 0)
  suggestions.push('开奖后蹲守：' + postDrawTotal + ' 轮未捞回任何新福袋，postDrawWaitSec 的收益待验证');
if (wins === 0 && draws.length >= 10)
  suggestions.push('目标函数：已开奖 ' + draws.length + ' 次仍 0 中奖，中奖期望接近 0，需累积样本或核对奖品类型');
if (!suggestions.length) suggestions.push('样本不足，暂不出调参建议；继续累积数据');
suggestions.forEach((x, i) => console.log('  ' + (i + 1) + '. ' + x));
console.log('');
console.log('  ⚠ 本报告不改写任何 data/*.json。所有结论需结合人工判断后再决定是否调参。');
console.log('');
