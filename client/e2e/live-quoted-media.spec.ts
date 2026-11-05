import { preparePairing } from "./fixtures/pairing-invite.js";
import { messageAction } from './fixtures/message-actions.js';
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HubServer } from '../../src/hub/server.js';
import { HubMaintenance } from '../../src/hub/maintenance.js';
import { blocksText, type Block } from '../../src/client-protocol/index.js';
import { archiveAcceptanceThreads } from '../../tests/helpers/codex-acceptance.js';
import { ownClaudeFixtureTranscripts } from './fixtures/claude-app-observer.js';
import { mediaBatchFixture } from './fixtures/media-batch.js';
import { selectConversation, waitForClientOnline } from './fixtures/mobile.js';

const definitions = [
  { engine: 'codex', model: 'gpt-6-astra', executable: process.env.CODEX_EXECUTABLE || 'codex', envKey: 'CODEX_EXECUTABLE' },
  { engine: 'claude', model: 'sonnet', executable: process.env.CLAUDE_EXECUTABLE || 'claude', envKey: 'CLAUDE_EXECUTABLE' },
  { engine: 'kimi', model: '', executable: process.env.KIMI_EXECUTABLE || path.join(os.homedir(), '.kimi-code/bin/kimi'), envKey: 'KIMI_EXECUTABLE' },
  { engine: 'deepseek', model: '', executable: process.env.DSH_EXECUTABLE || 'dsh', envKey: 'DSH_EXECUTABLE' },
  { engine: 'antigravity', model: '', executable: process.env.ANTIGRAVITY_EXECUTABLE || 'agy', envKey: 'ANTIGRAVITY_EXECUTABLE' },
] as const;
type Observation = { type: string; pid?: number; sessionId?: string; files?: Array<{ name: string; sha256: string }> };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const answer = (blocks: Block[]) => blocks.flatMap(block => block.type === 'text' ? [block.text] : block.type === 'card' ? block.elements.flatMap(element => element.type === 'markdown' ? [element.text ?? ''] : []) : []).join('\n');
async function observations(file: string): Promise<Observation[]> {
  return (await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}
test.use({ actionTimeout: 15_000 });
for (const definition of definitions) test(`real ${definition.engine} reads quoted and forwarded copies after source deletion`, async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_QUOTED_MEDIA !== '1' || !!process.env.TAROCUB_LIVE_ENGINE && process.env.TAROCUB_LIVE_ENGINE !== definition.engine, 'explicit authenticated live-engine acceptance only');
  test.setTimeout(300_000);
  const { engine, model, executable } = definition;
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), engine === 'claude' ? 'live-claude-app-tools-' : 'live-client-worker-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const cleanupClaude = engine === 'claude' ? await ownClaudeFixtureTranscripts(workspace) : undefined;
  const nativeLog = path.join(root, 'native-inputs.jsonl'), entrypoint = path.resolve('../dist/src/index.js');
  const env = { ...process.env, [definition.envKey]: executable, TAROCUB_MEDIA_WORKER_ENTRY: entrypoint, TAROCUB_MEDIA_OBSERVER_LOG: nativeLog,
    TAROCUB_MEDIA_PROTOCOL_MODULE: pathToFileURL(path.resolve('../dist/src/codex/deepseek-harness-protocol.js')).href,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(path.resolve('e2e/fixtures/quoted-media-observer.mjs')).href}` };
  if (engine === 'kimi') {
    const home = path.join(root, 'kimi-home'), nativeHome = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code');
    await mkdir(path.join(home, 'workspace-trust'), { recursive: true, mode: 0o700 });
    await symlink(path.join(nativeHome, 'config.toml'), path.join(home, 'config.toml'));
    await symlink(path.join(nativeHome, 'credentials'), path.join(home, 'credentials'), 'dir');
    await writeFile(path.join(home, 'workspace-trust', `wd_workspace_${hash(Buffer.from(workspace)).slice(0, 12)}`), JSON.stringify({ root: workspace, trustedAt: Date.now() }), { mode: 0o600, flag: 'wx' });
    Object.assign(env, { KIMI_CODE_HOME: home });
  }
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist'), managedBots: { entrypoint, env } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), phone = await phoneContext.newPage();
  let receipt: Record<string, unknown> | undefined;
  try {
    const bot = await hub.botManager!.create('owner', { requestId: 'target', name: '文件审阅助手', engine, model, effort: 'low', workspace });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('source_bot','资料助手','fixture'),('silent_bot','旁听助手','fixture')");
    const source = await hub.store.createConversation('owner', ['source_bot'], '原始资料', 'source');
    const group = await hub.store.createConversation('owner', [bot.id, 'silent_bot'], '审阅工作群', 'group', { type: 'group' });
    const topic = await hub.store.createConversation('owner', [], '引用阅读', 'topic', { parentId: group.id });
    const direct = await hub.store.createConversation('owner', [bot.id], '附件审阅', 'direct');
    const fixture = await mediaBatchFixture(), files = [fixture.images[0]!, fixture.pdf];
    const originalIds: string[] = [];
    for (const file of files) {
      const { id } = await hub.attachments.create('owner', { conversationId: source.id, name: file.name, mime: file.mimeType, size: file.buffer.length, sha256: hash(file.buffer) });
      await hub.attachments.putChunk('owner', id, 0, file.buffer); await hub.attachments.complete('owner', id); originalIds.push(id);
    }
    const instruction = '请实际读取这条消息附带的 PNG 和 PDF，各有一个八位编号。用一行回答：IMAGE_CODE=图内编号 PDF_CODE=文档内编号。不要猜编号，不要修改原附件，不发送到外部平台。';
    const original = await hub.store.publishBotMessage('source_bot', { conversationId: source.id, blocks: [
      { type: 'text', text: instruction }, { type: 'image', attachmentId: originalIds[0]!, title: files[0]!.name },
      { type: 'file', attachmentId: originalIds[1]!, name: files[1]!.name, mime: files[1]!.mimeType, size: files[1]!.buffer.length },
    ] });
    await pair(page, hub); await pair(phone, hub); await selectConversation(page, source.title);
    await expect.poll(async () => !!(await hub.store.bots('owner')).find(item => item.id === bot.id)?.online, { timeout: 30_000 }).toBe(true);
    const forward = async (device: Page, messageId: string, destination: string, reply: boolean) => {
      const article = device.locator(`[data-message-id="${messageId}"]`);
      await messageAction(device, article, '转发消息');
      const dialog = device.getByRole('dialog', { name: '转发消息', exact: true });
      await dialog.getByRole('button', { name: destination, exact: true }).click();
      const checkbox = dialog.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true }); if (destination === direct.title) await expect(checkbox).toBeChecked(); else await expect(checkbox).not.toBeChecked();
      if (reply) {
        await checkbox.check();
        const recipients = dialog.getByRole('group', { name: '转发后回复的 Bot', exact: true });
        for (const target of await recipients.getByRole('checkbox').all()) {
          const desired = (await target.innerText()).includes(bot.name);
          if ((await target.getAttribute('aria-checked') === 'true') !== desired) await target.click();
        }
      }
      await dialog.getByRole('button', { name: '确认转发', exact: true }).click(); await expect(dialog).toBeHidden();
    };
    await forward(page, original.id, `${group.title} / ${topic.title}`, false);
    const snapshot = (id: string) => hub.store.snapshot('owner', id);
    await expect.poll(async () => (await snapshot(topic.id)).messages.length).toBe(1);
    const copied = (await snapshot(topic.id)).messages[0]!;
    expect(copied.forwardedFrom?.messageId).toBe(original.id);
    expect(await hub.store.pendingForBot(bot.id)).toHaveLength(0);
    expect((await observations(nativeLog)).filter(event => event.type === 'input')).toHaveLength(0);
    for (const id of originalIds) await expect(hub.attachments.download({ botId: bot.id }, id)).rejects.toThrow('bot_forbidden');
    const copiedIds = copied.blocks.flatMap(block => 'attachmentId' in block ? [block.attachmentId] : []);
    expect(copiedIds).toHaveLength(2); expect(copiedIds.every(id => !originalIds.includes(id))).toBe(true);
    await hub.store.publishBotMessage('source_bot', { id: original.id, conversationId: source.id, status: 'deleted', blocks: [] });
    for (const id of originalIds) await expect(hub.attachments.download({ userId: 'owner' }, id)).rejects.toThrow('attachment_not_found');
    expect(await new HubMaintenance(hub.store, root).collectOrphans(Date.now() + 1)).toBe(2);
    const copyHashes = await Promise.all(copiedIds.map(async id => hash(await readFile((await hub.attachments.download({ botId: bot.id }, id)).path))));
    expect(copyHashes.sort()).toEqual(files.map(file => hash(file.buffer)).sort());
    await selectConversation(phone, topic.title, group.title);
    await messageAction(phone, phone.locator(`[data-message-id="${copied.id}"]`), '引用回复');
    const recipients = phone.getByRole('group', { name: '回复的 Bot', exact: true });
    for (const target of await recipients.getByRole('checkbox').all()) {
      const desired = (await target.innerText()).includes(bot.name);
      if ((await target.getAttribute('aria-checked') === 'true') !== desired) await target.click();
    }
    await phone.getByRole('textbox', { name: '消息', exact: true }).fill('请读取我引用的这条消息里的两个附件，按引用里的要求回复两个编号。');
    await phone.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await snapshot(topic.id)).messages.find(message => message.replyTo === copied.id && message.authorType === 'user')).toBeTruthy();
    const quoted = (await snapshot(topic.id)).messages.find(message => message.replyTo === copied.id && message.authorType === 'user')!;
    expect(quoted.blocks.filter(block => 'attachmentId' in block)).toHaveLength(0); expect(quoted.mentions).toEqual([bot.id]);
    const waitForAnswer = async (conversationId: string, inputId: string) => {
      const replies = async () => (await snapshot(conversationId)).messages.filter(message => message.replyTo === inputId && message.authorType === 'bot' && message.status === 'complete');
      await expect.poll(async () => (await replies()).some(message => answer(message.blocks).includes(fixture.images[0]!.code) && answer(message.blocks).includes(fixture.pdfCode)), { timeout: 120_000 }).toBe(true);
      await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
      const reply = (await replies()).find(message => answer(message.blocks).includes(fixture.pdfCode))!;
      for (const device of [page, phone]) {
        await selectConversation(device, conversationId === topic.id ? topic.title : direct.title, conversationId === topic.id ? group.title : undefined);
        await expect(device.locator(`[data-message-id="${reply.id}"]`)).toContainText(fixture.images[0]!.code);
        await expect(device.locator(`[data-message-id="${reply.id}"]`)).toContainText(fixture.pdfCode);
      }
      return reply;
    };
    await waitForAnswer(topic.id, quoted.id);
    // A direct conversation starts a separate native session, so this
    // second read cannot pass by remembering the first reply's random codes.
    await forward(phone, copied.id, direct.title, true);
    await expect.poll(async () => (await snapshot(direct.id)).messages.find(message => message.forwardedFrom?.messageId === copied.id)).toBeTruthy();
    const forwarded = (await snapshot(direct.id)).messages.find(message => message.forwardedFrom?.messageId === copied.id)!;
    expect(forwarded.mentions).toEqual([bot.id]);
    await waitForAnswer(direct.id, forwarded.id);
    expect(await hub.store.pendingForBot('silent_bot')).toHaveLength(0);
    const inputs = (await observations(nativeLog)).filter(event => event.type === 'input'); expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input.files!.map(file => file.sha256).sort()).toEqual(files.map(file => hash(file.buffer)).sort());
    const state = JSON.parse(await readFile(path.join(root, 'bots', bot.id, 'session.json'), 'utf8'));
    const sessions = [topic.id, direct.id].map(id => state.chats.find((chat: { conversationKey: string }) => chat.conversationKey === `lark:${id}`)?.codexSessionId);
    expect(sessions.every(Boolean)).toBe(true); expect(new Set(sessions).size).toBe(2);
    for (const [device, label] of [[page, 'desktop'], [phone, 'phone']] as const) {
      await device.screenshot({ path: info.outputPath(`quoted-media-${engine}-${label}.png`), animations: 'disabled' });
      expect(await device.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    receipt = { testedAt: new Date().toISOString(), engine, model: model || 'CLI default', version, effort: 'low', pairedBrowserContexts: 2, physicalDevices: false,
      attachmentCardActions: true, directForwardReplyEnabledByDefault: true, silentForwardNativeInputs: 0, originalSourceDeniedToTargetBot: true, recalledOriginalDownloadDeniedBeforeGc: true, sourceDeletedAndOrphansCollected: true, collectedOriginalAttachments: 2, copiedHashesMatch: true,
      quotedMessageOwnAttachments: 0, quotedNativeAttachmentCount: inputs[0]!.files!.length, forwardedNativeAttachmentCount: inputs[1]!.files!.length,
      nativeInputs: inputs, distinctNativeSessions: 2, imageCodeReadTwice: fixture.images[0]!.code, pdfCodeReadTwice: fixture.pdfCode,
      unselectedBotPending: 0, repliesRenderedOnBothDevices: true, testedSchema: 11 };
    await writeFile(info.outputPath(`quoted-media-${engine}.json`), JSON.stringify(receipt, null, 2));
  } catch (error) {
    await phone.screenshot({ path: info.outputPath('failure-phone.png') }).catch(() => undefined);
    await writeFile(info.outputPath('diagnostics.json'), JSON.stringify({ native: await observations(nativeLog), conversations: await Promise.all((await hub.store.conversations('owner')).map(async conversation => ({ title: conversation.title, messages: (await hub.store.snapshot('owner', conversation.id)).messages.map(message => ({ id: message.id, replyTo: message.replyTo, status: message.status, authorType: message.authorType, text: blocksText(message.blocks) })) }))) }, null, 2));
    throw error;
  } finally {
    await phoneContext.close(); await page.close(); await hub.close();
    const observed = await observations(nativeLog);
    await expect.poll(() => observed.filter(event => event.type === 'spawn').every(event => {
      if (!event.pid) return true;
      try { process.kill(event.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }), { timeout: 15_000 }).toBe(true);
    if (engine === 'codex') await archiveAcceptanceThreads(root);
    if (cleanupClaude) await cleanupClaude([...new Set(observed.filter(event => event.type === 'session').map(event => event.sessionId!).filter(Boolean))]);
    await rm(root, { recursive: true, force: true });
    if (receipt) await writeFile(info.outputPath(`quoted-media-${engine}.json`), JSON.stringify({ ...receipt, ownedHubAndNativeChildrenStopped: true, ownedFixtureRemoved: true, codexThreadsArchived: engine === 'codex', claudeFixtureTranscriptsRemoved: !!cleanupClaude, kimiPrivateHome: engine === 'kimi' }, null, 2));
  }
});
