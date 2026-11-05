import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { createServer } from './fixtures/vite.js';
import { preparePairing } from './fixtures/pairing-invite.js';
import { selectConversation, showDisconnectedBots, waitForClientOnline } from './fixtures/mobile.js';

test.use({ serviceWorkers: 'block' });
test('Dock count excludes archived conversations and their topics without erasing unread history', async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'unread-badge-'));
  const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, plugins: [{
    name: 'capture-native-badge', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/src/native.ts')) return code.replace('export async function updateBadge(count: number): Promise<void> {', match => match + '(window as any).__badgeCounts.push(count);');
      if (id.endsWith('/src/connection.ts')) return code.replace('private update(changes: Partial<ConnectionState> = {}, cacheChanged = false, scoped = false): void {', match => match + '(window as any).__badgeConnection=this;');
    },
  }] });
  await server.listen(); const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await page.addInitScript(() => { (window as any).__badgeCounts = []; });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Badge fixture','fixture')");
    const current = await hub.store.createConversation('owner', ['bot'], '当前对话', 'current');
    const archived = await hub.store.createConversation('owner', ['bot'], '将归档的对话', 'archived');
    const group = await hub.store.createConversation('owner', ['bot'], '将归档的群组', 'group', { type: 'group' });
    const topic = await hub.store.createConversation('owner', ['bot'], '群组话题', 'topic', { type: 'group', parentId: group.id });
    const active = await hub.store.createConversation('owner', ['bot'], '有效未读', 'active');
    await page.goto(url); await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, current.title);
    // Use the public client frame so the real Host broadcasts the metadata change.
    // A direct store update changes SQLite only and cannot notify the open App.
    const setArchived = (id: string, archived: boolean) => page.evaluate(
      ({ id, archived }) => (window as any).__badgeConnection.send({ v: 1, type: 'conversation.archive', conversationId: id, archived }), { id, archived });
    for (const [chat, count] of [[archived, 31], [group, 7], [topic, 15]] as const) {
      for (let i = 0; i < count; i++) await hub.store.publishBotMessage('bot', { conversationId: chat.id, blocks: [{ type: 'text', text: `Unread ${i}` }] });
    }
    await hub.store.publishBotMessage('bot', { conversationId: active.id, blocks: [{ type: 'text', text: 'Real unread message' }] });
    await expect(page).toHaveTitle('(54) TaroBird', { timeout: 20_000 });
    await setArchived(archived.id, true);
    await setArchived(group.id, true);
    await expect(page.locator(`.sidebar [data-conversation-id="${archived.id}"]`)).toHaveCount(0);
    await expect(page.locator(`.sidebar [data-conversation-id="${group.id}"]`)).toHaveCount(0);
    await expect(page).toHaveTitle('(1) TaroBird');
    await expect.poll(() => page.evaluate(() => (window as any).__badgeCounts.at(-1))).toBe(1);
    await selectConversation(page, active.title); await page.getByRole('textbox', { name: '消息', exact: true }).focus();
    await expect(page).toHaveTitle('TaroBird');
    await expect.poll(() => page.evaluate(() => (window as any).__badgeCounts.at(-1))).toBe(0);
    // Restore reveals retained unread history; counting is not mark-all-read.
    await setArchived(archived.id, false);
    await setArchived(group.id, false);
    await expect(page).toHaveTitle('(53) TaroBird');
    await expect.poll(() => page.evaluate(() => (window as any).__badgeCounts.at(-1))).toBe(53);
    await setArchived(archived.id, true);
    await setArchived(group.id, true);
    await expect(page).toHaveTitle('TaroBird');
    await page.reload(); await waitForClientOnline(page);
    await expect(page).toHaveTitle('TaroBird');
    await expect.poll(() => page.evaluate(() => (window as any).__badgeCounts.at(-1))).toBe(0);
  } finally { await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
