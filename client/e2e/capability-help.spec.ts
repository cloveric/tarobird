import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, openWorkspacePage, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
  await waitForClientOnline(page);
}

for (const lostStatus of [503, 408]) for (const phone of [false, true]) test(`capability help preserves existing drafts and retries the same confirmed creation (${phone ? "phone" : "desktop"}, ${lostStatus})`, async ({ page }, info) => {
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-help-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash) VALUES('alpha','研究助手','claude','fixture')");
    const original = await hub.store.createConversation("owner", ["alpha"], "原有研究", "existing");
    await pair(page, hub); await selectConversation(page, original.title);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("保留原来的研究草稿");
    await page.locator("input.attachment-picker-input").setInputFiles({ name: "保留.txt", mimeType: "text/plain", buffer: Buffer.from("original attachment") });
    await page.route("**/api/bots/alpha/capabilities", route => route.fulfill({ json: {
      generatedAt: new Date().toISOString(), engine: "claude", workspace: "/test/workspace", runtime: "unverified", coverage: "partial",
      entries: [{ id: "tool", name: "知识库检索", description: "读取资料", kind: "mcp", source: "workspace/.mcp.json", scope: "workspace", status: "configured", transport: "stdio" }],
      sources: [], warnings: ["runtime_unverified", "partial_catalog"],
    } }));
    await openWorkspacePage(page, "Skills 与 MCP");
    await page.getByRole("button", { name: /^MCP/ }).click();
    const card = page.locator(".capability-card").filter({ hasText: "知识库检索" });
    await expect(card).toBeVisible();
    // The help action is a draft handoff, not an installation or automatic send.
    await card.locator(".capability-summary").click();
    await card.getByRole("button", { name: "让 Bot 检查", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "准备配置消息", exact: true });
    await expect(dialog).toBeVisible();
    const text = page.getByRole("textbox", { name: "配置消息", exact: true });
    await expect(text).toHaveValue(/知识库检索/);
    const prepared = (await text.inputValue()) + "\n这是我确认过的补充要求。";
    await text.fill(prepared);
    let attempts = 0;
    const actionIds: string[] = [];
    await page.route("**/api/conversations", async route => {
      if (route.request().method() !== "POST") return route.continue();
      actionIds.push((route.request().postDataJSON() as { clientActionId: string }).clientActionId);
      const response = await route.fetch(); attempts++;
      // Persist the first creation, then lose its response. Retry must deduplicate.
      await route.fulfill(attempts === 1 ? { status: lostStatus, json: { error: "lost_receipt" } } : { response });
    });
    await page.getByRole("button", { name: "打开配置对话", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("重试会查询同一次创建");
    await expect(text).toHaveValue(prepared);
    await page.getByRole("button", { name: "打开配置对话", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(prepared);
    expect(attempts).toBe(2); expect(new Set(actionIds).size).toBe(1);
    const all = await hub.store.db.all<{ id: string; title: string }>("SELECT id,title FROM conversations ORDER BY created_at");
    expect(all).toHaveLength(2);
    const target = all.find(c => c.id !== original.id)!;
    expect((await hub.store.snapshot("owner", target.id)).messages).toHaveLength(0);
    expect((await hub.store.snapshot("owner", original.id)).messages).toHaveLength(0);
    await expect(page.locator(".attachment-draft")).toHaveCount(0);
    await selectConversation(page, original.title);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留原来的研究草稿");
    await expect(page.locator(".attachment-draft")).toContainText("保留.txt");
    await selectConversation(page, target.title);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, target.title);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(prepared);
    await page.screenshot({ path: info.outputPath(`capability-help-${phone ? "phone" : "desktop"}.png`) });
    expect(errors).toEqual([]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
