import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
// Regressions reproduced by the independent Opus App review.
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { NativeInputObserver } from "../../src/client-protocol/native-input.js";

const DIST = path.resolve("dist");
test.use({ serviceWorkers: "block" });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(page.locator(".connection-pill.online")).toBeVisible();
}
const row = (page: Page, title: string) => page.locator(".conversation-row").filter({ hasText: title });

test("N1: idle text send to an offline Claude bot must still reach the durable queue", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "r2-offline-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: DIST });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Claude',?,'claude')", [hashSecret(randomBytes(32).toString("base64url"))]);
    const chat = await hub.store.createConversation("owner", ["bot"], "离线 Claude", "direct");
    await pair(page, hub); await setListOption(page, '显示未连接 Bot', true); await row(page, chat.title).click();
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("Bot 离线时也应排队"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(composer).toHaveValue("");
    await expect.poll(async () => (await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.authorType === "user").length).toBe(1);
    const stored = (await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.authorType === "user");
    expect(stored).toHaveLength(1);
    expect(await composer.inputValue()).toBe("");
    await composer.fill("不支持立即发送时保留"); await composer.press("Control+Enter");
    await expect(page.locator(".error-banner")).toContainText("不支持立即发送，消息已保留");
    await expect(composer).toHaveValue("不支持立即发送时保留");
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.authorType === "user")).toHaveLength(1);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("fresh ordinary input queues safely when the live preflight fails before any native write", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-preflight-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root, clientDir: DIST });
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Claude',?,'claude')", [hashSecret(secret)]);
  let gateway: GatewayChannel | undefined; const deliveries: string[] = [], native: string[] = [];
  try {
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      supportsSteering: () => true, inFlightSendBehavior: () => { throw new Error("preflight unavailable"); },
      steerActiveTurn: async input => { native.push(input.text); return true; },
      handleAuthorizedMessage: async input => { deliveries.push(input.text); return { text: "已收到" }; },
    } });
    const chat = await hub.store.createConversation("owner", ["bot"], "Preflight", "direct");
    await pair(page, hub); await row(page, chat.title).click();
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("探测失败也要正常发送"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(composer).toHaveValue(""); await expect.poll(() => deliveries).toEqual(["探测失败也要正常发送"]);
    expect(native).toEqual([]);
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(message => message.authorType === "user")).toHaveLength(1);
  } finally { await page.close(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const xDraft of ["X 的新草稿", ""]) test(`R4': deferred restore applied after switching back keeps X's own draft (X draft='${xDraft}')`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "r2-restore-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root, clientDir: DIST });
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Claude',?,'claude')", [hashSecret(secret)]);
  const received: Array<{ text: string; observer: NativeInputObserver }> = [];
  let gateway: GatewayChannel | undefined;
  try {
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      supportsSteering: () => true, inFlightSendBehavior: () => "steer", nativeInputCapability: async () => ({ sendNow: true, cancel: true, modelReceipt: true }),
      steerActiveTurn: async input => { received.push({ text: input.text, observer: input.nativeInput! }); input.nativeInput!.onProgress({ state: "queued" }); return true; },
      controlNativeInput: async input => { const item = received.find(i => i.observer.id === input.inputId)!; item.observer.onProgress({ state: "cancelled" }); return { outcome: "accepted", result: "cancelled" }; },
      handleAuthorizedMessage: async input => { await input.onEngineEvent?.({ type: "assistant_text", text: "长任务运行中。", delta: true }); await new Promise<void>(resolve => input.abortSignal!.addEventListener("abort", () => resolve(), { once: true })); return { text: "结束" }; },
    } as any });
    const x = await hub.store.createConversation("owner", ["bot"], "X 对话", "direct_x");
    const y = await hub.store.createConversation("owner", ["bot"], "Y 对话", "direct_y");
    await pair(page, hub);
    const composer = page.getByRole("textbox", { name: "消息", exact: true }), send = page.getByRole("button", { name: "发送消息", exact: true });
    await row(page, x.title).click();
    await composer.fill("开始工作"); await send.click(); await expect(page.getByText("长任务运行中。", { exact: true })).toBeVisible();
    await composer.fill("撤回目标"); await send.click(); await expect(composer).toHaveValue("");
    const receipts = page.locator(".native-input-receipt");
    await expect(receipts.first()).toContainText("CLI 已接收 · 待处理");
    let releaseCancel!: () => void, releaseOther!: () => void;
    const cancelGate = new Promise<void>(r => { releaseCancel = r; }), otherGate = new Promise<void>(r => { releaseOther = r; });
    await page.route(u => u.pathname.includes(`/conversations/${x.id}/inputs/`), async route => { const response = await route.fetch(); await cancelGate; await route.fulfill({ response }); });
    await page.route(u => u.pathname === `/api/conversations/${x.id}/steer`, async route => {
      if (route.request().method() === "POST" && route.request().postDataJSON()?.text === "另一条") { const response = await route.fetch(); await otherGate; await route.fulfill({ response }); }
      else await route.fallback();
    });
    await receipts.first().getByRole("button", { name: "撤回编辑", exact: true }).click();
    await composer.fill("另一条"); await send.click();
    await expect.poll(() => received.some(i => i.text === "另一条")).toBe(true);
    releaseCancel(); await expect(receipts.first()).toContainText("已撤回");
    await page.waitForTimeout(300);
    if (xDraft) await composer.fill(xDraft);
    await row(page, y.title).click(); await expect(composer).toHaveValue("");
    await composer.fill("Y 里的半截草稿");
    const finished = page.waitForResponse(r => r.url().endsWith(`/conversations/${x.id}/steer`) && r.request().method() === "POST");
    releaseOther(); await finished; await page.waitForTimeout(500);
    await row(page, x.title).click();
    await expect(composer).toHaveValue(["撤回目标", xDraft].filter(Boolean).join("\n\n"));
    const xValue = await composer.inputValue();
    await row(page, y.title).click(); await page.waitForTimeout(500);
    await page.reload(); await row(page, x.title).click();
    await expect(composer).toHaveValue(["撤回目标", xDraft].filter(Boolean).join("\n\n"));
    expect(xValue).toBe(["撤回目标", xDraft].filter(Boolean).join("\n\n"));
  } finally { await page.close(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

async function nativeFixture(page: Page, name: string, options: { running?: boolean; steer?: (text: string) => boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `native-${name}-`)), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root, clientDir: DIST });
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Claude',?,'claude')", [hashSecret(secret)]);
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('other','Codex',?,'codex')", [hashSecret(randomBytes(32).toString("base64url"))]);
  const received: Array<{ text: string; observer?: NativeInputObserver }> = [], controls: string[] = [], turns: string[] = [];
  const gateway: GatewayChannel = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
    supportsSteering: () => true, inFlightSendBehavior: () => "steer", nativeInputCapability: async () => ({ sendNow: true, cancel: true, modelReceipt: true }),
    steerActiveTurn: async input => { received.push({ text: input.text, observer: input.nativeInput }); if (options.steer && !options.steer(input.text)) return false; input.nativeInput?.onProgress({ state: "queued" }); return true; },
    controlNativeInput: async input => { controls.push(input.action); return { outcome: "accepted", result: "delivering" }; },
    handleAuthorizedMessage: async input => {
      turns.push(input.text);
      if (!options.running) return { text: "已收到" };
      await input.onEngineEvent?.({ type: "assistant_text", text: "长任务运行中。", delta: true });
      await new Promise<void>(resolve => input.abortSignal!.addEventListener("abort", () => resolve(), { once: true })); return { text: "结束" };
    },
  } });
  return { hub, gateway, received, controls, turns, close: async () => { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

test("NI-1: groups keep explicit steering and Ctrl+Enter is an ordinary group send", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await nativeFixture(page, "group", { running: true });
  try {
    const group = await f.hub.store.createConversation("owner", ["bot", "other"], "Claude 群", "group", { type: "group" });
    await pair(page, f.hub); await row(page, group.title).click();
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await page.locator(".composer-recipients").click(); await page.getByRole("checkbox", { name: "Claude", exact: true }).click(); await page.keyboard.press("Escape");
    // Idle: Ctrl+Enter is the ordinary group send, never a native single-Bot input.
    await composer.fill("开始群内工作"); await composer.press("Control+Enter");
    await expect(page.getByText("长任务运行中。", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue(""); expect(f.turns).toEqual(["开始群内工作"]);
    // Running: the explicit 引导 control remains available once the live target is read.
    await expect(page.locator(".composer-steer")).toBeVisible({ timeout: 15_000 });
    await composer.fill("群里按 Ctrl+Enter 的消息"); await composer.press("Control+Enter");
    await expect(composer).toHaveValue("");
    await expect.poll(async () => (await f.hub.store.snapshot("owner", group.id)).messages.some(m => m.blocks.some(b => b.type === "text" && b.text === "群里按 Ctrl+Enter 的消息"))).toBe(true);
    const sent = (await f.hub.store.snapshot("owner", group.id)).messages.find(m => m.blocks.some(b => b.type === "text" && b.text === "群里按 Ctrl+Enter 的消息"))!;
    expect(sent.blocks.some(b => b.type === "steering")).toBe(false);
    expect(f.received).toEqual([]); expect(f.controls).toEqual([]);
    await expect(page.locator(".native-input-receipt")).toHaveCount(0);
  } finally { await f.close(); }
});

test("NI-4/NI-5: rejected fallback names the reason and finished receipts expose no controls", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await nativeFixture(page, "receipts", { running: true, steer: text => text !== "任务暂不能接收" });
  try {
    const chat = await f.hub.store.createConversation("owner", ["bot"], "Claude 回执", "direct");
    await pair(page, f.hub); await row(page, chat.title).click();
    const composer = page.getByRole("textbox", { name: "消息", exact: true }), send = page.getByRole("button", { name: "发送消息", exact: true });
    await composer.fill("开始工作"); await send.click(); await expect(page.getByText("长任务运行中。", { exact: true })).toBeVisible();
    await composer.fill("任务暂不能接收"); await send.click(); await expect(composer).toHaveValue("");
    // The fallback reached the durable next-turn queue; its rejected native record must not claim a failed send.
    await expect(page.getByRole("button", { name: "管理待执行消息，共 1 条", exact: true })).toBeVisible();
    const rejected = page.locator(".native-input-receipt.rejected");
    await expect(rejected).toHaveCount(1); await expect(rejected).not.toContainText("发送失败");
    await expect(rejected).toContainText("未投递到任务中"); await expect(rejected.getByRole("button")).toHaveCount(0);
    await composer.fill("等待中的消息"); await send.click(); await expect(composer).toHaveValue("");
    const receipt = page.locator(".native-input-receipt").filter({ hasText: "CLI 已接收 · 待处理" });
    await expect(receipt.getByRole("button", { name: "立即发送", exact: true })).toBeVisible();
    f.received.find(item => item.text === "等待中的消息")!.observer!.onProgress({ state: "unknown", reason: "engine_exit" });
    const exited = page.locator(".native-input-receipt").filter({ hasText: "CLI 已退出，模型接收情况无法确认" });
    await expect(exited).toHaveCount(1); await expect(exited.getByRole("button")).toHaveCount(0);
    expect(f.controls).toEqual([]);
  } finally { await f.close(); }
});

test("NI-6: editing the draft during the live preflight reports that nothing was sent", async ({ page }) => {
  test.setTimeout(60_000);
  const f = await nativeFixture(page, "preflight-edit");
  try {
    const chat = await f.hub.store.createConversation("owner", ["bot"], "Claude 空闲", "direct");
    await pair(page, f.hub); await row(page, chat.title).click();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let held = false;
    await page.route(url => url.pathname === `/api/conversations/${chat.id}/steer`, async route => {
      if (route.request().method() === "GET" && !held) { held = true; const response = await route.fetch(); await gate; await route.fulfill({ response }); }
      else await route.fallback();
    });
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("第一句"); await composer.press("Enter");
    await expect.poll(() => held).toBe(true);
    await composer.pressSequentially("，还有补充"); release();
    await expect(page.locator(".error-banner")).toContainText("发送时内容已修改，未发送");
    await expect(composer).toHaveValue("第一句，还有补充"); expect(f.turns).toEqual([]);
    await composer.press("Enter"); await expect(composer).toHaveValue("");
    await expect.poll(() => f.turns).toEqual(["第一句，还有补充"]);
  } finally { await f.close(); }
});
