import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { codexSubagentActivity } from "../../src/codex/subagent-activity.js";
import { enterMobileChat, waitForClientOnline } from "./fixtures/mobile.js";
import type { CoreBridgeLike } from "../../src/core/types.js";

for (const layout of ["desktop", "phone", "adhd"] as const) test(`${layout}: Codex child receipts survive long runs, paging, search and export`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-activity-ui-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: layout === "phone" ? { width: 390, height: 844 } : { width: 1360, height: 900 } });
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let input: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0] | undefined;
  let finish: ((result: { text: string }) => void) | undefined;
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','审阅助手',?,'codex')", [hashSecret(secret)]);
  const chat = await hub.store.createConversation("owner", ["alpha"], "审阅过程", "create");
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", runtime: createCoreServiceRuntime(), bridge: {
    handleAuthorizedMessage: value => { input = value; return new Promise(resolve => { finish = resolve; value.abortSignal?.addEventListener("abort", () => resolve({ text: "Stopped" }), { once: true }); }); },
  } });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await enterMobileChat(page, chat.title);
    if (layout === "adhd") {
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await page.getByRole("checkbox", { name: /加入面板：.*审阅过程$/ }).check();
      await page.getByLabel("ADHD 每行窗口数").selectOption("4");
    }
    await page.locator(".composer textarea").fill("请独立审阅"); await page.locator(".send-button").click();
    await expect.poll(() => !!input).toBe(true);
    for (let index = 0; index < 115; index++) {
      await input!.onEngineEvent?.({ type: "tool_use", toolName: "Bash", toolUseId: `command-${index}`, toolInput: { command: `verify-step-${index}` } });
      await input!.onEngineEvent?.({ type: "tool_result", toolUseId: `command-${index}`, output: "passed" });
    }
    for (const kind of ["started", "interacted", "interrupted", "completed"]) {
      const event = codexSubagentActivity({ type: "subAgentActivity", id: `activity-${kind}`, kind, agentThreadId: "child-reviewer", agentPath: "/root/reviewer", model: kind === "started" ? "fixture-model" : null, reasoningEffort: kind === "started" ? "xhigh" : null })!;
      await input!.onEngineEvent?.(event);
    }
    await input!.onEngineEvent?.({ type: "tool_use", toolName: "CodexAgent", toolUseId: "collab-review", toolInput: { action: "wait", receiverThreadIds: ["review-success", "review-error"] } });
    await input!.onEngineEvent?.({ type: "tool_result", toolName: "CodexAgent", toolUseId: "collab-review", output: JSON.stringify({ "review-success": { status: "completed", message: "## 审阅结果\n\n已确认 **一项** 问题。" }, "review-error": { status: "errored", message: "审阅因连接中断而失败。" } }) });
    // Engine callbacks queue journal batches. Wait for the fixture's actual
    // persistence before asking the reader to jump to its latest saved row.
    await expect.poll(async () => (await hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_journal"))?.n).toBe(120);
    const run = page.locator(".native-run");
    await expect(run.locator(".native-run-status")).not.toContainText("已完成");
    await expect(run.locator(".run-stop")).toBeVisible();
    await run.getByRole("button", { name: "查看运行过程", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "运行过程", exact: true });
    await expect(panel.locator(".run-step")).toHaveCount(40);
    await panel.getByRole("button", { name: "跳到最新记录", exact: true }).click();
    await expect(panel).toContainText("子代理已完成 · reviewer");
    const firstSeq = Number(await panel.locator(".run-step").first().getAttribute("data-seq"));
    expect(firstSeq).toBeGreaterThan(40);
    const body = panel.locator(".run-details-body");
    await expect.poll(() => body.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
    await body.evaluate(node => { node.scrollTop = 100; });
    await input!.onEngineEvent?.({ type: "assistant_text", text: "父任务仍在整理审阅结果。" });
    await expect(panel.getByRole("button", { name: "下一页", exact: true })).toBeEnabled();
    await expect(panel.locator(".run-step").first()).toHaveAttribute("data-seq", String(firstSeq));
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(100);
    await panel.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(panel.locator(".run-step").last()).toHaveAttribute("data-seq", String(firstSeq - 1));
    await panel.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(panel.locator(".run-step").first()).toHaveAttribute("data-seq", String(firstSeq));
    await panel.getByRole("button", { name: "跳到最早记录", exact: true }).click();
    await expect(panel.locator(".run-step").first()).toHaveAttribute("data-seq", "1");
    finish!({ text: "审阅修订已经完成。" });
    await expect(run.locator(".native-run-status")).toContainText("已完成");
    await panel.getByRole("textbox", { name: "搜索过程记录" }).fill("child-reviewer");
    await panel.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(panel.locator(".run-step")).toHaveCount(4);
    await expect(panel.locator(".run-step-status")).toHaveText(["已记录", "已记录", "已记录", "已记录"]);
    await panel.locator(".run-step summary").first().click();
    await expect(panel).toContainText("模型 · fixture-model · xhigh");
    await expect(panel.locator(".run-step time")).toHaveCount(0);
    await panel.getByRole("textbox", { name: "搜索过程记录" }).fill("collab-review");
    await panel.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(panel.locator(".run-step")).toHaveCount(1);
    await panel.locator(".run-step summary").first().click();
    await expect(panel).toContainText("等待子代理");
    await expect(panel.locator(".run-agent-report")).toHaveCount(2);
    await expect(panel.locator(".run-agent-report").first()).toContainText("已完成");
    await expect(panel.locator(".run-agent-report").first().locator("strong").last()).toHaveText("一项");
    await expect(panel.locator(".run-agent-report").last()).toContainText("失败");
    await expect(panel.locator(".run-agent-report").last()).toContainText("审阅因连接中断而失败。");
    expect(await panel.locator(".run-agent-report").first().innerText()).not.toContain('"status"');
    await panel.getByText("原始输出", { exact: true }).click();
    await expect(panel.locator(".run-raw").last()).toContainText('"status":"errored"');
    const downloading = page.waitForEvent("download"); await panel.getByRole("button", { name: "导出过程记录", exact: true }).click();
    const download = await downloading, exported = JSON.parse(await readFile((await download.path())!, "utf8"));
    expect(exported.entries.filter((entry: { name?: string }) => entry.name?.startsWith("subagent_"))).toHaveLength(4);
    expect(exported.entries.some((entry: { input?: string }) => entry.input?.includes("verify-step-114"))).toBe(true);
    expect(exported.entries.map((entry: { seq: number }) => entry.seq)).toEqual(Array.from({ length: exported.entries.length }, (_, i) => i + 1));
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`child-activity-${layout}.png`) });
    await panel.getByRole("button", { name: "关闭运行过程", exact: true }).click();
    await expect(page.locator(".composer textarea")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    finish?.({ text: "cleanup" }); await gateway.disconnect(); await context.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
