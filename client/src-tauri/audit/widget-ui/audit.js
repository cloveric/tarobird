const frame=document.getElementById('widget');
let finished=false,receipt,spinning=false,ticks=0,maxGap=0,last=performance.now();
const finish=value=>{if(finished)return;finished=true;window.__TAURI__.core.invoke('audit_finish',{receipt:value})};
setInterval(()=>{const now=performance.now();if(spinning){ticks++;maxGap=Math.max(maxGap,now-last);document.getElementById('response').textContent=String(ticks)}last=now},25);
addEventListener('error',event=>finish({error:event.message}));
addEventListener('unhandledrejection',event=>finish({error:String(event.reason)}));
addEventListener('message',event=>{
 if(event.source!==frame.contentWindow)return;
 const data=event.data;
 if(data?.type==='tarobot-widget-shell-ready')frame.contentWindow.postMessage({type:'tarobot-widget-init',key:'native-audit',document:window.widgetAuditDocument},'*');
 if(!receipt&&data?.type==='tarobot-widget-height'&&data.key==='native-audit'&&Number.isInteger(data.height)&&data.height>=512&&data.height<640){
  const flags=data.height-512;
  receipt=Object.fromEntries(['parentBlocked','storageBlocked','nativeBlocked','workerNoDom','workerNoTransport','clicked','dataImageLoaded'].map((name,index)=>[name,!!(flags&(1<<index))]));
  spinning=true;last=performance.now();frame.contentWindow.postMessage({type:'tarobot-widget-theme',key:'native-audit',theme:{text:'#202020'}},'*');
 }
 if(!receipt&&data?.type==='tarobot-widget-error')finish({error:'guest startup failed',reason:data.reason});
 if(receipt&&data?.type==='tarobot-widget-error'&&data.key==='native-audit'&&data.persistent===true&&data.reason==='cpu')finish({...receipt,cpuRetired:true,parentTicks:ticks,parentMaxGapMs:maxGap,parentResponsive:ticks>40&&maxGap<500});
});
setTimeout(()=>finish({error:'native widget timeout',receipt,ticks,maxGap}),15000);

const initialize=()=>frame.contentWindow.postMessage({type:'tarobot-widget-init',key:'native-audit',document:window.widgetAuditDocument},'*');
frame.addEventListener('load',initialize);frame.src='widget://localhost/widget-sandbox.html';
