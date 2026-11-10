#!/usr/bin/env node
/**
 * cond1 面板猎手（2026-11-10 16:35 用户选「先抓到真实面板快照再修」）
 *
 * 背景：今日 41 次 no-panel 全部是 `panel@图标中心:fans0/cond1` —— 面板有「参与条件」
 * 但没有「加入粉丝团」，之后 12 个参与按钮候选全落空。这个面板的真实按钮文案未知，
 * 盲扩候选词是浪费时间的做法，必须先抓到一次真实 DOM。
 *
 * 做法：
 *   ① 轮询两号日志，发现新的 「★★ 福袋」 行就立刻打开该房间
 *   ② 等页面稳定 → 移除静音遮罩 → 点福袋图标
 *   ③ 抓完整快照：所有可见按钮、面板文本、iframe 内文本、DOM 结构
 *   ④ 写入 data/cond1-captures/<时间>-<房间>.json 并截图
 *
 * 用法：node scripts/hunt-cond1.mjs [最多抓几个，默认3]
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'cond1-captures');
fs.mkdirSync(OUT, { recursive: true });

const MAX = Number(process.argv[2] || 3);
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

/** 从两个账号日志里读最近出现过的福袋房间 */
function recentFudaiRooms() {
  const out = [];
  for (const [port, logf] of [
    [9750, 'accounts/main/work/h35.log'],
    [9752, 'accounts/main3/work/h35.log'],
  ]) {
    let txt = '';
    try {
      txt = fs.readFileSync(path.join(ROOT, logf), 'utf8');
    } catch {
      continue;
    }
    const lines = txt.split('\n');
    let s = -1;
    for (let i = 0; i < lines.length; i++) if (/=== hunter35/.test(lines[i])) s = i;
    for (const l of lines.slice(s)) {
      const m = l.match(/★★ 福袋.*?\(([0-9a-z_]{6,})\)/);
      if (m) out.push({ port, room: m[1], line: l.trim().slice(0, 160) });
    }
  }
  return out;
}

async function capture(port, room) {
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
    if (d.id && q.has(d.id)) {
      q.get(d.id)(d);
      q.delete(d.id);
    }
  });
  const send = (m, a) =>
    new Promise((r) => {
      const k = ++id;
      q.set(k, r);
      ws.send(JSON.stringify({ id: k, method: m, params: a }));
    });
  const ev = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    return r?.result?.result?.value;
  };

  try {
    await send('Page.enable');
    await send('DOM.enable');
    await send('Page.navigate', { url: 'https://live.douyin.com/' + room });

    // 等页面稳定
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const len = await ev('(document.body.innerText||"").length');
      if (len > 300) break;
    }

    const hasIcon = await ev(`document.querySelectorAll('[class*="LMUtLyr9"]').length`);
    if (!hasIcon) return { ok: false, reason: 'no-icon' };

    // 移除静音遮罩（否则会盖住面板按钮，15:29 已证实）
    await ev(`(()=>{let n=0;document.querySelectorAll('[class*="Wn6sF12t"],[class*="fBv9dwfC"],[class*="RntNeJeO"]').forEach(function(el){var t=(el.innerText||'');if(t.length<80&&/浏览器限制静音|点击打开声音|按 P 或/.test(t)){el.remove();n++}});return n})()`);
    await sleep(400);

    const pos = JSON.parse(
      await ev(`(()=>{var e=document.querySelector('[class*="LMUtLyr9"]');var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`)
    );
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type,
        x: pos.x,
        y: pos.y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      });
    }
    await sleep(4000);

    // 完整快照
    const snap = await ev(`(()=>{
      const out = {url: location.href, title: document.title, bodyLen: 0};
      const b = document.body.innerText || '';
      out.bodyLen = b.length;
      out.bodyFull = b.slice(0, 3000);
      // 所有按钮（含伪装成 div 的）
      out.buttons = [];
      for (const el of document.querySelectorAll('button,div[role="button"],span,a')){
        const t = (el.innerText||'').trim();
        if (!t || t.length > 40) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 14) continue;
        out.buttons.push({tag: el.tagName, text: t.slice(0,40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cls: String(el.className).slice(0,50)});
      }
      out.buttons = out.buttons.slice(0, 40);
      // 面板容器（居中区域）
      out.center = [];
      for (const el of document.querySelectorAll('div')){
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 120) continue;
        const cx = r.x + r.width/2;
        if (cx < innerWidth*0.25 || cx > innerWidth*0.75) continue;
        if (r.y < 30 || r.y + r.height > innerHeight - 20) continue;
        const t = (el.innerText||'').trim();
        if (!t) continue;
        out.center.push({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),text:t.slice(0,300),cls:String(el.className).slice(0,50)});
      }
      out.center = out.center.slice(0, 6);
      // iframe 内文本（人气红包/某些面板在 iframe）
      out.iframes = [];
      for (const f of document.querySelectorAll('iframe')){
        try{
          const d = f.contentDocument;
          if (d && d.body) out.iframes.push((d.body.innerText||'').slice(0,500));
        }catch(e){ out.iframes.push('[cross-origin]'); }
      }
      // 关键词命中共计
      out.keywords = {};
      for (const k of ['参与条件','加入粉丝团','点亮粉丝团','一键发评论参与福袋','参与福袋','立即参与','点击参与','福袋','粉丝团','关注']){
        out.keywords[k] = b.includes(k);
      }
      return JSON.stringify(out);
    })()`);

    // 截图
    let pngB64 = null;
    try {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      pngB64 = shot?.result?.data || null;
    } catch { /* ignore */ }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(OUT, `${stamp}-${room}`);
    fs.writeFileSync(base + '.json', snap || '{}');
    if (pngB64) fs.writeFileSync(base + '.png', Buffer.from(pngB64, 'base64'));

    // 命中检测：如果面板里没有 cond 也可能是另一种形态
    let parsed = {};
    try { parsed = JSON.parse(snap || '{}'); } catch { /* ignore */ }
    return { ok: true, base, kw: parsed.keywords, btnCount: (parsed.buttons || []).length };
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { await req(port, '/json/close/' + t.id); } catch { /* ignore */ }
  }
}

const done = new Set();
let got = 0;
console.log(`[hunt] 启动，目标 ${MAX} 个 cond1 面板快照`);

while (got < MAX) {
  const rooms = recentFudaiRooms().filter((r) => !done.has(r.room));
  if (!rooms.length) {
    await sleep(10000);
    continue;
  }
  for (const r of rooms) {
    if (got >= MAX) break;
    done.add(r.room);
    console.log(`[hunt] 尝试 ${r.room} (port ${r.port})`);
    try {
      const res = await capture(r.port, r.room);
      if (res.ok) {
        got++;
        console.log(`[hunt] ✅ 已保存 ${res.base}`);
        console.log(`[hunt]    按钮 ${res.btnCount} 个，关键词 ${JSON.stringify(res.kw)}`);
      } else {
        console.log(`[hunt] 跳过 ${r.room}: ${res.reason}`);
      }
    } catch (e) {
      console.log(`[hunt] 失败 ${r.room}: ${String(e.message).slice(0, 80)}`);
    }
    await sleep(1500);
  }
  await sleep(8000);
}
console.log(`[hunt] 完成，共 ${got} 个快照，目录 ${OUT}`);
