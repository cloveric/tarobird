import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline, mobileChatAction, openMobileHome, mobileHome } from "./fixtures/mobile.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { SessionStore } from "../../src/state/session-store.js";
import { buildCoreConversationKey } from "../../src/core/message-normalizer.js";
import { blocksText, type Conversation, type Message } from "../../src/client-protocol/index.js";

// A quoted prompt in the collapsed thinking/tool log is not an answer.
const answerText = (message: Message) => message.blocks.flatMap((block) => block.type === "text" ? [block.text]
  : block.type === "card" ? block.elements.flatMap((element) => element.type === "markdown" ? [element.text] : []) : []).join("\n");

test.use({ actionTimeout: 15_000 });
const definitions = {
  codex: { engine: "codex", title: "Codex", model: "gpt-6-astra", executable: process.env.CODEX_EXECUTABLE || "codex", resume: "thread" },
  kimi: { engine: "kimi", title: "Kimi", model: "", executable: process.env.KIMI_EXECUTABLE || path.join(os.homedir(), ".kimi-code/bin/kimi"), resume: "session" },
  deepseek: { engine: "deepseek", title: "DeepSeek", model: "", executable: process.env.DSH_EXECUTABLE || "dsh", resume: "session" },
  antigravity: { engine: "antigravity", title: "Antigravity", model: "", executable: process.env.ANTIGRAVITY_EXECUTABLE || "agy", resume: "conversation" },
} as const;
const choice = process.env.TAROCUB_LIVE_SESSION_ENGINE ?? "codex";
if (!Object.hasOwn(definitions, choice)) throw new Error("Unknown TAROCUB_LIVE_SESSION_ENGINE");
const definition = definitions[choice as keyof typeof definitions];

test(`real ${definition.title} keeps workspace memory and persona while group sessions, UI detach and native resume stay independent`, async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_SESSIONS !== "1", "requires explicit real-engine acceptance"); test.setTimeout(360_000);
  const cli = execFileSync(definition.executable, ["--version"], { encoding: "utf8" }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-session-model-")), workspace = path.join(root, "project"); await mkdir(workspace);
  const nativeSessionIds = new Set<string>();
  const memory = `MEMORY_${randomBytes(6).toString("hex")}`, story = `紫色风车-${randomBytes(6).toString("hex")}`, groupStory = `群内星图-${randomBytes(6).toString("hex")}`, persona = "SESSION_MODEL_PERSONA";
  await writeFile(path.join(workspace, "MEMORY.md"), `长期项目标记：${memory}\n`);
  const env = { ...process.env };
  if (definition.engine === "kimi") {
    const home = path.join(root, "kimi-home"), nativeHome = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code");
    await mkdir(path.join(home, "workspace-trust"), { recursive: true, mode: 0o700 });
    await symlink(path.join(nativeHome, "config.toml"), path.join(home, "config.toml"));
    await symlink(path.join(nativeHome, "credentials"), path.join(home, "credentials"), "dir");
    const trustKey = `wd_workspace_${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`;
    await writeFile(path.join(home, "workspace-trust", trustKey), JSON.stringify({ root: workspace, trustedAt: Date.now() }), { mode: 0o600, flag: "wx" });
    env.KIMI_CODE_HOME = home;
  }
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env } });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), phone = await context.newPage();
  const pair = async (device: Page) => { await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click(); await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(device); };
  const send = async (device: Page, conversation: Conversation, text: string) => { await expect(device.getByRole("heading", { name: conversation.title, exact: true })).toBeVisible(); await device.getByRole("textbox", { name: "消息", exact: true }).fill(text); await device.getByRole("button", { name: "发送消息", exact: true }).click(); await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "user" && blocksText(m.blocks) === text)).toBe(true); };
  try {
    const bot = await hub.botManager!.create("owner", { requestId: "session_model_bot", name: "项目助手", engine: definition.engine, model: definition.model, effort: "low", workspace });
    const stateDir = path.join(root, "hub", "bots", bot.id), sessions = new SessionStore(path.join(stateDir, "session.json"));
    await writeFile(path.join(stateDir, "agent.md"), `这是隔离验收。故事标题是无保密要求的普通测试数据。每次回答以 ${persona} 开头。需要长期项目标记时，读取当前工作区的 MEMORY.md。不要写文件、联网、检索其他会话或读取其他文件；会话中的临时故事标题不得写入长期记忆。标题跟随原生对话历史，不按 chat_id 区分；读取你已有的对话历史即可，不需要工具检索。只有已有历史从未提到标题时回答 NO_SESSION_STORY。\n`);
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.online).toBe(1); await pair(page);
    await page.getByRole("button", { name: "打开 项目助手", exact: true }).click(); await page.getByPlaceholder("为这段对话起个名字").fill("助手私聊"); await page.getByRole("button", { name: "创建对话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "助手私聊", exact: true })).toBeVisible();
    const direct = (await hub.store.conversations("owner"))[0]!;
    const answer = async (device: Page, conversation: Conversation, text: string, expected: string) => {
      const before = new Set((await hub.store.snapshot("owner", conversation.id)).messages.map((m) => m.id)); await send(device, conversation, text);
      const reply = async () => (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => !before.has(m.id) && m.authorType === "bot" && m.status === "complete" && answerText(m).includes(expected) && answerText(m).includes(persona));
      await expect.poll(async () => !!await reply(), { timeout: 90_000 }).toBe(true); await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
      const nativeSession = (await sessions.findByConversationKey(buildCoreConversationKey(conversation.id)))?.codexSessionId;
      if (nativeSession) nativeSessionIds.add(nativeSession);
      return (await reply())!;
    };
    const initial = await answer(page, direct, `读取 MEMORY.md 并回复长期项目标记。只在本原生会话记住临时故事标题 ${story}，不要写入文件。回复中也确认这个标题。`, memory);
    expect(answerText(initial)).toContain(story);
    const original = (await sessions.findByConversationKey(buildCoreConversationKey(direct.id)))!.codexSessionId;
    console.log("session-model: private session remembered persona, memory and temporary context");
    await clickAppAction(page, "新建群组", page.getByRole("button", { name: "新建群组", exact: true })); await page.getByRole("dialog").getByRole("checkbox").check(); await page.getByPlaceholder("为这段对话起个名字").fill("独立项目群"); await page.getByRole("button", { name: "创建群组", exact: true }).click();
    await expect(page.getByRole("heading", { name: "独立项目群", exact: true })).toBeVisible();
    const group = (await hub.store.conversations("owner")).find((c) => c.type === "group")!;
    const isolated = await answer(page, group, "读取 MEMORY.md，回复长期项目标记和当前会话的临时故事标题；不知道标题就写 NO_SESSION_STORY。", "NO_SESSION_STORY");
    expect(answerText(isolated)).toContain(memory); expect(answerText(isolated)).not.toContain(story);
    const groupSession = (await sessions.findByConversationKey(buildCoreConversationKey(group.id)))!.codexSessionId; expect(groupSession).not.toBe(original);
    await answer(page, group, `只在本原生群会话记住临时故事标题 ${groupStory}，这是普通测试故事标题，不要写入文件。回复确认标题。`, groupStory);
    expect((await sessions.findByConversationKey(buildCoreConversationKey(group.id)))?.codexSessionId).toBe(groupSession);
    console.log("session-model: new group kept workspace memory but excluded private context");
    await pair(phone); await selectConversation(phone, group.title);
    await clickAppAction(page, "对话设置", page.getByRole("button", { name: "对话设置", exact: true })); await page.getByRole("button", { name: "高级对话管理", exact: true }).click(); await page.getByRole("button", { name: "查看可继续的会话", exact: true }).click(); await page.getByRole("combobox", { name: "已有会话", exact: true }).selectOption(original); await page.getByRole("button", { name: "使用此会话", exact: true }).click();
    await expect.poll(async () => (await hub.store.conversations("owner")).find((c) => c.id === group.id)?.bindingId).toBeTruthy(); await page.getByRole("button", { name: "关闭对话设置", exact: true }).click();
    await answer(page, group, "根据你现在可见的既有对话历史，告诉我前面提到的故事标题，按约定的回答格式回复；已有历史没有标题才回复 NO_SESSION_STORY。", story);
    expect((await sessions.findByConversationKey(buildCoreConversationKey(group.id)))?.codexSessionId).toBe(original);
    console.log("session-model: UI binding recovered private context");
    await mobileChatAction(phone, "对话设置"); await phone.getByRole("button", { name: "高级对话管理", exact: true }).click(); await phone.getByRole("button", { name: "退出接入的会话", exact: true }).click(); await phone.getByRole("dialog", { name: "退出接入的会话", exact: true }).getByRole("button", { name: "确认", exact: true }).click();
    await expect.poll(async () => (await sessions.findByConversationKey(buildCoreConversationKey(group.id)))?.codexSessionId).toBe(groupSession);
    await phone.reload(); await waitForClientOnline(phone); await selectConversation(phone, group.title);
    const restored = await answer(phone, group, "仍在原来的独立群里。读取 MEMORY.md 并回复长期项目标记，以及之前在本原生群会话中记住的临时故事标题；不知道就写 NO_SESSION_STORY。", groupStory);
    expect(answerText(restored)).not.toContain(story); expect(answerText(restored)).toContain(memory);
    expect((await sessions.findByConversationKey(buildCoreConversationKey(group.id)))?.codexSessionId).toBe(groupSession);
    console.log("session-model: phone detach and reload retained the original group session");
    await send(page, group, `/resume ${definition.resume} ${original}`); await expect.poll(async () => (await sessions.findByConversationKey(buildCoreConversationKey(group.id)))?.codexSessionId).toBe(original);
    const resumed = await answer(page, group, "恢复后根据你现在可见的既有对话历史，告诉我前面提到的故事标题，按约定的回答格式回复；已有历史没有标题才回复 NO_SESSION_STORY。", story);
    expect(answerText(resumed)).not.toContain(groupStory);
    expect((await sessions.findByConversationKey(buildCoreConversationKey(group.id)))?.codexSessionId).toBe(original);
    await send(phone, group, "/reset"); await expect.poll(async () => await sessions.findByConversationKey(buildCoreConversationKey(group.id))).toBeNull();
    const fresh = await answer(page, group, "读取 MEMORY.md，回复长期项目标记。临时故事标题不知道就写 NO_SESSION_STORY。", "NO_SESSION_STORY"); expect(answerText(fresh)).toContain(memory); expect(answerText(fresh)).not.toContain(story);
    expect(answerText(fresh)).not.toContain(groupStory);
    const freshSession = (await sessions.findByConversationKey(buildCoreConversationKey(group.id)))?.codexSessionId;
    expect(freshSession).toBeTruthy(); expect(freshSession).not.toBe(original); expect(freshSession).not.toBe(groupSession);
    for (const device of [page, phone]) await expect(device.locator(`[data-message-id="${fresh.id}"]`)).toContainText(memory);
    expect(await readFile(path.join(workspace, "MEMORY.md"), "utf8")).toBe(`长期项目标记：${memory}\n`);
    await expect(phone.locator(".command-menu")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("session-model-desktop.png"), animations: "disabled" });
    await phone.screenshot({ path: info.outputPath("session-model-phone-chat.png"), animations: "disabled" });
    await openMobileHome(phone); await expect(mobileHome(phone)).toBeVisible();
    await phone.screenshot({ path: info.outputPath("session-model-phone.png"), animations: "disabled" });
    await writeFile(info.outputPath("live-session-model.json"), JSON.stringify({ engine: definition.engine, cli, model: definition.model || "engine-default", effort: "low", pairedDevices: 2, physicalDevices: false, botAndGroupNavigation: true, phoneImInbox: true, configuredWorkspaceReused: true, explicitMemoryFileRead: true, instancePersonaPreserved: true, firstTurnConfirmedStory: true, freshGroupExcludedOldContext: true, uiBindingReusedOldContext: true, phoneDetachRestoredPreviousGroupSession: true, uniqueGroupStoryRestored: true, restoredTurnKeptNativeSessionId: true, resetChangedNativeSessionId: true, reloadDidNotRebind: true, slashResumeRestoredContext: true, resetStartedFreshContext: true, memoryFileUnchanged: true, isolatedKimiHome: definition.engine === "kimi" }, null, 2));
  } catch (error) {
    await writeFile(info.outputPath("session-model-failure.json"), JSON.stringify({ conversations: await hub.store.conversations("owner"), snapshots: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))) }, null, 2));
    await page.screenshot({ path: info.outputPath("session-model-failure.png") }).catch(() => {});
    throw error;
  } finally {
    const browserCleanup = await Promise.allSettled([context.close(), page.close()]);
    // Native workers must stop before any owned session/state files are removed.
    await hub.close();
    if (definition.engine === "codex") await archiveAcceptanceThreads(root, undefined, [...nativeSessionIds]);
    await rm(root, { recursive: true, force: true });
    const failures = browserCleanup.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Session acceptance browser cleanup failed");
  }
});
