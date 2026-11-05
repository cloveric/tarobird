import { describe, it, expect } from 'vitest';
import { openWorkbenchDesign } from '../src/workbench-open-design.js';
import type { WorkbenchController } from '../src/workbench-controller.js';
import type { WorkbenchTab } from '../src/workbench-model.js';
function fixture(tabs: WorkbenchTab[], active: string) {
  const opened: string[] = [], created: string[] = [];
  const controller = {isVisible:true,
    getSnapshot:()=>({layout:{tabs,active}}),
    change:async(action:{id:string})=>{active=action.id;opened.push(active);},
    createDesign:async(title:string,_id:string,check:()=>void,_data:undefined,format:string)=>{check();active='created';tabs.push({id:active,kind:'design',title,designFormat:format as 'slides'});created.push(format);return active;},
    context:async()=>({kind:'design',revision:0,target:{deviceId:'d',windowId:'w',tabId:active}}),
    getRegistration:()=>({visible:true,tabs})} as unknown as WorkbenchController;
  return {controller,opened,created};
}
describe('explicit Baoyu opener chooses the requested format',()=>{
  const canvas:WorkbenchTab={id:'canvas',kind:'design',title:'Same title'}, slides:WorkbenchTab={id:'slides',kind:'design',designFormat:'slides',title:'Same title'};
  it('selects the requested format even when the other project is active and has the same title',async()=>{
    const f=fixture([canvas,slides],'slides'),signal=new AbortController().signal;
    expect((await openWorkbenchDesign(f.controller,'canvas-open',()=>{},signal)).target.tabId).toBe('canvas');
    expect((await openWorkbenchDesign(f.controller,'slides-open',()=>{},signal,'slides')).target.tabId).toBe('slides');
    expect(f.opened).toEqual(['canvas','slides']);expect(f.created).toEqual([]);
  });
  it('creates slides when only a canvas exists, and does not mutate that canvas',async()=>{
    const f=fixture([canvas],'canvas');
    expect((await openWorkbenchDesign(f.controller,'ppt-open',()=>{},new AbortController().signal,'slides')).created).toBe(true);
    expect(f.created).toEqual(['slides']);expect(canvas).toEqual({id:'canvas',kind:'design',title:'Same title'});
  });
});
