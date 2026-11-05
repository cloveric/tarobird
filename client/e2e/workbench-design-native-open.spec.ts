import { test, expect } from "@playwright/test";
import { AsyncResource } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { WorkbenchReceipt, WorkbenchRequest } from "../../src/client-protocol/workbench.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings } from "./fixtures/settings.js";

// Real Hub/Gateway/Core/App, with a scripted engine. No production App or model.
test.use({ serviceWorkers: "block" });
for (const retireDuringSend of [false, true]) test(retireDuringSend
  ? "retiring an optional opener during native input preserves chat without opening another window"
  : "Claude native review input can open its originating Design and loses authority when the turn ends", async ({ page }, info) => {
  test.setTimeout(120000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "design-native-open-")), stateDir = path.join(directory, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench;
  const validateContext = broker.validateContext.bind(broker);
  let releaseCapture = () => {};
  let captured!: () => void;
  const captureStarted = new Promise<void>(resolve => { captured = resolve; });
  const captureGate = new Promise<void>(resolve => { releaseCapture = resolve; });
  if (retireDuringSend) broker.validateContext = async (...args) => { captured(); await captureGate; return validateContext(...args); };
  const instanceTrace: unknown[] = [];
  const instance = hub as unknown as { instanceRequest(botId: string, method: string, params: unknown): Promise<unknown> };
  const instanceRequest = instance.instanceRequest.bind(hub);
  instance.instanceRequest = async (bot, method, params) => {
    try {
      const result = await instanceRequest(bot, method, params);
      if (method.startsWith("workbench.")) instanceTrace.push({ method, params, result });
      return result;
    } catch (error) {
      if (method.startsWith("workbench.")) instanceTrace.push({ method, params, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Claude',?,'claude')", [hashSecret(secret)]);
  const conversation = await hub.store.createConversation("owner", ["bot"], "Design 原生输入", "design-native");
  let channel: GatewayChannel | undefined, review: string | undefined = "review_design", receipt: WorkbenchReceipt | undefined;
  let failure: unknown, sourceId: string | undefined, turnDone = false, ordinaryContinued = false, release = () => {};
  let inTurn: ((request: WorkbenchRequest) => Promise<WorkbenchReceipt>) | undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  try {
    channel = await attachGateway({ stateDir, url: hub.instanceUrl.replace(/^http/, "ws") + "/instance", secret, botId: "bot", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      supportsSteering: () => true, inFlightSendBehavior: () => "steer", nativeInputCapability: async () => ({ sendNow: true, cancel: true, modelReceipt: true }),
      backgroundInputTarget: async () => review,
      steerActiveTurn: async () => { throw new Error("must_create_native_foreground_turn"); },
      handleAuthorizedMessage: async input => {
        try {
          expect(input.reviewAdmission).toBe("native"); expect(input.nativeInput).toBeTruthy();
          sourceId = channel!.currentMessageId();
          inTurn = AsyncResource.bind((request: WorkbenchRequest) => channel!.workbench(request));
          input.nativeInput!.onProgress({ state: "received" });
          if (retireDuringSend) await expect(inTurn({ requestId: "native-open", operation: "design.open", payload: {} })).rejects.toThrow("workbench_open_target_unavailable");
          else receipt = await inTurn({ requestId: "native-open", operation: "design.open", payload: {} });
          const text = retireDuringSend ? "普通聊天继续；原页面已关闭，本轮未打开设计。" : "设计页已打开。";
          await input.onEngineEvent?.({ type: "assistant_text", text, delta: true });
          ordinaryContinued = true;
          await hold; return { text };
        } catch (error) { failure = error; throw error; }
        finally { turnDone = true; }
      },
    } });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await selectConversation(page, conversation.title);
    await expect(page.locator(".composer-hint")).toHaveText("发送后由 CLI 适时读入");
    const posts: any[] = [];
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === `/api/conversations/${conversation.id}/steer`) posts.push(request.postDataJSON()); });
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("请用 Design 做一个页面");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    if (retireDuringSend) {
      await captureStarted;
      await openSettings(page, "general");
      await expect.poll(async () => (await broker.list({ userId: "owner", conversationId: conversation.id, validate: async () => {} })).filter(window => window.capabilities.includes("design.open.v1")).length).toBe(0);
      releaseCapture();
      await expect.poll(() => ordinaryContinued || (failure instanceof Error ? failure.message : failure), { timeout: 20000 }).toBe(true);
    } else await expect.poll(() => receipt ?? (failure instanceof Error ? failure.message : failure), { timeout: 20000 }).toMatchObject({ status: "applied", saved: true });
    expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ mode: "message", workbench: { openTarget: expect.any(Object) } });
    expect(sourceId).toBeTruthy();
    const source = await broker.contextForMessage("owner", sourceId!, conversation.id);
    expect(source!.openTarget).toEqual(posts[0].workbench.openTarget);
    expect(await hub.store.db.all("SELECT * FROM deliveries WHERE message_id=?", [sourceId!])).toHaveLength(0);
    if (retireDuringSend) {
      await expect(page.getByRole("complementary", { name: "工作台", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "关闭设置", exact: true })).toBeVisible();
    } else await expect(page.getByRole("complementary", { name: "工作台", exact: true })).toBeVisible();
    review = undefined; release();
    await expect.poll(() => turnDone).toBe(true);
    await expect.poll(() => (channel as unknown as { processing: Set<string> }).processing.has(sourceId!)).toBe(false);
    // A callback can retain AsyncLocalStorage after the run has returned. The
    // Host must still refuse it; persisted native input is not a lasting grant.
    await expect(inTurn!({ requestId: "after-native-end", operation: "design.open", payload: {} }))
      .rejects.toThrow(/workbench_(turn_ended|user_turn_required|context_unavailable)/);
  } finally {
    releaseCapture(); release(); broker.validateContext = validateContext;
    await info.attach("workbench-instance-trace", { body: JSON.stringify(instanceTrace, null, 2), contentType: "application/json" });
    await page.close(); if (channel) await channel.disconnect(); await hub.close(); await rm(directory, { recursive: true, force: true });
  }
});
