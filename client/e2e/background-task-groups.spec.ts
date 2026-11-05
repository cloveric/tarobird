import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { EngineStreamEvent, ScopedEngineEvent } from "../../src/codex/adapter.js";
import { enterMobileChat, mobileHome } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
for (const width of [390, 1360]) for (const theme of ["light", "dark"] as const) test(`merged background tasks ${width}px ${theme}: rows, receipt, dock and recovery`, async ({ page }, info) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.emulateMedia({ colorScheme: theme });
  const root = await mkdtemp(path.join(os.tmpdir(), "background-groups-app-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','CC1',?,'claude')", [hashSecret(secret)]);
  let gateway: GatewayChannel | undefined;
  const emitters: Array<(event: EngineStreamEvent) => void | Promise<void>> = [];
  const names = ["抓取帖子与回帖", "下载 GitHub 视频", "读取上一期项目", "核对字幕", "检查配音", "整理交付清单"];
  const event = (round: number, i: number, inner: ScopedEngineEvent): EngineStreamEvent => ({ type: "scoped", origin: "bound", detached: true, scope: { id: `round_${round}_task_${i}`, kind: "subagent", label: names[i] }, event: inner });
  try {
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async input => {
        const round = emitters.length; emitters.push(input.onEngineEvent!);
        await input.onEngineEvent?.({ type: "assistant_text", text: "我安排了后台子代理分别处理素材，完成后给你汇总。", delta: true });
        for (let i = 0; i < (round ? 6 : 3); i++) await input.onEngineEvent?.(event(round, i, { type: "tool_use", toolUseId: `read_${i}`, toolName: "Read", toolInput: { file_path: `素材_${i}.md` } }));
        await input.onEngineEvent?.(event(round, 2, { type: "tool_result", toolUseId: "read_2", output: "项目记录已核对", exitCode: 0 }));
        await input.onEngineEvent?.(event(round, 2, { type: "scope_status", status: "done" }));
        return { text: "后台任务已安排，汇总回复会单独保留。" };
      },
    } });
    const chat = await hub.store.createConversation("owner", ["bot"], "素材整理", "direct");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    if (width === 390) { await expect(mobileHome(page)).toBeVisible(); await enterMobileChat(page, chat.title); }
    else { await expect(page.locator(".connection-pill.online")).toBeVisible(); await page.locator(".conversation-row").filter({ hasText: chat.title }).click(); }
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("把帖子、回帖和 GitHub 视频整理成素材。"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const card = page.locator(".background-task-group").first(), rows = card.locator(".background-task-row:visible");
    await expect(rows).toHaveCount(3); await expect(card).toContainText("2 运行中"); await expect(card).toContainText("1 完成");
    await expect(card).not.toContainText("正在继续处理"); await expect(card.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
    await card.scrollIntoViewIfNeeded(); await expect(page.locator(".background-task-dock")).toHaveCount(0);
    expect((await card.boundingBox())!.height).toBeLessThan(185);
    await page.screenshot({ path: info.outputPath(`${width}-${theme}-running.png`) });
    await rows.nth(1).click(); await expect(page.getByRole("dialog", { name: "运行过程", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("素材_1.md");
    await page.getByRole("button", { name: "关闭运行过程", exact: true }).click();
    // New ordinary messages move the original card outside the virtual viewport.
    for (let i = 0; i < 12; i++) await gateway.send(chat.id, { text: `素材检查 ${i + 1}：原始记录、来源和时间戳均已保留。\n\n下一步继续核对视频片段与项目说明。` });
    await page.locator(".message-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
    const dock = page.getByRole("button", { name: "定位后台任务组", exact: true });
    await expect(dock).toBeVisible(); await expect(dock).toContainText("2 运行中"); await expect(dock).toContainText("1 完成");
    await page.screenshot({ path: info.outputPath(`${width}-${theme}-dock.png`) });
    await dock.click(); await expect(card).toBeInViewport(); await expect(dock).toHaveCount(0);
    // Finish while its process reader is open; folding must not unmount it.
    await rows.first().click();
    for (const i of [0, 1]) { await emitters[0]!(event(0, i, { type: "tool_result", toolUseId: `read_${i}`, output: `完成 ${names[i]}`, exitCode: 0 })); await emitters[0]!(event(0, i, { type: "scope_status", status: "done" })); }
    await expect(page.getByRole("dialog", { name: "运行过程", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭运行过程", exact: true }).click();
    await expect(card).toHaveClass(/is-collapsed/); await expect(card).toContainText("3 个后台任务已完成"); await expect(rows).toHaveCount(0); await expect(dock).toHaveCount(0);
    await card.getByRole("button", { name: /3 个后台任务已完成/ }).click(); await expect(rows).toHaveCount(3);
    const originalIds = (await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.blocks.some(b => b.type === "card" && b.extra?.backgroundTaskGroup)).map(m => m.id);
    expect(originalIds).toHaveLength(3);
    await page.reload(); if (width === 390) { await expect(mobileHome(page)).toBeVisible(); await enterMobileChat(page, chat.title); }
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
    // Reload reconstructs the receipt, with source records still separately present.
    await expect(page.getByText("素材检查 12：原始记录、来源和时间戳均已保留。", { exact: false }).first()).toBeVisible();
    // After reload the list re-pins to the latest message while rows measure.
    // A wheel inside that settle window can be overridden; scroll once it is stable.
    await expect.poll(() => page.locator(".message-scroll").evaluate(n => new Promise<boolean>(resolve => { const top = n.scrollTop; requestAnimationFrame(() => requestAnimationFrame(() => resolve(n.scrollTop === top && n.scrollTop + n.clientHeight >= n.scrollHeight - 2))); }))).toBe(true);
    await page.locator(".message-scroll").hover(); await page.mouse.wheel(0, -10000); await expect(card).toContainText("3 个后台任务已完成");
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(m => originalIds.includes(m.id))).toHaveLength(3);
    await expect(card).toHaveClass(/is-collapsed/);
    await page.screenshot({ path: info.outputPath(`${width}-${theme}-complete.png`) });
    await composer.fill("继续下一轮核对。"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => emitters.length).toBe(2);
    await expect.poll(async () => (await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.blocks.some(b => b.type === "card" && b.extra?.backgroundTaskGroup)).length).toBe(9);
    await page.getByRole("button", { name: "回到最新消息", exact: true }).click();
    const latest = page.locator(".background-task-group").last(); await expect(latest).toContainText("后台任务 6");
    await expect(latest.locator(".background-task-row:visible")).toHaveCount(5); await latest.getByRole("button", { name: "还有 1 个", exact: true }).click(); await expect(latest.locator(".background-task-row:visible")).toHaveCount(6);
    for (const i of [0, 1, 3, 4, 5]) await emitters[1]!(event(1, i, { type: "scope_status", status: i === 0 ? "error" : i === 1 ? "stopped" : "done" }));
    await expect(latest).toHaveClass(/is-collapsed/); await expect(latest).toContainText("4 完成"); await expect(latest).toContainText("1 失败"); await expect(latest).toContainText("1 中断");
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.blocks.some(b => b.type === "card" && b.extra?.backgroundTaskGroup))).toHaveLength(9);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
