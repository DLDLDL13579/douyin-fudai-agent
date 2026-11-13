/**
 * 共享「热房间」发现信号（2026-11-13，多账号实时联动）
 *
 * 背景：原先两个实例只共享探测「冷却 / 当日账本 / 房间档案」，都是轮次级读取，
 * 没有任何「某个实例此刻看到在播 / 看到福袋」的实时信号。福袋只存在 3-10 分钟，
 * 另一实例往往等自己下一轮采集（几分钟到十几分钟）才看到，等于错过。
 * 用户定稿「每个号的探测资源共享、探测号主探、主实例主抢」，本模块补上实时联动。
 *
 * 设计：每个账号实例只写自己的 hot-signal-<acc>.json（单写者 → 无跨进程写冲突，
 * 用 shared-json 的原子 rename 保证读者永远看到完整 JSON）；任一实例在换房间隙
 * 读取「除自己以外」所有账号的信号文件并合并，TTL 过滤后提权插队。
 *   - 拆成单写者文件：零锁竞争；单实例崩溃残留靠 TTL 自动过期，不拖累别人。
 *   - 「只读别人的」：自己刚探到的房本来就在自己候选里，联动的意义在跨实例。
 *
 * 信号类型：
 *   - fudai:true  —— 实例在该房间识别到福袋图标（价值最高，福袋只存在几分钟）
 *   - fudai:false —— 主动探测确认该房间在播
 * 两者都带 online（探测/扫描拿到的在线数）与 at 时间戳。
 *
 * 纯读写、无副作用、可单测；调用方（hunter35.mjs）负责 try-catch 与开关。
 */
import fs from 'node:fs';
import { withSharedJson, readSharedJson } from './shared-json.mjs';

const PREFIX = 'hot-signal-';
const SUFFIX = '.json';

function safeAcc(acc) {
  // 只保留安全字符，避免账号名造成路径穿越
  return String(acc || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
}

function fileFor(DATA_DIR, acc) {
  return DATA_DIR + '/' + PREFIX + safeAcc(acc) + SUFFIX;
}

/**
 * 单写者上报：覆盖自己文件里该房间的信号，顺带清理过期房间。
 * 内部全程 try-catch，永不 reject；调用方可以 void 掉不阻塞主循环。
 */
export async function reportHot(DATA_DIR, acc, room, info = {}, ttlMs = 180000) {
  if (!room) return;
  const f = fileFor(DATA_DIR, acc);
  try {
    await withSharedJson(f, cur => {
      if (!cur.rooms || typeof cur.rooms !== 'object' || Array.isArray(cur.rooms)) cur.rooms = {};
      cur.rooms[String(room)] = {
        online: Number.isFinite(info.online) ? info.online : -1,
        fudai: !!info.fudai,
        by: safeAcc(acc),
        at: Date.now(),
        ttl: ttlMs | 0
      };
      const now = Date.now();
      for (const k of Object.keys(cur.rooms)) {
        const r = cur.rooms[k];
        if (!r || now - (r.at || 0) > (r.ttl || ttlMs)) delete cur.rooms[k];
      }
      return cur;
    }, { rooms: {} });
  } catch (e) { /* 信号是旁路，失败绝不影响抓取 */ }
}

/**
 * 读取「除 selfAcc 外」所有账号的有效热信号，按「有福袋优先、越新越前」排序。
 * maxAgeMs 是读取方的新鲜度门槛，与每个信号自带 ttl 取更短者。
 */
export function readHot(DATA_DIR, selfAcc, maxAgeMs = 180000) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith(PREFIX) && f.endsWith(SUFFIX)); }
  catch (e) { return out; }
  const selfFile = PREFIX + safeAcc(selfAcc) + SUFFIX;
  const now = Date.now();
  for (const f of files) {
    if (f === selfFile) continue;   // 只读别人写的，实现真正的跨账号联动
    let cur;
    try { cur = readSharedJson(DATA_DIR + '/' + f, { rooms: {} }); } catch (e) { continue; }
    const rooms = (cur && cur.rooms) || {};
    for (const [room, v] of Object.entries(rooms)) {
      if (!v) continue;
      const age = now - (v.at || 0);
      if (age < 0 || age > Math.min(maxAgeMs, v.ttl || maxAgeMs)) continue;  // TTL 过期
      out.push({
        room,
        online: Number.isFinite(v.online) ? v.online : -1,
        fudai: !!v.fudai,
        by: v.by || f,
        at: v.at || 0,
        ageSec: Math.round(age / 1000)
      });
    }
  }
  out.sort((a, b) => (b.fudai ? 1 : 0) - (a.fudai ? 1 : 0) || (a.ageSec - b.ageSec));
  return out;
}

export default { reportHot, readHot };
