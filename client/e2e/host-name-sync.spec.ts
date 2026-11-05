import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { clickAppAction } from './fixtures/desktop-actions.js';
import { openSettings } from './fixtures/settings.js';
import { desktopControllerMarkerKey } from '../../src/hub/local-controller.js';

test.use({ serviceWorkers: 'block' });
async function pair(page: Page, hub: HubServer, alias: string) {
  await page.goto(hub.url);
  await page.getByRole('textbox', { name: '主机名称', exact: true }).fill(alias);
  await page.getByRole('textbox', { name: 'Hub 地址', exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await expect(page.getByLabel('配对码', { exact: true })).toBeHidden({ timeout: 20_000 });
}
async function manager(page: Page) {
  await clickAppAction(page, '设备与网络');
  await page.getByRole('button', { name: '此设备的连接', exact: true }).click();
  return page.getByRole('dialog', { name: '此设备的连接', exact: true });
}

test('the native host device has one shared name in desktop and phone settings, while accessing devices keep their own names', async ({ page, browser }) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'host-device-name-'));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve('dist') });
  const other = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const phone = await other.newPage();
  try {
    await hub.profile.update({ name: 'example-mac', revision: (await hub.profile.read()).revision });
    await pair(page, hub, 'example-mac');
    const desktopId = ((await hub.store.devices('owner')).filter(device => device.id !== "pairing_fixture_owner"))[0]!.id;
    const desktop = (await hub.store.device(desktopId))!;
    // Browser rendering stand-in for a native-enrolled controller. The actual
    // challenge/signature and old-marker migration are covered by Hub tests.
    await hub.store.db.transaction(async () => {
      await hub.store.db.run('UPDATE devices SET name=?,platform=? WHERE id=?', ['这台电脑', 'macos', desktopId]);
      await hub.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [desktopControllerMarkerKey(desktopId), JSON.stringify({ id: desktopId, publicKey: desktop.public_key, nameSource: 'host' })]);
      await hub.profile.syncDesktopNameInTransaction(desktopId);
    });
    await pair(phone, hub, 'example-mac');
    const accessing = ((await hub.store.devices('owner')).filter(device => device.id !== "pairing_fixture_owner")).find(device => device.id !== desktopId)!;
    const currentRow = page.locator(`[data-device-id="${desktopId}"]`);
    const phoneHostRow = phone.locator(`[data-device-id="${desktopId}"]`);
    const phoneCurrentRow = phone.locator(`[data-device-id="${accessing.id}"]`);
    await openSettings(page, 'devices'); await openSettings(phone, 'devices');
    await expect(currentRow.locator('.device-display-name')).toHaveText('example-mac');
    await expect(phoneHostRow.locator('.device-display-name')).toHaveText('example-mac');
    await expect(phoneCurrentRow.locator('.device-display-name')).toHaveText(accessing.name);
    await currentRow.getByRole('button', { name: '管理', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '管理设备', exact: true });
    await expect(detail).toContainText('无需单独改名');
    await expect(detail.getByRole('button', { name: /^重命名设备 / })).toHaveCount(0);
    await expect(detail.locator('.device-name-hint')).toHaveCount(0);
    await detail.getByRole('button', { name: '修改主机名称', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'example-mac', exact: true });
    await expect(rename).toBeVisible();
    await rename.getByRole('button', { name: '修改主机名称', exact: true }).click();
    await rename.getByLabel('主机名称', { exact: true }).fill('工作室 Mac');
    await rename.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '工作室 Mac', exact: true })).toBeVisible();
    expect((await hub.profile.read()).name).toBe('工作室 Mac');
    await expect(phoneHostRow.locator('.device-display-name')).toHaveText('工作室 Mac', { timeout: 15_000 });
    await expect(phoneCurrentRow.locator('.device-display-name')).toHaveText(accessing.name);
    await phoneCurrentRow.getByRole('button', { name: '管理', exact: true }).click();
    await expect(phone.getByRole('dialog', { name: '管理设备', exact: true }).getByRole('button', { name: `重命名设备 ${accessing.name}`, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: '工作台：工作室 Mac，已连接', exact: true })).toBeVisible();
    await openSettings(page, 'devices');
    await expect(currentRow.locator('.device-display-name')).toHaveText('工作室 Mac');
  } finally { await other.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a shared rename reaches another device and survives reload when network metadata fails', async ({ page, browser }) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'host-name-sync-'));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve('dist') });
  const other = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  try {
    await hub.profile.update({ name: 'system-name.local', revision: (await hub.profile.read()).revision });
    await pair(page, hub, '旧本地备注');
    const phone = await other.newPage(); await pair(phone, hub, '另一份备注');
    await phone.getByRole('button', { name: '我的', exact: true }).click();
    await expect(phone.locator('.mh-me')).toContainText('system-name.local');
    const dialog = await manager(page);
    // The host-name endpoint still works; a failed network directory must not
    // prevent saving or make the already acknowledged rename look unsuccessful.
    await page.route('**/api/network', route => route.fulfill({ status: 503, json: { error: 'fixture-network-unavailable' } }));
    await dialog.getByRole('button', { name: '修改名称', exact: true }).click();
    await dialog.getByLabel('主机名称', { exact: true }).fill('example-mac');
    await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('主机名称已保存为「example-mac」');
    expect((await hub.profile.read()).name).toBe('example-mac');
    await expect(phone.locator('.mh-me')).toContainText('example-mac', { timeout: 15_000 });
    await page.reload();
    await expect(page.getByRole('button', { name: '工作台：example-mac，已连接', exact: true })).toBeVisible();
    const reopened = await manager(page);
    await reopened.getByRole('button', { name: '修改名称', exact: true }).click();
    await expect(reopened.getByLabel('主机名称', { exact: true })).toHaveValue('example-mac');
    // A newer name set through the host API (including CLI) must be reflected
    // in both devices, even with the directory still failing on this one.
    await hub.profile.update({ name: 'example-mac 工作室', revision: (await hub.profile.read()).revision });
    await expect(reopened.getByLabel('主机名称', { exact: true })).toHaveValue('example-mac 工作室', { timeout: 15_000 });
    await expect(phone.locator('.mh-me')).toContainText('example-mac 工作室', { timeout: 15_000 });
    // Stop the disposable Hub to close the actual WebSocket. WebKit's network
    // emulation can leave an already established localhost socket connected.
    await hub.close();
    await expect(reopened.getByRole('button', { name: '保存名称', exact: true })).toBeDisabled({ timeout: 20_000 });
  } finally { await other.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an unsupported shared rename keeps the previous name instead of saving a local alias', async ({ page }) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'host-name-unsupported-'));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve('dist') });
  try {
    await hub.profile.update({ name: 'original', revision: (await hub.profile.read()).revision });
    await pair(page, hub, 'original');
    const dialog = await manager(page);
    await page.route('**/api/host-profile', route => route.fulfill({ status: 404, json: { error: 'not_found' } }));
    await dialog.getByRole('button', { name: '修改名称', exact: true }).click();
    await dialog.getByLabel('主机名称', { exact: true }).fill('should-not-save');
    await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('名称未改变');
    expect((await hub.profile.read()).name).toBe('original');
    await page.reload();
    await expect(page.getByRole('button', { name: '工作台：original，已连接', exact: true })).toBeVisible();
  } finally { await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
