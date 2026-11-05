import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { enterMobileChat, waitForClientOnline } from "./fixtures/mobile.js";
import type { CoreBridgeLike } from "../../src/core/types.js";

for (const layout of ["desktop", "phone", "adhd"] as const) for (const cancel of [false, true]) test(`async answer ${layout}: same receipt follows queue, execution and reply (cancel=${cancel})`, async ({ browser }, info) => {
  const phone = layout === "phone";
  const root = await mkdtemp(path.join(os.tmpdir(), "async-answer-ui-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage(), inputs: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0][] = [];
  let finishOther: ((result: { text: string }) => void) | undefined, finishAnswer: ((result: { text: string }) => void) | undefined;
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','验收助手',?,'codex')", [hashSecret(secret)]);
  const chat = await hub.store.createConversation("owner", ["alpha"], "排队补答", "create");
  const runtime = createCoreServiceRuntime();
  const enqueue = runtime.chatQueue.enqueue.bind(runtime.chatQueue);
  runtime.chatQueue.enqueue = (chatId, job, options) => enqueue(chatId, job, { ...options, waitNotifyAfterMs: 0 });
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", runtime, bridge: {
    handleAuthorizedMessage: async input => {
      inputs.push(input);
      if (inputs.length === 1) {
        await input.onEngineEvent?.({ type: "user_input_request", toolName: "request_user_input_async", requestId: "queued-question", toolInput: { questions: [{ title: "需要什么格式？" }] } });
        return { text: "问题已发出。" };
      }
      if (inputs.length === 3) await input.onEngineEvent?.({ type: "tool_use", toolName: "Read", toolUseId: "answer_read", toolInput: { description: "正在核对补充要求" } });
      if (inputs.length > 3) return { text: "后续消息已处理。" };
      return new Promise(resolve => {
        if (inputs.length === 2) finishOther = resolve; else finishAnswer = resolve;
        input.abortSignal?.addEventListener("abort", () => resolve({ text: "已停止" }), { once: true });
      });
    },
  } });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await enterMobileChat(page, chat.title);
    if (layout === "adhd") {
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await page.getByRole("checkbox", { name: /加入面板：.*排队补答$/ }).check();
      await page.getByLabel("ADHD 每行窗口数").selectOption("4");
    }
    const composer = page.locator(".composer textarea"), send = page.locator(".send-button");
    await composer.fill("先问我格式"); await send.click();
    await expect.poll(() => inputs.length === 1 && !runtime.chatQueue.isBusy(`lark:${chat.id}`)).toBe(true);
    await composer.fill("先处理另一个任务"); await send.click();
    await expect.poll(() => !!finishOther).toBe(true);
    await page.locator('textarea[name="q0_other"]').fill("PDF，保留图表");
    await page.getByRole("button", { name: "提交", exact: true }).click();
    const receipt = page.locator(".rich-card").filter({ hasText: "已提交" });
    await expect(receipt).toContainText("答案已排队，等待处理");
    await expect(receipt).toContainText("PDF，保留图表");
    await expect(receipt.getByRole("button", { name: "取消后续处理", exact: true })).toBeVisible();
    const id = await receipt.locator("xpath=ancestor::*[@data-message-id][1]").getAttribute("data-message-id");
    await page.screenshot({ path: info.outputPath("answer-queued.png") });
    finishOther!({ text: "另一个任务已回复。" });
    await expect(receipt).toContainText("正在处理你的补充答案");
    await expect(receipt.getByRole("button", { name: "取消后续处理", exact: true })).toHaveCount(0);
    await expect.poll(() => !!finishAnswer).toBe(true);
    const runId = (await hub.store.snapshot("owner", chat.id)).messages.find(m => m.replyTo === id && m.blocks.some(b => b.type === "card" && b.extra?.nativeRun))!.id;
    const run = page.locator(`[data-message-id="${runId}"] .native-run`);
    await expect(run.locator(".native-run-status")).toContainText("读取文件");
    await expect(run.locator(".run-stop")).toBeEnabled();
    await composer.fill("等补答完成后再处理这条"); await send.click();
    await composer.fill("下一条可调整顺序"); await send.click();
    await page.getByRole("button", { name: "管理待执行消息，共 2 条", exact: true }).click();
    const pending = page.getByRole("dialog", { name: "待执行消息", exact: true });
    await expect(page.locator(".queue-notice")).toHaveCount(0);
    await expect(pending.locator(".is-locked")).toHaveCount(0);
    await expect(pending.locator(".prompt-queue-text")).toHaveText(["等补答完成后再处理这条", "下一条可调整顺序"]);
    await pending.getByRole("button", { name: "编辑第 1 条消息", exact: true }).click();
    await pending.getByRole("textbox", { name: "编辑待执行消息", exact: true }).fill("第一条修改后等待执行");
    await pending.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(pending.getByRole("textbox", { name: "编辑待执行消息", exact: true })).toHaveCount(0);
    await pending.getByRole("button", { name: "下移第 1 条消息", exact: true }).click();
    await expect(pending.locator(".prompt-queue-text")).toHaveText(["下一条可调整顺序", "第一条修改后等待执行"]);
    if (cancel) {
      await pending.getByRole("button", { name: "取消第 2 条待执行消息", exact: true }).click();
      await pending.getByRole("button", { name: "确认取消排队", exact: true }).click();
      await expect(pending.locator(".prompt-queue-text")).toHaveText(["下一条可调整顺序"]);
      expect(inputs.at(-1)?.abortSignal?.aborted).toBe(false);
    }
    expect(await pending.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("unified-pending-queue.png") });
    await pending.getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    await expect(run.locator(".run-stop")).toBeEnabled();
    await composer.fill("保留草稿");
    finishAnswer!({ text: "补答结果：PDF 已安排。" });
    await expect(receipt).toContainText("已生成后续回复");
    await expect(receipt.getByRole("button", { name: "取消后续处理", exact: true })).toHaveCount(0);
    await expect(run.locator(".native-run-status")).toContainText("已完成");
    await expect(run.locator(".run-stop")).toHaveCount(0);
    await expect(page.getByText("补答结果：PDF 已安排。", { exact: true })).toBeVisible();
    await expect(receipt.locator("xpath=ancestor::*[@data-message-id][1]")).toHaveAttribute("data-message-id", id!);
    await expect(receipt).toHaveCount(1); await expect(composer).toHaveValue("保留草稿");
    await expect(page.getByRole("button", { name: "提交", exact: true })).toHaveCount(0);
    await expect.poll(() => inputs.length).toBe(cancel ? 4 : 5);
    expect(inputs.slice(3).map(input => input.text)).toEqual(cancel ? ["下一条可调整顺序"] : ["下一条可调整顺序", "第一条修改后等待执行"]);
    await expect(page.locator(".queue-notice")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /管理待执行消息，共/ })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("answer-finished.png") });
  } finally {
    finishOther?.({ text: "cleanup" }); finishAnswer?.({ text: "cleanup" });
    await gateway.disconnect(); await context.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
