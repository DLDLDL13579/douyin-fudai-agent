#!/usr/bin/env node
/**
 * 抖音福袋助手 · 统一入口（2026-11-04 新增，desktop 分发用）
 *
 * 用法：
 *   app                      主控模式：检查环境 → 首次引导扫码 → 启动抓取 + 看板
 *   app hunter               只跑抓取（内部用）
 *   app web                  只跑看板（内部用）
 *   app login [账号名]       扫码登录/新增账号
 *   app status               检查登录态与运行状态
 *
 * 打包成 Windows exe 后，用户双击即可；首次运行会弹出 Chrome 让用户扫码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_ROOT, PATH, findChrome, chromeHint, isPortOpen, ensureDirs, seedAsset } from './paths.mjs';

const mode = (process.argv[2] || 'main').toLowerCase();
const arg = process.argv[3] || '';

// ─────────────────────────── 工具 ───────────────────────────

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 检查登录态。
 *
 * 三重判据（2026-11-04 修复「显示已保存、却又说未登录」）：
 *   1. 我们自己的登录标记 data/login-state.json —— CDP 已确认登录时写，最可靠
 *   2. Chrome 旧版 cookie 路径 Default/Cookies
 *   3. Chrome 96+ cookie 路径 Default/Network/Cookies
 *
 * 旧实现只查 2。新电脑装的是新版 Chrome，新建 profile 时 cookie 落在 3，
 * 于是「CDP 内存里已登录」与「磁盘上找不到文件」自相矛盾：
 * 前一句来自 getAllCookies，后一句来自 loginOk()，用户就会看到那两句冲突提示。
 * 任一判据命中即视为已登录。
 */
const LOGIN_MARK = path.join(PATH.data, 'login-state.json');
function loginOk() {
  // 1) 自定义标记：CDP 已确认过 sessionid/sid_tt，且 30 天内有效
  try {
    const m = JSON.parse(fs.readFileSync(LOGIN_MARK, 'utf8'));
    if (m && m.ok && Date.now() - (m.at || 0) < 30 * 24 * 3600 * 1000) return true;
  } catch {}
  // 2/3) 两个可能的 Chrome cookie 路径（SQLite，按字节找 sessionid 即可）
  for (const rel of ['Default/Cookies', 'Default/Network/Cookies']) {
    const ck = path.join(PATH.profile, ...rel.split('/'));
    try {
      if (fs.existsSync(ck) && fs.readFileSync(ck).includes(Buffer.from('sessionid'))) return true;
    } catch {}
  }
  return false;
}

/** 用当前 exe（或 node）启动指定模式 */
function spawnMode(m, extra = []) {
  // 打包后 process.execPath 就是 exe 本身；开发时是 node，需要带上脚本路径
  const isPkg = !!process.pkg;
  const cmd = process.execPath;
  const args = isPkg ? [m, ...extra] : [process.argv[1], m, ...extra];
  const child = spawn(cmd, args, {
    cwd: APP_ROOT,
    stdio: 'inherit',
    env: { ...process.env, DY_CHILD: '1' },
    windowsHide: true,
  });
  child.on('exit', (code, sig) => {
    if (code !== 0 && code !== null) log(`[${m}] 退出，code=${code} sig=${sig || '-'}`);
  });
  return child;
}

// ─────────────────────────── 各模式 ───────────────────────────

async function cmdStatus() {
  const chrome = findChrome();
  log('════════ 抖音福袋助手 ════════');
  log(`  运行目录: ${APP_ROOT}`);
  log(`  Chrome  : ${chrome || '❌ 未找到'}`);
  log(`  登录态  : ${loginOk() ? '✅ 已登录' : '❌ 未登录'}`);
  const port = await isPortOpen(PATH.basePort);
  log(`  抓取端口: ${port ? '✅ ' + PATH.basePort : '❌ 未运行'}`);
  const web = await isPortOpen(8899);
  log(`  看板    : ${web ? '✅ http://127.0.0.1:8899' : '❌ 未启动'}`);
  log('══════════════════════════════');
}

/**
 * 扫码登录（内联实现，不依赖 account-manager.mjs，方便单文件打包）。
 *
 * 两个必须做对的地方（都是历史踩坑）：
 *   1. 必须用**有头** Chrome —— headless 下抖音发的二维码会被手机端判为过期
 *   2. 关闭前必须把会话级 Cookie 转成持久化 —— sessionid 默认 expires=0，
 *      Chrome 一退出就丢弃，表现为「扫码成功但下次启动又没登录」
 */
async function cmdLogin() {
  const chrome = findChrome();
  if (!chrome) { log('❌ ' + chromeHint()); process.exit(1); }

  const port = PATH.basePort + 5;
  const profile = PATH.profile;
  fs.mkdirSync(profile, { recursive: true });
  try { fs.rmSync(path.join(profile, 'SingletonLock'), { force: true }); } catch {}

  log('');
  log('  正在打开 Chrome 窗口…');
  log('  ┌────────────────────────────────────────┐');
  log('  │ 1. 在弹出的窗口里点右上角「登录」       │');
  log('  │ 2. 用抖音 App 扫码                      │');
  log('  │ 3. 登录成功后窗口会自动关闭              │');
  log('  └────────────────────────────────────────┘');
  log('');

  const args = [
    '--new-window', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900', '--window-position=200,120', '--mute-audio',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '--lang=zh-CN', 'about:blank',
  ];
  const proc = spawn(chrome, args, { stdio: 'ignore', detached: false });

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  let cdp = null;
  try {
    // 等 CDP 端口
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (await isPortOpen(port, 500)) { ready = true; break; }
      await sleepMs(500);
    }
    if (!ready) throw new Error('Chrome 启动失败（端口未就绪）');

    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = tabs.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let msgId = 0;
    const waiting = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { const cb = waiting.get(m.id); waiting.delete(m.id); cb(m); }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++msgId;
      const tm = setTimeout(() => { waiting.delete(id); rej(new Error('timeout ' + method)); }, 30000);
      waiting.set(id, (m) => { clearTimeout(tm); res(m); });
      ws.send(JSON.stringify({ id, method, params }));
    });
    cdp = { send, close: () => { try { ws.close(); } catch {} } };

    await send('Page.navigate', { url: 'https://live.douyin.com/' });

    // 轮询检测登录态（最多 6 分钟）
    let logged = false;
    for (let i = 0; i < 120; i++) {
      await sleepMs(3000);
      try {
        const ck = await send('Network.getCookies', { urls: ['https://live.douyin.com', 'https://www.douyin.com'] });
        const names = (ck.result?.cookies || []).map((c) => c.name);
        if (names.includes('sessionid') && names.includes('sid_tt')) { logged = true; break; }
      } catch {}
      if (i % 10 === 9) log(`  等待扫码… ${(i + 1) * 3}s`);
    }
    if (!logged) throw new Error('等待超时，未检测到登录');

    log('  ✅ 检测到登录，正在保存登录态…');

    // 关键：会话级 Cookie 转持久化（30 天）
    try {
      const all = await send('Network.getAllCookies');
      const sess = (all.result?.cookies || []).filter((c) => !c.expires || c.expires <= 0);
      let fixed = 0;
      for (const c of sess) {
        await send('Network.setCookie', {
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'Lax',
          expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        }).catch(() => null);
        fixed++;
      }
      log(`  已持久化 ${fixed} 条会话 Cookie（30 天）`);
    } catch {}

    // 再确认一次：CDP 内存里 cookie 齐全就写我们自己的标记。
    // 不能依赖「磁盘 Cookies 文件里有 sessionid」来判定——新版 Chrome 把 cookie
    // 放在 Default/Network/Cookies，且 Chrome 进程还开着时 SQLite 可能尚未刷盘。
    const ck2 = await send('Network.getAllCookies');
    const n2 = (ck2.result?.cookies || []).map((c) => c.name);
    const need = ['sessionid', 'sid_tt', 'uid_tt'];
    const miss = need.filter((x) => !n2.includes(x));
    if (miss.length) {
      log('  ⚠️ 仍缺: ' + miss.join(',') + '（登录可能未完全生效）');
    } else {
      try {
        fs.mkdirSync(path.dirname(LOGIN_MARK), { recursive: true });
        fs.writeFileSync(LOGIN_MARK, JSON.stringify({ ok: true, at: Date.now(), cookies: need }));
      } catch {}
      log('  ✅ 登录态已保存');
    }

    // 优雅关闭（保证 Cookie 落盘）
    try { await send('Browser.close'); } catch {}
    await sleepMs(2500);
  } catch (e) {
    log('  ❌ 登录失败: ' + e.message);
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch {}
    await sleepMs(800);
  }
}

async function cmdMain() {
  log('');
  log('  ╔═══════════════════════════════════╗');
  log('  ║      抖音福袋助手  v1.0           ║');
  log('  ╚═══════════════════════════════════╝');
  log('');

  // 1. 环境检查
  const chrome = findChrome();
  if (!chrome) {
    log('❌ ' + chromeHint());
    log('   装好 Chrome 后重新双击本程序即可。');
    await sleep(6000);
    process.exit(1);
  }
  log(`✅ Chrome: ${chrome}`);
  ensureDirs();

  // 首次运行：把内置的学习档案 / 配置种子写到磁盘
  // （打包后这些在只读快照里，程序运行时要能写，所以必须先落盘）
  const seeded = [];
  for (const rel of [
    'data/anchors.json',
    'data/pinned-hosts.json',
    'data/threshold.json',
    'scripts/known-fudai-hosts.txt',
    'scripts/blacklist-rooms.txt',
  ]) {
    try { if (seedAsset(rel)) seeded.push(rel); } catch {}
  }
  if (seeded.length) log(`   已初始化内置数据: ${seeded.length} 项`);

  // 2. 登录态
  if (!loginOk()) {
    log('');
    log('⚠️  还没有登录抖音账号，正在打开扫码窗口…');
    log('   （登录成功后窗口会自动关闭，然后继续启动）');
    log('');
    await cmdLogin();
    if (!loginOk()) {
      log('❌ 仍未检测到登录态，请重新运行本程序再试。');
      await sleep(5000);
      process.exit(1);
    }
  }
  log('✅ 登录态正常');

  // 3. 启动抓取与看板
  log('');
  log('🚀 正在启动…（关闭本窗口即停止运行）');
  const hunter = spawnMode('hunter');
  const web = spawnMode('web');

  // 4. 5 秒后打印看板地址
  await sleep(5000);
  const ok = await isPortOpen(8899);
  log('');
  log('  ┌──────────────────────────────────────┐');
  log(`  │ 看板地址: http://127.0.0.1:8899      │`);
  log(`  │ 状态    : ${ok ? '已就绪，可在浏览器打开' : '启动中，稍后刷新…'}        │`);
  log('  └──────────────────────────────────────┘');
  log('');
  log('  提示：本窗口不要关闭，关闭后即停止抢福袋。');
  log('');

  // 5. 任一子进程退出就整体退出，避免半死不活
  const cleanup = () => {
    try { hunter.kill(); } catch {}
    try { web.kill(); } catch {}
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  hunter.on('exit', () => { log('抓取进程退出，整体停止'); cleanup(); process.exit(1); });
  web.on('exit', () => { log('看板进程退出，整体停止'); cleanup(); process.exit(1); });
}

// ─────────────────────────── 分发 ───────────────────────────

(async () => {
  try {
    switch (mode) {
      case 'main': await cmdMain(); break;
      case 'status': await cmdStatus(); break;
      case 'login': await cmdLogin(); break;
      case 'hunter': await import('./hunter35.mjs'); break;
      case 'web': await import('../web/server.mjs'); break;
      default:
        log('用法: app [main|status|login|hunter|web]');
    }
  } catch (e) {
    console.error('❌ 启动失败:', e.message);
    await sleep(5000);
    process.exit(1);
  }
})();
