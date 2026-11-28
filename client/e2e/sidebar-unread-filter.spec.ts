import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { ConversationFolders } from "../../src/hub/conversation-folders.js";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { openMobileHome, setListOption } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");
const sidebar = (page: Page) => workspace(page).locator(".sidebar");

async function pair(page: Page, hub: HubServer, name: string, add = false) {
  await hub.store.db.run(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })],
  );
  if (add) await clickAppAction(page, "连接另一台主机", workspace(page).getByRole("button", { name: "连接另一台主机", exact: true }));
  else await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill(name);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
}

test("desktop sidebar Unread filter lists unread across bots, hosts, folders and retains open chat until navigating away", async ({ page }) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "sidebar-unread-filter-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  try {
    await a.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','Alpha Bot','fixture',1),('beta','Beta Bot','fixture',1)");
    await b.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('gamma','Gamma Bot','fixture',1),('delta','Delta Bot','fixture',1)");

    // Seed 30+ conversations across both hosts and multiple bots.
    const aRead = [];
    for (let i = 0; i < 16; i++) {
      aRead.push(await a.store.createConversation("owner", [i % 2 === 0 ? "alpha" : "beta"], `A Read ${i + 1}`, `a_read_${i}`));
    }
    const bRead = [];
    for (let i = 0; i < 14; i++) {
      bRead.push(await b.store.createConversation("owner", [i % 2 === 0 ? "gamma" : "delta"], `B Read ${i + 1}`, `b_read_${i}`));
    }

    const unreadA = await a.store.createConversation("owner", ["alpha"], "Alpha Unread", "a_unread_1");
    const unreadB = await b.store.createConversation("owner", ["gamma"], "Gamma Unread", "b_unread_1");
    const archivedUnread = await a.store.createConversation("owner", ["beta"], "Archived Unread", "a_archived");
    await a.store.updateConversation("owner", archivedUnread.id, { archived: true });

    await new ConversationFolders(a.store.db).change("owner", { type: "create", id: "work", name: "Work", conversationId: unreadA.id, revision: 0 });
    await new ConversationFolders(b.store.db).change("owner", { type: "create", id: "ops", name: "Ops", conversationId: bRead[0]!.id, revision: 0 });

    await pair(page, a, "macmini");
    await pair(page, b, "studio-b", true);

    // Visit read conversations on both hosts so both workspaces are mounted with a read selection.
    await sidebar(page).locator(`[data-conversation-id="${bRead[0]!.id}"]`).click();
    await expect(workspace(page).getByRole("heading", { name: "B Read 1", exact: true })).toBeVisible();
    await sidebar(page).locator(`[data-conversation-id="${aRead[0]!.id}"]`).click();
    await expect(workspace(page).getByRole("heading", { name: "A Read 1", exact: true })).toBeVisible();

    // Publish unread messages: 2 on macmini, 1 on studio-b, 5 on archived (excluded).
    await a.store.publishBotMessage("alpha", { conversationId: unreadA.id, blocks: [{ type: "text", text: "Unread A-1" }] });
    await a.store.publishBotMessage("alpha", { conversationId: unreadA.id, blocks: [{ type: "text", text: "Unread A-2" }] });
    await b.store.publishBotMessage("gamma", { conversationId: unreadB.id, blocks: [{ type: "text", text: "Unread B-1" }] });
    for (let i = 0; i < 5; i++) {
      await a.store.publishBotMessage("beta", { conversationId: archivedUnread.id, blocks: [{ type: "text", text: `Archived ${i}` }] });
    }

    const filterGroup = sidebar(page).getByRole("group", { name: "筛选会话", exact: true });
    const allChip = filterGroup.getByRole("button", { name: "全部", exact: true });
    const unreadChip = filterGroup.getByRole("button", { name: /^未读/ });

    // Total equals title and excludes archived unread.
    await expect(page).toHaveTitle("(3) TaroBird", { timeout: 20_000 });
    await expect(unreadChip.locator(".sidebar-unread-total")).toHaveText("3");
    await expect(allChip).toHaveAttribute("aria-pressed", "true");

    // Fold Alpha Bot before filtering to confirm Unread auto-expands matching Bots.
    await sidebar(page).locator('.bot-tree[data-bot-id="alpha"] .bot-tree-toggle').click();
    await expect(sidebar(page).locator('.bot-tree[data-bot-id="alpha"]')).toHaveAttribute("data-collapsed", "true");

    // Activate Unread filter via keyboard.
    await unreadChip.focus();
    await page.keyboard.press("Enter");
    await expect(unreadChip).toHaveAttribute("aria-pressed", "true");

    // Only Alpha Bot (1 unread row) and Gamma Bot (1 unread row) appear; Beta/Delta & read rows vanish.
    await expect(sidebar(page).locator(".bot-tree")).toHaveCount(2);
    await expect(sidebar(page).locator(".conversation-row")).toHaveCount(2);
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadB.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(`[data-conversation-id="${archivedUnread.id}"]`)).toHaveCount(0);

    // Switch to By chat (folders) layout: only folders/sections with unread rows appear.
    await sidebar(page).getByRole("button", { name: "按对话", exact: true }).click();
    await expect(sidebar(page).locator(".conversation-row")).toHaveCount(2);
    await expect(sidebar(page).locator('.conversation-folder[data-folder-id="work"]')).toBeVisible();
    await expect(sidebar(page).locator('.conversation-folder[data-folder-id="ops"]')).toHaveCount(0);

    // Switch to group-by-host: only hosts with unread rows appear.
    await setListOption(page, "按主机分组", true);
    await expect(sidebar(page).locator(".host-directory-section")).toHaveCount(2);
    await setListOption(page, "按主机分组", false);

    // Narrowest desktop sidebar (200px) fits filter chips without overflow.
    const separator = workspace(page).getByRole("separator", { name: "调整侧栏宽度" });
    await separator.focus();
    await page.keyboard.press("Home");
    expect(await sidebar(page).locator(".sidebar-unread-filter").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await separator.dblclick();

    // Open Gamma Unread (on previously visited studio-b): it marks read, total drops from 3 to 2, row stays visible while open!
    await sidebar(page).locator(`[data-conversation-id="${unreadB.id}"]`).click();
    await expect(workspace(page).getByRole("heading", { name: "Gamma Unread", exact: true })).toBeVisible();
    await expect(page).toHaveTitle("(2) TaroBird", { timeout: 20_000 });
    await expect(unreadChip.locator(".sidebar-unread-total")).toHaveText("2");
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadB.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadB.id}"]`)).toHaveAttribute("aria-current", "page");
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadB.id}"] .unread-badge`)).toHaveCount(0);

    // Re-clicking the open retained row or active Unread chip keeps it visible.
    await sidebar(page).locator(`[data-conversation-id="${unreadB.id}"]`).click();
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadB.id}"]`)).toBeVisible();
    await unreadChip.click();
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadB.id}"]`)).toBeVisible();

    // Navigate to Alpha Unread (on macmini): Gamma Unread leaves the list; Alpha Unread marks read, total drops to 0!
    await sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`).click();
    await expect(workspace(page).getByRole("heading", { name: "Alpha Unread", exact: true })).toBeVisible();
    await expect(page).toHaveTitle("TaroBird", { timeout: 20_000 });
    await expect(unreadChip.locator(".sidebar-unread-total")).toHaveCount(0);
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadB.id}"]`)).toHaveCount(0);
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`)).toBeVisible();

    // Toggle back to All and back to Unread: Alpha Unread is now read, so empty state shows.
    await allChip.click();
    await expect(allChip).toHaveAttribute("aria-pressed", "true");
    await expect(sidebar(page).locator(".conversation-row")).toHaveCount(32);
    await unreadChip.click();
    await expect(sidebar(page).locator(".conversation-row")).toHaveCount(0);
    await expect(sidebar(page).locator(".empty-sidebar")).toHaveText("没有未读会话");

    // Phone layout keeps mobile filter bar and hides desktop filter bar.
    await page.setViewportSize({ width: 390, height: 844 });
    await openMobileHome(page);
    await expect(workspace(page).locator(".mobile-home .mh-filters")).toBeVisible();
    await expect(sidebar(page).locator(".sidebar-unread-filter")).toBeHidden();
  } finally {
    await page.close();
    await a.close();
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("single-host By Bot Unread view does not render empty state below globally pinned unread conversations", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "sidebar-unread-global-pin-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','Alpha Bot','fixture',1)");
    const readChat = await hub.store.createConversation("owner", ["alpha"], "Alpha Read", "a_read");
    const pinnedChat = await hub.store.createConversation("owner", ["alpha"], "Pinned Unread", "a_pinned");

    await pair(page, hub, "macmini");
    await sidebar(page).locator(`[data-conversation-id="${readChat.id}"]`).click();
    await expect(workspace(page).getByRole("heading", { name: "Alpha Read", exact: true })).toBeVisible();

    // Globally pin the second conversation via its context menu.
    await sidebar(page).locator(`[data-conversation-id="${pinnedChat.id}"]`).click({ button: "right" });
    await page.getByRole("menu", { name: "对话操作", exact: true }).getByRole("menuitem", { name: "全局置顶", exact: true }).click();
    const globalRegion = sidebar(page).getByRole("region", { name: "已全局置顶", exact: true });
    await expect(globalRegion.locator(`[data-conversation-id="${pinnedChat.id}"]`)).toBeVisible();

    await hub.store.publishBotMessage("alpha", { conversationId: pinnedChat.id, blocks: [{ type: "text", text: "Pinned ping" }] });
    await expect(page).toHaveTitle("(1) TaroBird", { timeout: 20_000 });

    const filterGroup = sidebar(page).getByRole("group", { name: "筛选会话", exact: true });
    const allChip = filterGroup.getByRole("button", { name: "全部", exact: true });
    const unreadChip = filterGroup.getByRole("button", { name: /^未读/ });
    await expect(unreadChip.locator(".sidebar-unread-total")).toHaveText("1");

    // Default By Bot layout: globally pinned unread row renders with no empty-sidebar state beneath it.
    await unreadChip.click();
    await expect(unreadChip).toHaveAttribute("aria-pressed", "true");
    await expect(globalRegion.locator(`[data-conversation-id="${pinnedChat.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(".empty-sidebar")).toHaveCount(0);
    await expect(sidebar(page).locator(".host-directory-section")).toHaveCount(0);

    // By chat layout also shows the global pin without an empty state.
    await sidebar(page).getByRole("button", { name: "按对话", exact: true }).click();
    await expect(globalRegion.locator(`[data-conversation-id="${pinnedChat.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(".empty-sidebar")).toHaveCount(0);

    // Opening the pinned unread chat in By Bot layout marks it read and retains it cleanly.
    await sidebar(page).getByRole("button", { name: "按 Bot", exact: true }).click();
    await globalRegion.locator(`[data-conversation-id="${pinnedChat.id}"]`).click();
    await expect(workspace(page).getByRole("heading", { name: "Pinned Unread", exact: true })).toBeVisible();
    await expect(page).toHaveTitle("TaroBird", { timeout: 20_000 });
    await expect(globalRegion.locator(`[data-conversation-id="${pinnedChat.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(".empty-sidebar")).toHaveCount(0);

    // Re-clicking the retained pinned row or active Unread chip keeps it visible without an empty state.
    await globalRegion.locator(`[data-conversation-id="${pinnedChat.id}"]`).click();
    await unreadChip.click();
    await expect(globalRegion.locator(`[data-conversation-id="${pinnedChat.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(".empty-sidebar")).toHaveCount(0);

    // Toggling All -> Unread once read shows the single empty state.
    await allChip.click();
    await unreadChip.click();
    await expect(globalRegion).toHaveCount(0);
    await expect(sidebar(page).locator(".empty-sidebar")).toHaveCount(1);
    await expect(sidebar(page).locator(".empty-sidebar")).toHaveText("没有未读会话");
  } finally {
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Unread filter resets 0-unread host filter, preserves retained chat on re-click/Bot header, and clears retained chat when switching to an empty host", async ({ page }) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "sidebar-unread-host-switch-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  try {
    await a.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','Alpha Bot','fixture',1)");
    const readA = await a.store.createConversation("owner", ["alpha"], "Alpha Read", "a_read");
    const unreadA = await a.store.createConversation("owner", ["alpha"], "Alpha Unread", "a_unread");

    await pair(page, a, "macmini");
    await pair(page, b, "studio-empty", true);

    await sidebar(page).locator(`[data-conversation-id="${readA.id}"]`).click();
    await expect(workspace(page).getByRole("heading", { name: "Alpha Read", exact: true })).toBeVisible();

    await a.store.publishBotMessage("alpha", { conversationId: unreadA.id, blocks: [{ type: "text", text: "Unread 1" }] });
    await a.store.publishBotMessage("alpha", { conversationId: unreadA.id, blocks: [{ type: "text", text: "Unread 2" }] });

    const filterGroup = sidebar(page).getByRole("group", { name: "筛选会话", exact: true });
    const unreadChip = filterGroup.getByRole("button", { name: /^未读/ });
    const hostSelect = sidebar(page).getByLabel("筛选运行主机", { exact: true });

    await expect(page).toHaveTitle("(2) TaroBird", { timeout: 20_000 });
    await expect(unreadChip.locator(".sidebar-unread-total")).toHaveText("2");

    // Scope host dropdown to the 0-unread host while the other host has 2 unread messages.
    await hostSelect.selectOption({ label: "studio-empty" });
    await expect(workspace(page).getByRole("heading", { name: "欢迎回来", exact: true })).toBeVisible();
    await expect(unreadChip.locator(".sidebar-unread-total")).toHaveText("2");

    // Clicking Unread (2) resets the host filter so all unread chats appear in one click.
    await unreadChip.click();
    await expect(unreadChip).toHaveAttribute("aria-pressed", "true");
    await expect(hostSelect).toHaveValue("");
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(".empty-sidebar")).toHaveCount(0);

    // Open Alpha Unread in By Bot layout -> marks read and stays retained.
    await sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`).click();
    await expect(workspace(page).getByRole("heading", { name: "Alpha Unread", exact: true })).toBeVisible();
    await expect(page).toHaveTitle("TaroBird", { timeout: 20_000 });
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadA.id}"] .unread-badge`)).toHaveCount(0);

    // Re-clicking the open row, its Bot header, or the active Unread chip keeps it visible.
    await sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`).click();
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`)).toBeVisible();
    await sidebar(page).locator('.bot-tree[data-bot-id="alpha"] .bot-identity').click();
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`)).toBeVisible();
    await unreadChip.click();
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`)).toBeVisible();

    // Switching to the host with 0 conversations clears retainedOpen so stale read rows do not linger.
    await hostSelect.selectOption({ label: "studio-empty" });
    await expect(workspace(page).getByRole("heading", { name: "欢迎回来", exact: true })).toBeVisible();
    await hostSelect.selectOption("");
    await expect(workspace(page).getByRole("heading", { name: "欢迎回来", exact: true })).toBeVisible();
    await expect(sidebar(page).locator(`[data-conversation-id="${unreadA.id}"]`)).toHaveCount(0);
    await expect(sidebar(page).locator(".empty-sidebar")).toHaveText("没有未读会话");
  } finally {
    await page.close();
    await a.close();
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop 待处理 filter lists chats where a Bot waits for an answer to a question, not command approvals", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "sidebar-pending-filter-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','Alpha Bot','fixture',1),('beta','Beta Bot','fixture',1)");
    const quiet = await hub.store.createConversation("owner", ["alpha"], "Quiet Chat", "p_quiet");
    const asking = await hub.store.createConversation("owner", ["alpha"], "Needs Answer", "p_ask");
    const approving = await hub.store.createConversation("owner", ["beta"], "Needs Approval", "p_approve");

    await pair(page, hub, "macmini");
    await sidebar(page).locator(`[data-conversation-id="${quiet.id}"]`).click();
    await expect(workspace(page).getByRole("heading", { name: "Quiet Chat", exact: true })).toBeVisible();

    const filterGroup = sidebar(page).getByRole("group", { name: "筛选会话", exact: true });
    const allChip = filterGroup.getByRole("button", { name: "全部", exact: true });
    const unreadChip = filterGroup.getByRole("button", { name: /^未读/ });
    const pendingChip = filterGroup.getByRole("button", { name: /^待处理/ });
    // Nothing to answer yet: no count, and the filter has its own empty state.
    await expect(pendingChip.locator(".sidebar-pending-total")).toHaveCount(0);
    await pendingChip.click();
    await expect(sidebar(page).locator(".empty-sidebar")).toHaveText("没有等你回答的问题");
    await allChip.click();

    await hub.store.publishBotMessage("alpha", { conversationId: asking.id, blocks: [{ type: "card", title: "需要选择", elements: [{ type: "button", text: "提交", actionId: "askq_submit", value: { cctb_lark: "ask_user_question", action: "form_submit", requestId: "question" } }] }] });
    await hub.store.publishBotMessage("beta", { conversationId: approving.id, blocks: [{ type: "card", title: "需要批准", elements: [{ type: "button", text: "允许此次", actionId: "approve", value: { cctb_lark: "approval", decision: "allow_once", requestId: "approval" } }] }] });

    // One question waits; the approval is not counted.
    await expect(pendingChip.locator(".sidebar-pending-total")).toHaveText("1", { timeout: 20_000 });
    await expect(pendingChip).toHaveAttribute("aria-pressed", "false");

    await pendingChip.click();
    await expect(pendingChip).toHaveAttribute("aria-pressed", "true");
    await expect(allChip).toHaveAttribute("aria-pressed", "false");
    await expect(unreadChip).toHaveAttribute("aria-pressed", "false");
    await expect(sidebar(page).locator(`[data-conversation-id="${asking.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(`[data-conversation-id="${approving.id}"]`)).toHaveCount(0);
    await expect(sidebar(page).locator(`[data-conversation-id="${quiet.id}"]`)).toHaveCount(0);

    // The By chat layout filters the same way.
    await sidebar(page).getByRole("button", { name: "按对话", exact: true }).click();
    await expect(sidebar(page).locator(`[data-conversation-id="${asking.id}"]`)).toBeVisible();
    await expect(sidebar(page).locator(`[data-conversation-id="${approving.id}"]`)).toHaveCount(0);
    await sidebar(page).getByRole("button", { name: "按 Bot", exact: true }).click();

    // 未读 still lists unread chats, including the approval; 全部 shows everything again.
    await unreadChip.click();
    await expect(unreadChip).toHaveAttribute("aria-pressed", "true");
    await expect(sidebar(page).locator(`[data-conversation-id="${approving.id}"]`)).toBeVisible();
    await allChip.click();
    await expect(sidebar(page).locator(`[data-conversation-id="${quiet.id}"]`)).toBeVisible();
  } finally {
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
