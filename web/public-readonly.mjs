/**
 * 公网只读代理（2026-11-06）
 *
 * 目的：把本机 8899 福袋看板映射到公网给手机看，但严格只读。
 *   - 只放行 GET 白名单：/、/api/status、/icon.svg、/manifest.json
 *   - 一切 POST（含 /api/action 启停、切换账号、添加账号）直接 403
 *   - HTML 里注入一行脚本，移除所有 .btn[data-act] 与账号操作按钮，避免手机上出现点不动的按钮
 *   - 原 8899 看板源码与进程完全不动，本地功能不受任何影响
 *
 * 用法：DY_PUBLIC_PORT=8898 node web/public-readonly.mjs
 * 上游固定 http://127.0.0.1:8899，不读任何用户可调配置，避免误连别的端口。
 */
import http from 'node:http';

const PORT = Number(process.env.DY_PUBLIC_PORT) || 8898;
const UPSTREAM = 'http://127.0.0.1:8899';
const ALLOW = new Set(['/', '/api/status', '/icon.svg', '/manifest.json']);

// 注入到 </body> 前：禁用所有会产生 POST /api/action 的控件
const READONLY_JS = `<script>
(function(){
  var s=document.createElement('style');
  s.textContent='.btn[data-act],#btn-acc-add,[data-use-account]{display:none!important}'
    +'#act-msg::after{content:" · 公网只读";color:var(--dim)}';
  document.head.appendChild(s);
  document.addEventListener('click',function(e){
    var t=e.target&&e.target.closest&&e.target.closest('.btn[data-act],#btn-acc-add,[data-use-account]');
    if(t){e.preventDefault();e.stopPropagation();}
  },true);
  var origFetch=window.fetch.bind(window);
  window.fetch=function(u,o){
    if(o&&String(o.method||'').toUpperCase()!=='GET') return Promise.reject(new Error('公网只读模式，禁止写操作'));
    return origFetch(u,o);
  };
})();
<\/script>`;

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
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
