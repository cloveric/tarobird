import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { EngineSteeringRejectedError } from "../../src/codex/adapter.js";
import { enterMobileChat, mobileHome } from "./fixtures/mobile.js";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { CoreBridgeLike } from "../../src/core/types.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect((page.viewportSize()?.width ?? 1360) <=760 ? mobileHome(page) : page.locator(".connection-pill.online")).toBeVisible();
}
async function select(page: Page, title: string) {
  const menu = page.getByRole("button", { name: "打开会话列表", exact: true }); if (await menu.isVisible()) await menu.click();
  if ((page.viewportSize()?.width ?? 1360) <=760) { await enterMobileChat(page, title); return; }
  const row = page.locator(".conversation-row").filter({ has: page.getByText(title, { exact: true }) });
  if (!await row.count()) { await page.getByRole("button", { name: `打开 ${title.startsWith("引导") ? "codex" : title.startsWith("agy") ? "antigravity" : title.split(" ")[0]}`, exact: true }).click(); await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible(); return; }
  await row.click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}

test("explicit steering and ordinary queueing have distinct cross-device receipts and engine capability checks", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-steering-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const gateways: GatewayChannel[] = [], errors: string[] = [];
  for (const page of [desktop, phone]) {
    page.on("pageerror", (error) => errors.push(error.message));
    if (process.env.TAROBOT_QUEUE_LEGACY_SIGNALS === "1") await page.addInitScript(() => { Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true }); });
  }
  const runtime = createCoreServiceRuntime(), calls: string[] = [], steers: string[] = [];
  let rejectQueuedSteer = false;
  let release: (() => void) | undefined, captured: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0] | undefined;
  try {
    for (const [id, engine] of [["alpha", "codex"], ["claude", "claude"], ["kimi", "kimi"], ["agy", "antigravity"]] as const) {
      const secret = randomBytes(32).toString("base64url"), stateDir = path.join(root, id); await mkdir(stateDir);
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale: "zh", steerEnabled: true }));
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, engine, hashSecret(secret)]);
      gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: id, engine, runtime: id === "alpha" ? runtime : createCoreServiceRuntime(),
        bridge: { supportsSteering: () => id === "alpha", steerActiveTurn: async (input) => {
          expect(input.isCurrentTurn?.()).toBe(true);
          if (rejectQueuedSteer) throw new EngineSteeringRejectedError("queued");
          steers.push(input.text);
          await captured?.onEngineEvent?.({ type: "assistant_text", text: "正在按补充要求调整", delta: true }); return true;
        }, handleAuthorizedMessage: async (input) => {
          calls.push(input.text);
          if (input.text.includes("先做调研")) {
            captured = input; await input.onEngineEvent?.({ type: "assistant_text", text: "正在调研", delta: true });
            await new Promise<void>((resolve) => { release = resolve; input.abortSignal?.addEventListener("abort", resolve, { once: true }); });
            return { text: "调研已完成" };
          }
          return { text: "排队任务完成" };
        } } }));
    }
    const chat = await hub.store.createConversation("owner", ["alpha"], "引导与排队", "direct");
    for (const id of ["claude", "kimi", "agy"]) await hub.store.createConversation("owner", [id], `${id} 能力检查`, `capability_${id}`);
    for (const page of [desktop, phone]) { await pair(page, hub); await select(page, chat.title); }
    const text = (page: Page) => page.getByRole("textbox", { name: "消息", exact: true });
    const send = (page: Page) => page.getByRole("button", { name: "发送消息", exact: true }).click();
    const steer = async (page: Page) => {
      const button = page.getByRole("button", { name: "引导当前任务", exact: true });
      if (!await button.isVisible()) await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await button.click();
    };
    await text(desktop).fill("先做调研"); await send(desktop);
    await expect(phone.getByText("正在调研", { exact: true })).toBeVisible();
    await expect(phone.getByRole("button", { name: "发送消息", exact: true })).toHaveCount(0);
    await expect(phone.getByRole("button", { name: "停止当前轮次", exact: true })).toBeVisible();
    await text(desktop).fill("调研完再做另一项"); await send(desktop);
    await expect.poll(async () => (await hub.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=? AND d.status='pending' AND d.dispatched=0", [chat.id]))?.count).toBe(1);
    expect(steers).toEqual([]); expect(calls).toHaveLength(1);
    let controlBody = "", authorization = "";
    phone.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/steer")) { controlBody = request.postData()!; authorization = request.headers().authorization!; } });
    await phone.setViewportSize({width:320,height:400});
    await text(phone).fill("把范围缩小到移动端");
    await expect(phone.getByRole("button", { name: "发送消息", exact: true })).toHaveAttribute("title", "发送消息，任务执行中会排队");
    await expect(phone.getByRole("button",{name:"发送消息",exact:true})).toBeInViewport();
    await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await expect(phone.getByRole("button",{name:"引导当前任务",exact:true})).toBeInViewport();
    await steer(phone);
    await phone.setViewportSize({width:390,height:844});
    for (const page of [desktop, phone]) await expect(page.getByText("CLI 已接收引导", { exact: true })).toBeVisible();
    expect(steers).toEqual(["把范围缩小到移动端"]); expect(calls).toHaveLength(1);
    await expect(text(phone)).toHaveValue("");
    const repeated = await fetch(`${hub.url}/api/conversations/${chat.id}/steer`, { method: "POST", headers: { authorization }, body: controlBody });
    expect(repeated.status).toBe(200); expect(steers).toHaveLength(1);
    const conflict = await fetch(`${hub.url}/api/conversations/${chat.id}/steer`, { method: "POST", headers: { authorization }, body: JSON.stringify({ ...JSON.parse(controlBody), text: "替换内容" }) });
    expect(conflict.status).toBe(409);
    rejectQueuedSteer = true;
    await text(phone).fill("排队中的补充不能送给别的任务"); await steer(phone);
    for (const page of [desktop, phone]) await expect(page.locator(".steering-receipt.rejected")).toContainText("这条消息仍在排队");
    await expect(text(phone)).toHaveValue("排队中的补充不能送给别的任务");
    expect(steers).toHaveLength(1); expect(calls).toHaveLength(1);
    rejectQueuedSteer = false; await text(phone).fill("");
    // Quotes/attachments must not be silently dropped by a text-only steer.
    await desktop.locator('input[type="file"][multiple]').setInputFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.from("context") });
    await text(desktop).fill("附上背景"); await steer(desktop);
    await expect(desktop.getByRole("alert")).toContainText("引导目前只接收纯文字");
    await expect(text(desktop)).toHaveValue("附上背景"); expect(steers).toHaveLength(1);
    for (const [page, device] of [[desktop, "desktop"], [phone, "phone"]] as const) await page.screenshot({ path: info.outputPath(`steering-${device}.png`), animations: "disabled" });
    release?.(); await expect.poll(() => calls.length).toBe(2);
    await expect(phone.locator("[data-message-id]").getByText("排队任务完成", { exact: true })).toBeVisible();
    await text(phone).fill("任务结束后的补充"); await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    // Status polls every 5s; allow the final host cleanup and network round trip
    // instead of racing a 5s assertion against that exact polling boundary.
    await expect.poll(() => runtime.activeRuns.size).toBe(0);
    await expect(phone.getByRole("button", { name: "引导当前任务", exact: true })).toHaveCount(0, { timeout: 8000 });
    await phone.getByRole("button", { name: "关闭聊天操作", exact: true }).click();
    await expect(text(phone)).toHaveValue("任务结束后的补充");
    for (const id of ["claude", "kimi", "agy"]) {
      await select(phone, `${id} 能力检查`); await text(phone).fill("保留这条草稿"); await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await expect(phone.getByRole("button", { name: "引导当前任务", exact: true })).toHaveCount(0);
      await phone.getByRole("button", { name: "关闭聊天操作", exact: true }).click();
      await expect(text(phone)).toHaveValue("保留这条草稿");
    }
    for (const page of [desktop, phone]) {
      await page.reload(); await expect((page.viewportSize()?.width ?? 1360) <=760 ? mobileHome(page) : page.locator(".connection-pill.online")).toBeVisible(); await select(page, chat.title);
      await expect(page.getByText("CLI 已接收引导", { exact: true })).toBeVisible();
      await expect(page.locator(".steering-receipt.rejected")).toContainText("这条消息仍在排队");
    }
    expect(calls).toHaveLength(2); expect(steers).toHaveLength(1); expect(errors).toEqual([]);
  } finally {
    release?.(); await desktopContext.close().catch(() => {}); await phoneContext.close().catch(() => {});
    for (const gateway of gateways) await gateway.disconnect();
    await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
