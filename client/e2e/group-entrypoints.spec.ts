import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { waitForClientOnline } from './fixtures/mobile.js';

test('the WelcomeHome group entry creates a group through its own visible action', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'group-welcome-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','入口验收助手','fixture')");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner'); await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await waitForClientOnline(page);
    await page.locator('.welcome-group').getByText('开一个群组', { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建群组', exact: true });
    await expect(dialog.getByRole('button', { name: '创建群组', exact: true })).toBeDisabled();
    await dialog.getByRole('checkbox').first().check(); await dialog.getByRole('button', { name: '创建群组', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(page.getByRole('heading', { name: '新群组', exact: true, level: 1 })).toBeVisible();
    const groups = (await hub.store.conversations('owner')).filter(value => value.type === 'group');
    expect(groups).toHaveLength(1); expect(groups[0]!.botIds).toEqual(['alpha']);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
