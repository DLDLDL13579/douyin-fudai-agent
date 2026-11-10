#!/usr/bin/env node
/**
 * cond1 面板锁定猎手 v2（2026-11-10 17:47）
 *
 * v1 的问题：轮询日志找「最近出现过的福袋」，但福袋往往 1-2 分钟就消失，
 * 等脚本看到日志、切房间、加载完页面，福袋已经没了 → 连续 40 分钟 0 快照。
 *
 * v2 改为「锁定房间 + 高频轮询」：
 *   ① 从今日 no-panel 统计里取 Top N 房间（这些是真正出问题的房间）
 *   ② 每个房间一个专用标签页，常驻不动
 *   ③ 每 2 秒扫一次该页面的 LMUtLyr9 图标
 *   ④ 一发现图标立刻点击 + 抓快照，无论它是不是刚好在日志里出现过
 *
 * 这样只看「页面此刻有没有福袋」，不再依赖日志时序，命中率高得多。
 *
 * 用法：node scripts/hunt-cond1-v2.mjs [最多抓几个] [最多跑几分钟]
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'cond1-captures');
fs.mkdirSync(OUT, { recursive: true });

const MAX_CAP = Number(process.argv[2] || 5);
const MAX_MIN = Number(process.argv[3] || 40);
const DEADLINE = Date.now() + MAX_MIN * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const req = (port, p, m = 'GET') =>
  new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: m }, (x) => {
      let s = '';
      x.on('data', (d) => (s += d));
      x.on('end', () => res(s));
    });
    r.on('error', rej);
    r.end();
  });

/** 今日 no-panel 的房间，按次数降序 */
function noPanelRooms() {
  try {
    const L = fs.readFileSync(path.join(ROOT, 'data/participations.jsonl'), 'utf8')
      .trim().split('\n').map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    const now = new Date();
    const isToday = (iso) => {
      const t = new Date(iso);
      return t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
    };
    const by = {};
    for (const r of L) {
      if (!isToday(r.at) || r.result !== 'no-panel') continue;
      const room = (r.url || '').split('/').pop();
      if (room) by[room] = (by[room] || 0) + 1;
    }
    return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([room, n]) => ({ room, n }));
  } catch {
    return [];
  }
}

async function openTab(port, room) {
  const t = JSON.parse(await req(port, '/json/new?about:blank', 'PUT'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
  });
  let id = 0;
  const q = new Map();
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(e.data);
    if (d.id && q.has(d.id)) { q.get(d.id)(d); q.delete(d.id); }
  });
  const send = (m, a) => new Promise((r) => {
    const k = ++id;
    q.set(k, r);
    ws.send(JSON.stringify({ id: k, method: m, params: a }));
  });
  const ev = async (expression, to = 15000) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, to);
    return r?.result?.result?.value;
  };
  await send('Page.enable');
  await send('Page.navigate', { url: 'https://live.douyin.com/' + room });
  return { port, room, tabId: t.id, ws, send, ev, captured: false, checks: 0 };
}

/** 移除静音遮罩（15:29 实测它会盖住面板按钮） */
const KILL_MUTE = `(()=>{let n=0;document.querySelectorAll('[class*="Wn6sF12t"],[class*="fbv9dwfC"],[class*="fBv9dwfC"],[class*="RntNeJeO"]').forEach(function(el){var t=(el.innerText||'');if(t.length<80&&/浏览器限制静音|点击打开声音|按 P 或/.test(t)){el.remove();n++}});return n})()`;

/** 抓完整快照 */
const GRAB = `(()=>{
  const out = {url: location.href, title: document.title, bodyLen: 0};
  const b = document.body.innerText || '';
  out.bodyLen = b.length;
  out.bodyFull = b.slice(0, 4000);
  out.buttons = [];
  for (const el of document.querySelectorAll('button,div[role="button"],span,a')){
    const t = (el.innerText||'').trim();
    if (!t || t.length > 40) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 14) continue;
    out.buttons.push({tag: el.tagName, text: t.slice(0,40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cls: String(el.className).slice(0,60)});
  }
  out.buttons = out.buttons.slice(0, 50);
  out.center = [];
  for (const el of document.querySelectorAll('div')){
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 120) continue;
    const cx = r.x + r.width/2;
    if (cx < innerWidth*0.25 || cx > innerWidth*0.75) continue;
    if (r.y < 30 || r.y + r.height > innerHeight - 20) continue;
    const t = (el.innerText||'').trim();
    if (!t) continue;
    out.center.push({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),text:t.slice(0,400),cls:String(el.className).slice(0,60)});
  }
  out.center = out.center.slice(0, 8);
  out.iframes = [];
  for (const f of document.querySelectorAll('iframe')){
    try{ const d=f.contentDocument; if(d&&d.body) out.iframes.push((d.body.innerText||'').slice(0,800)); }
    catch(e){ out.iframes.push('[cross-origin]'); }
  }
  out.keywords = {};
  for (const k of ['参与条件','加入粉丝团','点亮粉丝团','一键发评论参与福袋','参与福袋','立即参与','点击参与','福袋','粉丝团','关注','已参与']){
    out.keywords[k] = b.includes(k);
  }
  return JSON.stringify(out);
})()`;

async function tryCapture(t) {
  const n = await t.ev(`document.querySelectorAll('[class*="LMUtLyr9"]').length`, 8000);
  if (!n) return false;
  console.log(`[v2] ${t.room} 发现福袋图标！点击…`);
  await t.ev(KILL_MUTE, 8000);
  await sleep(300);
  const pos = await t.ev(`(()=>{var e=document.querySelector('[class*="LMUtLyr9"]');var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`, 8000);
  let p = null;
  try { p = JSON.parse(pos || 'null'); } catch { /* ignore */ }
  if (!p) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await t.send('Input.dispatchMouseEvent', {
      type, x: p.x, y: p.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
    });
  }
  await sleep(3500);
  const snap = await t.ev(GRAB, 20000);
  let parsed = {};
  try { parsed = JSON.parse(snap || '{}'); } catch { /* ignore */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(OUT, `${stamp}-${t.room}`);
  fs.writeFileSync(base + '.json', snap || '{}');
  try {
    const shot = await t.send('Page.captureScreenshot', { format: 'png' });
    if (shot?.result?.data) fs.writeFileSync(base + '.png', Buffer.from(shot.result.data, 'base64'));
  } catch { /* ignore */ }
  console.log(`[v2] ✅ 已保存 ${base}`);
  console.log(`[v2]    bodyLen=${parsed.bodyLen} 按钮=${(parsed.buttons||[]).length} 关键词=${JSON.stringify(parsed.keywords)}`);
  console.log(`[v2]    iframe=${(parsed.iframes||[]).length} center=${(parsed.center||[]).length}`);
  return true;
}

const targets = noPanelRooms().slice(0, 6);
if (!targets.length) {
  console.log('[v2] 今日无 no-panel 记录，退出');
  process.exit(0);
}
console.log(`[v2] 锁定 ${targets.length} 个房间：${targets.map((t) => t.room + '(' + t.n + ')').join(' ')}`);

const tabs = [];
for (const t of targets) {
  try {
    const tab = await openTab(9750, t.room);
    tabs.push(tab);
    console.log(`[v2] 已打开 ${t.room}`);
  } catch (e) {
    console.log(`[v2] 打开 ${t.room} 失败: ${String(e.message).slice(0, 60)}`);
  }
  await sleep(1500);
}

if (!tabs.length) {
  console.log('[v2] 无可用页面，退出');
  process.exit(1);
}

// 让页面加载完
await sleep(8000);

let captured = 0;
while (captured < MAX_CAP && Date.now() < DEADLINE) {
  for (const t of tabs) {
    if (t.captured || captured >= MAX_CAP) continue;
    try {
      t.checks++;
      const ok = await tryCapture(t);
      if (ok) { t.captured = true; captured++; }
    } catch (e) {
      console.log(`[v2] ${t.room} 检查异常: ${String(e.message).slice(0, 60)}`);
    }
  }
  if (captured >= MAX_CAP) break;
  await sleep(2000);
  if (Date.now() >= DEADLINE) break;
  // 每 5 分钟打一次心跳
  if (tabs[0].checks % 150 === 0) {
    console.log(`[v2] 心跳 checks=${tabs.map((t) => t.room + ':' + t.checks).join(' ')}`);
  }
}

// 清理
for (const t of tabs) {
  try { t.ws.close(); } catch { /* ignore */ }
  try { await req(t.port, '/json/close/' + t.tabId); } catch { /* ignore */ }
}
console.log(`[v2] 结束，共抓 ${captured} 个快照`);
