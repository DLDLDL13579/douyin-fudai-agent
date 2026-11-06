#!/bin/bash
# 采集端「有没有视力」自检 —— 登录态失效时整夜 0 福袋，与「真的没福袋」表现完全一样。
# 2026-11-03 在此栽过一次（盲跑 18 小时），固化成每次巡检必查。
PORT="${1:-9750}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# ⚠ 日志必须跟着端口走，否则查账号实例时会拿主实例的「守候开奖」误放行。
#    2026-11-05 02:57 踩过：9751 页面 len=20「直播加载中」，却因主实例在守候而报 OK。
#    2026-11-06 09:39 改为按 accounts/*/meta.json 的 port 反查账号目录：
#    账号可增删（main2 已删、main3 用 9752），写死端口→目录的映射必然再次失效。
DEFAULT_LOG="$ROOT_DIR/douyin-auto/h35.log"
if [ "$PORT" != "9750" ]; then
  ACC_DIR="$(node -e "
    const fs=require('fs'),p=require('path');
    const root='$ROOT_DIR/accounts';
    try{
      for(const n of fs.readdirSync(root)){
        const f=p.join(root,n,'meta.json');
        if(!fs.existsSync(f))continue;
        if(String(JSON.parse(fs.readFileSync(f,'utf8')).port||'')==='$PORT'){
          process.stdout.write(p.join(root,n,'work','h35.log'));break;
        }
      }
    }catch(e){}
  ")"
  [ -n "$ACC_DIR" ] && DEFAULT_LOG="$ACC_DIR"
fi
LOG_PATH="${DY_ALIVE_LOG:-$DEFAULT_LOG}"
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
    let len=0, prev=-1, stable=false, needLogin=false, commentBox=0;
    for(let a=0;a<8;a++){
      const d=await send('Runtime.evaluate',{expression:'(()=>{const t=document.body.innerText||\"\";return JSON.stringify({len:t.length,needLogin:/需先登录|请先登录|登录后参与|登录后可参与|登录后才能/.test(t),commentBox:document.querySelectorAll(\"[placeholder*=说点什么],[contenteditable=true]\").length})})()',returnByValue:true});
      let info={};
      try{ info=JSON.parse(d.result.value||'{}'); }catch(e){}
      len=info.len||0;
      if(info.needLogin) needLogin=true;
      commentBox=info.commentBox||0;
      if(len>=350 && Math.abs(len-prev)<40){ stable=true; break; }
      prev=len;
      await nap(1800);
    }
    // 🔴 服务端判定会话失效（硬判据，必须排最前、不受任何豁免）：
    //    2026-11-05 09:29 实测 main2：sessionid/sid_tt/uid_tt 全在、expires 到 2027 年，
    //    但页面显示「需先登录，才能开始聊天」、无评论输入框、福袋图标不下发，
    //    check-alive 却因 Cookie 齐全一直报 OK，导致盲跑 5 小时。
    //    真掉线必然带 needLogin 文案，所以把它留在最前面兜底，守候豁免不会漏放。
    if(needLogin){ console.log('LOGIN_EXPIRED needLogin=true (Cookie 齐全但服务端已判会话失效，需重新扫码)'); ws.close(); process.exit(2); }
    if(miss.length){ console.log('LOGIN_EXPIRED missing='+miss.join(',')); process.exit(2); }

    // 🎯 守候开奖期间页面被福袋/开奖浮层占满：innerText 变短、评论输入框被临时移除，
    //    这恰恰说明系统正常工作。⚠ 这一条必须排在 LOGIN_SUSPECT 之前：
    //    2026-11-05 14:57 巡检实测守候中 len=2049、commentBox=0，旧顺序先判
    //    「无评论框 → 登录态可疑」，连报两次 LOGIN_SUSPECT；而直接 CDP 查
    //    needLogin=false、有评论框、Cookie 三项齐全、福袋图标 LM=1，是纯误报。
    //    commentBox 是软判据（浮层/商品页/导航都会让它为 0），needLogin 才是硬判据。
    //    ⚠ len<60 是空页面「直播加载中」，绝不能被豁免（02:57 的 9751 假 OK 漏洞）。
    let isDrawing=false;
    if(len>=60){
      try{
        const fs=require('fs');
        const logPath=process.env.DY_ALIVE_LOG;
        const tail=fs.readFileSync(logPath,'utf8').split('\n').filter(Boolean).slice(-6).join('\n');
        isDrawing=/守候开奖中|守候开奖 \d+s/.test(tail);
      }catch(e){}
    }
    if(isDrawing){
      console.log('OK len='+len+' (守候开奖中，页面被开奖浮层占满属正常)');
      ws.close(); return;
    }

    // 非守候态：页面已稳定渲染却既无评论输入框，才判登录态可疑
    if(stable && commentBox===0 && len>350){ console.log('LOGIN_SUSPECT no-comment-box len='+len+' (页面正常但无评论框，疑似未登录)'); ws.close(); process.exit(2); }
    // 重测 8 次累计约 13 秒仍未稳定 → 才认为页面真的有问题
    if(!stable && len<60){ console.log('EMPTY_PAGE len='+len+' (重测 13 秒仍为空，标签可能卡死)'); process.exit(5); }
    if(!stable && len>=60 && len<350){ console.log('SUSPECT_SHORT_PAGE len='+len+' (cookie 在但页面 13 秒未渲染完成)'); process.exit(3); }
    console.log('OK len='+len+' (cookie 齐全)');
    ws.close();
  }catch(e){ console.log('ERR '+e.message); process.exit(4); }
})();
"
