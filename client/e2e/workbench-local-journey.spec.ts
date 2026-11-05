import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { BoardDocument, WorkbenchLayout } from "../src/workbench-model.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const workbench = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
async function saved(page: Page) {
  return page.evaluate(async () => {
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        if (!db.objectStoreNames.contains("workbenchBoards")) continue;
        const all = <T>(store: string) => new Promise<T[]>((resolve, reject) => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        return { boards: await all<BoardDocument>("workbenchBoards"), layouts: await all<WorkbenchLayout>("workbenchLayouts") };
      } finally { db.close(); }
    }
    return { boards: [], layouts: [] };
  });
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("local tab controls, offline board editing and switching a live side session preserve state", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-local-")), botDir = path.join(directory, "bot"); await mkdir(botDir);
  await writeFile(path.join(botDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(directory, "hub"), clientDir: process.env.WORKBENCH_ACCEPTANCE_DIST ?? path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','本机交互助手',?,'codex')", [hashSecret(secret)]);
  const conversation = await hub.store.createConversation("owner", ["alpha"], "本机共享交互验收", "workbench_local");
  const sides = { opened: 0, disposed: [] as string[], aborted: [] as string[], completed: [] as string[], attachments: [] as { name: string; hash: string }[] };
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  const gateway = await attachGateway({ stateDir: botDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: {
    handleAuthorizedMessage: async () => ({ text: "主对话正常" }),
    sideCapability: () => ({ context: "native", concurrent: true, readOnly: "enforced", residue: "none", seesInProgressTurn: false, attachments: { images: true, files: "any", paths: true } }),
    openSideSession: async () => { const nativeId = `shared_${++sides.opened}`; return { nativeId, dispose: async () => { sides.disposed.push(nativeId); }, send: async ({ text, attachments, onEngineEvent, abortSignal }) => {
      if (text === "保持执行中的侧边任务") {
        await onEngineEvent({ type: "assistant_text", text: "侧边任务仍在执行", delta: true });
        const aborted = () => { sides.aborted.push(nativeId); release(); }; abortSignal.addEventListener("abort", aborted, { once: true });
        await held; abortSignal.removeEventListener("abort", aborted); abortSignal.throwIfAborted();
      }
      for (const file of attachments ?? []) sides.attachments.push({ name: file.name, hash: createHash("sha256").update(await readFile(file.path)).digest("hex") });
      sides.completed.push(text); return { text: text === "先保留一条回答" ? "此前侧边回答保留" : text === "保持执行中的侧边任务" ? "原侧边任务正常完成" : "已读取保留的草稿附件" };
    } }; },
  } });
  const evidence: Record<string, unknown> = { boundary: "Production React App, isolated real Hub/Gateway, fixture side engine; simulated offline networking, not physical device", steps: [] };
  const step = (name: string) => (evidence.steps as string[]).push(name);
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await selectConversation(page, conversation.title);
    const main = page.locator(".conversation-main textarea").last(); await main.fill("保留主聊天草稿");
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const side = page.locator(".side-conversation"), sideInput = side.getByRole("textbox", { name: "侧边问题", exact: true });
    await sideInput.fill("先保留一条回答"); await side.getByRole("button", { name: "发送侧边问题", exact: true }).click(); await expect(side).toContainText("此前侧边回答保留");
    await sideInput.fill("保持执行中的侧边任务"); await side.getByRole("button", { name: "发送侧边问题", exact: true }).click(); await expect(side).toContainText("侧边任务仍在执行");
    const attachment = Buffer.from("SIDE_DRAFT_BYTES_SURVIVE_WORKBENCH_SWITCH");
    await sideInput.fill("保留侧边下一条草稿"); await side.locator('input[type="file"]').setInputFiles({ name: "retained-side.txt", mimeType: "text/plain", buffer: attachment });
    await expect(side.getByRole("region", { name: "待发送的附件" })).toContainText("retained-side.txt");
    await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(side).toBeHidden(); await expect(workbench(page)).toBeVisible();
    expect(sides.opened).toBe(1); expect(sides.aborted).toEqual([]); expect(sides.disposed).toEqual([]); expect(sides.completed).not.toContain("保持执行中的侧边任务");
    await page.getByRole("button", { name: "侧边对话", exact: true }).click(); await expect(sideInput).toHaveValue("保留侧边下一条草稿");
    await expect(side.getByRole("button", { name: "停止侧边回答", exact: true })).toBeVisible(); await expect(side).toContainText("此前侧边回答保留");
    await expect(side.getByRole("region", { name: "待发送的附件" })).toContainText("retained-side.txt");
    await page.getByRole("button", { name: "工作台", exact: true }).click(); release(); await expect.poll(() => sides.completed.includes("保持执行中的侧边任务")).toBe(true);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click(); await expect(side).toContainText("原侧边任务正常完成"); await expect(sideInput).toHaveValue("保留侧边下一条草稿");
    await side.getByRole("button", { name: "发送侧边问题", exact: true }).click(); await expect(side).toContainText("已读取保留的草稿附件");
    expect(sides.attachments).toEqual([{ name: "retained-side.txt", hash: createHash("sha256").update(attachment).digest("hex") }]); expect(sides.opened).toBe(1); expect(sides.aborted).toEqual([]); expect(sides.disposed).toEqual([]);
    await side.getByRole("button", { name: "关闭侧边对话", exact: true }).click(); await expect.poll(() => sides.disposed).toEqual(["shared_1"]); await expect(main).toHaveValue("保留主聊天草稿");
    step("Live side session, previous answer, next draft and original attachment bytes survive workbench switches; explicit close alone disposes it");

    await page.getByRole("button", { name: "工作台", exact: true }).click();
    const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
    await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length).toBe(1);
    const ids: string[] = [];
    for (const title of ["草图 A", "草图 B", "草图 C"]) {
      const created = await broker.request(actor, { requestId: `create-${ids.length}`, operation: "whiteboard.create", payload: { title } }); expect(created).toMatchObject({ status: "applied", saved: true }); ids.push((created.result as { tabId: string }).tabId);
    }
    const tabMenu = async (title: string, action: string) => { await workbench(page).getByRole("tab", { name: title, exact: true }).click({ button: "right" }); await page.getByRole("menu", { name: "标签选项", exact: true }).getByRole("button", { name: action, exact: true }).click(); };
    await tabMenu("草图 B", "重命名"); await workbench(page).getByLabel("重命名标签", { exact: true }).fill("已命名白板"); await workbench(page).getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
    await expect(workbench(page).getByRole("tab")).toHaveText(["草图 A", "已命名白板", "草图 C"]);
    await tabMenu("已命名白板", "向左移动"); await expect(workbench(page).getByRole("tab")).toHaveText(["已命名白板", "草图 A", "草图 C"]);
    await tabMenu("已命名白板", "向右移动"); await expect(workbench(page).getByRole("tab")).toHaveText(["草图 A", "已命名白板", "草图 C"]);
    await tabMenu("草图 C", "向左移动"); await expect(workbench(page).getByRole("tab")).toHaveText(["草图 A", "草图 C", "已命名白板"]);
    await tabMenu("草图 A", "加入分屏"); await tabMenu("已命名白板", "加入分屏");
    await workbench(page).getByRole("button", { name: "展开到主区", exact: true }).click(); await expect(workbench(page).locator(".workbench-canvas")).toHaveCount(3);
    const columns = workbench(page).getByRole("separator", { name: "调整左右比例", exact: true }), rows = workbench(page).getByRole("separator", { name: "调整上下比例", exact: true });
    await columns.focus(); await columns.press("ArrowRight"); await expect(columns).toHaveAttribute("aria-valuenow", "55"); await expect(columns).toBeFocused();
    await rows.focus(); await rows.press("ArrowDown"); await expect(rows).toHaveAttribute("aria-valuenow", "55"); await expect(rows).toBeFocused();
    const beforeKeyboard = (await saved(page)).boards.map(item => ({ id: item.id, revision: item.revision, elements: hash(item.scene.elements) }));
    await main.fill("输入框焦点保留"); await main.press("End"); await main.pressSequentially("ABC"); await main.press(process.platform === "darwin" ? "Meta+z" : "Control+z"); await expect(main).toBeFocused();
    expect((await saved(page)).boards.map(item => ({ id: item.id, revision: item.revision, elements: hash(item.scene.elements) }))).toEqual(beforeKeyboard);
    await main.fill("联网后仍保留的主草稿"); await expect(columns).toHaveAttribute("aria-valuenow", "55"); await expect(rows).toHaveAttribute("aria-valuenow", "55");
    step("Rename and move tabs both directions, keyboard column/row ratios and main input focus/undo do not alter a board");

    await context.setOffline(true);
    // Force the already-open App WS to observe the same network cut. Gateway/Host remain live.
    for (const client of (hub as unknown as { clients: Set<{ ws: { terminate(): void } }> }).clients) client.ws.terminate();
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    expect(await page.evaluate(async url => { try { await fetch(url, { cache: "no-store" }); return false; } catch { return true; } }, hub.url + "/health")).toBe(true);
    await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length).toBe(0);
    const canvas = workbench(page).locator(`.workbench-canvas[data-board-id="${ids[0]}"]`);
    await canvas.getByTestId("toolbar-rectangle").locator("..").click(); const bounds = await canvas.locator("canvas.interactive").boundingBox(); expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width * .3, bounds!.y + bounds!.height * .45); await page.mouse.down(); await page.mouse.move(bounds!.x + bounds!.width * .65, bounds!.y + bounds!.height * .7, { steps: 4 }); await page.mouse.up();
    await expect(canvas).toHaveAttribute("data-board-saved", "true"); await expect.poll(async () => (await saved(page)).boards.find(item => item.id === ids[0])!.scene.elements.length).toBe(1);
    const offline = (await saved(page)).boards.find(item => item.id === ids[0])!; evidence.offlineBoard = { id: offline.id, revision: offline.revision, elementsHash: hash(offline.scene.elements) };
    await workbench(page).getByRole("button", { name: "返回聊天", exact: true }).click(); await expect(page.locator(".workbench-canvas")).toHaveCount(0);
    await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(workbench(page).locator(".workbench-canvas")).toHaveCount(3); await expect(canvas).toHaveAttribute("data-board-revision", String(offline.revision));
    expect(hash((await saved(page)).boards.find(item => item.id === ids[0])!.scene.elements)).toBe(hash(offline.scene.elements));
    await page.screenshot({ path: info.outputPath("offline-local-board.png") });
    step("With HTTP and WS disconnected, already loaded editor draws and saves locally, unmounts and reopens the saved scene");
    await context.setOffline(false); await waitForClientOnline(page); await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length).toBe(1);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, conversation.title);
    await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(workbench(page).getByRole("tab")).toHaveText(["草图 A", "草图 C", "已命名白板"]);
    await expect(workbench(page).locator(".workbench-canvas")).toHaveCount(3); await expect(columns).toHaveAttribute("aria-valuenow", "55"); await expect(rows).toHaveAttribute("aria-valuenow", "55");
    await expect(main).toHaveValue("联网后仍保留的主草稿");
    const restored = (await saved(page)).boards.find(item => item.id === ids[0])!; expect(restored.revision).toBe(offline.revision); expect(restored.scene.elements).toEqual(offline.scene.elements);
    evidence.restoredBoard = { id: restored.id, revision: restored.revision, elementsHash: hash(restored.scene.elements) }; evidence.passed = true;
    await page.screenshot({ path: info.outputPath("reconnected-restored-layout.png") }); step("Reconnect and full App reload preserve the saved offline shape, renamed tab order, both ratios and main draft");
  } finally {
    release(); await context.setOffline(false); await writeFile(info.outputPath("local-journey-evidence.json"), JSON.stringify({ ...evidence, sides }, null, 2));
    await page.close(); await gateway.disconnect(); await hub.close(); await rm(directory, { recursive: true, force: true });
  }
});
