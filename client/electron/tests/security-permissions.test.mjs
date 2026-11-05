import test from 'node:test';
import assert from 'node:assert/strict';
import { secureSession } from '../security.mjs';
import { APP_ENTRY } from '../contract.mjs';
import { DESIGN_BOOTSTRAP_URL } from '../design-document.mjs';
function setup(preferences) {
 const handlers={}; const contents={isDestroyed:()=>false,getURL:()=>APP_ENTRY};
 secureSession({setPermissionRequestHandler:fn=>handlers.request=fn,setPermissionCheckHandler:fn=>handlers.check=fn,setDevicePermissionHandler(){},on(){},webRequest:{onBeforeRequest(){}}},{owns:value=>value===contents,systemPreferences:preferences,platform:'darwin'});
 const details={isMainFrame:true,requestingUrl:APP_ENTRY,mediaTypes:['audio']};
 return {handlers,contents,details,request:(permission,extra={})=>new Promise(resolve=>handlers.request(contents,permission,resolve,{...details,...extra}))};
}
test('only the owned main App can request microphone; widgets and unsupported permissions stay denied',async()=>{
 let prompts=0;const f=setup({getMediaAccessStatus:()=> 'not-determined',askForMediaAccess:async()=>{prompts++;return true;}});
 assert.equal(await f.request('media'),true);assert.equal(prompts,1);
 assert.equal(await f.request('fullscreen'),true);assert.equal(f.handlers.check(f.contents,'fullscreen','tarobot://app',f.details),true);
 assert.equal(await f.request('media',{isMainFrame:false,requestingUrl:'tarobot-widget://sandbox/widget-sandbox.html'}),false);
 assert.equal(await f.request('media',{mediaTypes:['display']}),false);
 assert.equal(await f.request('clipboard-read'),false);assert.equal(await f.request('fileSystem'),false);
 assert.equal(prompts,1);assert.equal(f.handlers.check(null,'media','tarobot://app',f.details),false);
});
test('an OS denial is preserved and a stale document does not receive an awaited permission',async()=>{
 const denied=setup({getMediaAccessStatus:()=> 'denied',askForMediaAccess:async()=>{throw new Error('must not ask again');}});
 assert.equal(await denied.request('media'),false);
 let complete;const f=setup({getMediaAccessStatus:()=> 'not-determined',askForMediaAccess:()=>new Promise(resolve=>complete=resolve)});
 const pending=f.request('media');f.contents.getURL=()=> 'https://example.org/';complete(true);
 assert.equal(await pending,false);
});

function designFixture() {
 const f=setup();const main={url:APP_ENTRY,detached:false,parent:null};
 const editor={url:DESIGN_BOOTSTRAP_URL+'#b33b01c0-1280-4000-8000-000000000001',parent:main,detached:false};
 main.framesInSubtree=[main,editor];f.contents.mainFrame=main;
 const details={isMainFrame:false,requestingUrl:editor.url};
 return {...f,main,editor,details,request:(permission='fullscreen')=>new Promise(resolve=>f.handlers.request(f.contents,permission,resolve,details)),check:(permission='fullscreen')=>f.handlers.check(f.contents,permission,'',details)};
}
test('fullscreen is restricted to the unique live direct Design document; split editors remain independent',async()=>{
 const f=designFixture();assert.equal(await f.request(),true);assert.equal(f.check(),true);
 f.main.framesInSubtree.push({...f.editor,url:f.editor.url.replace(/1$/,'2')});
 assert.equal(await f.request(),true);assert.equal(f.check(),true);
 for(const permission of ['automatic-fullscreen','media','clipboard-read','clipboard-sanitized-write','display-capture','fileSystem','geolocation','pointerLock','keyboardLock']) {
  assert.equal(await f.request(permission),false,permission);assert.equal(f.check(permission),false,permission);
 }
});
test('fullscreen rejects widgets, arbitrary data, nested or duplicate editors, stale frames and foreign contents',async()=>{
 for(const mutate of [
  f=>{f.details.requestingUrl='tarobot-widget://sandbox/widget-sandbox.html';},
  f=>{f.details.requestingUrl='data:text/html;charset=utf-8,<h1>spoof</h1>';},
  f=>{f.details.requestingUrl=DESIGN_BOOTSTRAP_URL;},
  f=>{f.editor.url=f.editor.url.replace('-4000-','-1000-');f.details.requestingUrl=f.editor.url;},
  f=>{f.details.requestingUrl=f.editor.url+'suffix';},
  f=>{f.editor.parent={url:'about:srcdoc'};},
  f=>{f.main.framesInSubtree.push({...f.editor,parent:f.editor});},
  f=>{f.main.framesInSubtree=[];},
  f=>{f.editor.detached=true;},
  f=>{f.main.detached=true;},
  f=>{f.main.url='https://example.org/';},
  f=>{f.contents.getURL=()=> 'https://example.org/';},
  f=>{f.contents.isDestroyed=()=>true;},
  f=>{Object.defineProperty(f.contents,'mainFrame',{get(){throw Error('destroyed');}});},
 ]) {const f=designFixture();mutate(f);assert.equal(await f.request(),false);assert.equal(f.check(),false);}
 const f=designFixture();assert.equal(f.handlers.check({...f.contents},'fullscreen','',f.details),false);
 assert.equal(await new Promise(resolve=>f.handlers.request({...f.contents},'fullscreen',resolve,f.details)),false);
});
