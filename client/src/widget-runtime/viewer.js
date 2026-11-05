import DOMPurify from 'dompurify';
// Trusted DOM renderer. Authored scripts exist only inside the dedicated Worker.
const {html,theme:initialTheme,workerSource,key,restore}=window.widgetConfiguration;delete window.widgetConfiguration;
const root=document.getElementById('report-root');
const createElement=document.createElement.bind(document),selectDocument=document.querySelector.bind(document),bodyElement=document.body,htmlElement=document.documentElement;
// Authored names can shadow document properties (named access); security
// checks read through prototype getters captured before any markup renders.
const uncurry=fn=>Function.prototype.call.bind(fn),getter=(prototype,name)=>uncurry(Object.getOwnPropertyDescriptor(prototype,name).get);
const visibility=getter(Document.prototype,'visibilityState'),activeOf=getter(Document.prototype,'activeElement'),hasFocus=uncurry(Document.prototype.hasFocus);
const attributesOf=getter(Element.prototype,'attributes'),childNodesOf=getter(Node.prototype,'childNodes'),replaceNode=uncurry(Element.prototype.replaceWith),appendNodes=uncurry(Element.prototype.append);
const send=(type,detail={})=>parent.postMessage({type,key,...detail},'*');
let watchdog,worker,failed=false,retiring=false,flushId,renderFrame=0,pendingHtml,pendingAttributes,pendingOverflow,pendingHtmlAck=0,pendingControls=[],snapshots=0,lastRender=0,lastPong=performance.now(),awaitingNonce='',lastGesture=-Infinity,bodyId,interactiveReady=false,fallbackStateKnown=false,fallbackState;
// Each heartbeat carries a fresh unpredictable nonce. Guest code that never
// yields cannot read it, so it cannot answer on the runtime's behalf.
const randomValues=crypto.getRandomValues.bind(crypto),freshNonce=()=>[...randomValues(new Uint32Array(4))].map(value=>value.toString(36)).join('');
const allowedTheme=Object.keys(initialTheme);
const applyTheme=theme=>{for(const name of allowedTheme){const value=theme?.[name];if(typeof value!=='string'||value.length>500)continue;if(name==='scheme')htmlElement.style.colorScheme=value==='dark'?'dark':'light';else htmlElement.style.setProperty('--'+name,value)}};
applyTheme(initialTheme);
// IDs remain local to this opaque viewer, whose authority is captured in lexical
// bindings. Preserve ordinary IDs such as "title"/"method" for CSS and virtual
// DOM correspondence; frames/embedded plugins and executable attributes remain
// forbidden. No authored script can use DOM-named globals here.
const sanitize=value=>DOMPurify.sanitize(value,{FORCE_BODY:true,SANITIZE_DOM:false,FORBID_TAGS:['script','iframe','frame','object','embed','meta','base','link','audio','video','canvas','animate','animateTransform','set','foreignObject'],FORBID_ATTR:['autofocus','srcset','action','formaction','target','download'],ADD_ATTR:['data-tarobot-node'],ALLOW_UNKNOWN_PROTOCOLS:false});
// A real form would add named-property clobbering and, in this sandbox, a
// blocked submission without any submit event. Keep its box as a neutral
// container: the Worker owns form semantics, submit and reset.
const formAttribute=/^(?:class|style|id|lang|dir|title|role|data-[a-z0-9_-]+|aria-[a-z0-9_-]+)$/i;
function neutralizeForms(fragment){
 for(const form of fragment.querySelectorAll('form')){
  const box=createElement('div');
  for(const attr of [...attributesOf(form)])if(formAttribute.test(attr.name))box.setAttribute(attr.name,attr.value);
  box.setAttribute('data-tarobot-form','');if(!box.hasAttribute('role'))box.setAttribute('role','form');
  appendNodes(box,...childNodesOf(form));replaceNode(form,box);
 }
}
// Authored CSS that addresses the form element keeps applying to its neutral
// box: type selectors in sheets inside the report are rewritten through CSSOM.
// Strings, escapes and attribute selectors are copied verbatim; only a bare
// `form` type token is replaced. Form-only pseudo-classes such as :invalid
// cannot match a div.
const identifier=/[\w\u00a0-\uffff-]/,mappedSheets=new WeakMap();
function mapFormSelector(selector){
 let out='',index=0,brackets=0;
 while(index<selector.length){
  const char=selector[index];
  if(char==='\\'){out+=selector.slice(index,index+2);index+=2;continue}
  if(char==='"'||char==="'"){let end=index+1;while(end<selector.length&&selector[end]!==char)end+=selector[end]==='\\'?2:1;out+=selector.slice(index,end+1);index=end+1;continue}
  if(char==='['||char===']'){brackets=Math.max(0,brackets+(char==='['?1:-1));out+=char;index++;continue}
  if(!brackets&&(char==='f'||char==='F')&&selector.slice(index,index+4).toLowerCase()==='form'&&!identifier.test(selector[index+4]??'')&&selector[index+4]!=='\\'&&(index===0||/[\s>+~,(]/.test(selector[index-1]))){out+='[data-tarobot-form]';index+=4;continue}
  out+=char;index++;
 }
 return out;
}
function mapFormStyles(){
 for(const style of root.querySelectorAll('style')){
  const sheet=style.sheet;if(!sheet||mappedSheets.get(style)===sheet)continue;mappedSheets.set(style,sheet);
  const visit=rules=>{for(const rule of rules){if(typeof rule.selectorText==='string'&&/form/i.test(rule.selectorText)){const next=mapFormSelector(rule.selectorText);if(next!==rule.selectorText)try{rule.selectorText=next}catch{/* Keep the authored selector. */}}if(rule.cssRules)visit(rule.cssRules)}};
  try{visit(sheet.cssRules)}catch{/* An unreadable sheet keeps its selectors. */}
 }
}
// User input newer than the Worker's acknowledged event serial wins: neither a
// stale snapshot nor live-state echo may overwrite it.
const localSerial=new WeakMap(),newerLocally=(node,ack)=>(localSerial.get(node)??0)>ack;
// Patching a details element's open attribute makes the browser queue a
// toggle event. That echo of a Worker change is not user input.
const patchedOpen=new WeakMap();
// Custom validity mirrored from the Worker, and the temporary message shown
// for a failure only the Worker can see (cleared when the user edits).
const mirrored=new WeakMap(),customized=new WeakSet();
// Host-validated source renders once without an element cap; Worker snapshots
// are bounded and call overflow instead of patching an oversized document.
function render(value,overflow,ack=Infinity){
 const template=createElement('template');template.innerHTML=sanitize(value);
 if(overflow&&template.content.querySelectorAll('*').length>2048){overflow();return}
 neutralizeForms(template.content);
 for(const element of template.content.querySelectorAll('[href],[src],[xlink\\:href]')){
  for(const attr of ['href','src','xlink:href']){const value=element.getAttribute(attr);if(value&&!value.startsWith('#')&&!/^data:image\/(?:png|gif|jpeg|webp);base64,/i.test(value))element.removeAttribute(attr)}
 }
 const patch=(parent,source)=>{
  for(let i=0;i<source.childNodes.length;i++){
   const incoming=source.childNodes[i];let current=parent.childNodes[i];
   if(incoming.nodeType===1){const id=incoming.getAttribute('data-tarobot-node');if(id&&current?.nodeType===1&&current.getAttribute('data-tarobot-node')!==id){const match=[...parent.children].find(node=>node.getAttribute('data-tarobot-node')===id);if(match){parent.insertBefore(match,current);current=match}}}
   if(!current||current.nodeType!==incoming.nodeType||current.nodeName!==incoming.nodeName){const copy=incoming.cloneNode(true);if(copy.nodeType===1)for(const details of [copy,...copy.querySelectorAll('details')])if(details.localName==='details'&&details.open)patchedOpen.set(details,true);if(current)parent.replaceChild(copy,current);else parent.appendChild(copy);continue}
   if(current.nodeType===3){if(current.textContent!==incoming.textContent)current.textContent=incoming.textContent;continue}
   if(current.nodeType!==1)continue;
   // A details element toggled by the user keeps that state until the Worker
   // has processed the toggle; other controls are protected by dirty state.
   const keep=current.localName==='details'&&newerLocally(current,ack);
   // A reused control now represents another Worker node: drop stale validity.
   if(current.getAttribute('data-tarobot-node')!==incoming.getAttribute('data-tarobot-node')&&typeof current.setCustomValidity==='function'&&(mirrored.has(current)||customized.has(current))){current.setCustomValidity('');mirrored.delete(current);customized.delete(current)}
   const open=current.localName==='details'&&current.open;
   for(const attr of [...current.attributes])if(!incoming.hasAttribute(attr.name)&&!(keep&&attr.name==='open'))current.removeAttribute(attr.name);
   for(const attr of incoming.attributes)if(current.getAttribute(attr.name)!==attr.value&&!(keep&&attr.name==='open'))current.setAttribute(attr.name,attr.value);
   if(current.localName==='details'&&current.open!==open)patchedOpen.set(current,current.open);
   patch(current,incoming);
  }
  while(parent.childNodes.length>source.childNodes.length)parent.lastChild.remove();
 };
 patch(root,template.content);mapFormStyles();refreshObservers();
}
// Live control properties from the Worker. Markup attributes only set default
// values; once a control is dirty, script changes need these properties. Each
// entry is judged by the ACK of the snapshot that produced it, never a later one.
function applyControls(entries){
 const byId=new Map();for(const node of root.querySelectorAll('[data-tarobot-node]'))byId.set(node.getAttribute('data-tarobot-node'),node);
 const focused=activeOf(document);
 for(const [id,state,ack] of entries){
  const node=byId.get(id);if(!node)continue;
  // Script-owned validity is not user-edited state; always mirror it.
  if(typeof state.m==='string'&&typeof node.setCustomValidity==='function'&&(mirrored.get(node)??'')!==state.m){mirrored.set(node,state.m);customized.delete(node);node.setCustomValidity(state.m)}
  if(newerLocally(node,ack)||composing&&node===focused)continue;
  if(node.localName==='select'&&Array.isArray(state.s)){
   if(node.multiple){const selected=new Set(state.s);[...node.options].forEach((option,index)=>{if(option.selected!==selected.has(index))option.selected=selected.has(index)})}
   else{const index=state.s[0]??-1;if(node.selectedIndex!==index)node.selectedIndex=index}
  }else if(node.localName==='input'||node.localName==='textarea'){
   if(typeof state.v==='string'&&node.type!=='file'&&node.value!==state.v)node.value=state.v;
   if(node.localName==='input'&&typeof state.c==='boolean'&&node.checked!==state.c)node.checked=state.c;
   if(node.localName==='input'&&typeof state.i==='boolean'&&node.indeterminate!==state.i)node.indeterminate=state.i;
  }
 }
}
const observedIds=new Set(),observedNodes=new Map();
const box=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
const guestResize=new ResizeObserver(entries=>{
 const measurements=entries.slice(0,64).map(entry=>{const r=entry.contentRect;return {id:entry.target.getAttribute('data-tarobot-node'),rect:{width:r.width,height:r.height,top:r.top,left:r.left,right:r.right,bottom:r.bottom,x:r.x,y:r.y},box:box(entry.target)}});
 worker?.postMessage({type:'resize',entries:measurements});
});
function refreshObservers(){
 for(const id of observedIds){const node=selectDocument('[data-tarobot-node="'+id+'"]');const previous=observedNodes.get(id);if(node===previous)continue;if(previous)guestResize.unobserve(previous);if(node){observedNodes.set(id,node);guestResize.observe(node)}}
}
const appliedAttributes=new Map(),appliedRootStyle=new Set();
function applyAttributes(values){
 for(const [kind,node] of [['body',bodyElement],['root',htmlElement]]){
  const raw=values?.[kind];if(!Array.isArray(raw)||raw.length>24)continue;
  const next=new Map(raw.filter(item=>Array.isArray(item)&&item.length===2&&typeof item[0]==='string'&&typeof item[1]==='string'&&item[1].length<=2000&&/^(?:class|style|id|lang|dir|data-[a-z0-9_-]+|aria-[a-z0-9_-]+)$/i.test(item[0])));
  for(const name of appliedAttributes.get(kind)??[])if(!next.has(name)&&!(kind==='root'&&name==='style'))node.removeAttribute(name);
  for(const [name,value] of next){if(kind==='root'&&name==='style')continue;if(node.getAttribute(name)!==value)node.setAttribute(name,value)}
  if(kind==='root'){
   const style=createElement('span').style;style.cssText=next.get('style')??'';
   const nextStyle=new Set([...style].filter(name=>name!=='color-scheme'&&!allowedTheme.some(token=>'--'+token===name)));
   for(const name of appliedRootStyle)if(!nextStyle.has(name))node.style.removeProperty(name);
   for(const name of nextStyle)node.style.setProperty(name,style.getPropertyValue(name));
   appliedRootStyle.clear();for(const name of nextStyle)appliedRootStyle.add(name);
  }
  appliedAttributes.set(kind,new Set(next.keys()));
 }
}
const inspection=createElement('template');inspection.innerHTML=html;
// widgetDocument ships workerSource for a textual superset of these parsed
// scripts and non-empty handlers; this parsed DOM decides what runs.
const hasScripts=!!inspection.content.querySelector('script')||[...inspection.content.querySelectorAll('*')].some(node=>[...node.attributes].some(attr=>/^on[a-z]+$/i.test(attr.name)&&attr.value));
const blockControls=()=>{root.inert=true;root.setAttribute('aria-busy','true');for(const node of root.querySelectorAll('button,input,select,textarea'))node.disabled=true};
render(html); // useful static content survives unsupported scripts or termination
if(hasScripts)blockControls();
function stop(reason='cpu'){
 if(failed)return;failed=true;worker?.terminate();clearInterval(watchdog);if(renderFrame)cancelAnimationFrame(renderFrame);
 send('tarobot-widget-error',{persistent:true,reason});
}
// Scripts that cannot run here, or whose first snapshot exceeds a bound, are a
// deterministic outcome: keep the static rendering and never quarantine it.
function unsupported(stateKnown=false,state){
 if(failed)return;failed=true;worker?.terminate();clearInterval(watchdog);if(renderFrame)cancelAnimationFrame(renderFrame);
 fallbackStateKnown=stateKnown;fallbackState=state;
 // Static text remains selectable, but dead script controls never pretend to
 // accept input. Purely static documents never pass through this fallback.
 blockControls();if(!retiring){root.inert=false;root.removeAttribute('aria-busy')}
 send('tarobot-widget-error',{persistent:false,reason:'unsupported'});
 send('tarobot-widget-ready',{interactive:false});
 // init can finish as unsupported after retirement was already forwarded.
 // The Worker has supplied its terminal state and will no longer answer that
 // queued flush; settle the same request here before the App's timeout.
 if(retiring&&flushId)send('tarobot-widget-state-flushed',{id:flushId,ok:fallbackStateKnown,...(fallbackStateKnown&&fallbackState!==undefined?{state:fallbackState}:{})});
}
let sourceUrl=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
const releaseWorkerUrl=()=>{if(sourceUrl){URL.revokeObjectURL(sourceUrl);sourceUrl=undefined}};
try{if(hasScripts&&!failed){if(workerSource)worker=new Worker(sourceUrl);else unsupported(true)}}catch{unsupported(true)}finally{if(!worker)releaseWorkerUrl()}
let updates=0,windowAt=performance.now(),serial=0,composing=false,lastCompose=-Infinity;const pendingEscapes=new Map(),activePointers=new Set();
// One-use activation nonces for trusted clicks and Enter. Only these can
// authorize a composer handoff; hover, focus, wheel and timers never do.
const activations=new Map(),composeRequests=new Map();
const issueActivation=now=>{for(const [token,at] of activations)if(now-at>1500||activations.size>32)activations.delete(token);const token=freshNonce();activations.set(token,now);return token};
const composeText=value=>{if(typeof value!=='string')return;const text=value.trim();return text&&text.length<=4000&&!text.startsWith('/')&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)?text:undefined};
function receiveCompose(data){
 if(typeof data.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(data.id))return;
 const id=data.id,at=activations.get(data.gesture),now=performance.now(),text=composeText(data.text);activations.delete(data.gesture);
 if(at===undefined||now-at>1500||!text||failed||retiring||composeRequests.size||now-lastCompose<500||visibility(document)!=='visible'||!hasFocus(document)){worker?.postMessage({type:'compose-result',id,accepted:false});return}
 lastCompose=now;composeRequests.set(id,setTimeout(()=>{if(composeRequests.delete(id))worker?.postMessage({type:'compose-result',id,accepted:false})},6000));
 send('tarobot-widget-compose',{id,text});
}
const flush=()=>{
 renderFrame=0;if(failed)return;
 if(pendingHtml!==undefined){const value=pendingHtml;pendingHtml=undefined;render(value,pendingOverflow,pendingHtmlAck);if(failed)return;applyAttributes(pendingAttributes);refreshObservers();lastRender=performance.now()}
 if(pendingControls.length){const entries=pendingControls;pendingControls=[];applyControls(entries)}
 if(retiring)blockControls();
 else if(!interactiveReady){interactiveReady=true;root.inert=false;root.removeAttribute('aria-busy');send('tarobot-widget-ready',{interactive:true})}
};
const queueControls=(entries,ack)=>{
 const snapshotAck=Number.isFinite(ack)?ack:0;
 if(Array.isArray(entries))for(const entry of entries.slice(0,512))if(Array.isArray(entry)&&typeof entry[0]==='string'&&/^\d{1,8}$/.test(entry[0])&&entry[1]&&typeof entry[1]==='object')pendingControls.push([entry[0],entry[1],snapshotAck]);
 if(pendingControls.length>2048){stop('limit');return}
 if(!renderFrame)renderFrame=requestAnimationFrame(flush);
};
if(worker){worker.onmessage=event=>{
 releaseWorkerUrl();if(failed)return;let data;try{if(typeof event.data!=='string'||event.data.length>262144){stop('limit');return}data=JSON.parse(event.data)}catch{stop('limit');return}if(!data||typeof data!=='object')return;
 if(data.type==='state-flushed'&&retiring&&data.id===flushId){
  let valid=data.state===undefined;
  if(typeof data.state==='string'&&data.state.length<=16384)try{JSON.parse(data.state);valid=true}catch{/* Reject malformed state. */}
  worker.terminate();worker=undefined;clearInterval(watchdog);if(renderFrame)cancelAnimationFrame(renderFrame);failed=true;
  send('tarobot-widget-state-flushed',{id:flushId,ok:valid,...(valid&&data.state!==undefined?{state:data.state}:{})});return;
 }
 if(data.type==='observe'&&typeof data.id==='string'&&/^\d{1,8}$/.test(data.id)){if(!observedIds.has(data.id)&&observedIds.size>=64){stop('limit');return}observedIds.add(data.id);refreshObservers();return}
 if(data.type==='unobserve'){const node=observedNodes.get(data.id);if(node)guestResize.unobserve(node);observedNodes.delete(data.id);observedIds.delete(data.id);return}
 if(data.type==='event-result'){const timer=pendingEscapes.get(data.serial);if(timer){clearTimeout(timer);pendingEscapes.delete(data.serial);if(data.prevented!==true)send('tarobot-widget-close')}return}
 if(data.type==='pong'){if(awaitingNonce&&data.nonce===awaitingNonce){lastPong=performance.now();awaitingNonce=''}return}
 if(data.type==='render'||data.type==='controls'){
  const now=performance.now();if(now-windowAt>1000){windowAt=now;updates=0}if(++updates>30){stop('limit');return}
  if(data.type==='render'){
   // 128K authored characters plus up to 32 annotation characters per element.
   const overflow=snapshots++?()=>stop('limit'):unsupported;if(typeof data.html!=='string'||data.html.length>128*1024+32*2048){overflow();return}
   if(typeof data.bodyId==='string'&&/^\d{1,8}$/.test(data.bodyId))bodyId=data.bodyId;
   pendingHtml=data.html;pendingHtmlAck=Number.isFinite(data.ack)?data.ack:0;pendingAttributes={body:data.body,root:data.root};pendingOverflow=overflow;
  }
  queueControls(data.controls,data.ack);
 }else if(data.type==='error'){send('tarobot-widget-error',{persistent:data.persistent===true,...(typeof data.detail==='string'?{detail:data.detail.slice(0,500)}:{})});if(data.persistent)stop('error')}
 else if(data.type==='limit')stop('limit');
 else if(data.type==='unsupported'){
  let known=data.stateKnown===true;
  if(data.state!==undefined){known=known&&typeof data.state==='string'&&data.state.length<=16384;if(known)try{JSON.parse(data.state)}catch{known=false}}
  unsupported(known,known?data.state:undefined);
 }
 else if(data.type==='compose')receiveCompose(data);
 else if(data.type==='state'&&typeof data.state==='string'&&data.state.length<=16384){try{JSON.parse(data.state)}catch{return}send('tarobot-widget-state',{state:data.state})}
 else if(data.type==='interaction'&&typeof data.id==='string'&&/^\d{1,8}$/.test(data.id)){
  const node=root.querySelector('[data-tarobot-node="'+data.id+'"]');if(!node)return;
  if((data.name==='focus'||data.name==='scrollIntoView')&&performance.now()-lastGesture<1200)node[data.name]({preventScroll:true,block:'nearest'});
  else if(data.name==='blur')node.blur?.();
  // The browser's own constraint message when it sees the same failure;
  // otherwise the Worker's message (custom errors) until the user edits it.
  else if(data.name==='reportValidity'&&performance.now()-lastGesture<1200&&typeof node.reportValidity==='function'){
   if(node.checkValidity()&&typeof data.message==='string'&&data.message){node.setCustomValidity(data.message.slice(0,512));customized.add(node)}
   node.reportValidity();
  }
  else if((data.name==='setPointerCapture'||data.name==='releasePointerCapture')&&activePointers.has(data.pointerId))try{node[data.name](data.pointerId)}catch{/* The pointer is no longer active. */}
 }
};worker.onerror=()=>{releaseWorkerUrl();unsupported(false)};worker.postMessage({type:'init',html,theme:initialTheme,viewport:{width:root.clientWidth,height:320},reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,restore:typeof restore==='string'&&restore.length<=16384?restore:undefined})}
let lastWatch=performance.now();
if(worker)watchdog=setInterval(()=>{
 if(failed)return;
 const now=performance.now();
 // A suspended or busy parent cannot diagnose the Worker while its own timer is late.
 if(now-lastWatch>750){lastPong=now;awaitingNonce=''}
 lastWatch=now;
 if(performance.now()-lastPong>2000){releaseWorkerUrl();stop();return}
 if(!awaitingNonce){awaitingNonce=freshNonce();worker?.postMessage({type:'ping',nonce:awaitingNonce})}
},250);
const forwarded=['click','dblclick','input','change','keydown','keyup','mousedown','mouseup','mouseenter','mouseleave','mousemove','mouseover','mouseout','pointerenter','pointerleave','pointermove','pointerdown','pointerup','pointercancel','pointerover','pointerout','toggle','focusin','focusout','wheel','compositionstart','compositionend'];
// Only deliberate input refreshes the focus/scroll window; hover cannot move
// focus out of the App composer into a widget.
const deliberate=new Set(['click','dblclick','keydown','mousedown','mouseup','pointerdown','pointerup','input','change']),modifiers=new Set(['Shift','Control','Alt','Meta','CapsLock','Fn']);
const eventKeys=['key','code','location','repeat','isComposing','keyCode','charCode','which','button','buttons','detail','clientX','clientY','pageX','pageY','offsetX','offsetY','screenX','screenY','movementX','movementY','ctrlKey','metaKey','shiftKey','altKey','pointerId','pointerType','isPrimary','pressure','width','height','tiltX','tiltY','deltaX','deltaY','deltaZ','deltaMode','inputType','data'];
const throttled={mousemove:0,pointermove:0,wheel:0},wheel={deltaX:0,deltaY:0,deltaZ:0};let wheelTimer=0;
const controlState=target=>{
 if(target.localName==='select')return {selected:[...target.options].slice(0,256).flatMap((option,index)=>option.selected?[index]:[])};
 if(target.localName==='input'||target.localName==='textarea'){const value=target.value;return {value:value.slice(0,32768),checked:target.localName==='input'?target.checked:undefined,indeterminate:target.localName==='input'?target.indeterminate:undefined}}
 if(target.localName==='details')return {open:target.open};
 return {};
};
// Only genuine user changes carry real control state. Other events (keys,
// pointer, focus, composition) would replay a value the Worker has since
// replaced, such as a normalization not yet written back.
const carriesState=(name,target)=>name==='input'||name==='change'||name==='toggle'||name==='click'&&target.localName==='input'&&(target.type==='checkbox'||target.type==='radio');
// Border boxes of the target and its annotated ancestors, measured at event
// time, make clientX - getBoundingClientRect().left correct in the Worker.
const rectsFor=target=>{const rects=[];for(let node=target;node&&node!==root&&rects.length<9;node=node.parentElement){const id=node.getAttribute('data-tarobot-node');if(id)rects.push([id,box(node)])}return rects};
function forward(event,explicitId,trailing=false){
 const name=event.type,now=performance.now();
 if(name==='compositionstart')composing=true;else if(name==='compositionend')composing=false;
 if(event.isTrusted&&name==='pointerdown')activePointers.add(event.pointerId);else if(name==='pointerup'||name==='pointercancel')activePointers.delete(event.pointerId);
 const target=explicitId?undefined:event.target?.closest?.('[data-tarobot-node]'),id=explicitId??target?.getAttribute('data-tarobot-node');if(!id||failed||retiring||!worker)return;
 if(name==='toggle'&&patchedOpen.has(target)){const echo=patchedOpen.get(target)===target.open;patchedOpen.delete(target);if(echo)return}
 if(name==='wheel'&&!trailing){wheel.deltaX+=event.deltaX;wheel.deltaY+=event.deltaY;wheel.deltaZ+=event.deltaZ}
 if(name in throttled){
  if(now-throttled[name]<40){if(name==='wheel'&&!wheelTimer)wheelTimer=setTimeout(()=>{wheelTimer=0;forward(event,explicitId,true)},40);return}
  throttled[name]=now;
 }
 if(event.isTrusted&&deliberate.has(name)&&!(name==='keydown'&&modifiers.has(event.key)))lastGesture=now;
 if(name==='click'&&target?.closest('a'))event.preventDefault();
 let escape;if(name==='keydown'&&event.key==='Escape'&&!event.isComposing){event.preventDefault();escape=serial+1;pendingEscapes.set(escape,setTimeout(()=>{pendingEscapes.delete(escape);send('tarobot-widget-close')},250))}
 const gesture=event.isTrusted&&(name==='click'||name==='keydown'&&event.key==='Enter'&&!event.isComposing&&!event.repeat)?issueActivation(now):undefined;
 const message={type:'event',serial:++serial,id,name,bubbles:event.bubbles,cancelable:event.cancelable,escape,gesture,...(target&&carriesState(name,target)?controlState(target):{})};
 for(const key of eventKeys){const value=event[key];if(typeof value==='number'?Number.isFinite(value):typeof value==='boolean')message[key]=value;else if(typeof value==='string')message[key]=value.slice(0,256)}
 if(name==='wheel'){Object.assign(message,wheel);wheel.deltaX=wheel.deltaY=wheel.deltaZ=0}
 const related=event.relatedTarget?.closest?.('[data-tarobot-node]');if(related&&root.contains(related))message.relatedTarget=related.getAttribute('data-tarobot-node');
 if(target&&/^(?:pointer|mouse|click|dblclick|wheel)/.test(name))message.rects=rectsFor(target);
 if(target&&carriesState(name,target))localSerial.set(target,serial);
 if((name==='input'||name==='change')&&customized.has(target)){target.setCustomValidity(mirrored.get(target)??'');customized.delete(target)}
 if(name==='click'&&target?.localName==='summary'&&target.parentElement?.localName==='details')localSerial.set(target.parentElement,serial);
 worker.postMessage(message);
}
for(const name of forwarded)root.addEventListener(name,event=>forward(event),name==='wheel'?{capture:true,passive:true}:true);
// Keyboard shortcuts typed while the frame body has focus reach the Worker's body.
for(const name of ['keydown','keyup'])document.addEventListener(name,event=>{if(!root.contains(event.target)&&bodyId)forward(event,bodyId)},true);
addEventListener('message',event=>{
 if(event.source!==parent||event.data?.key!==key)return;const data=event.data;
 if(data.type==='tarobot-widget-state-flush'&&!retiring&&typeof data.id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(data.id)){
  retiring=true;flushId=data.id;activations.clear();blockControls();
  if(worker&&!failed)worker.postMessage({type:'state-flush',id:flushId});
  else send('tarobot-widget-state-flushed',{id:flushId,ok:!failed||fallbackStateKnown,...(fallbackStateKnown&&fallbackState!==undefined?{state:fallbackState}:{})});
  return;
 }
 if(retiring)return;
 if(data.type==='tarobot-widget-theme'){applyTheme(data.theme);worker?.postMessage({type:'theme',theme:data.theme})}
 else if(data.type==='tarobot-widget-compose-result'&&typeof data.id==='string'){const timer=composeRequests.get(data.id);if(timer!==undefined){clearTimeout(timer);composeRequests.delete(data.id);worker?.postMessage({type:'compose-result',id:data.id,accepted:data.accepted===true})}}
});
addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented)send('tarobot-widget-close')});
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');const updateMotion=()=>worker?.postMessage({type:'media',reducedMotion:reducedMotion.matches});reducedMotion.addEventListener('change',updateMotion);
// A native keyboard shrinks the expanded iframe after the browser's initial
// focus scroll. Reveal the actual focused editor in the new viewport. This
// only scrolls real DOM; it never creates activation or asks the Worker to focus.
let viewportHeight=innerHeight,focusScroll=0;
const revealEditor=()=>{
 const shrinking=innerHeight<viewportHeight-1;viewportHeight=innerHeight;if(!shrinking)return;
 if(focusScroll)cancelAnimationFrame(focusScroll);
 focusScroll=requestAnimationFrame(()=>{
  focusScroll=0;const node=activeOf(document);
  if(!node||!root.contains(node)||!node.matches('textarea,input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=reset]):not([type=hidden])'))return;
  const rect=node.getBoundingClientRect();if(rect.top<0||rect.bottom>innerHeight)node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
 });
};
addEventListener('resize',revealEditor);
// A ready transport is separate from a usable authored UI. Flush can reach a
// busy initializing Worker without making its unbound static controls active.
send('tarobot-widget-started');
if(!hasScripts)send('tarobot-widget-ready',{interactive:false});
let height=0;const resize=new ResizeObserver(()=>{const next=Math.ceil(bodyElement.getBoundingClientRect().height);if(next!==height){height=next;send('tarobot-widget-height',{height})}worker?.postMessage({type:'viewport',viewport:{width:root.clientWidth,height:next}})});resize.observe(bodyElement);
addEventListener('pagehide',()=>{removeEventListener('resize',revealEditor);if(focusScroll)cancelAnimationFrame(focusScroll);reducedMotion.removeEventListener('change',updateMotion);releaseWorkerUrl();worker?.terminate();clearInterval(watchdog);clearTimeout(wheelTimer);for(const timer of [...pendingEscapes.values(),...composeRequests.values()])clearTimeout(timer);resize.disconnect();guestResize.disconnect()});
