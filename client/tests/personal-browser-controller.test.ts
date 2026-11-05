import { describe, expect, it } from 'vitest';
import { PersonalBrowserController } from '../src/personal-browser-controller.js';
import { BrowserUserClient, type BrowserEvent, type BrowserReceipt } from '../src/workbench-browser.js';
import { PERSONAL_BROWSER_SCOPE } from '../shared/personal-browser.mjs';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => {resolve=r;}); return {promise,resolve}; };
class Browser extends BrowserUserClient {
  calls: string[] = []; tabs = new Map<string, {tab:string;url:string;title:string}>();
  receive?: (event:BrowserEvent)=>void; gate?: {action:string;promise:Promise<void>}; fail?: string; cancelClose = false; failOpen?: BrowserReceipt;
  constructor(){super(PERSONAL_BROWSER_SCOPE);}
  override async command(action:string,tab?:string,fields:Record<string,unknown>={}):Promise<BrowserReceipt>{
    this.calls.push(action); if(this.gate?.action===action)await this.gate.promise;
    if(this.fail===action){this.fail=undefined;throw Error('fixture_failed');}
    if(action==='list')return {status:'ok',tabs:[...this.tabs.values()]};
    if(action==='open'){const value={tab:tab!,url:String(fields.url),title:'A page'};this.tabs.set(tab!,value);if(this.failOpen){const result=this.failOpen;this.failOpen=undefined;return {...value,...result};}return{status:'ok',...value};}
    if(action==='close'){if(this.cancelClose)return {status:'cancelled',error:'page_has_unsaved_changes'};this.tabs.delete(tab!);}
    return {status:'ok'};
  }
  override async subscribe(receive:(event:BrowserEvent)=>void){this.receive=receive;return()=>{this.receive=undefined;};}
  emit(event:BrowserEvent){this.receive?.({...event,scope:PERSONAL_BROWSER_SCOPE});}
}
describe('independent personal browser',()=>{
  it('recovers native tabs without opening duplicates and retains the next tab after close',async()=>{
    const browser=new Browser();browser.tabs.set('existing',{tab:'existing',url:'https://example.test',title:'Existing'});
    const owner=new PersonalBrowserController(browser);await owner.initialize();
    expect(browser.calls).toEqual(['capabilities','list']);expect(owner.getSnapshot().active).toBe('existing');
    await owner.openBrowser('https://second.test');const second=owner.getSnapshot().active;
    await owner.close('existing');expect(owner.getSnapshot().active).toBe(second);
    owner.dispose();expect(browser.tabs.size).toBe(1);expect(browser.receive).toBeUndefined();
    const remounted=new PersonalBrowserController(browser);await remounted.initialize();expect(remounted.getSnapshot().tabs).toHaveLength(1);remounted.dispose();
  });
  it('does not subscribe or open after cancelled capability initialization',async()=>{
    const browser=new Browser(),gate=deferred();browser.gate={action:'capabilities',promise:gate.promise};
    const owner=new PersonalBrowserController(browser),task=owner.initialize();owner.dispose();gate.resolve();await task;
    expect(browser.calls).toEqual(['capabilities']);expect(browser.receive).toBeUndefined();
  });
  it('releases failed initialization listeners and can retry',async()=>{
    const browser=new Browser();browser.fail='list';const owner=new PersonalBrowserController(browser);
    await expect(owner.initialize()).rejects.toThrow('fixture_failed');expect(browser.receive).toBeUndefined();
    await owner.initialize();expect(owner.getSnapshot().ready).toBe(true);expect(browser.tabs.size).toBe(1);owner.dispose();
  });
  it('cleans up a newly opened page when the owning component left during dispatch',async()=>{
    const browser=new Browser();browser.tabs.set('saved',{tab:'saved',url:'about:blank',title:'Saved'});
    const owner=new PersonalBrowserController(browser);await owner.initialize();const gate=deferred();browser.gate={action:'open',promise:gate.promise};
    const task=owner.openBrowser();await Promise.resolve();owner.dispose();gate.resolve();await task;
    expect([...browser.tabs.keys()]).toEqual(['saved']);
  });
  it('keeps a page when native close is cancelled and handles scoped popup/crash/recovery',async()=>{
    const browser=new Browser(),owner=new PersonalBrowserController(browser);await owner.initialize();const tab=owner.getSnapshot().active!;
    browser.cancelClose=true;await expect(owner.close(tab)).rejects.toThrow('page_has_unsaved_changes');expect(owner.getSnapshot().tabs).toHaveLength(1);
    browser.receive?.({kind:'state',scope:{host:'another',user:'local',conversation:'another'},tab:'foreign',title:'Wrong'});expect(owner.getSnapshot().tabs).toHaveLength(1);
    browser.emit({kind:'state',tab:'ghost',title:'Late unknown state'});expect(owner.getSnapshot().tabs).toHaveLength(1);
    browser.emit({kind:'opened',tab:'child',opener:tab,url:'https://child.test'});expect(owner.getSnapshot().active).toBe('child');
    browser.emit({kind:'gone',tab:'child',reason:'crashed'});expect(owner.getSnapshot().tabs[1]?.error).toBe('crashed');
    browser.emit({kind:'state',tab:'child',crashed:false,loading:false});expect(owner.getSnapshot().tabs[1]?.error).toBeUndefined();owner.dispose();
  });
  it('keeps failed native pages visible and subscribed after first-open failure',async()=>{
    const browser=new Browser();browser.failOpen={status:'needs_user',error:'live_limit',state:'sleeping'};
    const owner=new PersonalBrowserController(browser);await owner.initialize();
    const tab=owner.getSnapshot().active!;
    expect(owner.getSnapshot()).toMatchObject({ready:true,error:'live_limit'});
    expect(owner.getSnapshot().tabs).toHaveLength(1);expect(browser.receive).toBeTypeOf('function');
    browser.emit({kind:'state',tab,title:'Recovered page',state:'live'});
    expect(owner.getSnapshot().tabs[0]).toMatchObject({title:'Recovered page',sleeping:false});
    browser.failOpen={status:'failed',error:'navigation_failed',state:'live'};
    await expect(owner.openBrowser('https://broken.test')).rejects.toThrow('navigation_failed');
    expect(owner.getSnapshot().tabs).toHaveLength(2);
    await owner.close(owner.getSnapshot().active!);expect(owner.getSnapshot().tabs).toHaveLength(1);owner.dispose();
  });
  it('accepts a native child opened before its own opener receipt returns',async()=>{
    const browser=new Browser(),owner=new PersonalBrowserController(browser);await owner.initialize();
    const command=browser.command.bind(browser);
    browser.command=async(action,tab,fields)=>{
      if(action==='open')browser.emit({kind:'opened',tab:'early-child',opener:tab,url:'https://child.test'});
      return command(action,tab,fields);
    };
    await owner.openBrowser();expect(owner.getSnapshot().tabs.some(tab=>tab.tab==='early-child')).toBe(true);owner.dispose();
  });

});
