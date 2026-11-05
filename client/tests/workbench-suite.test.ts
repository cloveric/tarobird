import { describe, it, expect } from 'vitest';
import { emptyDesign, emptyDesignDocument, applyDesignFiles, decodeDesignFile, designTextFile, validateDesignDocument } from '../src/workbench-design.js';
import { designSystemInstall } from '../src/workbench-design-system.js';
import { workbenchRegistrationSchema } from '../../src/client-protocol/workbench.js';
import { workbenchDesignError, designFormatSchema } from '../../src/client-protocol/workbench-design.js';
const read=(file:{base64:string})=>JSON.parse(new TextDecoder().decode(decodeDesignFile(file)));
const source={scope:JSON.stringify(['host','owner','source-conversation']),id:'brand',title:'Brand'};
const brandDocument=()=>validateDesignDocument({schema:1,id:'brand',format:'design-system',revision:0,receipts:[],files:{
 'project/README.md':designTextFile('# Brand\n'),
 'project/tokens.json':designTextFile('{"version":1}','application/json'),
}});
describe('Baoyu canvas/PPT product boundaries',()=>{
 for(const format of ['canvas','slides'] as const)it(`${format} keeps its files and format through backup`,()=>{
  const doc=emptyDesignDocument('project','Design',format);
  expect(validateDesignDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  expect(workbenchDesignError({operation:'design.create',payload:{format}})).toBeUndefined();
 });
 for(const format of ['design-system','dashboard','motion'])it(`${format} has no standalone editor route`,()=>{
  expect(designFormatSchema.safeParse(format).success).toBe(false);
  for(const operation of ['design.create','design.open'])expect(workbenchDesignError({operation,payload:{format}})).toBe('invalid_design_payload');
  expect(()=>emptyDesignDocument('project','Design',format as never)).toThrow('design_format_unsupported');
  expect(workbenchRegistrationSchema.safeParse({windowId:'window',generation:'gen',conversationId:'chat',capabilities:['design.v1'],tabs:[{id:'project',kind:'design',title:'Design',designFormat:format}],visible:true}).success).toBe(false);
 });
 it('validates project database documents for canvas/PPT without a separate editor',()=>{
  for(const format of ['canvas','slides'] as const){
   const doc=emptyDesignDocument('project','Design',format);
   for(const value of ['[]','null','{"constructor":{"polluted":true}}'])expect(()=>validateDesignDocument({...doc,files:{...doc.files,'project/db/data/item.json':designTextFile(value,'application/json')}})).toThrow('design_invalid_db_document');
   expect(()=>validateDesignDocument({...doc,files:{...doc.files,'project/db/data/item.json':designTextFile('{"value":1}','application/json')}})).not.toThrow();
  }
 });
 it('registers canvas/PPT openers without advertising the removed suite',()=>{
  const opener={windowId:'window',generation:'gen',conversationId:'chat',capabilities:['design.open.v1','design.slides.v1'],tabs:[],visible:true};
  expect(workbenchRegistrationSchema.safeParse(opener).success).toBe(true);
  expect(workbenchRegistrationSchema.safeParse({...opener,capabilities:[...opener.capabilities,'design.suite.v1']}).success).toBe(false);
  expect(workbenchRegistrationSchema.safeParse({...opener,tabs:[{id:'canvas',kind:'design',title:'Canvas'}]}).success).toBe(false);
 });
});
describe('design-system install/sync',()=>{
 it('copies files and index atomically, syncs a removed upstream file, preserves user canvas',()=>{
  const target=emptyDesign('canvas','Original');let brand=brandDocument();
  brand.files['project/extra.css']=designTextFile('h1{color:red}','text/css');
  let installed=applyDesignFiles(target,designSystemInstall(target,brand,source));
  expect(installed.files['project/Main.dc.html']).toEqual(target.files['project/Main.dc.html']);
  expect(read(installed.files['project/canvas.json']).designSystems[0]).toMatchObject({namespace:'system-brand',version:'0',title:'Brand'});
  const {['project/extra.css']:gone,...files}=brand.files;brand={...brand,files,revision:1};
  installed=applyDesignFiles(installed,designSystemInstall(installed,brand,source));
  expect(installed.files['project/ds/system-brand/extra.css']).toBeUndefined();
  expect(read(installed.files['project/canvas.json']).designSystems[0].version).toBe('1');
 });
 it('refuses source replacement and local edits rather than silently losing them',()=>{
  const brand=brandDocument(),target=emptyDesign('canvas');
  const installed=applyDesignFiles(target,designSystemInstall(target,brand,source));
  expect(()=>designSystemInstall(installed,brand,{...source,scope:'other'})).toThrow('design_system_namespace_conflict');
  const local={...installed,files:{...installed.files,'project/ds/system-brand/README.md':designTextFile('Local edit')}};
  expect(()=>designSystemInstall(local,{...brand,revision:1},source)).toThrow('design_system_local_changes');
 });
 it('a concurrent target edit fences an already prepared installation',()=>{
  const brand=brandDocument(),target=emptyDesign('canvas');
  const batch=designSystemInstall(target,brand,source);
  const changed={...target,revision:1,files:{...target.files,'project/canvas.json':designTextFile(JSON.stringify({...read(target.files['project/canvas.json']),title:'New user title'}),'application/json')}};
  expect(()=>applyDesignFiles(changed,batch)).toThrow('design_revision_conflict');
 });
});
