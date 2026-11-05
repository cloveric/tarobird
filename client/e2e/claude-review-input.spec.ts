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
import { EngineNativeInputUnsentError } from "../../src/codex/adapter.js";
import type { NativeInputObserver } from "../../src/client-protocol/native-input.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { enterMobileChat, mobileHome } from "./fixtures/mobile.js";

// Isolated fixture: real Hub, Gateway, Core and built App; the Claude engine is
// a scripted bridge. Screenshots record App behavior, not a live Claude run.
test.use({ serviceWorkers: "block" });

async function open(page: Page, hub: HubServer, phone: boolean, title: string) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(phone ? mobileHome(page) : page.locator(".connection-pill.online")).toBeVisible();
  if (phone) await enterMobileChat(page, title); else await page.locator(".conversation-row").filter({ hasText: title }).click();
}
type Turn = { text: string; reviewAdmission?: "native"; nativeInput?: NativeInputObserver; release: (outcome?: "withdrawn") => void };

for (const phone of [false, true]) test(`${phone ? "phone" : "desktop"}: ordinary input during a Claude background review starts a native turn; 排队 waits`, async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "review-input-app-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Claude',?,'claude')", [hashSecret(secret)]);
  let reviewTarget: string | undefined, steered = 0;
  const turns: Turn[] = [];
  let gateway: GatewayChannel | undefined;
  try {
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      supportsSteering: () => true, inFlightSendBehavior: () => "steer", nativeInputCapability: async () => ({ sendNow: true, cancel: true, modelReceipt: true }),
      backgroundInputTarget: async () => reviewTarget,
      steerActiveTurn: async () => { steered++; return true; },
      controlNativeInput: async input => {
        const turn = turns.find(item => item.nativeInput?.id === input.inputId);
        if (!turn || input.action !== "cancel") return { outcome: "rejected", reason: "stale" };
        turn.nativeInput!.onProgress({ state: "cancelled" }); turn.release("withdrawn");
        return { outcome: "accepted", result: "cancelled" };
      },
      handleAuthorizedMessage: async input => {
        let release!: (outcome?: "withdrawn") => void;
        const gate = new Promise<"withdrawn" | undefined>(resolve => { release = resolve; });
        turns.push({ text: input.text, reviewAdmission: input.reviewAdmission, nativeInput: input.nativeInput, release });
        if (input.reviewAdmission === "native") {
          // The prompt sits in Claude's native queue while the review runs.
          await input.onEngineEvent?.({ type: "native_input_wait", status: "started" });
          input.nativeInput!.onProgress({ state: "queued" });
          if (await gate === "withdrawn") throw new EngineNativeInputUnsentError("withdrawn");
          input.nativeInput!.onProgress({ state: "dequeued" });
          await input.onEngineEvent?.({ type: "native_input_wait", status: "finished" });
          input.nativeInput!.onProgress({ state: "received" });
          await input.onEngineEvent?.({ type: "assistant_text", text: "已读取补充：B 也检查完了。", delta: true });
          return { text: "已读取补充：B 也检查完了。" };
        }
        // An explicit next-turn send keeps the adapter's wait for the review.
        await input.onEngineEvent?.({ type: "background_review_wait", status: "started" });
        await gate;
        await input.onEngineEvent?.({ type: "background_review_wait", status: "finished" });
        await input.onEngineEvent?.({ type: "assistant_text", text: "后台处理结束后才开始这一轮。", delta: true });
        return { text: "后台处理结束后才开始这一轮。" };
      },
    } });
    const chat = await hub.store.createConversation("owner", ["bot"], "后台结果补充", "direct");
    const started = Date.now();
    const review = (id: string, text: string) => hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "card", elements: [{ type: "markdown", text }],
      extra: { backgroundTask: { version: 1, origin: "bound" }, scopedRun: { version: 1, id, revision: 1, phase: "working", startedAt: started, updatedAt: Date.now(), count: 1, completed: 0, failed: 0, truncated: false } } }] });
    await open(page, hub, phone, chat.title);
    const composer = page.getByRole("textbox", { name: "消息", exact: true }), send = page.getByRole("button", { name: "发送消息", exact: true });
    const choice = page.locator(".claude-send-choice"), current = choice.getByRole("radio", { name: /^(补充当前|补充)$/ }), next = choice.getByRole("radio", { name: /^(排到下一轮|排队)$/ });
    await expect(choice).toHaveCount(0);
    // Claude starts reviewing a finished background task with no foreground run.
    reviewTarget = "review_fixture_1"; await review("review-1", "后台测试已完成，Claude 正在处理结果…");
    await expect(current).toBeChecked(); await expect(next).toBeVisible();
    await page.screenshot({ path: info.outputPath(`fixture-review-choice-${phone ? "phone390" : "desktop"}.png`) });

    await composer.fill("补充：顺便检查 B"); await send.click(); await expect(composer).toHaveValue("");
    const receipts = page.locator(".native-input-receipt");
    await expect(receipts.first()).toContainText("CLI 已接收 · 待处理");
    expect(turns).toHaveLength(1); expect(turns[0]!.reviewAdmission).toBe("native"); expect(turns[0]!.text).toContain("补充：顺便检查 B"); expect(steered).toBe(0);
    // The new turn's card says it waits for Claude to read the input, not that the model is working.
    await expect(page.getByRole("main").getByText("等待 Claude 读入", { exact: true })).toBeVisible();
    // Withdrawal is available; send-now would cut Claude's review and is not offered.
    await expect(receipts.first().getByRole("button", { name: "撤回编辑", exact: true })).toBeVisible();
    await expect(receipts.first().getByRole("button", { name: "立即发送", exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`fixture-review-supplement-queued-${phone ? "phone390" : "desktop"}.png`) });
    turns[0]!.release();
    await expect(receipts.first()).toContainText("模型已收到");
    await expect(page.getByRole("main").getByText("已读取补充：B 也检查完了。", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`fixture-review-supplement-answered-${phone ? "phone390" : "desktop"}.png`) });

    // A withdrawn supplement restores its text and leaves no reply card.
    // Rendered answer text can precede Core turn teardown. Wait until the App
    // has fetched this new review's target, not the old foreground target.
    const secondReviewReady = page.waitForResponse(async response => response.request().method() === "GET"
      && response.url().includes(`/api/conversations/${chat.id}/steer?`) && response.ok()
      && (await response.json()).targetId === "review_fixture_2");
    reviewTarget = "review_fixture_2"; await review("review-2", "另一项后台测试已完成，Claude 正在处理结果…");
    await secondReviewReady;
    await expect(current).toBeChecked();
    await composer.fill("先别做这个"); await send.click(); await expect(composer).toHaveValue("");
    await expect(receipts.nth(1)).toContainText("CLI 已接收 · 待处理");
    await receipts.nth(1).getByRole("button", { name: "撤回编辑", exact: true }).click();
    await expect(composer).toHaveValue("先别做这个"); await expect(receipts.nth(1)).toContainText("已撤回");
    // The Core retracts the reply card of the unsent turn.
    await expect.poll(async () => {
      const messages = (await hub.store.snapshot("owner", chat.id)).messages;
      const withdrawn = messages.find(message => message.authorType === "user" && blocksText(message.blocks) === "先别做这个");
      return messages.filter(message => message.authorType === "bot" && message.replyTo === withdrawn?.id && message.status !== "deleted").length;
    }).toBe(0);
    await composer.fill("");

    // 排队 keeps the durable route and waits for Claude's review to end.
    await next.check(); await composer.fill("排队：处理完后台结果再总结"); await send.click(); await expect(composer).toHaveValue("");
    await expect.poll(() => turns.length).toBe(3);
    expect(turns[2]!.reviewAdmission).toBeUndefined(); expect(turns[2]!.nativeInput).toBeUndefined();
    await expect(page.getByRole("main").getByText("Claude 正在处理上一项后台结果，本条消息尚未交给模型。", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`fixture-review-queued-waiting-${phone ? "phone390" : "desktop"}.png`) });
    turns[2]!.release();
    await expect(page.getByRole("main").getByText("后台处理结束后才开始这一轮。", { exact: true })).toBeVisible();
    expect(steered).toBe(0);
  } finally {
    for (const turn of turns) turn.release();
    await gateway?.disconnect().catch(() => undefined); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
