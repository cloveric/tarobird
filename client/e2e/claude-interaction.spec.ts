import { preparePairing } from "./fixtures/pairing-invite.js";
import { HubPromptQueue } from "../../src/hub/prompt-queue.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { EngineSteeringRejectedError } from "../../src/codex/adapter.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { CoreBridgeLike } from "../../src/core/types.js";
import type { EngineTask } from "../../src/client-protocol/engine-tasks.js";
import { enterMobileChat, mobileHome } from "./fixtures/mobile.js";

async function pair(page: Page, hub: HubServer, phone: boolean) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(phone ? mobileHome(page) : page.locator(".connection-pill.online")).toBeVisible();
}

for (const phone of [false, true]) test(`${phone ? "phone" : "desktop"}: native input updates the active turn; queue and per-task stop stay independent`, async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-interaction-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Claude',?,'claude')", [hashSecret(secret)]);
  const runtime = createCoreServiceRuntime(), calls: string[] = [], steers: string[] = [], stopped: string[] = [];
  const tasks: EngineTask[] = ["alpha", "beta"].map(id => ({ id, label: `子代理 ${id}`, kind: "subagent", mode: "background", status: "running", canStop: true, updatedAt: Date.now() }));
  let failure: "stale" | "uncertain" | undefined;
  let gateway: GatewayChannel | undefined, activeInput: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0] | undefined;
  try {
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "claude", runtime,
      bridge: {
        supportsSteering: () => true, inFlightSendBehavior: () => "steer",
        listTasks: async () => ({ supported: true, tasks: structuredClone(tasks) }),
        stopTask: async ({ taskId }) => { stopped.push(taskId); const task = tasks.find(task => task.id === taskId); if (task) task.status = "stopped"; return { outcome: "accepted" }; },
        steerActiveTurn: async input => { expect(input.isCurrentTurn?.()).toBe(true); if (failure) { const reason = failure; failure = undefined; throw reason === "stale" ? new EngineSteeringRejectedError("stale") : new Error("lost receipt"); } steers.push(input.text); input.onOutcome?.({ status: "applied", via: "fold" }); return true; },
        handleAuthorizedMessage: async input => {
          calls.push(input.text);
          if (input.text === "开始长期任务") {
            activeInput = input; await input.onEngineEvent?.({ type: "assistant_text", text: "主代理正在检查，后台子代理继续运行。", delta: true });
            await new Promise<void>(resolve => input.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
            return { text: "当前回复已停止" };
          }
          return { text: "下一轮处理完成" };
        },
      } });
    const chat = await hub.store.createConversation("owner", ["bot"], "Claude 交互验证", "direct");
    await pair(page, hub, phone);
    if (phone) await enterMobileChat(page, chat.title); else await page.locator(".conversation-row").filter({ hasText: chat.title }).click();
    const composer = page.getByRole("textbox", { name: "消息", exact: true }), send = page.getByRole("button", { name: "发送消息", exact: true });
    await composer.fill("开始长期任务"); await send.click();
    await expect(page.getByText("主代理正在检查，后台子代理继续运行。", { exact: true })).toBeVisible();
    await composer.fill("请先检查键盘");
    await expect(send).toHaveAttribute("title", "补充当前任务，不停止子代理");
    await send.click(); await expect(composer).toHaveValue("");
    expect(calls).toEqual(["开始长期任务"]); expect(steers).toEqual(["请先检查键盘"]);
    expect(activeInput?.abortSignal?.aborted).toBe(false);
    await expect(page.getByText("补充已进入模型上下文", { exact: true })).toBeVisible();
    await expect.poll(async () => JSON.parse(await readFile(path.join(stateDir, "gateway-outbox.json"), "utf8")).requests.length).toBe(0);
    failure = "stale";
    await composer.fill("任务刚结束时的普通消息"); await send.click(); await expect(composer).toHaveValue("");
    expect(calls).toHaveLength(1); expect(steers).toHaveLength(1);
    const rejected = page.locator("details.steering-rejected-input");
    await expect(rejected).toHaveCount(1); await expect(rejected).not.toHaveAttribute("open", "");
    await rejected.getByText("未投递的补充", { exact: true }).click(); await expect(rejected).toContainText("任务刚结束时的普通消息");
    await rejected.getByText("未投递的补充", { exact: true }).click();
    await composer.fill("完成后另做总结");
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await page.getByRole("button", { name: "作为下一轮发送", exact: true }).click();
    await expect(composer).toHaveValue(""); expect(calls).toHaveLength(1); expect(steers).toHaveLength(1);
    await composer.fill("稍后取消的独立消息");
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await page.getByRole("button", { name: "作为下一轮发送", exact: true }).click();
    await expect(composer).toHaveValue("");
    await page.getByRole("button", { name: "管理待执行消息，共 3 条", exact: true }).click();
    const queuePanel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    await queuePanel.getByRole("button", { name: "编辑第 1 条消息", exact: true }).click();
    await queuePanel.getByRole("textbox", { name: "编辑待执行消息", exact: true }).fill("编辑后的待执行任务");
    await queuePanel.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(queuePanel.getByRole("status")).toContainText("待执行消息已更新");
    await queuePanel.getByRole("button", { name: "上移第 2 条消息", exact: true }).click();
    await expect(queuePanel.locator(".prompt-queue-text").first()).toContainText("完成后另做总结");
    await queuePanel.getByRole("button", { name: "取消第 3 条待执行消息", exact: true }).click();
    await queuePanel.getByRole("button", { name: "确认取消排队", exact: true }).click();
    await expect(queuePanel.getByRole("status")).toContainText("已取消这条待执行消息");
    await queuePanel.getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    const queue = new HubPromptQueue(hub.store), before = await queue.read("owner", "bot", chat.id);
    expect(before.items.filter(item => item.state === "queued").map(item => blocksText(item.message.blocks))).toEqual(["完成后另做总结", "编辑后的待执行任务"]);
    await composer.fill("只补充当前任务，保留待执行顺序"); await send.click(); await expect(composer).toHaveValue("");
    expect(steers).toEqual(["请先检查键盘", "只补充当前任务，保留待执行顺序"]);
    expect((await queue.read("owner", "bot", chat.id)).revision).toBe(before.revision);
    failure = "uncertain";
    await composer.fill("不能重复发送的补充"); await send.click();
    await expect(page.locator(".error-banner")).toContainText("发送结果待确认");
    await expect(composer).toHaveValue("不能重复发送的补充");
    expect(calls).toHaveLength(1); expect(steers).toHaveLength(2);
    expect((await queue.read("owner", "bot", chat.id)).revision).toBe(before.revision);
    await composer.fill("");
    await page.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "子代理与后台任务", exact: true });
    await dialog.getByRole("article", { name: "子代理 alpha", exact: true }).getByRole("button", { name: "停止此任务", exact: true }).click();
    await expect(dialog.getByRole("article", { name: "子代理 alpha", exact: true })).toContainText("已停止");
    await expect(dialog.getByRole("article", { name: "子代理 beta", exact: true })).toContainText("执行中");
    expect((await queue.read("owner", "bot", chat.id)).revision).toBe(before.revision);
    expect(stopped).toEqual(["alpha"]); expect(activeInput?.abortSignal?.aborted).toBe(false);
    await page.screenshot({ path: info.outputPath("task-control.png") });
    await dialog.getByRole("button", { name: "关闭任务列表", exact: true }).click();
    await page.getByRole("button", { name: "停止当前轮次", exact: true }).click();
    await expect.poll(() => calls.length).toBe(3);
    expect(calls.slice(1)).toEqual(["完成后另做总结", "编辑后的待执行任务"]); expect(tasks.find(task => task.id === "beta")?.status).toBe("running");
    await expect(page.getByRole("main").getByText("下一轮处理完成", { exact: true }).last()).toBeVisible();
    await composer.fill("/tasks"); await send.click(); await expect(dialog).toBeVisible();
    expect(calls).toHaveLength(3); expect(steers).toHaveLength(2);
  } finally { await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
