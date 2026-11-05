import { test, expect, type Page } from "@playwright/test";
import { mountWidget } from "./fixtures/widget-runtime-host.js";

// Generated widgets run in the Worker's virtual DOM; users see the trusted
// viewer's real controls. These cases use ordinary authoring patterns and
// assert what the user actually sees, not only the Worker's own view.
test.use({ serviceWorkers: "block", trace: "off" });
const prop = (page: Page, selector: string, name: string) => mountedGuest(page).locator(selector).evaluate((node, name) => (node as unknown as Record<string, unknown>)[name], name);
const mountedGuest = (page: Page) => page.frameLocator("iframe").frameLocator("iframe");
const ready = async (page: Page, selector: string) => expect(mountedGuest(page).locator(selector)).toHaveAttribute("data-tarobot-node", /\d+/);

test("innerText preserves native multiline text without parsing HTML",async({page},info)=>{
 const values=['first\n\n<img src=x onerror=evil()>\r\nlast\r',null,undefined,0,false];
 const expression=`['first\\n\\n<img src=x onerror=evil()>\\r\\nlast\\r',null,undefined,0,false]`;
 const native=await page.evaluate(values=>values.map(value=>{const node=document.createElement('div');node.innerText=value as string;return {text:node.textContent,br:node.querySelectorAll('br').length,images:node.querySelectorAll('img').length}}),values);
 const {guest}=await mountWidget(page,`<button id="go">Apply</button><section id="list"></section><script>document.getElementById('go').onclick=()=>{${expression}.forEach((value,index)=>{const node=document.createElement('p');node.id='case'+index;node.innerText=value;document.getElementById('list').appendChild(node)})};</script>`);
 await expect(guest.locator('#go')).toHaveAttribute('data-tarobot-node',/\d+/);await guest.locator('#go').click();
 await expect(guest.locator('#list p')).toHaveCount(5);
 const actual=await guest.locator('#list p').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,br:node.querySelectorAll('br').length,images:node.querySelectorAll('img').length})));
 await info.attach('innerText.json',{body:JSON.stringify({native,actual}),contentType:'application/json'});
 expect(actual).toEqual(native);
});

test("a dense SVG slider coalesces snapshots without quarantining normal dragging",async({page})=>{
 const {guest,messages}=await mountWidget(page,`<input id="k" type="range" min="1" max="100" value="50"><p id="out"></p><input id="mirror"><input id="odd" type="checkbox"><svg id="g" viewBox="0 0 40 40" width="300" height="300"></svg><script>
 const g=document.getElementById('g'),k=document.getElementById('k'),out=document.getElementById('out'),rects=[];
 for(let i=0;i<1600;i++){const r=document.createElementNS('http://www.w3.org/2000/svg','rect');for(const [name,value] of Object.entries({x:i%40,y:Math.floor(i/40),width:1,height:1}))r.setAttribute(name,value);g.appendChild(r);rects.push(r)}
 const draw=()=>{const v=Number(k.value);rects.forEach((r,i)=>r.setAttribute('fill','hsl('+((i*v)%360)+' 60% 50%)'));out.textContent='k='+v;document.getElementById('mirror').value='value-'+v;document.getElementById('odd').checked=v%2===1};k.addEventListener('input',draw);draw();</script>`);
 await ready(page,'#k');await expect(guest.locator('#g rect')).toHaveCount(1600);
 const box=(await guest.locator('#k').boundingBox())!;
 await page.mouse.move(box.x+8,box.y+box.height/2);await page.mouse.down();
 for(let i=0;i<65;i++){await page.mouse.move(box.x+8+(box.width-16)*(i%32)/31,box.y+box.height/2);await page.waitForTimeout(16)}
 await page.mouse.up();const value=await guest.locator('#k').inputValue();
 await expect(guest.locator('#out')).toHaveText('k='+value);
 // The last drag is followed by a final precise value; coalescing must retain
 // property-only changes as well as the large DOM snapshot that carries them.
 await guest.locator('#k').fill('97');
 await expect(guest.locator('#out')).toHaveText('k=97');await expect(guest.locator('#mirror')).toHaveValue('value-97');await expect(guest.locator('#odd')).toBeChecked();
 expect((await messages()).filter(m=>m.type==='tarobot-widget-error')).toEqual([]);
});

test("script changes reach dirty native controls without overwriting newer input", async ({ page }) => {
  const { guest } = await mountWidget(page, `<label><input type="checkbox" id="a" checked>收盘价</label><label><input type="checkbox" id="b" checked>MA20</label><label><input type="checkbox" id="all" checked>全部</label>
<label><input type="radio" name="p" value="d" id="pd" checked>日</label><label><input type="radio" name="p" value="w" id="pw">周</label>
<input type="range" id="r" min="0" max="100" step="5" value="20"><output id="rv">20</output><input id="t"><textarea id="ta">备注</textarea>
<select id="s"><option value="a">A</option><option value="b">B</option></select><select id="m" multiple><option>x</option><option>y</option><option>z</option></select>
<button id="none">全不选</button><button id="reset">重置</button><p id="log"></p><div id="list"></div><button id="clear">清空列表</button>
<script>const $=id=>document.getElementById(id),series=[$('a'),$('b')],state={u:true,v:true};
const sync=()=>{const n=series.filter(c=>c.checked).length;$('all').checked=n===2;$('all').indeterminate=n===1;$('log').textContent=JSON.stringify({p:document.querySelector('[name=p]:checked')?.value,r:$('r').valueAsNumber,s:$('s').selectedIndex,m:[...$('m').selectedOptions].map(o=>o.value).join(',')})};
const draw=()=>{$('list').innerHTML=Object.keys(state).map(k=>'<label><input type="checkbox" data-k="'+k+'" '+(state[k]?'checked':'')+'>'+k+'</label>').join('')};
series.forEach(c=>c.addEventListener('change',sync));$('all').addEventListener('change',()=>{series.forEach(c=>c.checked=$('all').checked);sync()});
for(const id of ['s','m'])$(id).addEventListener('change',sync);document.querySelectorAll('[name=p]').forEach(r=>r.addEventListener('change',sync));
$('r').addEventListener('input',e=>{$('rv').textContent=String(e.target.valueAsNumber)});$('t').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase()});
$('list').addEventListener('change',e=>{state[e.target.dataset.k]=e.target.checked;draw()});$('clear').addEventListener('click',()=>{state.u=state.v=false;draw()});
$('none').addEventListener('click',()=>{series.forEach(c=>c.checked=false);sync()});
$('reset').addEventListener('click',()=>{series.forEach(c=>c.checked=true);$('pd').checked=true;$('r').value=20;$('rv').textContent='20';$('t').value='';$('ta').value='已重置';$('s').value='a';[...$('m').options].forEach(o=>o.selected=false);sync()});
sync();draw();</script>`);
  await ready(page, "#a");
  await guest.locator("#a").click();
  await expect(guest.locator("#all")).not.toBeChecked();await expect.poll(() => prop(page, "#all", "indeterminate")).toBe(true);
  await guest.locator("#none").click();
  await expect(guest.locator("#a")).not.toBeChecked();await expect(guest.locator("#b")).not.toBeChecked();await expect.poll(() => prop(page, "#all", "indeterminate")).toBe(false);
  await guest.locator("#all").click();
  await expect(guest.locator("#a")).toBeChecked();await expect(guest.locator("#b")).toBeChecked();
  await guest.locator("#pw").click();await guest.locator("#r").fill("70");await expect(guest.locator("#rv")).toHaveText("70");
  await guest.locator("#t").pressSequentially("abc");await expect(guest.locator("#t")).toHaveValue("ABC");
  await guest.locator("#ta").fill("新的备注");await guest.locator("#s").selectOption("b");await guest.locator("#m").selectOption(["y", "z"]);
  await expect(guest.locator("#log")).toHaveText(JSON.stringify({ p: "w", r: 70, s: 1, m: "y,z" }));
  await guest.locator("#reset").click();
  await expect(guest.locator("#pd")).toBeChecked();await expect(guest.locator("#pw")).not.toBeChecked();
  await expect(guest.locator("#r")).toHaveValue("20");await expect(guest.locator("#t")).toHaveValue("");await expect(guest.locator("#ta")).toHaveValue("已重置");
  await expect(guest.locator("#s")).toHaveValue("a");await expect.poll(() => guest.locator("#m").evaluate(node => (node as HTMLSelectElement).selectedOptions.length)).toBe(0);
  // State-driven redraw replaces the Worker nodes; the reused real checkbox follows state.
  await guest.locator("[data-k=u]").click();await guest.locator("[data-k=u]").click();await guest.locator("#clear").click();
  await expect(guest.locator("[data-k=u]")).not.toBeChecked();await expect(guest.locator("[data-k=v]")).not.toBeChecked();
  // Rapid typing while each input redraws elsewhere is never rolled back.
  await guest.locator("#t").fill("");await guest.locator("#t").pressSequentially("abcdefghij", { delay: 0 });
  await page.waitForTimeout(300);await expect(guest.locator("#t")).toHaveValue("ABCDEFGHIJ");
});

test("local forms submit, serialize and reset inside the Worker", async ({ page }) => {
  const { guest } = await mountWidget(page, `<style>form{display:grid;gap:4px}@media (min-width:1px){form > .note{color:rgb(1, 2, 3)}}:is(section,form).calc{border-top:3px solid rgb(4, 5, 6)}.form-note,#form,[data-form]{outline:1px solid rgb(7, 8, 9)}[data-note="a form b"]{color:rgb(11, 22, 33)}</style><p data-note="a form b" id="quoted">引号</p><form id="f" class="calc"><span class="note">说明</span><input name="qty" id="qty" type="number" value="2"><label><input type="radio" name="mode" value="fast" checked>快</label><label><input type="radio" name="mode" value="slow" id="slow">慢</label><select name="city"><option>北京</option><option selected>上海</option></select><button id="go">计算</button><button type="reset" id="clear">清空</button></form><p id="out">-</p><p id="resets">0</p>
<script>let resets=0;const f=document.getElementById('f');
f.addEventListener('submit',e=>{e.preventDefault();document.getElementById('out').textContent=JSON.stringify({data:Object.fromEntries(new FormData(f)),mode:f.elements.mode.value,submitter:e.submitter?.id??null,qty:f.elements.qty.valueAsNumber,form:e.target instanceof HTMLFormElement})});
f.addEventListener('reset',()=>{document.getElementById('resets').textContent=String(++resets)});</script>`);
  await ready(page, "#go");
  expect(await guest.locator("form").count()).toBe(0);
  // The neutral box keeps form type selectors, including nested and :is() rules.
  const form = guest.locator("[data-tarobot-form][role=form].calc");
  await expect(form).toHaveCSS("display", "grid");await expect(form).toHaveCSS("border-top-color", "rgb(4, 5, 6)");
  await expect(guest.locator(".note")).toHaveCSS("color", "rgb(1, 2, 3)");await expect(form).not.toHaveCSS("outline-color", "rgb(7, 8, 9)");
  // A quoted attribute value that contains "form" is not a type selector.
  await expect(guest.locator("#quoted")).toHaveCSS("color", "rgb(11, 22, 33)");
  await guest.locator("#go").click();
  await expect(guest.locator("#out")).toHaveText(JSON.stringify({ data: { qty: "2", mode: "fast", city: "上海" }, mode: "fast", submitter: "go", qty: 2, form: true }));
  await guest.locator("#qty").fill("5");await guest.locator("#slow").check();await guest.locator("#qty").press("Enter");
  await expect(guest.locator("#out")).toHaveText(JSON.stringify({ data: { qty: "5", mode: "slow", city: "上海" }, mode: "slow", submitter: "go", qty: 5, form: true }));
  await guest.locator("#clear").click();
  await expect(guest.locator("#resets")).toHaveText("1");await expect(guest.locator("#qty")).toHaveValue("2");await expect(guest.getByRole("radio", { name: "快" })).toBeChecked();
});

test("pointer events keep browser semantics, real geometry and capture", async ({ page }) => {
  const { guest } = await mountWidget(page, `<div style="padding-left:150px"><svg id="svg" width="200" height="100" viewBox="0 0 400 200" style="display:block;touch-action:none"><g id="g"><rect id="r1" width="200" height="200" fill="#ccc"/><rect id="r2" x="200" width="200" height="200" fill="#999"/></g><circle id="h" cx="40" cy="100" r="16"/></svg></div><p id="hover">-</p><p id="pos">-</p><p id="drag">-</p><p id="inline">-</p><svg width="40" height="20"><rect id="mark" width="40" height="20" onclick="document.getElementById('inline').textContent='svg-inline:'+(this.id)"/></svg>
<script>const svg=document.getElementById('svg'),g=document.getElementById('g'),h=document.getElementById('h'),log=[];
g.addEventListener('mouseenter',e=>{log.push('enter:'+e.target.id);document.getElementById('hover').textContent=log.join(' ')});
g.addEventListener('mouseleave',e=>{log.push('leave:'+e.target.id);document.getElementById('hover').textContent=log.join(' ')});
svg.addEventListener('click',function(e){const r=svg.getBoundingClientRect();document.getElementById('pos').textContent=Math.round((e.clientX-r.left)*400/r.width)+','+(e instanceof MouseEvent)+','+this.id});
let dragging=false;h.addEventListener('pointerdown',e=>{dragging=true;h.setPointerCapture(e.pointerId)});
h.addEventListener('pointermove',e=>{if(!dragging)return;const r=svg.getBoundingClientRect();h.setAttribute('cx',String(Math.round(Math.max(0,Math.min(400,(e.clientX-r.left)*400/r.width)))))});
h.addEventListener('pointerup',()=>{dragging=false;document.getElementById('drag').textContent=h.getAttribute('cx')});</script>`);
  await ready(page, "#h");
  const box = (await guest.locator("#svg").boundingBox())!;
  await page.mouse.move(box.x + box.width + 60, box.y + 50);await page.mouse.move(box.x + 50, box.y + 50, { steps: 4 });
  await page.mouse.move(box.x + 150, box.y + 50, { steps: 4 });await page.mouse.move(box.x + box.width + 60, box.y + 50, { steps: 4 });
  await expect(guest.locator("#hover")).toHaveText("enter:g leave:g");
  await guest.locator("#svg").click({ position: { x: 50, y: 20 } });
  await expect(guest.locator("#pos")).toHaveText("100,true,svg");
  await page.mouse.move(box.x + 20, box.y + 50);await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 50, { steps: 12 });await page.waitForTimeout(150);
  await page.mouse.move(box.x + 150, box.y + box.height + 40, { steps: 4 });await page.mouse.up();
  await expect(guest.locator("#drag")).toHaveText("300");await expect(guest.locator("#h")).toHaveAttribute("cx", "300");
  await guest.locator("#mark").click();await expect(guest.locator("#inline")).toHaveText("svg-inline:mark");
});

test("listener order, this, once and cancelability follow the DOM", async ({ page }) => {
  const { guest } = await mountWidget(page, `<div id="outer"><button id="inner">x</button></div><pre id="log">-</pre><script>
const o=document.getElementById('outer'),i=document.getElementById('inner'),log=[];
o.addEventListener('click',function(){log.push('outer-capture:'+(this===o))},true);
i.addEventListener('click',function(e){log.push('inner:'+(this===i)+':'+e.eventPhase)});
o.addEventListener('click',e=>{log.push('outer-bubble:'+(e.currentTarget===o))});
document.addEventListener('click',()=>log.push('document'),{once:true});
window.addEventListener('click',{handleEvent(){log.push('window')}});
i.addEventListener('mouseenter',()=>log.push('enter'));window.addEventListener('mouseenter',()=>log.push('BAD'));
i.click();i.click();i.dispatchEvent(new MouseEvent('mouseenter'));
const e=new Event('custom');e.preventDefault();log.push('noncancelable:'+e.defaultPrevented);log.push('state:'+tarobot.state.initial);
document.getElementById('log').textContent=log.join(' ');</script>`);
  await expect(guest.locator("#log")).toHaveText("outer-capture:true inner:true:2 outer-bubble:true document window outer-capture:true inner:true:2 outer-bubble:true window enter noncancelable:false state:null");
});

test("keyboard reaches focused widgets and frame-level shortcuts", async ({ page }) => {
  const { guest } = await mountWidget(page, `<div id="lb" role="listbox" tabindex="0"><div role="option" aria-selected="true">一</div><div role="option">二</div><div role="option">三</div></div><p id="key">-</p><p id="doc">-</p>
<script>const lb=document.getElementById('lb');let i=0;
lb.addEventListener('keydown',e=>{if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;e.preventDefault();i=Math.max(0,Math.min(2,i+(e.key==='ArrowDown'?1:-1)));lb.querySelectorAll('[role=option]').forEach((o,j)=>o.ariaSelected=String(j===i));document.getElementById('key').textContent=i+':'+e.keyCode+':'+(e instanceof KeyboardEvent)});
document.addEventListener('keydown',e=>{if(e.key==='ArrowRight')document.getElementById('doc').textContent='right:'+(e.target===document.body)});</script>`);
  await ready(page, "#lb");
  await guest.locator("#lb").focus();await page.keyboard.press("ArrowDown");await page.keyboard.press("ArrowDown");
  await expect(guest.locator("#key")).toHaveText("2:40:true");await expect(guest.getByRole("option", { name: "三" })).toHaveAttribute("aria-selected", "true");
  await guest.locator("#doc").click();await page.keyboard.press("ArrowRight");
  await expect(guest.locator("#doc")).toHaveText("right:true");
});

test("details hierarchy follows script and user toggles without echo events", async ({ page }) => {
  const { guest } = await mountWidget(page, `<button id="expand">全部展开</button><button id="collapse">全部收起</button><details id="d1"><summary>一级</summary><details id="d2"><summary>二级</summary><p>内容</p></details></details><p id="toggles">0</p>
<script>let n=0;document.querySelectorAll('details').forEach(d=>d.addEventListener('toggle',()=>{document.getElementById('toggles').textContent=String(++n)}));
document.getElementById('expand').onclick=()=>document.querySelectorAll('details').forEach(d=>d.open=true);document.getElementById('collapse').onclick=()=>document.querySelectorAll('details').forEach(d=>d.open=false);</script>`);
  await ready(page, "#expand");
  await guest.locator("#expand").click();
  await expect.poll(() => prop(page, "#d2", "open")).toBe(true);expect(await prop(page, "#d1", "open")).toBe(true);
  await expect(guest.locator("#toggles")).toHaveText("2");await page.waitForTimeout(300);await expect(guest.locator("#toggles")).toHaveText("2");
  await guest.getByText("二级").click();await expect.poll(() => prop(page, "#d2", "open")).toBe(false);await expect(guest.locator("#toggles")).toHaveText("3");
  await guest.locator("#collapse").click();await expect.poll(() => prop(page, "#d1", "open")).toBe(false);
  await page.waitForTimeout(300);await expect(guest.locator("#toggles")).toHaveText("4");
});

test("composer handoff needs the current trusted click or submit and is single-use", async ({ page }) => {
  const host = await mountWidget(page, `<button id="ask">填入输入框</button><button id="later">稍后</button><button id="twice">两次</button><button id="slash">斜杠</button><button id="seen">监听</button><div id="hover" style="height:40px">悬停</div><form id="f"><input id="q" value="提交问题"></form><p id="out">-</p><p id="load">-</p>
<script>const out=document.getElementById('out'),show=v=>out.textContent=String(v);let seen=0;
// Guest code can reach the real Worker global but must not observe runtime messages.
(function(){return this})().addEventListener('message',()=>{seen++},true);
tarobot.prompt.compose('加载时').then(v=>document.getElementById('load').textContent=String(v));
document.getElementById('ask').onclick=async()=>show(await tarobot.prompt.compose('分析 A 与 B'));
document.getElementById('later').onclick=()=>setTimeout(async()=>show('later:'+await tarobot.prompt.compose('定时器')),0);
document.getElementById('twice').onclick=async()=>{const a=tarobot.prompt.compose('一'),b=tarobot.prompt.compose('二');show(await a+':'+await b)};
document.getElementById('slash').onclick=async()=>show('slash:'+await tarobot.prompt.compose('/stop'));
document.getElementById('seen').onclick=()=>show('seen:'+seen);
document.getElementById('hover').onmousemove=async()=>show('hover:'+await tarobot.prompt.compose('悬停'));
document.getElementById('f').onsubmit=async e=>{e.preventDefault();show('submit:'+await tarobot.prompt.compose(document.getElementById('q').value))};</script>`);
  const { guest } = host;
  const composed = async () => (await host.messages()).filter(message => message.type === "tarobot-widget-compose").map(message => message.text);
  await ready(page, "#ask");await expect(guest.locator("#load")).toHaveText("false");
  await guest.locator("#ask").click();await expect(guest.locator("#out")).toHaveText("true");
  const pause = () => page.waitForTimeout(600); // The relay limits handoffs to one per 500 ms.
  await pause();await guest.locator("#later").click();await expect(guest.locator("#out")).toHaveText("later:false");
  await pause();await guest.locator("#twice").click();await expect(guest.locator("#out")).toHaveText("true:false");
  await pause();await guest.locator("#slash").click();await expect(guest.locator("#out")).toHaveText("slash:false");
  await guest.locator("#hover").hover();await guest.locator("#hover").hover({ position: { x: 30, y: 10 } });await expect(guest.locator("#out")).toHaveText("hover:false");
  await host.composeAccepted(false);await pause();await guest.locator("#ask").click();await expect(guest.locator("#out")).toHaveText("false");
  await host.composeAccepted(true);await pause();await guest.locator("#q").press("Enter");await expect(guest.locator("#out")).toHaveText("submit:true");
  await guest.locator("#seen").click();await expect(guest.locator("#out")).toHaveText("seen:0");
  expect(await composed()).toEqual(["分析 A 与 B", "一", "分析 A 与 B", "提交问题"]);
});

test("hover cannot move focus from the App composer into a widget", async ({ page }) => {
  const { guest } = await mountWidget(page, `<input id="w"><div id="pad" style="height:120px">pad</div><script>document.getElementById('pad').addEventListener('mousemove',()=>document.getElementById('w').focus())</script>`);
  await ready(page, "#pad");
  await page.locator("#composer").click();await page.keyboard.type("ab");
  await guest.locator("#pad").hover();await guest.locator("#pad").hover({ position: { x: 40, y: 60 } });await page.waitForTimeout(300);
  await page.keyboard.type("cd");
  await expect(page.locator("#composer")).toHaveValue("abcd");await expect(guest.locator("#w")).toHaveValue("");
});

test("authored state is explicit, bounded JSON restored before scripts run", async ({ page }) => {
  const host = await mountWidget(page, `<button id="inc">增加</button><p id="count"></p><p id="big"></p><script>
let count=Number(tarobot.state.initial?.count)||0;const draw=()=>document.getElementById('count').textContent=String(count);draw();
document.getElementById('big').textContent=String(tarobot.state.set({text:'x'.repeat(20000)}));
document.getElementById('inc').onclick=()=>{count++;draw();tarobot.state.set({count})};</script>`, { restore: JSON.stringify({ count: 2 }) });
  const { guest } = host;
  await expect(guest.locator("#count")).toHaveText("2");await expect(guest.locator("#big")).toHaveText("false");
  await guest.locator("#inc").click();await expect(guest.locator("#count")).toHaveText("3");
  await expect.poll(async () => (await host.messages()).filter(message => message.type === "tarobot-widget-state").map(message => message.state).at(-1)).toBe(JSON.stringify({ count: 3 }));
});

test("IME composition is not interrupted by script normalization", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Uses Chromium's DevTools IME commands");
  const { guest } = await mountWidget(page, `<input id="ime"><p id="v">-</p><p id="c">0</p><script>let c=0;const ime=document.getElementById('ime');ime.addEventListener('compositionstart',()=>{document.getElementById('c').textContent=String(++c)});
ime.addEventListener('input',e=>{e.target.value=e.target.value.replace(/\\s+/g,'');document.getElementById('v').textContent=e.target.value})</script>`);
  await ready(page, "#ime");await guest.locator("#ime").click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });await page.waitForTimeout(150);
  await cdp.send("Input.imeSetComposition", { text: "zhong guo", selectionStart: 9, selectionEnd: 9 });await page.waitForTimeout(300);
  await cdp.send("Input.insertText", { text: "中国 人" });
  await expect(guest.locator("#c")).toHaveText("1");await expect(guest.locator("#ime")).toHaveValue("中国人");
});

test("script-only property changes from timers and promises reach real controls", async ({ page }) => {
  const { guest } = await mountWidget(page, `<input type="checkbox" id="cb" checked><input type="range" id="r" value="50"><select id="s"><option>a</option><option>b</option></select><textarea id="ta">x</textarea><input id="t"><button id="go">异步更新</button>
<script>const $=id=>document.getElementById(id);setTimeout(()=>{$('t').value='启动后'},100);
$('go').onclick=()=>{setTimeout(()=>{$('cb').checked=false;$('r').value=10},30);Promise.resolve().then(()=>new Promise(done=>setTimeout(done,60))).then(()=>{$('s').selectedIndex=1;$('ta').value='稍后';$('t').value='promise';$('cb').indeterminate=true})};</script>`);
  await ready(page, "#go");await expect(guest.locator("#t")).toHaveValue("启动后");
  await guest.locator("#cb").click();await guest.locator("#cb").click();await expect(guest.locator("#cb")).toBeChecked();
  await guest.locator("#r").fill("70");await guest.locator("#ta").fill("用户");await guest.locator("#go").click();
  await expect(guest.locator("#cb")).not.toBeChecked();await expect(guest.locator("#r")).toHaveValue("10");
  await expect(guest.locator("#s")).toHaveValue("b");await expect(guest.locator("#ta")).toHaveValue("稍后");await expect(guest.locator("#t")).toHaveValue("promise");
  await expect.poll(() => prop(page, "#cb", "indeterminate")).toBe(true);
});

test("local form constraints block submit with the browser's feedback", async ({ page }) => {
  const { guest } = await mountWidget(page, `<form id="f"><input id="name" name="name" required><input id="age" name="age" type="number" min="1" max="120"><input id="code" name="code" pattern="[A-Z]{3}"><input id="mail" name="mail" type="email"><input id="nick" name="nick"><button id="go">提交</button></form>
<form id="nv" novalidate><input required><button id="go2">直接提交</button></form><p id="out">-</p><p id="invalid">0</p>
<script>let n=0;const f=document.getElementById('f'),nick=document.getElementById('nick');
for(const el of f.elements)el.addEventListener('invalid',()=>{document.getElementById('invalid').textContent=String(++n)});
nick.addEventListener('input',()=>nick.setCustomValidity(nick.value==='admin'?'名称已占用':''));
f.onsubmit=e=>{e.preventDefault();document.getElementById('out').textContent='ok:'+Object.fromEntries(new FormData(f)).name};
document.getElementById('nv').onsubmit=e=>{e.preventDefault();document.getElementById('out').textContent='novalidate:'+document.getElementById('nv').checkValidity()};</script>`);
  await ready(page, "#go");
  await guest.locator("#go").click();
  await expect(guest.locator("#invalid")).toHaveText("1");await expect(guest.locator("#name")).toBeFocused();await expect(guest.locator("#out")).toHaveText("-");
  expect(await prop(page, "#name", "validationMessage")).not.toBe("");
  await guest.locator("#name").fill("甲");await guest.locator("#age").fill("200");await guest.locator("#code").fill("abc");await guest.locator("#mail").fill("x");
  await guest.locator("#go").click();
  await expect(guest.locator("#invalid")).toHaveText("4");await expect(guest.locator("#age")).toBeFocused();await expect(guest.locator("#out")).toHaveText("-");
  await guest.locator("#age").fill("30");await guest.locator("#code").fill("ABC");await guest.locator("#mail").fill("a@example.com");await guest.locator("#nick").fill("admin");
  await guest.locator("#go").click();
  await expect(guest.locator("#invalid")).toHaveText("5");await expect(guest.locator("#nick")).toBeFocused();
  await expect.poll(() => prop(page, "#nick", "validationMessage")).toBe("名称已占用");await expect(guest.locator("#out")).toHaveText("-");
  await guest.locator("#nick").fill("bob");await expect.poll(() => prop(page, "#nick", "validationMessage")).toBe("");
  await guest.locator("#name").press("Enter");await expect(guest.locator("#out")).toHaveText("ok:甲");
  await guest.locator("#go2").click();await expect(guest.locator("#out")).toHaveText("novalidate:false");
});

test("a queued control snapshot never overwrites newer typing with a later ACK", async ({ page }) => {
  const { guest } = await mountWidget(page, `<input id="q"><p id="status">-</p><script>const q=document.getElementById('q');q.addEventListener('input',()=>{if(q.value==='a')q.value='A';document.getElementById('status').textContent=q.value})</script>`);
  await ready(page, "#q");await guest.locator("#q").focus();
  // Hold the viewer's frame so the Worker's "A" snapshot is still queued when "b" is typed.
  await guest.locator("body").evaluate(() => { const frame = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = callback => setTimeout(() => frame(callback), 400) as unknown as number; });
  await page.keyboard.insertText("a");await page.waitForTimeout(150);await page.keyboard.insertText("b");
  await page.waitForTimeout(900);
  await expect(guest.locator("#q")).toHaveValue("ab");await expect(guest.locator("#status")).toHaveText("ab");
});

test(":checked follows live state while [checked] and [selected] stay literal", async ({ page }) => {
  const { guest } = await mountWidget(page, `<input type="checkbox" id="c0"><input type="checkbox" id="c1" checked><select id="s"><option id="o0" selected>a</option><option id="o1">b</option></select><i id="q" data-x=":checked"></i><pre id="out">-</pre><script>
const $=id=>document.getElementById(id),ids=selector=>[...document.querySelectorAll(selector)].map(node=>node.id).join(',');
$('c0').checked=true;$('c1').checked=false;$('s').selectedIndex=1;
$('out').textContent=JSON.stringify({attr:ids('input[checked]'),pseudo:ids('input:checked'),optionAttr:ids('option[selected]'),optionPseudo:ids('option:checked'),c0:$('c0').matches('[checked]'),c1:$('c1').matches('[checked]'),mixed:ids('input[checked]:not(:checked)'),quoted:ids('[data-x=":checked"]'),closest:$('c0').closest(':checked')?.id??null});</script>`);
  await expect(guest.locator("#out")).toHaveText(JSON.stringify({ attr: "c1", pseudo: "c0", optionAttr: "o0", optionPseudo: "o1", c0: false, c1: true, mixed: "c1", quoted: "q", closest: "c0" }));
});

test("custom validity clears on both sides and survives form reset", async ({ page }) => {
  const { guest } = await mountWidget(page, `<form id="f"><input id="q" name="q" value="原值"><button id="go">提交</button><button type="reset" id="rs">重置</button></form><button id="bad">设错误</button><button id="clear">清除</button><p id="out">0</p>
<script>const q=document.getElementById('q');let n=0;document.getElementById('bad').onclick=()=>{q.setCustomValidity('自定义问题');q.reportValidity()};document.getElementById('clear').onclick=()=>q.setCustomValidity('');
document.getElementById('f').onsubmit=e=>{e.preventDefault();document.getElementById('out').textContent=String(++n)};</script>`);
  await ready(page, "#bad");
  const invalid = () => guest.locator("#q").evaluate(node => (node as HTMLInputElement).matches(":invalid"));
  await guest.locator("#bad").click();
  await expect.poll(() => prop(page, "#q", "validationMessage")).toBe("自定义问题");expect(await invalid()).toBe(true);
  await guest.locator("#clear").click();
  await expect.poll(() => prop(page, "#q", "validationMessage")).toBe("");expect(await invalid()).toBe(false);
  await guest.locator("#go").click();await expect(guest.locator("#out")).toHaveText("1");
  await guest.locator("#bad").click();await guest.locator("#q").fill("改过");await guest.locator("#rs").click();
  await expect(guest.locator("#q")).toHaveValue("原值");await expect.poll(() => prop(page, "#q", "validationMessage")).toBe("自定义问题");
  await guest.locator("#go").click();await expect(guest.locator("#q")).toBeFocused();await page.waitForTimeout(200);await expect(guest.locator("#out")).toHaveText("1");
  await guest.locator("#clear").click();await guest.locator("#go").click();await expect(guest.locator("#out")).toHaveText("2");
});

test("keyup after a script normalization never rolls the value back", async ({ page }) => {
  const { guest } = await mountWidget(page, `<input id="k"><p id="status">-</p><script>const k=document.getElementById('k');k.addEventListener('input',()=>{if(k.value==='a')k.value='A';document.getElementById('status').textContent=k.value})</script>`);
  await ready(page, "#k");await guest.locator("#k").focus();
  // Ordinary frame timing: keydown, input (script writes A) and keyup carrying the old real "a".
  await page.keyboard.press("a");await page.waitForTimeout(300);
  await expect(guest.locator("#k")).toHaveValue("A");await expect(guest.locator("#status")).toHaveText("A");
});

test("user-changed choices keep [checked] as the markup default for resets", async ({ page }) => {
  const { guest } = await mountWidget(page, `<label><input type="checkbox" id="cb" checked>默认勾选</label><label><input type="radio" name="p" id="r1" value="d" checked>日</label><label><input type="radio" name="p" id="r2" value="w">周</label>
<span class="a:checked" id="escaped">转义</span><button id="read">读取</button><button id="defaults">恢复默认</button><pre id="out">-</pre><script>
const ids=selector=>[...document.querySelectorAll(selector)].map(node=>node.id).join(',');
document.getElementById('read').onclick=()=>{document.getElementById('out').textContent=JSON.stringify({attr:ids('input[checked]'),live:ids('input:checked'),changed:ids('input[checked]:not(:checked)'),matches:document.getElementById('cb').matches('[checked]:not(:checked)'),escaped:ids('.a\\\\:checked')})};
document.getElementById('defaults').onclick=()=>{const defaults=new Set(document.querySelectorAll('input[checked]'));for(const input of document.querySelectorAll('input'))input.checked=defaults.has(input)};</script>`);
  await ready(page, "#read");
  await guest.locator("#cb").click();await guest.locator("#r2").click();
  await expect(guest.locator("#cb")).not.toBeChecked();await expect(guest.locator("#r2")).toBeChecked();
  await guest.locator("#read").click();
  await expect(guest.locator("#out")).toHaveText(JSON.stringify({ attr: "cb,r1", live: "r2", changed: "cb,r1", matches: true, escaped: "escaped" }));
  await guest.locator("#defaults").click();
  await expect(guest.locator("#cb")).toBeChecked();await expect(guest.locator("#r1")).toBeChecked();await expect(guest.locator("#r2")).not.toBeChecked();
});
