import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { ConversationFolders } from "../../src/hub/conversation-folders.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { mobileHome, openMobileHome, openMobileSearch, setListOption, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { closeSettings, openSettings } from "./fixtures/settings.js";
import { createServer } from "./fixtures/vite.js";
import type { multipleHosts } from "./fixtures/multiple-hosts.js";

// Two independent device-local pin levels: 分组置顶 orders a row inside its own
// folder/container, 全局置顶 lifts it into one cross-host 置顶 section above every
// host and folder heading without changing the Hub's folder assignment.
test.use({ serviceWorkers: "block" });
const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");
const sidebar = (page: Page) => workspace(page).locator(".sidebar");
const mode = (page: Page, name: string) => sidebar(page).getByRole("button", { name, exact: true });
// The section is named by its state; 全局置顶 remains the action label.
const globalRegion = (scope: Page | Locator) => scope.getByRole("region", { name: "已全局置顶", exact: true });
const menu = (page: Page) => page.getByRole("menu", { name: /^(对话|群组)操作$/ });
const sheet = (page: Page) => page.getByRole("dialog", { name: /^(对话|群组)操作$/ });
const hostKey = (hub: HubServer) => `hub_${createHash("sha256").update(Buffer.from(hub.auth.publicKey, "base64")).digest("hex")}`;
// Nested Locator arguments resolve from the page root, so section-relative
// queries use these host-scoped CSS selectors instead.
const rowCss = (hub: HubServer, id: string) => `[data-host-id="${hostKey(hub)}"] .conversation-row[data-conversation-id="${id}"]`;
const phoneCss = (hub: HubServer, id: string) => `.mh-row[data-host-id="${hostKey(hub)}"][data-conversation-id="${id}"]`;
const desktopRow = (page: Page, hub: HubServer, id: string) => sidebar(page).locator(rowCss(hub, id));
const phoneRow = (page: Page, hub: HubServer, id: string) => mobileHome(page).locator(phoneCss(hub, id));

async function pair(page: Page, hub: HubServer, name: string, add = false) {
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  if (add) await clickAppAction(page, "连接另一台主机", workspace(page).getByRole("button", { name: "连接另一台主机", exact: true }));
  else await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill(name);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await showDisconnectedBots(page); await waitForClientOnline(page);
}
async function bot(hub: HubServer, id: string, name: string, online = 1) {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES(?,?,'fixture',?)", [id, name, online]);
}
/** Explicit IDs reproduce identical conversations on different hosts. */
async function direct(hub: HubServer, id: string, title: string, at: number, botId = "bot") {
  await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES(?,?,?,?,?,?)", [id, "direct", title, "owner", at, id]);
  await hub.store.db.run("INSERT INTO conversation_members VALUES(?,?,?,0)", [id, "user", "owner"]);
  await hub.store.db.run("INSERT INTO conversation_members VALUES(?,?,?,0)", [id, "bot", botId]);
}
async function group(hub: HubServer, title: string, at: number, parentId?: string) {
  const chat = await hub.store.createConversation("owner", ["bot"], title, `action_${title}`, { type: "group", ...(parentId ? { parentId } : {}) });
  await hub.store.db.run("UPDATE conversations SET created_at=? WHERE id=?", [at, chat.id]);
  return chat;
}
async function desktopAction(page: Page, row: Locator, name: string, keyboard = false) {
  if (keyboard) await row.press("Shift+F10"); else await row.click({ button: "right" });
  const item = menu(page).getByRole("menuitem", { name, exact: true });
  if (keyboard) await item.press("Enter"); else await item.click();
  await expect(menu(page)).toHaveCount(0);
}
async function phoneAction(page: Page, row: Locator, name: string) {
  await row.press("Shift+F10");
  await sheet(page).getByRole("button", { name, exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
}

type Layout = { sections: number; before: boolean; globalFirst: boolean; duplicates: string[]; global: string[]; groups: Record<string, string[]> };
/** Where every rendered conversation row sits, in document order. `groups` keys
 * are `host:folder` (`unfiled` for the system section, `-` outside folders),
 * including rows hidden inside a collapsed folder: hidden is not lost. */
function layout(page: Page, aliases: Record<string, string>, phone = false): Promise<Layout> {
  return page.evaluate(({ aliases, phone }) => {
    const root = document.querySelector<HTMLElement>(phone ? ".host-workspace:not([hidden]) .mobile-home" : ".host-workspace:not([hidden]) .sidebar");
    if (!root) return { sections: -1, before: false, globalFirst: false, duplicates: [], global: [], groups: {} };
    const rows = [...root.querySelectorAll<HTMLElement>(phone ? ".mh-row[data-conversation-id]" : ".conversation-row[data-conversation-id]")];
    const host = (row: HTMLElement) => { const id = row.dataset.hostId ?? row.closest<HTMLElement>("[data-host-id]")?.dataset.hostId ?? ""; return aliases[id] ?? id; };
    const name = (row: HTMLElement) => `${host(row)}/${row.dataset.conversationId}`;
    const sections = [...root.querySelectorAll<HTMLElement>(".global-pin-section")];
    const inGlobal = rows.map(row => !!row.closest(".global-pin-section"));
    const seen = new Set<string>(), duplicates = rows.map(name).filter(key => seen.has(key) || !seen.add(key));
    const firstOrdinary = inGlobal.indexOf(false), lastGlobal = inGlobal.lastIndexOf(true);
    const section = sections[0];
    const headings = [...root.querySelectorAll(".conversation-folder, .host-heading, .host-directory-section, .mh-folder-host, .sidebar-label, .bot-tree, .group-tree, .adhd-group-topics")].filter(node => !section?.contains(node));
    const groups: Record<string, string[]> = {};
    rows.forEach((row, i) => {
      if (inGlobal[i]) return;
      const folder = row.closest<HTMLElement>(".conversation-folder")?.dataset.folderId;
      (groups[`${host(row)}:${folder === undefined ? "-" : folder || "unfiled"}`] ??= []).push(row.dataset.conversationId!);
    });
    return {
      sections: sections.length,
      before: !section || headings.every(node => !!(section.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)),
      globalFirst: firstOrdinary < 0 || lastGlobal < firstOrdinary,
      duplicates, global: rows.filter((_, i) => inGlobal[i]).map(name), groups,
    };
  }, { aliases, phone });
}
const placed = (global: string[], groups: Record<string, string[]>): Layout => ({ sections: global.length ? 1 : 0, before: true, globalFirst: true, duplicates: [], global, groups });

test("phone folders keep group and global pins independent, including an otherwise empty folder, across filters and reload", async ({ page }, info) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "global-pins-phone-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const folders = new ConversationFolders(hub.store.db);
  try {
    await bot(hub, "bot", "整理助手"); await bot(hub, "ghost", "未连接助手", 0);
    await direct(hub, "a", "周报", 40); await direct(hub, "b", "需求评审", 30); await direct(hub, "c", "旅行计划", 20);
    await direct(hub, "d", "随手记", 10); await direct(hub, "e", "离线草稿", 5, "ghost");
    await folders.change("owner", { type: "create", id: "work", name: "工作", conversationId: "a", revision: 0 });
    await folders.change("owner", { type: "move", conversationId: "b", folderId: "work", revision: 1 });
    // 生活 contains only 旅行计划: extracting it must not delete or hide the folder.
    await folders.change("owner", { type: "create", id: "life", name: "生活", conversationId: "c", revision: 2 });
    await pair(page, hub, "手机主机"); await openMobileHome(page);
    const home = mobileHome(page), H = { [hostKey(hub)]: "H" }, row = (id: string) => phoneRow(page, hub, id);
    const life = home.locator('.conversation-folder[data-folder-id="life"]');
    const expectLayout = (global: string[], groups: Record<string, string[]>) => expect.poll(() => layout(page, H, true)).toEqual(placed(global, groups));
    await expectLayout([], { "H:work": ["a", "b"], "H:life": ["c"], "H:unfiled": ["d", "e"] });

    await phoneAction(page, row("b"), "分组置顶");
    await expectLayout([], { "H:work": ["b", "a"], "H:life": ["c"], "H:unfiled": ["d", "e"] });
    await expect(row("b").getByRole("img", { name: "已分组置顶", exact: true })).toBeVisible();

    await phoneAction(page, row("b"), "全局置顶");
    await expectLayout(["H/b"], { "H:work": ["a"], "H:life": ["c"], "H:unfiled": ["d", "e"] });
    await expect(globalRegion(home).getByText("置顶", { exact: true })).toBeVisible();
    await expect(globalRegion(home).locator(phoneCss(hub, "b")).getByRole("img", { name: "已全局置顶", exact: true })).toBeVisible();
    await phoneAction(page, row("c"), "全局置顶");
    await expectLayout(["H/b", "H/c"], { "H:work": ["a"], "H:unfiled": ["d", "e"] });
    await expect(life.locator(".folder-heading")).toBeVisible();
    await expect(life.locator(".folder-empty")).toBeVisible();
    await phoneAction(page, row("e"), "全局置顶");
    await expectLayout(["H/b", "H/c", "H/e"], { "H:work": ["a"], "H:unfiled": ["d"] });
    await page.screenshot({ path: info.outputPath("phone-global-and-group-pins.png"), animations: "disabled" });

    // Global pins never bypass the disconnected-Bot filter, search or folder ownership.
    await setListOption(page, "显示未连接 Bot", false);
    await expectLayout(["H/b", "H/c"], { "H:work": ["a"], "H:unfiled": ["d"] });
    await setListOption(page, "显示未连接 Bot", true);
    await expectLayout(["H/b", "H/c", "H/e"], { "H:work": ["a"], "H:unfiled": ["d"] });
    await openMobileSearch(page);
    const search = home.getByRole("searchbox", { name: "查找会话或 Bot", exact: true });
    await search.fill("旅行");
    await expectLayout(["H/c"], {});
    await search.fill("周报");
    await expectLayout([], { "H:work": ["a"] });
    // A query matching a Bot keeps search order: Bot results, then the
    // conversation heading, then the global section, then ordinary folders.
    await search.fill("整理");
    await expectLayout(["H/b", "H/c"], { "H:work": ["a"], "H:unfiled": ["d"] });
    expect(await home.evaluate(root => {
      const order = (a: Element | null | undefined, b: Element | null | undefined) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const heading = [...root.querySelectorAll("h2.mh-section-title")].find(node => node.textContent === "会话");
      return order(root.querySelector(".mh-bot-row"), heading) && order(heading, root.querySelector(".global-pin-section")) && order(root.querySelector(".global-pin-section"), root.querySelector(".conversation-folder"));
    })).toBe(true);
    await home.getByRole("button", { name: "关闭搜索", exact: true }).click();
    await expectLayout(["H/b", "H/c", "H/e"], { "H:work": ["a"], "H:unfiled": ["d"] });
    expect((await folders.read("owner")).assignments.map(a => `${a.conversationId}:${a.folderId}`).sort()).toEqual(["a:work", "b:work", "c:life"]);

    await page.reload(); await openMobileHome(page);
    await expectLayout(["H/b", "H/c", "H/e"], { "H:work": ["a"], "H:unfiled": ["d"] });
    // Each level is toggled only by its own action.
    await row("b").press("Shift+F10");
    await expect(sheet(page).getByRole("button", { name: "取消全局置顶", exact: true })).toBeVisible();
    await sheet(page).getByRole("button", { name: "取消分组置顶", exact: true }).click();
    await expect(sheet(page)).toHaveCount(0);
    await expectLayout(["H/b", "H/c", "H/e"], { "H:work": ["a"], "H:unfiled": ["d"] });
    await expect(row("b").getByRole("img", { name: "已全局置顶", exact: true })).toBeVisible();
    await phoneAction(page, row("b"), "分组置顶");

    // Unpinning returns each row to its own folder, keeping its group pin.
    await phoneAction(page, row("b"), "取消全局置顶");
    await expectLayout(["H/c", "H/e"], { "H:work": ["b", "a"], "H:unfiled": ["d"] });
    await expect(row("b").getByRole("img", { name: "已分组置顶", exact: true })).toBeVisible();
    await phoneAction(page, row("c"), "取消全局置顶");
    await expectLayout(["H/e"], { "H:work": ["b", "a"], "H:life": ["c"], "H:unfiled": ["d"] });
    await expect(life.locator(".folder-empty")).toHaveCount(0);
    await phoneAction(page, row("e"), "取消全局置顶");
    await expectLayout([], { "H:work": ["b", "a"], "H:life": ["c"], "H:unfiled": ["d", "e"] });
    await expect(globalRegion(home)).toHaveCount(0);
    await phoneAction(page, row("b"), "取消分组置顶");
    await expectLayout([], { "H:work": ["a", "b"], "H:life": ["c"], "H:unfiled": ["d", "e"] });
    await page.reload(); await openMobileHome(page);
    await expectLayout([], { "H:work": ["a", "b"], "H:life": ["c"], "H:unfiled": ["d", "e"] });
    expect((await folders.read("owner")).assignments.map(a => `${a.conversationId}:${a.folderId}`).sort()).toEqual(["a:work", "b:work", "c:life"]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("one cross-host global section precedes every host and folder in combined, grouped, filtered, Bot and phone lists, with same IDs isolated", async ({ page }, info) => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "global-pins-hosts-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  try {
    for (const hub of [a, b]) { await bot(hub, "bot", "同名助手"); await direct(hub, "same", "同名对话", 30); }
    await direct(a, "a_note", "甲笔记", 20); await direct(b, "b_note", "乙笔记", 10);
    await new ConversationFolders(a.store.db).change("owner", { type: "create", id: "work", name: "工作", conversationId: "same", revision: 0 });
    await pair(page, a, "主机甲"); await mode(page, "按对话").click(); await pair(page, b, "主机乙", true);
    await expect(mode(page, "按对话")).toHaveAttribute("aria-pressed", "true");
    const aliases = { [hostKey(a)]: "A", [hostKey(b)]: "B" };
    const expectLayout = (global: string[], groups: Record<string, string[]>, phone = false) => expect.poll(() => layout(page, aliases, phone)).toEqual(placed(global, groups));
    const region = globalRegion(sidebar(page));
    await expectLayout([], { "A:work": ["same"], "A:unfiled": ["a_note"], "B:unfiled": ["same", "b_note"] });

    await desktopAction(page, desktopRow(page, a, "same"), "全局置顶", true);
    await expectLayout(["A/same"], { "A:unfiled": ["a_note"], "B:unfiled": ["same", "b_note"] });
    await expect(region).toContainText("主机甲");
    await expect.soft(desktopRow(page, a, "same"), "keyboard focus follows the row into the global section").toBeFocused();
    await desktopAction(page, desktopRow(page, b, "b_note"), "全局置顶");
    await expectLayout(["A/same", "B/b_note"], { "A:unfiled": ["a_note"], "B:unfiled": ["same"] });
    await page.screenshot({ path: info.outputPath("desktop-combined.png") });

    await setListOption(page, "按主机分组", true);
    await expect(sidebar(page).locator(".host-heading")).toHaveCount(2);
    await expectLayout(["A/same", "B/b_note"], { "A:unfiled": ["a_note"], "B:-": ["same"] });
    await expect(region.locator(".host-source-badge")).toHaveCount(2);
    await page.screenshot({ path: info.outputPath("desktop-grouped.png") });
    const filter = sidebar(page).getByRole("combobox", { name: "筛选运行主机" });
    await filter.selectOption(hostKey(a));
    await expectLayout(["A/same"], { "A:unfiled": ["a_note"] });
    await filter.selectOption(hostKey(b));
    await expectLayout(["B/b_note"], { "B:-": ["same"] });
    await filter.selectOption("");

    await mode(page, "按 Bot").click();
    await expectLayout(["A/same", "B/b_note"], { "A:-": ["a_note"], "B:-": ["same"] });
    await expect(sidebar(page).getByText("分组置顶", { exact: true })).toHaveCount(0);
    await setListOption(page, "按主机分组", false);
    await expectLayout(["A/same", "B/b_note"], { "A:-": ["a_note"], "B:-": ["same"] });
    await page.screenshot({ path: info.outputPath("desktop-bots-combined.png") });
    // In the Bot list a group pin orders the row inside its own Bot; leaving the
    // global section returns it there (first, although older), not to a second
    // pinned section.
    await desktopAction(page, desktopRow(page, b, "b_note"), "分组置顶");
    await expectLayout(["A/same", "B/b_note"], { "A:-": ["a_note"], "B:-": ["same"] });
    await desktopAction(page, desktopRow(page, b, "b_note"), "取消全局置顶");
    await expectLayout(["A/same"], { "A:-": ["a_note"], "B:-": ["b_note", "same"] });
    await expect(sidebar(page).getByText("分组置顶", { exact: true })).toHaveCount(0);
    await desktopAction(page, desktopRow(page, b, "b_note"), "全局置顶");
    await desktopAction(page, desktopRow(page, b, "b_note"), "取消分组置顶");
    await expectLayout(["A/same", "B/b_note"], { "A:-": ["a_note"], "B:-": ["same"] });
    await mode(page, "按对话").click();

    await desktopAction(page, desktopRow(page, a, "same"), "取消全局置顶", true);
    await expectLayout(["B/b_note"], { "A:work": ["same"], "A:unfiled": ["a_note"], "B:unfiled": ["same"] });
    await expect.soft(desktopRow(page, a, "same"), "keyboard focus follows the row back into its folder").toBeFocused();
    await page.reload(); await expect(mode(page, "按对话")).toHaveAttribute("aria-pressed", "true");
    await expectLayout(["B/b_note"], { "A:work": ["same"], "A:unfiled": ["a_note"], "B:unfiled": ["same"] });

    await page.setViewportSize({ width: 390, height: 844 }); await openMobileHome(page);
    await expectLayout(["B/b_note"], { "A:work": ["same"], "A:unfiled": ["a_note"], "B:unfiled": ["same"] }, true);
    await expect(globalRegion(mobileHome(page))).toContainText("主机乙");
    await setListOption(page, "按主机分组", true);
    await expect(mobileHome(page).locator(".mh-folder-host-title")).toHaveCount(2);
    await expectLayout(["B/b_note"], { "A:work": ["same"], "A:unfiled": ["a_note"], "B:-": ["same"] }, true);
    await page.screenshot({ path: info.outputPath("phone-grouped.png"), animations: "disabled" });
    await phoneAction(page, phoneRow(page, b, "b_note"), "取消全局置顶");
    await expectLayout([], { "A:work": ["same"], "A:unfiled": ["a_note"], "B:-": ["same", "b_note"] }, true);
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("a globally pinned topic leaves its parent without double-counted unread and returns on unpin in Bot, inbox, phone and ADHD lists", async ({ page }, info) => {
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "global-pins-topic-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await bot(hub, "bot", "群助手");
    const parent = await group(hub, "产品群", 10);
    const release = await group(hub, "发布话题", 11, parent.id), design = await group(hub, "设计话题", 12, parent.id);
    await direct(hub, "other", "其他对话", 50);
    await pair(page, hub, "话题主机");
    await expect(workspace(page).getByRole("heading", { name: "其他对话", exact: true, level: 1 })).toBeVisible();
    for (const [id, text] of [[release.id, "发布进度一"], [release.id, "发布进度二"], [design.id, "设计稿"]] as const) {
      await hub.store.publishBotMessage("bot", { conversationId: id, blocks: [{ type: "text", text }], status: "complete" });
    }
    const H = { [hostKey(hub)]: "H" }, row = (id: string) => desktopRow(page, hub, id), region = globalRegion(sidebar(page));
    await mode(page, "按对话").click();
    await expect(row(parent.id).locator(".unread-badge")).toHaveText("3");
    await expect(row(release.id)).toHaveCount(0);

    await mode(page, "按 Bot").click();
    await expect(row(release.id)).toBeVisible();
    await desktopAction(page, row(release.id), "全局置顶");
    await expect(region.locator(rowCss(hub, release.id))).toBeVisible();
    await expect(row(release.id)).toHaveCount(1);
    await expect(region).toContainText("产品群");
    await expect.poll(() => layout(page, H).then(value => ({ ...value, groups: {} }))).toEqual(placed(["H/" + release.id], {}));

    await mode(page, "按对话").click();
    await expect.poll(() => layout(page, H)).toEqual(placed(["H/" + release.id], { "H:-": [parent.id, "other"] }));
    await expect(row(release.id).locator(".unread-badge")).toHaveText("2");
    await expect(row(parent.id).locator(".unread-badge")).toHaveText("1");
    await page.reload(); await expect(mode(page, "按对话")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => layout(page, H)).toEqual(placed(["H/" + release.id], { "H:-": [parent.id, "other"] }));
    await page.screenshot({ path: info.outputPath("desktop-topic-extracted.png") });

    await page.setViewportSize({ width: 390, height: 844 }); await openMobileHome(page);
    const extracted = phoneRow(page, hub, release.id);
    await expect.poll(() => layout(page, H, true)).toEqual(placed(["H/" + release.id], { "H:-": [parent.id, "other"] }));
    await expect(extracted.locator(".mh-row-tag")).toHaveText("产品群");
    await expect(extracted.locator(".mh-badge")).toHaveText("2");
    await expect(phoneRow(page, hub, parent.id).locator(".mh-badge")).toHaveText("1");
    await extracted.press("Shift+F10");
    await expect(sheet(page).getByRole("button", { name: "移至分组", exact: true })).toHaveCount(0);
    await sheet(page).getByRole("button", { name: "关闭对话操作", exact: true }).click(); await expect(sheet(page)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("phone-topic-extracted.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1360, height: 900 });

    await desktopAction(page, row(release.id), "取消全局置顶");
    await expect(region).toHaveCount(0);
    await expect(row(release.id)).toHaveCount(0);
    await expect(row(parent.id).locator(".unread-badge")).toHaveText("3");

    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    const adhd = page.locator(".adhd-shell > .sidebar"), adhdRegion = globalRegion(adhd);
    const tree = adhd.locator(".adhd-group-topics").filter({ has: page.locator(`[data-conversation-id="${parent.id}"]`) });
    const toggle = tree.locator(".adhd-topic-toggle"), child = tree.locator(`.conversation-row[data-conversation-id="${release.id}"]`);
    await expect(toggle).toHaveText("2 个话题");
    await toggle.click(); await expect(child).toBeVisible();
    await desktopAction(page, child, "全局置顶");
    await expect(adhdRegion.locator(`.conversation-row[data-conversation-id="${release.id}"]`)).toBeVisible();
    await expect(adhd.locator(`.conversation-row[data-conversation-id="${release.id}"]`)).toHaveCount(1);
    await expect(toggle).toHaveText("1 个话题");
    await page.screenshot({ path: info.outputPath("adhd-topic-extracted.png") });
    await desktopAction(page, adhdRegion.locator(`.conversation-row[data-conversation-id="${release.id}"]`), "取消全局置顶");
    await expect(adhdRegion).toHaveCount(0);
    await expect(toggle).toHaveText("2 个话题");
    await expect(child).toBeVisible();
    await expect(adhd.locator(`.conversation-row[data-conversation-id="${release.id}"]`)).toHaveCount(1);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("global pin focus follows the moved row even when the local directory refresh is slower than two frames", async ({ page }) => {
  test.setTimeout(120_000);
  // Simulates a slow device: readonly reads of the global pin list complete
  // 250 ms late. Read-modify-write transactions are untouched.
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const request = get.call(this, key), delay = (window as unknown as { slowGlobalPinReads?: number }).slowGlobalPinReads ?? 0;
      if (delay && key === "globalPins" && this.transaction.mode === "readonly") {
        let replay = false;
        request.addEventListener("success", event => {
          if (replay) return;
          event.stopImmediatePropagation();
          setTimeout(() => { replay = true; request.dispatchEvent(new Event("success")); }, delay);
        });
      }
      return request;
    };
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "global-pins-focus-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await bot(hub, "bot", "助手");
    await direct(hub, "focus", "焦点对话", 30); await direct(hub, "peer", "同组对话", 20);
    await new ConversationFolders(hub.store.db).change("owner", { type: "create", id: "work", name: "工作", conversationId: "focus", revision: 0 });
    await pair(page, hub, "焦点主机"); await mode(page, "按对话").click();
    const row = desktopRow(page, hub, "focus"), region = globalRegion(sidebar(page));
    const work = sidebar(page).locator('.conversation-folder[data-folder-id="work"]'), heading = work.locator(".folder-heading");
    // GLOBAL_PIN_READ_DELAY=0 runs the same journey at native speed as a control.
    const delay = Number(process.env.GLOBAL_PIN_READ_DELAY ?? 250);
    const slow = (ms: number) => page.evaluate(ms => { (window as unknown as { slowGlobalPinReads: number }).slowGlobalPinReads = ms; }, ms);
    await slow(delay);

    await desktopAction(page, row, "全局置顶", true);
    await expect(region.locator(rowCss(hub, "focus"))).toBeVisible();
    await expect(row).toBeFocused();
    await desktopAction(page, row, "取消全局置顶", true);
    await expect(work.locator('.conversation-row[data-conversation-id="focus"]')).toBeVisible();
    await expect(row).toBeFocused();

    // Unpinning into a collapsed folder keeps it collapsed and focuses its heading.
    await desktopAction(page, row, "全局置顶", true);
    await expect(region.locator(rowCss(hub, "focus"))).toBeVisible();
    await heading.click(); await expect(heading).toHaveAttribute("aria-expanded", "false");
    await desktopAction(page, row, "取消全局置顶", true);
    await expect(region).toHaveCount(0);
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await expect(heading).toBeFocused();

    // The user moves to another conversation in the same host list before the
    // slow refresh commits. That deliberate focus wins over the pending intent,
    // including after the intent's own expiry window.
    await heading.click(); await expect(heading).toHaveAttribute("aria-expanded", "true");
    const peer = desktopRow(page, hub, "peer");
    await slow(delay ? 800 : 0);
    await desktopAction(page, row, "全局置顶", true);
    await peer.focus();
    await expect(region.locator(rowCss(hub, "focus"))).toBeVisible();
    // Report what holds focus (conversation ID or tag) instead of only "inactive".
    const focused = () => page.evaluate(() => { const node = document.activeElement as HTMLElement | null; return node?.dataset.conversationId ?? node?.tagName ?? null; });
    await expect.poll(focused, { timeout: 2_000 }).toBe("peer");
    await expect(peer).toBeFocused();
    await page.waitForTimeout(2_100);
    await expect.poll(focused, { timeout: 1_000 }).toBe("peer");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("English narrow desktop menu and phone sheet keep both pin labels readable and distinct from folder pinning", async ({ page }, info) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "global-pins-english-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const fits = (scope: Locator, role: "menuitem" | "button") => scope.getByRole(role).evaluateAll(nodes => nodes
    .filter(node => node.getClientRects().length && node.textContent?.trim())
    .filter(node => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().right > window.innerWidth + 1)
    .map(node => node.textContent!.trim()));
  try {
    await bot(hub, "bot", "Helper");
    await direct(hub, "weekly", "Weekly planning notes for the release review", 30); await direct(hub, "errands", "Errands", 20);
    await new ConversationFolders(hub.store.db).change("owner", { type: "create", id: "work", name: "Work", conversationId: "weekly", revision: 0 });
    await pair(page, hub, "English host"); await mode(page, "按对话").click();
    await openSettings(page, "general"); await page.locator("#language").selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en"); await closeSettings(page, true);
    await page.setViewportSize({ width: 800, height: 720 });
    const row = desktopRow(page, hub, "weekly"), open = page.getByRole("menu");
    await row.click({ button: "right" });
    const labels = await open.getByRole("menuitem").allTextContents();
    // The container-level pin applies to folders and Bot-list sections alike.
    // It must not read as folder pinning or as a group chat (“Groups”).
    expect(labels.filter(label => /^(Pin|Unpin)/.test(label))).toEqual(["Pin to top", "Pin in section"]);
    expect(await fits(open, "menuitem")).toEqual([]);
    await page.screenshot({ path: info.outputPath("english-desktop-menu.png") });
    await open.getByRole("menuitem", { name: "Pin to top", exact: true }).click();
    const section = sidebar(page).locator(".global-pin-section");
    await expect(section).toHaveCount(1);
    await expect(sidebar(page).getByRole("region", { name: "Pinned to top", exact: true })).toHaveCount(1);
    await expect(section.locator(rowCss(hub, "weekly"))).toBeVisible();
    await expect(section.getByText("Pinned", { exact: true })).toBeVisible();
    await row.click({ button: "right" });
    await expect(open.getByRole("menuitem", { name: "Unpin from top", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 320, height: 700 });
    for (const name of ["Back to chat", "Open conversation list"]) { const back = page.getByRole("button", { name, exact: true }); if (await back.isVisible()) await back.click(); }
    await expect(mobileHome(page)).toHaveAttribute("data-tab", "messages");
    const phone = phoneRow(page, hub, "weekly"), actions = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Unpin from top", exact: true }) });
    await phone.press("Shift+F10");
    await expect(actions).toBeVisible();
    expect(await fits(actions, "button")).toEqual([]);
    await page.screenshot({ path: info.outputPath("english-phone-sheet-320.png"), animations: "disabled" });
    await actions.getByRole("button", { name: "Unpin from top", exact: true }).click();
    await expect(actions).toHaveCount(0);
    await expect(mobileHome(page).locator(".global-pin-section")).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("local pin lists stay independent, atomic, validated and host-scoped in real IndexedDB", async ({ page }) => {
  const key = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0]! + "e2e/fixtures/multiple-hosts.html");
    await page.waitForFunction(() => !!(window as unknown as { multipleHosts?: unknown }).multipleHosts);
    const result = await page.evaluate(async keys => {
      const f = (window as unknown as { multipleHosts: typeof multipleHosts }).multipleHosts;
      const handles = [];
      for (const [i, hubPublicKey] of keys.entries()) {
        const record = await f.registry.add({ deviceId: `device_${i}`, name: "同名电脑", publicKey: "fixture", hubPublicKey, routes: [] }, "同名电脑");
        handles.push((await f.registry.open(record.id))!);
      }
      const [a, b] = handles as [NonNullable<typeof handles[number]>, NonNullable<typeof handles[number]>];
      const ids = Array.from({ length: 24 }, (_, i) => `chat_${i}`);
      const sorted = async (scope?: "global") => (await a.cache.pins(scope)).sort();
      const raw = async (name: string) => { const db = await (a.cache as unknown as { db: Promise<{ get(store: string, key: string): Promise<unknown> }> }).db; return JSON.parse(String(await db.get("settings", name))) as unknown; };
      // Interleaved concurrent writes to both lists; each is its own transaction.
      await Promise.all(ids.flatMap((id, i) => [a.cache.setPinned(id, true, "global"), ...(i % 2 ? [a.cache.setPinned(id, true)] : [])]));
      const pinned = { global: await sorted("global"), group: await sorted() };
      await Promise.all(ids.map((id, i) => i % 3 ? a.cache.setPinned(id, false, "global") : a.cache.setPinned(id, false)));
      const unpinned = { global: await sorted("global"), group: await sorted() };
      await Promise.all([a.cache.setPinned("twice", true, "global"), a.cache.setPinned("twice", true, "global"), b.cache.setPinned("twice", true)]);
      const stored = (await raw("globalPins") as string[]).filter(id => id === "twice").length;
      const other = { global: await b.cache.pins("global"), group: await b.cache.pins() };
      await a.cache.savePins(["x", "x", 5, null] as unknown as string[]);
      const db = await (a.cache as unknown as { db: Promise<{ put(store: string, value: unknown, key: string): Promise<unknown> }> }).db;
      await db.put("settings", JSON.stringify({ not: "a list" }), "globalPins");
      const corrupt = { group: await a.cache.pins(), global: await a.cache.pins("global") };
      await db.put("settings", "{", "globalPins");
      const unreadable = await a.cache.pins("global");
      await a.cache.setPinned("fresh", true, "global");
      const recovered = await a.cache.pins("global");
      await a.cache.forgetIdentity();
      const cleared = { group: await a.cache.pins(), global: await a.cache.pins("global"), otherHost: await b.cache.pins() };
      return { ids, pinned, unpinned, stored, other, corrupt, unreadable, recovered, cleared };
    }, [key(), key()]);
    const { ids } = result;
    expect(result.pinned).toEqual({ global: [...ids].sort(), group: ids.filter((_, i) => i % 2).sort() });
    expect(result.unpinned).toEqual({ global: ids.filter((_, i) => i % 3 === 0).sort(), group: ids.filter((_, i) => i % 2 && i % 3).sort() });
    expect(result.stored).toBe(1);
    expect(result.other).toEqual({ global: [], group: ["twice"] });
    expect(result.corrupt).toEqual({ group: ["x"], global: [] });
    expect(result.unreadable).toEqual([]);
    expect(result.recovered).toEqual(["fresh"]);
    expect(result.cleared).toEqual({ group: [], global: [], otherHost: ["twice"] });
  } finally { await server.close(); }
});
