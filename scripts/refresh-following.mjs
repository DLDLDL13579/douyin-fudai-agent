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
      // 🔴 2026-11-11 08:19 重大发现：抖音关注列表接口有硬限制，
      //    offset 被忽略（0/20/40 返回同一页）、min_time 游标失效、
      //    count 被忽略（20/50/100/200 都只返回 20 条）。
      //    实测账号有 195 个关注，但无论怎么翻页都只能拿到第一页 20 个。
      //    所以这里只拉一次（20 条），靠 refresh-following.mjs 的累积合并
      //    保留历史数据，避免越刷越少。
      //    关键洞察：被 fans-panel 拦截的主播往往就在最新 20 个里
      //    （最近关注的排在最前），所以这 20 条的实际价值最高。
      var k=JSON.parse(await (await fetch('/aweme/v1/web/user/following/list/?user_id='+u.uid+'&sec_user_id='+u.sec_uid+'&count=20&aid=6383&device_platform=webapp&_t='+Date.now(),{credentials:'include',cache:'no-store'})).text());
      var arr=k.followings||[];
      var all=arr.map(function(x){return {uid:String(x.uid),name:String(x.nickname||'')}});
      return JSON.stringify({nick:u.nickname,count:u.following_count,list:all,apiLimited:all.length<((u.following_count||0)-5)});
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

// 🔴 累积合并：API 只能拿到最新 20 个，但历史关注的仍有效，
//    所以把新拿到的并进旧集合，绝不覆盖掉历史。
let old = {};
try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}; } catch { /* ignore */ }
const merged = { ...old };
for (const [acc, v] of Object.entries(out)) {
  const prev = old[acc] || {};
  const prevList = Array.isArray(prev.list) ? prev.list : [];
  const byUid = new Map();
  for (const x of prevList) if (x && x.uid) byUid.set(String(x.uid), x);
  let added = 0;
  for (const x of v.list) {
    if (!x || !x.uid) continue;
    if (!byUid.has(String(x.uid))) added++;
    byUid.set(String(x.uid), x);
  }
  merged[acc] = {
    nick: v.nick,
    count: v.count,
    at: v.at,
    apiLimited: !!v.apiLimited,
    list: [...byUid.values()],
  };
  const uniq = new Set(merged[acc].list.map((x) => String(x.name || '').trim()).filter(Boolean));
  console.log(`  ${acc}: 本次拉到 ${v.list.length}，累积 ${merged[acc].list.length}（去重 ${uniq.size} 个昵称，新增 ${added}）`);
}
fs.writeFileSync(OUT, JSON.stringify(merged, null, 1));
console.log(`  已写入 ${OUT}`);
