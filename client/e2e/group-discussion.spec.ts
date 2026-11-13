import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { microphone } from "./fixtures/microphone.js";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { CoreBridgeLike } from "../../src/core/types.js";
import { selectConversation, waitForClientOnline, mobileHome, openMobileHome } from "./fixtures/mobile.js";
import { revealReplyBots, dismissReplyBots } from "./fixtures/desktop-actions.js";

// Real UI -> Hub -> durable queue -> Gateway/Core. Only model output is scripted.
// No Agent Bus listener/configuration is used by these journeys.
test.use({ serviceWorkers: "block" });
type Turn = Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
type Answer = { text: string; usage?: { inputTokens: number; outputTokens: number } };
const settings = (page: Page) => page.getByRole("dialog", { name: "群组设置", exact: true });
const progress = (page: Page) => page.getByRole("dialog", { name: "讨论进展", exact: true });
const stance = (text: string, position: object) => `${text}\n\n\`\`\`group_stance\n${JSON.stringify(position)}\n\`\`\``;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function setup(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "group-discussion-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.join(root, "no-model-worker.js") } });
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_PROFILE_KEY, JSON.stringify({ name: "群组验收主机", revision: 1 })]);
  const calls: { id: string; turn: Turn }[] = [], channels: Awaited<ReturnType<typeof attachGateway>>[] = [], errors: string[] = [];
  let respond: (id: string, turn: Turn) => Promise<Answer> = async id => ({ text: `${id} 的回复` });
  await page.exposeFunction("recordGroupRuntimeError", (message: string) => errors.push(message));
  await page.addInitScript(() => {
    const report = (message: string) => { void (window as unknown as { recordGroupRuntimeError(message: string): Promise<void> }).recordGroupRuntimeError(message).catch(() => {}); };
    addEventListener("error", event => report(event.message));
    addEventListener("unhandledrejection", event => report(String(event.reason)));
  });
  for (const [id, name] of [["alpha", "研究助手"], ["beta", "复核助手"]]) {
    const secret = randomBytes(32).toString("base64url"), dir = path.join(root, "bots", id!);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", approvalMode: "bypass" }));
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, name, hashSecret(secret)]);
    await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
    const bridge: CoreBridgeLike = { handleAuthorizedMessage: async turn => { calls.push({ id: id!, turn }); return respond(id!, turn); } };
    channels.push(await attachGateway({ stateDir: dir, botId: id!, secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge }));
  }
  const group = await hub.store.createConversation("owner", ["alpha", "beta"], "产品讨论组", "create-discussion-group");
  await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill("群组验收主机");
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await selectConversation(page, "产品讨论组");
  await expect(page.getByRole("region", { name: "群聊方式与讨论状态" })).toBeVisible();
  return { hub, group, calls, errors, respond: (fn: typeof respond) => { respond = fn; }, close: async () => { await page.close(); for (const channel of channels) await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
async function configure(page: Page, mode: "普通群聊" | "并行回复" | "轮流讨论" | "独立评议", rounds = "2") {
  await page.getByRole("button", { name: "设置群聊方式", exact: true }).click();
  const choice = settings(page).getByRole("radio", { name: new RegExp(`^${mode}`) });
  // A checked initial default is not an authoritative loaded policy.
  await expect(choice).toBeEnabled(); await choice.check();
  if (mode === "轮流讨论" || mode === "独立评议") await settings(page).getByLabel("最多讨论轮数", { exact: true }).selectOption(rounds);
  await settings(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings(page)).toHaveCount(0);
  // The composer adopts the authoritative follow-up read after settings save.
  // Sending before it arrives correctly trips the mode-change draft guard.
  if (mode === "轮流讨论" || mode === "独立评议") await expect(page.getByLabel("消息", { exact: true })).toHaveAttribute("placeholder", "输入问题，开始讨论…");
}
async function start(page: Page, text: string) {
  await page.getByRole("button", { name: "发起讨论", exact: true }).click();
  await page.getByLabel("讨论课题", { exact: true }).fill(text);
  await page.getByRole("button", { name: "开始讨论", exact: true }).click();
  await expect(progress(page)).toBeVisible();
}

for (const width of [390, 1360]) for (const header of ['group_stance', 'json group_stance', 'group-stance']) test(`internal group positions never appear in streamed or completed replies at ${width}px (${header})`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await setup(page), finish = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async (id, turn) => {
      const answer = id === 'alpha'
        ? stance('杭州和武汉各有适合的人群，按工作与生活偏好选择。', { stance: 'propose', proposal: '结合个人偏好选择城市', summary: '按偏好选择' })
        : stance('我同意按个人偏好选择城市。', { stance: 'agree', proposalId: 'P1', proposal: '', summary: '同意 P1 原文' });
      const text = answer.replace('```group_stance', `\`\`\`${header}`);
      for (const chunk of text.match(/.{1,7}|\n/gu) ?? []) await turn.onEngineEvent?.({ type: 'assistant_text', text: chunk, delta: true });
      if (id === 'alpha') await finish.promise;
      await turn.onEngineEvent?.({ type: 'result', text }); return { text };
    });
    await page.getByLabel('消息', { exact: true }).fill('讨论一下这两个城市。');
    await page.locator('.composer .send-button').click();
    await expect(page.locator('.message.bot').filter({ hasText: '杭州和武汉各有适合的人群' })).toBeVisible();
    expect((await page.locator('.message.bot').allTextContents()).join('\n')).not.toMatch(/group[_-]stance/);
    await page.screenshot({ path: info.outputPath(`clean-stream-${width}.png`) });
    finish.release();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.outcome).toBe(header === 'group_stance' ? 'consensus' : 'different_views');
    await expect(page.locator('.message.bot').getByText('我同意按个人偏好选择城市。', { exact: true })).toBeVisible();
    expect((await page.locator('.message.bot').allTextContents()).join('\n')).not.toMatch(/group[_-]stance/);
    await page.screenshot({ path: info.outputPath(`clean-final-${width}.png`) });
    expect(f.errors).toEqual([]);
  } finally { finish.release(); await f.close(); }
});

for (const width of [390, 1360]) for (const selected of [false, true]) test(`main composer follows sequential mode with ${selected ? 'all saved' : 'no'} recipients at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await setup(page), first = gate();
  try {
    if (selected) {
      await revealReplyBots(page);
      for (const name of ['研究助手', '复核助手']) await page.getByRole('checkbox', { name, exact: true }).check();
      await dismissReplyBots(page);
    }
    await configure(page, '轮流讨论', '1');
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toContainText('轮流讨论');
    f.respond(async (id, turn) => {
      if (id === 'alpha') await first.promise;
      if (id === 'beta' && selected && width === 1360) expect((await Promise.all((turn.files ?? []).map(file => readFile(file, 'utf8')))).join('\n')).toContain('NOTE_FILE_CONTENT');
      return { text: stance(`${id}_SEQUENTIAL_RESULT`, { stance: 'abstain', summary: '保留意见' }) };
    });
    await page.getByLabel('消息', { exact: true }).fill('请按设置顺序讨论这个问题。');
    await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.map(call => call.id), { timeout: 5000 }).toEqual(['alpha']);
    const running = await f.hub.groupDiscussions.view('owner', f.group.id);
    expect(running.run?.mode).toBe('sequential');
    expect(running.run?.topic).toBe('请按设置顺序讨论这个问题。');
    await expect(page.getByRole('button', { name: /^让谁回复：/ })).toHaveCount(0);
    if (selected && width === 1360) await page.locator('input[type=file][multiple]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('NOTE_FILE_CONTENT') });
    await page.getByLabel('消息', { exact: true }).fill('补充：请关注维护成本。');
    await page.locator('.composer .send-button').click();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
    expect(f.calls.map(call => call.id)).toEqual(['alpha']);
    first.release();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    expect(f.calls.map(call => call.id)).toEqual(['alpha', 'beta']);
    expect(f.calls[1]!.turn.text).toContain('alpha_SEQUENTIAL_RESULT');
    expect(f.calls[1]!.turn.text).toContain('请关注维护成本');
    await page.screenshot({ path: info.outputPath(`main-sequential-${width}-${selected}.png`) });
    expect(f.errors).toEqual([]);
  } finally { first.release(); await f.close(); }
});

test('group composer retains its draft when another device changes mode during upload', async ({ page }) => {
  const f = await setup(page), complete = gate(), first = gate();
  let uploading = false;
  try {
    await revealReplyBots(page);
    for (const name of ['研究助手', '复核助手']) await page.getByRole('checkbox', { name, exact: true }).check();
    await dismissReplyBots(page);
    f.respond(async () => { await first.promise; return { text: stance('reviewed', { stance: 'abstain', summary: '保留意见' }) }; });
    await page.route('**/api/uploads/*/complete', async route => { uploading = true; await complete.promise; await route.continue(); });
    await page.locator('input[type=file][multiple]').setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('MODE_CHANGE_BRIEF') });
    await page.getByLabel('消息', { exact: true }).fill('上传期间改为了轮流讨论');
    await page.locator('.composer .send-button').click();
    await expect.poll(() => uploading).toBe(true);
    const before = await f.hub.store.groupSettings('owner', f.group.id);
    await f.hub.store.updateGroup('owner', f.group.id, { title: before.group.title, expectedTitle: before.group.title, botIds: before.group.botIds, expectedBotIds: before.group.botIds,
      policy: { mode: 'sequential', botOrder: before.group.botIds, maxRounds: 1 }, expectedRevision: before.revision });
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toContainText('轮流讨论');
    complete.release();
    await expect(page.getByLabel('消息', { exact: true })).not.toBeDisabled();
    expect(await f.hub.store.db.all('SELECT d.bot_id FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.blocks_json LIKE ?', ['%上传期间改为了轮流讨论%'])).toEqual([]);
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('上传期间改为了轮流讨论');
    expect(f.calls).toHaveLength(0);
    await page.getByRole('button', { name: '作为新讨论', exact: true }).click();
    await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(['alpha']);
    first.release();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    expect(f.calls.map(call => call.id)).toEqual(['alpha', 'beta']);
  } finally { complete.release(); first.release(); await f.close(); }
});

test('main composer starts independent review and supplies topic attachments', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const f = await setup(page), both = gate();
  try {
    await configure(page, '独立评议', '2');
    f.respond(async (id, turn) => {
      if (f.calls.length <= 2) await both.promise;
      expect((await Promise.all((turn.files ?? []).map(file => readFile(file, 'utf8')))).join('\n')).toContain('SHARED_BRIEF');
      return { text: stance(`${id}_PRIVATE_OPINION`, { stance: 'abstain', summary: '保留意见' }) };
    });
    await page.locator('input[type=file][multiple]').setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('SHARED_BRIEF') });
    await page.getByLabel('消息', { exact: true }).fill('独立思考这个附件，然后讨论。');
    await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.length).toBe(2);
    for (const call of f.calls) expect(call.turn.text).not.toContain('PRIVATE_OPINION');
    both.release();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    expect(f.calls.slice(0, 2).map(call => call.id).sort()).toEqual(['alpha', 'beta']);
    expect(f.calls.slice(2).map(call => call.id)).toEqual(['alpha', 'beta']);
    expect(f.calls[2]!.turn.text).toContain('beta_PRIVATE_OPINION');
    expect(f.errors).toEqual([]);
  } finally { both.release(); await f.close(); }
});

test('main composer retains an uncertain start across reload and retries the same receipt', async ({ page }) => {
  const f = await setup(page), requests: string[] = [];
  try {
    await configure(page, '轮流讨论', '1');
    await page.route('**/api/conversations/*/discussion', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      requests.push(route.request().postDataJSON().requestId);
      if (requests.length > 1) return route.continue();
      const result = await route.fetch(); expect(result.ok()).toBe(true); await route.abort('failed');
    });
    await page.locator('input[type=file][multiple]').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('RETRY_ATTACHMENT') });
    await page.getByLabel('消息', { exact: true }).fill('不要因重试重复发起。');
    await page.locator('.composer .send-button').click();
    await expect(page.getByText('未能确认操作结果。请先刷新状态，再决定是否重试。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('不要因重试重复发起。');
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    const original = (await f.hub.groupDiscussions.view('owner', f.group.id)).run!.id;
    await configure(page, '普通群聊');
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('不要因重试重复发起。');
    await page.locator('.composer .send-button').click();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
    expect(requests).toHaveLength(2); expect(new Set(requests).size).toBe(1);
    expect((await f.hub.groupDiscussions.view('owner', f.group.id)).run!.id).toBe(original);
    expect(f.calls).toHaveLength(2);
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const width of [390, 1360]) test(`parallel replies address the user concurrently, @ narrows recipients and reload retains mode at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await setup(page), both = gate();
  try {
    await configure(page, '并行回复');
    expect(f.calls).toHaveLength(0);
    await expect(page.getByRole('button', { name: '让谁回复：全员回复', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发起讨论', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toContainText('不 @ 全员回复');
    await page.getByRole('button', { name: '设置群聊方式', exact: true }).click();
    await expect(settings(page).getByRole('radio', { name: /^并行回复/ })).toBeChecked();
    await expect(settings(page).getByLabel('最多讨论轮数', { exact: true })).toHaveCount(0);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await settings(page).screenshot({ path: info.outputPath(`parallel-settings-${width}.png`), animations: 'disabled' });
    await settings(page).getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    f.respond(async id => { await both.promise; return { text: id === 'alpha' ? '研究助手：我的独立回答是先明确目标。' : '复核助手：我的独立回答是先验证假设。' }; });
    await page.getByLabel('消息', { exact: true }).fill('请各自给我一个项目建议。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => f.calls.map(call => call.id).sort()).toEqual(['alpha', 'beta']);
    both.release();
    const transcript = page.locator('.host-workspace:not([hidden]) .message-scroll').filter({ visible: true });
    await expect(transcript).toContainText('研究助手：我的独立回答');
    await expect(transcript).toContainText('复核助手：我的独立回答');
    expect(f.calls.every(call => !call.turn.text.includes('我的独立回答'))).toBe(true);
    await page.screenshot({ path: info.outputPath(`parallel-replies-${width}.png`), animations: 'disabled' });
    await revealReplyBots(page); await page.getByRole('checkbox', { name: '研究助手', exact: true }).check(); await dismissReplyBots(page);
    await page.getByLabel('消息', { exact: true }).fill('这次只请研究助手继续。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => f.calls.length).toBe(3); expect(f.calls[2]!.id).toBe('alpha');
    await expect(transcript).toContainText('这次只请研究助手继续');
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toContainText('并行回复');
    expect((await f.hub.groupDiscussions.view('owner', f.group.id)).run).toBeNull();
    await configure(page, '普通群聊');
    await revealReplyBots(page); await page.getByRole('checkbox', { name: '研究助手', exact: true }).uncheck(); await dismissReplyBots(page);
    await expect(page.getByRole('button', { name: '让谁回复：不指定回复', exact: true })).toBeVisible();
    expect(f.errors).toEqual([]);
  } finally { both.release(); await f.close(); }
});

test('parallel replies are disabled on older hosts while existing group modes remain available', async ({ page }) => {
  await page.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer(); server.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.type === 'ready') frame.serverCapabilities = frame.serverCapabilities.filter((cap: string) => cap !== 'groups.parallel.v1');
      socket.send(JSON.stringify(frame));
    });
  });
  const f = await setup(page);
  try {
    await page.getByRole('button', { name: '设置群聊方式', exact: true }).click();
    await expect(settings(page).getByRole('radio', { name: /^并行回复/ })).toBeDisabled();
    await expect(settings(page).getByRole('radio', { name: /^轮流讨论/ })).toBeEnabled();
    await expect(settings(page)).toContainText('更新主机后可使用并行回复');
  } finally { await f.close(); }
});

test('main composer preserves the question when settings change before send, then uses the new order', async ({ page }) => {
  const f = await setup(page);
  let changed = false;
  try {
    await configure(page, '轮流讨论', '1');
    await page.route('**/api/conversations/*/discussion', async route => {
      if (route.request().method() === 'POST' && !changed) {
        changed = true;
        const settings = await f.hub.store.groupSettings('owner', f.group.id);
        await f.hub.store.updateGroup('owner', f.group.id, { title: settings.group.title, botIds: settings.group.botIds, expectedTitle: settings.group.title, expectedBotIds: settings.group.botIds, expectedRevision: settings.revision, policy: { ...settings.policy, botOrder: ['beta', 'alpha'] } });
      }
      await route.continue();
    });
    await page.getByLabel('消息', { exact: true }).fill('按最新顺序讨论，不要并行。');
    await page.locator('.composer .send-button').click();
    await expect(page.getByText('讨论或设置已变化，已保留输入。请核对最新状态后重试。', { exact: true })).toBeVisible();
    expect(f.calls).toHaveLength(0);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('按最新顺序讨论，不要并行。');
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toContainText('轮流讨论');
    await page.locator('.composer .send-button').click();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    expect(f.calls.map(call => call.id)).toEqual(['beta', 'alpha']);
  } finally { await f.close(); }
});

test('older hosts retain unsupported supplemental drafts instead of broadcasting them', async ({ page }) => {
  await page.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer(); server.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.type === 'ready') frame.serverCapabilities = frame.serverCapabilities.filter((cap: string) => cap !== 'groups.discussion.composer.v1');
      socket.send(JSON.stringify(frame));
    });
  });
  const f = await setup(page), first = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { if (id === 'alpha') await first.promise; return { text: `${id} answer` }; });
    await page.getByLabel('消息', { exact: true }).fill('先讨论'); await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(['alpha']);
    await page.getByLabel('消息', { exact: true }).fill('保留这段补充'); await page.locator('.composer .send-button').click();
    await expect(page.getByText('更新主机后可从输入框补充讨论，内容已保留。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留这段补充');
    expect(f.calls.map(call => call.id)).toEqual(['alpha']);
  } finally { first.release(); await f.close(); }
});

test("ordinary group only addresses selected Bots; mode changes save without executing", async ({ page }, info) => {
  const f = await setup(page);
  try {
    await page.getByLabel("消息", { exact: true }).fill("先记录背景，不指定回复");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue("");
    await expect(page.locator(".message-scroll")).toContainText("先记录背景，不指定回复");
    expect(f.calls).toHaveLength(0);
    await revealReplyBots(page); await page.getByRole("checkbox", { name: "研究助手", exact: true }).check(); await dismissReplyBots(page);
    await page.getByLabel("消息", { exact: true }).fill("仅研究助手回复"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(["alpha"]);
    await expect(page.locator(".message-scroll")).toContainText("alpha 的回复");
    await page.locator(".group-tree-heading .conversation-row").click({ button: "right" });
    await page.getByRole("menuitem", { name: "群组设置", exact: true }).click();
    await settings(page).getByRole("radio", { name: /^轮流讨论/ }).check();
    await settings(page).getByLabel("最多讨论轮数", { exact: true }).selectOption("2");
    await settings(page).getByRole("button", { name: "上移 复核助手", exact: true }).click();
    await expect(settings(page).getByRole("button", { name: "下移 复核助手", exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath("group-settings-desktop.png") });
    await settings(page).getByRole("button", { name: "保存", exact: true }).click(); await expect(settings(page)).toHaveCount(0);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, "产品讨论组");
    await page.getByRole("button", { name: "设置群聊方式", exact: true }).click();
    await expect(settings(page).getByRole("radio", { name: /^轮流讨论/ })).toBeChecked();
    await expect(settings(page).locator(".group-order-name")).toHaveText(["复核助手", "研究助手"]);
    expect(f.calls).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("sequential speaking keeps order/context, bounded rounds and a persistent topic draft", async ({ page }, info) => {
  const f = await setup(page);
  try {
    f.respond(async id => ({ text: stance(`${id} 的独立观点 ${f.calls.length}`, { stance: "abstain", summary: `${id} 保留意见` }) }));
    await configure(page, "轮流讨论");
    await page.getByRole("button", { name: "发起讨论", exact: true }).click();
    await page.getByLabel("讨论课题", { exact: true }).fill("讨论上线顺序，保留风险与分歧。");
    await page.getByRole("button", { name: "关闭讨论课题", exact: true }).click();
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, "产品讨论组");
    await page.getByRole("button", { name: "发起讨论", exact: true }).click();
    await expect(page.getByLabel("讨论课题", { exact: true })).toHaveValue("讨论上线顺序，保留风险与分歧。");
    await page.getByRole("button", { name: "开始讨论", exact: true }).click();
    await expect(progress(page)).toContainText("保留各方意见", { timeout: 25_000 });
    expect(f.calls.map(call => call.id)).toEqual(["alpha", "beta", "alpha", "beta"]);
    expect(f.calls[1]!.turn.text).toContain("alpha 的独立观点 1");
    expect(f.calls[2]!.turn.text).toContain("beta 的独立观点 2");
    await expect(progress(page).locator(".discussion-turn")).toHaveCount(4);
    await progress(page).locator(".discussion-turn summary").first().click();
    await expect(progress(page).locator(".discussion-turn-text")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("group-discussion-desktop.png") });
    await page.getByRole("button", { name: "关闭讨论进展", exact: true }).click();
    await page.getByRole("button", { name: "发起讨论", exact: true }).click();
    await expect(page.getByLabel("讨论课题", { exact: true })).toHaveValue("");
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("pause waits for the current speaker; resume proceeds and end cancels without replay", async ({ page }) => {
  const f = await setup(page), first = gate();
  try {
    f.respond(async (id, turn) => {
      if (f.calls.length === 1) await first.promise;
      if (f.calls.length === 2) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 30_000); turn.abortSignal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("fixture_cancelled")); }, { once: true }); });
      return { text: stance(`${id} 发言`, { stance: "abstain", summary: "尚未一致" }) };
    });
    await configure(page, "轮流讨论"); await start(page, "暂停恢复验收");
    await expect.poll(() => f.calls.length).toBe(1);
    await progress(page).getByRole("button", { name: "暂停讨论", exact: true }).click();
    await expect(progress(page)).toContainText("本次发言结束后暂停"); first.release();
    await expect(progress(page)).toContainText("讨论已暂停", { timeout: 15_000 }); expect(f.calls).toHaveLength(1);
    await progress(page).getByRole("button", { name: "继续讨论", exact: true }).click(); await expect.poll(() => f.calls.length).toBe(2);
    await progress(page).getByRole("button", { name: "结束讨论", exact: true }).click();
    await page.getByRole("dialog", { name: "结束这次讨论？", exact: true }).getByRole("button", { name: "确认结束", exact: true }).click();
    await expect(progress(page)).toContainText("讨论已结束", { timeout: 15_000 });
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, "产品讨论组");
    await expect(page.getByRole("region", { name: "群聊方式与讨论状态" })).toContainText("讨论已结束");
    expect(f.calls).toHaveLength(2); expect(f.errors).toEqual([]);
  } finally { first.release(); await f.close(); }
});

test("phone long-press mode settings; independent first round is concurrent and blind", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await setup(page), both = gate();
  try {
    f.respond(async id => { if (f.calls.length <= 2) await both.promise; return { text: stance(`${id}_PRIVATE_FIRST_VIEW`, { stance: "abstain", summary: `${id} 未达成共识` }) }; });
    await openMobileHome(page);
    const row = mobileHome(page).locator(".mh-row").filter({ hasText: "产品讨论组" });
    await row.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: 100, clientY: 180 });
    await expect(page.getByRole("button", { name: "群组设置", exact: true })).toBeVisible();
    await row.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true });
    await page.getByRole("button", { name: "群组设置", exact: true }).click();
    await settings(page).getByRole("radio", { name: /^独立评议/ }).check();
    await settings(page).getByLabel("最多讨论轮数", { exact: true }).selectOption("2");
    const box = await settings(page).boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath("group-settings-phone.png") });
    await settings(page).getByRole("button", { name: "保存", exact: true }).click(); await expect(settings(page)).toHaveCount(0);
    await selectConversation(page, "产品讨论组"); await start(page, "独立评议同一个方案，再讨论分歧。");
    await expect.poll(() => f.calls.length).toBe(2);
    expect(f.calls.map(call => call.id).sort()).toEqual(["alpha", "beta"]);
    for (const call of f.calls) expect(call.turn.text).not.toContain("PRIVATE_FIRST_VIEW");
    await page.screenshot({ path: info.outputPath("group-independent-phone.png") }); both.release();
    await expect(progress(page)).toContainText("保留各方意见", { timeout: 25_000 });
    expect(f.calls).toHaveLength(4); expect(f.calls[2]!.turn.text).toContain("PRIVATE_FIRST_VIEW");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { both.release(); await f.close(); }
});

test("lost start response retains draft and reads actual progress without another run", async ({ page }) => {
  const f = await setup(page);
  try {
    f.respond(async id => ({ text: stance(`${id} 提议`, id === "alpha" ? { stance: "propose", proposal: "先完善测试再上线", summary: "建议" } : { stance: "agree", proposalId: "P1", summary: "同意" }) }));
    await configure(page, "轮流讨论");
    let lost = false;
    await page.route("**/api/conversations/*/discussion", async route => {
      if (route.request().method() !== "POST" || lost) return route.continue();
      lost = true; const result = await route.fetch(); expect(result.ok()).toBe(true); await route.abort("failed");
    });
    await page.getByRole("button", { name: "发起讨论", exact: true }).click();
    await page.getByLabel("讨论课题", { exact: true }).fill("审阅上线流程"); await page.getByRole("button", { name: "开始讨论", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("未能确认操作结果");
    await expect(page.getByLabel("讨论课题", { exact: true })).toHaveValue("审阅上线流程");
    await page.getByRole("button", { name: "关闭讨论课题", exact: true }).click();
    await expect(page.getByRole("region", { name: "群聊方式与讨论状态" })).toContainText("已达成共识", { timeout: 25_000 });
    expect(f.calls.map(call => call.id)).toEqual(["alpha", "beta"]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const width of [390, 1360]) test(`topic dialog replays an uncertain completed start with attachments after reload at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await setup(page), requests: string[] = [];
  try {
    await configure(page, '轮流讨论', '1');
    await page.route('**/api/conversations/*/discussion', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      requests.push(route.request().postDataJSON().requestId);
      if (requests.length > 1) return route.continue();
      const result = await route.fetch(); expect(result.ok()).toBe(true); await route.abort('failed');
    });
    await page.getByRole('button', { name: '发起讨论', exact: true }).click();
    await page.getByLabel('讨论课题', { exact: true }).fill('回执丢失后不要重复这个课题。');
    await page.getByLabel('选择课题附件', { exact: true }).setInputFiles({ name: 'topic-receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('PINNED_TOPIC_ATTACHMENT') });
    await page.getByRole('button', { name: '开始讨论', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('未能确认操作结果');
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    const original = (await f.hub.groupDiscussions.view('owner', f.group.id)).run!.id;
    if (width === 390) {
      await page.getByRole('button', { name: '关闭讨论课题', exact: true }).click();
      await configure(page, '普通群聊');
    }
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await page.getByRole('button', { name: '核对上次发送', exact: true }).click();
    await expect(page.getByLabel('讨论课题', { exact: true })).toHaveValue('回执丢失后不要重复这个课题。');
    await expect(page.getByLabel('讨论课题', { exact: true })).toBeDisabled();
    const fileGeometry = await page.locator('.group-discussion-dialog .attachment-draft-file').evaluate(node => {
      const item = node.getBoundingClientRect(), open = node.querySelector('.draft-file-open')!.getBoundingClientRect();
      return { itemBottom: item.bottom, contentBottom: open.bottom, itemHeight: item.height };
    });
    expect(fileGeometry.itemHeight).toBeGreaterThan(50); expect(fileGeometry.contentBottom).toBeLessThanOrEqual(fileGeometry.itemBottom + 1);
    await page.screenshot({ path: info.outputPath(`topic-send-recovery-${width}.png`), animations: 'disabled' });
    await page.getByRole('dialog', { name: '发起讨论', exact: true }).getByRole('button', { name: /开始讨论|核对上次发送/, exact: true }).click();
    await expect(progress(page)).toBeVisible();
    expect(requests).toHaveLength(2); expect(new Set(requests).size).toBe(1);
    expect((await f.hub.groupDiscussions.view('owner', f.group.id)).run!.id).toBe(original);
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every(call => call.turn.files?.some(file => file.endsWith('topic-receipt.txt')))).toBe(true);
    const topic = await f.hub.store.messageForUser('owner', (await f.hub.groupDiscussions.view('owner', f.group.id)).run!.topicMessageId!);
    expect(topic.blocks.filter(block => block.type === 'file')).toHaveLength(1);
    await page.getByRole('button', { name: '关闭讨论进展', exact: true }).click();
    if (width === 390) await configure(page, '轮流讨论', '1');
    await page.getByRole('button', { name: '发起讨论', exact: true }).click();
    await expect(page.getByLabel('讨论课题', { exact: true })).toHaveValue('');
    await expect(page.locator('.attachment-chips')).toHaveCount(0);
  } finally { await f.close(); }
});

test('unfinished code fences remain ordinary group text without addressing or blocking Bots', async ({ page }) => {
  const f = await setup(page);
  try {
    for (const text of ['```text\n@研究助手 请看这段代码', '~~~txt\n@不存在']) {
      await page.getByLabel('消息', { exact: true }).fill(text);
      await page.locator('.composer .send-button').click();
      await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
    }
    expect(f.calls).toHaveLength(0);
    const messages = (await f.hub.store.listMessages('owner', f.group.id)).messages.filter(message => message.authorType === 'user');
    expect(messages).toHaveLength(2); expect(messages.every(message => !message.mentions?.length)).toBe(true);
    await page.getByLabel('消息', { exact: true }).fill('````text\n```\n@研究助手\n````\n@复核助手 请检查');
    await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(['beta']);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('invisible discussion input is retained without launching a model', async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    await page.getByLabel('消息', { exact: true }).fill('\u200b\u200d');
    await page.locator('.composer .send-button').click();
    await expect(page.getByText('请输入可见的讨论内容或添加附件。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('\u200b\u200d');
    await page.getByRole('button', { name: '发起讨论', exact: true }).click();
    await page.getByLabel('讨论课题', { exact: true }).fill('\u2060\ufe0f');
    await expect(page.getByRole('button', { name: '开始讨论', exact: true })).toBeDisabled();
    expect((await f.hub.groupDiscussions.view('owner', f.group.id)).run).toBeNull(); expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

async function topicReceiptOperation(page: Page, id: string, value?: string) {
  return page.evaluate(async ({ id, value }) => {
    const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    for (const entry of await indexedDB.databases()) {
      const db = await request(indexedDB.open(entry.name!));
      if (!db.objectStoreNames.contains('conversations')) { db.close(); continue; }
      if (!await request(db.transaction('conversations').objectStore('conversations').get(id))) { db.close(); continue; }
      const tx = db.transaction('settings', value === undefined ? 'readonly' : 'readwrite'), store = tx.objectStore('settings');
      const key = `operation:group-discussion-start:${id}`;
      const raw = value === undefined ? await request(store.get(key)) : await request(store.put(value, key));
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close(); return raw ?? '';
    }
    throw new Error('topic cache missing');
  }, { id, value });
}

test('topic dialog corrupt receipt requires explicit recovery and keeps the unsent topic', async ({ page }, info) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    await page.getByRole('button', { name: '发起讨论', exact: true }).click();
    await page.getByLabel('讨论课题', { exact: true }).fill('核对之后才发送的课题');
    await page.getByRole('button', { name: '关闭讨论课题', exact: true }).click();
    await topicReceiptOperation(page, f.group.id, '{broken');
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await page.getByRole('button', { name: '核对上次发送', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '发起讨论', exact: true });
    await expect(dialog.getByRole('button', { name: '开始讨论', exact: true })).toBeDisabled();
    await expect(page.getByLabel('讨论课题', { exact: true })).toHaveValue('核对之后才发送的课题');
    await dialog.getByRole('button', { name: '我已核对群内记录', exact: true }).click();
    await page.getByRole('button', { name: '取消解除发送保护', exact: true }).click();
    expect(await topicReceiptOperation(page, f.group.id)).toBe('{broken'); expect(f.calls).toHaveLength(0);
    await dialog.getByRole('button', { name: '我已核对群内记录', exact: true }).click();
    await page.getByRole('button', { name: '解除发送保护', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '开始讨论', exact: true })).toBeEnabled(); expect(f.calls).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('topic-receipt-recovered.png') });
    await dialog.getByRole('button', { name: '开始讨论', exact: true }).click();
    await expect(progress(page)).toBeVisible(); await expect.poll(() => f.calls.length).toBe(2);
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1);
  } finally { await f.close(); }
});

test("a failed turn pauses; explicit retry does not skip it or replay completed work", async ({ page }) => {
  const f = await setup(page);
  try {
    let fail = true;
    f.respond(async id => {
      if (fail) { fail = false; throw new Error("scripted_first_turn_failure"); }
      return { text: stance(`${id} 已重新核对`, { stance: "abstain", summary: "保留意见" }) };
    });
    await configure(page, "轮流讨论", "1"); await start(page, "失败与显式重试验收");
    await expect(progress(page)).toContainText("发言未完成，等待处理", { timeout: 20_000 });
    expect(f.calls.map(call => call.id)).toEqual(["alpha"]);
    const failedRun = (await f.hub.groupDiscussions.view("owner", f.group.id)).run!;
    await page.getByRole("button", { name: "关闭讨论进展", exact: true }).click();
    const scheduled = page.locator(`[data-message-id="${failedRun.steps[0]!.inputMessageId}"]`);
    await expect(scheduled).toHaveClass(/is-discussion-input/);
    await expect(scheduled.getByRole("button", { name: "重新发送消息", exact: true })).toHaveCount(0);
    await expect(page.locator(`[data-message-id="${failedRun.topicMessageId}"]`).getByRole("button", { name: "重新发送消息", exact: true })).toHaveCount(0);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, "产品讨论组");
    await expect(scheduled).toHaveClass(/is-discussion-input/);
    await expect(scheduled.getByRole("button", { name: "重新发送消息", exact: true })).toHaveCount(0);
    expect(f.calls.map(call => call.id)).toEqual(["alpha"]);
    await page.locator(".group-discussion-summary").click();
    await expect(progress(page).getByRole("button", { name: "跳过未完成发言并继续", exact: true })).toBeVisible();
    await progress(page).getByRole("button", { name: "重试未完成发言", exact: true }).click();
    await expect(progress(page)).toContainText("保留各方意见", { timeout: 20_000 });
    expect(f.calls.map(call => call.id)).toEqual(["alpha", "alpha", "beta"]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("settings failure preserves mode draft; latest revision reload resolves concurrent changes", async ({ page }) => {
  const f = await setup(page);
  try {
    await page.getByRole("button", { name: "设置群聊方式", exact: true }).click();
    await settings(page).getByRole("radio", { name: /^独立评议/ }).check();
    let fail = true;
    await page.route("**/api/groups/*/settings", async route => {
      if (route.request().method() !== "PUT" || !fail) return route.continue();
      fail = false; await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
    });
    await settings(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(settings(page).getByRole("alert")).toContainText("未能确认操作结果");
    await expect(settings(page).getByRole("radio", { name: /^独立评议/ })).toBeChecked();
    expect((await f.hub.store.groupSettings("owner", f.group.id)).policy.mode).toBe("mentions");
    // Another authenticated device updates the same settings through shared store rules.
    const base = await f.hub.store.groupSettings("owner", f.group.id);
    await f.hub.store.updateGroup("owner", f.group.id, { title: base.group.title, botIds: base.group.botIds, expectedTitle: base.group.title, expectedBotIds: base.group.botIds, expectedRevision: base.revision, policy: { ...base.policy, mode: "sequential", maxRounds: 1 } });
    await settings(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(settings(page).getByRole("alert")).toContainText("群组已在其他设备修改");
    await settings(page).getByRole("button", { name: "重新读取群组设置", exact: true }).click();
    await expect(settings(page).getByRole("radio", { name: /^轮流讨论/ })).toBeChecked();
    await expect(settings(page).getByLabel("最多讨论轮数", { exact: true })).toHaveValue("1");
    expect(f.calls).toHaveLength(0); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("root group controls its active topic discussion without targeting the wrong conversation", async ({ page }) => {
  const f = await setup(page), first = gate();
  try {
    const topic = await f.hub.store.createConversation("owner", ["alpha", "beta"], "发布顺序", "topic-controls", { type: "group", parentId: f.group.id });
    f.respond(async () => { await first.promise; return { text: stance("暂保留观点", { stance: "abstain", summary: "待讨论" }) }; });
    await configure(page, "轮流讨论");
    const snapshot = await f.hub.store.groupSettings("owner", f.group.id);
    await f.hub.groupDiscussions.start("owner", topic.id, { requestId: "topic-start", revision: snapshot.revision, text: "讨论发布顺序" });
    await expect.poll(() => f.calls.length).toBe(1);
    await expect(page.getByRole("region", { name: "群聊方式与讨论状态" })).toContainText("研究助手 正在发言", { timeout: 15_000 });
    await page.locator(".group-discussion-summary").click();
    await expect(progress(page).getByRole("button", { name: "前往正在讨论的话题" })).toBeVisible();
    await progress(page).getByRole("button", { name: "暂停讨论", exact: true }).click();
    await expect(progress(page)).toContainText("本次发言结束后暂停");
    first.release();
    await expect(progress(page)).toContainText("讨论已暂停", { timeout: 15_000 });
    expect((await f.hub.groupDiscussions.view("owner", topic.id)).run?.status).toBe("paused");
    expect(f.calls).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { first.release(); await f.close(); }
});

test("a transient status read error clears when authoritative reads recover", async ({ page }) => {
  let failed = false;
  await page.route(/\/api\/conversations\/[^/]+\/discussion(?:\?.*)?$/, route => {
    if (!failed && route.request().method() === "GET") {
      failed = true;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporarily_unavailable" }) });
    }
    return route.continue();
  });
  const f = await setup(page);
  try {
    await expect(page.getByRole("alert").filter({ hasText: "未能读取讨论状态" })).toBeVisible();
    await expect(page.locator(".group-discussion-summary")).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByRole("alert").filter({ hasText: "未能读取讨论状态" })).toHaveCount(0);
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

test("active discussion refresh uses small unchanged responses and still shows completion", async ({ page }) => {
  const f = await setup(page), hold = gate(), reads: { unchanged: boolean; bytes: number }[] = [];
  page.on("response", response => {
    if (response.request().method() !== "GET" || !/\/api\/conversations\/[^/]+\/discussion(?:\?|$)/.test(response.url())) return;
    void response.text().then(body => { const value = JSON.parse(body); reads.push({ unchanged: value.unchanged === true, bytes: Buffer.byteLength(body) }); }).catch(() => {});
  });
  try {
    f.respond(async id => { if (id === "alpha") await hold.promise; return { text: stance(`${id} 独立意见`, { stance: "abstain", summary: "有待验证" }) }; });
    await configure(page, "轮流讨论", "1"); await start(page, "等待过程中不重复下载完整讨论");
    await expect.poll(() => reads.some(read => read.unchanged), { timeout: 15_000 }).toBe(true);
    expect(reads.filter(read => read.unchanged).every(read => read.bytes < 256)).toBe(true);
    hold.release();
    await expect(progress(page)).toContainText("保留各方意见", { timeout: 20_000 });
    expect(f.calls.map(call => call.id)).toEqual(["alpha", "beta"]);
    expect(f.errors).toEqual([]);
  } finally { hold.release(); await f.close(); }
});

test("long completed turns are fetched only when expanded and reused on reopening", async ({ page }) => {
  const f = await setup(page), fullReads: string[] = [];
  page.on("request", request => { if (/\/discussion\/[^/]+\/steps\//.test(request.url())) fullReads.push(request.url()); });
  try {
    f.respond(async id => ({ text: stance(`${id}观点。${"需要独立核对证据。".repeat(500)}全文末尾标记_${id}`, { stance: "abstain", summary: "逐项核对证据" }) }));
    await configure(page, "轮流讨论", "1"); await start(page, "长发言按需读取");
    await expect(progress(page)).toContainText("保留各方意见", { timeout: 25_000 });
    expect(fullReads).toHaveLength(0);
    const first = progress(page).locator(".discussion-turn").first();
    await first.locator("summary").click();
    await expect(first).toContainText("全文末尾标记_alpha", { timeout: 15_000 });
    expect(fullReads).toHaveLength(1);
    await first.locator("summary").click(); await first.locator("summary").click();
    await expect(first).toContainText("全文末尾标记_alpha");
    expect(fullReads).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("topic attachment draft survives reload and reaches each participant once with visible consensus evidence", async ({ page }) => {
  const f = await setup(page), seen: string[] = [];
  try {
    f.respond(async (id, turn) => {
      for (const file of turn.files ?? []) seen.push(`${id}:${(await readFile(file, "utf8")).trim()}`);
      return { text: id === "alpha" ? stance("建议先验证再发布。", { stance: "propose", proposal: "先验证再发布", summary: "保留验证步骤" })
        : stance("同意该提案。", { stance: "agree", proposalId: "P1", summary: "同意先验证" }) };
    });
    await configure(page, "轮流讨论", "1");
    await page.getByRole("button", { name: "发起讨论", exact: true }).click();
    await page.getByLabel("讨论课题", { exact: true }).fill("请结合附件讨论发布计划");
    await page.getByLabel("选择课题附件", { exact: true }).setInputFiles({ name: "brief.txt", mimeType: "text/plain", buffer: Buffer.from("release requirements\n") });
    await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("brief.txt");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, "产品讨论组");
    await page.getByRole("button", { name: "发起讨论", exact: true }).click();
    await expect(page.getByLabel("讨论课题", { exact: true })).toHaveValue("请结合附件讨论发布计划");
    await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("brief.txt");
    await page.getByRole("button", { name: "开始讨论", exact: true }).click();
    await expect(progress(page)).toContainText("已达成共识", { timeout: 30_000 });
    await expect(progress(page).locator(".discussion-positions")).toContainText("同意 P1");
    expect(seen).toEqual(["alpha:release requirements", "beta:release requirements"]);
    expect(f.calls).toHaveLength(2);
    await page.getByRole("button", { name: "关闭讨论进展", exact: true }).click();
    await page.getByRole("button", { name: "发起讨论", exact: true }).click();
    await expect(page.getByLabel("讨论课题", { exact: true })).toHaveValue("");
    await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("older host keeps normal group settings without automatic discussion controls", async ({ page }) => {
  await page.routeWebSocket("**/ws", socket => {
    const upstream = socket.connectToServer();
    upstream.onMessage(data => { const frame = JSON.parse(String(data)); if (frame.type === "ready") frame.serverCapabilities = frame.serverCapabilities.filter((cap: string) => cap !== "groups.discussion.v1"); socket.send(JSON.stringify(frame)); });
  });
  // setup's final strip check applies only to capable hosts.
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-group-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "旧主机群组", "group", { type: "group" });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await selectConversation(page, "旧主机群组");
    await expect(page.getByRole("region", { name: "群聊方式与讨论状态" })).toHaveCount(0);
    await page.locator(".group-tree-heading .conversation-row").click({ button: "right" }); await page.getByRole("menuitem", { name: "群组设置", exact: true }).click();
    await expect(settings(page)).toContainText("更新主机后，可设置轮流讨论和独立评议。");
    await expect(settings(page).getByRole("radio")).toHaveCount(0);
    await settings(page).getByLabel("群组名称", { exact: true }).fill("仍可改名");
    await settings(page).getByRole("button", { name: "保存", exact: true }).click(); await expect(settings(page)).toHaveCount(0);
    await expect(page.locator(".group-tree-heading")).toContainText("仍可改名");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("group discussion strip fits an ADHD pane and restores chat after closing settings", async ({ page }, info) => {
  const f = await setup(page);
  try {
    await configure(page, "轮流讨论");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("checkbox", { name: "加入面板：群组验收主机 · 产品讨论组", exact: true }).check();
    const pane = page.locator(`.adhd-card[data-pane-conversation="${f.group.id}"]`);
    await expect(pane.getByRole("region", { name: "群聊方式与讨论状态" })).toBeVisible();
    await pane.getByRole("button", { name: "设置群聊方式", exact: true }).click();
    await expect(settings(page).getByRole("radio", { name: /^轮流讨论/ })).toBeChecked();
    await page.getByRole("button", { name: "关闭群组设置", exact: true }).click();
    await expect(pane.locator(".composer textarea")).toBeVisible();
    const bounds = await pane.evaluate(node => ({ width: node.scrollWidth - node.clientWidth, height: node.scrollHeight - node.clientHeight, page: document.documentElement.scrollHeight - innerHeight }));
    expect(bounds.width).toBeLessThanOrEqual(1); expect(bounds.height).toBeLessThanOrEqual(1); expect(bounds.page).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("group-discussion-adhd.png") });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


test("typed member names narrow replies and unknown mentions retain the draft", async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, "并行回复");
    const composer = page.getByLabel("消息", { exact: true });
    await composer.fill("@研究助手，只请你回答这一条。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(["alpha"]);
    await composer.fill("＠ALPHA! 仍只请你回答。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(["alpha", "alpha"]);
    await composer.fill("＠未知助手 只请你回答。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(composer).toHaveValue("＠未知助手 只请你回答。");
    await expect(page.getByRole("alert")).toContainText("无法识别提及");
    expect((await f.hub.store.listMessages("owner", f.group.id)).messages.filter(m => m.authorType === "user")).toHaveLength(2);
    await configure(page, "普通群聊");
    await composer.fill("@复核助手 请回答。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(["alpha", "alpha", "beta"]);
    const inputs = (await f.hub.store.listMessages("owner", f.group.id)).messages.filter(m => m.authorType === "user");
    expect(inputs).toHaveLength(3);
    for (const message of inputs) expect(message.mentions).toEqual([message.blocks.some(block => block.type === "text" && block.text.startsWith("@复核助手")) ? "beta" : "alpha"]);
  } finally { await f.close(); }
});

for (const width of [390, 1360]) test(`composer intent: clearing an uncertain start permits a new identical note at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await setup(page), first = gate(), posts: string[] = [];
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async (id, turn) => { if (id === 'alpha') await first.promise; return { text: `${id} answer` }; });
    let lose = true;
    await page.route('**/api/conversations/*/discussion**', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts.push(new URL(route.request().url()).pathname.replace(/^.*\/discussion/, '/discussion'));
      if (!lose) return route.continue();
      lose = false; const result = await route.fetch(); expect(result.ok()).toBe(true); await route.abort('failed');
    });
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('继续'); await page.locator('.composer .send-button').click();
    await expect(page.getByText('未能确认操作结果。请先刷新状态，再决定是否重试。', { exact: true })).toBeVisible();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(['alpha']);
    // The user sees the discussion running and discards the retained text.
    await box.fill('');
    await expect(box).toHaveAttribute('placeholder', '补充本次讨论…');
    // Later, the same short text is meant as a supplemental note.
    await box.fill('继续'); await page.locator('.composer .send-button').click();
    await expect(box).toHaveValue('');
    const notes = await f.hub.store.db.all("SELECT id FROM messages WHERE client_msg_id LIKE 'gdnote_%'");
    expect(posts).toHaveLength(2); expect(posts[0]).toBe('/discussion'); expect(posts[1]).toMatch(/^\/discussion\/[^/]+\/notes$/);
    expect(notes).toHaveLength(1);
    first.release();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    expect(f.calls.map(call => call.id)).toEqual(['alpha', 'beta']);
    expect(f.calls[1]!.turn.text).toContain('Notes the user added during the discussion');
    expect(f.errors).toEqual([]);
  } finally { first.release(); await f.close(); }
});

for (const width of [390, 1360]) test(`composer intent: an ended run cannot convert an existing note into a new discussion at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await setup(page), last = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { if (id === 'beta') await last.promise; return { text: `${id} answer` }; });
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('第一个问题'); await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(['alpha', 'beta']);
    await expect(box).toHaveAttribute('placeholder', '补充本次讨论…');
    // The user starts typing a supplemental note while the last speaker answers.
    await box.fill('补充：请注意预算');
    last.release();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).not.toContainText('正在发言');
    await page.screenshot({ path: test.info().outputPath('note-becomes-start-before-send.png') });
    await page.locator('.composer .send-button').click();
    await expect(box).toHaveValue('补充：请注意预算');
    await expect(page.getByText('原讨论已结束，补充内容已保留。请确认后按当前群聊方式发送。', { exact: true })).toBeVisible();
    const runs = await f.hub.store.db.all<{ id: string }>('SELECT id FROM group_discussions');
    expect(runs).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await expect(box).toHaveValue('补充：请注意预算');
    await page.locator('.composer .send-button').click();
    await page.getByRole('button', { name: '作为新讨论', exact: true }).click();
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1);
    await page.locator('.composer .send-button').click();
    await expect(box).toHaveValue('');
    await expect.poll(() => f.calls.length).toBe(4);
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally { last.release(); await f.close(); }
});

test('composer intent: an ended note offers the current ordinary mode without promising a new discussion', async ({ page }) => {
  const f = await setup(page), last = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { if (id === 'beta') await last.promise; return { text: `${id} answer` }; });
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('第一个问题'); await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(['alpha', 'beta']);
    await expect(box).toHaveAttribute('placeholder', '补充本次讨论…');
    await box.fill('补充内容'); last.release();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    const before = await f.hub.store.groupSettings('owner', f.group.id);
    await f.hub.store.updateGroup('owner', f.group.id, {
      title: before.group.title, expectedTitle: before.group.title, botIds: before.group.botIds, expectedBotIds: before.group.botIds,
      policy: { mode: 'mentions', botOrder: before.group.botIds, maxRounds: 1 }, expectedRevision: before.revision,
    });
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toContainText('不 @ 仅记录');
    await page.locator('.composer .send-button').click();
    await expect(page.getByRole('button', { name: '作为新讨论', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '按当前方式', exact: true }).click();
    await page.locator('.composer .send-button').click();
    await expect(box).toHaveValue('');
    await expect.poll(async () => (await f.hub.store.db.all("SELECT id FROM messages WHERE blocks_json LIKE ? AND client_msg_id NOT LIKE ?", ['%补充内容%', 'gd%'])).length).toBe(1);
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1);
    expect(f.calls).toHaveLength(2); expect(f.errors).toEqual([]);
  } finally { last.release(); await f.close(); }
});

for (const content of ['attachment', 'recording', 'hold-voice'] as const) test(`composer intent: ${content} keeps its original note after completion`, async ({ page }) => {
  await microphone(page);
  if (content === 'hold-voice') await page.setViewportSize({ width: 390, height: 844 });
  const f = await setup(page), last = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { if (id === 'beta') await last.promise; return { text: `${id} answer` }; });
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('先讨论'); await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(['alpha', 'beta']);
    await expect(box).toHaveAttribute('placeholder', '补充本次讨论…');
    if (content === 'attachment') await page.locator('input[type=file][multiple]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('FILE_ONLY_NOTE') });
    else {
      await page.getByRole('button', { name: '录制语音', exact: true }).click();
      if (content === 'hold-voice') {
        const button = await page.getByRole('button', { name: '按住说话', exact: true }).boundingBox();
        await page.mouse.move(button!.x + button!.width / 2, button!.y + button!.height / 2); await page.mouse.down();
      }
      await expect(page.getByLabel('录音时长', { exact: true })).not.toHaveText('00:00');
    }
    last.release();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toContainText('保留各方意见');
    if (content === 'recording') await page.getByRole('button', { name: '完成录音', exact: true }).click();
    if (content === 'hold-voice') await page.mouse.up();
    else {
      await expect(page.getByRole('region', { name: '待发送的附件', exact: true })).toBeVisible();
      // Note target and file bytes survive reload, including a finished encoder.
      await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿已保存');
      await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
      await page.locator('.composer .send-button').click();
    }
    await expect(page.getByRole('button', { name: '作为新讨论', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '待发送的附件', exact: true })).toBeVisible();
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1);
    expect(f.calls).toHaveLength(2); expect(f.errors).toEqual([]);
  } finally { last.release(); await page.mouse.up().catch(() => {}); await f.close(); }
});

async function groupCacheOperation(page: Page, id: string, operation: 'corrupt-receipt' | 'corrupt-intent' | 'conflict-rich' | 'receipt') {
  return page.evaluate(async ({ id, operation }) => {
    const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    for (const name of await indexedDB.databases()) {
      const db = await request(indexedDB.open(name.name!));
      if (!db.objectStoreNames.contains('settings')) { db.close(); continue; }
      const match = await request(db.transaction('settings').objectStore('settings').get(`group-composer-intent:${id}`));
      if (!match) { db.close(); continue; }
      if (operation === 'receipt') { const raw = await request(db.transaction('settings').objectStore('settings').get(`draft:discussion-composer:${id}`)); db.close(); return raw ?? ''; }
      const storeName = operation === 'conflict-rich' ? 'conversationDrafts' : 'settings';
      const tx = db.transaction(storeName, 'readwrite'), store = tx.objectStore(storeName);
      if (operation === 'corrupt-receipt') store.put('{broken', `draft:discussion-composer:${id}`);
      else if (operation === 'corrupt-intent') store.put('{broken', `group-composer-intent:${id}`);
      else { const value = await request(store.get(id)); store.put({ ...value, revision: 'another-window' }, id); }
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close(); return 'done';
    }
    throw new Error('fixture group draft cache not found');
  }, { id, operation });
}

for (const corruption of ['corrupt-receipt', 'corrupt-intent'] as const) test(`composer intent: ${corruption} requires checking and an explicit reset`, async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    const box = page.getByLabel('消息', { exact: true }); await box.fill('检查后再发');
    await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿已保存');
    await groupCacheOperation(page, f.group.id, corruption);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await expect(box).toHaveValue('检查后再发');
    await page.locator('.composer .send-button').click();
    await expect(page.getByRole('button', { name: '核对后重新发送', exact: true })).toBeVisible();
    expect(f.calls).toHaveLength(0);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '核对后重新发送', exact: true }).click();
    if (corruption === 'corrupt-receipt') expect(await groupCacheOperation(page, f.group.id, 'receipt')).toBe('{broken');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '核对后重新发送', exact: true }).click();
    await expect(box).toHaveValue('检查后再发'); expect(f.calls).toHaveLength(0);
    await page.locator('.composer .send-button').click();
    await expect(box).toHaveValue(''); await expect.poll(() => f.calls.length).toBe(2);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('composer intent: successful send remains successful if draft cleanup conflicts', async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    await page.locator('input[type=file][multiple]').setInputFiles({ name: 'cleanup.txt', mimeType: 'text/plain', buffer: Buffer.from('CLEANUP_CONFLICT') });
    const box = page.getByLabel('消息', { exact: true }); await box.fill('已经发出');
    await page.route('**/api/conversations/*/discussion', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      await groupCacheOperation(page, f.group.id, 'conflict-rich'); await route.fulfill({ response });
    });
    await page.locator('.composer .send-button').click();
    await expect(page.getByText('消息已发送，但本机草稿清理未完成。请先核对聊天记录，避免重复发送。', { exact: true })).toBeVisible();
    await expect.poll(() => f.calls.length).toBe(2);
    const pending = JSON.parse(await groupCacheOperation(page, f.group.id, 'receipt'));
    expect(pending.kind).toBe('start'); expect(pending.intentId).toBeTruthy();
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


test('composer intent: unsaved conflicting attachments block HTTP before send', async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    const input = page.locator('input[type=file][multiple]');
    await input.setInputFiles({ name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('ONE') });
    await page.getByLabel('消息', { exact: true }).fill('先保存再发送');
    await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿已保存');
    await groupCacheOperation(page, f.group.id, 'conflict-rich');
    await input.setInputFiles({ name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('TWO') });
    await expect(page.getByText('另一窗口已更新此草稿。当前内容仍在此页，请备份后重新打开客户端。', { exact: false })).toBeVisible();
    await page.locator('.composer .send-button').click();
    await expect(page.getByText('草稿尚未保存或已在另一窗口修改，请保留当前内容并重新打开对话。', { exact: true })).toBeVisible();
    expect(f.calls).toHaveLength(0);
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(0);
    await expect(page.getByRole('region', { name: '待发送的附件', exact: true })).toContainText('two.txt');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const fault of ['attachment-quota', 'temporary-text-write'] as const) test(`composer intent: ${fault} has a safe recovery path`, async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    await page.evaluate(({ id, fault }) => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        const match = fault === 'attachment-quota' ? this.name === 'conversationDrafts' && key === id : this.name === 'settings' && key === `group-composer-intent:${id}`;
        if (match) { IDBObjectStore.prototype.put = put; this.transaction.abort(); throw new Error(fault === 'attachment-quota' ? 'draft_capacity_exceeded' : 'temporary draft storage failure'); }
        return put.call(this, value, key);
      };
    }, { id: f.group.id, fault });
    const box = page.getByLabel('消息', { exact: true });
    if (fault === 'attachment-quota') {
      await page.locator('input[type=file][multiple]').setInputFiles({ name: 'legal-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('VALID_HUB_UPLOAD') });
      await expect(page.getByText('草稿未自动保存，', { exact: false })).toBeVisible();
      await box.fill('本机满了仍然发送');
    } else {
      await box.fill('恢复存储后发送');
      await expect(page.getByRole('button', { name: '重试保存', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '重试保存', exact: true }).click();
      await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿已保存');
    }
    await page.locator('.composer .send-button').click();
    await expect(box).toHaveValue(''); await expect.poll(() => f.calls.length).toBe(2);
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1);
    if (fault === 'attachment-quota') expect((await Promise.all((f.calls[0]!.turn.files ?? []).map(file => readFile(file, 'utf8')))).join('')).toContain('VALID_HUB_UPLOAD');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('composer intent: a newer draft survives an older send receipt and is not replayed', async ({ page }) => {
  const f = await setup(page), response = gate(), speaker = gate(); let committed = false, other: Page | undefined;
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { if (id === 'alpha') await speaker.promise; return { text: `${id} answer` }; });
    await page.route('**/api/conversations/*/discussion', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const result = await route.fetch(); expect(result.ok()).toBe(true); committed = true;
      await response.promise; await route.fulfill({ response: result });
    });
    const box = page.getByLabel('消息', { exact: true }); await box.fill('原问题'); await page.locator('.composer .send-button').click();
    await expect.poll(() => committed).toBe(true);
    await expect(box).toHaveAttribute('placeholder', '补充本次讨论…');
    // The sending window is read-only. A genuinely different window can still
    // save a newer draft; the old receipt must not erase it.
    await expect(box).toHaveAttribute('readonly', '');
    other = await page.context().newPage(); await other.goto(f.hub.url); await waitForClientOnline(other); await selectConversation(other, '产品讨论组');
    const otherBox = other.getByLabel('消息', { exact: true });
    await expect(otherBox).toHaveAttribute('placeholder', '补充本次讨论…');
    await otherBox.fill(''); await otherBox.fill('后来补充'); await expect(other.getByLabel('草稿状态', { exact: true })).toHaveText('草稿已保存');
    response.release(); await expect(box).toBeEditable(); await other.close(); other = undefined;
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await expect(page.locator('.composer .send-button')).toBeEnabled(); await expect(box).toHaveValue('后来补充');
    await page.locator('.composer .send-button').click(); await expect(box).toHaveValue('');
    expect(await f.hub.store.db.all("SELECT id FROM messages WHERE client_msg_id LIKE 'gdnote_%'")).toHaveLength(1);
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1);
    speaker.release(); await expect.poll(() => f.calls.length).toBe(2);
    expect(f.calls[1]!.turn.text).toContain('后来补充'); expect(f.errors).toEqual([]);
  } finally { response.release(); speaker.release(); await other?.close(); await f.close(); }
});

test('composer intent: send preparation locks local editing without changing the accepted text', async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    const box = page.getByLabel('消息', { exact: true }); await box.fill('原问题');
    await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿已保存');
    await page.evaluate(async () => {
      const source = performance.getEntriesByType('resource').find(entry => /\/storage-[^/]+\.js$/.test(entry.name))?.name;
      if (!source) throw new Error('fixture storage module not loaded');
      const module = await import(source);
      const Cache = Object.values(module).find((value: any) => typeof value === 'function' && value.prototype?.groupComposerDraft) as any;
      const original = Cache.prototype.groupComposerDraft;
      Cache.prototype.groupComposerDraft = async function(...args: any[]) {
        Cache.prototype.groupComposerDraft = original;
        const result = await original.apply(this, args);
        await new Promise<void>(resolve => { (window as any).releaseGroupPrepare = resolve; });
        return result;
      };
    });
    await page.locator('.composer .send-button').click();
    await page.waitForFunction(() => typeof (window as any).releaseGroupPrepare === 'function');
    await expect(box).toHaveAttribute('readonly', ''); await box.pressSequentially('修正后的问题');
    await expect(box).toHaveValue('原问题'); expect(f.calls).toHaveLength(0);
    await page.evaluate(() => (window as any).releaseGroupPrepare());
    await expect(box).toHaveValue(''); await expect(box).toBeEditable();
    await expect.poll(() => f.calls.length).toBe(2);
    expect(f.calls[0]!.turn.text).toContain('原问题'); expect(f.calls[0]!.turn.text).not.toContain('修正后的问题'); expect(f.errors).toEqual([]);
  } finally { await page.evaluate(() => (window as any).releaseGroupPrepare?.()).catch(() => {}); await f.close(); }
});

for (const foreign of [false, true]) test(`composer intent: editing after the clear receipt ${foreign ? 'keeps a real foreign conflict' : 'uses its own tombstone'}`, async ({ page }) => {
  const f = await setup(page), speaker = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { if (id === 'alpha') await speaker.promise; return { text: `${id} answer` }; });
    await page.evaluate(async () => {
      const source = performance.getEntriesByType('resource').find(entry => /\/storage-[^/]+\.js$/.test(entry.name))?.name;
      if (!source) throw new Error('fixture storage module not loaded');
      const module = await import(source);
      const Cache = Object.values(module).find((value: any) => typeof value === 'function' && value.prototype?.clearGroupComposerDraft) as any;
      const original = Cache.prototype.clearGroupComposerDraft;
      Cache.prototype.clearGroupComposerDraft = async function(...args: any[]) {
        Cache.prototype.clearGroupComposerDraft = original;
        const result = await original.apply(this, args);
        const fixture = (window as any).heldGroupClear = { cache: this, id: args[0], tombstone: result, release: undefined };
        await new Promise<void>(resolve => { fixture.release = resolve; });
        return result;
      };
    });
    const box = page.getByLabel('消息', { exact: true }); await box.fill('继续'); await page.locator('.composer .send-button').click();
    await page.waitForFunction(() => typeof (window as any).heldGroupClear?.release === 'function');
    await expect(box).toHaveAttribute('placeholder', '补充本次讨论…');
    await expect(box).toHaveAttribute('readonly', ''); await box.pressSequentially('不能接在旧内容后'); await expect(box).toHaveValue('继续');
    if (foreign) await page.evaluate(async () => {
      const f = (window as any).heldGroupClear;
      await f.cache.saveGroupComposerDraft(f.id, '真正另一窗口的内容', { id: 'foreign-edit', empty: false }, f.tombstone.id);
    });
    await page.evaluate(() => (window as any).heldGroupClear.release());
    await expect(box).toHaveValue(''); await expect(box).toBeEditable(); await box.fill('继续');
    await expect(page.locator('.composer .send-button')).toBeEnabled();
    await expect(box).toHaveValue('继续');
    if (foreign) {
      await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿未保存');
      await expect(page.getByText('另一窗口已更新此草稿。当前内容仍在此页，请备份后重新打开客户端。', { exact: true })).toBeVisible();
      await expect(page.getByText('draft_changed_elsewhere', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '重试保存', exact: true }).click();
      await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿未保存');
      expect(await page.evaluate(async () => { const f = (window as any).heldGroupClear; return (await f.cache.groupComposerDraft(f.id)).text; })).toBe('真正另一窗口的内容');
    } else {
      await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿已保存');
      await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
      await expect(box).toHaveValue('继续');
      await page.locator('.composer .send-button').click(); await expect(box).toHaveValue('');
      expect(await f.hub.store.db.all("SELECT id FROM messages WHERE client_msg_id LIKE 'gdnote_%'")).toHaveLength(1);
    }
    expect(f.errors).toEqual([]);
  } finally { await page.evaluate(() => (window as any).heldGroupClear?.release?.()).catch(() => {}); speaker.release(); await f.close(); }
});

for (const toDiscussion of [true, false]) test(`composer intent: observed ${toDiscussion ? 'ordinary to discussion' : 'discussion to ordinary'} mode change needs explicit rebinding`, async ({ page }) => {
  const f = await setup(page);
  try {
    if (!toDiscussion) await configure(page, '轮流讨论', '1');
    else await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toContainText('普通群聊');
    const box = page.getByLabel('消息', { exact: true });
    const text = toDiscussion ? '@研究助手 只请你查一下这个' : '讨论一下这个问题';
    await box.fill(text);
    const before = await f.hub.store.groupSettings('owner', f.group.id);
    await f.hub.store.updateGroup('owner', f.group.id, { title: before.group.title, expectedTitle: before.group.title, botIds: before.group.botIds, expectedBotIds: before.group.botIds,
      policy: { mode: toDiscussion ? 'sequential' : 'mentions', botOrder: before.group.botIds, maxRounds: 1 }, expectedRevision: before.revision });
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toContainText(toDiscussion ? '轮流讨论' : '普通群聊');
    await page.locator('.composer .send-button').click();
    await expect(page.getByText('群聊回复方式已变化，草稿已保留。请确认后按当前群聊方式发送。', { exact: true })).toBeVisible();
    await expect(box).toHaveValue(text);
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(0);
    expect((await f.hub.store.listMessages('owner', f.group.id)).messages.filter(message => message.authorType === 'user')).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    // Repeating Send is not consent to change the destination/category.
    await page.locator('.composer .send-button').click();
    expect(f.calls).toHaveLength(0);
    await page.getByRole('button', { name: toDiscussion ? '作为新讨论' : '按当前方式', exact: true }).click();
    expect(f.calls).toHaveLength(0);
    await page.locator('.composer .send-button').click(); await expect(box).toHaveValue('');
    if (toDiscussion) { await expect.poll(() => f.calls.map(call => call.id)).toEqual(['alpha']); expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(0); }
    else {
      expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(0);
      const inputs = (await f.hub.store.listMessages('owner', f.group.id)).messages.filter(message => message.authorType === 'user');
      expect(inputs).toHaveLength(1); expect(inputs[0]!.mentions ?? []).toEqual([]); expect(f.calls).toHaveLength(0);
    }
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const width of [390, 1360]) test(`composer stop ends the old discussion so a corrected question starts fresh at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async (id, turn) => {
      if (f.calls.length === 1) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000);
        turn.abortSignal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('fixture_cancelled')); }, { once: true });
      });
      return { text: stance(`${id} 回答了正确问题`, { stance: 'abstain', summary: '保留意见' }) };
    });
    await page.getByLabel('消息', { exact: true }).fill('上海的气候好还是杭州的旗号');
    await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.length).toBe(1);
    await page.locator('.composer-stop').click();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status, { timeout: 15_000 }).toBe('ended');
    await page.getByLabel('消息', { exact: true }).fill('上海的气候好还是杭州的气候好');
    await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.length).toBe(3);
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    const current = (await f.hub.groupDiscussions.view('owner', f.group.id)).run!;
    expect(current.topic).toBe('上海的气候好还是杭州的气候好');
    expect(current.status).toBe('completed');
    expect(f.calls[1]!.turn.text).toContain('上海的气候好还是杭州的气候好');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('discussion composer offers Bot names when typing at-sign', async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    await page.getByLabel('消息', { exact: true }).fill('@');
    await expect(page.getByRole('button', { name: /^研究助手/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^复核助手/ })).toBeVisible();
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

test('allowed speakers default to everyone and a single selection survives reload', async ({ page }, info) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    await page.getByRole('button', { name: '可发言：全员', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '可发言的 Bot', exact: true });
    for (const name of ['研究助手', '复核助手']) await expect(chooser.getByRole('checkbox', { name, exact: true })).toBeChecked();
    await chooser.getByRole('checkbox', { name: '复核助手', exact: true }).uncheck();
    await chooser.getByRole('button', { name: '完成', exact: true }).click();
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await expect(page.getByRole('button', { name: '可发言：已选 1 位', exact: true })).toBeEnabled();
    await page.getByLabel('消息', { exact: true }).fill('这次只请一位看看');
    await page.locator('.composer .send-button').click();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(['alpha']);
    expect((await f.hub.groupDiscussions.view('owner', f.group.id)).run).toBeNull();
    const inputs = (await f.hub.store.listMessages('owner', f.group.id)).messages.filter(message => message.authorType === 'user');
    expect(inputs[0]!.mentions).toEqual(['alpha']);
    await page.screenshot({ path: info.outputPath('participants-single.png') });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('mention selection addresses only that Bot without changing discussion defaults', async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('@复'); await page.getByRole('button', { name: /^复核助手/ }).click();
    await expect(box).toHaveValue('@复核助手 ');
    await box.press('End'); await box.pressSequentially('请检查错字');
    await page.locator('.composer .send-button').click(); await expect(box).toHaveValue('');
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(['beta']);
    expect((await f.hub.groupDiscussions.view('owner', f.group.id)).run).toBeNull();
    await expect(page.getByRole('button', { name: '可发言：全员', exact: true })).toBeVisible();
    await box.fill('现在一起讨论方案'); await page.locator('.composer .send-button').click();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    expect(f.calls.map(call => call.id)).toEqual(['beta', 'alpha', 'beta']); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const width of [390, 1360]) for (const newTopic of [false, true]) test(`paused composer explicitly ${newTopic ? 'replaces the old topic atomically' : 'adds context and resumes the original topic'} at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await setup(page), first = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { if (f.calls.length === 1) await first.promise; return { text: stance(`${id} 的意见`, { stance: 'abstain', summary: '保留意见' }) }; });
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('原问题：上海与杭州'); await page.locator('.composer .send-button').click();
    await expect.poll(() => f.calls.length).toBe(1);
    await page.getByRole('button', { name: '暂停讨论', exact: true }).click(); first.release();
    await expect(page.getByRole('group', { name: '暂停后如何发送', exact: true })).toBeVisible();
    const previous = (await f.hub.groupDiscussions.view('owner', f.group.id)).run!;
    await expect(page.getByRole('region', { name: '当前讨论课题', exact: true })).toContainText('原问题：上海与杭州');
    await expect(page.locator('.discussion-note-receipt')).toContainText('复核助手');
    if (newTopic) await page.getByRole('radio', { name: '作为新课题', exact: true }).click();
    await box.fill(newTopic ? '新问题：苏州与南京' : '补充：请按今年的数据');
    await expect(page.locator('.composer .send-button')).toHaveText(newTopic ? '发送新课题' : '补充并继续');
    await page.screenshot({ path: info.outputPath(newTopic ? 'paused-new-topic.png' : 'paused-continue.png') });
    await page.locator('.composer .send-button').click(); await expect(box).toHaveValue('');
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    const result = (await f.hub.groupDiscussions.view('owner', f.group.id)).run!;
    if (newTopic) {
      expect(result.id).not.toBe(previous.id); expect(result.topic).toBe('新问题：苏州与南京');
      expect(f.calls.map(call => call.id)).toEqual(['alpha', 'alpha', 'beta']);
      expect(await f.hub.store.db.get('SELECT status FROM group_discussions WHERE id=?', [previous.id])).toMatchObject({ status: 'ended' });
    } else {
      expect(result.id).toBe(previous.id); expect(result.topic).toBe('原问题：上海与杭州');
      expect(f.calls.map(call => call.id)).toEqual(['alpha', 'beta']);
      expect(f.calls[1]!.turn.text).toContain('请按今年的数据');
      expect(result.noteCount).toBe(1); expect(result.unseenNoteCount).toBe(0);
    }
    expect(f.errors).toEqual([]);
  } finally { first.release(); await f.close(); }
});

test('failed speaker retries with the correction instead of silently skipping it', async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { if (f.calls.length === 1) throw new Error('fixture_first_turn_failed'); return { text: stance(`${id} 回答`, { stance: 'abstain', summary: '保留意见' }) }; });
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('原课题含错字'); await page.locator('.composer .send-button').click();
    await expect(page.getByRole('radio', { name: '补充并重试', exact: true })).toBeVisible();
    await expect(page.locator('.discussion-note-receipt')).toContainText('重试发言：研究助手');
    await expect(page.locator('.discussion-note-receipt')).toContainText('跳过后由 复核助手 继续');
    await box.fill('更正：应当按最近季度比较'); await page.locator('.composer .send-button').click(); await expect(box).toHaveValue('');
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    expect(f.calls.map(call => call.id)).toEqual(['alpha', 'alpha', 'beta']);
    expect(f.calls[1]!.turn.text).toContain('更正：应当按最近季度比较'); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const legacy of [false, true]) test(`late addition is visibly unconsumed and active mentions cannot fan out (legacy cache: ${legacy})`, async ({ page }) => {
  const f = await setup(page), last = gate();
  try {
    if (legacy) await page.route(/\/api\/conversations\/[^/]+\/discussion(?:\?|$)/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(), value = await response.json();
      if (value.settings) {
        const known = `${value.run ? `${value.run.id}.${value.run.revision}` : 'none'}.${value.settings.revision}`;
        delete value.viewRevision;
        if (new URL(route.request().url()).searchParams.get('known') === known) return route.fulfill({ response, json: { unchanged: true } });
      }
      return route.fulfill({ response, json: value });
    });
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { if (id === 'beta') await last.promise; return { text: stance(`${id} 回答`, { stance: 'abstain', summary: '保留意见' }) }; });
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('原来的讨论问题'); await page.locator('.composer .send-button').click(); await expect.poll(() => f.calls.length).toBe(2);
    await box.fill('@研究助手 最后补充：我更关心交通'); await page.locator('.composer .send-button').click(); await expect(box).toHaveValue('');
    await expect(page.locator('.discussion-note-receipt')).toContainText('我更关心交通'); expect(f.calls).toHaveLength(2); last.release();
    await expect(page.locator('.discussion-note-receipt')).toContainText('本轮已结束，仍有 1 条补充未进入回复');
    // A terminal run does not poll continuously. Personal deletion must notify
    // the bar and invalidate only this reader's cached note projection.
    const note = (await f.hub.groupDiscussions.view('owner', f.group.id)).run!.latestNote!;
    await f.hub.store.deleteMessages('owner', f.group.id, { messageIds: [note.messageId] });
    await expect(page.locator('.discussion-note-receipt')).toHaveCount(0);

    expect(f.calls).toHaveLength(2); expect(f.calls[1]!.turn.text).not.toContain('我更关心交通'); expect(f.errors).toEqual([]);
  } finally { last.release(); await f.close(); }
});

for (const replacement of [false, true]) test(`paused ${replacement ? 'replacement' : 'continue'} lost receipt replays once after reload`, async ({ page }) => {
  const f = await setup(page), first = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { if (f.calls.length === 1) await first.promise; return { text: stance(`${id} 完成`, { stance: 'abstain', summary: '保留意见' }) }; });
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('最初的课题'); await page.locator('.composer .send-button').click(); await expect.poll(() => f.calls.length).toBe(1);
    await page.getByRole('button', { name: '暂停讨论', exact: true }).click(); first.release();
    await expect(page.getByRole('group', { name: '暂停后如何发送', exact: true })).toBeVisible();
    if (replacement) await page.getByRole('radio', { name: '作为新课题', exact: true }).click();
    let lost = false;
    await page.route('**/api/conversations/**/discussion**', async route => {
      if (!lost && route.request().method() === 'POST' && (replacement ? !!route.request().postDataJSON()?.supersedes : !!route.request().postDataJSON()?.then)) {
        await route.fetch(); lost = true; await route.abort('failed'); return;
      }
      await route.continue();
    });
    await box.fill('收据丢失的更正'); await page.locator('.composer .send-button').click(); await expect.poll(() => lost).toBe(true);
    await expect(box).toBeEnabled(); await expect(box).toHaveValue('收据丢失的更正');
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await expect(box).toHaveValue('收据丢失的更正'); await page.locator('.composer .send-button').click(); await expect(box).toHaveValue('');
    expect(f.calls.map(call => call.id)).toEqual(replacement ? ['alpha', 'alpha', 'beta'] : ['alpha', 'beta']);
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(replacement ? 2 : 1);
    expect(await f.hub.store.db.all("SELECT id FROM messages WHERE client_msg_id LIKE 'gdnote_%'")).toHaveLength(replacement ? 0 : 1);
    expect(f.errors).toEqual([]);
  } finally { first.release(); await f.close(); }
});

test('Stop in another topic stops only its reply and leaves the group discussion running', async ({ page }) => {
  const f = await setup(page), discussion = gate();
  const stopped: string[] = [];
  try {
    const topic = await f.hub.store.createConversation('owner', ['alpha', 'beta'], '另一个话题', 'other-stop-topic', { type: 'group', parentId: f.group.id });
    await configure(page, '轮流讨论', '1');
    f.respond(async (id, turn) => {
      if (id === 'alpha') await discussion.promise;
      else await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000);
        turn.abortSignal?.addEventListener('abort', () => { stopped.push(id); clearTimeout(timer); reject(new Error('fixture_cancelled')); }, { once: true });
      });
      return { text: stance('回答完成', { stance: 'abstain', summary: '保留意见' }) };
    });
    await page.getByLabel('消息', { exact: true }).fill('讨论A仍在运行'); await page.locator('.composer .send-button').click(); await expect.poll(() => f.calls.length).toBe(1);
    await f.hub.store.sendMessage('owner', { conversationId: topic.id, clientMsgId: 'other-topic-directed', text: '只在话题B做检查', attachments: [], mentions: ['beta'] });
    await expect.poll(() => f.calls.length).toBe(2);
    // Direct store setup bypasses the route's conversation snapshot notification.
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await page.locator('.header-topic').filter({ visible: true }).click();
    await page.getByRole('dialog', { name: '群内话题', exact: true }).locator('.topic-directory-row').filter({ has: page.getByText('另一个话题', { exact: true }) }).click();
    await expect(page.getByRole('heading', { name: '另一个话题', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: '当前讨论课题', exact: true })).toContainText('讨论A仍在运行');
    await expect(page.locator('.composer-stop')).toHaveAttribute('aria-label', '停止当前轮次');
    await page.locator('.composer-stop').click(); await expect.poll(() => stopped).toEqual(['beta']);
    expect((await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('running');
    expect(f.errors).toEqual([]);
  } finally { discussion.release(); await f.close(); }
});

test('choosing everyone includes later members instead of freezing a saved list', async ({ page }) => {
  const f = await setup(page);
  try {
    await configure(page, '轮流讨论', '1');
    await page.getByRole('button', { name: '可发言：全员', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '可发言的 Bot', exact: true });
    await chooser.getByRole('checkbox', { name: '复核助手', exact: true }).uncheck();
    await chooser.getByRole('button', { name: '全选', exact: true }).click();
    await chooser.getByRole('button', { name: '完成', exact: true }).click();
    await f.hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', ['gamma', '新成员', 'fixture']);
    await f.hub.store.db.run('INSERT INTO managed_bots VALUES(?,?,?,?)', ['gamma', 'owner', 'gamma', '{}']);
    const old = await f.hub.store.groupSettings('owner', f.group.id);
    await f.hub.store.updateGroup('owner', f.group.id, { title: old.group.title, expectedTitle: old.group.title, botIds: ['alpha', 'beta', 'gamma'], expectedBotIds: old.group.botIds, policy: { ...old.policy, botOrder: ['alpha', 'beta', 'gamma'] }, expectedRevision: old.revision });
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await page.getByRole('button', { name: '可发言：全员', exact: true }).click();
    await expect(chooser.getByRole('checkbox', { name: '新成员', exact: true })).toBeChecked(); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('a participant without control permission sees why a paused draft cannot resume the discussion', async ({ page }) => {
  const f = await setup(page), first = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async () => { await first.promise; return { text: stance('意见', { stance: 'abstain', summary: '保留意见' }) }; });
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('讨论权限边界'); await page.locator('.composer .send-button').click(); await expect.poll(() => f.calls.length).toBe(1);
    await page.getByRole('button', { name: '暂停讨论', exact: true }).click(); first.release();
    await expect(page.getByRole('group', { name: '暂停后如何发送', exact: true })).toBeVisible();
    await f.hub.store.db.run("INSERT INTO users VALUES('different-owner','Group owner','member')");
    await f.hub.store.db.run("UPDATE conversations SET owner_id='different-owner' WHERE id=?", [f.group.id]);
    await f.hub.store.db.run("UPDATE group_discussions SET created_by='different-owner' WHERE conversation_id=?", [f.group.id]);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await expect(page.getByText('请讨论发起人或群主继续讨论后，再发送补充。', { exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: '补充并继续', exact: true })).toBeDisabled();
    await expect(page.getByRole('radio', { name: '作为新课题', exact: true })).toBeDisabled();
    await box.fill('保留我的补充'); await expect(page.locator('.composer .send-button')).toBeDisabled();
    await box.press('Enter'); await expect(box).toHaveValue('保留我的补充');
    expect(f.calls).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { first.release(); await f.close(); }
});

for (const kind of ['start', 'note', 'resume'] as const) test(`discussion ${kind} keeps the composer focused and read-only until its receipt`, async ({ page }) => {
  const f = await setup(page), first = gate(), last = gate(), receipt = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async id => { await (id === 'alpha' ? first : last).promise; return { text: stance(`${id} 完成`, { stance: 'abstain', summary: '保留意见' }) }; });
    const box = page.getByLabel('消息', { exact: true });
    if (kind !== 'start') {
      await box.fill('原课题'); await box.press('Enter'); await expect(box).toHaveValue(''); await expect.poll(() => f.calls.length).toBe(1);
      if (kind === 'resume') {
        await page.getByRole('button', { name: '暂停讨论', exact: true }).click(); first.release();
        await expect(page.getByRole('group', { name: '暂停后如何发送', exact: true })).toBeVisible();
      }
    }
    let received = false;
    await page.route('**/api/conversations/**/discussion**', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); received = true; await receipt.promise; await route.fulfill({ response });
    });
    await box.fill('第一条独立内容'); await box.press('Enter'); await expect.poll(() => received).toBe(true);
    await expect(page.locator('.message.user').filter({ hasText: '第一条独立内容' }).getByRole('button', { name: '引用回复', exact: true })).toBeDisabled();
    await box.pressSequentially('不应拼进第一条');
    await expect(box).toHaveValue('第一条独立内容'); await expect(box).toHaveAttribute('readonly', ''); await expect(box).toBeFocused();
    await expect(page.locator('.composer .send-button')).toHaveAttribute('aria-busy', 'true'); await expect(page.locator('.composer .send-button .lucide-hourglass')).toBeVisible();
    receipt.release(); await expect(box).toHaveValue(''); await expect(box).toBeEditable();
    await box.pressSequentially('第二条独立内容'); await box.press('Enter'); await expect(box).toHaveValue('');
    const texts = (await f.hub.store.listMessages("owner", f.group.id)).messages.filter(message => message.clientMsgId?.startsWith("gdnote_")).sort((a, b) => a.createdAt - b.createdAt);
    expect(texts.map(message => message.blocks.filter(block => block.type === "text").map(block => block.text).join("\n"))).toEqual(kind === 'start' ? ['第二条独立内容'] : ['第一条独立内容', '第二条独立内容']);
    expect(f.errors).toEqual([]);
  } finally { first.release(); last.release(); receipt.release(); await f.close(); }
});

test('run-scoped supplemental notes do not offer ordinary message resend', async ({ page }) => {
  const f = await setup(page), first = gate();
  try {
    await configure(page, '轮流讨论', '1');
    f.respond(async () => { await first.promise; return { text: stance('回答', { stance: 'abstain', summary: '保留意见' }) }; });
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('原课题'); await box.press('Enter'); await expect(box).toHaveValue('');
    await box.fill('这是原讨论的补充'); await box.press('Enter'); await expect(box).toHaveValue('');
    const row = page.locator('.message.user').filter({ hasText: '这是原讨论的补充' });
    await expect(row).toBeVisible(); await expect(row.getByRole('button', { name: '重新发送消息', exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: '引用回复', exact: true })).toBeVisible();
    first.release(); await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await expect(row).toBeVisible(); await expect(row.getByRole('button', { name: '重新发送消息', exact: true })).toHaveCount(0);
    expect(await f.hub.store.db.all("SELECT id FROM messages WHERE client_msg_id LIKE 'gdnote_%'")).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { first.release(); await f.close(); }
});

test('topic dialog honors the shared allowed-speaker choice and never silently includes an excluded Bot', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', ['gamma', '本轮不参与', 'fixture']);
    await f.hub.store.db.run('INSERT INTO managed_bots VALUES(?,?,?,?)', ['gamma', 'owner', 'gamma', '{}']);
    const old = await f.hub.store.groupSettings('owner', f.group.id);
    await f.hub.store.updateGroup('owner', f.group.id, { title: old.group.title, expectedTitle: old.group.title, botIds: ['alpha', 'beta', 'gamma'], expectedBotIds: old.group.botIds, policy: { ...old.policy, botOrder: ['alpha', 'beta', 'gamma'], mode: 'sequential', maxRounds: 1 }, expectedRevision: old.revision });
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await page.getByRole('button', { name: '可发言：全员', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '可发言的 Bot', exact: true });
    await chooser.getByRole('checkbox', { name: '本轮不参与', exact: true }).uncheck(); await chooser.getByRole('button', { name: '完成', exact: true }).click();
    await start(page, '不要叫被排除的成员');
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.participants.map(bot => bot.botId)).toEqual(['alpha', 'beta']);
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    expect(f.calls.map(call => call.id)).toEqual(['alpha', 'beta']); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const width of [390, 1360]) for (const mode of ['并行回复', '轮流讨论'] as const) test(`literal annotations require an explicit send and package/email text stays intact in ${mode} at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await setup(page);
  try {
    await configure(page, mode, '1');
    const box = page.getByLabel('消息', { exact: true });
    const idle = async () => {
      if (mode === '轮流讨论') { await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed'); await expect(box).toHaveAttribute('placeholder', '输入问题，开始讨论…'); }
    };
    const code = '检查 npm i @types/node，我的邮箱@example.com 无法使用。';
    await box.fill(code); await page.locator('.composer .send-button').click(); await expect(box).toHaveValue('');
    await expect.poll(() => f.calls.length).toBe(2); await idle();
    const literal = 'Java 里 @Override 和 @property 是什么意思？';
    await box.fill(literal); await page.locator('.composer .send-button').click();
    await expect(box).toHaveValue(literal); expect(f.calls).toHaveLength(2);
    const confirm = page.getByRole('button', { name: '将未识别的 @ 作为正文发送', exact: true });
    await expect(confirm).toBeVisible();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.screenshot({ path: info.outputPath(`literal-mention-${width}-${theme}.png`), animations: 'disabled' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await confirm.click(); await expect(box).toHaveValue(''); await expect.poll(() => f.calls.length).toBe(4); await idle();
    const userTexts = (await f.hub.store.listMessages('owner', f.group.id)).messages.filter(message => message.authorType === 'user' && message.groupDiscussion?.role !== 'input').map(message => message.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n'));
    expect(userTexts).toContain(code); expect(userTexts).toContain(literal);
    // Permission to treat one send literally does not silently authorize the next.
    await box.fill('@未知 再来一次'); await page.locator('.composer .send-button').click(); await expect(confirm).toBeVisible(); expect(f.calls).toHaveLength(4);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('another window cannot duplicate a pending topic and its newer draft survives the first receipt', async ({ page }) => {
  const f = await setup(page), receipt = gate(); let other: Page | undefined;
  try {
    await configure(page, '轮流讨论', '1');
    await page.getByRole('button', { name: '发起讨论', exact: true }).click(); await page.getByLabel('讨论课题', { exact: true }).fill('原窗口课题');
    other = await page.context().newPage(); await other.goto(f.hub.url); await waitForClientOnline(other); await selectConversation(other, '产品讨论组');
    await other.getByRole('button', { name: '发起讨论', exact: true }).click(); await expect(other.getByLabel('讨论课题', { exact: true })).toHaveValue('原窗口课题');
    let received = false;
    await page.route('**/api/conversations/*/discussion', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); received = true; await receipt.promise; await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '开始讨论', exact: true }).click(); await expect.poll(() => received).toBe(true);
    await other.getByLabel('讨论课题', { exact: true }).fill('另一窗口的新草稿');
    // The second window sees the existing request and must not claim another one.
    await other.getByRole('button', { name: '开始讨论', exact: true }).click();
    // Either the live running-state guard or the persisted pending receipt can
    // reject the racing click. Neither may create a second run or erase this draft.
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1);
    receipt.release(); await expect(progress(page)).toBeVisible();
    await expect.poll(async () => (await f.hub.groupDiscussions.view('owner', f.group.id)).run?.status).toBe('completed');
    await other.reload(); await waitForClientOnline(other); await selectConversation(other, '产品讨论组');
    await other.getByRole('button', { name: '发起讨论', exact: true }).click(); await expect(other.getByLabel('讨论课题', { exact: true })).toHaveValue('另一窗口的新草稿');
    expect(await f.hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(1); expect(f.calls).toHaveLength(2);
  } finally { receipt.release(); await other?.close(); await f.close(); }
});

test('topic dialog uses the same disambiguated member names as the main composer', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.hub.store.db.run('UPDATE bots SET name=? WHERE id=?', ['研究助手', 'beta']);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组');
    await configure(page, '轮流讨论', '1');
    await page.getByRole('button', { name: '可发言：全员', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '可发言的 Bot', exact: true });
    const expectedNames = await chooser.getByRole('checkbox').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')).sort());
    expect(new Set(expectedNames).size).toBe(2);
    await chooser.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '发起讨论', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '发起讨论', exact: true });
    await dialog.getByRole('button', { name: '可发言：全员', exact: true }).click();
    expect(await chooser.getByRole('checkbox').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')).sort())).toEqual(expectedNames);
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

for (const width of [320, 390]) test(`phone discussion speaker choice leaves the text input as wide as ordinary chat at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const f = await setup(page);
  try {
    const box = page.getByLabel('消息', { exact: true });
    const ordinaryWidth = (await box.boundingBox())!.width;
    await configure(page, '轮流讨论', '1');
    const choice = page.getByRole('button', { name: '可发言：全员', exact: true });
    await expect(choice).toBeVisible();
    expect((await box.boundingBox())!.width).toBeGreaterThanOrEqual(ordinaryWidth - 4);
    expect((await choice.boundingBox())!.y + (await choice.boundingBox())!.height).toBeLessThanOrEqual((await box.boundingBox())!.y + 1);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.screenshot({ path: info.outputPath(`phone-speakers-${width}-${theme}.png`), animations: 'disabled' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await choice.click(); const chooser = page.getByRole('dialog', { name: '可发言的 Bot', exact: true });
    await chooser.getByRole('checkbox', { name: '复核助手', exact: true }).uncheck(); await chooser.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.getByRole('button', { name: '可发言：已选 1 位', exact: true })).toBeVisible();
    await box.fill('单独问研究助手'); await page.locator('.composer .send-button').click(); await expect(box).toHaveValue(''); await expect.poll(() => f.calls.map(call => call.id)).toEqual(['alpha']);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('forward reply respects discussion single-recipient mode and blocks an active run before queueing', async ({ page }) => {
  const f = await setup(page), speaker = gate();
  try {
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('可供转发的消息'); await box.press('Enter'); await expect(box).toHaveValue('');
    await configure(page, '轮流讨论', '1');
    const source = page.locator('.message.user').filter({ hasText: '可供转发的消息' }).first();
    const forward = page.getByRole('dialog', { name: '转发消息', exact: true });
    await source.getByRole('button', { name: '转发消息', exact: true }).click();
    await forward.getByRole('button', { name: '产品讨论组', exact: true }).click();
    await forward.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true }).check();
    await forward.getByRole('radio', { name: '复核助手', exact: true }).click();
    await expect(forward.getByRole('radio', { name: '研究助手', exact: true })).not.toBeChecked();
    await expect(forward.getByRole('radio', { name: '复核助手', exact: true })).toBeChecked();
    await forward.getByRole('button', { name: '确认转发', exact: true }).click();
    await expect(forward).toHaveCount(0); await expect.poll(() => f.calls.map(call => call.id)).toEqual(['beta']);
    f.respond(async () => { await speaker.promise; return { text: stance('讨论回答', { stance: 'abstain', summary: '保留意见' }) }; });
    await box.fill('正在运行的课题'); await box.press('Enter'); await expect(box).toHaveValue(''); await expect.poll(() => f.calls.length).toBe(2);
    await source.getByRole('button', { name: '转发消息', exact: true }).click(); await forward.getByRole('button', { name: '产品讨论组', exact: true }).click();
    await forward.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true }).check();
    await expect(forward).toContainText('群内已有进行中的讨论'); await expect(forward.getByRole('button', { name: '确认转发', exact: true })).toBeDisabled();
    expect(await page.locator('.queued-message').count()).toBe(0); expect(f.calls).toHaveLength(2);
    await forward.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true }).uncheck();
    await forward.getByRole('button', { name: '确认转发', exact: true }).click(); await expect(forward).toHaveCount(0);
    const copies = (await f.hub.store.listMessages('owner', f.group.id)).messages.filter(message => message.forwardedFrom);
    expect(copies).toHaveLength(2); expect(copies.filter(message => !message.mentions?.length)).toHaveLength(1); expect(f.calls).toHaveLength(2); expect(f.errors).toEqual([]);
  } finally { speaker.release(); await f.close(); }
});

test('a discussion starting after forward preflight yields a scoped readable rejection without dispatching the forward', async ({ page }) => {
  const f = await setup(page), speaker = gate();
  try {
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('可供竞态转发的消息'); await box.press('Enter'); await expect(box).toHaveValue(''); await configure(page, '轮流讨论', '1');
    const forward = page.getByRole('dialog', { name: '转发消息', exact: true });
    await page.locator('.message.user').filter({ hasText: '可供竞态转发的消息' }).getByRole('button', { name: '转发消息', exact: true }).click();
    await forward.getByRole('button', { name: '产品讨论组', exact: true }).click(); await forward.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true }).check();
    await expect(forward.getByRole('button', { name: '确认转发', exact: true })).toBeEnabled();
    f.respond(async () => { await speaker.promise; return { text: '讨论继续' }; });
    let started = false;
    await page.route('**/api/conversations/*/discussion?brief=1', async route => {
      if (started) return route.continue();
      const response = await route.fetch(); started = true;
      const settings = await f.hub.store.groupSettings('owner', f.group.id);
      await f.hub.groupDiscussions.start('owner', f.group.id, { requestId: 'forward-preflight-race', revision: settings.revision, text: '抢先开始的讨论' });
      await route.fulfill({ response });
    });
    await forward.getByRole('button', { name: '确认转发', exact: true }).click();
    await expect(page.locator('.queued-message')).toContainText('群内已有进行中的讨论');
    await expect(page.locator('.queued-message')).not.toContainText('group_discussion_active');
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect((await f.hub.store.listMessages('owner', f.group.id)).messages.filter(message => message.forwardedFrom)).toHaveLength(0);
    await expect.poll(() => f.calls.length).toBe(1); expect(f.errors).toEqual([]);
  } finally { speaker.release(); await f.close(); }
});

test('ambiguous Bot mentions cannot be bypassed as literal text or broadcast', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.hub.store.db.run('UPDATE bots SET name=? WHERE id=?', ['研究助手', 'beta']);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '产品讨论组'); await configure(page, '并行回复', '1');
    const box = page.getByLabel('消息', { exact: true });
    await box.fill('@研究助手 请检查'); await box.press('Enter');
    await expect(page.getByRole('alert')).toContainText('对应多个 Bot');
    await expect(page.getByRole('button', { name: '将未识别的 @ 作为正文发送', exact: true })).toHaveCount(0);
    await expect(box).toHaveValue('@研究助手 请检查'); expect(f.calls).toHaveLength(0);
    await box.fill('@alpha 请检查'); await box.press('Enter'); await expect(box).toHaveValue('');
    await expect.poll(() => f.calls.map(call => call.id)).toEqual(['alpha']); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('forward preflight read failure keeps the dialog and source with a readable recovery message', async ({ page }) => {
  const f = await setup(page);
  try {
    const box = page.getByLabel('消息', { exact: true }); await box.fill('网络故障转发原文'); await box.press('Enter'); await expect(box).toHaveValue(''); await configure(page, '轮流讨论', '1');
    const dialog = page.getByRole('dialog', { name: '转发消息', exact: true });
    await page.locator('.message.user').filter({ hasText: '网络故障转发原文' }).getByRole('button', { name: '转发消息', exact: true }).click();
    await dialog.getByRole('button', { name: '产品讨论组', exact: true }).click(); await dialog.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true }).check();
    await expect(dialog.getByRole('button', { name: '确认转发', exact: true })).toBeEnabled();
    await page.route('**/api/conversations/*/discussion?brief=1', route => route.abort());
    await dialog.getByRole('button', { name: '确认转发', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('暂时无法确认目标群的回复方式'); expect(f.calls).toHaveLength(0); await expect(page.locator('.queued-message')).toHaveCount(0);
    await dialog.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true }).uncheck(); await dialog.getByRole('button', { name: '确认转发', exact: true }).click();
    await expect(dialog).toHaveCount(0); expect((await f.hub.store.listMessages('owner', f.group.id)).messages.filter(message => message.forwardedFrom)).toHaveLength(1); expect(f.calls).toHaveLength(0); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
