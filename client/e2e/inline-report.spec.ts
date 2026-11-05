import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { widgetBlock } from '../../src/client-protocol/widget.js';
import type { ReportData } from '../../src/client-protocol/report.js';
import { selectConversation, showDisconnectedBots, waitForClientOnline } from './fixtures/mobile.js';
test.use({serviceWorkers:'block'});
const report:ReportData={version:1,columns:['日期','体验','可靠性'],rows:[['10/16',2,1],['10/17',1,3],['10/18',4,2],['10/19',2,1],['10/20',3,5],['10/21',2,3]],chart:{kind:'bar',category:0,values:[1,2],unit:'项'},metrics:[{label:'体验交付',column:1,operation:'sum',unit:'项'},{label:'可靠性交付',column:2,operation:'sum',unit:'项'}],source:'验收示例 · 10/16–21 · 非真实项目统计',note:'所有数值由同一数据集绘制。'};
async function fixture(page:Page,data:ReportData=report){
 const dir=await mkdtemp(path.join(os.tmpdir(),'inline-report-'));const hub=await HubServer.start({stateDir:dir,clientDir:path.resolve('dist')});
 await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','报告助手','fixture')");const conversation=await hub.store.createConversation('owner',['alpha'],'数据报告','report');
 await hub.store.publishBotMessage('alpha',{id:'report_one',conversationId:conversation.id,status:'complete',blocks:[widgetBlock({title:'本周交付节奏',summary:'20 日交付最多；后半段的增量主要来自可靠性。',report:data})]});
 await page.goto(hub.url);await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});await waitForClientOnline(page);await showDisconnectedBots(page);await selectConversation(page,conversation.title);
 return {hub,conversation,dispose:async()=>{await page.close();await hub.close();await rm(dir,{recursive:true,force:true})}};
}
for(const width of [1360,390])test(`fixed report stays interactive without an iframe or generated script at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:900});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const f=await fixture(page);
 try{
  const panel=page.locator('.inline-report');await expect(panel).toContainText('体验交付');await expect(panel.locator('.report-metrics')).toContainText('14');await expect(panel.locator('.report-metrics')).toContainText('15');await expect(panel.locator('iframe')).toHaveCount(0);
  await panel.getByRole('combobox',{name:'选择记录查看数值'}).selectOption('4');await expect(panel.locator('.report-selection')).toContainText('10/20');await expect(panel.locator('.report-selection')).toContainText('5');
  await panel.getByRole('button',{name:'明细',exact:true}).click();await expect(panel.locator('tbody tr')).toHaveCount(6);
  await page.getByRole('button',{name:'放大交互组件',exact:true}).click();await expect(page.locator('.report-panel:modal')).toBeVisible();await expect(panel.locator('tbody tr')).toHaveCount(6);
  await page.getByRole('button',{name:'收起交互组件',exact:true}).click();await expect(page.locator('.report-panel:modal')).toHaveCount(0);await panel.getByRole('button',{name:'概览',exact:true}).click();await expect(panel.locator('.report-selection')).toContainText('10/20');
  await panel.screenshot({path:info.outputPath(`fixed-report-${width}.png`)});
  expect(await panel.evaluate(node=>node.getBoundingClientRect().right<=window.innerWidth)).toBe(true);
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await expect(page.locator('.report-metrics')).toContainText('14');
  expect(errors).toEqual([]);
 }finally{await f.dispose()}
});
test('table filtering treats cells as text and recalculates metrics without executing payloads',async({page})=>{
 const data:ReportData={version:1,columns:['事项','数值'],rows:Array.from({length:12},(_,i)=>[i===0?'<img src=x onerror="window.reportEscaped=true">':`item-${i}`,i]),metrics:[{label:'合计',column:1,operation:'sum'}]};const f=await fixture(page,data);
 try{const panel=page.locator('.inline-report');await expect(panel.locator('tbody tr')).toHaveCount(12);await expect(panel.locator('tbody img')).toHaveCount(0);await panel.getByRole('searchbox',{name:'筛选报告'}).fill('item-11');await expect(panel.locator('tbody tr')).toHaveCount(1);await expect(panel.locator('.report-metrics dd')).toHaveText('11');expect(await page.evaluate(()=>(window as any).reportEscaped)).toBeUndefined();await panel.getByRole('searchbox').fill('missing');await expect(panel).toContainText('没有匹配的记录');await expect(panel.locator('.report-metrics dd')).toHaveText('—');}finally{await f.dispose()}
});
test('timeline renders data and report selection is safe with negative and missing values',async({page})=>{
 const f=await fixture(page,{version:1,columns:['日期','变化'],rows:[['Monday',-4],['Tuesday',null],['Wednesday',2]],chart:{kind:'line',category:0,values:[1]},source:'Fixture'});
 try{await expect(page.locator('.report-chart circle')).toHaveCount(2);await page.getByRole('combobox',{name:'选择记录查看数值'}).selectOption('1');await expect(page.locator('.report-selection')).toContainText('—');await f.hub.store.publishBotMessage('alpha',{id:'report_one',conversationId:f.conversation.id,status:'complete',blocks:[widgetBlock({title:'时间线',summary:'两个事件',report:{version:1,columns:['日期','事件','说明'],rows:[['10/20','开始','需求确认'],['10/21','完成','复核通过']],timeline:{date:0,title:1,detail:2}}})]});await expect(page.locator('.report-timeline li')).toHaveCount(2);await expect(page.locator('.report-timeline')).toContainText('复核通过');}finally{await f.dispose()}
});

const denseReport:ReportData={version:1,columns:['日期','方案甲','方案乙','方案丙'],rows:Array.from({length:60},(_,index)=>[new Date(Date.UTC(2026,0,1+index*3)).toISOString().slice(0,10),index+2,index%11-5,index%9===0?null:index/2]),chart:{kind:'line',category:0,values:[1,2,3],unit:'项'},source:'交互验收示例，非真实业务数据'};
async function plotPoint(page:Page,index:number,count=60,settled=true){
 await expect(page.locator('.report-chart > svg')).toBeVisible();
 // ResizeObserver replaces the initial 600px drawing width. A point read before
 // that commit targets a different record once the responsive chart renders.
 // Keep paused scene motion intact; only wait for the chart's own measurement.
 await expect.poll(()=>page.locator('.report-chart > svg').evaluate(node=>{
  const svg=node as SVGSVGElement;
  return Math.abs(svg.viewBox.baseVal.width-Math.max(160,Math.min(850,Math.floor(svg.getBoundingClientRect().width))));
 })).toBeLessThan(1);
 if(settled)await expect.poll(()=>page.locator('.conversation-main').evaluate(el=>el.getAnimations().every(animation=>animation.playState!=='running'))).toBe(true);
 return page.locator('.report-chart > svg').evaluate((node,{index,count})=>{
  const svg=node as SVGSVGElement,box=svg.getBoundingClientRect(),view=svg.viewBox.baseVal;
  return {x:box.left+(54+(view.width-66)/count*(index+.5))/view.width*box.width,y:box.top+60/view.height*box.height};
 },{index,count});
}
for(const [width,kind] of [[320,'line'],[390,'line'],[1360,'bar']] as const)test(`report series and record interaction stays compact at ${width}px (${kind})`,async({page},info)=>{
 await page.setViewportSize({width,height:950});const f=await fixture(page,{...denseReport,chart:{...denseReport.chart!,kind}});
 try{
  const panel=page.locator('.inline-report'),picker=panel.getByRole('combobox',{name:'选择记录查看数值'}),legend=panel.getByRole('group',{name:'显示的数据系列'});
  const first=legend.getByRole('button',{name:'方案甲',exact:true}),second=legend.getByRole('button',{name:'方案乙',exact:true});
  await expect(first).toHaveAttribute('aria-pressed','true');
  const color=await panel.locator('[data-series="2"]'+(kind==='bar'?' rect':'')).first().getAttribute(kind==='bar'?'fill':'stroke');
  await picker.selectOption('20');await first.click();await expect(first).toHaveAttribute('aria-pressed','false');await expect(panel.locator('[data-series="1"]')).toHaveCount(0);
  await expect(panel.locator('[data-series="2"]'+(kind==='bar'?' rect':'')).first()).toHaveAttribute(kind==='bar'?'fill':'stroke',color!);
  await second.focus();await page.keyboard.press('Space');await expect(second).toHaveAttribute('aria-pressed','false');await page.keyboard.press('Space');await expect(second).toHaveAttribute('aria-pressed','true');
  await panel.getByRole('button',{name:'明细',exact:true}).click();await expect(panel.locator('tbody tr')).toHaveCount(60);
  await panel.getByRole('button',{name:'概览',exact:true}).click();await expect(first).toHaveAttribute('aria-pressed','false');await expect(picker).toHaveValue('20');
  await panel.getByRole('button',{name:'放大交互组件',exact:true}).click();await expect(picker).toHaveValue('20');await expect(first).toHaveAttribute('aria-pressed','false');
  await panel.getByRole('button',{name:'收起交互组件',exact:true}).click();await expect(picker).toHaveValue('20');
  const point=await plotPoint(page,10);await page.mouse.move(point.x,point.y);await expect(picker).toHaveValue('10');
  await second.hover();await expect(picker).toHaveValue('20');
  const clickPoint=await plotPoint(page,10);await page.mouse.click(clickPoint.x,clickPoint.y);await second.hover();await expect(picker).toHaveValue('10');
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   await panel.screenshot({path:info.outputPath(`report-${width}-${kind}-${theme}.png`)});
   expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
   if(width===320)expect(await picker.evaluate(node=>node.getBoundingClientRect().width)).toBeGreaterThan(115);
   const boxes=await panel.locator('.report-x-label').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right}}));
   for(let i=1;i<boxes.length;i++)expect(boxes[i]!.left).toBeGreaterThanOrEqual(boxes[i-1]!.right-1);
  }
  if(kind==='line')expect(await panel.locator('.report-chart circle').count()).toBeLessThan(10);
  await second.click();await legend.getByRole('button',{name:'方案丙',exact:true}).click();await expect(panel.getByRole('status')).toHaveText('所有数据系列已隐藏显示全部系列');await expect(panel.locator('.report-chart > svg')).toHaveCount(0);
  await panel.getByRole('button',{name:'显示全部系列',exact:true}).click();await expect(legend.locator('[aria-pressed="true"]')).toHaveCount(3);await expect(picker).toHaveValue('10');
  await picker.selectOption('59');await expect(panel.getByRole('button',{name:'下一条记录'})).toBeDisabled();await panel.getByRole('button',{name:'上一条记录'}).click();await expect(picker).toHaveValue('58');
  await panel.getByRole('searchbox',{name:'筛选报告'}).fill('2026-01-01');await expect(picker).toHaveValue('0');await expect(picker.locator('option')).toHaveCount(1);await expect(panel.locator('.report-selection')).toContainText('2026-01-01');
  await panel.getByRole('searchbox').fill('not-a-date');await expect(panel).toContainText('没有匹配的记录');await panel.getByRole('searchbox').fill('');await expect(picker).toHaveValue('0');
 }finally{await f.dispose()}
});
test.describe('touch report controls',()=>{
 test.use({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
 test('touch chooses a record without hover or blocking vertical reading',async({page})=>{
  const f=await fixture(page,denseReport);
  try{
   const picker=page.getByRole('combobox',{name:'选择记录查看数值'});
   const point=await plotPoint(page,22);await page.touchscreen.tap(point.x,point.y);await expect(picker).toHaveValue('22');
   await page.getByRole('button',{name:'方案乙',exact:true}).tap();await expect(picker).toHaveValue('22');
   await expect(page.locator('.report-chart > svg')).toHaveCSS('touch-action','pan-y');
   await picker.selectOption('30');await expect(picker).toHaveValue('30');
  }finally{await f.dispose()}
 });
 test('touch retains the hit record when page-entry motion ends before the compatibility click',async({page})=>{
  await page.addInitScript(()=>{const original=Element.prototype.animate;Element.prototype.animate=function(frames,options){const animation=original.call(this,frames,options);if(this.classList.contains('conversation-main')){animation.pause();animation.currentTime=0;}return animation;};});
  const f=await fixture(page,denseReport);
  try{const point=await plotPoint(page,22,60,false);await page.touchscreen.tap(point.x,point.y);await expect(page.getByRole('combobox',{name:'选择记录查看数值'})).toHaveValue('22');}finally{await f.dispose()}
 });
});
test('changing report data never transfers a selected row or hidden series to unrelated values',async({page})=>{
 const f=await fixture(page,denseReport);
 try{
  const picker=page.getByRole('combobox',{name:'选择记录查看数值'});await picker.selectOption('5');await page.getByRole('button',{name:'方案甲',exact:true}).click();
  await f.hub.store.publishBotMessage('alpha',{id:'report_one',conversationId:f.conversation.id,status:'complete',blocks:[widgetBlock({title:'已更新的数据',summary:'缺失值与全零值',report:{version:1,columns:['日期','方案甲','方案乙'],rows:[['新记录',null,0],['另一条',null,0]],chart:{kind:'line',category:0,values:[1,2]}}})]});
  await expect(page.locator('.report-header')).toContainText('已更新的数据');await expect(picker).toHaveValue('0');await expect(page.getByRole('button',{name:'方案甲',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.report-selection')).toContainText('—');await expect(page.locator('.report-selection')).toContainText('0');
  expect(await page.locator('.report-chart > svg').innerHTML()).not.toMatch(/(?:NaN|Infinity)/);
 }finally{await f.dispose()}
});

test('a replaced small report clears a filter that can no longer be edited',async({page})=>{
 const f=await fixture(page,denseReport);
 try{
  await page.getByRole('searchbox',{name:'筛选报告'}).fill('2026-01-01');
  await expect(page.getByRole('combobox',{name:'选择记录查看数值'}).locator('option')).toHaveCount(1);
  await f.hub.store.publishBotMessage('alpha',{id:'report_one',conversationId:f.conversation.id,status:'complete',blocks:[widgetBlock({title:'新的两条记录',summary:'全部记录',report:{version:1,columns:['类别','数值'],rows:[['新记录甲',4],['新记录乙',8]],chart:{kind:'bar',category:0,values:[1]}}})]});
  await expect(page.locator('.report-header')).toContainText('新的两条记录');
  await expect(page.getByRole('searchbox',{name:'筛选报告'})).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'选择记录查看数值'}).locator('option')).toHaveCount(2);
  await expect(page.locator('.inline-report')).not.toContainText('没有匹配的记录');
 }finally{await f.dispose()}
});

test('keyboard record selection takes priority over an earlier mouse hover',async({page})=>{
 const f=await fixture(page,denseReport);
 try{
  const picker=page.getByRole('combobox',{name:'选择记录查看数值'}),point=await plotPoint(page,10);
  await page.mouse.move(point.x,point.y);await expect(picker).toHaveValue('10');
  await picker.focus();await picker.selectOption('20');await expect(picker).toHaveValue('20');
  await page.getByRole('button',{name:'下一条记录'}).focus();await page.keyboard.press('Enter');await expect(picker).toHaveValue('21');
 }finally{await f.dispose()}
});

for(const width of [320,1360])test(`line chart scales visible values honestly and bars keep zero at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:950});
 const data:ReportData={version:1,columns:['日期','指标','对照'],rows:[['第一天',1400,9000],['第二天',1550,10000],['第三天',1700,11000]],chart:{kind:'line',category:0,values:[1,2]}};
 const f=await fixture(page,data),panel=page.locator('.inline-report');
 const ticks=()=>panel.locator('.report-y-label').evaluateAll(nodes=>nodes.map(node=>Number(node.getAttribute('data-value'))));
 const replace=async(rows:ReportData['rows'],kind:'line'|'bar'='line')=>{
  await f.hub.store.publishBotMessage('alpha',{id:'report_one',conversationId:f.conversation.id,status:'complete',blocks:[widgetBlock({title:'范围检查',summary:'原始数值保持不变。',report:{version:1,columns:['记录','数值'],rows,chart:{kind,category:0,values:[1]}}})]});
  await expect(panel.getByRole('combobox',{name:'选择记录查看数值'}).locator('option').first()).toHaveText(String(rows[0]![0]));
 };
 try{
  await expect(panel.locator('.report-scale-note')).toHaveText('纵轴按可见数据缩放');
  await panel.getByRole('button',{name:'对照',exact:true}).click();await expect(panel.locator('[data-series="2"]')).toHaveCount(0);
  expect(Math.min(...await ticks())).toBeGreaterThan(0);expect(Math.max(...await ticks())).toBeGreaterThan(1700);
  const proportion=await panel.locator('.report-chart > svg').evaluate(svg=>{
   const positions=[...svg.querySelectorAll('[data-series="1"] circle')].map(node=>Number(node.getAttribute('cy'))),cursor=svg.querySelector('.report-cursor')!;
   return (Math.max(...positions)-Math.min(...positions))/(Number(cursor.getAttribute('y2'))-Number(cursor.getAttribute('y1')));
  });expect(proportion).toBeGreaterThan(.5);
  await panel.getByRole('combobox',{name:'选择记录查看数值'}).selectOption('1');await expect(panel.locator('.report-selection')).toContainText('1,550');
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   await panel.screenshot({path:info.outputPath(`report-domain-price-${width}-${theme}.png`)});
   expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  }
  await panel.getByRole('button',{name:'对照',exact:true}).click();expect(Math.max(...await ticks())).toBeGreaterThanOrEqual(11000);
  await replace([['柱甲',1400],['柱乙',1700]],'bar');expect(await ticks()).toContain(0);await expect(panel.locator('.report-scale-note')).toHaveCount(0);
  await replace([['零甲',0],['零乙',0]]);expect(Math.min(...await ticks())).toBeLessThan(0);expect(Math.max(...await ticks())).toBeGreaterThan(0);
  const ys=await panel.locator('circle').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('cy')));expect(new Set(ys).size).toBe(1);
  await replace([['负甲',-1700],['负乙',-1400]]);expect(Math.max(...await ticks())).toBeLessThan(0);
  await replace([['跨甲',-4],['跨乙',2]]);expect(await ticks()).toContain(0);
  for(const rows of [[['小甲',1.4e-9],['小乙',1.7e-9]],[['大甲',9e11],['大乙',9e11+.0001]]] as ReportData['rows'][]){
   await replace(rows);const labels=await panel.locator('.report-y-label').allTextContents();expect(new Set(labels).size).toBe(labels.length);
   expect(await panel.locator('.report-chart > svg').innerHTML()).not.toMatch(/(?:NaN|Infinity)/);
   expect(await panel.locator('.report-chart > svg').evaluate(svg=>{const r=svg.getBoundingClientRect();return [...svg.querySelectorAll('.report-y-label')].every(node=>{const box=node.getBoundingClientRect();return box.left>=r.left-1&&box.right<=r.right+1})})).toBe(true);
  }
  await replace([['空甲',null],['空乙',null]]);await expect(panel.getByRole('status')).toHaveText('暂无可绘制的数值');await expect(panel.locator('.report-chart > svg')).toHaveCount(0);
  await expect(panel.getByRole('combobox',{name:'选择记录查看数值'}).locator('option')).toHaveCount(2);await expect(panel.locator('.report-selection')).toContainText('—');
 }finally{await f.dispose()}
});
