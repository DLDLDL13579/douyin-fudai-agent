#!/usr/bin/env node
/**
 * 福袋可见性双实例对照诊断。
 *
 * 用途：当某个账号长时间「candCount 全 0」，判断是
 *   (a) 采集端掉线 / 选择器失效  → 两个账号都看不到
 *   (b) 抖音按账号维度没下发福袋 → 只有一个账号看不到
 *
 * 做法：把两个 Chrome 导航到同一个房间 URL，等待渲染，然后对比福袋图标 DOM。
 * 只读诊断，不参与福袋、不修改任何状态。会短暂打断两个实例当前的常驻。
 *
 * 用法：node scripts/diagnose-fudai-visibility.mjs [房间号或完整URL]
 *       不传参数时自动取 9750 当前所在的直播间。
 */
const ROOM = process.argv[2] || null;

const PROBE = `(()=>{
  const q = (s) => document.querySelectorAll(s).length;
  const lm = document.querySelector('[class*="LMUtLyr9"]');
  const st = document.querySelector('[class*="ShortTouchContainer"]');
  return JSON.stringify({
    url: location.href,
    len: document.body.innerText.length,
    icon: q('[class*="LMUtLyr9"]'),
    iconText: lm ? (lm.innerText || '').trim() : null,
    shortTouch: q('[class*="ShortTouchContainer"]'),
    shortTouchText: st ? (st.innerText || '').slice(0, 40) : null,
    redpacketPlaceholder: q('[class="redpacket"]'),
  });
})()`;

async function conn(P) {
  const tabs = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
  const t = tabs.find((x) => x.type === 'page');
  if (!t) throw new Error(`端口 ${P} 无页面标签`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; setTimeout(() => j(new Error(`端口 ${P} WS 超时`)), 6000); });
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ws, send };
}

const evalProbe = async (c) => {
  const d = await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  return JSON.parse(d.result?.result?.value || '{}');
};

(async () => {
  const a = await conn(9750);
  let url = ROOM;
  if (!url) {
    const cur = await a.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    url = cur.result?.result?.value;
  } else if (!url.startsWith('http')) {
    url = `https://live.douyin.com/${url}`;
  }
  if (!url || url.includes('categorynew')) {
    console.log('❌ 9750 当前在分类页且未指定房间号，请用参数指定，例如：');
    console.log('   node scripts/diagnose-fudai-visibility.mjs 350971325803');
    a.ws.close();
    return;
  }
  console.log(`🔍 对照房间: ${url}`);

  const b = await conn(9751);
  await Promise.all([
    a.send('Page.navigate', { url }),
    b.send('Page.navigate', { url }),
  ]);
  await new Promise((r) => setTimeout(r, 9000));

  const [da, db] = await Promise.all([evalProbe(a), evalProbe(b)]);
  console.log(`  9750 主实例 : icon=${da.icon} 倒计时=${JSON.stringify(da.iconText)} shortTouch=${da.shortTouch} len=${da.len}`);
  console.log(`  9751 main2  : icon=${db.icon} 倒计时=${JSON.stringify(db.iconText)} shortTouch=${db.shortTouch} len=${db.len}`);

  if (da.icon > 0 && db.icon === 0) {
    console.log('  ⚠️ 结论：抖音按账号维度没给 main2 下发福袋图标。不是采集端故障，改选择器无效。');
    console.log('     排查方向：账号等级 / 粉丝团资格 / 风控降权 / 是否已被限制参与福袋。');
  } else if (da.icon === 0 && db.icon === 0) {
    console.log('  ℹ️ 结论：两个账号都看不到福袋。可能是当前确实没有福袋，或采集端集体失效，需看日志交叉验证。');
  } else if (da.icon > 0 && db.icon > 0) {
    console.log('  ✅ 结论：两个账号都能看到福袋，采集端正常。');
  } else {
    console.log('  ⚠️ 结论：只有 main2 看得到，主实例看不到。检查主实例登录态。');
  }
  a.ws.close();
  b.ws.close();
})().catch((e) => console.log('❌', e.message));
