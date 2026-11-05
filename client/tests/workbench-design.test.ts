import { describe, expect, it, vi } from 'vitest';
import { applyDesignFiles, decodeDesignFile, designTextFile, emptyDesign, validateDesignDocument } from '../src/workbench-design.js';
import { DesignSession } from '../src/workbench-design-session.js';
import { designPath, workbenchDesignError } from '../../src/client-protocol/workbench-design.js';
const text = (file: {base64:string}) => new TextDecoder().decode(decodeDesignFile(file));
function fixture() {
  let disk = emptyDesign('design'), fail = false;
  const changed = vi.fn(), session = new DesignSession(structuredClone(disk), async () => structuredClone(disk), async (expected, next) => { if(fail) throw Error('quota'); if(expected!==disk.revision) throw Error('design_revision_conflict'); disk=structuredClone(next); }, changed);
  return { session, disk:()=>disk, fail:(value:boolean)=>{fail=value;}, changed };
}
const payload = (content='kept') => ({ files: { 'project/note.txt': { content, contentType:'text/plain' } } });
describe('Design bounded file/session contract',()=>{
  it('does not let a delayed refresh roll the live revision behind a completed save', async () => {
    let disk=emptyDesign('design'), release!: (document: typeof disk) => void, reads=0;
    const session=new DesignSession(structuredClone(disk),async()=>++reads===1?new Promise(resolve=>{release=resolve;}):structuredClone(disk),async(expected,next)=>{if(expected!==disk.revision)throw Error('design_revision_conflict');disk=structuredClone(next);},()=>{});
    const refresh=session.refresh();await vi.waitFor(()=>expect(reads).toBe(1));
    const save=session.publish('concurrent-save',0,payload('retained'),()=>{});
    // Let the save advance if the old refresh is outside the mutation queue.
    await new Promise(resolve=>setTimeout(resolve,0));release(emptyDesign('design'));
    await Promise.all([refresh,save]);
    expect(session.document.revision).toBe(1);expect(disk.revision).toBe(1);
    expect(text(session.document.files['project/note.txt'])).toBe('retained');
  });
  it('keeps later saves usable after a refresh read fails', async () => {
    let disk=emptyDesign('design'), reads=0;
    const session=new DesignSession(structuredClone(disk),async()=>{if(++reads===1)throw Error('storage_unavailable');return structuredClone(disk);},async(expected,next)=>{if(expected!==disk.revision)throw Error('design_revision_conflict');disk=structuredClone(next);},()=>{});
    await expect(session.refresh()).rejects.toThrow('storage_unavailable');
    expect(await session.publish('after-refresh-failure',0,payload('recovered'),()=>{})).toMatchObject({revision:1});
    expect(text(session.document.files['project/note.txt'])).toBe('recovered');
    expect(session.document).toEqual(disk);
  });
  it('rejects traversal, object prototypes and non-project file names',()=>{
    for(const path of ['project/../secrets','/etc/hosts','project/a/../../x','project/__proto__/x','project/constructor','project/%2e%2e/x','project//x','project/a\\b'])expect(designPath.safeParse(path).success).toBe(false);
    for(const path of ['project/Main.dc.html','project/Main copy.dc.html','project/海报 (2).dc.html'])expect(designPath.safeParse(path).success).toBe(true);
  });
  it('validates file hashes, sizes and canvas references before applying any batch',()=>{
    const doc=emptyDesign('design');expect(validateDesignDocument(doc)).toEqual(doc);
    expect(()=>validateDesignDocument({...doc,files:{...doc.files,'project/Main.dc.html':{...doc.files['project/Main.dc.html'],size:1}}})).toThrow('design_file_corrupt');
    const change=designTextFile(JSON.stringify({v:3,boards:{'Missing.dc.html':{}}}),'application/json');
    expect(()=>applyDesignFiles(doc,{'project/canvas.json':{base64:change.base64,contentType:change.contentType,ifMatch:doc.files['project/canvas.json'].sha256}})).toThrow('design_artboard_missing');
    expect(doc.revision).toBe(0);
  });
  it('requires file CAS for edits, prevents asset overwrites and applies a batch atomically',()=>{
    const doc=emptyDesign('design'), file=doc.files['project/Main.dc.html'];
    expect(()=>applyDesignFiles(doc,{'project/Main.dc.html':{base64:file.base64,contentType:file.contentType}})).toThrow('design_revision_required');
    expect(()=>applyDesignFiles(doc,{'project/Main.dc.html':{delete:true,ifMatch:'old'}})).toThrow('design_revision_conflict');
    expect(()=>applyDesignFiles(doc,{'project/assets/a':null})).toThrow('design_read_only_path');
    expect(()=>applyDesignFiles(doc,{'project/new.txt':{base64:'YQ==',contentType:'text/plain'},'project/canvas.json':{delete:true,ifMatch:doc.files['project/canvas.json'].sha256}})).toThrow();
    expect(doc.files['project/new.txt']).toBeUndefined();
  });
  it('requires a revision and rejects oversized/unknown command fields',()=>{
    expect(workbenchDesignError({operation:'design.publish',payload:payload()})).toBe('workbench_revision_required');
    expect(workbenchDesignError({operation:'design.publish',expectedRevision:0,payload:payload('中'.repeat(50000))})).toBe('invalid_design_payload');
    expect(workbenchDesignError({operation:'design.read',payload:{path:'/tmp/foo'}})).toBe('invalid_design_payload');
    expect(workbenchDesignError({operation:'design.create',payload:{file:'/tmp/x'}})).toBe('invalid_design_payload');
  });
  it('never exposes inherited object properties through the untrusted read bridge',async()=>{
    const f=fixture();await expect(f.session.request('read',{path:'toString'})).rejects.toThrow();
    expect(await f.session.request('read',{path:'project/missing.txt'})).toBeNull();
  });
  it('flushes pending human edits before CAS and rejects stale Bot edits',async()=>{
    const f=fixture();let flushed=false;f.session.bindEditor({flush:async()=>{if(!flushed){flushed=true;await f.session.request('publish',{files:{'project/human.txt':{base64:'YQ==',contentType:'text/plain'}}});}},reload:async()=>{},retire:async()=>{}});
    await expect(f.session.publish('bot',0,payload(),()=>{})).rejects.toThrow('design_revision_conflict');
    expect(f.disk().files['project/note.txt']).toBeUndefined();expect(text(f.disk().files['project/human.txt'])).toBe('a');
  });
  it('preserves durable receipts across reopen and rejects changed replay contents',async()=>{
    const f=fixture();expect(await f.session.publish('bot',0,payload(),()=>{})).toMatchObject({revision:1});
    const reopened=new DesignSession(f.disk(),async()=>f.disk(),async()=>{throw Error('must_not_write');},()=>{});
    expect(await reopened.publish('bot',0,payload(),()=>{})).toMatchObject({revision:1});
    await expect(reopened.publish('bot',0,payload('different'),()=>{})).rejects.toThrow('workbench_request_conflict');
  });
  it('does not lose a committed receipt when renderer reload fails, and unlocks interaction',async()=>{
    const f=fixture(), unlock=vi.fn();f.session.bindEditor({lock:()=>unlock,flush:async()=>{},reload:async()=>{throw Error('renderer');},retire:async()=>{}});
    expect(await f.session.publish('bot',0,payload(),()=>{})).toEqual({revision:1,rendered:false});expect(unlock).toHaveBeenCalledOnce();expect(f.disk().revision).toBe(1);expect(f.session.getSnapshot().error).toBe('design_editor_reload_failed');
  });
  it('reports save failure without mutating document and succeeds on the same retry',async()=>{
    const f=fixture();f.fail(true);await expect(f.session.publish('bot',0,payload(),()=>{})).rejects.toThrow('quota');expect(f.disk().revision).toBe(0);
    f.fail(false);expect(await f.session.publish('bot',0,payload(),()=>{})).toMatchObject({revision:1});
  });
  it('checks cancellation before commit',async()=>{
    const f=fixture();await expect(f.session.publish('bot',0,payload(),()=>{throw Error('cancelled');})).rejects.toThrow('cancelled');expect(f.disk().revision).toBe(0);
  });
  it('uploads content-addressed images once and returns paged Unicode without broken pairs',async()=>{
    const f=fixture(), input={base64:btoa('image'),contentType:'image/png'};
    const first=await f.session.request('upload',input);const assets=await f.session.request('assets',{}) as Record<string,unknown>;expect(Object.keys(assets)).toHaveLength(1);expect(assets[(first as {id:string}).id]).toMatchObject(input);expect(await f.session.request('upload',input)).toEqual(first);expect(f.disk().revision).toBe(1);
    await f.session.publish('unicode',1,payload('😀A😀中'),()=>{});
    let offset:number|null=0;const parts=[];while(offset!==null){const value=await f.session.read({path:'project/note.txt',offset,limit:1});const result=value.result as {content:string;nextOffset:number|null};parts.push(result.content);offset=result.nextOffset;}
    expect(parts).toEqual(['😀','A','😀','中']);
  });
  it('normalizes a mid-pair read offset before calculating the page boundary',async()=>{
    const f=fixture();await f.session.publish('unicode-offset',0,payload('😀A😀中'),()=>{});
    expect(await f.session.read({path:'project/note.txt',offset:1,limit:1})).toMatchObject({result:{content:'A',offset:2,nextOffset:3,eof:false}});
    expect(await f.session.read({path:'project/note.txt',offset:4,limit:1})).toMatchObject({result:{content:'中',offset:5,nextOffset:null,eof:true}});
    expect(text(f.disk().files['project/note.txt'])).toBe('😀A😀中');
  });
});
