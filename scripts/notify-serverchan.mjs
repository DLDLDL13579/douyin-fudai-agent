#!/usr/bin/env node
/**
 * Server 酱推送工具（2026-11-10 用户定稿「如果中奖了，就要通过server酱给我发消息」）
 *
 * 设计原则：
 *   ① SendKey 放 data/notify-config.json，不硬编码在代码里
 *   ② 只在「中奖」与「严重异常」时推送，日常巡检不打扰
 *   ③ 网络失败不抛异常（推送是旁路，绝不能拖垮抓取主流程）
 *   ④ 支持 --dry 只打印不发送，便于排查
 *
 * 用法：
 *   node scripts/notify-serverchan.mjs --title "标题" --desp "正文"
 *   node scripts/notify-serverchan.mjs --title "..." --desp "..." --dry
 *   node scripts/notify-serverchan.mjs --win --room 123 --text "没抽中/中奖"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG_PATH = path.join(ROOT, 'data', 'notify-config.json');

function loadCfg() {
  try {
    return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const out = { dry: false, win: false, confirm: false, fromHunter: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') out.dry = true;
    else if (a === '--confirm') out.confirm = true;
    else if (a === '--from-hunter') out.fromHunter = true;
    else if (a === '--win') out.win = true;
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--desp') out.desp = argv[++i];
    else if (a === '--room') out.room = argv[++i];
    else if (a === '--text') out.text = argv[++i];
  }
  return out;
}

/** 发送一条推送。返回 {ok, code, msg}，绝不 throw。 */
export async function push(title, desp, { dry = false } = {}) {
  const cfg = loadCfg();
  const sc = cfg.serverChan || {};
  if (!sc.enabled) return { ok: false, code: -1, msg: 'disabled' };
  const key = sc.sendKey || '';
  if (!key) return { ok: false, code: -1, msg: 'no-sendkey' };

  const endpoint = (sc.endpoint || 'https://sctapi.ftqq.com/{key}.send')
    .replace('{key}', encodeURIComponent(key));

  if (dry) {
    console.log(`[dry] POST ${endpoint.replace(key, key.slice(0, 8) + '...')}`);
    console.log(`[dry] title=${title}`);
    console.log(`[dry] desp=${String(desp).slice(0, 200)}`);
    return { ok: true, code: 0, msg: 'dry-run' };
  }

  try {
    const body = new URLSearchParams({ title: String(title).slice(0, 32), desp: String(desp) });
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const txt = await r.text();
    let j = {};
    try { j = JSON.parse(txt); } catch { /* 非 JSON 也当失败处理 */ }
    const ok = j.code === 0;
    const res = { ok, code: j.code, msg: j.message || j.data?.error || txt.slice(0, 120) };
    // 🔴 2026-11-10 16:25 配额耗尽兜底：免费版每天 5 条，用完时真中奖会推不出去。
    //    失败就写入待发队列 data/notify-queue.jsonl，健康守护在下轮
    //    （通常是次日 0 点配额重置后）自动补发，绝不静默丢失中奖消息。
    if (!ok) {
      try {
        const qf = path.join(ROOT, 'data', 'notify-queue.jsonl');
        fs.appendFileSync(qf, JSON.stringify({
          at: new Date().toISOString(), title: String(title), desp: String(desp),
          failCode: res.code, failMsg: String(res.msg).slice(0, 120),
        }) + '\n');
        console.error('[queue] 推送失败已入队待补发：' + String(res.msg).slice(0, 80));
      } catch { /* 入队失败也不能抛 */ }
    }
    return res;
  } catch (e) {
    const res = { ok: false, code: -2, msg: String(e.message || e).slice(0, 120) };
    try {
      const qf = path.join(ROOT, 'data', 'notify-queue.jsonl');
      fs.appendFileSync(qf, JSON.stringify({
        at: new Date().toISOString(), title: String(title), desp: String(desp),
        failCode: res.code, failMsg: res.msg,
      }) + '\n');
    } catch { /* ignore */ }
    return res;
  }
}

/** 补发队列里的消息（健康守护调用）。返回 {tried,sent,left} */
export async function flushQueue({ dry = false } = {}) {
  const qf = path.join(ROOT, 'data', 'notify-queue.jsonl');
  let lines = [];
  try {
    lines = fs.readFileSync(qf, 'utf8').trim().split('\n').filter(Boolean);
  } catch { return { tried: 0, sent: 0, left: 0 }; }
  if (!lines.length) return { tried: 0, sent: 0, left: 0 };
  const keep = [];
  let sent = 0;
  for (const ln of lines) {
    let it;
    try { it = JSON.parse(ln); } catch { continue; }
    // 补发时加【补发】标记，避免和实时消息混淆
    const r = await push('【补发】' + String(it.title || ''), String(it.desp || ''), { dry });
    if (r.ok) sent++;
    else keep.push(ln);
  }
  try {
    if (keep.length) fs.writeFileSync(qf, keep.join('\n') + '\n');
    else fs.rmSync(qf, { force: true });
  } catch { /* ignore */ }
  return { tried: lines.length, sent, left: keep.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv);
  const cfg = loadCfg();

  // --win 是专项入口：中奖推送，标题带 emoji 便于手机通知里一眼识别
  if (args.win) {
    if (cfg.triggers && cfg.triggers.win === false) {
      console.log('中奖推送已在配置里关闭');
      process.exit(0);
    }
    // 🔴 2026-11-10 16:25 防呆：用户明确指出「发假消息、浪费消息资源」。
    //    手工调用 --win 时，默认只 dry-run；必须显式加 --confirm 才真发，
    //    且标题强制带「测试」前缀，杜绝「假中奖通知」出现在手机上。
    //    hunter35 自动调用时传 --from-hunter，跳过此保护（那是真中奖）。
    if (!args.fromHunter && !args.confirm) {
      console.log('[保护] --win 是真实中奖通道，手工调用需加 --confirm；本次只 dry-run');
      args.dry = true;
    }
    const isManual = !args.fromHunter;
    const title = isManual ? '【测试】抖音福袋中奖通道' : '🎉 抖音福袋中奖了！';
    const desp = [
      `**时间**：${new Date().toLocaleString('zh-CN')}`,
      `**房间**：${args.room || '未知'}`,
      '',
      '**开奖文案**：',
      '```',
      String(args.text || '').slice(0, 400),
      '```',
      '',
      '请到抖音 App 里查看奖品并领取。',
    ].join('\n');
    const r = await push(title, desp, { dry: args.dry });
    console.log(r.ok ? `✅ 中奖推送成功 code=${r.code}` : `❌ 中奖推送失败 code=${r.code} ${r.msg}`);
    process.exit(r.ok ? 0 : 1);
  }

  // 🔴 手工发送一律加「测试」前缀，除非显式 --from-hunter（自动链路）
  let title = args.title || '抖音福袋通知';
  if (!args.fromHunter && !/测试/.test(title)) title = '【测试】' + title;
  const desp = args.desp || '';
  const r = await push(title, desp, { dry: args.dry });
  console.log(r.ok ? `✅ 推送成功 code=${r.code}` : `❌ 推送失败 code=${r.code} ${r.msg}`);
  process.exit(r.ok ? 0 : 1);
}
