import { parseHTML } from 'linkedom/worker';
// This runs in an opaque-origin dedicated Worker. Captured transport stays in
// this closure; guest code is evaluated in a different function scope.
const transport = postMessage.bind(self), stringify = JSON.stringify, listen = addEventListener.bind(self), ownKeys = Object.keys, isArray = Array.isArray;
// Guest code can still reach this real global and shared prototypes. Message
// intake reads through primitives captured before any guest script runs.
const uncurry = fn => Function.prototype.call.bind(fn);
const messageData = uncurry(Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get), stopMessage = uncurry(Event.prototype.stopImmediatePropagation), NativeFormData = self.FormData;
// Encode only own data of runtime message literals. JSON.stringify would call
// a toJSON that guest code can install on shared prototypes and so forge any
// message type; primitives never consult toJSON.
const encode = value => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return stringify(value);
  if (typeof value !== 'object') return undefined;
  let text = '';
  if (isArray(value)) { for (let index = 0; index < value.length; index++) text += (index ? ',' : '') + (encode(value[index]) ?? 'null'); return '[' + text + ']'; }
  const keys = ownKeys(value);
  for (let index = 0; index < keys.length; index++) { const item = encode(value[keys[index]]); if (item !== undefined) text += (text ? ',' : '') + stringify(keys[index]) + ':' + item; }
  return '{' + text + '}';
};
let transportClosed=false, transportAt=0, transportMessages=0, transportBytes=0;
const send = (data, overflow='limit') => {
  if(transportClosed)return;
  const now=nativeNow();if(now-transportAt>=1000){transportAt=now;transportMessages=0;transportBytes=0}
  let text;try{text=encode(data)}catch{/* Cyclic or overly deep guest values close the transport. */}
  if(typeof text!=='string'||text.length>262144){transportClosed=true;transport(overflow==='unsupported'?encode({type:'unsupported',stateKnown:true,...(pendingState===undefined?{}:{state:pendingState})}):'{"type":"limit"}');return}
  if(++transportMessages>128||(transportBytes+=text.length)>2*1024*1024){transportClosed=true;transport('{"type":"limit"}');return}
  transport(text);
};
const later = setTimeout.bind(self), cancel = clearTimeout.bind(self);
const nativeNow = performance.now.bind(performance);
// Capability boundary: authored code gets ECMAScript built-ins, timers,
// microtasks, crypto random values and the virtual DOM below. Networking,
// storage, messaging, nested workers, GPU, media codecs, font loading and
// canvases are removed. CSP and the opaque origin still enforce the network
// boundary for syntax that cannot be removed, such as dynamic import().
for (const name of ['postMessage','Worker','SharedWorker','WebSocket','EventSource','BroadcastChannel','RTCPeerConnection','webkitRTCPeerConnection','importScripts','fetch','XMLHttpRequest','indexedDB','caches','OffscreenCanvas','createImageBitmap','VideoDecoder','AudioDecoder','VideoEncoder','AudioEncoder','ImageDecoder','FontFace','fonts','WebTransport','WebSocketStream']) {
  for (let object = self; object; object = Object.getPrototypeOf(object)) {
    if (object === self || Object.hasOwn(object, name)) {
      try { Object.defineProperty(object, name, {value:undefined, writable:false, configurable:false}); } catch { /* CSP + opaque origin remain mandatory. */ }
    }
  }
}
for (const name of ['gpu','ml']) for (let object = navigator; object; object = Object.getPrototypeOf(object)) {
  if (Object.hasOwn(object, name)) try { Object.defineProperty(object, name, {value:undefined, writable:false, configurable:false}); } catch { /* Not exposed in this engine. */ }
}
// Opaque origins are not secure contexts, so randomUUID is absent; generated
// ids are a common authoring pattern and need no extra capability.
if (self.crypto && typeof crypto.randomUUID !== 'function') try { Object.defineProperty(crypto, 'randomUUID', {value(){const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`}}); } catch { /* Optional convenience. */ }
let doc, win, windowEvents, events, evaluateHandler, resizeObservers=new Set(), mediaQueries=new Set(), reducedMotion=false, geometry=new Map(), viewport={width:600,height:320}, theme={}, nodes=new Map(), ids=new WeakMap(), nextId=0;
let renderTimer=0, lastRender=0, nextRenderAt=0, lastSnapshot="", started=false, reportedErrors=[];
// Live control properties (value, checkedness, selectedness) are not markup
// attributes. They are sent separately and acknowledged by event serial so a
// stale snapshot never overwrites newer user input in the real control.
let live=new WeakMap(), sentControls=new Map(), ack=0, activeElement, activation='', composeSerial=0;
const composeRequests=new Map(), pointerCaptures=new Map();
const error = cause => {
  const now=nativeNow();reportedErrors=reportedErrors.filter(at=>now-at<2000);reportedErrors.push(now);
  let detail;try{const value=typeof cause==='string'?cause:cause?.message;if(typeof value==='string')detail=value.slice(0,500)}catch{/* Error accessors are untrusted. */}
  send({type:'error',persistent:reportedErrors.length>=3,...(detail?{detail}:{})});
};
listen('error',event=>{event.preventDefault();error(event.error??event.reason??event.message)});listen('unhandledrejection',event=>{event.preventDefault();error(event.error??event.reason??event.message)});
function schedule(interactive=false) {
  if (renderTimer && !interactive) return;
  if (renderTimer) cancel(renderTimer);
  const now=nativeNow();
  renderTimer=later(()=>{renderTimer=0;render()},Math.max(0,(interactive?40:250)-(now-lastRender),nextRenderAt-now));
}
// Live properties change no markup, so MutationObserver never sees them; a
// script setter (including from a timer or promise) queues one coalesced render.
const queueRender=()=>{if(!renderTimer)schedule(true)};
// Prompt handoff authority: the viewer issues a one-use nonce only for a
// trusted click or Enter. It is visible here only while that click (or the
// submit it causes) is dispatched synchronously, so timers, awaits, loading
// and hover cannot obtain it. The App decides; true means the draft accepted it.
function compose(text) {
  return new Promise(resolve => {
    const gesture=activation;
    if(!gesture||typeof text!=='string'||text.length>4000||composeRequests.size>=4){resolve(false);return}
    const id='compose_'+(++composeSerial);composeRequests.set(id,resolve);
    later(()=>{if(composeRequests.delete(id))resolve(false)},10000);
    send({type:'compose',id,text,gesture});
  });
}
// Authored selection state: bounded JSON data, coalesced to at most four
// updates per second. The App keeps it in window memory for this message.
const utf8=new TextEncoder();let stateTimer=0,stateSentAt=-Infinity,pendingState,stateRetiring=false;
function setState(value){
  if(stateRetiring)return false;
  let text;try{text=encode(value)}catch{return false}
  if(typeof text!=='string'||text.length>16384||utf8.encode(text).length>16384)return false;
  pendingState=text;if(!stateTimer)stateTimer=later(()=>{stateTimer=0;stateSentAt=nativeNow();send({type:'state',state:pendingState})},Math.max(0,250-(nativeNow()-stateSentAt)));
  return true;
}
// Deterministic initialization fallback still carries any explicit state the
// script already processed. Absence here is proven, not inferred from a timer.
function unsupportedSnapshot(){stateRetiring=true;cancel(stateTimer);stateTimer=0;send({type:'unsupported',stateKnown:true,...(pendingState===undefined?{}:{state:pendingState})})}

const inputTypes=new Set(['hidden','text','search','tel','url','email','password','date','month','week','time','datetime-local','number','range','color','checkbox','radio','file','submit','image','reset','button']);
const textLike=new Set(['text','search','url','tel','email','password','date','month','week','time','datetime-local','number']);
const typeOf=node=>{const type=(node.getAttribute('type')??'').toLowerCase();return inputTypes.has(type)?type:'text'};
const checkable=node=>node.localName==='input'&&(typeOf(node)==='checkbox'||typeOf(node)==='radio');
const own=node=>{let state=live.get(node);if(!state)live.set(node,state={});return state};
const number=(value,fallback)=>{const parsed=parseFloat(value);return Number.isFinite(parsed)?parsed:fallback};
const formOf=node=>{const id=node.getAttribute('form');if(id){const form=doc.getElementById(id);return form?.localName==='form'?form:null}return node.closest('form')};
const isSubmit=node=>node.localName==='button'?!['reset','button'].includes((node.getAttribute('type')??'').toLowerCase()):node.localName==='input'&&['submit','image'].includes(typeOf(node));
const isReset=node=>(node.localName==='button'||node.localName==='input')&&(node.getAttribute('type')??'').toLowerCase()==='reset';
function sanitizeValue(node,raw){
  const type=typeOf(node),value=String(raw??'');
  if(type==='range'){
    const min=number(node.getAttribute('min'),0),max=Math.max(min,number(node.getAttribute('max'),100)),step=node.getAttribute('step');
    let next=Math.min(max,Math.max(min,number(value,min+(max-min)/2)));
    if(step!=='any'){const size=number(step,1)>0?number(step,1):1;next=min+Math.round((next-min)/size)*size;if(next>max)next-=size}
    return String(+next.toFixed(10));
  }
  if(type==='number')return /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)?value:'';
  if(type==='color')return /^#[0-9a-f]{6}$/i.test(value)?value.toLowerCase():'#000000';
  return ['text','search','tel','url','email','password'].includes(type)?value.replace(/[\r\n]/g,''):value;
}
const valueMode=node=>{const type=typeOf(node);return checkable(node)?'on':['hidden','submit','image','reset','button'].includes(type)?'default':type==='file'?'file':'value'};
function inputValue(node,current=true){
  const mode=valueMode(node);if(mode==='on')return node.getAttribute('value')??'on';if(mode==='default')return node.getAttribute('value')??'';if(mode==='file')return '';
  const state=current?live.get(node):undefined;return state&&'value' in state?state.value:sanitizeValue(node,node.getAttribute('value')??'');
}
function setInputValue(node,value){const mode=valueMode(node);if(mode==='value'){own(node).value=sanitizeValue(node,value);queueRender()}else if(mode!=='file')node.setAttribute('value',String(value??''))}
const checkedOf=(node,current=true)=>{const state=current?live.get(node):undefined;return state&&'checked' in state?state.checked:node.hasAttribute('checked')};
const radioGroup=node=>{const name=node.getAttribute('name');if(!name||!doc.contains(node))return [node];const form=formOf(node);return [...doc.querySelectorAll('input')].filter(other=>typeOf(other)==='radio'&&other.getAttribute('name')===name&&formOf(other)===form)};
function setChecked(node,value){own(node).checked=!!value;if(value&&typeOf(node)==='radio')for(const other of radioGroup(node))if(other!==node)own(other).checked=false;queueRender()}
const optionsOf=select=>[...select.querySelectorAll('option')];
function selectedIndices(select,current=true){
  const options=optionsOf(select),flags=options.map(option=>{const state=current?live.get(option):undefined;return state&&'selected' in state?state.selected:option.hasAttribute('selected')});
  if(select.hasAttribute('multiple'))return flags.flatMap((flag,index)=>flag?[index]:[]);
  if(current&&live.get(select)?.none)return [];
  let index=flags.lastIndexOf(true);if(index<0&&!(number(select.getAttribute('size'),1)>1))index=options.findIndex(option=>!option.hasAttribute('disabled'));
  return index<0?[]:[index];
}
function selectIndex(select,index){
  const options=optionsOf(select);own(select).none=!options[index];
  for(let i=0;i<options.length;i++)own(options[i]).selected=i===index;
  queueRender();
}
function controlState(node,current=true){
  let state;
  if(node.localName==='select')state={s:selectedIndices(node,current)};
  else if(node.localName==='textarea')state={v:current?node.value:node.textContent};
  else if(node.localName!=='input'||['file','hidden','submit','reset','button','image'].includes(typeOf(node)))return;
  else state=checkable(node)?{c:checkedOf(node,current),i:current&&live.get(node)?.indeterminate===true}:{v:inputValue(node,current)};
  // Script-owned custom validity travels with the control so the real one
  // shows the same :invalid state and message, including when cleared.
  state.m=current?String(live.get(node)?.custom??'').slice(0,512):'';
  return state;
}
const liveChecked='data-tarobot-live-checked',identifierChar=/[\w\u00a0-\uffff-]/;
function liveSelector(selector){
  if(typeof selector!=='string'||!/:checked/i.test(selector))return selector;
  let out='',index=0,brackets=0;
  while(index<selector.length){
    const char=selector[index];
    if(char==='\\'){out+=selector.slice(index,index+2);index+=2;continue}
    if(char==='"'||char==="'"){let end=index+1;while(end<selector.length&&selector[end]!==char)end+=selector[end]==='\\'?2:1;out+=selector.slice(index,end+1);index=end+1;continue}
    if(char==='['||char===']'){brackets=Math.max(0,brackets+(char==='['?1:-1));out+=char;index++;continue}
    if(!brackets&&char===':'&&selector[index+1]!==':'&&selector[index-1]!==':'&&selector.slice(index+1,index+8).toLowerCase()==='checked'&&!identifierChar.test(selector[index+8]??'')&&selector[index+8]!=='\\'){out+=`[${liveChecked}]`;index+=8;continue}
    out+=char;index++;
  }
  return out;
}
function formControls(form){
  const selector='input,select,textarea,button,fieldset,output,object',seen=new Set(),list=[];
  for(const node of [...form.querySelectorAll(selector),...(form.id?doc.querySelectorAll(`[form="${form.id.replace(/["\\]/g,'\\$&')}"]`):[])])if(!seen.has(node)&&formOf(node)===form){seen.add(node);list.push(node)}
  return list;
}
function trusted(event){Object.defineProperty(event,'isTrusted',{value:true});return event}
function fire(node,event){try{return node.dispatchEvent(event)}catch(cause){error(cause);return true}}
function submitForm(form,submitter){if(interactivelyValid(form,submitter))fire(form,trusted(new events.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter})))}
function resetForm(form){
  if(!fire(form,trusted(new events.Event('reset',{bubbles:true,cancelable:true}))))return;
  // Reset restores values and selection; like browsers, it keeps custom validity.
  for(const control of formControls(form)){const custom=live.get(control)?.custom;live.delete(control);if(custom)own(control).custom=custom;if(control.localName==='select')for(const option of optionsOf(control))live.delete(option)}
  schedule(true);
}
// Buttons and Enter submit a form owned by the Worker. The real document has
// no form element: sandboxed frames would block submission without an event.
function defaultAction(target,programmatic){
  const control=target.closest?.('button,input,summary,label');if(!control)return;
  if(control.localName==='button'||control.localName==='input'){
    if(control.hasAttribute('disabled'))return;const form=formOf(control);if(!form)return;
    if(isSubmit(control))submitForm(form,control);else if(isReset(control))resetForm(form);
  }else if(programmatic&&control.localName==='summary'){const details=control.parentElement;if(details?.localName==='details'&&details.querySelector('summary')===control)details.open=!details.open}
  else if(programmatic&&control.localName==='label'){const id=control.getAttribute('for'),labelled=id?doc.getElementById(id):control.querySelector('input,select,textarea,button');if(labelled&&labelled!==target&&!labelled.contains(target))labelled.click?.()}
}
function implicitSubmit(target){
  if(target.localName!=='input'||!textLike.has(typeOf(target)))return;const form=formOf(target);if(!form)return;
  const controls=formControls(form),button=controls.find(isSubmit);
  if(button){if(!button.hasAttribute('disabled')&&fire(button,trusted(new events.MouseEvent('click',{bubbles:true,cancelable:true}))))submitForm(form,button)}
  else if(controls.filter(control=>control.localName==='input'&&textLike.has(typeOf(control))).length<=1)submitForm(form,null);
}
function click(element){
  if(['button','input','select','textarea'].includes(element.localName)&&element.hasAttribute('disabled'))return;
  const type=element.localName==='input'&&typeOf(element);let previous;
  if(type==='checkbox'){previous=element.checked;element.checked=!previous}else if(type==='radio'){previous=radioGroup(element).find(radio=>radio.checked)??null;element.checked=true}
  const proceed=fire(element,new events.MouseEvent('click',{bubbles:true,cancelable:true}));
  if(type==='checkbox'||type==='radio'){
    if(!proceed){if(type==='checkbox')element.checked=previous;else if(previous)previous.checked=true;else own(element).checked=false}
    else if(type==='checkbox'||previous!==element){fire(element,new events.InputEvent('input',{bubbles:true}));fire(element,new events.Event('change',{bubbles:true}))}
  }
  if(proceed)defaultAction(element,true);schedule(true);
}
const dateValue=(type,value)=>{
  let match;
  if(type==='date'&&(match=/^(\d{4,})-(\d\d)-(\d\d)$/.exec(value)))return Date.UTC(+match[1],+match[2]-1,+match[3]);
  if(type==='month'&&(match=/^(\d{4,})-(\d\d)$/.exec(value)))return (+match[1]-1970)*12+(+match[2]-1);
  if(type==='time'&&(match=/^(\d\d):(\d\d)(?::(\d\d(?:\.\d+)?))?$/.exec(value)))return ((+match[1]*60+ +match[2])*60+number(match[3],0))*1000;
  if(type==='datetime-local'&&(match=/^(\d{4,})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d(?:\.\d+)?))?$/.exec(value)))return Date.UTC(+match[1],+match[2]-1,+match[3],+match[4],+match[5])+number(match[6],0)*1000;
  return NaN;
};
const valueNumber=node=>{const type=typeOf(node),value=node.value;return type==='number'||type==='range'?value===''?NaN:parseFloat(value):dateValue(type,value)};
const emailAddress=/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const matchesPattern=(pattern,value)=>{for(const flags of ['v','u'])try{return new RegExp('^(?:'+pattern+')$',flags).test(value)}catch{/* Try the older flag; an invalid pattern never blocks. */}return true};
// Constraint validation as in HTML for: required, type email/url, pattern,
// minlength/maxlength, min/max on number/range/date/time/month and custom
// errors. Not implemented: step mismatch and badInput. Length limits apply to
// script-set values as well as edits.
const candidate=node=>['input','select','textarea'].includes(node.localName)&&!node.hasAttribute('disabled')&&!node.closest('fieldset[disabled]')&&!(node.localName!=='select'&&node.hasAttribute('readonly'))&&!(node.localName==='input'&&['hidden','reset','button','submit','image'].includes(typeOf(node)))&&!node.closest('datalist');
function validity(node){
  const tag=node.localName,type=tag==='input'?typeOf(node):tag,value=String(node.value??''),state={valueMissing:false,typeMismatch:false,patternMismatch:false,tooLong:false,tooShort:false,rangeUnderflow:false,rangeOverflow:false,stepMismatch:false,badInput:false,customError:false};
  if(candidate(node)){
    state.customError=!!live.get(node)?.custom;
    const empty=tag==='input'&&checkable(node)?!(type==='radio'?radioGroup(node).some(radio=>radio.checked):node.checked):value==='';
    state.valueMissing=node.hasAttribute('required')&&empty;
    if(value!==''&&tag!=='select'&&!checkable(node)){
      if(type==='email')state.typeMismatch=(node.hasAttribute('multiple')?value.split(','):[value]).some(item=>!emailAddress.test(item.trim()));
      if(type==='url')try{new URL(value)}catch{state.typeMismatch=true}
      if(node.hasAttribute('pattern')&&['text','search','url','tel','email','password'].includes(type))state.patternMismatch=!matchesPattern(node.getAttribute('pattern'),value);
      const shortest=number(node.getAttribute('minlength'),-1),longest=number(node.getAttribute('maxlength'),-1);state.tooShort=shortest>=0&&value.length<shortest;state.tooLong=longest>=0&&value.length>longest;
      if(['number','range','date','month','time','datetime-local'].includes(type)){
        const n=valueNumber(node),bound=name=>node.hasAttribute(name)?type==='number'||type==='range'?number(node.getAttribute(name),NaN):dateValue(type,node.getAttribute(name)):NaN;
        if(Number.isFinite(n)){state.rangeUnderflow=n<bound('min');state.rangeOverflow=n>bound('max')}
      }
    }
  }
  return {...state,valid:!Object.values(state).some(Boolean)};
}
function validationMessage(node){
  const state=validity(node),type=node.localName==='input'?typeOf(node):node.localName;
  if(state.customError)return live.get(node).custom;
  if(state.valueMissing)return type==='checkbox'?'Please check this box if you want to proceed.':type==='radio'||type==='select'?'Please select one of these options.':'Please fill out this field.';
  if(state.typeMismatch)return type==='email'?'Please enter an email address.':'Please enter a URL.';
  if(state.patternMismatch)return 'Please match the requested format.';
  if(state.tooShort)return `Please use at least ${node.getAttribute('minlength')} characters.`;
  if(state.tooLong)return `Please use no more than ${node.getAttribute('maxlength')} characters.`;
  const dated=['date','month','time','datetime-local'].includes(type);
  if(state.rangeUnderflow)return `Value must be ${dated?'':'greater than or equal to '}${node.getAttribute('min')}${dated?' or later':''}.`;
  if(state.rangeOverflow)return `Value must be ${dated?'':'less than or equal to '}${node.getAttribute('max')}${dated?' or earlier':''}.`;
  return '';
}
// The real control shows the browser's own message (or this one when only the
// Worker can see the failure) after a recent deliberate user action.
const reportInvalid=node=>send({type:'interaction',name:'reportValidity',id:identify(node),message:validationMessage(node).slice(0,512)});
// Interactive validation before submit: every failing control receives
// `invalid`; the first uncanceled one is reported. novalidate/formnovalidate skip it.
function interactivelyValid(form,submitter){
  if(form.hasAttribute('novalidate')||submitter?.hasAttribute?.('formnovalidate'))return true;
  let invalid=false,first;
  for(const control of formControls(form))if(candidate(control)&&!validity(control).valid){invalid=true;if(fire(control,trusted(new events.Event('invalid',{cancelable:true})))&&!first)first=control}
  if(first)reportInvalid(first);
  return !invalid;
}
const eventNames=['click','dblclick','contextmenu','mousedown','mouseup','mousemove','mouseover','mouseout','mouseenter','mouseleave','pointerdown','pointerup','pointermove','pointerover','pointerout','pointerenter','pointerleave','pointercancel','gotpointercapture','lostpointercapture','wheel','keydown','keyup','keypress','input','change','focus','blur','focusin','focusout','toggle','submit','reset','invalid','compositionstart','compositionend','load','error','scroll','select'];
const globalEventNames=['click','keydown','keyup','pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','wheel','input','change','submit','resize','load'];
// LinkeDOM's simplified dispatch has no capture phase, calls listeners with
// the target instead of currentTarget, ignores bubbles for the path and lets
// one throwing listener abort the rest. Widgets rely on browser semantics.
function installEvents(parsed){
  const Base=parsed.Event,listeners=new WeakMap(),handlers=new WeakMap();let passive=false;
  const flags=options=>typeof options==='object'&&options!==null?options:{capture:!!options};
  const parentOf=node=>node===doc?windowEvents:node===windowEvents?null:node._getParent?.()??null;
  const define=(target,properties)=>{for(const [name,descriptor] of Object.entries(properties))Object.defineProperty(target,name,{configurable:true,writable:true,...descriptor})};
  define(parsed.EventTarget.prototype,{
    addEventListener:{value(type,callback,options){
      if(!callback||typeof callback!=='function'&&typeof callback!=='object')return;
      const {capture=false,once=false,passive:quiet=false,signal}=flags(options);if(signal?.aborted)return;
      let types=listeners.get(this);if(!types)listeners.set(this,types=new Map());type=String(type);let list=types.get(type);if(!list)types.set(type,list=[]);
      if(list.some(entry=>entry.callback===callback&&entry.capture===!!capture))return;
      list.push({callback,capture:!!capture,once:!!once,passive:!!quiet});
      signal?.addEventListener?.('abort',()=>this.removeEventListener(type,callback,{capture}),{once:true});
    }},
    removeEventListener:{value(type,callback,options){
      const list=listeners.get(this)?.get(String(type));if(!list)return;const capture=!!flags(options).capture,index=list.findIndex(entry=>entry.callback===callback&&entry.capture===capture);
      if(index>=0){list[index].removed=true;list.splice(index,1)}
    }},
    dispatchEvent:{value(event){
      if(!(event instanceof Base))throw new TypeError("Failed to execute 'dispatchEvent': parameter 1 is not of type 'Event'.");
      const path=[];for(let node=this;node&&path.length<4096;node=parentOf(node))path.push(node);
      event.target=event.srcElement=this;event._path=path.map(currentTarget=>({currentTarget}));
      const invoke=(node,phase,capture)=>{
        const list=listeners.get(node)?.get(event.type);if(!list?.length)return;event.currentTarget=node;event.eventPhase=phase;
        for(const entry of [...list]){
          if(entry.removed||entry.capture!==capture)continue;if(entry.once)node.removeEventListener(event.type,entry.callback,entry.capture);
          passive=entry.passive;try{typeof entry.callback==='function'?entry.callback.call(node,event):entry.callback.handleEvent(event)}catch(cause){error(cause)}passive=false;
          if(event._stopImmediatePropagationFlag)return;
        }
      };
      for(let index=path.length-1;index>0&&!event.cancelBubble;index--)invoke(path[index],1,true);
      if(!event.cancelBubble)invoke(this,2,true);if(!event.cancelBubble)invoke(this,2,false);
      if(event.bubbles)for(let index=1;index<path.length&&!event.cancelBubble;index++)invoke(path[index],3,false);
      event.currentTarget=null;event.eventPhase=0;event._path=[];event.cancelBubble=false;event._stopImmediatePropagationFlag=false;
      return !event.defaultPrevented;
    }},
  });
  define(Base.prototype,{preventDefault:{value(){if(this.cancelable&&!passive){this.defaultPrevented=true;this.returnValue=false}}}});
  Object.defineProperty(Base.prototype,'isTrusted',{configurable:true,get:()=>false});
  // Event-handler properties: SVG elements, documents and the virtual window
  // have none in LinkeDOM. A false return cancels, as in browsers.
  const handler=(name,owner)=>({get(){return handlers.get(owner??this)?.[name]?.callback??null},set(value){
    const key=owner??this,target=owner??this;let map=handlers.get(key);if(!map)handlers.set(key,map={});const type=name.slice(2);
    if(map[name])target.removeEventListener(type,map[name].listener);
    map[name]=typeof value==='function'?{callback:value,listener(event){if(value.call(this,event)===false)event.preventDefault()}}:undefined;
    if(map[name])target.addEventListener(type,map[name].listener);
  }});
  for(const target of [parsed.Element.prototype,parsed.HTMLElement.prototype])for(const name of eventNames)Object.defineProperty(target,'on'+name,{configurable:true,...handler('on'+name)});
  for(const name of globalEventNames)Object.defineProperty(doc,'on'+name,{configurable:true,...handler('on'+name,doc)});
  const modifier=(event,key)=>!!event[{Control:'ctrlKey',Shift:'shiftKey',Alt:'altKey',Meta:'metaKey'}[key]];
  const defaults={relatedTarget:null,ctrlKey:false,shiftKey:false,altKey:false,metaKey:false,isPrimary:false,repeat:false,isComposing:false,key:'',code:'',pointerType:'',inputType:'',data:null};
  const fill=(event,init,keys)=>{for(const key of keys)event[key]=init[key]??(key in defaults?defaults[key]:0)};
  const mouseKeys=['screenX','screenY','clientX','clientY','pageX','pageY','offsetX','offsetY','movementX','movementY','button','buttons','ctrlKey','shiftKey','altKey','metaKey','relatedTarget'];
  class UIEvent extends Base{constructor(type,init={}){super(type,init);this.detail=init.detail??0;this.view=init.view??null}}
  class MouseEvent extends UIEvent{constructor(type,init={}){super(type,init);fill(this,init,mouseKeys);this.x=this.clientX;this.y=this.clientY;this.which=init.which??this.button+1}getModifierState(key){return modifier(this,key)}}
  class PointerEvent extends MouseEvent{constructor(type,init={}){super(type,init);fill(this,init,['pointerId','pressure','tangentialPressure','tiltX','tiltY','twist','pointerType','isPrimary']);this.width=init.width??1;this.height=init.height??1}}
  class WheelEvent extends MouseEvent{constructor(type,init={}){super(type,init);fill(this,init,['deltaX','deltaY','deltaZ','deltaMode'])}}
  class KeyboardEvent extends UIEvent{constructor(type,init={}){super(type,init);fill(this,init,['key','code','location','ctrlKey','shiftKey','altKey','metaKey','repeat','isComposing','keyCode','charCode','which'])}getModifierState(key){return modifier(this,key)}}
  class FocusEvent extends UIEvent{constructor(type,init={}){super(type,init);this.relatedTarget=init.relatedTarget??null}}
  class InputEvent extends UIEvent{constructor(type,init={}){super(type,init);fill(this,init,['data','inputType','isComposing']);this.dataTransfer=null}}
  class CompositionEvent extends UIEvent{constructor(type,init={}){super(type,init);this.data=init.data??''}}
  class SubmitEvent extends Base{constructor(type,init={}){super(type,init);this.submitter=init.submitter??null}}
  events={Event:Base,UIEvent,MouseEvent,PointerEvent,WheelEvent,KeyboardEvent,FocusEvent,InputEvent,CompositionEvent,SubmitEvent};
  return handler;
}
function installControls(parsed){
  const {Element,HTMLElement,HTMLInputElement:Input,HTMLTextAreaElement:TextArea,HTMLSelectElement:Select,HTMLOptionElement:OptionElement,HTMLButtonElement:Button,HTMLFormElement:Form,HTMLDetailsElement:Details}=parsed;
  const define=(target,properties)=>{for(const [name,descriptor] of Object.entries(properties))Object.defineProperty(target,name,{configurable:true,...descriptor})};
  // LinkeDOM has only an innerText getter. Match the browser's assignment
  // semantics (plain text and explicit line breaks), without claiming its
  // getter can measure rendered CSS or layout in this Worker.
  let innerText;for(let proto=HTMLElement.prototype;proto&&!innerText;proto=Object.getPrototypeOf(proto))innerText=Object.getOwnPropertyDescriptor(proto,'innerText');
  define(HTMLElement.prototype,{innerText:{get:innerText?.get??function(){return this.textContent},set(value){
    const lines=String(value===null?'':value).replace(/\r\n?/g,'\n').split('\n');this.replaceChildren();
    lines.forEach((line,index)=>{if(index)this.appendChild(doc.createElement('br'));this.appendChild(doc.createTextNode(line))});
  }}});
  const reflect=attribute=>({get(){return this.getAttribute(attribute)??''},set(value){this.setAttribute(attribute,String(value))}});
  const flag=attribute=>({get(){return this.hasAttribute(attribute)},set(value){this.toggleAttribute(attribute,!!value)}});
  const noop={value(){}},form={get(){return formOf(this)}};
  const validation={
    validity:{get(){return validity(this)}},willValidate:{get(){return candidate(this)}},
    validationMessage:{get(){return validationMessage(this)}},
    setCustomValidity:{value(message){own(this).custom=String(message??'');queueRender()}},
    checkValidity:{value(){const valid=validity(this).valid;if(!valid)fire(this,trusted(new events.Event('invalid',{cancelable:true})));return valid}},
    reportValidity:{value(){if(validity(this).valid)return true;if(fire(this,trusted(new events.Event('invalid',{cancelable:true}))))reportInvalid(this);return false}},
  };
  const step=(node,count)=>{
    const type=typeOf(node);if(type!=='number'&&type!=='range')throw new DOMException('This form element is not steppable.','InvalidStateError');
    if(node.getAttribute('step')==='any')throw new DOMException('This form element does not have an allowed value step.','InvalidStateError');
    const size=number(node.getAttribute('step'),1)>0?number(node.getAttribute('step'),1):1;let next=number(node.value,0)+size*Number(count??1);
    if(node.hasAttribute('min'))next=Math.max(next,number(node.getAttribute('min'),next));if(node.hasAttribute('max'))next=Math.min(next,number(node.getAttribute('max'),next));
    setInputValue(node,String(+next.toFixed(10)));
  };
  define(Input.prototype,{
    type:{get(){return typeOf(this)},set(value){this.setAttribute('type',String(value))}},
    value:{get(){return inputValue(this)},set(value){setInputValue(this,value)}},
    defaultValue:reflect('value'),defaultChecked:flag('checked'),form,
    checked:{get(){return checkedOf(this)},set(value){setChecked(this,value)}},
    indeterminate:{get(){return live.get(this)?.indeterminate===true},set(value){own(this).indeterminate=!!value;queueRender()}},
    valueAsNumber:{get(){const type=typeOf(this),value=this.value;return type==='number'||type==='range'?value===''?NaN:parseFloat(value):dateValue(type,value)},set(value){
      const type=typeOf(this),n=Number(value);
      if(type==='number'||type==='range')setInputValue(this,Number.isFinite(n)?String(n):'');
      else if(['date','datetime-local','time','month'].includes(type)){
        if(!Number.isFinite(n)){setInputValue(this,'');return}
        const iso=new Date(type==='month'?Date.UTC(1970+Math.floor(n/12),((n%12)+12)%12):n).toISOString();
        setInputValue(this,type==='date'?iso.slice(0,10):type==='month'?iso.slice(0,7):type==='time'?iso.slice(11,16):iso.slice(0,16));
      }else throw new DOMException('This input element does not support Number values.','InvalidStateError');
    }},
    valueAsDate:{get(){const n=dateValue(typeOf(this),this.value);return ['date','datetime-local','time','month'].includes(typeOf(this))&&Number.isFinite(n)&&typeOf(this)!=='month'?new Date(n):null},set(value){this.valueAsNumber=value instanceof Date?value.getTime():NaN}},
    stepUp:{value(count=1){step(this,count)}},stepDown:{value(count=1){step(this,-count)}},
    select:noop,setSelectionRange:noop,setRangeText:noop,
    min:reflect('min'),max:reflect('max'),step:reflect('step'),pattern:reflect('pattern'),placeholder:reflect('placeholder'),name:reflect('name'),
    required:flag('required'),readOnly:flag('readonly'),multiple:flag('multiple'),disabled:flag('disabled'),...validation,
  });
  define(TextArea.prototype,{
    type:{get(){return 'textarea'}},form,
    value:{get(){const state=live.get(this);return state&&'value' in state?state.value:this.textContent},set(value){own(this).value=String(value??'').replace(/\r\n?/g,'\n');queueRender()}},
    defaultValue:{get(){return this.textContent},set(value){this.textContent=String(value)}},
    textLength:{get(){return this.value.length}},select:noop,setSelectionRange:noop,setRangeText:noop,
    required:flag('required'),readOnly:flag('readonly'),disabled:flag('disabled'),name:reflect('name'),placeholder:reflect('placeholder'),...validation,
  });
  const removeNode=Select.prototype.remove;
  define(Select.prototype,{
    type:{get(){return this.hasAttribute('multiple')?'select-multiple':'select-one'}},form,
    multiple:flag('multiple'),required:flag('required'),disabled:flag('disabled'),name:reflect('name'),
    length:{get(){return optionsOf(this).length}},
    selectedIndex:{get(){return selectedIndices(this)[0]??-1},set(value){selectIndex(this,Number(value))}},
    selectedOptions:{get(){const options=optionsOf(this);return selectedIndices(this).map(index=>options[index])}},
    value:{get(){return this.selectedOptions[0]?.value??''},set(value){selectIndex(this,optionsOf(this).findIndex(option=>option.value===String(value)))}},
    add:{value(option,before){const reference=typeof before==='number'?optionsOf(this)[before]:before;if(reference)reference.before(option);else this.appendChild(option)}},
    remove:{value(...args){if(!args.length)return removeNode.call(this);optionsOf(this)[Number(args[0])]?.remove()}},
    item:{value(index){return optionsOf(this)[index]??null}},...validation,
  });
  const text=option=>option.textContent.replace(/\s+/g,' ').trim();
  define(OptionElement.prototype,{
    value:{get(){return this.getAttribute('value')??text(this)},set(value){this.setAttribute('value',String(value))}},
    text:{get(){return text(this)},set(value){this.textContent=String(value)}},label:{get(){return this.getAttribute('label')??text(this)}},
    index:{get(){const select=this.closest('select');return select?optionsOf(select).indexOf(this):0}},defaultSelected:flag('selected'),disabled:flag('disabled'),
    selected:{get(){const select=this.closest('select');return select?selectedIndices(select).includes(optionsOf(select).indexOf(this)):live.get(this)?.selected??this.hasAttribute('selected')},set(value){
      const select=this.closest('select');if(!select){own(this).selected=!!value;return}
      if(select.hasAttribute('multiple')){own(this).selected=!!value;own(select).none=false}else if(value)selectIndex(select,optionsOf(select).indexOf(this));else{own(this).selected=false;own(select).none=false}
      queueRender();
    }},
  });
  define(Button.prototype,{type:{get(){const type=(this.getAttribute('type')??'').toLowerCase();return ['reset','button'].includes(type)?type:'submit'},set(value){this.setAttribute('type',String(value))}},value:reflect('value'),name:reflect('name'),form,disabled:flag('disabled')});
  // LinkeDOM registers no form, details or label classes: those elements are
  // plain HTMLElements. Scope their members by tag and make instanceof work.
  for(const [Class,tag] of [[Form,'form'],[Details,'details'],[parsed.HTMLLabelElement,'label']])Object.defineProperty(Class,Symbol.hasInstance,{configurable:true,value:value=>value instanceof HTMLElement&&value.localName===tag});
  const only=(tag,properties)=>{for(const [name,descriptor] of Object.entries(properties))Object.defineProperty(HTMLElement.prototype,name,{configurable:true,
    get(){return this.localName!==tag?undefined:descriptor.get?descriptor.get.call(this):descriptor.value},
    set(value){if(this.localName===tag&&descriptor.set)descriptor.set.call(this,value);else Object.defineProperty(this,name,{value,writable:true,configurable:true,enumerable:true})}})};
  only('label',{htmlFor:reflect('for'),control:{get(){const id=this.getAttribute('for');return id?doc.getElementById(id):this.querySelector('input,select,textarea,button')}}});
  only('details',{open:{get(){return this.hasAttribute('open')},set(value){
    const next=!!value;if(next===this.hasAttribute('open'))return;this.toggleAttribute('open',next);
    later(()=>{const event=new events.Event('toggle');event.oldState=next?'closed':'open';event.newState=next?'open':'closed';fire(this,event)},0);
  }}});
  only('form',{
    elements:{get(){
      const list=formControls(this).filter(control=>!(control.localName==='input'&&typeOf(control)==='image')),named=new Map();
      for(const control of list)for(const key of new Set([control.getAttribute('name'),control.getAttribute('id')]))if(key){if(!named.has(key))named.set(key,[]);named.get(key).push(control)}
      const elements=[...list];
      for(const [key,controls] of named)if(!(key in elements)){
        let item=controls[0];
        if(controls.length>1){item=[...controls];Object.defineProperty(item,'value',{get:()=>controls.find(control=>control.localName==='input'&&typeOf(control)==='radio'&&control.checked)?.value??'',set:value=>{const radio=controls.find(control=>control.localName==='input'&&typeOf(control)==='radio'&&control.value===String(value));if(radio)radio.checked=true}})}
        Object.defineProperty(elements,key,{value:item});
      }
      Object.defineProperties(elements,{namedItem:{value:key=>named.has(key)?elements[key]:null},item:{value:index=>elements[index]??null}});
      return elements;
    }},
    length:{get(){return formControls(this).length}},noValidate:flag('novalidate'),
    // There is nowhere to navigate; submit() never fires an event in browsers.
    submit:{value(){}},
    requestSubmit:{value(submitter){if(submitter!=null&&!(isSubmit(submitter)&&formOf(submitter)===this))throw new TypeError('The specified element is not a submit button of this form.');submitForm(this,submitter??null)}},
    reset:{value(){resetForm(this)}},
    checkValidity:{value(){let valid=true;for(const control of formControls(this))if(candidate(control)&&!control.checkValidity())valid=false;return valid}},
    reportValidity:{value(){return interactivelyValid(this,null)}},
  });
  define(HTMLElement.prototype,{click:{writable:true,value(){click(this)}},blur:{writable:true,value(){const id=ids.get(this);if(id)send({type:'interaction',name:'blur',id})}}});
  define(Element.prototype,{
    setPointerCapture:{writable:true,value(pointerId){pointerCaptures.set(pointerId,this);send({type:'interaction',name:'setPointerCapture',id:identify(this),pointerId})}},
    releasePointerCapture:{writable:true,value(pointerId){if(pointerCaptures.get(pointerId)===this)pointerCaptures.delete(pointerId);send({type:'interaction',name:'releasePointerCapture',id:identify(this),pointerId})}},
    hasPointerCapture:{writable:true,value(pointerId){return pointerCaptures.get(pointerId)===this}},
  });
  // :checked must follow live checkedness/selectedness while [checked] and
  // [selected] stay literal attribute tests. Selectors passed to the query
  // methods have the bare pseudo-class (outside strings, escapes and
  // attribute brackets) replaced by an internal attribute answered live.
  const hasAttribute=Element.prototype.hasAttribute;
  define(Element.prototype,{hasAttribute:{writable:true,value(name){
    if(name!==liveChecked)return hasAttribute.call(this,name);
    if(checkable(this))return checkedOf(this);
    if(this.localName!=='option')return false;
    let select=this.parentElement;if(select?.localName==='optgroup')select=select.parentElement;
    return select?.localName==='select'?selectedIndices(select).includes(optionsOf(select).indexOf(this)):hasAttribute.call(this,'selected');
  }}});
  for(const prototype of new Set([Element.prototype,Object.getPrototypeOf(doc),parsed.DocumentFragment.prototype]))for(const name of ['querySelector','querySelectorAll','matches','closest']){
    const original=prototype[name];if(typeof original==='function')define(prototype,{[name]:{writable:true,value(selector,...rest){return original.call(this,liveSelector(selector),...rest)}}});
  }
  for(const name of ['Pressed','Expanded','Selected','Checked','Hidden','Label','Current','Disabled','ValueNow','ValueMin','ValueMax','ValueText','Live','HasPopup','Level','Modal','Orientation','ReadOnly','Required','Sort','Busy','Invalid','Multiselectable','RoleDescription','Description','PosInSet','SetSize','ColIndex','RowIndex','ColCount','RowCount']){
    const property='aria'+name,attribute='aria-'+name.toLowerCase();
    if(!(property in Element.prototype))define(Element.prototype,{[property]:{get(){return this.getAttribute(attribute)},set(value){if(value==null)this.removeAttribute(attribute);else this.setAttribute(attribute,String(value))}}});
  }
  if(!('role' in Element.prototype))define(Element.prototype,{role:{get(){return this.getAttribute('role')},set(value){if(value==null)this.removeAttribute('role');else this.setAttribute('role',String(value))}}});
  const FormData=NativeFormData&&class FormData extends NativeFormData{constructor(form,submitter){
    super();if(form===undefined)return;
    if(!(form instanceof Form))throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.");
    for(const control of formControls(form)){
      const name=control.getAttribute('name');if(!name||control.hasAttribute('disabled')||control.closest('fieldset[disabled]'))continue;
      if(control.localName==='input'){const type=typeOf(control);if(['submit','reset','button','image','file'].includes(type)||checkable(control)&&!control.checked)continue;this.append(name,control.value)}
      else if(control.localName==='select')for(const option of control.selectedOptions)this.append(name,option.value);
      else if(control.localName==='textarea')this.append(name,control.value);
    }
    if(submitter?.getAttribute?.('name'))this.append(submitter.getAttribute('name'),submitter.value??'');
  }};
  function Option(text='',value,defaultSelected=false,selected=false){const option=doc.createElement('option');option.textContent=String(text);if(value!==undefined)option.setAttribute('value',String(value));if(defaultSelected)option.setAttribute('selected','');if(selected)own(option).selected=true;return option}
  return {FormData,Option};
}
function render(initial=false) {
  if (!doc) return;
  // Exceeding a bound on the first snapshot is deterministic for this source,
  // not a runaway update: the viewer keeps its static rendering visible.
  const overflow=initial?'unsupported':'limit';
  const elements=[doc.documentElement,doc.body,...doc.body.querySelectorAll('*')];
  if(elements.length>2048){if(initial)unsupportedSnapshot();else send({type:overflow});return false}
  nodes=new Map();const controls=[],sent=new Map();let more=false;
  for(const node of elements){let id=ids.get(node);if(!id){id=String(++nextId);ids.set(node,id)}nodes.set(id,node);if(node.getAttribute('data-tarobot-node')!==id)node.setAttribute('data-tarobot-node',id);
    for(const attr of [...node.attributes]) if(/^on[a-z]+$/i.test(attr.name)){
      const event=attr.name.slice(2).toLowerCase();try{node['on'+event]=evaluateHandler?.(attr.value)}catch(cause){error(cause)}node.removeAttribute(attr.name);
    }
    // A new or script-changed control is sent; the initial snapshot compares
    // with the markup the viewer has already rendered.
    const state=controlState(node);if(!state)continue;const key=encode(state),previous=initial?encode(controlState(node,false)):sentControls.get(id);
    if(previous===key){sent.set(id,key)}else if(controls.length<512){controls.push([id,state]);sent.set(id,key)}else{more=true;if(previous!==undefined)sent.set(id,previous)}
  }
  // Each element gains at most 32 characters of data-tarobot-node annotation.
  const html=doc.body.innerHTML;if(typeof html!=='string'||html.length>128*1024+32*elements.length){if(initial)unsupportedSnapshot();else send({type:overflow});return false}
  const attributes=element=>[...element.attributes].filter(attr=>/^(?:class|style|id|lang|dir|data-[a-z0-9_-]+|aria-[a-z0-9_-]+)$/i.test(attr.name)&&attr.value.length<=2000).slice(0,24).map(attr=>[attr.name,attr.value]);
  const body=attributes(doc.body),root=attributes(doc.documentElement);
  const snapshot=html+encode([body,root]),changed=snapshot!==lastSnapshot;
  const payload=changed?{type:'render',html,body,root,controls,ack,bodyId:ids.get(doc.body)}:{type:'controls',controls,ack};
  const cost=changed||controls.length?encode(payload).length:0,now=nativeNow();
  // Dense SVGs can be valid yet exhaust the transport during ordinary slider
  // dragging. Coalesce to the latest DOM under backpressure, retaining room
  // for state/ACK/heartbeat traffic. Keep all hard size/rate limits unchanged.
  if(!initial&&cost&&now-transportAt<1000&&(transportBytes+cost>1024*1024||transportMessages>=96)){
    nextRenderAt=transportAt+1001;schedule(true);return;
  }
  sentControls=sent;lastRender=now;
  if(cost){nextRenderAt=now+cost/(600*1024/1000);send(payload,overflow)}
  if(changed)lastSnapshot=snapshot;
  if(more)schedule(true);
  return !transportClosed;
}
function identify(node){let id=ids.get(node);if(!id){id=String(++nextId);ids.set(node,id);node.setAttribute('data-tarobot-node',id)}return id}
const rect=value=>value&&typeof value==='object'&&['x','y','width','height'].every(key=>Number.isFinite(value[key]))?{x:value.x,y:value.y,width:value.width,height:value.height,top:value.y,left:value.x,right:value.x+value.width,bottom:value.y+value.height}:undefined;
function init(data) {
  const parsed=parseHTML('<!doctype html><html><head></head><body>'+data.html+'</body></html>');
  doc=parsed.document;const globals=Object.create(null);win=new Proxy(globals,{get(target,name){return Object.hasOwn(target,name)?target[name]:parsed[name]}});Object.defineProperty(doc,'defaultView',{value:win});theme=data.theme??{};viewport=data.viewport??viewport;reducedMotion=data.reducedMotion===true;
  windowEvents=new parsed.EventTarget();
  let initial=null;if(typeof data.restore==='string'&&data.restore.length<=16384)try{initial=JSON.parse(data.restore)}catch{/* A damaged cache starts fresh. */}
  const tarobot=Object.freeze({prompt:Object.freeze({compose:text=>compose(text)}),state:Object.freeze({initial,set:value=>setState(value)})});
  const handler=installEvents(parsed),{FormData,Option}=installControls(parsed);
  Object.defineProperty(doc,'activeElement',{configurable:true,get:()=>activeElement&&doc.contains(activeElement)?activeElement:doc.body});
  const scripts=[...doc.querySelectorAll('script')].map(node=>{const text=node.textContent;node.remove();return text});
  for(const node of doc.querySelectorAll('iframe,object,embed,base,meta,link'))node.remove();
  // Real border-box geometry arrives with pointer events and ResizeObserver;
  // until then an element reports the frame viewport.
  const dimensions=function(){const box=geometry.get(ids.get(this));return box?{...box}:{width:viewport.width,height:viewport.height,top:0,left:0,right:viewport.width,bottom:viewport.height,x:0,y:0}};
  parsed.Element.prototype.getBoundingClientRect=dimensions;parsed.Element.prototype.getClientRects=function(){return [dimensions.call(this)]};
  for(const property of ['clientWidth','offsetWidth'])Object.defineProperty(parsed.Element.prototype,property,{configurable:true,get(){return dimensions.call(this).width}});
  for(const property of ['clientHeight','offsetHeight'])Object.defineProperty(parsed.Element.prototype,property,{configurable:true,get(){return dimensions.call(this).height}});
  for(const name of ['focus','scrollIntoView'])parsed.Element.prototype[name]=function(){const id=ids.get(this);if(typeof id==='string'&&/^\d{1,8}$/.test(id))send({type:'interaction',name,id})};
  const css=element=>new Proxy(element.style,{get(target,name){if(name==='getPropertyValue')return key=>target.getPropertyValue(key)||(key.startsWith('--')?theme[key.slice(2)]??'':'');if(name==='color')return target.color||theme.text||'#222';if(name==='fontSize')return theme['font-size']||'14px';return target[name]}});
  class ResizeObserver {
    constructor(callback){if(typeof callback!=='function')throw new TypeError('ResizeObserver requires a callback');this.callback=callback;this.elements=new Set()}
    observe(element){resizeObservers.add(this);this.elements.add(element);send({type:'observe',id:identify(element)});schedule()}
    unobserve(element){this.elements.delete(element);if(![...resizeObservers].some(observer=>observer.elements.has(element)))send({type:'unobserve',id:identify(element)})}
    disconnect(){for(const element of [...this.elements])this.unobserve(element);resizeObservers.delete(this)}
  }
  const matchMedia=query=>{
    if(typeof query!=='string'||query.length>200||mediaQueries.size>=16)throw new Error('Unsupported media query');
    const target=new parsed.EventTarget();Object.defineProperties(target,{media:{value:query},matches:{get(){const q=query.trim().toLowerCase();if(q==='(prefers-reduced-motion: reduce)')return reducedMotion;if(q==='(prefers-color-scheme: dark)')return theme.scheme==='dark';const width=/^\((min|max)-width:\s*(\d+)px\)$/.exec(q);return width?(width[1]==='min'?viewport.width>=Number(width[2]):viewport.width<=Number(width[2])):false}}});
    target.addListener=callback=>target.addEventListener('change',callback);target.removeListener=callback=>target.removeEventListener('change',callback);target.last=target.matches;mediaQueries.add(target);return target;
  };
  const deny = () => {throw new Error('This API is unavailable in a widget Worker')};
  const exposed={...events,CustomEvent:parsed.CustomEvent,Node:parsed.Node,Element:parsed.Element,HTMLElement:parsed.HTMLElement,SVGElement:parsed.SVGElement,HTMLInputElement:parsed.HTMLInputElement,HTMLSelectElement:parsed.HTMLSelectElement,HTMLOptionElement:parsed.HTMLOptionElement,HTMLTextAreaElement:parsed.HTMLTextAreaElement,HTMLButtonElement:parsed.HTMLButtonElement,HTMLFormElement:parsed.HTMLFormElement,HTMLDetailsElement:parsed.HTMLDetailsElement,HTMLLabelElement:parsed.HTMLLabelElement,HTMLTemplateElement:parsed.HTMLTemplateElement,DocumentFragment:parsed.DocumentFragment,Text:parsed.Text,EventTarget:parsed.EventTarget,MutationObserver:parsed.MutationObserver,FormData,Option,tarobot,document:doc,window:win,self:win,globalThis:win,parent:undefined,top:undefined,frames:undefined,opener:undefined,localStorage:undefined,sessionStorage:undefined,location:Object.freeze({href:'about:blank'}),navigator:Object.freeze({}),getComputedStyle:css,ResizeObserver,matchMedia,
    requestAnimationFrame:callback=>later(()=>callback(nativeNow()),16),cancelAnimationFrame:cancel,
    addEventListener:windowEvents.addEventListener.bind(windowEvents),removeEventListener:windowEvents.removeEventListener.bind(windowEvents),dispatchEvent:windowEvents.dispatchEvent.bind(windowEvents),
    Image:function(){return doc.createElement('img')},alert:deny,confirm:deny,prompt:deny,open:deny,fetch:()=>Promise.reject(new Error('Network unavailable')),
    RTCPeerConnection:undefined,webkitRTCPeerConnection:undefined,Worker:undefined,SharedWorker:undefined,WebSocket:undefined,EventSource:undefined,postMessage:undefined,
  };
  // LinkeDOM's defaultView is a proxy over its virtual globals. These definitions
  // do not install or expose any real DOM or native App bridge.
  for(const [name,value] of Object.entries(exposed))Object.defineProperty(win,name,{value,configurable:false,writable:false});
  for(const name of globalEventNames)Object.defineProperty(win,'on'+name,{configurable:false,...handler('on'+name,windowEvents)});
  // Native Worker timers require their real receiver; virtual-window method
  // calls must not pass the LinkeDOM proxy as `this`.
  for(const [name,value] of Object.entries({setTimeout:later,clearTimeout:cancel,setInterval:self.setInterval.bind(self),clearInterval:self.clearInterval.bind(self),queueMicrotask:self.queueMicrotask.bind(self)}))Object.defineProperty(win,name,{value,writable:false,configurable:false});
  Object.defineProperties(win,{innerWidth:{get:()=>viewport.width},innerHeight:{get:()=>viewport.height}});
  Object.defineProperty(doc,'readyState',{value:'complete',configurable:true});
  const observer=new parsed.MutationObserver(()=>schedule());observer.observe(doc.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
  const names=Object.keys(exposed),values=Object.values(exposed);
  try{
    // A shared lexical scope preserves functions referenced by inline handlers.
    // No evaluated code is ever inserted into the real rendering document.
    new Function(...names,'__capture',`${scripts.join('\n;\n')}\n;__capture(source=>eval('(function(event){'+source+'\\n})'));`)(...values,fn=>{evaluateHandler=fn});
  }catch(cause){error(cause)}
  evaluateHandler??=(source=>new Function(...names,'event',source).bind(win,...values));
  if(render(true)===false)return;fire(doc,new events.Event('DOMContentLoaded',{bubbles:true}));fire(windowEvents,new events.Event('load'));schedule();

}
const forwardedKeys=['key','code','location','repeat','isComposing','keyCode','charCode','which','button','buttons','detail','clientX','clientY','pageX','pageY','offsetX','offsetY','screenX','screenY','movementX','movementY','ctrlKey','metaKey','shiftKey','altKey','pointerId','pointerType','isPrimary','pressure','width','height','tiltX','tiltY','deltaX','deltaY','deltaZ','deltaMode','inputType','data'];
function userEvent(name,data,bubbles=data.bubbles===true){
  const init={bubbles,cancelable:data.cancelable===true};
  for(const key of forwardedKeys){const value=data[key];if(typeof value==='number'?Number.isFinite(value):typeof value==='boolean'||typeof value==='string'&&value.length<=256)init[key]=value}
  if(typeof data.relatedTarget==='string')init.relatedTarget=nodes.get(data.relatedTarget)??null;
  const Type=/^pointer|pointercapture$/.test(name)?events.PointerEvent:name==='wheel'?events.WheelEvent:/^(?:click|dblclick|contextmenu|mouse)/.test(name)?events.MouseEvent:/^key/.test(name)?events.KeyboardEvent:/^(?:focus|blur)/.test(name)?events.FocusEvent:name==='input'?events.InputEvent:/^composition/.test(name)?events.CompositionEvent:events.Event;
  return trusted(new Type(name,init));
}
// The real control already holds this state; record it as sent.
function applyState(node,data){
  const tag=node.localName;let applied=true;
  if(tag==='input'&&!checkable(node)&&typeof data.value==='string'&&valueMode(node)==='value')own(node).value=data.value;
  else if(tag==='input'&&checkable(node)&&typeof data.checked==='boolean'){setChecked(node,data.checked);own(node).indeterminate=data.indeterminate===true}
  else if(tag==='textarea'&&typeof data.value==='string')own(node).value=data.value;
  else if(tag==='select'&&isArray(data.selected)){const options=optionsOf(node),selected=new Set(data.selected);options.forEach((option,index)=>{own(option).selected=selected.has(index)});own(node).none=!node.hasAttribute('multiple')&&!selected.size}
  else{applied=false;if(tag==='details'&&typeof data.open==='boolean')node.toggleAttribute('open',data.open)}
  const state=applied&&controlState(node);if(state)sentControls.set(ids.get(node),encode(state));
}
listen('message',event=>{
  // Capture-phase, first-registered: guest listeners on this real global never
  // observe nonces/tokens and cannot alter what the runtime reads.
  stopMessage(event);
  const data=messageData(event);if(!event.isTrusted||!data||typeof data!=='object')return;
  // FIFO with previously forwarded input. The final snapshot bypasses only the
  // coalescing timer, not the transport/size limits; no authored callback runs.
  if(data.type==='state-flush'&&!stateRetiring&&typeof data.id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(data.id)){
    stateRetiring=true;cancel(stateTimer);stateTimer=0;
    send({type:'state-flushed',id:data.id,...(pendingState===undefined?{}:{state:pendingState})});return;
  }
  if(stateRetiring)return;
  if(data.type==='ping'){if(typeof data.nonce==='string'&&data.nonce.length<=64)send({type:'pong',nonce:data.nonce});return}
  if(data.type==='init'&&!started&&typeof data.html==='string'&&data.html.length<=128*1024){started=true;try{init(data)}catch{unsupportedSnapshot()}return}
  if(!doc)return;
  if(data.type==='event'){
    const node=nodes.get(data.id),name=typeof data.name==='string'?data.name:'';if(!node||!name)return;
    if(isArray(data.rects))for(const item of data.rects.slice(0,16))if(isArray(item)&&typeof item[0]==='string'){const box=rect(item[1]);if(box)geometry.set(item[0],box)}
    applyState(node,data);
    if(name==='focusin'||name==='focusout'){activeElement=name==='focusin'?node:undefined;fire(node,userEvent(name==='focusin'?'focus':'blur',data,false));fire(node,userEvent(name,data,true))}
    else{
      const token=typeof data.gesture==='string'&&data.gesture.length<=64?data.gesture:'',event=userEvent(name,data);
      activation=name==='click'?token:'';
      const proceed=fire(node,event);
      if(proceed&&name==='click')defaultAction(node,false);
      if(proceed&&name==='keydown'&&data.key==='Enter'&&data.isComposing!==true){activation=token;implicitSubmit(node)}
      activation='';
      if(name==='pointerup'||name==='pointercancel')pointerCaptures.delete(data.pointerId);
      if(typeof data.escape==='number')send({type:'event-result',serial:data.escape,prevented:event.defaultPrevented});
    }
    if(typeof data.serial==='number'&&data.serial>ack)ack=data.serial;schedule(true);
  }else if(data.type==='compose-result'){const resolve=composeRequests.get(data.id);if(resolve){composeRequests.delete(data.id);resolve(data.accepted===true)}}
  else if(data.type==='theme'){theme=data.theme??{};fire(windowEvents,new events.Event('tarobot:theme'));schedule(true)}
  else if(data.type==='viewport'){const changed=viewport.width!==data.viewport.width;viewport=data.viewport;if(changed)fire(windowEvents,new events.Event('resize'))}
  else if(data.type==='media'){reducedMotion=data.reducedMotion===true;}
  else if(data.type==='resize'&&Array.isArray(data.entries)){
    for(const entry of data.entries){const box=rect(entry.box)??rect(entry.rect);if(box)geometry.set(entry.id,box)}
    for(const observer of resizeObservers){const entries=data.entries.flatMap(entry=>{const target=nodes.get(entry.id);return target&&observer.elements.has(target)?[{target,contentRect:entry.rect,contentBoxSize:[{inlineSize:entry.rect.width,blockSize:entry.rect.height}],borderBoxSize:[{inlineSize:entry.box?.width??entry.rect.width,blockSize:entry.box?.height??entry.rect.height}]}]:[]});if(entries.length)try{observer.callback(entries,observer)}catch(cause){error(cause)}}
    schedule();
  }
  if(['theme','viewport','media'].includes(data.type))for(const query of mediaQueries){const matches=query.matches;if(matches!==query.last){query.last=matches;const e=new events.Event('change');Object.defineProperties(e,{matches:{value:matches},media:{value:query.media}});fire(query,e);try{query.onchange?.(e)}catch(cause){error(cause)}}}
},true);
