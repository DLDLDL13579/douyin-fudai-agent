#!/usr/bin/env node
/**
 * 抖音福袋 · 账号管理
 *
 * 用法：
 *   node account-manager.mjs list                    列出所有账号
 *   node account-manager.mjs add <名字>              扫码添加新账号（会弹出 Chrome 窗口）
 *   node account-manager.mjs remove <名字>           删除账号
 *   node account-manager.mjs use <名字>              设为默认账号
 *   node account-manager.mjs status [名字]           检查登录态
 *
 * 关键约束：抖音在 headless 环境下发的二维码会被手机端判定过期，
 * 所以添加账号必须用有头 Chrome。这是唯一需要弹窗的操作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

// 🌍 跨平台：路径与 Chrome 探测统一走 paths.mjs
import { APP_ROOT, findChrome, chromeHint, isPortOpen } from './paths.mjs';
const ROOT = APP_ROOT;
const ACCOUNTS = path.join(ROOT, 'accounts');
const CHROME = (()=>{
  const f = findChrome();
  if (!f) { console.error(chromeHint()); process.exit(1); }
  return f;
})();
const BASE_PORT = 9750;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function metaPath(name) { return path.join(ACCOUNTS, name, 'meta.json'); }
function profilePath(name) { return path.join(ACCOUNTS, name, 'profile'); }

function readMeta(name) {
  try { return JSON.parse(fs.readFileSync(metaPath(name), 'utf8')); } catch { return null; }
}
function writeMeta(name, meta) {
  ensureDir(path.join(ACCOUNTS, name));
  fs.writeFileSync(metaPath(name), JSON.stringify(meta, null, 2));
}

/** 扫描已有账号目录 */
function scanAccounts() {
  if (!fs.existsSync(ACCOUNTS)) return [];
  return fs.readdirSync(ACCOUNTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const meta = readMeta(d.name) || {};
      const profile = profilePath(d.name);
      let sizeMb = 0;
      if (fs.existsSync(profile)) {
        try {
          const out = execSync(`du -sm "${profile}" 2>/dev/null`).toString();
          sizeMb = parseInt(out, 10) || 0;
        } catch { sizeMb = 0; }
      }
      return {
        name: d.name,
        displayName: meta.displayName || d.name,
        port: meta.port || null,
        enabled: meta.enabled !== false,
        lastLogin: meta.lastLogin || null,
        createdAt: meta.createdAt || null,
        hasProfile: fs.existsSync(profile),
        sizeMb,
      };
    });
}

/** 找一个空闲端口 */
function pickPort(used = []) {
  const taken = new Set(scanAccounts().map((a) => a.port).filter(Boolean));
  used.forEach((p) => taken.add(p));
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (!taken.has(p)) return p;
  }
  return BASE_PORT + 20;
}

/** 极简 CDP 客户端 */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
    };
    return c;
  }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const tm = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout ' + method)); }, timeout);
      this.pending.set(id, (m) => { clearTimeout(tm); res(m); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function waitPort(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

/** 检查某个 profile 的登录态（读 cookie 里的 sessionid） */
async function checkLogin(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const tab = await res.json();
  const cdp = await CDP.connect(tab.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.navigate', { url: 'https://live.douyin.com/' });
    await sleep(8000);
    const ck = await cdp.send('Network.getCookies', { urls: ['https://live.douyin.com', 'https://www.douyin.com'] });
    const list = ck.result?.cookies || [];
    const names = list.map((c) => c.name);
    const logged = names.includes('sessionid') && names.includes('sid_tt');
    return { logged, cookieCount: list.length, keyCookies: ['sessionid', 'sessionid_tt', 'sid_tt', 'ttwid'].filter((k) => names.includes(k)) };
  } finally {
    cdp.close();
    try { await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`); } catch {}
  }
}

/**
 * 从 /user/self 页面读取昵称与抖音号。
 *
 * 为什么需要这一步：扫码登录只能确认「有 sessionid」，但看板要显示的是
 * 「昵称 / 抖音号」这样能让人一眼认出的身份。少了它，多个账号
 * 在看板上全是 (无) (无)，根本分不清谁是谁。
 *
 * 昵称的取法踩过坑：直接拿页面第一段短文本会拿到「下载抖音精选」这种固定推广语。
 * 正确做法是从「抖音号：xxx」这一行往回找，跳过空行、纯数字、导航词，
 * 第一个剩下的才是昵称。
 */
const IDENTITY_SKIP = new Set([
  '开启读屏标签', '读屏标签已关闭', '精选', '推荐', 'AI抖音', '关注', '朋友', '我的',
  '直播', '放映厅', '短剧', '搜索', '充钻石', '客户端', '壁纸', '通知', '消息', '投稿',
  '粉丝', '获赞', '作品', '喜欢', '收藏', '观看历史', '稍后再看', '我的预约', '批量管理',
  '私密作品', '合集', '搜索你发布的作品', '日期筛选', '我公开展示的群聊', '编辑资料',
  '下载抖音精选', '抖音', '首页',
]);

async function readIdentity(cdp) {
  try {
    // Runtime.enable 必须先做，否则 Runtime.evaluate 会返回 error 而不是结果
    await cdp.send('Runtime.enable').catch(() => {});
    await cdp.send('Page.navigate', { url: 'https://www.douyin.com/user/self' });
    await sleep(6000);
    let lastUrl = '', lastLen = 0, lastErr = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(()=>{const t=(document.body?document.body.innerText:'')||'';return {url:location.href,text:t.slice(0,3000)};})()`,
        returnByValue: true,
      });
      if (r?.error) { lastErr = JSON.stringify(r.error); await sleep(2000); continue; }
      // ⚠ Runtime.evaluate 的返回是双层 result：{result:{result:{type,value}}}
      // 写成单层 r.result.value 会永远拿到 undefined，表现为「页面未渲染抖音号 url= len=0」。
      const v = r.result?.result?.value || {};
      const text = String(v.text || '');
      lastUrl = String(v.url || '');
      lastLen = text.length;
      const m = text.match(/抖音号[：:]\s*([A-Za-z0-9_.-]+)/);
      if (m) {
        const lines = text.split('\n').map((s) => s.trim());
        const idLine = lines.findIndex((s) => /^抖音号[：:]/.test(s));
        let nickname = '', nickIdx = -1;
        for (let k = idLine - 1; k >= 0 && k >= idLine - 12; k--) {
          const s = lines[k];
          if (!s) continue;
          if (/^\d+$/.test(s)) continue;
          if (IDENTITY_SKIP.has(s)) continue;
          if (s.length > 40) continue;
          nickname = s; nickIdx = k;
          break;
        }
        // 抖音把昵称里的 emoji 单独渲染成一行，innerText 就会拆成「🌈」「福袋」两行，
        // 只取到后一行会让昵称变成「福袋」。这里把紧邻的纯 emoji 行补回去。
        if (nickIdx > 0) {
          const prev = lines[nickIdx - 1];
          if (prev && prev.length <= 8 && /^[\p{Extended_Pictographic}\uFE0F\u200D]+$/u.test(prev)) {
            nickname = prev + nickname;
          }
        }
        return { nickname, douyinId: m[1] };
      }
      if (/passport|login/i.test(String(v.url))) return { nickname: '', douyinId: '', needLogin: true };
      await sleep(2500);
    }
    return { nickname: '', douyinId: '', err: `页面未渲染抖音号（url=${lastUrl} len=${lastLen}）${lastErr ? ' CDP错误:' + lastErr : ''}` };
  } catch (e) {
    return { nickname: '', douyinId: '', err: e.message };
  }
}

/** 启动 Chrome（headless 可选），返回进程 */
function launchChrome(port, profile, { headless = false } = {}) {
  ensureDir(profile);
  try { fs.rmSync(path.join(profile, 'SingletonLock'), { force: true }); } catch {}
  const args = [
    headless ? '--headless=new' : '--new-window',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // ⚠ 2026-11-05 08:04 已证实 SwiftShader 在 headless 下让 GPU 进程空转 260~377% CPU，
    //    hunter35.mjs 已改 --disable-gpu，这里同步，避免登录用的 Chrome 重蹈覆辙。
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1280,900',
    '--mute-audio',
    '--disable-blink-features=AutomationControlled',
    `--user-agent=${UA}`,
    '--lang=zh-CN',
    'about:blank',
  ];
  // 与 hunter35.mjs 同步：DSH 会话被 macOS seatbelt 限制时 Chrome 自带沙箱初始化失败
  // （sandbox initialization failed + SIGTRAP），登录/扫码用的 Chrome 同样起不来。
  // 默认带 --no-sandbox，需要强隔离时设 DY_CHROME_NO_SANDBOX=0。
  if (process.env.DY_CHROME_NO_SANDBOX !== '0') args.push('--no-sandbox');
  if (!headless) args.unshift('--window-position=200,120');
  return spawn(CHROME, args, { stdio: 'ignore', detached: false });
}

// ─────────────────────────── 命令实现 ───────────────────────────

function cmdList() {
  const accounts = scanAccounts();
  if (!accounts.length) {
    console.log('还没有任何账号。用 `node account-manager.mjs add <名字>` 扫码添加。');
    return;
  }
  const def = readMeta('_default')?.name;
  console.log('账号列表：\n');
  console.log('  名字          显示名        端口   登录     大小   最后登录');
  console.log('  ' + '-'.repeat(74));
  for (const a of accounts) {
    const login = a.lastLogin ? '✓' : '未登录';
    const size = a.sizeMb ? a.sizeMb + 'M' : '-';
    const last = a.lastLogin ? new Date(a.lastLogin).toLocaleString('zh-CN') : '-';
    const mark = def === a.name ? ' *默认' : '';
    console.log(
      '  ' + a.name.padEnd(13) + (a.displayName || '').padEnd(13).slice(0, 12) +
      ' ' + String(a.port || '-').padEnd(5) + ' ' + login.padEnd(8) + ' ' + size.padEnd(6) + ' ' + last + mark
    );
  }
  console.log('\n  *默认 = 未指定账号时使用的账号');
}

async function cmdAdd(name) {
  if (!name) { console.error('用法: node account-manager.mjs add <名字>'); process.exit(1); }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(name)) { console.error('账号名只能用中英文、数字、下划线、短横线'); process.exit(1); }
  if (fs.existsSync(path.join(ACCOUNTS, name))) { console.error(`账号「${name}」已存在`); process.exit(1); }

  const port = pickPort();
  const profile = profilePath(name);
  console.log(`\n准备添加账号「${name}」`);
  console.log(`  端口: ${port}`);
  console.log(`  profile: ${profile}\n`);
  console.log('⚠️  即将弹出 Chrome 窗口用于扫码登录。');
  console.log('    抖音在 headless 下发的二维码会被判定过期，所以必须用有头模式。\n');

  const chrome = launchChrome(port, profile, { headless: false });
  try {
    if (!(await waitPort(port))) throw new Error('Chrome 启动失败，端口未就绪');
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.navigate', { url: 'https://live.douyin.com/' });
    console.log('请在弹出的 Chrome 窗口里点右上角「登录」，用抖音 App 扫码。');
    console.log('（脚本会自动检测登录状态，成功后自动关闭窗口）\n');

    let logged = false;
    for (let i = 0; i < 120; i++) {
      await sleep(3000);
      try {
        const ck = await cdp.send('Network.getCookies', { urls: ['https://live.douyin.com', 'https://www.douyin.com'] });
        const names = (ck.result?.cookies || []).map((c) => c.name);
        if (names.includes('sessionid') && names.includes('sid_tt')) { logged = true; break; }
      } catch {}
      if (i % 10 === 0) console.log(`  等待扫码... ${i * 3}s`);
    }
    if (!logged) { cdp.close(); throw new Error('等待超时，未检测到登录态'); }

    // ⚠ 关键：关闭 Chrome 前必须把会话级 Cookie 转成持久化。
    //   sessionid / sid_tt / uid_tt 等都是「会话级」Cookie（expires=0），
    //   Chrome 一旦退出就会丢弃它们，结果是「登录成功但下次启动又变成未登录」——
    //   2026-11-03 09:43 实际踩过：脚本报「账号添加成功」，但 Cookies 库里只有 ttwid，
    //   sessionid 压根没落盘，抓取继续在未登录状态盲跑一整夜。
    try {
      const all = await cdp.send('Network.getAllCookies');
      const sess = (all.cookies || []).filter((c) => !c.expires || c.expires <= 0);
      let fixed = 0;
      for (const c of sess) {
        const ok = await cdp.send('Network.setCookie', {
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: !!c.secure, httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'Lax',
          expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        }).catch(() => null);
        if (ok) fixed++;
      }
      console.log(`  已持久化 ${fixed} 条会话级 Cookie（30 天）`);
    } catch (e) { console.log('  ⚠️ Cookie 持久化失败:', e.message); }

    // 再确认关键 Cookie 真的能读到
    try {
      const ck2 = await cdp.send('Network.getAllCookies');
      const n2 = (ck2.cookies || []).map((c) => c.name);
      const need = ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt'];
      const miss = need.filter((x) => !n2.includes(x));
      if (miss.length) console.log('  ⚠️ 仍缺:', miss.join(','));
      else console.log('  ✅ 关键 Cookie 齐全:', need.join(', '));
    } catch {}

    // 读昵称与抖音号（失败不影响登录态，只是看板上显示为 (无)）
    const ident = await readIdentity(cdp);
    if (ident.nickname || ident.douyinId) {
      console.log(`  ✅ 身份: ${ident.nickname || '(未知)'} / 抖音号 ${ident.douyinId || '(未知)'}`);
    } else {
      console.log('  ⚠️ 未能读取昵称与抖音号（不影响登录，可稍后用 refresh 重试）');
    }

    // 用 CDP 优雅关闭，确保 Cookies 落盘后再断开（kill 强杀可能丢数据）
    try { await cdp.send('Browser.close'); } catch {}
    await sleep(3000);
    cdp.close();

    writeMeta(name, {
      displayName: name,
      port,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
      nickname: ident.nickname || '',
      douyinId: ident.douyinId || '',
      loginOk: true,
    });
    console.log('\n✅ 账号添加成功，登录态已保存');
  } finally {
    // 尽量温和关闭：先 TERM 让 Chrome 自己落盘 Cookie，超时再 KILL
    try { chrome.kill('SIGTERM'); } catch {}
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      try { process.kill(chrome.pid, 0); } catch { return; }   // 已退出
    }
    try { chrome.kill('SIGKILL'); } catch {}
  }
}

function cmdRemove(name) {
  if (!name) { console.error('用法: node account-manager.mjs remove <名字>'); process.exit(1); }
  const dir = path.join(ACCOUNTS, name);
  if (!fs.existsSync(dir)) { console.error(`账号「${name}」不存在`); process.exit(1); }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`已删除账号「${name}」`);
}

function cmdUse(name) {
  if (!name) { console.error('用法: node account-manager.mjs use <名字>'); process.exit(1); }
  if (!fs.existsSync(path.join(ACCOUNTS, name))) { console.error(`账号「${name}」不存在`); process.exit(1); }
  writeMeta('_default', { name });
  console.log(`默认账号已设为「${name}」`);
}

async function cmdStatus(name) {
  const targets = name ? [name] : scanAccounts().map((a) => a.name);
  if (!targets.length) { console.log('没有账号'); return; }
  for (const n of targets) {
    const meta = readMeta(n);
    if (!meta) { console.log(`${n}: 缺少 meta.json`); continue; }
    const port = meta.port || pickPort();
    console.log(`\n检查「${n}」...`);
    const chrome = launchChrome(port, profilePath(n), { headless: true });
    try {
      if (!(await waitPort(port))) { console.log('  ❌ Chrome 启动失败'); continue; }
      const st = await checkLogin(port);
      console.log(`  登录态: ${st.logged ? '✅ 有效' : '❌ 失效'}`);
      console.log(`  cookie: ${st.cookieCount} 个，关键项 ${st.keyCookies.join(', ') || '无'}`);
      if (st.logged) {
        const m = readMeta(n) || {};
        m.lastLogin = new Date().toISOString();
        m.port = port;
        writeMeta(n, m);
      }
    } finally {
      try { chrome.kill('SIGKILL'); } catch {}
      await sleep(800);
    }
  }
}

/** 该 profile 是否正被某个 Chrome 占用（占用时不能双开，否则 profile 锁冲突） */
function profileInUse(profile) {
  // ⚠ 不能用 `ps | grep 完整路径`：ps 会把中文路径转义成 M-iM^BM^S 形式，
  //   grep 中文路径必然 0 匹配，函数永远返回 false —— 防双开保护形同虚设。
  //   改从「这个 profile 对应的调试端口是否在监听」来判断，端口是纯 ASCII，可靠。
  const name = path.basename(path.dirname(profile));
  const meta = readMeta(name) || {};
  const port = meta.port;
  if (!port) return false;
  try {
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN | grep -q LISTEN`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * 补齐/刷新账号身份（昵称 + 抖音号）。
 * 用于两类场景：①老账号当时没记录身份；②看板上显示 (无) (无) 分不清是谁。
 * 走 headless，不弹窗不抢焦点。
 */
async function cmdRefresh(target) {
  const names = target ? [target] : scanAccounts().map((a) => a.name);
  if (!names.length) { console.log('没有账号'); return; }
  for (const n of names) {
    if (!fs.existsSync(path.join(ACCOUNTS, n))) { console.log(`${n}: 账号不存在，跳过`); continue; }
    const profile = profilePath(n);
    if (!fs.existsSync(profile)) { console.log(`${n}: 没有 profile，跳过`); continue; }
    if (profileInUse(profile)) { console.log(`${n}: profile 正被占用（可能有 Chrome 在跑），跳过`); continue; }

    const meta = readMeta(n) || {};
    const port = meta.port || pickPort();
    console.log(`\n读取「${n}」身份（端口 ${port}）...`);
    const chrome = launchChrome(port, profile, { headless: true });
    try {
      if (!(await waitPort(port))) { console.log('  ❌ Chrome 启动失败'); continue; }
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      const cdp = await CDP.connect(page.webSocketDebuggerUrl);
      try {
        const ident = await readIdentity(cdp);
        if (ident.needLogin) { console.log('  ❌ 登录态已失效，需要重新扫码'); continue; }
        if (!ident.nickname && !ident.douyinId) { console.log('  ⚠️ 未读到身份' + (ident.err ? '：' + ident.err : '')); continue; }
        meta.nickname = ident.nickname || meta.nickname || '';
        meta.douyinId = ident.douyinId || meta.douyinId || '';
        meta.loginOk = true;
        meta.port = port;
        meta.lastLogin = meta.lastLogin || new Date().toISOString();
        writeMeta(n, meta);
        console.log(`  ✅ ${meta.nickname || '(未知昵称)'} / 抖音号 ${meta.douyinId || '(未知)'}`);
      } finally {
        try { await cdp.send('Browser.close'); } catch {}
        cdp.close();
      }
    } finally {
      try { chrome.kill('SIGKILL'); } catch {}
      await sleep(800);
    }
  }
}

/** 把现有 douyin-auto/chrome-profile 迁移为一个账号（保留登录态，不用重新扫码） */
function cmdImportExisting(name = 'default') {
  const src = path.join(ROOT, 'douyin-auto', 'chrome-profile');
  const dst = profilePath(name);
  if (!fs.existsSync(src)) { console.error('找不到现有 profile: ' + src); process.exit(1); }
  if (fs.existsSync(dst)) { console.error(`账号「${name}」已存在，先 remove 再导入`); process.exit(1); }

  // 确认抓取任务已停止，否则 profile 文件锁冲突
  try {
    const out = execSync("ps -eo args | grep -F 'node hunter35.mjs' | grep -v grep || true").toString().trim();
    if (out) {
      console.error('检测到抓取任务仍在运行，请先停止（否则 profile 文件锁冲突）：');
      console.error('  ' + out.split('\n')[0]);
      process.exit(1);
    }
  } catch {}

  console.log(`把 ${src}\n  导入为账号「${name}」\n  目标 ${dst}`);
  ensureDir(path.join(ACCOUNTS, name));
  execSync(`cp -a "${src}" "${dst}"`, { stdio: 'inherit' });
  writeMeta(name, {
    displayName: name,
    port: pickPort(),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastLogin: new Date().toISOString(),
    importedFrom: src,
  });
  console.log('\n✅ 导入完成，登录态原样保留。原目录未删除，确认可用后再手工清理。');
}

/**
 * 重新扫码登录已有账号（不删账号、不换端口、不丢 profile）。
 *
 * 2026-11-05 09:29 事故：main2 的 sessionid/sid_tt/uid_tt 全在、expires 到 2027 年，
 * 但服务端已判会话失效（页面显示「需先登录，才能开始聊天」、无评论框、福袋不下发）。
 * 旧自检只看 Cookie 是否存在，盲跑 5 小时；`add` 又拒绝覆盖已有账号，
 * `refresh` 只补昵称不重新登录 —— 缺一个「原地重登」入口。
 *
 * 与 cmdAdd 的区别：
 *  - 账号必须已存在，端口用 meta.port，profile 原地复用
 *  - 登录判定不只看 Cookie，还要求 /user/self 能读到抖音号
 *  - 保留 createdAt 与昵称（读不到时沿用旧值）
 */
async function cmdRelogin(name) {
  if (!name) { console.error('用法: node account-manager.mjs relogin <名字>'); process.exit(1); }
  const dir = path.join(ACCOUNTS, name);
  if (!fs.existsSync(dir)) { console.error(`账号「${name}」不存在，请先用 add 添加`); process.exit(1); }
  const meta = readMeta(name) || {};
  const port = meta.port || pickPort();
  const profile = profilePath(name);

  if (profileInUse(profile)) {
    console.error(`账号「${name}」的 profile 正被占用（Chrome 9751/9750 可能还在跑）。`);
    console.error(`请先停掉该实例：bash scripts/fudai.sh stop-acc ${name}`);
    console.error(`停止后再执行 relogin，否则两个 Chrome 抢同一份 profile。`);
    process.exit(1);
  }

  console.log(`\n准备为已有账号「${name}」重新扫码登录`);
  console.log(`  端口: ${port}（保持不变）`);
  console.log(`  profile: ${profile}（原地复用）`);
  console.log('⚠️  即将弹出 Chrome 窗口，请用抖音 App 扫码。\n');

  // 清掉已失效的会话 Cookie，避免它还留在 profile 里干扰新登录
  const chrome = launchChrome(port, profile, { headless: false });
  try {
    if (!(await waitPort(port))) throw new Error('Chrome 启动失败，端口未就绪');
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Network.enable').catch(() => {});
    await cdp.send('Network.clearBrowserCookies').catch(() => {});
    await cdp.send('Page.navigate', { url: 'https://live.douyin.com/' });
    console.log('请在弹出的 Chrome 窗口里点右上角「登录」，用抖音 App 扫码。');
    console.log('（脚本会自动验证登录态，成功后自动关闭窗口）\n');

    let logged = false;
    for (let i = 0; i < 120; i++) {
      await sleep(3000);
      try {
        const ck = await cdp.send('Network.getCookies', { urls: ['https://live.douyin.com', 'https://www.douyin.com'] });
        const names = (ck.result?.cookies || []).map((c) => c.name);
        if (names.includes('sessionid') && names.includes('sid_tt')) { logged = true; break; }
      } catch {}
      if (i % 10 === 0) console.log(`  等待扫码... ${i * 3}s`);
    }
    if (!logged) { cdp.close(); throw new Error('等待超时，未检测到登录态'); }

    // 会话级 Cookie 转持久化（Chrome 退出会丢，2026-11-03 踩过）
    try {
      const all = await cdp.send('Network.getAllCookies');
      const sess = (all.cookies || []).filter((c) => !c.expires || c.expires <= 0);
      let fixed = 0;
      for (const c of sess) {
        const ok = await cdp.send('Network.setCookie', {
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: !!c.secure, httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'Lax',
          expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        }).catch(() => null);
        if (ok) fixed++;
      }
      console.log(`  已持久化 ${fixed} 条会话级 Cookie（30 天）`);
    } catch (e) { console.log('  ⚠️ Cookie 持久化失败:', e.message); }

    // 🔴 关键：Cookie 齐全 ≠ 服务端认可。必须验证 /user/self 能读到身份。
    const ident = await readIdentity(cdp);
    if (ident.needLogin || (!ident.nickname && !ident.douyinId)) {
      cdp.close();
      throw new Error('Cookie 已写入但服务端仍判未登录（' + (ident.err || 'ident.needLogin') + '），请重新扫码');
    }
    console.log(`  ✅ 服务端已认可会话：${ident.nickname || '(未知)'} / 抖音号 ${ident.douyinId || '(未知)'}`);

    try { await cdp.send('Browser.close'); } catch {}
    await sleep(3000);
    cdp.close();

    writeMeta(name, {
      ...meta,
      displayName: meta.displayName || name,
      port,
      enabled: true,
      createdAt: meta.createdAt || new Date().toISOString(),
      lastLogin: new Date().toISOString(),
      nickname: ident.nickname || meta.nickname || '',
      douyinId: ident.douyinId || meta.douyinId || '',
      loginOk: true,
    });
    console.log('\n✅ 重新登录成功。现在可以启动该实例：');
    console.log(`   bash scripts/fudai.sh start-acc ${name} --force`);
  } finally {
    try { chrome.kill('SIGTERM'); } catch {}
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      try { process.kill(chrome.pid, 0); } catch { return; }
    }
    try { chrome.kill('SIGKILL'); } catch {}
  }
}

const [, , cmd, arg] = process.argv;
(async () => {
  switch (cmd) {
    case 'list': cmdList(); break;
    case 'add': await cmdAdd(arg); break;
    case 'relogin': await cmdRelogin(arg); break;
    case 'remove': cmdRemove(arg); break;
    case 'use': cmdUse(arg); break;
    case 'status': await cmdStatus(arg); break;
    case 'refresh': await cmdRefresh(arg); break;
    case 'import': cmdImportExisting(arg); break;
    default:
      console.log(`抖音福袋 · 账号管理

用法:
  node account-manager.mjs list              列出所有账号
  node account-manager.mjs add <名字>        扫码添加新账号（会弹出 Chrome）
  node account-manager.mjs relogin <名字>    已有账号掉线后原地重新扫码（会弹出 Chrome）
  node account-manager.mjs remove <名字>     删除账号
  node account-manager.mjs use <名字>        设为默认账号
  node account-manager.mjs status [名字]     检查登录态
  node account-manager.mjs refresh [名字]    补齐昵称与抖音号（headless，不弹窗）
  node account-manager.mjs import [名字]     把现有 profile 导入为账号（不用重新扫码）`);
  }
})().catch((e) => { console.error('错误:', e.message); process.exit(1); });
