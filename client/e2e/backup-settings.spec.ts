import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubMaintenance } from "../../src/hub/maintenance.js";
import { readBackupSettings, updateBackupSettings } from "../../src/hub/backup-settings.js";
import { openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "backup-settings-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "Mac mini", revision: (await hub.profile.read()).revision });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    const open = async () => { await openWorkspacePage(page, "设置"); await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^数据与备份/ }).click(); };
    await open();
    const panel = page.locator('.backup-settings'); await expect(panel.getByLabel('保留天数', { exact: true })).toHaveValue('1');
    return { root, hub, open, panel, dispose: async () => { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
for (const width of [1360, 390]) test(`retention saves, survives reload, and clears only automatic snapshots at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); const f = await fixture(page);
  try {
    const input = f.panel.getByLabel('保留天数', { exact: true }), save = f.panel.getByRole('button', { name: '保存备份设置', exact: true });
    await input.fill('3'); await save.click(); await expect(f.panel.getByRole('status')).toContainText('已保存并核实');
    expect((await readBackupSettings(f.hub.store.db)).retentionDays).toBe(3);
    await page.reload(); await waitForClientOnline(page); await f.open(); await expect(input).toHaveValue('3');
    const maintenance = new HubMaintenance(f.hub.store, f.root); await maintenance.dailyBackup();
    await writeFile(path.join(f.root, 'backups/manual.sqlite'), 'manual');
    await input.fill('0'); await save.click(); await expect(f.panel.getByRole('status')).toContainText('已保存并核实');
    await maintenance.dailyBackup(); await f.panel.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(f.panel).toContainText('已保留 0 份自动快照');
    expect(await readFile(path.join(f.root, 'backups/manual.sqlite'), 'utf8')).toBe('manual');
    await input.fill('1'); await save.click(); await expect(f.panel.getByRole('status')).toContainText('已保存并核实');
    await f.panel.locator('summary').click(); await expect(f.panel).toContainText('不包含附件原文件');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`backup-settings-${width}.png`) });
    if (width < 760) await page.getByRole('button', { name: '返回设置分类', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /^通用/ }).click();
    await page.locator('#theme').selectOption('dark'); await page.locator('#language').selectOption('en');
    if (width < 760) await page.getByRole('button', { name: 'Back to settings categories', exact: true }).click();
    await page.locator('[data-section="backups"]').click();
    await expect(f.panel.getByLabel('Retention days', { exact: true })).toHaveValue('1');
    await expect(f.panel).toContainText('Manual', { ignoreCase: true });
    await page.screenshot({ path: info.outputPath(`backup-settings-dark-en-${width}.png`) });
  } finally { await f.dispose(); }
});
test('rejects invalid numbers, preserves unsaved drafts and requires read-back after uncertain or conflicting saves', async ({ page }) => {
  const f = await fixture(page);
  try {
    const input = f.panel.getByLabel('保留天数', { exact: true }), save = f.panel.getByRole('button', { name: '保存备份设置', exact: true });
    await input.fill('-1'); await expect(save).toBeDisabled();
    await input.fill('2.5'); await expect(save).toBeDisabled();
    await input.fill(''); await expect(save).toBeDisabled();
    await input.fill('30'); await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click(); await expect(input).toHaveValue('30');
    await updateBackupSettings(f.hub.store, f.root, { requestId: 'other', revision: 'default', retentionDays: 7 }, 'owner', async () => {});
    await save.click(); await expect(f.panel.getByRole('alert')).toBeVisible(); await expect(save).toBeDisabled();
    await f.panel.getByRole('button', { name: '重新读取', exact: true }).click(); await expect(input).toHaveValue('7');
    let writes = 0;
    await page.route('**/api/settings/backups', async route => { if (route.request().method() !== 'PUT') return route.continue(); writes++; await route.fetch(); await route.abort('failed'); });
    await input.fill('0'); await save.click(); await expect(f.panel.getByRole('alert')).toBeVisible();
    expect((await readBackupSettings(f.hub.store.db)).retentionDays).toBe(0); expect(writes).toBe(1);
    await f.panel.getByRole('button', { name: '重新读取', exact: true }).click(); await expect(input).toHaveValue('0'); await expect(f.panel.getByRole('alert')).toHaveCount(0); expect(writes).toBe(1);
  } finally { await f.dispose(); }
});
test('explains owner-only access and fails safely for an unavailable host API', async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.route('**/api/settings/backups*', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
    await page.reload(); await waitForClientOnline(page); await f.open();
    await expect(f.panel.getByRole('alert')).toBeVisible(); await expect(f.panel.getByLabel('保留天数', { exact: true })).toHaveCount(0);
    await f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    let reads = 0; await page.unroute('**/api/settings/backups*');
    await page.route('**/api/settings/backups*', route => { reads++; return route.continue(); });
    await page.reload(); await waitForClientOnline(page); await f.open();
    await expect(f.panel).toContainText('仅主机所有者可以管理自动备份。'); expect(reads).toBe(0);
  } finally { await f.dispose(); }
});
