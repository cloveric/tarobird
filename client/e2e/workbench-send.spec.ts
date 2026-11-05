import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import { WORKBENCH_HISTORY_LIMITS } from "../../src/hub/workbench-history.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });

async function annotatedDraft(page: Page, blank = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-send-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','改图助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "标注改图", "image_chat");
  const other = await hub.store.createConversation("owner", ["alpha"], "其他对话", "other_chat");
  await page.goto(hub.url); await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench;
  const actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
  await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length).toBe(1);
  const created = await broker.request(actor, { requestId: "annotation-board", operation: "whiteboard.create", payload: { title: "原图白板" } });
  expect(created).toMatchObject({ status: "applied", saved: true });
  const fixture = { hub, conversation, other, broker, actor, created,
    close: async () => { await page.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); } };
  if (blank) return fixture;
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext("2d")!; context.fillStyle = "#faecd2"; context.fillRect(0, 0, 96, 64);
    context.fillStyle = "#74655c"; context.fillRect(24, 16, 48, 32);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await panel(page).locator('input[accept^=".excalidraw"]').setInputFiles({ name: "original.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(panel(page).locator(".workbench-canvas")).toHaveAttribute("data-board-revision", "1");
  await panel(page).getByRole("button", { name: "发给 Bot", exact: true }).click();
  await page.getByRole("dialog", { name: "发送改图材料", exact: true }).getByRole("button", { name: "加入聊天草稿", exact: true }).click();
  await expect(page.locator(".workbench-draft-notice")).toBeVisible();
  await expect(page.locator(".conversation-main textarea").last()).toHaveValue(/请按标注修改原图/);
  await expect(page.getByLabel("草稿状态", { exact: true })).toHaveText("草稿已保存");
  return fixture;
}

test("full workbench history still sends chat and explains the omitted context", async ({ page }) => {
  const fixture = await annotatedDraft(page, true);
  try {
    await fixture.hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ["workbench-history-budget-v1", JSON.stringify({entries:WORKBENCH_HISTORY_LIMITS.maxEntries,bytes:1000,cleanedAt:Date.now()})]);
    await page.locator(".conversation-main textarea").last().fill("HISTORY_CAP_CHAT_SENT");
    await page.getByRole("button", {name:"发送消息",exact:true}).click();
    await expect(page.getByText("消息已发送，但工作台历史容量已满；本轮无法操作工作台内容。", {exact:true})).toBeVisible();
    const sent=await fixture.hub.store.db.get<{id:string}>("SELECT id FROM messages WHERE author_type='user' AND conversation_id=?",[fixture.conversation.id]);
    expect(sent).toBeDefined();
    await expect(fixture.broker.contextForMessage("owner",sent!.id,fixture.conversation.id)).rejects.toThrow("workbench_context_unavailable");
    await expect(page.locator(".conversation-main textarea").last()).toHaveValue("");
    await expect(page.locator(".conversation-main").getByText("HISTORY_CAP_CHAT_SENT", {exact:true})).toHaveCount(1);
    expect(await fixture.hub.store.db.get<{n:number}>("SELECT COUNT(*) AS n FROM messages WHERE author_type='user' AND conversation_id=?",[fixture.conversation.id])).toEqual({n:1});
  } finally { await fixture.close(); }
});

for (const action of ["cancel", "navigate"] as const) test(`annotation hashing respects ${action} before message dispatch`, async ({ page }) => {
  const fixture = await annotatedDraft(page);
  try {
    // Upload hashing uses Blob slices. Delay only the whole File read performed
    // by annotation resolution after all upload receipts have already arrived.
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      const state = { blocked: false, released: false, release: () => {} };
      const hold = new Promise<void>(resolve => { state.release = () => { state.released = true; resolve(); }; });
      (window as unknown as { annotationHash: typeof state }).annotationHash = state;
      File.prototype.arrayBuffer = async function () {
        const bytes = await original.call(this);
        if (this.name === "annotation-preview.png" && !state.released) { state.blocked = true; await hold; }
        return bytes;
      };
    });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { annotationHash: { blocked: boolean } }).annotationHash.blocked)).toBe(true);
    expect((await fixture.hub.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM attachments WHERE conversation_id=? AND complete=1", [fixture.conversation.id]))?.count).toBe(2);
    if (action === "cancel") await page.getByRole("button", { name: "取消上传", exact: true }).click();
    else await selectConversation(page, fixture.other.title);
    await page.evaluate(() => (window as unknown as { annotationHash: { release(): void } }).annotationHash.release());
    await expect(page.getByRole("button", { name: "取消上传", exact: true })).toHaveCount(0);
    expect((await fixture.hub.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE author_type='user'"))?.count).toBe(0);
    if (action === "navigate") await selectConversation(page, fixture.conversation.title);
    await expect(page.locator(".workbench-draft-notice")).toBeVisible();
    await expect(page.locator(".conversation-main textarea").last()).toHaveValue(/请按标注修改原图/);
  } finally { await fixture.close(); }
});

test("Bot edits refresh the user's undo and export toolbar", async ({ page }) => {
  const fixture = await annotatedDraft(page, true);
  try {
    const tabId = (fixture.created.result as { tabId: string }).tabId;
    const target = { ...fixture.created.target, tabId }, revision = fixture.created.revision!;
    const command = (request: Parameters<WorkbenchBroker["request"]>[1]) => fixture.broker.request(fixture.actor, request);
    expect(await command({ requestId: "toolbar-patch", operation: "whiteboard.patch", target, expectedRevision: revision, payload: { ops: [{ op: "add", id: "box", type: "rectangle", x: 20, y: 20, width: 150, height: 80 }] } })).toMatchObject({ status: "applied", saved: true });
    const toolbar = panel(page).locator(".workbench-canvas-tools");
    const undo = toolbar.getByRole("button", { name: "撤销", exact: true });
    const redo = toolbar.getByRole("button", { name: "重做", exact: true });
    await expect(undo).toBeEnabled(); await expect(panel(page).getByRole("button", { name: "PNG", exact: true })).toBeEnabled();
    await undo.click(); await expect(redo).toBeEnabled();
    expect(await command({ requestId: "toolbar-after-undo", operation: "whiteboard.read", target })).toMatchObject({ revision: revision + 2, result: { scene: { elements: [] } } });
    expect(await command({ requestId: "toolbar-redo", operation: "whiteboard.redo", target, expectedRevision: revision + 2 })).toMatchObject({ status: "applied", saved: true });
    await expect(undo).toBeEnabled(); await expect(redo).toBeDisabled();
    await expect(panel(page).getByRole("button", { name: "PNG", exact: true })).toBeEnabled();
    await expect(panel(page).getByTestId("button-undo")).toBeHidden();
    await expect(panel(page).getByTestId("button-redo")).toBeHidden();
    const colors = await panel(page).locator(".workbench-canvas").evaluate(canvas => {
      const selected = canvas.querySelector(".ToolIcon_type_radio:checked + .ToolIcon__icon")!;
      const probe = document.createElement("span"); probe.style.backgroundColor = "color-mix(in srgb,var(--accent,#897e74) 16%,var(--bg,#fff))";
      canvas.append(probe); const expected = getComputedStyle(probe).backgroundColor; probe.remove();
      return { selected: getComputedStyle(selected).backgroundColor, expected };
    });
    expect(colors.selected).toBe(colors.expected);
  } finally { await fixture.close(); }
});

test("restored annotation rebinds its original board after reload, never the active alternate board", async ({ page }) => {
  const fixture = await annotatedDraft(page);
  try {
    const originalTab = (fixture.created.result as { tabId: string }).tabId;
    const draftBefore = await page.evaluate(async conversationId => {
      const databases = await indexedDB.databases();
      for (const { name } of databases) {
        if (!name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try {
          if (!db.objectStoreNames.contains("conversationDrafts")) continue;
          const value = await new Promise<{context: {revision:number;imageEdit:{baseRevision:number;originalElementId:string;requestId:string}}} | undefined>((resolve,reject) => { const request=db.transaction("conversationDrafts").objectStore("conversationDrafts").get(conversationId); request.onsuccess=()=>resolve(request.result?.workbench);request.onerror=()=>reject(request.error); });
          if (value) return value;
        } finally { db.close(); }
      }
      throw new Error("fixture_annotation_draft_missing");
    }, fixture.conversation.id);
    const alternate = await fixture.broker.request(fixture.actor, { requestId: "alternate-board", operation: "whiteboard.create", payload: { title: "另一张白板" } });
    expect(alternate.status).toBe("applied");
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, fixture.conversation.title);
    await expect(page.locator(".workbench-draft-notice")).toBeVisible();
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(panel(page).getByRole("tab", { name: "另一张白板", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => (await workbenchContentTargets(fixture.broker, fixture.actor)).filter(target => target.visible).length).toBe(1);
    const live = (await workbenchContentTargets(fixture.broker, fixture.actor)).find(target => target.visible)!;
    expect(live.windowId).not.toBe(fixture.created.target.windowId);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(async () => (await fixture.hub.store.db.get<{id:string}>("SELECT id FROM messages WHERE author_type='user' AND conversation_id=?", [fixture.conversation.id]))?.id).toBeTruthy();
    const sent = (await fixture.hub.store.db.get<{id:string}>("SELECT id FROM messages WHERE author_type='user' AND conversation_id=?", [fixture.conversation.id]))!;
    expect(await fixture.broker.contextForMessage("owner", sent.id, fixture.conversation.id)).toMatchObject({
      target: {deviceId: live.deviceId, windowId: live.windowId, tabId: originalTab}, revision: draftBefore.context.revision,
      imageEdit: {boardId:originalTab,baseRevision:draftBefore.context.imageEdit.baseRevision,originalElementId:draftBefore.context.imageEdit.originalElementId,requestId:draftBefore.context.imageEdit.requestId},
    });
    await expect(page.locator(".workbench-draft-notice")).toHaveCount(0);
  } finally { await fixture.close(); }
});

test("narrow canvas menu stays compact with usable touch targets and an unclipped popup", async ({ page }, info) => {
  const fixture = await annotatedDraft(page, true);
  try {
    for (const width of [1360, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const canvas = panel(page).locator(".workbench-canvas"), bar = canvas.locator(".App-bottom-bar > .Island");
      const trigger = canvas.getByTestId("main-menu-trigger");
      await expect(trigger).toBeVisible();
      await canvas.locator(".excalidraw").evaluate(editor => { (editor as HTMLElement).style.setProperty("--sab", "20px"); (editor as HTMLElement).style.setProperty("--sal", "12px"); });
      const idle = await bar.boundingBox(), hit = await trigger.boundingBox(), bounds = await canvas.boundingBox();
      expect(idle!.width).toBeLessThan(100); expect(hit!.width).toBeGreaterThanOrEqual(44); expect(hit!.height).toBeGreaterThanOrEqual(44);
      expect(hit!.y + hit!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height - 20);
      expect(hit!.x).toBeGreaterThanOrEqual(bounds!.x + 12);
      await page.screenshot({ path: info.outputPath(`compact-menu-${width}.png`) });
      await trigger.click();
      const popup = canvas.locator(".dropdown-menu--mobile"); await expect(popup).toBeVisible();
      const popupBounds = await popup.boundingBox(); expect(popupBounds!.width).toBeGreaterThan(240);
      const color = canvas.getByTestId("color-top-pick-#f8f9fa"); await color.click(); await expect(color).toHaveClass(/active/);
      await page.screenshot({ path: info.outputPath(`open-menu-${width}.png`) });
      await trigger.click(); await expect(popup).toHaveCount(0);
      await expect(panel(page).locator(".workbench-canvas-tools").getByRole("button", { name: "撤销", exact: true })).toBeEnabled();
      await panel(page).locator(".workbench-canvas-tools").getByRole("button", { name: "撤销", exact: true }).click();
      await expect.poll(async () => (await bar.boundingBox())!.width).toBeLessThan(100);
    }
  } finally { await fixture.close(); }
});

test("fit shortcut and scroll-back use each split canvas's local viewport", async ({ page }, info) => {
  const fixture = await annotatedDraft(page, true);
  try {
    const command = (request: Parameters<WorkbenchBroker["request"]>[1]) => fixture.broker.request(fixture.actor, request);
    const boards = [{ title: "原图白板", receipt: fixture.created }];
    for (let index = 1; index < 4; index++) boards.push({ title: `缩放白板 ${index}`, receipt: await command({ requestId: `fit-create-${index}`, operation: "whiteboard.create", payload: { title: `缩放白板 ${index}` } }) });
    for (const [index, board] of boards.entries()) {
      const tabId = (board.receipt.result as { tabId: string }).tabId;
      expect(await command({ requestId: `fit-shape-${index}`, operation: "whiteboard.patch", target: { ...board.receipt.target, tabId }, expectedRevision: board.receipt.revision, payload: { ops: [{ op: "add", id: "fit-box", type: "rectangle", x: 30, y: 30, width: 200, height: 90 }] } })).toMatchObject({ status: "applied" });
    }
    for (const board of boards.slice(0, 3)) {
      await panel(page).getByRole("tab", { name: board.title, exact: true }).click({ button: "right" });
      await page.getByRole("menu", { name: "标签选项", exact: true }).getByRole("button", { name: "加入分屏", exact: true }).click();
    }
    await panel(page).getByRole("button", { name: "展开到主区", exact: true }).click();
    await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(4);
    // Wait for the shared expansion animation and each editor's ResizeObserver;
    // fitting a still-growing viewport legitimately keeps its earlier center.
    await expect.poll(async () => Math.min(...await Promise.all((await panel(page).locator(".workbench-pane:visible canvas.interactive").all()).map(async canvas => (await canvas.boundingBox())!.width)))).toBeGreaterThan(500);
    const receipts = [];
    for (const [index, board] of boards.entries()) {
      const tabId = (board.receipt.result as { tabId: string }).tabId, target = { ...board.receipt.target, tabId };
      const canvas = panel(page).locator(`.workbench-canvas[data-board-id="${tabId}"]`), interactive = canvas.locator("canvas.interactive");
      const bounds = (await interactive.boundingBox())!;
      await page.mouse.click(bounds.x + 15, bounds.y + bounds.height / 2);
      await page.keyboard.press("Shift+Digit1");
      let reads = 0, view!: { zoom: { value: number }; scrollX: number; scrollY: number };
      await expect.poll(async () => {
        const receipt = await command({ requestId: `fit-read-${index}-${++reads}`, operation: "whiteboard.read", target });
        view = (receipt.result as { scene: { appState: typeof view } }).scene.appState;
        return Math.abs((130 + view.scrollX) * view.zoom.value - bounds.width / 2);
      }).toBeLessThan(2);
      expect(view.zoom.value).toBeGreaterThan(.1);
      expect((30 + view.scrollX) * view.zoom.value).toBeGreaterThanOrEqual(0);
      expect((230 + view.scrollX) * view.zoom.value).toBeLessThanOrEqual(bounds.width);
      expect((30 + view.scrollY) * view.zoom.value).toBeGreaterThanOrEqual(0);
      expect((120 + view.scrollY) * view.zoom.value).toBeLessThanOrEqual(bounds.height);
      await expect(canvas.getByRole("button", { name: "滚动回到内容", exact: true })).toHaveCount(0);
      receipts.push({ tabId, bounds, view });
      if (index === 3) {
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.wheel(0, 1800);
        const back = canvas.getByRole("button", { name: "滚动回到内容", exact: true }); await expect(back).toBeVisible(); await back.click(); await expect(back).toHaveCount(0);
      }
    }
    await writeFile(info.outputPath("fit-local-viewports.json"), JSON.stringify(receipts, null, 2));
    await page.screenshot({ path: info.outputPath("four-boards-fitted.png") });
  } finally { await fixture.close(); }
});
