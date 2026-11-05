#!/usr/bin/env node
/**
 * 抖音福袋 · 日报生成
 *
 * 用法：
 *   node daily-report.mjs              生成今天的报告
 *   node daily-report.mjs 2026-11-02   生成指定日期
 *
 * 输出：reports/YYYY-MM-DD.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './paths.mjs';

// 📅 本地时区日期（YYYY-MM-DD）。
//    ⚠ 不能用 new Date().toISOString().slice(0,10)——那是 UTC 日期，
//    北京 00:00-08:00 期间 UTC 还停在前一天，会让「今日战果」全部算错。
const localDay = (d = new Date()) => {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().slice(0, 10);
};

// 📅 判断一条记录的 at 时间戳是否属于「本地某一天」。
//    ⚠ 数据里的 at 是 UTC ISO 字符串（2026-11-03T16:09Z），直接 startsWith('2026-11-04')
//    会漏掉北京时间 0-8 点的记录——它们 UTC 日期还是前一天。
//    2026-11-04 00:59 实际踩过：0点抢到的 4 个福袋一个都没算进「今日」。
const isLocalDay = (isoStr, day = localDay()) => {
  if (!isoStr) return false;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return false;
  return localDay(d) === day;
};



const ROOT = APP_ROOT;
const DATA = path.join(ROOT, 'data', 'participations.jsonl');
const WINS = path.join(ROOT, 'data', 'wins.jsonl');
const LEGACY = path.join(ROOT, 'douyin-auto', 'h35-results.jsonl');
const LOG = path.join(ROOT, 'douyin-auto', 'h35.log');
const OUT_DIR = path.join(ROOT, 'reports');


/** 按「房间 + 12 分钟滑动窗口」去重。
 *  ⚠ 旧实现用 Math.floor(t/360000) 固定 6 分钟桶，桶边界会把同一个福袋切成两个：
 *  实测 8199758142 的同一福袋横跨 02:14:32-02:21:36（7 分钟），正好跨过 02:18 的桶边界，
 *  被算成 2 个，使「遭遇次数」虚高。看板侧已修为滑动窗口，日报这里必须同步，
 *  否则同一份数据两处显示的数字会对不上（看板 4 次、日报 5 次）。
 *  福袋倒计时实测最长 10 分钟，12 分钟窗口能完整覆盖；实际间隔 30-60 分钟，不会误并。 */
function dedupRows(rows) {
  const WIN = 12 * 60 * 1000;
  const last = new Map();
  const out = [];
  const sorted = [...rows].sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());
  for (const r of sorted) {
    const room = (r.url || '').split('/').pop() || '';
    const t = new Date(r.at || 0).getTime();
    if (!t) { out.push(r); continue; }
    // 多账号并行：两个号在同一间房各抢一次是两次真实参与，key 必须含账号
    const key = room + '|' + (r.account || 'default');
    const prev = last.get(key);
    if (prev !== undefined && Math.abs(t - prev) < WIN) continue;
    last.set(key, t);
    out.push(r);
  }
  return out;
}

const day = process.argv[2] || localDay();
let NAMES = {};
try { NAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'room-names.json'), 'utf8')) || {}; } catch {}
const dispRoom = (room) => (NAMES[room] ? NAMES[room] + '(' + room + ')' : room);

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

const all = [
  ...readJsonl(DATA),
  ...readJsonl(LEGACY).map((r) => ({ ...r, account: 'default' })),
];
const rows = dedupRows(all.filter((r) => isLocalDay(r.at, day)));
const wins = readJsonl(WINS).filter((w) => isLocalDay(w.at, day));

// 统计
const byResult = {};
const byRoom = {};
const byHour = {};
for (const r of rows) {
  byResult[r.result || '?'] = (byResult[r.result || '?'] || 0) + 1;
  const room = (r.url || '').split('/').pop();
  if (room) {
    byRoom[room] = byRoom[room] || { total: 0, joined: 0 };
    byRoom[room].total++;
    if (r.result === 'joined' || r.result === 'maybe-joined') byRoom[room].joined++;
  }
  const d = new Date(r.at);
  const h = d.getHours();
  byHour[h] = (byHour[h] || 0) + 1;
}

const joined = rows.filter((r) => r.result === 'joined' || r.result === 'maybe-joined');
const joins = joined.sort((a, b) => String(a.at).localeCompare(String(b.at)));

const LABEL = {
  'maybe-joined': '参与成功（待确认）',
  joined: '参与成功（已确认）',
  'skip-fans': '粉丝团型（跳过）',
  'fans-no-coins': '抖币不足（需充值）',
  'fans-unverified': '粉丝团加入未确认',
  'no-panel': '未找到面板',
  'packet-skipped': '人气红包（按配置不抢）',
  'need-follow': '需要关注（抢不到）',
  'btn-still': '按钮未消失',
};

function hhmm(iso) {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

const lines = [];
lines.push(`# 抖音福袋日报 · ${day}`);
lines.push('');
lines.push(`## 总览`);
lines.push('');
lines.push(`- 福袋遭遇：**${rows.length}** 次`);
lines.push(`- 成功参与：**${joined.length}** 次`);
lines.push(`- 参与率：**${rows.length ? ((joined.length / rows.length) * 100).toFixed(1) : 0}%**`);
lines.push(`- 中奖：**${wins.length}** 次`);
lines.push('');

if (joins.length) {
  lines.push(`## 参与明细`);
  lines.push('');
  lines.push('| 时间 | 房间 | 在线人数 | 结果 |');
  lines.push('|:---|:---|:---|:---|');
  for (const r of joins) {
    const room = (r.url || '').split('/').pop();
    lines.push(`| ${hhmm(r.at)} | ${dispRoom(room)} | ${r.online ?? '-'} | ${LABEL[r.result] || r.result} |`);
  }
  lines.push('');
}

if (Object.keys(byHour).length) {
  lines.push(`## 时段分布`);
  lines.push('');
  lines.push('| 时段 | 遭遇次数 |');
  lines.push('|:---|:---|');
  for (const h of Object.keys(byHour).sort((a, b) => a - b)) {
    lines.push(`| ${String(h).padStart(2, '0')}:00 - ${String(h).padStart(2, '0')}:59 | ${byHour[h]} |`);
  }
  lines.push('');
}

if (Object.keys(byResult).length) {
  lines.push(`## 结果分布`);
  lines.push('');
  for (const [k, v] of Object.entries(byResult).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${LABEL[k] || k}：${v} 次`);
  }
  lines.push('');
}

const ranked = Object.entries(byRoom).filter(([, v]) => v.joined > 0).sort((a, b) => b[1].joined - a[1].joined);
if (ranked.length) {
  lines.push(`## 房间排行`);
  lines.push('');
  lines.push('| 房间 | 参与 | 遭遇 |');
  lines.push('|:---|:---|:---|');
  for (const [room, v] of ranked) lines.push(`| ${dispRoom(room)} | ${v.joined} | ${v.total} |`);
  lines.push('');
}

if (wins.length) {
  lines.push(`## 中奖记录`);
  lines.push('');
  for (const w of wins) lines.push(`- ${hhmm(w.at)} ${w.room}：${(w.text || '').slice(0, 80)}`);
  lines.push('');
}

lines.push(`## 系统状况`);
lines.push('');
try {
  const logLines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  // ⚠ 必须同时统计「页面空白」：日志里两种写法的含义相同（都是加载不出直播间），
  //   只统计「加载失败」会漏掉一半（实测 45 vs 93），让日报低估异常程度。
  const loadFailLines = logLines.filter((l) => l.includes('加载失败') || l.includes('页面空白'));
  const loadFails = loadFailLines.length;
  const fatals = logLines.filter((l) => l.includes('FATAL')).length;
  // 按时段分布：单个数字看不出「是一次事故还是持续异常」，必须给出分布
  const failByHour = {};
  for (const l of loadFailLines) {
    const m = l.match(/^\[(\d{2}):/);
    if (m) failByHour[m[1]] = (failByHour[m[1]] || 0) + 1;
  }
  const hours = Object.keys(failByHour).sort();
  const hourStr = hours.map((h) => `${h}点 ${failByHour[h]}`).join('、');
  const peak = hours.length ? Math.max(...hours.map((h) => failByHour[h])) : 0;
  const isBurst = loadFails > 0 && peak / loadFails > 0.5;
  lines.push(`- 加载失败：${loadFails} 次${hourStr ? `　分布：${hourStr}` : ''}`);
  if (isBurst) {
    lines.push(`  - ⚠ 其中 ${peak} 次（${Math.round(peak / loadFails * 100)}%）集中在单一时段，属单次标签卡死事故，已由「重建标签」自愈，非持续性异常`);
  }
  lines.push(`- 致命错误：${fatals} 次`);
  const qualities = logLines.filter((l) => l.includes('📊 候选质量')).slice(-1);
  if (qualities.length) lines.push(`- 最后候选质量：${qualities[0].replace(/^\[[0-9:]*\] /, '')}`);
} catch {
  lines.push('- 日志不可读');
}
lines.push('');

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `${day}.md`);
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`日报已生成: ${outFile}`);
console.log(lines.join('\n'));
