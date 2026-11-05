import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline, mobileChatAction } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { SessionStore } from "../../src/state/session-store.js";
import { buildCoreConversationKey } from "../../src/core/message-normalizer.js";
import { blocksText, type Conversation } from "../../src/client-protocol/index.js";
import { ownClaudeFixtureTranscripts, writeClaudeObserver } from "./fixtures/claude-app-observer.js";

test.use({ actionTimeout: 15_000 });
test("real Claude detaches a UI binding created before the destination's first native turn", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_CLAUDE_BINDING !== "1", "requires explicit real-Claude acceptance");
  test.setTimeout(240_000);
  const executable = process.env.CLAUDE_EXECUTABLE || "claude";
  const cli = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-claude-app-tools-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const cleanupTranscripts = await ownClaudeFixtureTranscripts(workspace);
  const nativeLog = path.join(root, "native-binding.jsonl"), wrapper = path.join(root, "claude-observer.cjs");
  await writeClaudeObserver(wrapper, nativeLog, executable, true);
  const story = `银色月桥-${randomBytes(6).toString("hex")}`;
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { ...process.env, CLAUDE_EXECUTABLE: wrapper } } });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  const pair = async (device: Page) => {
    await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(device);
  };
  try {
    const bot = await hub.botManager!.create("owner", { requestId: "claude_empty_binding", name: "Claude 助手", engine: "claude", model: "claude-opus-5-5", effort: "low", workspace });
    const stateDir = path.join(root, "bots", bot.id), sessions = new SessionStore(path.join(stateDir, "session.json"));
    await writeFile(path.join(stateDir, "agent.md"), "这是隔离会话验收。每次回复以 CLAUDE_BINDING_TEST 开头。故事标题是无保密要求的普通测试数据，仅在原生对话中记忆，禁止调用工具或读写文件、长期记忆、其他会话。当前原生对话没有故事标题时只回复 CLAUDE_BINDING_TEST UNKNOWN_CONTEXT。\n");
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.online, { timeout: 20_000 }).toBe(1);
    await pair(page);
    await page.getByRole("button", { name: "打开 Claude 助手", exact: true }).click();
    await page.getByPlaceholder("为这段对话起个名字").fill("原会话"); await page.getByRole("button", { name: "创建对话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "原会话", exact: true })).toBeVisible();
    const original = (await hub.store.conversations("owner"))[0]!;
    const answer = async (device: Page, conversation: Conversation, prompt: string, expected: string) => {
      const before = new Set((await hub.store.snapshot("owner", conversation.id)).messages.map((m) => m.id));
      await expect(device.getByRole("heading", { name: conversation.title, exact: true })).toBeVisible();
      await device.getByRole("textbox", { name: "消息", exact: true }).fill(prompt);
      await device.getByRole("button", { name: "发送消息", exact: true }).click();
      const reply = async () => (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => !before.has(m.id) && m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes(expected));
      await expect.poll(async () => !!await reply(), { timeout: 70_000 }).toBe(true);
      await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
      return (await reply())!;
    };
    await answer(page, original, `仅在当前原生对话中记住临时故事标题 ${story}，请确认；不要写入文件或长期记忆。`, story);
    const source = (await sessions.findByConversationKey(buildCoreConversationKey(original.id)))!.codexSessionId;
    await page.getByRole("button", { name: "为 Claude 助手 新建对话", exact: true }).click();
    await page.getByPlaceholder("为这段对话起个名字").fill("直接恢复的空对话"); await page.getByRole("button", { name: "创建对话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "直接恢复的空对话", exact: true })).toBeVisible();
    const destination = (await hub.store.conversations("owner")).find((c) => c.title === "直接恢复的空对话")!;
    const key = buildCoreConversationKey(destination.id); expect(await sessions.findByConversationKey(key)).toBeNull();
    await clickAppAction(page, "对话设置", page.getByRole("button", { name: "对话设置", exact: true })); await page.getByRole("button", { name: "高级对话管理", exact: true }).click(); await page.getByRole("button", { name: "查看可继续的会话", exact: true }).click();
    await page.getByRole("combobox", { name: "已有会话", exact: true }).selectOption(source); await page.getByRole("button", { name: "使用此会话", exact: true }).click();
    await expect.poll(async () => (await hub.store.conversations("owner")).find((c) => c.id === destination.id)?.bindingId).toBeTruthy();
    await page.getByRole("button", { name: "关闭对话设置", exact: true }).click();
    await answer(page, destination, "回复当前原生会话中的临时故事标题；不知道就回复 UNKNOWN_CONTEXT。", story);
    expect((await sessions.findByConversationKey(key))?.codexSessionId).toBe(source);
    expect((await sessions.findByConversationKey(key))?.suspendedPrevious).toEqual({ sessionId: null, resume: null });
    await pair(phone); await selectConversation(phone, destination.title);
    await mobileChatAction(phone, "对话设置"); await phone.getByRole("button", { name: "高级对话管理", exact: true }).click(); await phone.getByRole("button", { name: "退出接入的会话", exact: true }).click(); await phone.getByRole("dialog", { name: "退出接入的会话", exact: true }).getByRole("button", { name: "确认", exact: true }).click();
    await expect.poll(async () => await sessions.findByConversationKey(key)).toBeNull();
    await phone.reload(); await waitForClientOnline(phone); await selectConversation(phone, destination.title);
    const fresh = await answer(phone, destination, "回复当前原生会话中的临时故事标题；不知道就回复 UNKNOWN_CONTEXT。", "UNKNOWN_CONTEXT");
    expect(blocksText(fresh.blocks)).not.toContain(story);
    const freshSession = (await sessions.findByConversationKey(key))!.codexSessionId;
    expect(freshSession).not.toBe(source); expect((await sessions.findByConversationKey(buildCoreConversationKey(original.id)))?.codexSessionId).toBe(source);
    for (const device of [page, phone]) await expect(device.locator(`[data-message-id="${fresh.id}"]`)).toContainText("UNKNOWN_CONTEXT");
    await page.screenshot({ path: info.outputPath("claude-binding-desktop.png"), animations: "disabled" });
    await phone.screenshot({ path: info.outputPath("claude-binding-phone.png"), animations: "disabled" });
    await writeFile(info.outputPath("live-claude-binding.json"), JSON.stringify({ engine: "claude", cli, model: "claude-opus-5-5", effort: "low", pairedDevices: 2, physicalDevices: false, emptyDestination: true, uiBindingRecoveredContext: true, phoneDetachRemovedBinding: true, reloadDidNotRebind: true, freshSessionExcludedOldContext: true, sourceConversationUnchanged: true }, null, 2));
  } finally {
    const browserCleanup = await Promise.allSettled([context.close(), page.close()]);
    // Fail closed if the Hub/native workers cannot stop: keep their files.
    await hub.close();
    const frames = (await readFile(nativeLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const sessions = [...new Set(frames.filter((frame) => frame.type === "session").map((frame) => frame.sessionId as string))];
    const launches = frames.filter((frame) => frame.type === "launch");
    await expect.poll(() => launches.every((entry) => [entry.observerPid, entry.childPid].every((pid) => {
      if (!Number.isInteger(pid) || pid <= 1) return false;
      try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    })), { timeout: 15_000 }).toBe(true);
    const removedFixtureTranscripts = await cleanupTranscripts(sessions);
    await writeFile(info.outputPath("cleanup.json"), JSON.stringify({ removedFixtureTranscripts, readBackNoOwnedTranscripts: true, observerAndNativeChildrenStopped: true }));
    await rm(root, { recursive: true, force: true });
    const failures = browserCleanup.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Claude acceptance browser cleanup failed");
  }
});
