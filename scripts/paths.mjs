#!/usr/bin/env node
/**
 * 跨平台路径与环境适配层（2026-11-04 新增，为打包 exe 做准备）
 *
 * 背景：项目原本把 macOS 绝对路径写死在代码里（共 218 处），
 * Chrome 路径也是 `/Applications/Google Chrome.app/...`。
 * 要打包成 Windows exe 分发给别人用，这些必须全部收敛到这里。
 *
 * 设计原则：
 *   1. 应用根目录 = 打包后 exe 所在目录 / 开发时项目根
 *   2. 可写数据（profile、日志、状态）放应用根下的 data/ 与 douyin-auto/
 *   3. Chrome 自动探测常见安装位置，找不到给出明确提示
 *   4. 平台差异（进程/端口查询）用 Node 原生 API 实现，不依赖 lsof/pkill
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 应用根目录。
 * - 打包后（pkg / SEA）：process.pkg 存在 → exe 所在目录
 * - 开发环境：本文件在 scripts/ 下 → 上一级即项目根
 */
export const APP_ROOT = (() => {
  if (process.pkg) return path.dirname(process.execPath);
  try {
    // ⚠ 必须用 fileURLToPath：new URL(...).pathname 会把中文路径编码成
    //   %E9%82%93%E6%9E%97 这种百分号形式，导致后续所有路径拼接全部失效。
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..');
  } catch {
    return process.cwd();
  }
})();

/**
 * 代码快照根目录（只读）。
 * - 开发环境：等同 APP_ROOT
 * - pkg 打包后：指向 exe 内嵌的虚拟文件系统，可以读到 assets 但不能写
 * 用途：首次运行时把内置的初始数据（如学习档案种子）复制到可写目录。
 */
export const SNAPSHOT_ROOT = (() => {
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return APP_ROOT; }
})();

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

/** 可写目录：都放在应用根下，方便整个文件夹拷贝迁移 */
export const PATH = {
  root: APP_ROOT,
  data: path.join(APP_ROOT, 'data'),
  work: path.join(APP_ROOT, 'douyin-auto'),
  accounts: path.join(APP_ROOT, 'accounts'),
  scripts: path.join(APP_ROOT, 'scripts'),
  web: path.join(APP_ROOT, 'web'),
  profile: path.join(APP_ROOT, 'douyin-auto', 'chrome-profile'),
  log: path.join(APP_ROOT, 'douyin-auto', 'h35.log'),
  results: path.join(APP_ROOT, 'douyin-auto', 'h35-results.jsonl'),
  basePort: Number(process.env.DY_PORT || 9750),
};

/** 确保所有运行目录存在 */
export function ensureDirs() {
  for (const d of [PATH.data, PATH.work, PATH.accounts]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}

/**
 * 探测 Chrome 可执行文件。
 * 优先 Chrome，其次 Edge（同为 Chromium 内核，CDP 协议一致，可作为兜底）。
 * 返回 null 表示没找到，调用方应提示用户安装。
 */
export function findChrome() {
  const cands = [];

  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    cands.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Edge 兜底
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (IS_MAC) {
    cands.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    cands.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    );
  }

  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

/** 找不到 Chrome 时的提示文案 */
export function chromeHint() {
  if (IS_WIN) return '未找到 Chrome。请先安装 Google Chrome（https://www.google.com/chrome/）后重试。';
  if (IS_MAC) return '未找到 Chrome。请先安装 Google Chrome 后重试。';
  return '未找到 Chrome/Chromium。请安装后重试。';
}

/**
 * 检测本地端口是否在监听。
 * 替代 macOS 的 `lsof -iTCP:PORT`，Windows 上同样可用。
 */
export function isPortOpen(port, timeout = 700) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, '127.0.0.1'); } catch { finish(false); }
  });
}

/**
 * 结束进程（跨平台）。force=true 强杀。
 * 替代 `pkill -9 -f xxx`。
 */
export function killPid(pid, force = true) {
  if (!pid) return false;
  try {
    if (IS_WIN) {
      // Windows 用 taskkill，/T 连子进程一起杀（Chrome 会有多个子进程）
      execSync(`taskkill ${force ? '/F' : ''} /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
    return true;
  } catch { return false; }
}

/**
 * 首次运行时把内置的初始数据复制到可写目录。
 *
 * 为什么需要：pkg 打包后，代码与 assets 都在一个只读快照里，
 * 而程序要往 data/anchors.json 这类文件里写学习结果。
 * 所以内置数据只能作为「种子」，运行前必须先落盘。
 *
 * @param {string} relPath 相对应用根的路径，如 'data/anchors.json'
 * @returns {boolean} 是否执行了复制
 */
export function seedAsset(relPath) {
  const target = path.join(APP_ROOT, relPath);
  if (fs.existsSync(target)) return false;           // 已有磁盘文件，不覆盖
  // 依次尝试：快照根 / 应用根
  const cands = [
    path.join(SNAPSHOT_ROOT, '..', relPath),
    path.join(SNAPSHOT_ROOT, relPath),
    path.join(APP_ROOT, relPath),
  ];
  for (const src of cands) {
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target);
        return true;
      }
    } catch {}
  }
  return false;
}

/** 读取 JSON 文件，失败返回默认值 */
export function readJson(file, def = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}

/** 写 JSON 文件（自动建目录） */
export function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
    return true;
  } catch { return false; }
}

export default { APP_ROOT, SNAPSHOT_ROOT, PATH, IS_WIN, IS_MAC, findChrome, chromeHint, isPortOpen, killPid, readJson, writeJson, ensureDirs, seedAsset };
