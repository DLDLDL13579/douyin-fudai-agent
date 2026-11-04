/**
 * 跨进程安全的共享 JSON 读写（2026-11-04，为多账号并行新增）
 *
 * 背景：hunter35 的 data/anchors.json 是「读 → 改 → writeFileSync 整文件覆盖」。
 * 两个账号实例同时跑时，后写的会把先写的学习成果整个抹掉。
 *
 * 方案：文件锁（wx 独占创建，Node 跨平台统一语义）+ 临时文件 rename 原子替换。
 *   - 锁只在毫秒级的读写窗口持有，不阻塞 7×24 主循环
 *   - 崩溃残留锁超过 5 秒自动清除，避免死锁
 *   - 读失败一律回退默认值，绝不让统计异常拖垮抓取
 *
 * 用法：await withSharedJson(file, (obj) => { obj.x++; return obj; })
 */
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 写临时文件后 rename，保证读者永远看到完整 JSON */
function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);   // 同一文件系统内 rename 是原子的
}

function readJsonSafe(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || def; }
  catch { return def; }
}

/**
 * 抢锁。wx 在文件已存在时抛 EEXIST，天然互斥。
 * 超时 5 秒的陈旧锁会被清除（进程崩溃残留）。
 */
async function acquireLock(file, timeoutMs = 3000) {
  const lock = file + '.lock';
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      // 陈旧锁自愈
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 5000) { fs.rmSync(lock, { force: true }); continue; }
      } catch {}
      await sleep(20);
    }
  }
  return false;
}

function releaseLock(file) {
  try { fs.rmSync(file + '.lock', { force: true }); } catch {}
}

/**
 * 在锁保护下读 → 改 → 原子写。
 * mutator 收到当前对象，返回要写入的对象（或 undefined 表示用原对象）。
 * 抢锁失败时降级为「无锁直接写」，宁可极小概率丢更新，也不阻塞抓取。
 */
export async function withSharedJson(file, mutator, def = {}) {
  let locked = true;
  try { locked = await acquireLock(file); } catch { locked = false; }
  try {
    const cur = readJsonSafe(file, def);
    let next;
    try { next = mutator(cur); } catch (e) { return cur; }
    if (next === undefined) next = cur;
    if (locked) atomicWriteJson(file, next);
    else {
      // 降级：直接原子写（仍是完整 JSON，只是没串行化）
      atomicWriteJson(file, next);
    }
    return next;
  } catch (e) {
    return readJsonSafe(file, def);
  } finally {
    if (locked) releaseLock(file);
  }
}

/** 只读（无需锁：配合 atomicWriteJson 保证永远读到完整文件） */
export function readSharedJson(file, def = {}) {
  return readJsonSafe(file, def);
}

export default { withSharedJson, readSharedJson };
