#!/usr/bin/env node
/**
 * 刷新本地关注名单缓存（2026-11-11 07:16 创建，17:25 全量翻页改造）
 *
 * 背景：hunter35 的 fans-panel 校验会读 data/following-cache.json。
 * 该文件原先只能拿到关注列表第一页 20 个（实测 /aweme/v1/web/user/following/list/
 * 的 offset / min_time / count 全被服务端忽略），而账号实际关注 206 人，
 * 导致「已关注主播」查不到 → 被误判 need-follow。全天 44 条误判皆源于此。
 *
 * 🔑 2026-11-11 17:22 决定性发现：max_time 是真游标。
 *    把「上一页返回的 max_time」作为下一页参数，每页首条都不同，
 *    186 页 / 74.2 秒实测拉到 206/206 = 100% 覆盖。
 *
 * 两种模式：
 *   --full  链式翻页拉全（约 75-95 秒），供 health-guard 每小时跑一次
 *   无参数  只拉第一页 20 个（约 10 秒），供 20 分钟级捕获刚关注的新主播
 *   --dry   只打印不写文件
 *
 * hunter35 侧只读缓存、零改动、零额外请求。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'following-cache.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRY = process.argv.includes('--dry');
const FULL = process.argv.includes('--full');

// 全量约 75-95 秒，加硬看门狗：CDP 万一挂死也不至于把 health-guard 永久卡住。
const _wd = setTimeout(() => { console.error('  ⏰ refresh-following 超时，强制退出'); process.exit(2); }, FULL ? 150000 : 60000);
if (typeof _wd.unref === 'function') _wd.unref();

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
    // 🔴 2026-11-11 18:27 修 hang：原 send() 的 Promise 在 ws 断开/错误时
    //    永不 resolve，若连续手动跑撞上主实例 VIP 探测导航导致连接被关，
    //    整个脚本会 unsettled top-level await 静默退出、不写缓存，
    //    而 health-guard 是同步阻塞调用，会把守护两个节拍一起卡住。
    //    改法：每个 send 带超时兜底 resolve；close/error 清空所有 pending。
    const settleAll = () => {
      for (const [, resolve] of q) resolve(null);
      q.clear();
    };
    ws.addEventListener('close', settleAll);
    ws.addEventListener('error', settleAll);
    const send = (m, a) => new Promise((r) => {
      const k = ++id;
      let done = false;
      const finish = (v) => { if (done) return; done = true; clearTimeout(tm); q.delete(k); r(v); };
      const tm = setTimeout(() => finish(null), 150000);
      q.set(k, finish);
      try { ws.send(JSON.stringify({ id: k, method: m, params: a })); }
      catch (_) { finish(null); }
    });
    // ⚠ timeout 必须放进 CDP params。原实现把它当 send 的第三个参数，
    //   而 send 只接 (m,a)，超时其实从未生效；全量翻页需要 120 秒。
    const ev = async (expression, timeoutMs = 40000) => {
      const r = await send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs });
      if (!r) throw new Error('CDP 无响应（连接断开或超时）');
      return r?.result?.result?.value;
    };

    await send('Page.navigate', { url: 'https://www.douyin.com/user/self' });
    await sleep(8000);
    const r = await ev(`(async()=>{
      const FULL=${FULL ? 'true' : 'false'}, MAX_PAGES=${FULL ? 400 : 1}, HARD_STOP_MS=${FULL ? 95000 : 8000};
      const t0=Date.now();
      try{
        var j=JSON.parse(await (await fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&_t='+Date.now(),{credentials:'include',cache:'no-store'})).text());
        var u=j.user||{};
        if(!u.uid) return JSON.stringify({err:'no-uid'});
        // 🔑 max_time 链式翻页：offset/min_time/count 实测都被服务端忽略，
        //    只有用「上一页返回的 max_time」当下一页参数，才会返回不同的一批人。
        var base='/aweme/v1/web/user/following/list/?user_id='+u.uid+'&sec_user_id='+u.sec_uid+'&count=20&aid=6383&device_platform=webapp';
        var byUid=new Map(), cursor='', pages=0, stall=0, lastSize=0;
        for(;pages<MAX_PAGES;pages++){
          var k=JSON.parse(await (await fetch(base+(cursor?'&max_time='+cursor:'')+'&_t='+Date.now(),{credentials:'include',cache:'no-store'})).text());
          var arr=k.followings||[];
          arr.forEach(function(x){ if(x&&x.uid) byUid.set(String(x.uid),{uid:String(x.uid),name:String(x.nickname||'')}); });
          if(!FULL) break;
          var next=k.max_time;
          if(!k.has_more||!next||String(next)===String(cursor)) break;
          if(byUid.size===lastSize){ stall++; if(stall>=12) break; } else stall=0;
          lastSize=byUid.size; cursor=next;
          if(byUid.size>=Number(u.following_count||0)) break;
          if(Date.now()-t0>HARD_STOP_MS) break;
        }
        var all=[...byUid.values()];
        return JSON.stringify({nick:u.nickname,count:u.following_count,list:all,
          pages:pages,ms:Date.now()-t0,full:FULL,
          apiLimited: all.length < (Number(u.following_count||0)-5)});
      }catch(e){return JSON.stringify({err:String(e.message).slice(0,80)})}
    })()`, FULL ? 120000 : 40000);
    const d = JSON.parse(r || '{}');
    if (Array.isArray(d.list)) {
      out[acc] = {
        nick: d.nick, count: d.count, at: new Date().toISOString(), list: d.list,
        full: !!d.full, pages: d.pages, ms: d.ms, apiLimited: !!d.apiLimited,
      };
      console.log(`  ${acc}: ${d.count} 人，拉到 ${d.list.length}` +
        (d.full ? `（全量 ${d.pages} 页 / ${(d.ms / 1000).toFixed(1)}s）` : ''));
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

// 累积合并：新旧按 uid 并集，绝不覆盖掉历史（含已取关但福袋仍可抢的房间）。
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
  const finalList = [...byUid.values()];
  const finalCount = Number(v.count) || finalList.length;
  // 🔴 2026-11-11 18:25 修自己引入的元数据回归：
  //    20 分钟快刷只拉 20 个，会把「上次 --full 拉到 206/206」的 full/apiLimited/pages
  //    覆盖成 false/true/0，让未来排查误判「缓存只有 20 个、被 API 限制」。
  //    hunter 只读 list（功能不受影响），但元数据会误导人，属「看不见和没有表现一样」的坑。
  //    改法：full 如实反映本次模式；新增 lastFull* 记录上次全量证据，快刷不清空；
  //    apiLimited 改按最终缓存人数重算，而不是看本次拉了多少。
  merged[acc] = {
    nick: v.nick,
    count: v.count,
    at: v.at,
    apiLimited: finalList.length < (finalCount - 5),
    full: !!v.full,
    pages: v.pages,
    ms: v.ms,
    lastFullAt: (v.full === true) ? v.at : (prev.lastFullAt || null),
    lastFullPages: (v.full === true) ? v.pages : (prev.lastFullPages ?? null),
    lastFullMs: (v.full === true) ? v.ms : (prev.lastFullMs ?? null),
    lastFullCount: (v.full === true) ? finalList.length : (prev.lastFullCount ?? null),
    list: finalList,
  };
  const uniq = new Set(merged[acc].list.map((x) => String(x.name || '').trim()).filter(Boolean));
  console.log(`  ${acc}: 本次拉到 ${v.list.length}，累积 ${merged[acc].list.length}（去重 ${uniq.size} 个昵称，新增 ${added}）` +
    (merged[acc].lastFullAt ? ` | 上次全量 ${merged[acc].lastFullCount} 人 @ ${merged[acc].lastFullAt}` : ''));
}
fs.writeFileSync(OUT, JSON.stringify(merged, null, 1));
console.log(`  已写入 ${OUT}`);
