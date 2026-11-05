#!/usr/bin/env node
/**
 * 抖音福袋 · 数据导出
 *
 * 用法：
 *   node export-csv.mjs              导出今日
 *   node export-csv.mjs --all        导出全部历史
 *
 * 输出：exports/fudai-YYYY-MM-DD.csv（UTF-8 BOM，Excel 可直接打开）
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
const isLocalDay = (iso, day) => {
  if (!iso) return false;
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && localDay(d) === day;
};


const ROOT = APP_ROOT;
const DATA = path.join(ROOT, 'data', 'participations.jsonl');
const WINS = path.join(ROOT, 'data', 'wins.jsonl');
const LEGACY = path.join(ROOT, 'douyin-auto', 'h35-results.jsonl');
const OUT_DIR = path.join(ROOT, 'exports');

const showAll = process.argv.includes('--all');
const day = localDay();

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

/** 按房间+6分钟窗口去重 */
function dedup(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const room = (r.url || '').split('/').pop() || '';
    const t = new Date(r.at || 0).getTime();
    if (!t) { out.push(r); continue; }
    const k = room + '#' + Math.floor(t / 360000);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

let NAMES = {};
try { NAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'room-names.json'), 'utf8')); } catch {}

const all = dedup([
  ...readJsonl(DATA),
  ...readJsonl(LEGACY).map((r) => ({ ...r, account: 'default' })),
]);

const rows = all
  .filter((r) => showAll || isLocalDay(r.at, day))
  .sort((a, b) => String(a.at).localeCompare(String(b.at)));

const LABEL = {
  'joined': '参与成功',
  'maybe-joined': '参与成功(待确认)',
  'skip-fans': '粉丝团跳过',
  'fans-no-coins': '抖币不足需充值',
  'fans-unverified': '粉丝团加入未确认',
  'need-follow': '需关注(抢不到)',
  'no-panel': '未找到面板',
  'packet-skipped': '人气红包按配置不抢',
  'btn-still': '按钮未消失',
};

// CSV 转义
const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// 账号显示名：导出结果不要出现 default / main2 这种内部代号
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

const header = ['时间', '主播昵称', '房间号', '结果', '在线人数', '倒计时', '账号'];
const lines = [header.join(',')];

for (const r of rows) {
  const room = (r.url || '').split('/').pop() || '';
  const t = new Date(r.at);
  const local = isNaN(t) ? String(r.at) : t.toLocaleString('zh-CN', { hour12: false });
  lines.push([
    local,
    NAMES[room] || '',
    room,
    LABEL[r.result] || r.result || '',
    r.online ?? '',
    r.cd ?? '',
    accLabel(r.account || 'default'),
  ].map(esc).join(','));
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const suffix = showAll ? 'all' : day;
const outFile = path.join(OUT_DIR, `fudai-${suffix}.csv`);
// 加 BOM，Excel 才认 UTF-8
fs.writeFileSync(outFile, '\uFEFF' + lines.join('\n') + '\n');

console.log(`已导出 ${rows.length} 条记录`);
console.log(`文件: ${outFile}`);
console.log(`\n前 3 行预览:`);
console.log(lines.slice(0, 4).join('\n'));
