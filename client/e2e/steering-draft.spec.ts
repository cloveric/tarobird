import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './fixtures/vite.js';
import { microphone } from './fixtures/microphone.js';
import { selectConversation, waitForClientOnline } from './fixtures/mobile.js';
import { HubServer } from '../../src/hub/server.js';
import { hashSecret } from '../../src/hub/auth.js';
import { attachGateway } from '../../src/gateway/service.js';
import { createCoreServiceRuntime } from '../../src/core/runtime.js';

for (const phone of [false, true]) for (const delayedMethod of ['GET', 'POST']) {
  test(`new ${phone ? 'file draft survives' : 'recording and file survive'} delayed steering ${delayedMethod} receipt (${phone ? 'phone' : 'desktop'})`, async ({ browser }, info) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'steering-draft-'));
    const vite = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false } }); await vite.listen();
    const origin = vite.resolvedUrls!.local[0]!;
    const hub = await HubServer.start({ stateDir: path.join(root, 'hub'), origins: [new URL(origin).origin] });
    const stateDir = path.join(root, 'instance'), secret = randomBytes(32).toString('base64url');
    await mkdir(stateDir); await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine: 'codex', locale: 'zh', steerEnabled: true }));
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','引导助手',?)", [hashSecret(secret)]);
    const calls: string[] = [], steers: string[] = [];
    let releaseRun = () => {}, releaseReceipt = () => {};
    const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace('http', 'ws') + '/instance', botId: 'alpha', secret, engine: 'codex', runtime: createCoreServiceRuntime(),
      bridge: { supportsSteering: () => true, steerActiveTurn: async input => { steers.push(input.text); return true; }, handleAuthorizedMessage: async input => {
        calls.push(input.text); await input.onEngineEvent?.({ type: 'assistant_text', text: '等待引导中的任务', delta: true });
        await new Promise<void>(resolve => { releaseRun = resolve; input.abortSignal?.addEventListener('abort', resolve, { once: true }); });
        return { text: '原任务完成' };
      } } });
    const chat = await hub.store.createConversation('owner', ['alpha'], '引导期间保留草稿', 'steering-draft');
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, isMobile: phone, hasTouch: phone });
    let page = await context.newPage(); const errors: string[] = [];
    const watch = () => page.on('pageerror', error => errors.push(error.message)); watch();
    try {
      await microphone(page); await page.goto(origin);
      await page.getByLabel('主机名称', { exact: true }).fill('草稿验收主机'); await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
      await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
      await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await selectConversation(page, chat.title);
      const text = page.getByRole('textbox', { name: '消息', exact: true });
      await text.fill('开始原任务'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(page.getByText('等待引导中的任务', { exact: true })).toBeVisible();
      let intercepted = false;
      const gate = new Promise<void>(resolve => { releaseReceipt = resolve; });
      await page.route(`**/api/conversations/${chat.id}/steer**`, async route => {
        if (route.request().method() !== delayedMethod) return route.continue();
        const response = await route.fetch(); intercepted = true; await gate; await route.fulfill({ response });
      });
      await text.fill('仅把这条文字补充到当前任务');
      await clickAppAction(page, '引导当前任务', page.getByRole('button', { name: '引导当前任务', exact: true }));
      await expect.poll(() => intercepted).toBe(true);
      await expect(page.getByRole('button', { name: phone ? '发送消息' : '引导当前任务', exact: true })).toBeDisabled();
      // The text-only request is already in flight. These attachments belong
      // to the next message and must survive its eventual success receipt.
      let originalAudio: number[] = [];
      if (phone) {
        // Held recording sends on release, so it stays disabled while a steer
        // owns submission. Uploading a file still prepares the next draft.
        await expect(page.getByRole('button', { name: '录制语音', exact: true })).toBeDisabled();
      } else {
        await page.getByRole('button', { name: '录制语音', exact: true }).click();
        await expect(page.getByText('正在录音', { exact: true })).toBeVisible();
        await expect(page.getByLabel('录音时长', { exact: true })).not.toHaveText('00:00');
        await page.getByRole('button', { name: '完成录音', exact: true }).click();
        await expect(page.locator('.audio-draft audio')).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => (window as any).__mic.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
        originalAudio = await page.locator('.audio-draft audio').evaluate(async (audio: HTMLAudioElement) => Array.from(new Uint8Array(await (await fetch(audio.src)).arrayBuffer())));
        expect(originalAudio.length).toBeGreaterThan(1000);
      }
      await page.locator('input.attachment-picker-input').setInputFiles({ name: '下一条的资料.txt', mimeType: 'text/plain', buffer: Buffer.from('next-message-file\u0000exact-bytes') });
      await expect(page.locator('.attachment-draft-file')).toHaveCount(phone ? 1 : 2);
      releaseReceipt(); await page.unrouteAll({ behavior: 'wait' });
      await expect(text).toHaveValue('');
      await expect(page.getByText('CLI 已接收引导', { exact: true })).toBeVisible();
      await expect(page.locator('.attachment-draft-file')).toHaveCount(phone ? 1 : 2);
      expect(steers).toEqual(['仅把这条文字补充到当前任务']); expect(calls).toHaveLength(1); expect(calls[0]).toContain('开始原任务');
      releaseRun(); await expect(page.getByText('原任务完成', { exact: true })).toBeVisible();
      await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿已保存');
      await page.close(); page = await context.newPage(); watch();
      await page.goto(origin); await waitForClientOnline(page); await selectConversation(page, chat.title);
      await expect(page.locator('.attachment-draft-file')).toHaveCount(phone ? 1 : 2);
      await expect(page.locator('.attachment-draft')).toContainText('下一条的资料.txt');
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
      if (!phone) {
      await expect.poll(() => page.locator('.audio-draft audio').evaluate((audio: HTMLAudioElement) => audio.readyState >= 1 && audio.duration > 0 && !audio.error)).toBe(true);
      const restoredAudio = await page.locator('.audio-draft audio').evaluate(async (audio: HTMLAudioElement) => Array.from(new Uint8Array(await (await fetch(audio.src)).arrayBuffer())));
      expect(restoredAudio).toEqual(originalAudio);
      }
      const saved = await page.evaluate(async conversationId => {
        const registryPath = '/src/host-registry.ts'; const { HostRegistry } = await import(registryPath);
        const registry = new HostRegistry(); let handle;
        try {
          handle = await registry.open((await registry.list())[0].id);
          const value = await handle.cache.conversationDraft(conversationId, handle.identity);
          return { files: await Promise.all(value.draft.files.map(async (file: File) => ({ name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) }))), outbox: await handle.cache.outbox() };
        } finally { handle?.cache.close(); registry.close(); }
      }, chat.id);
      expect(saved.files.find((file: { name: string }) => file.name === '下一条的资料.txt')?.bytes).toEqual(Array.from(Buffer.from('next-message-file\u0000exact-bytes')));
      expect(saved.outbox).toEqual([]);
      const messages = (await hub.store.snapshot('owner', chat.id)).messages.filter(message => message.authorType === 'user');
      expect(messages).toHaveLength(2);
      expect(messages.map(message => message.blocks.map(block => block.type))).toEqual([['text'], ['text', 'steering']]);
      expect(calls).toHaveLength(1); expect(steers).toHaveLength(1); expect(errors).toEqual([]);
      await page.screenshot({ path: info.outputPath('recording-and-file-restored.png') });
    } finally {
      releaseReceipt(); releaseRun(); await context.close(); await gateway.disconnect(); await hub.close(); await vite.close(); await rm(root, { recursive: true, force: true });
    }
  });
}
