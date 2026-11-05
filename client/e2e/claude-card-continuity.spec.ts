import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { CoreBridgeLike } from "../../src/core/types.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { waitForClientOnline, enterMobileChat } from "./fixtures/mobile.js";
import { withChannelProfile } from "../../src/gateway/platform-profile.js";

for (const phone of [false, true]) test(`Claude ${phone ? "phone" : "desktop"}: submitted answers show background follow-up in the same card`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "answer-feedback-ui-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage(), inputs: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0][] = [];
  let gateway: GatewayChannel | undefined;
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 助手',?,'claude')", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "提交答案反馈", "create");
    const runtime = createCoreServiceRuntime();
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "claude", runtime, bridge: {
      handleAuthorizedMessage: async input => { inputs.push(input); return { text: "后台正在核对报告。" }; },
    } });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await enterMobileChat(page, chat.title);
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("核对报告"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => inputs.length === 1 && !runtime.chatQueue.isBusy(`lark:${chat.id}`)).toBe(true);
    const answer = withChannelProfile("feishu", () => inputs[0].onApprovalRequest!({ engine: "claude", toolName: "AskUserQuestion", supportsAnswerProgress: true,
      toolInput: { questions: [{ header: "使用版本", question: "使用哪个版本的报告？", options: [{ label: "当前版本" }, { label: "上个版本" }] }] } }));
    await page.getByRole("radio", { name: "当前版本", exact: true }).check();
    await page.getByRole("button", { name: "提交", exact: true }).click();
    const decision = await answer;
    if (decision.behavior !== "allow" || !decision.onAnswerProgress) throw new Error("missing feedback observer");
    const receipt = page.locator(".rich-card").filter({ hasText: "已提交" });
    await expect(receipt).toContainText("答案已收到，无需重复提交。后续进展会显示在对话中。");
    await expect(receipt).toContainText("当前版本");
    await expect(page.getByRole("button", { name: "提交", exact: true })).toHaveCount(0);
    const id = await receipt.locator("xpath=ancestor::*[@data-message-id][1]").getAttribute("data-message-id");
    decision.onAnswerProgress({ phase: "sent" });
    decision.onAnswerProgress({ phase: "working", toolName: "Read" });
    await expect(receipt).toContainText("后续进展：Claude 正在读取文件。");
    await composer.fill("保留我的草稿");
    await page.screenshot({ path: info.outputPath("answer-feedback.png") });
    decision.onAnswerProgress({ phase: "finished" });
    decision.onAnswerProgress({ phase: "working", toolName: "Bash" });
    await expect(receipt).toContainText("Claude 已生成后续回复，请查看对话中的结果。");
    await expect(receipt.locator("xpath=ancestor::*[@data-message-id][1]")).toHaveAttribute("data-message-id", id!);
    await expect(receipt).toHaveCount(1); await expect(composer).toHaveValue("保留我的草稿");
    expect(inputs).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 390 : 1360);
  } finally { await gateway?.disconnect(); await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const phone of [false, true]) test(`Claude ${phone ? "phone" : "desktop"}: child prose and background reports remain linked to their request`, async ({ browser }, info) => {
  test.setTimeout(90000);
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-card-ui-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const inputs: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0][] = [], finish: Array<() => void> = [];
  let gateway: GatewayChannel | undefined;
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 助手',?,'claude')", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "Claude 对话衔接", "create");
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async input => { const index = inputs.push(input) - 1; await new Promise<void>(resolve => { finish[index] = resolve; input.abortSignal?.addEventListener("abort", () => resolve(), { once: true }); }); return { text: index ? "新的问题已回答。" : "报告核对已启动，后台结果会随后返回。" }; },
    } });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await enterMobileChat(page, chat.title);
    if (phone) await page.evaluate(() => { document.documentElement.style.setProperty("--safe-area-inset-top", "30px"); document.documentElement.style.setProperty("--safe-area-inset-bottom", "18px"); });
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("核对报告，完成后告诉我"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => inputs.length).toBe(1);
    const emit = async (i: number, event: Parameters<NonNullable<typeof inputs[number]["onEngineEvent"]>>[0]) => { await inputs[i].onEngineEvent?.(event); };
    await emit(0, { type: "tool_use", toolName: "Agent", toolUseId: "child", toolInput: { description: "核对报告", prompt: "private assignment" } });
    await emit(0, { type: "tool_progress", toolUseId: "child", delta: false, text: "第一段：已核对结构。" });
    await emit(0, { type: "tool_progress", toolUseId: "child", delta: false, text: "第二段：正在检查代码。\n\n~~~ts\nconst checked = true;\n~~~" });
    await expect(page.locator(".native-run-status")).toContainText("子代理 · 核对报告");
    await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
    await page.locator(".run-step summary").first().click();
    await expect(page.locator(".run-child-progress p")).toHaveCount(2);
    await expect(page.locator(".run-child-progress .hljs-keyword").first()).toBeVisible();
    if (phone) expect((await page.getByRole("dialog", { name: "运行过程", exact: true }).locator("header").boundingBox())!.y).toBeGreaterThanOrEqual(30);
    await page.screenshot({ path: info.outputPath("child-prose.png") });
    await page.getByRole("button", { name: "关闭运行过程", exact: true }).click();
    await emit(0, { type: "tool_result", toolUseId: "child", output: "核对已交回主代理。" });
    await emit(0, { type: "background_task_started", taskId: "report", description: "生成报告" });
    finish[0](); await expect(page.locator(".native-run-status")).toContainText("本轮已回复");
    await composer.fill("先回答我另一个问题"); await page.getByRole("button", { name: "发送消息", exact: true }).click(); await expect.poll(() => inputs.length).toBe(2);
    await emit(1, { type: "assistant_text", text: "正在核对新问题。" });
    await emit(0, { type: "task_notification", origin: "bound", status: "completed", taskId: "report", text: "## 报告核对结果\n\n原请求中的报告已完成。\n\n~~~ts\nconst verified = true;\n~~~" });
    const report = page.locator(".background-report").filter({ hasText: "报告核对结果" });
    await expect(report.getByRole("button", { name: "查看关联请求", exact: true })).toBeVisible();
    await expect(report.getByRole("button", { name: "查看关联请求", exact: true })).toHaveText("核对报告，完成后告诉我");
    await report.getByRole("button", { name: "查看完整回复", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "后台任务结果", exact: true }).locator(".hljs-keyword").first()).toBeVisible();
    await page.getByRole("button", { name: "关闭完整回复", exact: true }).click();
    await composer.fill("尚未发送的草稿");
    await emit(1, { type: "task_notification", origin: "unattributed", text: "恢复会话时收到的任务回报。" });
    const recovered = page.locator(".background-report").filter({ hasText: "恢复会话时收到的任务回报。" });
    await expect(recovered).toContainText("后台任务更新");
    await expect(recovered).toContainText("来源待确认 · 不是当前提问的回答");
    await expect(recovered.getByRole("button", { name: "查看关联请求", exact: true })).toHaveCount(0);
    await expect(composer).toHaveValue("尚未发送的草稿");
    await expect(page.locator(".native-run-status").last()).toContainText("正在输出文字");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 390 : 1360);
    await page.screenshot({ path: info.outputPath("background-report.png") });
    await report.getByRole("button", { name: "查看关联请求", exact: true }).click();
    await expect(page.locator(".focused-message")).toContainText("核对报告，完成后告诉我");
    await expect(page.locator(".focused-message")).not.toContainText("先回答我另一个问题");
    expect(errors).toEqual([]);
  } finally { for (const resolve of finish) resolve?.(); await gateway?.disconnect(); await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
