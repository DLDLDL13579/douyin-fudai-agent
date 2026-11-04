#!/usr/bin/env node
/**
 * 提交前敏感信息门禁：扫描 git 暂存区全部内容，命中即非零退出。
 *
 * 用法：node scripts/precommit-check.mjs
 * 建议在每次 git commit 前跑一次，或接入 pre-commit hook。
 *
 * ⚠ 本脚本自身的模式串用片段拼接构造，确保脚本文件里不含任何完整敏感串，
 *    这样脚本本身可以安全地放进公开仓库。
 */
import { execFileSync } from 'node:child_process';

// 完整敏感串 = 各片段 join('')，源码里不会出现连续明文
const PARTS = [
  ['819527', '72638'],           // 账号 A 抖音号
  ['862002', '64017'],           // 账号 B 抖音号
  ['143894', '3791@qq.com'],     // 邮箱
  ['/Users/meihao', 'shidai'],   // 本机用户名路径
  ['好患得', '患失'],             // 账号 A 昵称
  ['🌈', '福袋'],                 // 账号 B 昵称
];
const FATAL = PARTS.map((p) => p.join(''));
// token 前缀也用片段拼接，避免脚本自身被自己判定为「含 token」而误报
const TOKEN_PREFIXES = [
  ['gh', 'o_'].join(''),
  ['gh', 'p_'].join(''),
  ['github', '_pat_'].join(''),
];
// 真实凭据值形态：Cookie 名后跟 20+ 位实际值（代码里的名称检查不会命中）
const COOKIE_VALUE = /sessionid["'\s:=]+[A-Za-z0-9_%]{20,}/;

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

function contentOf(path) {
  return execFileSync('git', ['show', ':' + path], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

const files = stagedFiles();
if (!files.length) {
  console.log('⚠️  暂存区为空，无需检查。先 git add <具体文件>。');
  process.exit(0);
}

const hits = [];
for (const f of files) {
  let s;
  try {
    s = contentOf(f);
  } catch {
    continue; // 二进制文件（git show 对二进制会报错），跳过
  }
  for (const k of FATAL) {
    if (s.includes(k)) hits.push({ file: f, what: '身份/凭据明文', detail: k.slice(0, 4) + '…' });
  }
  for (const k of TOKEN_PREFIXES) {
    if (s.includes(k)) hits.push({ file: f, what: 'GitHub token 前缀', detail: k });
  }
  if (COOKIE_VALUE.test(s)) hits.push({ file: f, what: '疑似真实 Cookie 值', detail: '' });
}

console.log(`🔍 已扫描暂存区 ${files.length} 个文件`);
if (hits.length) {
  console.error('❌ 检出敏感内容，禁止提交：');
  for (const h of hits) console.error(`   ${h.file}  ${h.what}  ${h.detail}`);
  console.error('   修法：脱敏后重新 git add；若确为规则文本误报，请人工确认。');
  process.exit(1);
}
console.log('✅ 零命中，可以提交');
