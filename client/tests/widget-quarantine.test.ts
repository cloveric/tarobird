import { expect, it, vi, afterEach } from 'vitest';
import { parseWidgetQuarantine, stopWidget, retryWidget, widgetStopReason, widgetFingerprint } from '../src/widget-quarantine.js';
afterEach(()=>vi.unstubAllGlobals());
it('accepts only bounded, fresh, versioned stop records',()=>{
 const now=Date.now(),record={hash:'a'.repeat(64),at:now,reason:'cpu'};
 expect(parseWidgetQuarantine(JSON.stringify({version:1,entries:[record]}),now)).toEqual([record]);
 for(const entry of [{...record,hash:'invalid'},{...record,at:now+120000},{...record,at:now-8*86400000},{...record,reason:'anything'}])expect(parseWidgetQuarantine(JSON.stringify({version:1,entries:[entry]}),now)).toEqual([]);
 expect(parseWidgetQuarantine('{bad')).toEqual([]);expect(parseWidgetQuarantine(JSON.stringify({version:1,entries:Array(65).fill(record)}))).toEqual([]);
});
it('keeps a failed source stopped across reads, explicitly retries it and treats repaired code separately',async()=>{
 const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
 const hash=await widgetFingerprint('<script>while(true){}</script>'),repaired=await widgetFingerprint('<p>repaired</p>');
 stopWidget(hash,'cpu');expect(widgetStopReason(hash)).toBe('cpu');expect(widgetStopReason(repaired)).toBeUndefined();expect([...values.values()][0]).not.toContain('while');retryWidget(hash);expect(widgetStopReason(hash)).toBeUndefined();
});
it('retains stop and explicit retry in memory when persistent storage is unavailable',async()=>{
 vi.stubGlobal('localStorage',{getItem:()=>{throw new Error('denied')},setItem:()=>{throw new Error('denied')}});
 const hash=await widgetFingerprint('<script>for(;;){}</script>');stopWidget(hash,'limit');expect(widgetStopReason(hash)).toBe('limit');retryWidget(hash);expect(widgetStopReason(hash)).toBeUndefined();
});
