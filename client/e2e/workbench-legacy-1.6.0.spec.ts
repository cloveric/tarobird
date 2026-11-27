import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect as baseExpect, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import type { WorkbenchRequest } from "../../src/client-protocol/workbench.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

// Projects written by the 1.6.0 App and its Baoyu editors, in this build: a deck
// opens in the presentation editor with nothing lost, a canvas can only be
// exported. The fixtures are real 1.6.0 output; fixtures/legacy-1.6.0/README.md
// says how they were made. Each deck is brought in both ways a 1.6.0 device can
// have it: as the file "Back up PPT project" wrote, and as the records the 1.6.0
// App left in IndexedDB (same database version, 13).
// Desktop Chromium at 1360 px; not a phone, not Electron, not WebKit.
const dist = process.env.WORKBENCH_LEGACY_CLIENT_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
const fixtureFile = (name: string) => fileURLToPath(new URL(`./fixtures/legacy-1.6.0/${name}`, import.meta.url));
type StoredFile = { base64: string; contentType: string; sha256: string; size: number };
type StoredDocument = { id: string; revision: number; format?: string; files: Record<string, StoredFile> };
type Stored = { dbVersion: number; document: StoredDocument; tab: { id: string; kind: "design"; title: string; designFormat?: "slides" }; meta: Record<string, unknown>; objects: Record<string, unknown> };
type Backup = { format: string; version: number; title: string; document: StoredDocument };
const json = async <T,>(name: string) => JSON.parse(await readFile(fixtureFile(name), "utf8")) as T;
const text = (file: { base64: string }) => Buffer.from(file.base64, "base64").toString("utf8");
const hashes = (files: Record<string, { sha256: string }>) => Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.sha256]).sort(([a], [b]) => a < b ? -1 : 1));

// Generous waits: the fixture Host, the App and the editor frame start slowly on a busy machine.
const expect = baseExpect.configure({ timeout: 30000 });
const online = (page: Page) => expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeAttached({ timeout: 180000 });
test.use({ serviceWorkers: "block", actionTimeout: 120000 });
async function fixture(page: Page) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-legacy-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: dist });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','设计助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "旧版项目", "legacy_chat");
  await page.goto(hub.url); await preparePairing(page, hub);
  // On a busy machine the App's check of its Host address can time out ("主机地址不可用"); the form stays and the
  // button repeats the check. Nothing about a project is involved yet.
  const code = page.getByLabel("配对码", { exact: true });
  for (let attempt = 1; ; attempt++) {
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    if (await code.waitFor({ state: "visible", timeout: 60000 }).then(() => true, () => false)) break;
    if (attempt === 5) throw new Error("pairing_code_not_shown");
  }
  await hub.auth.approve(await code.innerText(), "local-owner"); await code.waitFor({ state: "hidden" });
  await online(page); await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
  await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(panel(page)).toBeVisible();
  await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length, { timeout: 60000 }).toBe(1);
  let serial = 0;
  const f = {
    hub, conversation, targets: () => workbenchContentTargets(broker, actor), command: (request: WorkbenchRequest) => broker.request(actor, request),
    async target(title: string) {
      // The Workbench registers again after a reload or a new tab: wait until the Host sees this tab.
      await expect.poll(async () => (await f.targets())[0]?.tabs.some(item => item.title === title) ?? false, { timeout: 60000 }).toBe(true);
      const registration = (await f.targets())[0], tab = registration.tabs.find(item => item.title === title)!; return { deviceId: registration.deviceId, windowId: registration.windowId, tabId: tab.id };
    },
    /** What the App has stored now, through the Bot read path: file hashes, revision and one file's text. */
    async listing(title: string) { const result = await f.command({ requestId: `legacy-list-${++serial}`, operation: "design.read", target: await f.target(title), payload: {} }); return { revision: result.revision, files: (result.result as { files: Record<string, { sha256: string }> }).files }; },
    async file(title: string, name: string) { return ((await f.command({ requestId: `legacy-read-${++serial}`, operation: "design.read", target: await f.target(title), payload: { path: name } })).result as { content: string }).content; },
    async reopen() { await page.reload(); await online(page); await waitForClientOnline(page); await selectConversation(page, conversation.title); if (!await panel(page).isVisible()) await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(panel(page)).toBeVisible(); await expect.poll(async () => (await f.targets()).length, { timeout: 60000 }).toBe(1); },
    close: async () => { await page.close({ runBeforeUnload: false }); await hub.close(); await rm(directory, { recursive: true, force: true }); },
  };
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
const editorOf = (page: Page) => page.frameLocator(".workbench-design-frame:visible");
const guestOf = (page: Page) => page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;

/** The file a 1.6.0 user saved with "Back up PPT project", imported from the + menu. */
async function importBackup(page: Page, name: string) {
  await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await panel(page).getByRole("menu").getByRole("button", { name: "导入项目", exact: true }).click();
  await (await chooser).setFiles(fixtureFile(name));
}
/** The records the 1.6.0 App left in IndexedDB for one project, with its Tab, put under this device's own scope. */
async function seedStored(page: Page, f: Fixture, records: Stored[]) {
  // A layout change makes the App write this conversation's layout record, which names its scope.
  await panel(page).getByRole("button", { name: "展开到主区", exact: true }).click(); await panel(page).getByRole("button", { name: "返回右侧", exact: true }).click();
  await page.evaluate(async ({ records, conversationId }) => {
    for (const name of (await indexedDB.databases()).map(item => item.name!).filter(Boolean)) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open(name); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      try {
        if (!db.objectStoreNames.contains("workbenchLayouts")) continue;
        const keys = await new Promise<IDBValidKey[]>((resolve, reject) => { const request = db.transaction("workbenchLayouts").objectStore("workbenchLayouts").getAllKeys(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const scope = keys.find(key => typeof key === "string" && JSON.parse(key)[2] === conversationId) as string | undefined;
        if (!scope) continue;
        if (db.version !== records[0].dbVersion) throw new Error(`database version ${db.version}, fixture ${records[0].dbVersion}`);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(["workbenchDesign", "workbenchDesignMeta", "workbenchDesignObjects", "workbenchLayouts"], "readwrite");
          const layouts = tx.objectStore("workbenchLayouts"), current = layouts.get(scope);
          current.onsuccess = () => {
            const layout = current.result, tabs = records.filter(record => record.tab).map(record => record.tab);
            for (const record of records) {
              tx.objectStore("workbenchDesign").put(record.document, [scope, record.document.id]);
              for (const [kind, value] of Object.entries(record.meta)) tx.objectStore("workbenchDesignMeta").put(value, [scope, record.document.id, kind]);
              for (const [sha, value] of Object.entries(record.objects)) tx.objectStore("workbenchDesignObjects").put(value, [scope, record.document.id, sha]);
            }
            if (tabs.length) layouts.put({ ...layout, revision: layout.revision + 1, tabs: [...layout.tabs, ...tabs], visible: [tabs[0].id], active: tabs[0].id, maximized: null }, scope);
          };
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
        return;
      } finally { db.close(); }
    }
    throw new Error("scope_not_found");
  }, { records, conversationId: f.conversation.id });
  await f.reopen();
}

/** Slide elements as the presentation editor lays them out, in slide units (1920 × 1080). */
async function geometry(page: Page, slide: string) {
  return guestOf(page).evaluate(id => {
    const stage = document.querySelector(`[data-open-artifact-slide="${id}"]`)!, frame = stage.getBoundingClientRect(), k = 1920 / frame.width;
    return [...stage.querySelectorAll("[data-open-artifact-kind]")].map(node => { const r = node.getBoundingClientRect(); return { kind: node.getAttribute("data-open-artifact-kind"), x: Math.round((r.left - frame.left) * k), y: Math.round((r.top - frame.top) * k), w: Math.round(r.width * k), h: Math.round(r.height * k) }; });
  }, slide);
}
/** Computed style of the innermost element whose whole text is `value`. */
async function styleOf(page: Page, value: string) {
  return guestOf(page).evaluate(value => {
    const node = [...document.querySelectorAll("[data-open-artifact-slide] *")].filter(node => node.textContent === value).at(-1)!, style = getComputedStyle(node);
    return { weight: Number(style.fontWeight), italic: style.fontStyle === "italic", color: style.color, family: style.fontFamily, size: style.fontSize };
  }, value);
}
async function show(page: Page, slide: number, of: number) {
  const editor = editorOf(page), position = async () => Number((await editor.getByText(new RegExp(`^\\d+ / ${of}$`)).first().innerText()).split(" / ")[0]);
  for (let current = await position(); current !== slide; current = await position()) await editor.getByRole("button", { name: current < slide ? "Next slide" : "Previous slide", exact: true }).click();
}
async function noSlideErrors(page: Page) {
  await expect(editorOf(page).getByText(/has errors|read-only here|can’t be edited/)).toHaveCount(0);
}
/** Types over a text in the editor by hand, then waits until the editor and the App have saved it. */
async function retype(page: Page, current: string, next: string) {
  const editor = editorOf(page), target = editor.getByText(current, { exact: true }).first();
  await target.dblclick(); await page.keyboard.press("Meta+A"); await page.keyboard.type(next); await page.keyboard.press("Escape");
  await expect(editor.getByText(next, { exact: true }).first()).toBeVisible();
  await expect(editor.getByRole("button", { name: "All changes synced", exact: true })).toBeVisible({ timeout: 120000 });
  await expect(panel(page).getByRole("status").filter({ hasText: /正在保存|尚未保存/ })).toHaveCount(0, { timeout: 120000 });
}
/** The App gives its editor frame 20 s to start and 10 s to confirm a save. On a busy machine either limit can
 * pass; the App then shows "尚未保存或编辑器未就绪" with 重试. It is pressed here as a person would, and logged. */
async function pressRetry(page: Page) {
  const retry = panel(page).getByRole("alert").getByRole("button", { name: "重试", exact: true });
  if (!await retry.isVisible().catch(() => false)) return false;
  console.log("LEGACY_SPEC_PRESSED_APP_RETRY"); await retry.click().catch(() => undefined); return true;
}
/** Waits for the editor to show `locator` after a project was opened or the page reloaded. */
async function shown(page: Page, locator: Locator, timeout = 240000) {
  for (const deadline = Date.now() + timeout, since = { alert: 0 }; Date.now() < deadline; await page.waitForTimeout(1000)) {
    if (await locator.isVisible().catch(() => false)) return;
    const alert = await panel(page).getByRole("alert").getByRole("button", { name: "重试", exact: true }).isVisible().catch(() => false);
    // A late editor clears its own alert; press 重试 only when the alert has stayed for 20 s.
    since.alert = alert ? since.alert || Date.now() : 0;
    if (alert && Date.now() - since.alert > 20000) { await pressRetry(page); since.alert = 0; }
  }
  await expect(locator).toBeVisible();
}
async function download(page: Page, click: () => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    const pending = page.waitForEvent("download", { timeout: 60000 }).catch(() => undefined); await click();
    const file = await pending;
    if (file) return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
    if (attempt === 3) throw new Error("no_download");
    await pressRetry(page); await page.waitForTimeout(5000);
  }
}

/** Every slide of the plain 1.6.0 deck, as 1.6.0 showed it: text, runs, shapes, tables and the uploaded picture. */
async function expectPlainDeck(page: Page) {
  const editor = editorOf(page);
  await shown(page, editor.getByRole("heading", { name: "季度复盘 Quarterly review", level: 1 }));
  await expect(editor.getByText("双击文字即可编辑，也可以让 Bot 帮你制作幻灯片。", { exact: true })).toBeVisible();
  await expect(editor.getByText("1 / 5", { exact: true })).toBeVisible(); await noSlideErrors(page);

  await show(page, 2, 5);
  await expect(editor.getByRole("heading", { name: "议程 Agenda（手改）", level: 2 })).toBeVisible();
  await expect(editor.getByText("三件事，按优先级排列。", { exact: true })).toBeVisible();
  await expect(editor.getByRole("listitem")).toHaveText(["收入与留存", "发布节奏 release cadence", "下季度计划"]);
  expect((await styleOf(page, "优先级")).weight).toBeGreaterThanOrEqual(600);
  expect((await styleOf(page, "release cadence")).italic).toBe(true);
  expect(await styleOf(page, "议程 Agenda（手改）")).toMatchObject({ weight: 600, color: "rgb(41, 39, 35)", family: expect.stringContaining("Georgia") });
  await noSlideErrors(page);

  await show(page, 3, 5);
  await expect(editor.getByRole("heading", { name: "流程 Flow", level: 2 })).toBeVisible();
  await expect(editor.getByText("起草 Draft", { exact: true })).toBeVisible();
  await expect(editor.getByText("矩形、箭头、椭圆、菱形与一条虚线", { exact: true })).toBeVisible();
  // Painted box, arrow, ellipse, diamond and line where the 1.6.0 file pins them; the rounded rectangle
  // the 1.6.0 toolbar inserted (stored as 50% / 50% with translate(-50%, -50%)) centred on the slide as 1.6.0 drew it.
  const placed = await geometry(page, "shapes");
  expect(placed.filter(item => item.kind === "box")).toEqual([{ kind: "box", x: 160, y: 360, w: 420, h: 240 }]);
  expect(placed.filter(item => item.kind === "shape")).toEqual([
    { kind: "shape", x: 640, y: 440, w: 200, h: 80 }, { kind: "shape", x: 900, y: 340, w: 300, h: 280 }, { kind: "shape", x: 1300, y: 340, w: 280, h: 280 },
    { kind: "shape", x: 160, y: 720, w: 1420, h: 6 }, { kind: "shape", x: 810, y: 390, w: 300, h: 300 },
  ]);
  expect(await guestOf(page).evaluate(() => [...document.querySelectorAll('[data-open-artifact-slide="shapes"] > [data-open-artifact-kind]')].map(node => { const style = getComputedStyle(node), fill = node.querySelector("polygon")?.getAttribute("fill") ?? node.querySelector("line")?.getAttribute("stroke"); return fill ?? `${style.backgroundColor} ${style.borderRadius}`; })))
    .toEqual(["rgb(217, 119, 87) 24px", "#292723", "rgb(61, 122, 106) 50%", "#e8c56a", "#77736e", expect.stringMatching(/^rgb/), "rgb(154, 160, 166) 24px"]);
  await noSlideErrors(page);

  await show(page, 4, 5);
  await expect(editor.getByRole("heading", { name: "数据 Numbers", level: 2 })).toBeVisible();
  await expect(editor.getByRole("table")).toHaveCount(2);
  await expect(editor.getByRole("table").first().getByRole("row")).toHaveText(["指标 MetricQ2Q3", "活跃用户12,40015,950", "留存 Retention61%68%", "收入 Revenue¥ 1.2M¥ 1.7M"]);
  await expect(editor.getByRole("table").first().getByRole("columnheader")).toHaveText(["指标 Metric", "Q2", "Q3"]);
  await expect(editor.getByRole("table").nth(1).getByRole("columnheader")).toHaveText(["Column", "Column", "Column"]);
  await expect(editor.getByRole("table").nth(1).getByRole("row")).toHaveCount(3);
  // The first table keeps its width and place; the one the 1.6.0 toolbar inserted stays centred on the slide's height.
  const tables = (await geometry(page, "numbers")).filter(item => item.kind === "table");
  expect(tables.map(({ x, w }) => ({ x, w }))).toEqual([{ x: 110, w: 1500 }, { x: 128, w: 900 }]);
  expect(Math.abs(tables[1].y + tables[1].h / 2 - 540)).toBeLessThanOrEqual(2);
  expect(await guestOf(page).evaluate(() => getComputedStyle([...document.querySelectorAll("[data-open-artifact-slide] [role=cell], [data-open-artifact-slide] td")].find(node => node.textContent === "15,950")!).textAlign)).toBe("right");
  await noSlideErrors(page);

  await show(page, 5, 5);
  await expect(editor.getByRole("heading", { name: "现场 On site", level: 2 })).toBeVisible();
  await expect(editor.getByText("本机上传的图片（手改）。", { exact: true })).toBeVisible();
  const photo = editor.locator('img[alt="现场照片 Site photo"]').first();
  await expect(photo).toBeVisible();
  // The 96 × 64 PNG uploaded in the 1.6.0 editor is decoded from the project's own asset, in its 720 × 480 frame.
  await expect.poll(() => photo.evaluate((node: HTMLImageElement) => node.complete ? `${node.naturalWidth}x${node.naturalHeight}` : "loading")).toBe("96x64");
  expect((await geometry(page, "picture")).filter(item => item.kind === "image").map(({ w, h }) => ({ w, h }))).toEqual([{ w: 720, h: 480 }]);
  await noSlideErrors(page);
}

for (const way of ["backup", "stored"] as const) test(`a plain 1.6.0 deck opens complete, saves an edit and exports (${way === "backup" ? "imported from its 1.6.0 backup file" : "left in the App's storage by 1.6.0"})`, async ({ page }) => {
  test.setTimeout(600000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const backup = await json<Backup>("plain-deck.tarobot-design.json"), stored = await json<Stored>("plain-deck.stored.json"), title = "季度复盘 1.6.0";
  expect(backup).toMatchObject({ format: "tarobot-design", version: 2, title }); expect(stored.document).toEqual(backup.document);
  const f = await fixture(page);
  try {
    if (way === "backup") await importBackup(page, "plain-deck.tarobot-design.json"); else await seedStored(page, f, [stored]);
    await expect(panel(page).getByRole("tab", { name: title, exact: true })).toBeVisible({ timeout: 120000 });
    const editor = editorOf(page);
    await expectPlainDeck(page);
    // Opening and paging through it wrote nothing: every stored file is still byte for byte what 1.6.0 saved.
    const opened = await f.listing(title);
    expect(hashes(opened.files)).toEqual(hashes(Object.fromEntries(Object.entries(backup.document.files).filter(([name]) => !name.startsWith("project/assets/")))));
    expect(opened.revision).toBe(way === "stored" ? stored.document.revision : 0);

    // An edit by hand on the cover is saved and read back; the other slides are not touched by it.
    await show(page, 1, 5);
    await retype(page, "季度复盘 Quarterly review", "季度复盘 Edited in the new editor");
    expect(await f.file(title, "project/slides/cover.html")).toContain("季度复盘 Edited in the new editor");
    const afterCover = await f.listing(title);
    expect(afterCover.revision).toBeGreaterThan(opened.revision!);
    for (const name of ["agenda", "shapes", "numbers", "picture"]) expect(afterCover.files[`project/slides/${name}.html`].sha256, name).toBe(backup.document.files[`project/slides/${name}.html`].sha256);
    // An edit on the slide that holds the 1.6.0 toolbar shape: the editor saves its own form of it, in the same place.
    await show(page, 3, 5);
    await retype(page, "流程 Flow", "流程 Flow 已改");
    const shapes = await f.file(title, "project/slides/shapes.html");
    expect(shapes).toContain("流程 Flow 已改"); expect(shapes).toContain("矩形、箭头、椭圆、菱形与一条虚线");
    expect(shapes.match(/<x-shape /g)).toHaveLength(5);
    expect(shapes).toMatch(/<x-shape kind="rect"[^>]*left:calc\(50% - 150px\);top:calc\(50% - 150px\);width:300px;height:300px/);
    expect(shapes).not.toContain("translate(");
    // Speaker notes, sections and the picture reference written by 1.6.0 are still in the stored project.
    expect(await f.file(title, "project/slides/agenda.html")).toContain("<aside>讲者备注：先讲留存，再讲收入。</aside>");
    const deck = JSON.parse(await f.file(title, "project/deck.json"));
    expect(deck).toMatchObject({ v: 4, order: ["cover", "agenda", "shapes", "numbers", "picture"], cover: "cover", sections: { s1: { description: "Opening", start: "cover" }, s2: { description: "Evidence", start: "numbers" } } });
    expect(await f.file(title, "project/slides/picture.html")).toMatch(/<img src="\/_blob\/[0-9a-f]{32}" alt="现场照片 Site photo"/);

    // After a reload the App reads its own storage again: the edits and everything else are there.
    await f.reopen();
    await shown(page, editor.getByRole("heading", { name: "季度复盘 Edited in the new editor", level: 1 }));
    await show(page, 3, 5);
    await expect(editor.getByRole("heading", { name: "流程 Flow 已改", level: 2 })).toBeVisible();
    expect((await geometry(page, "shapes")).filter(item => item.kind === "shape").at(-1)).toEqual({ kind: "shape", x: 810, y: 390, w: 300, h: 300 });
    await show(page, 5, 5);
    await expect.poll(() => editor.locator('img[alt="现场照片 Site photo"]').first().evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth)).toBe(96);
    await noSlideErrors(page);

    // Export: the project backup of this build, and PowerPoint from the editor's own menu.
    const saved = await download(page, () => panel(page).getByRole("button", { name: "备份项目", exact: true }).click());
    expect(saved.name).toBe(`${title}.tarobot-design.json`);
    const again = JSON.parse(saved.bytes.toString("utf8")) as Backup;
    expect(again).toMatchObject({ format: "tarobot-design", version: 2, title, document: { format: "slides" } });
    expect(Object.keys(again.document.files).sort()).toEqual(Object.keys(backup.document.files).sort());
    expect(text(again.document.files["project/slides/cover.html"])).toContain("季度复盘 Edited in the new editor");
    const asset = Object.keys(backup.document.files).find(name => name.startsWith("project/assets/"))!;
    expect(again.document.files[asset]).toEqual(backup.document.files[asset]);
    for (const name of ["agenda", "numbers", "picture"]) expect(again.document.files[`project/slides/${name}.html`], name).toEqual(backup.document.files[`project/slides/${name}.html`]);
    await editor.getByRole("button", { name: "Export", exact: true }).click();
    const pptx = await download(page, () => editor.getByRole("menuitem", { name: "PowerPoint (basic fonts)", exact: true }).click());
    expect(pptx.name).toMatch(/\.pptx$/);
    const { default: AdmZip } = await import("adm-zip"); const zip = new AdmZip(pptx.bytes), entries = zip.getEntries().map(item => item.entryName);
    expect(entries.filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort()).toEqual([1, 2, 3, 4, 5].map(n => `ppt/slides/slide${n}.xml`));
    expect(zip.readAsText("ppt/slides/slide1.xml")).toContain("季度复盘 Edited in the new editor");
    expect(zip.readAsText("ppt/slides/slide2.xml")).toContain("议程 Agenda（手改）");
    expect(zip.readAsText("ppt/slides/slide4.xml")).toContain("15,950");
    expect(zip.readAsText("ppt/slides/slide5.xml")).toContain("本机上传的图片（手改）。");
    const media = entries.filter(name => name.startsWith("ppt/media/"));
    expect(media.some(name => createHash("sha256").update(zip.readFile(name)!).digest("hex") === backup.document.files[asset].sha256)).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) {
    console.log("LEGACY_PLAIN_STATE", await page.frameLocator(".workbench-design-frame").locator("body").ariaSnapshot().catch(() => "no editor"), await panel(page).ariaSnapshot().catch(() => "no panel"), errors);
    throw error;
  } finally { await f.close(); }
});

for (const way of ["backup", "stored"] as const) test(`a 1.6.0 deck with an installed design system keeps it (${way === "backup" ? "imported from its 1.6.0 backup file" : "left in the App's storage by 1.6.0"})`, async ({ page }) => {
  test.setTimeout(600000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const backup = await json<Backup>("design-system-deck.tarobot-design.json"), stored = await json<Stored>("design-system-deck.stored.json"), title = "品牌演示 1.6.0";
  expect(stored.document).toEqual(backup.document);
  const copies = Object.keys(backup.document.files).filter(name => name.startsWith("project/ds/system-brand/")).sort();
  expect(copies).toHaveLength(7);
  // What 1.6.0 stored: its copy of the system, with the leading-slash asset references it wrote into the copied text files.
  expect(text(backup.document.files["project/ds/system-brand/Logo.dc.html"])).toContain('src="/project/ds/system-brand/assets/');
  expect(text(backup.document.files["project/ds/system-brand/theme.css"])).toContain("url(/project/ds/system-brand/assets/");
  const f = await fixture(page);
  try {
    if (way === "backup") await importBackup(page, "design-system-deck.tarobot-design.json"); else await seedStored(page, f, [stored]);
    await expect(panel(page).getByRole("tab", { name: title, exact: true })).toBeVisible({ timeout: 120000 });
    const editor = editorOf(page);
    await shown(page, editor.getByRole("heading", { name: "品牌演示 Brand deck", level: 1 }));
    await noSlideErrors(page);
    await show(page, 2, 2);
    await expect(editor.getByRole("heading", { name: "品牌 Brand", level: 2 })).toBeVisible();
    await expect(editor.getByText("珊瑚色强调、墨色文字、纸色背景（手改）。", { exact: true })).toBeVisible();
    expect(await styleOf(page, "品牌 Brand")).toMatchObject({ weight: 600, color: "rgb(217, 119, 87)", family: expect.stringContaining("Georgia") });
    // The system's logo keeps its element, name and 360 × 360 frame. As in 1.6.0 it is not painted:
    // neither editor frame serves a design-system file by its path (1.6.0 showed the same slide with the name only).
    await expect(editor.getByRole("img", { name: "品牌标志 Brand logo", exact: true }).first()).toBeVisible();
    expect((await geometry(page, "brand")).filter(item => item.kind === "image")).toEqual([{ kind: "image", x: 120, y: 360, w: 360, h: 360 }]);
    await noSlideErrors(page);
    // Opening it wrote nothing.
    const opened = await f.listing(title);
    expect(hashes(opened.files)).toEqual(hashes(backup.document.files));
    expect(opened.revision).toBe(way === "stored" ? stored.document.revision : 0);

    // An edit on the slide is saved; the copied system, its record and the picture reference stay as 1.6.0 wrote them.
    await retype(page, "品牌 Brand", "品牌 Brand 已改");
    const slide = await f.file(title, "project/slides/brand.html");
    expect(slide).toContain("品牌 Brand 已改");
    expect(slide).toContain('<img src="project/ds/system-brand/img/logo.svg" alt="品牌标志 Brand logo"');
    const after = await f.listing(title);
    for (const name of copies) expect(after.files[name].sha256, name).toBe(backup.document.files[name].sha256);
    const deck = JSON.parse(await f.file(title, "project/deck.json")), before = JSON.parse(text(backup.document.files["project/deck.json"]));
    expect(deck.designSystems).toEqual(before.designSystems); expect(deck.order).toEqual(["cover", "brand"]);
    await f.reopen();
    await shown(page, editor.getByRole("heading", { name: "品牌演示 Brand deck", level: 1 }));
    await show(page, 2, 2);
    await expect(editor.getByRole("heading", { name: "品牌 Brand 已改", level: 2 })).toBeVisible();
    await noSlideErrors(page);
    const saved = await download(page, () => panel(page).getByRole("button", { name: "备份项目", exact: true }).click());
    const again = JSON.parse(saved.bytes.toString("utf8")) as Backup;
    expect(again).toMatchObject({ format: "tarobot-design", version: 2, title });
    for (const name of copies) expect(again.document.files[name], name).toEqual(backup.document.files[name]);
    // The editor reads the installed system's tokens: the paragraph's colour and style carry the system's names,
    // and the system is offered as the deck's look.
    await editor.getByText("珊瑚色强调、墨色文字、纸色背景（手改）。", { exact: true }).first().click();
    await editor.getByRole("button", { name: "Properties", exact: true }).first().click();
    const properties = editor.getByRole("complementary", { name: "Properties", exact: true });
    await expect(properties.getByRole("button", { name: "Text color: ink", exact: true })).toBeVisible();
    await expect(properties.getByRole("combobox", { name: "Text style", exact: true })).toHaveText("Body / Body");
    await properties.getByRole("button", { name: "Theme", exact: true }).click();
    await expect(properties.getByRole("option", { name: /^设计系统/ })).toBeVisible();
    expect(hashes((await f.listing(title)).files)).toEqual(hashes(after.files));
    expect(errors).toEqual([]);
  } catch (error) {
    console.log("LEGACY_DS_STATE", await page.frameLocator(".workbench-design-frame").locator("body").ariaSnapshot().catch(() => "no editor"), await panel(page).ariaSnapshot().catch(() => "no panel"), errors);
    throw error;
  } finally { await f.close(); }
});

test("a 1.6.0 canvas project is not opened and can be exported from its tab and from Workbench files", async ({ page }) => {
  test.setTimeout(600000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const exported160 = await json<Backup>("canvas-project.tarobot-design.json"), stored = await json<Stored>("canvas-project.stored.json"), title = "海报草稿 1.6.0";
  expect(stored.tab).toEqual({ id: stored.document.id, kind: "design", title }); expect(stored.document.format).toBeUndefined();
  expect(text(stored.document.files["project/Main.dc.html"])).toContain("海报草稿 Poster draft");
  const f = await fixture(page);
  try {
    await seedStored(page, f, [stored]);
    const tab = panel(page).getByRole("tab", { name: title, exact: true });
    await expect(tab).toBeVisible({ timeout: 120000 }); await expect(tab).toHaveAttribute("aria-selected", "true");
    const pane = panel(page).getByRole("tabpanel", { name: title, exact: true });
    await expect(pane.getByText("Baoyu 画布已从工作台移除。可导出此项目。", { exact: true })).toBeVisible();
    await expect(page.locator(".workbench-design-frame")).toHaveCount(0);
    // The Bot cannot reach it, and a canvas is not offered for creation.
    expect((await f.targets())[0].tabs.map(item => item.title)).not.toContain(title);
    await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
    await expect(panel(page).getByRole("menu").getByRole("button", { name: "画布", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // "Export project" on the tab saves the file 1.6.0's own "Export design" button wrote for this project.
    const fromTab = await download(page, () => pane.getByRole("button", { name: "导出项目", exact: true }).click());
    expect(fromTab.name).toBe(`${title}.tarobot-design.json`);
    expect(JSON.parse(fromTab.bytes.toString("utf8"))).toEqual(exported160);
    await expect(page.locator(".workbench-design-frame")).toHaveCount(0);

    // The same from Settings → Workbench files, where the project's row has "Export" beside "Open".
    await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click();
    await panel(page).getByRole("button", { name: "管理所有工作台文件", exact: true }).click();
    const files = page.getByRole("region", { name: "工作台文件", exact: true });
    const row = files.getByRole("listitem").filter({ hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button")).toHaveText(["导出", "打开"]);
    const fromFiles = await download(page, () => row.getByRole("button", { name: `导出：${title}`, exact: true }).click());
    expect(fromFiles.name).toBe(`${title}.tarobot-design.json`);
    expect(JSON.parse(fromFiles.bytes.toString("utf8"))).toEqual(exported160);
    await expect(files.getByRole("alert")).toHaveCount(0);
    expect(errors).toEqual([]);
  } catch (error) {
    console.log("LEGACY_CANVAS_STATE", await page.locator("body").ariaSnapshot().catch(() => "no page"), errors);
    throw error;
  } finally { await f.close(); }
});

test("a 1.6.0 canvas backup is refused on import, and a deck row in Workbench files has no export button", async ({ page }) => {
  test.setTimeout(600000);
  const f = await fixture(page);
  try {
    await importBackup(page, "canvas-project.tarobot-design.json");
    await expect(panel(page).getByRole("alert")).toContainText("Baoyu 画布已从工作台移除。本机项目可在“设置 → 工作台文件”导出。");
    await expect(panel(page).getByRole("tab")).toHaveCount(0);
    await panel(page).getByRole("alert").getByRole("button", { name: "关闭提示", exact: true }).click();
    await importBackup(page, "plain-deck.tarobot-design.json");
    await expect(panel(page).getByRole("tab", { name: "季度复盘 1.6.0", exact: true })).toBeVisible({ timeout: 120000 });
    await shown(page, editorOf(page).getByRole("heading", { name: "季度复盘 Quarterly review", level: 1 }));
    await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click();
    await panel(page).getByRole("button", { name: "管理所有工作台文件", exact: true }).click();
    const row = page.getByRole("region", { name: "工作台文件", exact: true }).getByRole("listitem").filter({ hasText: "季度复盘 1.6.0" });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button")).toHaveText(["打开"]);
  } finally { await f.close(); }
});
