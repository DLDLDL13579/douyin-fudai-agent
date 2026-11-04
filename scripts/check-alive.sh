#!/bin/bash
# 采集端「有没有视力」自检 —— 登录态失效时整夜 0 福袋，与「真的没福袋」表现完全一样。
# 2026-11-03 在此栽过一次（盲跑 18 小时），固化成每次巡检必查。
PORT="${1:-9750}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_PATH="${DY_ALIVE_LOG:-$ROOT_DIR/douyin-auto/h35.log}"
DY_ALIVE_LOG="$LOG_PATH" node -e "
(async()=>{
  try{
    const l=await (await fetch('http://127.0.0.1:$PORT/json/list')).json();
    const p=l.find(t=>t.type==='page');
    if(!p){ console.log('NO_PAGE'); process.exit(1); }
    const ws=new WebSocket(p.webSocketDebuggerUrl);
    let i=0,cb=new Map();
    const send=(m,pr={})=>new Promise(r=>{const k=++i;cb.set(k,r);ws.send(JSON.stringify({id:k,method:m,params:pr}))});
    ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&cb.has(m.id)){cb.get(m.id)(m.result);cb.delete(m.id)}};
    await new Promise(r=>ws.onopen=r);
    const ck=await send('Network.getCookies',{urls:['https://live.douyin.com','https://www.douyin.com']});
    const n=(ck.cookies||[]).map(c=>c.name);
    const need=['sessionid','sid_tt','uid_tt'];
    const miss=need.filter(x=>!n.includes(x));
    // ⚠ 页面长度必须在「稳定后」测，否则巡检会连续误报：
    //   抓取每次换房都会导航，撞上导航瞬间会读到 len=14（个位数），
    //   撞上半加载会读到 len=342（正好落在 SUSPECT_SHORT_PAGE 区间）。
    //   2026-11-03 12:57 和 13:57 各踩一次，两次都是假的，白排查两轮。
    //   真正的判据不是「长度多少」，而是「长度是否已经稳定」：
    //   连续两次读到 >=350 且相差 <40，才算渲染完成。
    const nap=(ms)=>new Promise(r=>setTimeout(r,ms));
    let len=0, prev=-1, stable=false;
    for(let a=0;a<8;a++){
      const d=await send('Runtime.evaluate',{expression:'(document.body.innerText||\"\").length',returnByValue:true});
      len=d.result.value||0;
      if(len>=350 && Math.abs(len-prev)<40){ stable=true; break; }
      prev=len;
      await nap(1800);
    }
    // 判据优先级：Cookie 是硬证据，页面长度只作辅助（导航瞬间 len 个位数是正常的，
    // 只有「Cookie 齐全但页面长期只有 300 上下」才可疑 —— 那才是未登录页的特征）
    if(miss.length){ console.log('LOGIN_EXPIRED missing='+miss.join(',')); process.exit(2); }

    // 🎯 守候开奖期间页面被开奖浮层占满，innerText 必然变短（实测 600+ → 105），
    //    这恰恰说明系统正常工作。此时不能再用页面长度判断，直接看日志状态。
    //    2026-11-03 22:57 连续 3 次误报 SUSPECT_SHORT_PAGE 就是踩了这个。
    try{
      const fs=require('fs');
      const logPath=process.env.DY_ALIVE_LOG;
      const tail=fs.readFileSync(logPath,'utf8').split('\n').filter(Boolean).slice(-6).join('\n');
      if(/守候开奖中|守候开奖 \d+s/.test(tail)){
        console.log('OK len='+len+' (守候开奖中，页面被开奖浮层占满属正常)');
        ws.close(); return;
      }
    }catch(e){}
    // 重测 8 次累计约 13 秒仍未稳定 → 才认为页面真的有问题
    if(!stable && len<60){ console.log('EMPTY_PAGE len='+len+' (重测 13 秒仍为空，标签可能卡死)'); process.exit(5); }
    if(!stable && len>=60 && len<350){ console.log('SUSPECT_SHORT_PAGE len='+len+' (cookie 在但页面 13 秒未渲染完成)'); process.exit(3); }
    console.log('OK len='+len+' (cookie 齐全)');
    ws.close();
  }catch(e){ console.log('ERR '+e.message); process.exit(4); }
})();
"
