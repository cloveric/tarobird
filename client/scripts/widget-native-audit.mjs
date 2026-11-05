import { Script } from 'node:vm';
import { writeFile } from 'node:fs/promises';
import { buildWidgetRuntime } from './widget-runtime-build.mjs';
import { widgetDocument } from '../src/widget-document.ts';
const html=`<h2>Native interactive widget</h2><button id="probe">Select</button><p id="result">initial</p><img id="image" alt="Embedded marker" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="><script>
const actual=Function('return this')();
let parentBlocked=false,storageBlocked=false;try{parent.document.body.innerHTML='escaped'}catch{parentBlocked=true}try{localStorage.setItem('probe','x')}catch{storageBlocked=true}
const button=document.getElementById('probe');button.onclick=()=>document.getElementById('result').textContent='selected';button.click();
document.getElementById('result').dataset.flags=JSON.stringify([parentBlocked,storageBlocked,!actual.__TAURI_INTERNALS__&&!actual.webkit,!actual.document,!actual.postMessage&&!actual.Worker]);
addEventListener('tarobot:theme',()=>{while(true){}});
</script>`;
const runtime=await buildWidgetRuntime();
let document=widgetDocument({version:1,title:'Native widget',summary:'Native isolation probe',html},'native-audit',{'text':'#202020','accent':'#7050b0','font-body':'system-ui','scheme':'light'},runtime);
// Test-only trusted observer: inspect the real renderer without granting any
// capability to authored code. The production relay still strips all extras.
const nonce=/nonce="([^"]+)"/.exec(document)[1];
const observer=`const timer=setInterval(()=>{const node=document.getElementById('result');if(!node?.dataset.flags)return;const image=document.getElementById('image');if(!image?.complete)return;const flags=JSON.parse(node.dataset.flags);flags.push(node.textContent==='selected',image.naturalWidth===1);const bits=flags.reduce((n,value,index)=>n+(value?1<<index:0),0);parent.postMessage({type:'tarobot-widget-height',key:'native-audit',height:512+bits},'*')},50);`;
const bodyEnd=document.lastIndexOf('</body>');
document=document.slice(0,bodyEnd)+`<script nonce="${nonce}">${observer}</script>`+document.slice(bodyEnd);
// Fail before opening a native window if probe insertion breaks generated JS.
for(const [,source] of document.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Script(source);
await writeFile(new URL('../src-tauri/audit/widget-ui/document.js',import.meta.url),'window.widgetAuditDocument='+JSON.stringify(document)+';\n');
