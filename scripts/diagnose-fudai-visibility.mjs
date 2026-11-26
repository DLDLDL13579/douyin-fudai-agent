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
 * 用法：node scripts/diagnose-fudai-visibility.mjs [房间号或完整URL] [第二端口]
 *       不传房间号时自动取主实例当前所在的直播间。
 *
 * 🔴 2026-11-26 更新：main2(9751) 已于 11-06 删除、main3(9752) 已取消，当前是单实例。
 *    旧版硬编码连 9751 会直接报「端口 9751 无页面标签」，功能完全失效。
 *    现改为：第二端口默认 9752（若在跑），都不在则自动降级为「单实例基线诊断」，
 *    仍然输出主号的 icon/shortTouch/len 供判断「采集端有没有视力」。
 */
const ROOM = process.argv[2] || null;
const PORT_B = process.argv[3] ? Number(process.argv[3]) : 9752;

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

  // 🔴 2026-11-26：第二端口可能不存在（单实例），先探测再决定是否双实例对照
  let b = null;
  try {
    const ver = await fetch(`http://127.0.0.1:${PORT_B}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (ver.ok) b = await conn(PORT_B);
  } catch { /* 端口不存活 → 降级单实例 */ }

  if (!b) {
    // 单实例基线诊断：只导航主号，输出它的 DOM 证据，判断「采集端有没有视力」
    await a.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 9000));
    const da = await evalProbe(a);
    console.log(`  9750 主实例 : icon=${da.icon} 倒计时=${JSON.stringify(da.iconText)} shortTouch=${da.shortTouch} len=${da.len}`);
    if (da.icon > 0) console.log('  ✅ 主号能看到福袋图标，采集端正常；当前单实例，无第二账号可对照。');
    else console.log('  ℹ️ 主号当前看不到福袋图标：可能确实没发袋，或需核对登录态/页面是否加载完成。');
    a.ws.close();
    return;
  }

  await Promise.all([
    a.send('Page.navigate', { url }),
    b.send('Page.navigate', { url }),
  ]);
  await new Promise((r) => setTimeout(r, 9000));

  const [da, db] = await Promise.all([evalProbe(a), evalProbe(b)]);
  console.log(`  9750 主实例 : icon=${da.icon} 倒计时=${JSON.stringify(da.iconText)} shortTouch=${da.shortTouch} len=${da.len}`);
  console.log(`  ${PORT_B} 对照实例: icon=${db.icon} 倒计时=${JSON.stringify(db.iconText)} shortTouch=${db.shortTouch} len=${db.len}`);

  if (da.icon > 0 && db.icon === 0) {
    console.log(`  ⚠️ 结论：抖音按账号维度没给 ${PORT_B} 下发福袋图标。不是采集端故障，改选择器无效。`);
    console.log('     排查方向：账号等级 / 粉丝团资格 / 风控降权 / 是否已被限制参与福袋。');
  } else if (da.icon === 0 && db.icon === 0) {
    console.log('  ℹ️ 结论：两个账号都看不到福袋。可能是当前确实没有福袋，或采集端集体失效，需看日志交叉验证。');
  } else if (da.icon > 0 && db.icon > 0) {
    console.log('  ✅ 结论：两个账号都能看到福袋，采集端正常。');
  } else {
    console.log(`  ⚠️ 结论：只有 ${PORT_B} 看得到，主实例看不到。检查主实例登录态。`);
  }
  a.ws.close();
  b.ws.close();
})().catch((e) => console.log('❌', e.message));
