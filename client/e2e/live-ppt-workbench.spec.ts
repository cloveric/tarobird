import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { createBridgeDependencies } from "../../src/core/engine-factory.js";
import { appAgentInstructions } from "../../src/gateway/agent-instructions.js";
import type { EngineStreamEvent } from "../../src/codex/adapter.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { workbenchContentTargets } from "./fixtures/workbench-targets.js";

// Opt-in: real Claude, private Bot state, local Hub and a paired browser. No
// installed App, production Bot or global skill files are changed.
test.skip(process.env.PPT_LIVE_CLAUDE !== "1", "explicit live-model acceptance only");
test.use({ serviceWorkers: "block" });
test("native PPT skill authors a deck and publishes it to Workbench without a branded choice", async ({ page }, info) => {
  test.setTimeout(600000);
  const directory = await mkdtemp(path.join(process.env.PPT_LIVE_LAB ?? os.tmpdir(), "native-ppt-"));
  const stateDir = path.join(directory, "bot"), workspace = path.join(stateDir, "workspace");
  await mkdir(path.join(workspace, ".claude/skills"), { recursive: true });
  await symlink(path.resolve(process.env.PPT_NATIVE_SKILL!), path.join(workspace, ".claude/skills/pptx"), "dir");
  for (const skill of ["baoyu-design", "baoyu-ppt"]) await symlink(path.resolve("../skills", skill), path.join(workspace, ".claude/skills", skill), "dir");
  if (process.env.PPT_NODE_MODULES) await symlink(path.resolve(process.env.PPT_NODE_MODULES), path.join(workspace, "node_modules"), "dir");
  await writeFile(path.join(workspace, "AGENTS.md"), "This is an isolated acceptance workspace. Write only here. Do not access unrelated user files, install software, change global settings or use the network. All slide facts are supplied by the test user. Use the applicable available presentation skill and complete the requested App delivery.\n");
  const model = process.env.PPT_LIVE_MODEL ?? "claude-opus-5-5";
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", model, effort: "low", approvalMode: "full-auto", locale: "zh", workspacePath: workspace }));
  const hub = await HubServer.start({ stateDir: path.join(directory, "hub"), clientDir: process.env.PPT_CLIENT_DIST ?? path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','PPT Test',?,'claude')", [hashSecret(secret)]);
  const conversation = await hub.store.createConversation("owner", ["bot"], "原生 PPT 工作台", "native-ppt");
  const { bridge } = await createBridgeDependencies({ ...process.env, TAROBOT_STATE_DIR: stateDir, TAROBOT_INSTANCE: "native-ppt-test" }, { transport: "gateway", startupInstructions: appAgentInstructions });
  const adapter = (bridge as any).adapter, send = adapter.sendUserMessage.bind(adapter);
  const events: EngineStreamEvent[] = [];
  let done = false, failure: string | undefined, answer = "";
  adapter.sendUserMessage = async (sessionId: string, input: any) => {
    try {
      const result = await send(sessionId, { ...input, onEngineEvent: (event: EngineStreamEvent) => {
        if (event.type === "tool_use" || event.type === "session") {
          events.push(event);
          console.log("NATIVE_PPT", event.type === "tool_use" ? event.toolName : "session");
        }
        return input.onEngineEvent?.(event);
      } });
      answer = result.text ?? ""; return result;
    } catch (error) { failure = String(error); throw error; }
    finally { done = true; }
  };
  const channel = await attachGateway({ stateDir, botId: "bot", url: hub.instanceUrl.replace(/^http/, "ws") + "/instance", secret, bridge, runtime: createCoreServiceRuntime(), engine: "claude", model, effort: "low" });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await selectConversation(page, conversation.title);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("做一个天气说明的ppt，放工作台，同时附上可下载的.pptx。资料已经确定，无需联网：这是虚构演示数据，城市上海，晴，22°C，东风2级。只做两页，标题分别为‘天气演示 Weather Demo’和‘出行建议’，第二页写‘带水、适当防晒’。直接完成，不需要再确认城市或格式。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => done, { timeout: 500000, intervals: [1000] }).toBe(true);
    expect(failure).toBeUndefined();
    const uses = events.filter(event => event.type === "tool_use");
    const skillUses = uses.filter(event => event.type === "tool_use" && /^(?:Skill|Read)$/i.test(event.toolName));
    expect(JSON.stringify(skillUses)).toMatch(/pptx(?:\/SKILL\.md|["\\])/i);
    expect(JSON.stringify(skillUses)).not.toMatch(/baoyu-(?:ppt|design)/i);
    expect(uses.some(event => event.type === "tool_use" && /AskUserQuestion|request_user_input/.test(event.toolName))).toBe(false);
    const panel = page.getByRole("complementary", { name: "工作台", exact: true });
    await expect(panel).toBeVisible();
    expect(await panel.innerText()).not.toMatch(/baoyu|宝玉|宝育/i);
    const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench;
    const actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
    const targets = await workbenchContentTargets(broker, actor);
    const window = targets.find(target => target.tabs.some(tab => tab.designFormat === "slides"))!;
    const tab = window.tabs.find(tab => tab.designFormat === "slides")!;
    const target = { deviceId: window.deviceId, windowId: window.windowId, tabId: tab.id };
    const read = await broker.request(actor, { requestId: "native-ppt-readback", operation: "design.read", target, payload: { path: "project/deck.json" } });
    const deck = JSON.parse((read.result as { content: string }).content);
    expect(deck.order).toHaveLength(2);
    await expect(page.frameLocator(".workbench-design-frame:visible").getByText("天气演示 Weather Demo", { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect.poll(async () => JSON.stringify(await hub.store.db.all("SELECT blocks_json FROM messages WHERE conversation_id=?", [conversation.id])), { timeout: 20000 }).toMatch(/\.pptx/);
    await page.screenshot({ path: info.outputPath("native-ppt-workbench.png") });
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, conversation.title);
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(page.frameLocator(".workbench-design-frame:visible").getByText("天气演示 Weather Demo", { exact: true }).first()).toBeVisible({ timeout: 30000 });
    console.log("NATIVE_PPT_PASSED", directory);
  } finally {
    await writeFile(path.join(directory, "evidence.json"), JSON.stringify({ requestedModel: model, stateDir, answer, failure, events }, null, 2));
    await info.attach("native-ppt-evidence", { path: path.join(directory, "evidence.json"), contentType: "application/json" });
    await page.close({ runBeforeUnload: false }); await channel.disconnect(); await bridge.destroy(); await hub.close();
    if (!process.env.PPT_LIVE_LAB) await rm(directory, { recursive: true, force: true });
  }
});
