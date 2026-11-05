import { preparePairing } from "./fixtures/pairing-invite.js";
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
import { enterMobileChat, mobileHome } from "./fixtures/mobile.js";

// Fault injection must intercept App HTTP, not an installed service worker.
test.use({ serviceWorkers: "block" });

async function open(page: Page, hub: HubServer, phone: boolean, title: string) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(phone ? mobileHome(page) : page.locator(".connection-pill.online")).toBeVisible();
  if (phone) await enterMobileChat(page, title); else await page.locator(".conversation-row").filter({ hasText: title }).click();
}
for (const phone of [false, true]) test(`${phone ? "phone" : "desktop"}: native receipts, atomic edit, immediate send and reload uncertainty`, async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "native-input-app-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Claude',?,'claude')", [hashSecret(secret)]);
  const received: Array<{ text: string; observer: NativeInputObserver }> = [], controls: string[] = [], turns: string[] = [];
  let gateway: GatewayChannel | undefined, abort: AbortSignal | undefined;
  const admissionGates = new Map<string, Promise<void>>();
  let cancellationGate: Promise<void> | undefined, sendNowSupported = true;
  try {
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      supportsSteering: () => true, inFlightSendBehavior: () => "steer", nativeInputCapability: async () => ({ sendNow: sendNowSupported, cancel: true, modelReceipt: true }),
      steerActiveTurn: async input => { received.push({ text: input.text, observer: input.nativeInput! }); if (input.text === "回执丢失的消息") throw new Error("lost"); input.nativeInput!.onProgress({ state: "queued" }); await admissionGates.get(input.text); return true; },
      controlNativeInput: async input => { controls.push(input.action); const item = received.find(item => item.observer.id === input.inputId)!; if (input.action === "cancel") { item.observer.onProgress({ state: "cancelled" }); await cancellationGate; return { outcome: "accepted", result: "cancelled" }; } item.observer.onProgress({ state: "dequeued" }); return { outcome: "accepted", result: "delivering" }; },
      handleAuthorizedMessage: async input => { turns.push(input.text); abort = input.abortSignal; await input.onEngineEvent?.({ type: "assistant_text", text: "正在运行工具，后台子代理继续工作。", delta: true }); await new Promise<void>(resolve => input.abortSignal!.addEventListener("abort", () => resolve(), { once: true })); return { text: "结束" }; },
    } });
    const chat = await hub.store.createConversation("owner", ["bot"], "Claude 原生消息", "direct");
    await open(page, hub, phone, chat.title);
    const composer = page.getByRole("textbox", { name: "消息", exact: true }), send = page.getByRole("button", { name: "发送消息", exact: true });
    await composer.fill("开始工作"); if (phone) await send.click(); else await composer.press("Control+Enter"); await expect(page.getByText("正在运行工具，后台子代理继续工作。", { exact: true })).toBeVisible();
    await composer.fill("先检查键盘，再检查滚动"); await send.click(); await expect(composer).toHaveValue("");
    const receipts = page.locator(".native-input-receipt");
    await expect(receipts.first()).toContainText("CLI 已接收 · 待处理");
    expect(turns).toEqual(["开始工作"]); expect(abort?.aborted).toBe(false);
    received[0]!.observer.onProgress({ state: "dequeued" });
    await expect(receipts.first()).toContainText("CLI 正在处理，等待模型回执");
    await expect(receipts.first()).not.toContainText("模型已收到");
    received[0]!.observer.onProgress({ state: "received" }); await expect(receipts.first()).toContainText("模型已收到");
    await expect(receipts.first().getByRole("button", { name: "撤回编辑" })).toHaveCount(0);
    await composer.fill("暂时不做这个"); await send.click(); await expect(composer).toHaveValue("");
    await composer.fill("保留我正在写的新草稿");
    await receipts.nth(1).getByRole("button", { name: "撤回编辑", exact: true }).click();
    await expect(composer).toHaveValue("暂时不做这个\n\n保留我正在写的新草稿"); await expect(receipts.nth(1)).toContainText("已撤回");
    await composer.fill("请现在查看新条件");
    if (phone) { await page.getByRole("button", { name: "更多聊天操作", exact: true }).click(); await page.getByRole("button", { name: "立即发送", exact: true }).click(); }
    else await composer.press("Control+Enter");
    await expect(composer).toHaveValue(""); await expect(receipts.nth(2)).toContainText("CLI 正在处理，等待模型回执");
    expect(controls).toEqual(["cancel", "send-now"]); expect(abort?.aborted).toBe(false); expect(turns).toHaveLength(1);
    received[2]!.observer.onProgress({ state: "unknown", reason: "ended_without_model_receipt" });
    await expect(receipts.nth(2)).toContainText("CLI 已结束本轮，模型接收情况无法确认");
    await expect(receipts.nth(2).getByRole("button")).toHaveCount(0);
    // Rich input remains in the durable next-turn queue, with bytes and text intact.
    await page.locator('input.attachment-picker-input').setInputFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.from("exact attachment bytes") });
    await composer.fill("带附件的下一轮任务"); await send.click(); await expect(composer).toHaveValue("");
    await expect(page.getByRole("button", { name: "管理待执行消息，共 1 条", exact: true })).toBeVisible();
    const rich = (await hub.store.snapshot("owner", chat.id)).messages.find(message => message.blocks.some(block => block.type === "file" && block.name === "context.txt"));
    expect(rich?.blocks).toContainEqual({ type: "text", text: "带附件的下一轮任务" }); expect(received).toHaveLength(3);
    await composer.fill("工具做完后单独总结"); await page.getByRole("button", { name: "更多聊天操作", exact: true }).click(); await page.getByRole("button", { name: "作为下一轮发送", exact: true }).click(); await expect(composer).toHaveValue("");
    await expect(page.getByRole("button", { name: "管理待执行消息，共 2 条", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`native-input-${phone ? "phone" : "desktop"}.png`) });
    // Admission while the user edits must retire the old sending identity,
    // without erasing the newer draft or swallowing a later identical message.
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve; });
    let delayAdmission = true;
    await page.route(url => url.pathname === `/api/conversations/${chat.id}/steer`, async route => {
      if (route.request().method() === "POST" && route.request().postDataJSON()?.text === "重复发送" && delayAdmission) {
        delayAdmission = false; const response = await route.fetch(); await admissionGate; await route.fulfill({ response });
      } else await route.continue();
    });
    await composer.fill("重复发送"); await send.click();
    await expect.poll(() => received.filter(item => item.text === "重复发送").length).toBe(1);
    await composer.fill("我正在另写的草稿"); releaseAdmission();
    await expect(send).toBeEnabled(); await expect(composer).toHaveValue("我正在另写的草稿");
    await composer.fill("重复发送"); await send.click(); await expect(composer).toHaveValue("");
    await expect.poll(() => received.filter(item => item.text === "重复发送").length).toBe(2);
    expect(received[3]!.observer.id).not.toBe(received[4]!.observer.id);
    // Cancellation finishing while another send is in flight must restore only
    // the cancelled text after the other draft has been successfully cleared.
    let releaseCancel!: () => void, releaseOther!: () => void;
    const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
    const otherGate = new Promise<void>(resolve => { releaseOther = resolve; });
    cancellationGate = cancelGate;
    admissionGates.set("撤回时发送的另一条", otherGate);
    await receipts.nth(3).getByRole("button", { name: "撤回编辑", exact: true }).click();
    await composer.fill("撤回时发送的另一条"); await send.click();
    await expect.poll(() => received.some(item => item.text === "撤回时发送的另一条")).toBe(true);
    releaseCancel(); await expect(receipts.nth(3).getByRole("button", { name: "编辑已撤回内容", exact: true })).toBeEnabled();
    await expect(composer).toHaveValue("撤回时发送的另一条");
    releaseOther(); await expect(composer).toHaveValue("重复发送");
    // Lost HTTP with confirmed websocket admission is not a forever-uncertain
    // lock. Editing that known draft allows a fresh identical instruction.
    let loseAcceptedResponse = true;
    await page.route(url => url.pathname === `/api/conversations/${chat.id}/steer`, async route => {
      if (route.request().method() === "POST" && route.request().postDataJSON()?.text === "确认后再次发送" && loseAcceptedResponse) {
        loseAcceptedResponse = false; await route.fetch(); await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "receipt_lost" }) });
      } else await route.fallback();
    });
    await composer.fill("确认后再次发送"); await send.click();
    await expect.poll(() => received.filter(item => item.text === "确认后再次发送").length).toBe(1);
    await expect(receipts.last()).toContainText("CLI 已接收 · 待处理"); await expect(send).toBeEnabled();
    await composer.fill("不同草稿"); await composer.fill("确认后再次发送"); await send.click(); await expect(composer).toHaveValue("");
    expect(received.filter(item => item.text === "确认后再次发送")).toHaveLength(2);
    sendNowSupported = false;
    const beforeUnavailable = received.length;
    await composer.fill("旧 CLI 不支持立即发送"); await composer.press("Control+Enter");
    await expect(page.locator(".error-banner")).toContainText("不支持立即发送");
    await expect(composer).toHaveValue("旧 CLI 不支持立即发送"); expect(received).toHaveLength(beforeUnavailable);
    sendNowSupported = true;
    await composer.fill("/tasks"); await composer.press("Control+Enter");
    await expect(page.getByRole("dialog", { name: "子代理与后台任务", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭任务列表", exact: true }).click();
    await expect(composer).toHaveValue(""); expect(received).toHaveLength(beforeUnavailable);
    const beforeLost = received.map(item => item.text);
    const lostIndex = received.length;
    await composer.fill("回执丢失的消息"); await send.click();
    await expect.poll(() => received.length).toBe(lostIndex + 1);
    const lostMessage = (await hub.store.snapshot("owner", chat.id)).messages.find(message => message.blocks.some(block => block.type === "text" && block.text === "回执丢失的消息"))!;
    const lostReceipt = page.locator(`[data-message-id="${lostMessage.id}"] .native-input-receipt`);
    await expect(lostReceipt).toContainText("发送结果待确认");
    await expect(send).toBeEnabled();
    const retry = async () => {
      const response = page.waitForResponse(response => response.url().endsWith(`/conversations/${chat.id}/steer`) && response.request().method() === "POST");
      await send.click(); await response; await expect(send).toBeEnabled();
    };
    await page.reload(); if (phone) await enterMobileChat(page, chat.title); await expect(composer).toHaveValue("回执丢失的消息"); await retry();
    await expect(lostReceipt).toContainText("发送结果待确认");
    await expect(composer).toHaveValue("回执丢失的消息");
    await expect(page.getByRole("button", { name: "管理待执行消息，共 2 条", exact: true })).toBeVisible();
    expect(received.map(item => item.text)).toEqual([...beforeLost, "回执丢失的消息"]);
    expect(turns).toHaveLength(1); expect(abort?.aborted).toBe(false);
    // A reconnect to an older worker cannot turn an uncertain original write
    // into a definitive rejection and a duplicate durable-queue fallback.
    const worker = (hub as unknown as { bots: Map<string, { nativeInput: boolean }> }).bots.get("bot")!;
    worker.nativeInput = false;
    await retry(); await expect(lostReceipt).toContainText("发送结果待确认");
    expect(received).toHaveLength(lostIndex + 1); expect(turns).toHaveLength(1);
    await expect(composer).toHaveValue("回执丢失的消息");
    await expect(page.getByRole("button", { name: "管理待执行消息，共 2 条", exact: true })).toBeVisible();
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(message => message.authorType === "user" && message.blocks.some(block => block.type === "text" && block.text === "回执丢失的消息"))).toHaveLength(1);
    // A fresh offline message still uses the existing durable outbox. An
    // uncertain native attempt above is a different identity and is not resent.
    await page.context().setOffline(true);
    for (const client of (hub as unknown as { clients: Set<{ ws: { close(): void } }> }).clients) client.ws.close();
    await expect(page.locator(".connection-pill.online")).toHaveCount(0);
    await composer.fill("离线时新写的消息"); await send.click(); await expect(composer).toHaveValue("");
    await page.context().setOffline(false);
    await expect(page.locator(".connection-pill.online")).toBeAttached();
    await expect(page.getByRole("button", { name: "管理待执行消息，共 3 条", exact: true })).toBeVisible();
    expect(received).toHaveLength(lostIndex + 1);
  } finally { await page.close(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
