import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
test("a failed whiteboard save survives a conversation remount and retries from the actual saved revision", async ({ page }) => {
  test.setTimeout(90000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "audit-board-retention-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('audit_bot','白板保存验收','fixture')");
    const a = await hub.store.createConversation("owner", ["audit_bot"], "白板 A", "audit_a");
    const b = await hub.store.createConversation("owner", ["audit_bot"], "对话 B", "audit_b");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, a.title);
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await panel(page).getByRole("button", { name: "白板", exact: true }).click();
    const canvas = panel(page).locator(".workbench-canvas").first();
    await expect(canvas).toHaveAttribute("data-board-saved", "true");
    const id = await canvas.getAttribute("data-board-id");
    await page.evaluate(id => {
      const put = IDBObjectStore.prototype.put;
      Object.assign(window, { restoreAuditBoardSave: () => { IDBObjectStore.prototype.put = put; } });
      IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
        if (this.name === "workbenchBoards" && value.id === id && value.revision > 0) throw new DOMException("fixture storage full", "QuotaExceededError");
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    }, id);
    await canvas.getByTestId("toolbar-rectangle").locator("..").click();
    const bounds = (await canvas.locator("canvas.interactive").boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * .3, bounds.y + bounds.height * .4);
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .6, bounds.y + bounds.height * .65, { steps: 4 }); await page.mouse.up();
    await expect(canvas.getByRole("button", { name: "重新保存", exact: true })).toBeVisible();
    await selectConversation(page, b.title); await expect(canvas).toHaveCount(0);
    await selectConversation(page, a.title);
    if (!await panel(page).isVisible()) await page.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(canvas).toHaveAttribute("data-board-id", id!);
    await expect(canvas).toHaveAttribute("data-board-saved", "false");
    await expect(canvas.getByRole("button", { name: "重新保存", exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).restoreAuditBoardSave());
    await canvas.getByRole("button", { name: "重新保存", exact: true }).click();
    await expect(canvas).toHaveAttribute("data-board-saved", "true");
    const saved = await page.evaluate(async id => {
      for (const entry of await indexedDB.databases()) {
        if (!entry.name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(entry.name!); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try {
          if (!db.objectStoreNames.contains("workbenchBoards")) continue;
          const rows = await new Promise<any[]>((resolve, reject) => { const request = db.transaction("workbenchBoards").objectStore("workbenchBoards").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          const board = rows.find(row => row.id === id); if (board) return { revision: board.revision, elements: board.scene.elements.length };
        } finally { db.close(); }
      }
    }, id);
    expect(saved?.revision).toBeGreaterThan(0); expect(saved?.elements).toBe(1);
  } finally { await page.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Design tab deletion refuses another live editor, then succeeds after that window closes", async ({ page, context }) => {
  test.setTimeout(90000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "audit-design-delete-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  let other: Page | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('audit_bot','设计删除验收','fixture')");
    const conversation = await hub.store.createConversation("owner", ["audit_bot"], "双窗口设计", "audit_design");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
    await panel(page).getByRole("menu").getByRole("button", { name: "设计", exact: true }).click();
    await expect(page.frameLocator(".workbench-design-frame").getByText("设计", { exact: true }).first()).toBeVisible({ timeout: 20000 });
    // Same origin, device and IndexedDB; a real second editor holds a shared Web Lock.
    other = await context.newPage(); await other.goto(hub.url); await waitForClientOnline(other);
    await showDisconnectedBots(other); await selectConversation(other, conversation.title);
    if (!await panel(other).isVisible()) await other.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(other.frameLocator(".workbench-design-frame").getByText("设计", { exact: true }).first()).toBeVisible({ timeout: 20000 });
    const remove = async () => {
      await panel(other!).getByRole("tab", { name: "设计", exact: true }).click({ button: "right" });
      await other!.getByRole("menu", { name: "标签选项", exact: true }).getByRole("button", { name: "删除这个设计", exact: true }).click();
      await other!.getByRole("dialog").getByRole("button", { name: "删除设计", exact: true }).click();
    };
    await remove();
    await expect(other.getByText("另一窗口正在打开这份设计，暂不能删除。请先在该窗口关闭设计标签后重试。", { exact: true })).toBeVisible();
    await expect(panel(page).getByRole("tab", { name: "设计", exact: true })).toBeVisible();
    await expect(panel(other).getByRole("tab", { name: "设计", exact: true })).toBeVisible();
    await page.close({ runBeforeUnload: false });
    await remove();
    await expect(panel(other).getByRole("tab", { name: "设计", exact: true })).toHaveCount(0);
    await expect(other.locator(".workbench-design-frame")).toHaveCount(0);
    // Persistence readback through a full reload must not resurrect the deleted design.
    await other.reload(); await waitForClientOnline(other); await selectConversation(other, conversation.title);
    if (!await panel(other).isVisible()) await other.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(panel(other).getByRole("tab", { name: "设计", exact: true })).toHaveCount(0);
  } finally { await other?.close({ runBeforeUnload: false }); if (!page.isClosed()) await page.close({ runBeforeUnload: false }); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
