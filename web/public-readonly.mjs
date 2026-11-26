/**
 * 公网只读代理（2026-11-06）
 *
 * 目的：把本机 8899 福袋看板映射到公网给手机看，但严格只读。
 *   - 放行 GET 白名单：/、/api/status、/icon.svg、/manifest.json
 *   - 🕹️ 2026-11-21 22:50 用户定稿：额外放行唯一一个写动作 POST /api/action 且 body.action 必须是
 *     next-room（手动切下一个直播间）。其余一切 POST（启停/切账号/加账号）仍然 403。
 *     理由：用户在外面用手机也想快速跳过无聊的直播间，这个动作不改变系统状态、只影响选房节奏。
 *   - HTML 里注入脚本，只移除**启停/账号类**按钮，保留「下一个房间」按钮
 *   - 原 8899 看板源码与进程完全不动，本地功能不受任何影响
 *
 * 用法：DY_PUBLIC_PORT=8898 node web/public-readonly.mjs
 * 上游固定 http://127.0.0.1:8899，不读任何用户可调配置，避免误连别的端口。
 */
import http from 'node:http';

const PORT = Number(process.env.DY_PUBLIC_PORT) || 8898;
const UPSTREAM = 'http://127.0.0.1:8899';
const ALLOW = new Set(['/', '/api/status', '/icon.svg', '/manifest.json']);
// 🕹️ 唯一放行的写接口：POST /api/action，且 action 必须是 next-room。
//    用「读完整 body 再校验」而不是只看路径，避免路径放行后被塞进 start/stop 之类的危险动作。
const ACTION_PATH = '/api/action';
const ALLOWED_ACTION = 'next-room';

// 注入到 </body> 前：禁用所有会产生 POST /api/action 的控件
const READONLY_JS = `<script>
(function(){
  var s=document.createElement('style');
  // 只隐藏启停/账号类按钮；「下一个房间」保留（用户明确要求公网也能点）
  s.textContent='.btn[data-act]:not([data-act="next-room"]),#btn-acc-add,[data-use-account]{display:none!important}'
    +'#act-msg::after{content:" · 公网可用「下一个房间」";color:var(--dim)}';
  document.head.appendChild(s);
  document.addEventListener('click',function(e){
    var t=e.target&&e.target.closest&&e.target.closest('.btn[data-act]:not([data-act="next-room"]),#btn-acc-add,[data-use-account]');
    if(t){e.preventDefault();e.stopPropagation();}
  },true);
  var origFetch=window.fetch.bind(window);
  window.fetch=function(u,o){
    var m=o&&String(o.method||'').toUpperCase();
    if(m&&m!=='GET'&&m!=='POST') return Promise.reject(new Error('公网只允许 GET 与「下一个房间」'));
    if(m==='POST'){
      // 只放行 next-room，其它 POST 一律在本地拦掉，不等服务端 403
      var ok=false;
      try{ ok=(JSON.parse(o.body||'{}').action==='next-room'); }catch(err){}
      if(!ok) return Promise.reject(new Error('公网只允许「下一个房间」'));
    }
    return origFetch(u,o);
  };
})();
<\/script>`;

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];

  // 🕹️ 唯一放行的写请求：POST /api/action 且 action==='next-room'。
  //    必须在这里做真正的校验（前端注入的 fetch 包装只是体验层，能被绕过）：
  //    读完 body → 解析 → 只认 next-room，然后原样转发给 8899。
  if (req.method === 'POST' && path === ACTION_PATH) {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > 2048) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) { res.writeHead(413).end('{}'); return; }
      let act = null;
      try { act = JSON.parse(body).action; } catch {}
      if (act !== ALLOWED_ACTION) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'public: only next-room allowed', got: act }));
        return;
      }
      // 🔑 2026-11-26 副作用修复：8899 的 POST 加了 token 鉴权，手机页面从本代理取 HTML，
      //    token 在 fetch 的 X-Web-Token header 里。代理原只转发 body、重建 headers 时丢了 token，
      //    导致手机「下一房」被 8899 判 401。这里显式透传该 header（其余 header 仍不转发，权限面不变）。
      const up = http.request(UPSTREAM + ACTION_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(req.headers['x-web-token'] ? { 'X-Web-Token': req.headers['x-web-token'] } : {}),
        },
      }, (ur) => {
        res.writeHead(ur.statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        ur.pipe(res);
      });
      up.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'upstream failed: ' + String(e.message).slice(0, 80) }));
      });
      up.end(body);
    });
    return;
  }

  if (req.method !== 'GET' || !ALLOW.has(path)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'public read-only: blocked', method: req.method, path }));
    return;
  }
  const u = new URL(req.url, UPSTREAM);
  const up = http.request(u, { method: 'GET', headers: { 'Accept': req.headers.accept || '*/*' } }, (ur) => {
    const ct = ur.headers['content-type'] || '';
    if (!ct.startsWith('text/html')) {
      res.writeHead(ur.statusCode || 200, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
      ur.pipe(res);
      return;
    }
    let body = '';
    ur.setEncoding('utf8');
    ur.on('data', (c) => { body += c; });
    ur.on('end', () => {
      const patched = body.replace('</body>', READONLY_JS + '\n</body>');
      res.writeHead(ur.statusCode || 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(patched),
      });
      res.end(patched);
    });
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(e.message) }));
  });
  up.setTimeout(15000, () => up.destroy(new Error('upstream timeout')));
  up.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[public-readonly] http://127.0.0.1:${PORT} → ${UPSTREAM} (GET 白名单，写操作 403)`);
});
