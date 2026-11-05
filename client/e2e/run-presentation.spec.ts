import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
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
import { nativeRun } from "../../src/client-protocol/run.js";
import { waitForClientOnline, enterMobileChat } from "./fixtures/mobile.js";
import { expectOneDisclosure } from "./fixtures/disclosure-assertions.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}
const engines = {
  codex: { read: "commandExecution", readInput: { commandActions: [{ type: "read", path: "/workspace/report.md" }] }, command: "commandExecution", edit: "file_change", editInput: { filename: "/workspace/report.md" }, search: "web_search", searchInput: { query: "可靠来源" } },
  claude: { read: "Read", readInput: { file_path: "/workspace/report.md" }, command: "Bash", edit: "Edit", editInput: { file_path: "/workspace/report.md", old_string: "before", new_string: "after" }, search: "WebSearch", searchInput: { query: "可靠来源" } },
  antigravity: { read: "view_file", readInput: { AbsolutePath: "/workspace/report.md" }, command: "run_command", edit: "replace_file_content", editInput: { TargetFile: "/workspace/report.md", TargetContent: "before", ReplacementContent: "after" }, search: "search_web", searchInput: { Query: "可靠来源" } },
  kimi: { read: "ReadFile", readInput: { path: "/workspace/report.md" }, command: "Shell", edit: "StrReplaceFile", editInput: { path: "/workspace/report.md" }, search: "SearchWeb", searchInput: { query: "可靠来源" } },
  deepseek: { read: "read", readInput: { file_path: "/workspace/report.md" }, command: "bash", edit: "str_replace_editor", editInput: { command: "str_replace", path: "/workspace/report.md", old_str: "before", new_str: "after" }, search: "mcp__cctb_search__web_search", searchInput: { query: "可靠来源" } },
} as const;

for (const width of [390, 1360]) test(`live foreground thinking preview updates and retires at ${width}px`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "thinking-preview-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  let gateway: GatewayChannel | undefined, finish: (() => void) | undefined;
  let input: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0] | undefined;
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 摘要验收',?,'claude')", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "公开摘要展示", "direct");
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async value => { input = value; await new Promise<void>(resolve => { finish = resolve; value.abortSignal?.addEventListener("abort", resolve, { once: true }); }); return { text: "核对完成。" }; },
    } });
    await page.setViewportSize({ width, height: 844 }); await pair(page, hub); await enterMobileChat(page, chat.title);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("核对归档文件");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => !!input).toBe(true);
    const emit = async (event: Parameters<NonNullable<NonNullable<typeof input>["onEngineEvent"]>>[0]) => { await input!.onEngineEvent?.(event); };
    const preview = page.locator(".run-thinking-preview");
    await expect(preview).toHaveCount(0);
    await emit({ type: "thinking", text: "先检查归档位置。", delta: false });
    await expect(preview).toContainText("先检查归档位置。");
    await emit({ type: "thinking", text: "已找到归档记录，接下来核对文件对应关系。", delta: true });
    await expect(preview).toContainText("先检查归档位置。已找到归档记录，接下来核对文件对应关系。");
    await emit({ type: "tool_use", toolName: "Read", toolUseId: "read", toolInput: { file_path: "/workspace/trace-index.json" } });
    await expect(page.locator(".native-run-status")).toContainText("读取文件 · trace-index.json");
    await expect(preview).toContainText("已找到归档记录");
    await expect(page.locator(".native-run-prose")).toHaveText("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`thinking-${width}.png`), animations: "disabled" });
    await page.reload(); await waitForClientOnline(page); await enterMobileChat(page, chat.title);
    await expect(preview).toContainText("已找到归档记录");
    await emit({ type: "thinking", text: "较长公开摘要".repeat(7000), delta: false });
    await emit({ type: "thinking", text: "长摘要之后仍能看到最新进展。", delta: true });
    await expect(preview).toContainText("长摘要之后仍能看到最新进展。");
    await emit({ type: "tool_result", toolUseId: "read", output: "DO_NOT_SHOW_TOOL_OUTPUT" });
    await emit({ type: "thinking", text: "对应关系已确认，准备给出结论。", delta: false });
    await expect(preview).toContainText("对应关系已确认，准备给出结论。");
    await expect(preview).not.toContainText("先检查归档位置");
    await expect(preview).not.toContainText("DO_NOT_SHOW_TOOL_OUTPUT");
    finish!(); await expect(page.locator(".native-run-status")).toContainText("已完成");
    await expect(preview).toHaveCount(0); await expect(page.locator(".native-run-prose")).toContainText("核对完成。");
    await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
    const thoughts = page.locator(".run-step").filter({ hasText: "公开思考摘要" });
    await expect(thoughts).toHaveCount(3);
    for (const thought of await thoughts.all()) await thought.locator("summary").click();
    await expect(thoughts.first()).toContainText("先检查归档位置。已找到归档记录");
    await expect(thoughts.nth(1)).toContainText("长摘要之后仍能看到最新进展。");
    await expect(thoughts.last()).toContainText("对应关系已确认，准备给出结论。");
  } finally { finish?.(); await page.close(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
// Adapter protocol suites separately verify these normalized events originate
// from native CLI payloads. This matrix verifies the complete Hub/App surface.
for (const engine of Object.keys(engines) as Array<keyof typeof engines>)
for (const phone of [false, true]) test(`${engine} ${phone ? "phone" : "desktop"} native run journal, tools, search, export, state and safe layout`, async ({ browser }, info) => {
  test.setTimeout(120000);
  const native = engines[engine], hasThinking = engine !== "antigravity";
  const root = await mkdtemp(path.join(os.tmpdir(), "run-ui-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const observerContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const observer = await observerContext.newPage();
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  // Installing the clock after the app starts resets performance.now() while
  // its history reader retains the old timestamp, delaying subsequent reads.
  await page.clock.install();
  let delayStop = false;
  let gateway: GatewayChannel | undefined, finish!: () => void;
  let input!: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','过程助手',?,?)", [hashSecret(secret), engine]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "过程验收", "direct");
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine, runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async value => { input = value; await new Promise<void>(resolve => { finish = resolve; value.abortSignal?.addEventListener("abort", () => { if (!delayStop) resolve(); }, { once: true }); }); if (value.abortSignal?.aborted) throw new Error("Stopped by user"); return { text: "报告已检查完成。" }; },
    } });
    await pair(page, hub); await enterMobileChat(page, chat.title);
    if (phone) await page.evaluate(() => { document.documentElement.style.setProperty("--safe-area-inset-top", "30px"); document.documentElement.style.setProperty("--safe-area-inset-bottom", "18px"); });
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("检查报告"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => !!input).toBe(true);
    await expect(page.locator(".message.user [data-reply-state=replying]")).toHaveText("回复中");
    const emit = async (event: Parameters<NonNullable<typeof input.onEngineEvent>>[0]) => { await input.onEngineEvent?.(event); };
    {
      const checkpoint = engine === "antigravity";
      const activeTitle = checkpoint ? "正在整理上下文摘要" : "正在压缩上下文";
      const completedTitle = checkpoint ? "整理上下文摘要" : "压缩上下文";
      await emit({ type: "context_compaction", id: "compact-before-turn", status: "started", checkpoint });
      await expect(page.locator(".native-run-status")).toContainText(activeTitle);
      if (!phone) await expect(page.locator(".conversation-row.selected")).toContainText(activeTitle);
      await page.clock.setFixedTime(Date.now() + 102000);
      await expect(page.locator(".run-quiet-note")).toHaveCount(0);
      await expect(page.locator(".native-run-status")).not.toContainText("正在思考");
      await expect(page.locator(".native-run-prose")).toHaveText("");
      await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
      await expect(page.locator(".run-update-time")).toContainText("最后更新：");
      await expect(page.locator(".run-update-relative")).toHaveText("1分钟前");
      await expect(page.locator(".run-update-time time")).toBeVisible();
      await expect(page.locator(".run-update-explanation")).toContainText("部分任务会在完成后返回结果");
      await page.getByRole("button", { name: "关闭运行过程" }).click();
      await page.screenshot({ path: info.outputPath(`${phone ? "phone" : "desktop"}-compaction.png`) });
      await page.clock.setFixedTime(Date.now());
      await emit({ type: "context_compaction", id: "compact-before-turn", status: "completed", checkpoint });
      await expect.poll(async () => {
        const messages = await hub.store.listMessages("owner", chat.id);
        const run = messages.messages.flatMap(message => message.blocks).find(block => block.type === "card" && block.extra?.nativeRun);
        const summary = run?.type === "card" ? nativeRun(run) : undefined;
        return summary?.phase;
      }).toBe("thinking");
      await expect(page.locator(".native-run-status")).toContainText("正在思考");
      await expect(page.locator(".native-run-status")).not.toContainText("已完成");
      await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
      const maintenance = page.locator(".run-step.is-done").filter({ hasText: completedTitle });
      await expect(maintenance).toHaveCount(1);
      await maintenance.locator("summary").click();
      await expect(maintenance).toContainText(checkpoint ? "生成对话摘要，供后续处理使用。" : "整理较早的对话内容，为后续处理腾出上下文空间。");
      await expect(maintenance).not.toContainText("context_compaction");
      await expect(maintenance).not.toContainText("context_checkpoint");
      await page.screenshot({ path: info.outputPath(`${phone ? "phone" : "desktop"}-compaction-detail.png`) });
      await page.getByRole("button", { name: "关闭运行过程", exact: true }).click();
    }
    if (hasThinking) {
      await emit({ type: "thinking", text: "公开摘要".repeat(600) });
      await expect(page.locator(".run-thinking-preview")).toContainText("公开摘要");
      await emit({ type: "thinking", text: "最新进展：已找到归档记录，接下来核对文件对应关系。", delta: true });
      await expect(page.locator(".run-thinking-preview")).toContainText("最新进展：已找到归档记录，接下来核对文件对应关系。");
    } else await expect(page.locator(".run-thinking-preview")).toHaveCount(0);
    await emit({ type: "assistant_text", text: "先检查文件，再核对来源。\n保留这一行。\n\n再确认最终结果。" });
    await emit({ type: "tool_use", toolName: native.read, toolUseId: "read", toolInput: native.readInput });
    await expect(page.locator(".native-run-status")).toContainText("读取文件 · report.md");
    if (hasThinking) await expect(page.locator(".run-thinking-preview")).toContainText("最新进展：");
    await expect(page.locator(".native-run-prose")).toContainText("先检查文件，再核对来源。");
    await expect(page.locator(".native-run-prose")).not.toContainText("正在调用工具");
    await expect(page.locator(".native-run-prose .markdown p")).toHaveCount(2);
    const paragraphs = await page.locator(".native-run-prose .markdown p").evaluateAll(nodes => nodes.map(node => ({ whiteSpace: getComputedStyle(node).whiteSpace, top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom })));
    expect(paragraphs[0].whiteSpace).toBe("pre-line");
    expect(paragraphs[1].top - paragraphs[0].bottom).toBeGreaterThanOrEqual(8);
    if (engine === "claude" && phone) {
      await page.clock.setFixedTime(Date.now() + 517000);
      await expect(page.locator(".native-run-status time")).toHaveText(/8m \d+s/);
      await expect(page.locator(".run-quiet-note")).toHaveCount(0);
      await page.screenshot({ path: info.outputPath("phone-elapsed-and-paragraphs.png") });
      await page.clock.setFixedTime(Date.now() + 90061000);
      await expect(page.locator(".native-run-status time")).toHaveText("1d 1h 1m");
      await page.clock.setFixedTime(Date.now());
      await expect(page.locator(".run-quiet-note")).toHaveCount(0);
    }

    await pair(observer, hub);
    await expect(observer.locator(".native-run-status")).toContainText("读取文件 · report.md");
    await observer.getByRole("button", { name: "查看运行过程", exact: true }).click();
    await expect(observer.locator(".run-step")).toHaveCount((hasThinking ? 3 : 2) + 1);
    await page.screenshot({ path: info.outputPath(`${phone ? "phone" : "desktop"}-running.png`) });
    const inputBox = page.getByRole("textbox", { name: "消息", exact: true }); const before = await inputBox.boundingBox();
    await inputBox.fill("中文输入保持稳定"); const after = await inputBox.boundingBox(); expect(Math.abs(after!.height - before!.height)).toBeLessThan(2);
    await gateway.transport.disconnect();
    await expect(page.locator(".native-run-status")).toContainText("连接中断，当前状态待确认");
    await expect(page.locator(".native-run-status .spin")).toHaveCount(0);
    if (engine === "claude" && phone) {
      const frozen = await page.locator(".native-run-status time").innerText();
      await page.clock.setFixedTime(Date.now() + 90061000);
      await page.waitForTimeout(1200);
      await expect(page.locator(".native-run-status time")).toHaveText(frozen);
      await expect(page.locator(".run-quiet-note")).toHaveCount(0);
      await page.clock.setFixedTime(Date.now());
    }
    await gateway.transport.connect();
    await expect(page.locator(".native-run-status")).toContainText("读取文件 · report.md");
    await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "运行过程", exact: true }); await expect(panel).toBeVisible();
    if (hasThinking) await panel.locator(".run-step").filter({ hasText: "公开思考摘要" }).locator("summary").first().click();
    if (hasThinking) await expect(panel.locator(".run-step").filter({ hasText: "公开思考摘要" }).locator(".run-step-detail")).toContainText("公开摘要".repeat(600));
    await emit({ type: "tool_result", toolUseId: "read", output: "READ_ATTEMPT_FAILED", isError: true });
    await emit({ type: "tool_use", toolName: native.read, toolUseId: "read-retry", toolInput: native.readInput });
    await emit({ type: "tool_result", toolUseId: "read-retry", output: "document content" });
    await emit({ type: "tool_use", toolName: native.command, toolUseId: "cmd", toolInput: { command: "inspect-font report.md", description: "检查字体信息" } });
    await emit({ type: "tool_result", toolUseId: "cmd", ...(engine === "codex" || engine === "kimi" ? { exitCode: 0, durationMs: 1250 } : {}), output: "line\n".repeat(600) + "END_OF_OUTPUT" });
    await emit({ type: "tool_use", toolName: native.edit, toolUseId: "edit", toolInput: native.editInput });
    await emit({ type: "tool_result", toolUseId: "edit", output: "updated", ...(["kimi", "codex", "deepseek"].includes(engine) ? { changes: [{ path: "/workspace/report.md", diff: "- before\n+ after" }] } : {}) });
    await emit({ type: "tool_use", toolName: native.search, toolUseId: "search", toolInput: native.searchInput });
    await emit({ type: "tool_result", toolUseId: "search", output: JSON.stringify({ sources: [{ url: "https://example.com/source", title: "Source" }] }) });
    await expect(panel.locator(".run-step").filter({ hasText: "搜索资料 · 可靠来源" })).toBeVisible();
    for (const summary of await panel.locator(".run-step > details > summary").all()) await expectOneDisclosure(summary);
    if (hasThinking) await expect(panel.locator(".run-step").filter({ hasText: "公开思考摘要" }).locator("details").first()).toHaveAttribute("open", "");
    const command = panel.locator(".run-step").filter({ hasText: "检查字体信息" }); await command.locator("summary").first().click();
    await expect(command).toContainText("END_OF_OUTPUT"); if (engine === "codex" || engine === "kimi") await expect(command).toContainText("退出状态：0"); else await expect(command).not.toContainText("退出状态：");
    const edit = panel.locator(".run-step").filter({ hasText: "修改文件 · report.md" }); await edit.locator("summary").first().click(); await expect(edit.locator(".run-diff")).toContainText("+ after");
    const search = panel.locator(".run-step").filter({ hasText: "搜索资料 · 可靠来源" }); await search.locator("summary").first().click(); await expect(search.getByRole("link")).toHaveAttribute("href", "https://example.com/source");
    if (phone) { const rect = await panel.boundingBox(); expect(rect!.x).toBe(0); expect(rect!.width).toBe(390); expect(rect!.height).toBe(844); const header = await panel.locator("header").boundingBox(); expect(header!.y).toBeGreaterThanOrEqual(30); }
    await panel.getByRole("textbox", { name: "搜索过程记录" }).fill("END_OF_OUTPUT"); await panel.getByRole("button", { name: "搜索", exact: true }).click(); await expect(panel.locator(".run-step")).toHaveCount(1);
    await panel.getByRole("textbox", { name: "搜索过程记录" }).fill(""); await panel.getByRole("button", { name: "搜索", exact: true }).click(); await expect(panel.locator(".run-step")).toHaveCount((hasThinking ? 7 : 6) + 1);
    if (hasThinking) await panel.locator(".run-step").filter({ hasText: "公开思考摘要" }).locator("summary").first().click();
    await page.screenshot({ path: info.outputPath(`${phone ? "phone" : "desktop"}-details.png`) });
    const download = page.waitForEvent("download"); await panel.getByRole("button", { name: "导出过程记录" }).click(); const exported = await download; expect(exported.suggestedFilename()).toMatch(/^run-.*\.json$/); await exported.saveAs(info.outputPath("run.json"));
    await page.getByRole("button", { name: "关闭运行过程" }).click();
    await page.getByRole("button", { name: "查看运行过程", exact: true }).click(); await expect(panel.locator(".run-step").filter({ hasText: "检查字体信息" }).locator("details").first()).toHaveAttribute("open", "");
    await page.getByRole("button", { name: "关闭运行过程" }).click();
    const userMessage = (await hub.store.snapshot("owner", chat.id)).messages.find(m => m.authorType === "user")!;
    await gateway.send(chat.id, { file: { source: Buffer.from("Verified report contents"), fileName: "report.txt" } }, { replyTo: userMessage.id });
    await expect(page.locator(".message.user [data-reply-state=replying]")).toHaveText("回复中");
    finish(); await expect(page.locator(".native-run-status")).toContainText("已完成");
    await expect(page.locator(".run-thinking-preview")).toHaveCount(0);
    await expect(page.locator(".message.user [data-reply-state=done]")).toHaveText("已回复"); await expect(page.locator(".native-run-prose")).toContainText("报告已检查完成。");
    await expect(page.getByRole("button", { name: "查看运行过程", exact: true })).toHaveText("过程 · 5 个动作");
    await expect(inputBox).toHaveValue("中文输入保持稳定");
    await expect(observer.locator(".run-details-meta")).toContainText("已完成");
    await expect(observer.locator(".run-step")).toHaveCount((hasThinking ? 7 : 6) + 1);
    await page.reload(); await waitForClientOnline(page); await enterMobileChat(page, chat.title); await expect(page.locator(".native-run-status")).toContainText("已完成");
    await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
    const failedAttempt = panel.locator(".run-step.is-error");
    await expect(failedAttempt).toHaveCount(1);
    await expect(failedAttempt.locator(".run-step-status")).toHaveText("失败");
    await failedAttempt.locator("summary").first().click();
    await expect(failedAttempt).toContainText("READ_ATTEMPT_FAILED");
    await expect(panel.locator(".run-step.is-done").filter({ hasText: "读取文件 · report.md" })).toHaveCount(1);
    await panel.getByRole("button", { name: "预览 report.txt", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "文件预览", exact: true }).locator("pre")).toHaveText("Verified report contents");
    await page.keyboard.press("Escape"); await page.getByRole("button", { name: "关闭运行过程" }).click();
    delayStop = true; const previous = input;
    await inputBox.fill("测试停止回执"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => input !== previous).toBe(true);
    await emit({ type: "tool_use", toolName: native.command, toolUseId: "slow", toolInput: { description: "执行慢速任务" } });
    const last = page.locator(".native-run").last(); await expect(last).toContainText("执行慢速任务");
    await last.getByRole("button", { name: "停止", exact: true }).click();
    await expect(last).toContainText("等待停止确认"); await expect(last.locator(".native-run-status")).not.toContainText("已停止");
    await expect.poll(() => input.abortSignal?.aborted).toBe(true); finish();
    await expect(last.locator(".native-run-status")).toContainText("已停止");
    await expect(page.locator(".message.user [data-reply-state=stopped]")).toHaveText("已停止");
    expect(errors).toEqual([]);
  } finally { finish?.(); await observerContext.close(); await context.close(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
