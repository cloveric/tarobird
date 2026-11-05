import { describe, it, expect } from 'vitest';
import { applyDesignFiles, designTextFile, emptyDesign, emptySlides, validateDesignDocument, decodeDesignFile } from '../src/workbench-design.js';
import { DesignSession } from '../src/workbench-design-session.js';
import { designCreateSchema, designOpenSchema, isSlidesRequest } from '../../src/client-protocol/workbench-design.js';
import { workbenchRegistrationSchema } from '../../src/client-protocol/workbench.js';
const text = (file: {base64:string}) => new TextDecoder().decode(decodeDesignFile(file));
describe('Baoyu slide projects reuse the revisioned file store without changing canvases', () => {
  it('reads old canvases without format and validates a separate slide starter', () => {
    const canvas = emptyDesign('canvas'); expect(validateDesignDocument(canvas)).toEqual(canvas);
    const deck = emptySlides('deck','My slides'); expect(validateDesignDocument(deck)).toEqual(deck);
    expect(deck.files['project/canvas.json']).toBeUndefined();
    expect(JSON.parse(text(deck.files['project/deck.json']))).toMatchObject({v:4,order:['cover'],title:'My slides'});
  });
  it('rejects missing, duplicate, traversal slide IDs and cross-format indexes', () => {
    for (const order of [['missing'], ['cover','cover'], ['../cover']]) {
      const deck = emptySlides('deck'); deck.files['project/deck.json'] = designTextFile(JSON.stringify({v:4,order}), 'application/json');
      expect(() => validateDesignDocument(deck)).toThrow();
    }
    const deck = emptySlides('deck'); deck.files['project/canvas.json'] = emptyDesign('canvas').files['project/canvas.json'];
    expect(() => validateDesignDocument(deck)).toThrow('design_format_mismatch');
    expect(() => validateDesignDocument({...emptyDesign('canvas'),format:'slides'})).toThrow();
  });
  it('a partial invalid batch leaves the previous revision intact', () => {
    const deck = emptySlides('deck'), snapshot = structuredClone(deck), index = deck.files['project/deck.json'];
    expect(() => applyDesignFiles(deck, {'project/deck.json': {base64:designTextFile('{"v":4,"order":["next"]}').base64, contentType:'application/json',ifMatch:index.sha256}})).toThrow('design_slide_missing');
    expect(deck).toEqual(snapshot);
  });
  it('Bot reads and atomic publishes persist both slide order and text across a new session', async () => {
    let stored = emptySlides('deck');
    const create = () => new DesignSession(stored,async()=>structuredClone(stored),async(expected,next)=>{expect(stored.revision).toBe(expected);stored=structuredClone(next);},()=>{});
    const session=create(), result=await session.read({}); expect(result.result).toMatchObject({format:'slides'});
    const index = JSON.parse(text(stored.files['project/deck.json'])); index.order.push('next');
    await session.publish('edit',0,{files:{'project/deck.json':{content:JSON.stringify(index)},'project/slides/next.html':{content:'<section id="next"><h1>Next slide</h1></section>',contentType:'text/html'}}},()=>{});
    const reopened=create();expect((await reopened.read({path:'project/slides/next.html'})).result).toMatchObject({content:expect.stringContaining('Next slide')});
    await expect(reopened.publish('stale',0,{files:{'project/slides/next.html':null}},()=>{})).rejects.toThrow('design_revision_conflict');
    expect(stored.format).toBe('slides');expect(index.order).toEqual(['cover','next']);
  });
  it('allows only explicit supported formats and a format-capable opener without editor tabs', () => {
    expect(designCreateSchema.parse({format:'slides'})).toEqual({format:'slides'});
    expect(designOpenSchema.safeParse({format:'pptx'}).success).toBe(false);
    expect(isSlidesRequest({operation:'design.open',payload:{format:'slides'}})).toBe(true);
    const registration={windowId:'opener',generation:'g',conversationId:'c',capabilities:['design.open.v1','design.slides.v1'],tabs:[],visible:true};
    expect(workbenchRegistrationSchema.safeParse(registration).success).toBe(true);
    expect(workbenchRegistrationSchema.safeParse({...registration,capabilities:[...registration.capabilities,'browser.v1']}).success).toBe(false);
  });
});
