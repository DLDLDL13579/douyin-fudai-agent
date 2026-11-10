#!/usr/bin/env node
/**
 * 刷新本地关注名单缓存（2026-11-11 07:16）
 *
 * 背景：hunter35 的 fans-panel 校验会读 data/following-cache.json，
 * 但该文件原先只在手工跑一次，实测 5 小时后主号关注数已从 181 涨到 190，
 * 新增的 9 个关注没进缓存，导致「uid 拿不到 + 本地名单未命中」时误拦。
 *
 * 本脚本从两个实例的 /user/self 拉取最新关注列表并覆盖缓存。
 * 由 health-guard 每 6 小时调用一次（关注变化不频繁，不需要更密）。
 *
 * 用法：node scripts/refresh-following.mjs [--dry]
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'following-cache.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRY = process.argv.includes('--dry');

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

const ACCOUNTS = [['main', 9750], ['main3', 9752]];
const out = {};
let any = false;

for (const [acc, port] of ACCOUNTS) {
  try {
    const t = JSON.parse(await req(port, '/json/new?about:blank', 'PUT'));
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    let id = 0;
    const q = new Map();
    ws.addEventListener('message', (e) => {
      const d = JSON.parse(e.data);
      if (d.id && q.has(d.id)) { q.get(d.id)(d); q.delete(d.id); }
    });
    const send = (m, a) => new Promise((r) => {
      const k = ++id; q.set(k, r);
      ws.send(JSON.stringify({ id: k, method: m, params: a }));
    });
    const ev = async (expression, to = 30000) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, to);
      return r?.result?.result?.value;
    };

    await send('Page.navigate', { url: 'https://www.douyin.com/user/self' });
    await sleep(8000);
    const r = await ev(`(async()=>{try{
      var j=JSON.parse(await (await fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&_t='+Date.now(),{credentials:'include',cache:'no-store'})).text());
      var u=j.user||{};
      if(!u.uid) return JSON.stringify({err:'no-uid'});
      var all=[],off=0,more=true,p=0;
      while(more&&p<15){
        var k=JSON.parse(await (await fetch('/aweme/v1/web/user/following/list/?user_id='+u.uid+'&sec_user_id='+u.sec_uid+'&count=20&offset='+off+'&aid=6383&device_platform=webapp&_t='+Date.now(),{credentials:'include',cache:'no-store'})).text());
        var arr=k.followings||[];
        all=all.concat(arr.map(function(x){return {uid:String(x.uid),name:String(x.nickname||'')}}));
        more=!!k.has_more; off+=20; p++; if(!arr.length)break;
      }
      return JSON.stringify({nick:u.nickname,count:u.following_count,list:all});
    }catch(e){return JSON.stringify({err:String(e.message).slice(0,80)})}})()`, 40000);
    const d = JSON.parse(r || '{}');
    if (Array.isArray(d.list)) {
      out[acc] = { nick: d.nick, count: d.count, at: new Date().toISOString(), list: d.list };
      console.log(`  ${acc}: ${d.count} 人，拉到 ${d.list.length}`);
      any = true;
    } else {
      console.log(`  ${acc}: 失败 ${d.err || '未知'}`);
    }
    ws.close();
    await req(port, '/json/close/' + t.id).catch(() => {});
  } catch (e) {
    console.log(`  ${acc}: 异常 ${String(e.message).slice(0, 60)}`);
  }
}

if (!any) { console.log('  无任何账号成功，保留旧缓存'); process.exit(1); }
if (DRY) { console.log('  [dry] 不写文件'); process.exit(0); }

// 与旧缓存合并：某个账号失败时保留它上次的数据
let old = {};
try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}; } catch { /* ignore */ }
const merged = { ...old, ...out };
fs.writeFileSync(OUT, JSON.stringify(merged, null, 1));
console.log(`  已写入 ${OUT}`);
