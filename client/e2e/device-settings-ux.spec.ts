import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { openSettings, closeSettings, openDevicePairing, closeDevicePairing } from "./fixtures/settings.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const hostName = "设备验收主机";
const knownId = "phone_known_a1b2c3", unknownId = "phone_unknown_d4e5f6";
const pairedAt = Date.parse("2026-10-01T02:30:00Z");
const unknownApproval = "没有收到主机的确认结果，授权可能已经生效。请查看新设备是否自动进入聊天；也可以点击「重新检查连接」，无需重新扫码。";
const wizard = (page: Page) => page.getByRole("dialog", { name: "添加设备", exact: true });
const device = (page: Page, id: string) => page.locator(`[data-device-id="${id}"]`);
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

async function fixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "device-settings-ux-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    // The shared host profile is authoritative; a client alias is not a host rename.
    await hub.profile.update({ name: hostName, revision: (await hub.profile.read()).revision });
    await page.goto(hub.url);
    await page.getByLabel("主机名称", { exact: true }).fill(hostName);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    const seenAt = Date.now() - 2 * 60 * 60 * 1000;
    await hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES(?,?,?,?,?,?,?)", [knownId,"owner","同名手机","android","fixture-known",pairedAt,seenAt]);
    await hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES(?,?,?,?,?,?,?)", [unknownId,"owner","同名手机","android","fixture-unknown",0,0]);
    return { hub, seenAt, dispose: async () => { await page.close(); await hub.close(); await rm(root,{recursive:true,force:true}); } };
  } catch (error) { await page.close(); await hub.close(); await rm(root,{recursive:true,force:true}); throw error; }
}
async function requestPairing(page: Page, hub: HubServer, name: string) {
  await page.goto(hub.url); await page.getByLabel("设备名称",{exact:true}).fill(name);
  await preparePairing(page, hub); await page.getByRole("button",{name:"配对此设备",exact:true}).click();
  return page.getByLabel("配对码",{exact:true}).innerText();
}
async function containedHorizontally(dialog: Locator) {
  expect(await dialog.evaluate(element => {
    const rect=element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= innerWidth+1 && element.scrollWidth <= element.clientWidth;
  })).toBe(true);
  expect(await dialog.locator("button,input").evaluateAll(elements => elements.filter(element => element.getClientRects().length).every(element => {
    const rect=element.getBoundingClientRect(); return rect.left >= -1 && rect.right <= innerWidth+1;
  }))).toBe(true);
}

test("same-name device details distinguish IDs and unknown times; delayed revoke stays scoped and admits one write", async ({ page }) => {
  const { hub, seenAt, dispose } = await fixture(page), held = barrier(); let posts=0;
  try {
    await openSettings(page,"devices");
    const known=device(page,knownId), unknown=device(page,unknownId);
    await expect(known).toContainText("ID …a1b2c3"); await expect(unknown).toContainText("ID …d4e5f6");
    await expect(known.locator("time")).toHaveAttribute("datetime",new Date(seenAt).toISOString());
    await expect(unknown).toContainText("暂无连接记录"); await expect(unknown.locator("time")).toHaveCount(0);
    await unknown.getByRole("button",{name:"管理",exact:true}).click();
    const detail = page.getByRole("dialog",{name:"管理设备",exact:true});
    await detail.getByRole("button",{name:"撤销授权",exact:true}).click();
    const confirmation=page.getByRole("dialog",{name:"撤销设备授权？",exact:true});
    await expect(confirmation).toContainText("同名手机 · Android · ID …d4e5f6");
    await expect(confirmation.locator(".device-facts")).toContainText("未记录");
    await expect(confirmation.locator(".device-facts")).toContainText("暂无连接记录");
    await confirmation.getByRole("button",{name:"取消",exact:true}).click();
    await detail.getByRole("button",{name:"返回设备列表",exact:true}).click();
    await known.getByRole("button",{name:"管理",exact:true}).click();
    await detail.getByRole("button",{name:"撤销授权",exact:true}).click();
    const expectedDate=await page.evaluate(at=>new Intl.DateTimeFormat("zh",{dateStyle:"medium",timeStyle:"short"}).format(at),pairedAt);
    await expect(confirmation.locator(".device-facts")).toContainText(expectedDate);
    await expect(confirmation.locator("time")).toHaveAttribute("datetime",new Date(seenAt).toISOString());
    await expect(confirmation).toContainText("同名手机 · Android · ID …a1b2c3");
    await page.route("**/api/devices/revoke",async route=>{ posts++; await held.promise; await route.continue(); });
    await confirmation.getByRole("button",{name:"撤销授权",exact:true}).click();
    await expect.poll(()=>posts).toBe(1);
    const pending=detail.getByRole("button",{name:"正在撤销…",exact:true});
    await expect(pending).toBeDisabled();
    await expect(detail.getByRole("status")).toHaveText("正在撤销「同名手机 · Android · ID …a1b2c3」的访问授权…");
    await pending.evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
    await expect(confirmation).toHaveCount(0); expect(posts).toBe(1);
    held.release(); await expect(known).toContainText("已撤销授权");
    await expect.poll(async()=> (await hub.store.db.get<{revoked:number}>("SELECT revoked FROM devices WHERE id=?",[knownId]))?.revoked).toBe(1);
    expect((await hub.store.db.get<{revoked:number}>("SELECT revoked FROM devices WHERE id=?",[unknownId]))?.revoked).toBe(0);
    expect(posts).toBe(1);
  } finally { held.release(); await dispose(); }
});

test("a delayed real approval keeps progress visible, then completes and focuses the exact newly added device", async ({ page, browser }) => {
  await page.setViewportSize({width:390,height:844});
  const {hub,dispose}=await fixture(page), otherContext=await browser.newContext({serviceWorkers:"block"}), other=await otherContext.newPage(), held=barrier();
  let posts=0, approvedId="";
  try {
    const code=await requestPairing(other,hub,"新配对手机");
    await openSettings(page,"devices"); await openDevicePairing(page);
    await wizard(page).getByLabel("新设备配对码",{exact:true}).fill(code);
    await page.route("**/api/devices/approve",async route=>{
      posts++; const response=await route.fetch(); expect(response.ok()).toBe(true);
      approvedId=(await response.json() as {deviceId:string}).deviceId;
      await held.promise; await route.fulfill({response});
    });
    await wizard(page).getByRole("button",{name:"确认配对",exact:true}).click();
    await expect.poll(()=>approvedId).not.toBe("");
    const pending=wizard(page).getByRole("button",{name:"正在确认…",exact:true});
    await expect(pending).toHaveAttribute("aria-disabled","true");
    expect(await pending.evaluate((button:HTMLButtonElement)=>button.disabled)).toBe(false);
    await expect(wizard(page).getByRole("status")).toHaveText(`正在主机「${hostName}」上确认配对码 ${code.slice(0,4)} ${code.slice(4)} 对应的新设备…`);
    await pending.evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
    await page.keyboard.press("Escape");
    await expect(wizard(page).getByRole("heading",{name:"输入新设备上的 8 位配对码",exact:true})).toBeVisible();
    expect(posts).toBe(1); held.release();
    await expect(wizard(page).getByRole("heading",{name:"新设备自动连接",exact:true})).toBeVisible();
    await expect(wizard(page).getByRole("status")).toHaveText(`已在主机「${hostName}」上确认新设备。`);
    await other.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(other);
    expect((await hub.store.db.get<{name:string}>("SELECT name FROM devices WHERE id=?",[approvedId]))?.name).toBe("新配对手机");
    await wizard(page).getByRole("button",{name:"完成",exact:true}).click();
    const row=device(page,approvedId); await expect(row).toHaveClass(/just-added/); await expect(row).toBeFocused(); await expect(row).toBeInViewport();
    await expect(row).toContainText("新配对手机"); expect(posts).toBe(1);
  } finally { held.release(); await otherContext.close(); await dispose(); }
});

test("lost approval acknowledgment stays uncertain without a second POST or false completion, while the new device can connect", async ({ page, browser }) => {
  const {hub,dispose}=await fixture(page), otherContext=await browser.newContext({serviceWorkers:"block"}), other=await otherContext.newPage();
  let posts=0, approvedId="";
  try {
    const code=await requestPairing(other,hub,"回执丢失手机");
    await openSettings(page,"devices"); await openDevicePairing(page);
    await wizard(page).getByLabel("新设备配对码",{exact:true}).fill(code);
    await page.route("**/api/devices/approve",async route=>{
      posts++; const response=await route.fetch(); expect(response.ok()).toBe(true);
      approvedId=(await response.json() as {deviceId:string}).deviceId;
      await route.abort("failed");
    });
    await wizard(page).getByRole("button",{name:"确认配对",exact:true}).click();
    await expect(wizard(page).getByRole("alert")).toHaveText(unknownApproval);
    await expect(wizard(page).getByRole("heading",{name:"输入新设备上的 8 位配对码",exact:true})).toBeVisible();
    await expect(wizard(page).getByRole("heading",{name:"新设备自动连接",exact:true})).toHaveCount(0);
    await expect(wizard(page).getByRole("button",{name:"完成",exact:true})).toHaveCount(0);
    await expect(wizard(page).getByRole("button",{name:"已扫码，输入配对码",exact:true})).toHaveCount(0);
    await expect(page.locator(".device-row.just-added")).toHaveCount(0); expect(posts).toBe(1);
    await other.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(other);
    expect(approvedId).not.toBe(""); expect((await hub.store.db.get<{name:string}>("SELECT name FROM devices WHERE id=?",[approvedId]))?.name).toBe("回执丢失手机");
    await closeDevicePairing(page);
    await page.getByRole("button",{name:"刷新设备列表",exact:true}).click();
    await expect(device(page,approvedId)).toContainText("回执丢失手机");
    await expect(page.locator(".device-row.just-added")).toHaveCount(0);
    await expect(page.getByRole("alert").filter({hasText:unknownApproval})).toBeVisible(); expect(posts).toBe(1);
  } finally { await otherContext.close(); await dispose(); }
});

test("device detail guards name drafts and pairing Back works at 320px, 390px and landscape", async ({ page }) => {
  await page.setViewportSize({width:320,height:844}); const {dispose}=await fixture(page);
  try {
    await openSettings(page,"devices");
    await device(page,knownId).getByRole("button",{name:"管理",exact:true}).click();
    const detail=page.getByRole("dialog",{name:"管理设备",exact:true});
    await detail.getByRole("button",{name:"重命名设备 同名手机",exact:true}).click();
    const draft=page.getByLabel("设备新名称",{exact:true}); await draft.fill("尚未保存的手机名称");
    await page.keyboard.press("Escape");
    const discard=page.getByRole("dialog",{name:"放弃设备名称修改？",exact:true});
    await discard.getByRole("button",{name:"继续编辑",exact:true}).click();
    await expect(draft).toHaveValue("尚未保存的手机名称");
    await containedHorizontally(detail);
    await detail.getByRole("button",{name:"保存",exact:true}).click();
    await expect(detail.getByRole("button",{name:"重命名设备 尚未保存的手机名称",exact:true})).toBeVisible();
    await detail.getByRole("button",{name:"返回设备列表",exact:true}).click();
    for(const viewport of [{width:320,height:844},{width:390,height:844},{width:844,height:390}]) {
      await page.setViewportSize(viewport); await openDevicePairing(page,false,0);
      await expect(wizard(page).getByRole("heading",{name:"让新手机或电脑扫描二维码",exact:true})).toBeVisible();
      await containedHorizontally(wizard(page));
      const next=wizard(page).getByRole("button",{name:"已扫码，输入配对码",exact:true}); await next.scrollIntoViewIfNeeded(); await expect(next).toBeInViewport(); await next.click();
      await wizard(page).getByLabel("新设备配对码",{exact:true}).fill("12345678"); await containedHorizontally(wizard(page));
      await page.keyboard.press("Escape"); await expect(wizard(page).getByRole("heading",{name:"让新手机或电脑扫描二维码",exact:true})).toBeVisible();
      await wizard(page).getByRole("button",{name:"已扫码，输入配对码",exact:true}).click();
      await expect(wizard(page).getByLabel("新设备配对码",{exact:true})).toHaveValue("12345678");
      await page.evaluate(()=>window.dispatchEvent(new Event("tarocub-native-back",{cancelable:true})));
      await expect(wizard(page).getByRole("heading",{name:"让新手机或电脑扫描二维码",exact:true})).toBeVisible();
      await page.evaluate(()=>window.dispatchEvent(new Event("tarocub-native-back",{cancelable:true})));
      await expect(wizard(page)).toHaveCount(0); await expect(device(page,knownId)).toContainText("尚未保存的手机名称");
      await expect(page.getByRole("button",{name:"添加设备",exact:true})).toBeFocused();
      await expect(page.getByRole("dialog",{name:"设置",exact:true})).toBeVisible();
    }
    await closeSettings(page);
    await expect(page.getByRole("dialog",{name:"放弃未保存的修改？",exact:true})).toHaveCount(0);
  } finally { await dispose(); }
});

for (const width of [1280, 390]) test(`legacy device labels are neutral without renaming records at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const { hub, dispose } = await fixture(page), duplicateId = 'mac_legacy_112233';
  let writes = 0;
  try {
    const current = ((await hub.store.devices('owner')).filter(device => device.id !== "pairing_fixture_owner")).find(d => d.id !== knownId && d.id !== unknownId)!;
    await hub.store.db.run('UPDATE devices SET name=?,platform=? WHERE id=?', ['这台电脑', 'macos', knownId]);
    await hub.store.db.run('UPDATE devices SET name=? WHERE id=?', ['这台手机', unknownId]);
    await hub.store.db.run('INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES(?,?,?,?,?,?,?)', [duplicateId, 'owner', '这台主机', 'macos', 'fixture-duplicate', pairedAt, 0]);
    await page.route('**/api/devices/rename', async route => { writes++; await route.continue(); });
    await openSettings(page, 'devices');
    await expect(device(page, knownId).locator('.device-display-name')).toHaveText('Mac 电脑');
    await expect(device(page, unknownId).locator('.device-display-name')).toHaveText('Android 手机');
    await expect(device(page, duplicateId)).toHaveAttribute('aria-label', 'Mac 电脑 · Mac · ID …112233');
    await expect(page.getByRole('region', { name: '你正在使用', exact: true }).locator('.device-row')).toHaveAttribute('data-device-id', current.id);
    await device(page, duplicateId).getByRole('button', { name: '管理', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '管理设备', exact: true });
    await expect(detail.locator('.device-detail-heading strong')).toHaveText('Mac 电脑');
    await detail.getByRole('button', { name: '撤销授权', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '撤销设备授权？', exact: true });
    await expect(confirm).toContainText('Mac 电脑 · Mac · ID …112233');
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await detail.getByRole('button', { name: '返回设备列表', exact: true }).click();
    expect(writes).toBe(0);
    expect((await hub.store.device(knownId))?.name).toBe('这台电脑');
    expect((await hub.store.device(unknownId))?.name).toBe('这台手机');
    expect((await hub.store.device(duplicateId))?.name).toBe('这台主机');
    await device(page, knownId).getByRole('button', { name: '管理', exact: true }).click();
    await detail.getByRole('button', { name: '重命名设备 Mac 电脑', exact: true }).click();
    await expect(detail.getByLabel('设备新名称', { exact: true })).toHaveValue('Mac 电脑');
    await detail.getByLabel('设备新名称', { exact: true }).fill('办公 Mac');
    await detail.getByRole('button', { name: '保存', exact: true }).click();
    await expect(detail.getByRole('status')).toHaveText('设备名称已更新');
    await detail.getByRole('button', { name: '返回设备列表', exact: true }).click();
    await expect(device(page, knownId).locator('.device-display-name')).toHaveText('办公 Mac');
    expect(writes).toBe(1);
    await page.screenshot({ path: info.outputPath(`legacy-device-names-${width}.png`), animations: 'disabled' });
  } finally { await dispose(); }
});

test('current identity leads the list, legacy labels are neutral and revoked records stay collapsed', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const {hub, dispose} = await fixture(page);
  try {
    const current = ((await hub.store.devices('owner')).filter(device => device.id !== "pairing_fixture_owner")).find(d => d.id !== knownId && d.id !== unknownId)!;
    await hub.store.db.run('UPDATE devices SET name=?,created_at=? WHERE id=?', ['我的设备', Date.now() + 1000, current.id]);
    await hub.store.db.run('UPDATE devices SET name=?,revoked=1 WHERE id=?', ['我的设备', unknownId]);
    await openSettings(page, 'devices');
    const active = page.getByRole('region', {name:'你正在使用',exact:true});
    await expect(active.locator('.device-row')).toHaveAttribute('data-device-id', current.id);
    await expect(active).toContainText('浏览器设备'); await expect(active).toContainText('现在已连接');
    await expect(active.locator('time')).toHaveCount(0);
    expect(await page.locator('.device-row').first().getAttribute('data-device-id')).toBe(current.id);
    await expect(page.locator('.device-revoked')).not.toHaveAttribute('open');
    await expect(device(page,unknownId)).not.toBeVisible();
    await expect(page.getByRole('button',{name:'撤销授权',exact:true})).toHaveCount(0);
    await active.getByRole('button',{name:'管理',exact:true}).click();
    const detail=page.getByRole('dialog',{name:'管理设备',exact:true});
    await expect(detail.getByRole('button',{name:'撤销授权',exact:true})).toHaveCount(0);
    await expect(detail.locator('.device-name-hint')).toBeVisible();
    await detail.getByRole('button',{name:'不再提示',exact:true}).click();
    await detail.getByRole('button',{name:'返回设备列表',exact:true}).click();
    await active.getByRole('button',{name:'管理',exact:true}).click();
    await expect(detail.locator('.device-name-hint')).toHaveCount(0);
    await detail.getByRole('button',{name:'重命名设备 浏览器设备',exact:true}).click();
    await detail.getByLabel('设备新名称',{exact:true}).fill('MacBook Pro');
    await detail.getByRole('button',{name:'保存',exact:true}).click();
    await expect(detail.getByRole('status')).toHaveText('设备名称已更新');
    await detail.getByRole('button',{name:'返回设备列表',exact:true}).click();
    await expect(active).toContainText('MacBook Pro');
    await page.locator('.device-revoked > summary').click();
    await device(page,unknownId).getByRole('button',{name:'查看记录',exact:true}).click();
    await expect(detail.locator('.device-detail-heading strong')).toHaveText('Android 手机');
    await expect(detail.getByRole('status')).toHaveCount(0); // A prior device's rename result must not follow into another record.
    await expect(detail.getByRole('button',{name:/重命名设备|撤销授权/})).toHaveCount(0);
    await detail.getByRole('button',{name:'返回设备列表',exact:true}).click();
    await page.reload(); await waitForClientOnline(page); await openSettings(page,'devices');
    await expect(page.getByRole('region',{name:'你正在使用',exact:true})).toContainText('MacBook Pro');
    await expect(page.locator('.device-revoked')).not.toHaveAttribute('open');
    await page.screenshot({path:info.outputPath('devices-phone.png'),animations:'disabled'});
    await page.setViewportSize({width:1280,height:900});
    await expect(page.getByRole('region',{name:'你正在使用',exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('devices-desktop.png'),animations:'disabled'});
  } finally { await dispose(); }
});

test('phone device details fill the viewport and keep their header below the safe area', async ({ page }) => {
  await page.setViewportSize({width:390,height:844}); const {dispose}=await fixture(page);
  try {
    await openSettings(page,'devices');
    await page.evaluate(()=>document.documentElement.style.setProperty('--app-safe-top','47px'));
    await device(page,knownId).getByRole('button',{name:'管理',exact:true}).click();
    const detail=page.getByRole('dialog',{name:'管理设备',exact:true});
    const geometry=await detail.evaluate(element=>{const r=element.getBoundingClientRect(),h=element.querySelector('header')!.getBoundingClientRect();return {top:r.top,left:r.left,width:r.width,height:r.height,header:h.top,w:innerWidth,h:innerHeight};});
    expect(geometry.top).toBeCloseTo(0,0); expect(geometry.left).toBeCloseTo(0,0);
    expect(geometry.width).toBeCloseTo(geometry.w,0); expect(geometry.height).toBeCloseTo(geometry.h,0); expect(geometry.header).toBeGreaterThanOrEqual(47);
    await containedHorizontally(detail);
  } finally { await dispose(); }
});
