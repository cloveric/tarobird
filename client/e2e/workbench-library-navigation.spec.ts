import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
test.use({ serviceWorkers: "block" });

for (const phone of [false, true]) test(`settings and workbench entries reopen the owning conversation without losing another draft (phone=${phone})`, async ({ page }, info) => {
  test.setTimeout(150_000);
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-library-navigation-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "测试主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('library_bot','文件管理验收','fixture')");
    const a = await hub.store.createConversation("owner", ["library_bot"], "资料整理 A", "library_a");
    const b = await hub.store.createConversation("owner", ["library_bot"], "方案讨论 B", "library_b");
    const capacityChats: Array<{ id: string; title: string }> = [];
    if (!phone) for (let index = 0; index < 11; index++) capacityChats.push(await hub.store.createConversation("owner", ["library_bot"], `容量验证 ${index}`, `capacity_${index}`));
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page);
    for (const [conversation, filename] of [[a, "Alpha.md"], [b, "Beta.md"]] as const) {
      await selectConversation(page, conversation.title);
      const entry = page.getByRole("button", { name: "工作台", exact: true });
      if (!await panel(page).isVisible()) await entry.click();
      await panel(page).locator('input[accept^=".md"]').setInputFiles({ name: filename, mimeType: "text/markdown", buffer: Buffer.from(`Saved ${filename}`) });
      await expect(panel(page).getByRole("tab", { name: filename, exact: true })).toHaveAttribute("aria-selected", "true");
      await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click();
      await panel(page).getByRole("button", { name: `标签选项：${filename}`, exact: true }).click();
      await panel(page).getByRole("button", { name: "关闭标签", exact: true }).click();
      await panel(page).getByRole("button", { name: "返回聊天", exact: true }).click();
    }
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("Keep this unsent draft in B");
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click();
    await panel(page).getByRole("button", { name: "管理所有工作台文件", exact: true }).click();
    const library = page.locator(".workbench-library");
    await expect(library.getByText("共 2 项", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(phone ? "library-settings-phone.png" : "library-settings-desktop.png") });
    await library.getByRole("button", { name: "打开：Alpha.md", exact: true }).click();
    await expect(panel(page).getByRole("tab", { name: "Alpha.md", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(panel(page).getByRole("textbox", { name: "笔记内容", exact: true })).toHaveValue("Saved Alpha.md");
    // Use the real editor in the built App, not the fixture's manual lock:
    // settings overlays must not allow deleting the still-open writable note.
    await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click();
    await panel(page).getByRole("button", { name: "管理所有工作台文件", exact: true }).click();
    await library.getByLabel("选择：Alpha.md", { exact: true }).check();
    await library.getByRole("button", { name: "删除所选", exact: true }).click();
    await page.getByRole("button", { name: "删除 1 项", exact: true }).click();
    await expect(library.getByText("已清理 0 项，1 项未删除。", { exact: true })).toBeVisible();
    await expect(library.getByText(/正在编辑，请先关闭该标签后重试/)).toBeVisible();
    await closeSettings(page);
    await expect(panel(page).getByRole("textbox", { name: "笔记内容", exact: true })).toHaveValue("Saved Alpha.md");
    await panel(page).getByRole("button", { name: "返回聊天", exact: true }).click();
    await selectConversation(page, b.title); await expect(composer).toHaveValue("Keep this unsent draft in B");
    await openSettings(page);
    if (phone) await page.getByRole("button", { name: "返回设置分类", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^工作台文件/ }).click();
    await library.getByLabel("选择：Beta.md", { exact: true }).check();
    await library.getByRole("button", { name: "删除所选", exact: true }).click(); await page.getByRole("button", { name: "删除 1 项", exact: true }).click();
    await expect(library.getByText("已清理 1 项。", { exact: true })).toBeVisible(); await expect(library.getByText("共 1 项", { exact: true })).toBeVisible();
    await closeSettings(page); await page.reload(); await waitForClientOnline(page); await selectConversation(page, b.title);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("Keep this unsent draft in B");
    await openSettings(page);
    if (phone) await page.getByRole("button", { name: "返回设置分类", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^工作台文件/ }).click();
    await expect(page.locator(".workbench-library").getByText("共 1 项", { exact: true })).toBeVisible();
    await expect(page.getByLabel("选择：Beta.md", { exact: true })).toHaveCount(0);
    expect((await hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE id IN (?, ?)", [a.id, b.id]))?.n).toBe(2);
    if (!phone) {
      await closeSettings(page);
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      const bPane = page.locator(`.adhd-card[data-pane-conversation="${b.id}"]`);
      await page.getByRole("checkbox", { name: /加入面板：.* · 方案讨论 B/ }).check();
      await expect(bPane.locator(".composer textarea")).toHaveValue("Keep this unsent draft in B");
      await openSettings(page);
      await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^工作台文件/ }).click();
      await page.locator(".workbench-library").filter({ visible: true }).getByRole("button", { name: "打开：Alpha.md", exact: true }).click();
      const aPane = page.locator(`.adhd-card[data-pane-conversation="${a.id}"]`);
      await expect(aPane).toHaveClass(/is-expanded/);
      await expect(aPane.getByRole("textbox", { name: "笔记内容", exact: true })).toHaveValue("Saved Alpha.md");
      await expect(bPane.locator(".composer textarea")).toHaveValue("Keep this unsent draft in B");
      await expect(page.locator(".adhd-card")).toHaveCount(2);
      // A full board must consume a refused library navigation, so manually
      // opening the conversation later does not replay the old file request.
      await page.locator(".adhd-toolbar").getByRole("button", { name: "总览", exact: true }).click();
      await aPane.getByRole("button", { name: "移除此面板", exact: true }).click();
      for (const item of capacityChats) await page.getByRole("checkbox", { name: new RegExp(`加入面板：.* · ${item.title}$`) }).check();
      await expect(page.locator(".adhd-card")).toHaveCount(12);
      await openSettings(page);
      await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^工作台文件/ }).click();
      await page.locator(".workbench-library").filter({ visible: true }).getByRole("button", { name: "打开：Alpha.md", exact: true }).click();
      await expect(page.getByText("最多同时打开 12 个对话。请先移除一个面板。", { exact: true })).toBeVisible();
      await page.locator(`.adhd-card[data-pane-conversation="${capacityChats[0]!.id}"]`).getByRole("button", { name: "移除此面板", exact: true }).click();
      await page.getByRole("checkbox", { name: /加入面板：.* · 资料整理 A/ }).check();
      await expect(aPane).toBeVisible(); await expect(aPane).not.toHaveClass(/is-expanded/);
      await expect(aPane.getByRole("complementary", { name: "工作台", exact: true })).toBeHidden();

    }
  } finally { await page.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
