// Only the documentation driver enables this bridge after web pairing.
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('__readmeBrowser',{
 version:1,engine:'electron',platform:process.platform,
 invoke:(command,args={})=>ipcRenderer.invoke('readme:browser',command,args),
 openSocket:async()=>{throw new Error('documentation_uses_loopback_web_transport');},
 on:(event,receive)=>{
  if(event!=='workbench-browser')return()=>{};
  const handler=(_event,payload)=>receive(payload);
  ipcRenderer.on('readme:browser-event',handler);
  return()=>ipcRenderer.removeListener('readme:browser-event',handler);
 },
});
