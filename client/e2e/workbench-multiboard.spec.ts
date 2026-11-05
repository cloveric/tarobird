import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { HubServer } from "../../src/hub/server.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import type { WorkbenchRequest, WorkbenchTarget } from "../../src/client-protocol/workbench.js";
import type { BoardDocument } from "../src/workbench-model.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
const board = (page: Page, id: string) => panel(page).locator(`.workbench-canvas[data-board-id="${id}"]`);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function storedBoards(page: Page): Promise<BoardDocument[]> {
  return page.evaluate(async () => {
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        if (!db.objectStoreNames.contains("workbenchBoards")) continue;
        return await new Promise<BoardDocument[]>((resolve, reject) => { const request = db.transaction("workbenchBoards").objectStore("workbenchBoards").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      } finally { db.close(); }
    }
    return [];
  });
}
const locks = (page: Page) => page.evaluate(async () => (await navigator.locks.query()).held?.filter(lock => lock.name?.startsWith("tarobot-whiteboard:")).map(lock => lock.name!).sort() ?? []);
async function inputSample(page: Page, label: string) {
  const composer = page.locator(".conversation-main textarea").last(), prefix = "MULTI_BOARD_DRAFT_", typed = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
  await composer.fill(prefix); await composer.focus();
  await page.evaluate(() => {
    const samples: number[] = [], input = document.querySelector<HTMLTextAreaElement>(".conversation-main textarea")!;
    const listener = (event: Event) => { const started = event.timeStamp; requestAnimationFrame(() => samples.push(performance.now() - started)); };
    input.addEventListener("input", listener);
    (window as unknown as { workbenchInputProbe: { samples: number[]; stop(): void } }).workbenchInputProbe = { samples, stop: () => input.removeEventListener("input", listener) };
  });
  await page.keyboard.type(typed, { delay: 20 }); await expect(composer).toHaveValue(prefix + typed);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const samples = await page.evaluate(() => { const probe = (window as unknown as { workbenchInputProbe: { samples: number[]; stop(): void } }).workbenchInputProbe; probe.stop(); return probe.samples; });
  expect(samples).toHaveLength(typed.length); const sorted = [...samples].sort((a, b) => a - b);
  return { label, samplesMs: samples, count: samples.length, p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1), draft: prefix + typed };
}
async function resourceSample(page: Page, cdp: CDPSession, label: string) {
  // Isolated renderer live heap after GC, not total App RSS/GPU/peak usage.
  await cdp.send("HeapProfiler.collectGarbage");
  return { label, heap: await cdp.send("Runtime.getHeapUsage"), dom: await cdp.send("Memory.getDOMCounters"), editors: await page.locator(".workbench-canvas").count(), canvasElements: await page.locator(".workbench-canvas canvas").count(), heldLocks: await locks(page) };
}

test("2/3/4 independent whiteboards with image mixtures save, switch and release without affecting chat", async ({ page, context, browserName }, info) => {
  test.skip(browserName !== "chromium", "CDP counters are specific to this isolated Chromium acceptance"); test.setTimeout(180_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-multi-")), hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  const resources: unknown[] = [], inputs: unknown[] = [], operations: unknown[] = []; let evidence: Record<string, unknown> = {};
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','多白板助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "多白板并行验收", "multi_board_chat");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
    const cdp = await context.newCDPSession(page), broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
    const command = async (request: WorkbenchRequest) => { const result = await broker.request(actor, request); operations.push({ request, receipt: result }); return result; };
    inputs.push(await inputSample(page, "chat-only")); resources.push(await resourceSample(page, cdp, "chat-only"));
    await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length).toBe(1);
    await panel(page).getByRole("button", { name: "展开到主区", exact: true }).click();
    const png = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 320; const drawing = canvas.getContext("2d")!;
      drawing.fillStyle = "#eee7df"; drawing.fillRect(0, 0, 512, 320); drawing.fillStyle = "#897e74"; drawing.fillRect(70, 60, 220, 140); drawing.fillStyle = "#30494b"; drawing.beginPath(); drawing.arc(355, 175, 70, 0, Math.PI * 2); drawing.fill();
      return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    const boards: { id: string; title: string; target: WorkbenchTarget; revision: number; images: number }[] = [];
    for (let index = 0; index < 4; index++) {
      const title = `独立白板 ${index + 1}`, created = await command({ requestId: `multi-create-${index}`, operation: "whiteboard.create", payload: { title } }); expect(created).toMatchObject({ status: "applied", saved: true });
      const id = (created.result as { tabId: string }).tabId, target = { ...created.target, tabId: id };
      const drawn = await command({ requestId: `multi-draw-${index}`, operation: "whiteboard.patch", target, expectedRevision: created.revision, payload: { ops: [{ op: "add", id: `box_${index}`, type: "rectangle", x: 30, y: 50, width: 150, height: 65 }, { op: "add", id: `label_${index}`, type: "text", x: 45, y: 70, text: `画布 ${index + 1}` }] } });
      expect(drawn).toMatchObject({ status: "applied", saved: true }); let revision = drawn.revision!; const images = index % 2 === 0 ? 1 : 0;
      if (images) { await board(page, id).locator('input[type="file"]').setInputFiles({ name: `fixture-${index}.png`, mimeType: "image/png", buffer: png }); revision++; await expect(board(page, id)).toHaveAttribute("data-board-revision", String(revision)); }
      boards.push({ id, title, target, revision, images });
    }
    await panel(page).getByRole("tab", { name: boards[0].title, exact: true }).click();
    for (let count = 2; count <= 4; count++) {
      await panel(page).getByRole("tab", { name: boards[count - 1].title, exact: true }).click({ button: "right" }); await page.getByRole("menu", { name: "标签选项", exact: true }).getByRole("button", { name: "加入分屏", exact: true }).click();
      await expect(page.locator(".workbench-canvas")).toHaveCount(count); await expect.poll(async () => (await locks(page)).length).toBe(count);
      for (const value of boards.slice(0, count)) await expect(board(page, value.id).locator(".workbench-canvas-status")).toHaveText("已保存在本机");
      // Concurrent commands use actual Host admission and independent revision/locks.
      const writes = await Promise.all(boards.slice(0, count).map(value => command({ requestId: `phase-${count}-${value.id}`, operation: "whiteboard.patch", target: value.target, expectedRevision: value.revision, payload: { ops: [{ op: "add", id: `phase_${count}`, type: "ellipse", x: 200 + count * 35, y: 40, width: 24, height: 24 }] } })));
      writes.forEach((result, index) => { expect(result).toMatchObject({ status: "applied", saved: true, revision: boards[index].revision + 1 }); boards[index].revision++; });
      for (const value of boards.slice(0, count)) { await panel(page).getByRole("tab", { name: value.title, exact: true }).click(); await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(count); }
      const input = await inputSample(page, `${count}-whiteboards`); inputs.push(input); resources.push(await resourceSample(page, cdp, `${count}-whiteboards`));
      await expect(page.locator(".conversation-main textarea").last()).toHaveValue(input.draft); await page.screenshot({ path: info.outputPath(`whiteboards-${count}-with-images.png`) });
    }
    const expected = await storedBoards(page); expect(expected).toHaveLength(4);
    for (const value of boards) { const saved = expected.find(item => item.id === value.id)!; expect(saved.revision).toBe(value.revision); expect(saved.scene.elements.filter(element => element.type === "image")).toHaveLength(value.images); expect(Object.keys(saved.files)).toHaveLength(value.images); }
    const actual = board(page, boards[1].id), canvas = actual.locator("canvas.interactive");
    await actual.getByTestId("toolbar-rectangle").locator("..").click(); const bounds = await canvas.boundingBox(); expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width * .6, bounds!.y + bounds!.height * .45); await page.mouse.down(); await page.mouse.move(bounds!.x + bounds!.width * .8, bounds!.y + bounds!.height * .7, { steps: 4 }); await page.mouse.up();
    const dirtyAtClose = await actual.getAttribute("data-board-saved"), pane = panel(page).getByRole("tabpanel", { name: boards[1].title, exact: true });
    await pane.getByRole("button", { name: "标签选项", exact: true }).click(); await panel(page).getByRole("button", { name: "关闭标签", exact: true }).click();
    await expect(board(page, boards[1].id)).toHaveCount(0); await expect.poll(async () => (await locks(page)).length).toBe(3);
    const savedAfterClose = (await storedBoards(page)).find(item => item.id === boards[1].id)!;
    expect(savedAfterClose.scene.elements).toHaveLength(expected.find(item => item.id === boards[1].id)!.scene.elements.length + 1);
    await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click(); await panel(page).getByRole("menu").getByRole("button", { name: boards[1].title, exact: true }).click();
    await expect(board(page, boards[1].id)).toHaveAttribute("data-board-revision", String(savedAfterClose.revision)); expect((await storedBoards(page)).find(item => item.id === boards[1].id)?.scene.elements).toEqual(savedAfterClose.scene.elements);
    const beforeRelease = await storedBoards(page), hashes = Object.fromEntries(beforeRelease.map(value => [value.id, { scene: digest(value.scene.elements), files: digest(value.files), revision: value.revision }]));
    await panel(page).getByRole("button", { name: "返回聊天", exact: true }).click(); await expect(page.locator(".workbench-canvas")).toHaveCount(0); await expect.poll(async () => (await locks(page)).length).toBe(0);
    inputs.push(await inputSample(page, "workbench-released")); resources.push(await resourceSample(page, cdp, "workbench-released"));
    await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(page.locator(".workbench-canvas")).toHaveCount(3);
    for (const value of boards) { await panel(page).getByRole("tab", { name: value.title, exact: true }).click(); await expect(board(page, value.id).locator(".workbench-canvas-status")).toHaveText("已保存在本机"); }
    const afterDocuments = await storedBoards(page), afterReopen = Object.fromEntries(afterDocuments.map(value => [value.id, { scene: digest(value.scene.elements), files: digest(value.files), revision: value.revision }]));
    evidence = { passed: false, source: "real isolated Hub + production React build, fixture Bot, Chromium", imageFixture: { bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), width: 512, height: 320, boardsWithImages: 2 }, boardCount: 4, dirtyAtClose, hashes, afterReopen, beforeDocuments: beforeRelease, afterDocuments, savedAfterClose };
    expect(afterReopen).toEqual(hashes); evidence.passed = true;
  } finally {
    await writeFile(info.outputPath("multiboard-evidence.json"), JSON.stringify({ ...evidence, operations, inputs, resources, limits: ["Input timing is trusted input event to next animation frame in isolated headless Chromium, not network/Host/model completion or physical screen latency.", "Heap samples follow forced GC and exclude total Electron process RSS/GPU; parent owns whole-process measurement.", "Four small scenes with two 512x320 PNGs; not a large-document stress limit or physical mobile acceptance."] }, null, 2));
    await page.close(); await hub.close(); await rm(directory, { recursive: true, force: true });
  }
});
