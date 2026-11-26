// 严格验证：检查抖音的官方中奖通知（历史一次性诊断脚本）
// 🔴 2026-11-26 安全加固：本脚本用独立端口 9715，但复用主号 profile。
//    旧版会无条件删 SingletonLock + 用 swiftshader 起 Chrome——若主号(9750)正在跑，
//    这等于双开同一 profile，会搞崩主号。现加硬性防护：主号在跑则拒绝启动。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PORT=9715;
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const W=path.join(ROOT,'douyin-auto');
const PROFILE=path.join(W,'chrome-profile');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
// 🛑 主号在跑就不碰 profile：9750 有 CDP 监听即视为在跑
try{
  const r=await fetch('http://127.0.0.1:9750/json/version',{signal:AbortSignal.timeout(2000)});
  if(r.ok){console.log('⛔ 主号 9750 正在运行，本诊断脚本复用同一 profile，拒绝启动以免搞崩主号。请先停主号再跑。');process.exit(0);}
}catch{}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const q=this.p.get(m.id);this.p.delete(m.id);m.error?q.rej(new Error(JSON.stringify(m.error))):q.res(m.result);}};}
 send(m,p={},t=25000){const id=++this.id;return new Promise((res,rej)=>{const tm=setTimeout(()=>{this.p.delete(id);rej(new Error('timeout'));},t);this.p.set(id,{res:(v)=>{clearTimeout(tm);res(v);},rej:(e)=>{clearTimeout(tm);rej(e);}});this.ws.send(JSON.stringify({id,method:m,params:p}));});}}
async function conn(u){const ws=new WebSocket(u);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});return new CDP(ws);}
try{fs.rmSync(PROFILE+'/SingletonLock',{force:true});}catch(e){}
const chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,
 '--no-first-run','--no-default-browser-check','--disable-gpu',
 // ⚡ 2026-11-26：去掉 swiftshader（11-05 实测致 GPU 进程空转 260~377% CPU），改 --disable-gpu
 '--disable-dev-shm-usage','--window-size=1440,900','--mute-audio','--disable-blink-features=AutomationControlled',
 `--user-agent=${UA}`,'--lang=zh-CN','about:blank'],{stdio:'ignore'});
try{
  for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok)break;}catch{}await sleep(300);}
  const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page=l.find(t=>t.type==='page');
  const cdp=await conn(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  console.log('=== 1. 检查抖音消息中心（福袋中奖通知）===');
  await cdp.send('Page.navigate',{url:'https://www.douyin.com/user/self'});
  await sleep(12000);
  const prof=await cdp.send('Runtime.evaluate',{expression:`(()=>{
    var b=document.body.innerText||'';
    return {len:b.length, hasFudai:b.indexOf('福袋')>=0,
      fudaiLines:b.split('\\n').filter(l=>l.indexOf('福袋')>=0).slice(0,8),
      hasWin:/中奖|恭喜/.test(b), head:b.slice(0,200).replace(/\\n/g,'|')};
  })()`,returnByValue:true},25000);
  console.log(JSON.stringify(prof.result?.value,null,1).slice(0,800));

  console.log('\n=== 2. 检查通知页 ===');
  await cdp.send('Page.navigate',{url:'https://www.douyin.com/notification'});
  await sleep(10000);
  const notif=await cdp.send('Runtime.evaluate',{expression:`(()=>{
    var b=document.body.innerText||'';
    return {len:b.length, hasFudai:b.indexOf('福袋')>=0,
      lines:b.split('\\n').filter(l=>/福袋|中奖|红包/.test(l)).slice(0,10),
      head:b.slice(0,300).replace(/\\n/g,'|')};
  })()`,returnByValue:true},25000);
  console.log(JSON.stringify(notif.result?.value,null,1).slice(0,800));

  const shotPath=path.join(ROOT,'scripts','notification.png');
  await cdp.send('Page.captureScreenshot',{format:'png'}).then(x=>fs.writeFileSync(shotPath,Buffer.from(x.data,'base64'))).catch(()=>{});
  console.log('\n截图: '+shotPath);
}catch(e){console.log('FATAL',e.message);}
finally{try{chrome.kill('SIGKILL');}catch{} process.exit(0);}
