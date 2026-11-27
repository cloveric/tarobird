import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import type { OsProcessSample } from "../../src/hub/host-resources.js";
import { HubServer } from "../../src/hub/server.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { mobileHome, openMobileHome, waitForClientOnline } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";

test.use({ serviceWorkers: "block", actionTimeout: 15_000 });

const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");

async function pair(page: Page, hub: HubServer, name: string, add = false) {
  await hub.store.db.run(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })],
  );
  if (add) await clickAppAction(page, "连接另一台主机");
  else await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill(name);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}

async function openResourcesFromSidebar(page: Page) {
  await workspace(page).getByRole("button", { name: /^工作台：/ }).click();
  await page.getByRole("button", { name: "资源管理", exact: true }).filter({ visible: true }).click();
}

test("desktop Resource Manager is reachable from WelcomeHome and rail, separates stop payloads, and shows inline stop errors", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resources-panel-ui-"));
  const hubPid = process.pid;
  const samples: OsProcessSample[] = [
    { pid: hubPid, ppid: 1, cpuPercent: 1.5, memoryBytes: 120 * 1024 * 1024, name: "node" },
    { pid: 4000, ppid: 1, cpuPercent: 2.0, memoryBytes: 150 * 1024 * 1024, name: "tarocub-client" },
    { pid: 4001, ppid: 4000, cpuPercent: 3.0, memoryBytes: 210 * 1024 * 1024, name: "TaroBird Helper (Renderer)" },
    { pid: 7001, ppid: hubPid, cpuPercent: 0.5, memoryBytes: 40 * 1024 * 1024, name: "node" },
    { pid: 7101, ppid: 7001, cpuPercent: 22.0, memoryBytes: 380 * 1024 * 1024, name: "codex" },
    { pid: 7102, ppid: 7101, cpuPercent: 45.0, memoryBytes: 512 * 1024 * 1024, name: "pytest" },
  ];
  const stopPayloads: Array<Record<string, unknown>> = [];
  const killedPids: number[] = [];
  let failNextStop = false;

  const hub = await HubServer.start({
    stateDir: path.join(root, "hub-a"),
    clientDir: path.resolve("dist"),
    hostResourcesSampler: async () => samples,
    hostResourcesBotPids: () => new Map([["bot_alpha", 7001]]),
    hostResourcesKillPid: async (pid) => { killedPids.push(pid); },
    hostResourcesStopBotTurn: async () => true,
  });

  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_alpha','Alpha Bot','codex','h1',1)");
    const conv = await hub.store.createConversation("owner", ["bot_alpha"], "Alpha Refactor", "conv_alpha", { type: "direct" });
    await hub.store.db.run(
      "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('msg_a',?,'bot_alpha','bot',?,'streaming',1,?)",
      [conv.id, JSON.stringify([{ type: "text", text: "running…" }]), Date.now()],
    );

    const resourceGetUrls: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "GET" && new URL(req.url()).pathname === "/api/host-resources") {
        resourceGetUrls.push(req.url());
      }
    });
    await page.route("**/api/host-resources/stop", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      stopPayloads.push(body);
      if (failNextStop) {
        failNextStop = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "stop_unavailable" }) });
        return;
      }
      await route.continue();
    });

    await pair(page, hub, "主机甲");

    // 0. Zero background /api/host-resources requests while the dialog is closed,
    //    even after opening the Workspace Rail (which renders ResourcesTriggerButton).
    await workspace(page).locator(".conversation-row").filter({ hasText: "Alpha Refactor" }).click();
    await workspace(page).getByRole("button", { name: "会话工作区", exact: true }).click();
    const railFooterBtn = workspace(page).locator("aside.conversation-workspace-rail").getByRole("button", { name: "资源", exact: true });
    await expect(railFooterBtn).toBeVisible();
    await page.waitForTimeout(500);
    expect(resourceGetUrls).toEqual([]);

    // Close Workspace Rail so we also prove persistent sidebar WorkspaceFooter works when rail is closed
    await workspace(page).getByRole("button", { name: "会话工作区", exact: true }).click();
    await expect(page.locator("aside.conversation-workspace-rail")).toHaveCount(0);

    // 1. Reachable directly from persistent sidebar WorkspaceFooter even while Workspace Rail is closed!
    await openResourcesFromSidebar(page);
    const dialog = page.getByRole("dialog", { name: "资源管理", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("桌面应用");
    await expect(dialog).toContainText("Alpha Bot");
    await expect(dialog).toContainText("Alpha Refactor");
    await expect(dialog).toContainText("PID 7101");
    await expect(dialog).toContainText("PID 7102");
    expect(resourceGetUrls.length).toBeGreaterThanOrEqual(1);

    // 2. Conversation Stop sends `{ botId, conversationId }` ONLY (never `pid`), and shows inline error on failure
    failNextStop = true;
    await dialog.getByRole("button", { name: "停止 Alpha Refactor 中的运行", exact: true }).click();
    const convConfirm = page.getByRole("dialog", { name: "确认停止当前运行？", exact: true });
    await expect(convConfirm).toBeVisible();
    await convConfirm.getByRole("button", { name: "确认停止", exact: true }).click();
    // Error renders visibly INSIDE the open confirmation dialog (not behind backdrop)
    await expect(convConfirm.getByRole("alert")).toContainText("停止进程失败");
    expect(stopPayloads[0]).toEqual({ botId: "bot_alpha", conversationId: conv.id });

    // Retry conversation stop -> succeeds cleanly without killing any PID
    await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
    await convConfirm.getByRole("button", { name: "确认停止", exact: true }).click();
    await expect(convConfirm).toBeHidden();
    await expect(dialog.locator(".resources-notice")).toContainText("已请求停止「Alpha Refactor」中的运行。");
    expect(stopPayloads[1]).toEqual({ botId: "bot_alpha", conversationId: conv.id });
    expect(killedPids).toEqual([]);

    // 3. Per-process Stop inside multi-process conversation sends `{ botId, pid }` ONLY (never `conversationId`)
    await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
    await dialog.getByRole("button", { name: "停止进程 7102", exact: true }).click();
    const procConfirm = page.getByRole("dialog", { name: "确认终止进程？", exact: true });
    await expect(procConfirm).toBeVisible();
    await expect(procConfirm).toContainText("直接终止");
    await expect(procConfirm).toContainText("PID 7102");
    await procConfirm.getByRole("button", { name: "确认终止", exact: true }).click();
    await expect(procConfirm).toBeHidden();
    await expect(dialog.locator(".resources-notice")).toContainText("已终止进程 pytest（PID 7102）。");
    expect(stopPayloads[2]).toEqual({ botId: "bot_alpha", pid: 7102 });
    expect(killedPids).toEqual([7102]);

    await dialog.getByRole("button", { name: "关闭资源面板", exact: true }).click();
    await expect(dialog).toBeHidden();

    // 4. Also reachable from Workspace Rail footer button when a conversation + rail is open
    await workspace(page).getByRole("button", { name: "会话工作区", exact: true }).click();
    await expect(railFooterBtn).toBeVisible();
    await railFooterBtn.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "关闭资源面板", exact: true }).click();
    await expect(dialog).toBeHidden();

    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("switching hosts ignores stale responses and keeps the modal usable when a target host goes offline", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resources-panel-multihost-"));
  const hubPid = process.pid;

  const hubA = await HubServer.start({
    stateDir: path.join(root, "hub-a"),
    clientDir: path.resolve("dist"),
    hostResourcesSampler: async () => [
      { pid: hubPid, ppid: 1, cpuPercent: 1.0, memoryBytes: 100 * 1024 * 1024, name: "node" },
      { pid: 7001, ppid: hubPid, cpuPercent: 1.0, memoryBytes: 40 * 1024 * 1024, name: "node" },
      { pid: 7101, ppid: 7001, cpuPercent: 15.0, memoryBytes: 300 * 1024 * 1024, name: "codex" },
    ],
    hostResourcesBotPids: () => new Map([["bot_a", 7001]]),
  });
  const hubB = await HubServer.start({
    stateDir: path.join(root, "hub-b"),
    origins: [hubA.url],
    hostResourcesSampler: async () => [
      { pid: hubPid, ppid: 1, cpuPercent: 2.0, memoryBytes: 110 * 1024 * 1024, name: "node" },
      { pid: 8001, ppid: hubPid, cpuPercent: 1.5, memoryBytes: 50 * 1024 * 1024, name: "node" },
      { pid: 8101, ppid: 8001, cpuPercent: 25.0, memoryBytes: 450 * 1024 * 1024, name: "claude" },
    ],
    hostResourcesBotPids: () => new Map([["bot_b", 8001]]),
  });

  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  let hubBClosed = false;
  try {
    await hubA.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_a','Alpha Host Bot','codex','ha',1)");
    await hubB.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_b','Beta Host Bot','claude','hb',1)");

    await pair(page, hubA, "主机甲", false);
    await pair(page, hubB, "主机乙", true);

    // Delay Host A's /api/host-resources request so it resolves AFTER switching to Host B
    let releaseHostA!: () => void;
    let holdHostA = true;
    const hostAHeld = new Promise<void>((resolve) => { releaseHostA = resolve; });
    let hostARequestSeen!: () => void;
    const hostARequestPromise = new Promise<void>((resolve) => { hostARequestSeen = resolve; });

    await page.route(`${hubA.url}/api/host-resources*`, async (route) => {
      if (holdHostA) {
        holdHostA = false;
        hostARequestSeen();
        await hostAHeld;
      }
      await route.continue();
    });

    // Verify persistent sidebar entry works on WelcomeHome (zero conversations selected!)
    await expect(workspace(page).getByRole("heading", { name: "欢迎回来", exact: true })).toBeVisible();
    await openResourcesFromSidebar(page);
    const dialog = page.getByRole("dialog", { name: "资源管理", exact: true });
    await expect(dialog).toBeVisible();

    const hostSelect = dialog.getByRole("combobox", { name: "切换主机", exact: true });
    // Ensure Host A is selected to start the slow request
    await hostSelect.selectOption({ label: "主机甲" });
    await hostARequestPromise;

    // Switch immediately to Host B while Host A's request is still in flight
    await hostSelect.selectOption({ label: "主机乙" });
    await expect(dialog).toContainText("Beta Host Bot");

    // Release Host A's delayed response and confirm it NEVER overwrites Host B's data
    releaseHostA();
    await page.waitForTimeout(250);
    await expect(dialog).toContainText("Beta Host Bot");
    await expect(dialog).not.toContainText("Alpha Host Bot");

    // Take Host B offline while the dialog is open: dialog MUST NOT vanish!
    await hubB.close();
    hubBClosed = true;
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/主机「主机乙」当前离线|正在连接「主机乙」/);
    await expect(hostSelect).toBeVisible();

    // Switching back to online Host A recovers cleanly inside the same dialog
    await hostSelect.selectOption({ label: "主机甲" });
    await expect(dialog).toContainText("Alpha Host Bot");

    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await hubA.close();
    if (!hubBClosed) await hubB.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("phone Host Resources view is reachable from the Host tools page, responsive, strictly read-only, and polls only while open", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resources-panel-phone-"));
  const hubPid = process.pid;
  const samples: OsProcessSample[] = [
    { pid: hubPid, ppid: 1, cpuPercent: 1.8, memoryBytes: 115 * 1024 * 1024, name: "node" },
    { pid: 7001, ppid: hubPid, cpuPercent: 0.6, memoryBytes: 42 * 1024 * 1024, name: "node" },
    { pid: 7101, ppid: 7001, cpuPercent: 28.5, memoryBytes: 410 * 1024 * 1024, name: "codex" },
    { pid: 7002, ppid: hubPid, cpuPercent: 0.4, memoryBytes: 38 * 1024 * 1024, name: "node" },
    { pid: 7202, ppid: 7002, cpuPercent: 52.0, memoryBytes: 220 * 1024 * 1024, name: "claude" },
  ];

  const hub = await HubServer.start({
    stateDir: path.join(root, "hub-phone"),
    clientDir: path.resolve("dist"),
    hostResourcesSampler: async () => samples,
    hostResourcesBotPids: () => new Map([["bot_alpha", 7001], ["bot_beta", 7002]]),
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    const now = Date.now();
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_alpha','Alpha Bot','codex','ha',1)");
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_beta','Beta Bot','claude','hb',1)");
    const convA = await hub.store.createConversation("owner", ["bot_alpha"], "Mobile Alpha Task", "conv_pa", { type: "direct" });
    const convB = await hub.store.createConversation("owner", ["bot_beta"], "Mobile Beta Task", "conv_pb", { type: "direct" });
    await hub.store.db.run(
      "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('msg_pa',?,'bot_alpha','bot',?,'streaming',1,?)",
      [convA.id, JSON.stringify([{ type: "text", text: "running…" }]), now],
    );
    await hub.store.db.run(
      "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('msg_pb',?,'bot_beta','bot',?,'streaming',1,?)",
      [convB.id, JSON.stringify([{ type: "text", text: "running…" }]), now + 100],
    );

    const resourceGets: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "GET" && new URL(req.url()).pathname === "/api/host-resources") {
        resourceGets.push(req.url());
      }
    });

    await pair(page, hub, "手机测试主机");
    await openMobileHome(page);

    // Zero /api/host-resources calls before opening Host Resources on phone.
    await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "我的", exact: true }).click();
    const entry = mobileHome(page).getByRole("button", { name: "资源管理", exact: true });
    await expect(entry).toBeVisible();
    await expect(entry).toContainText("CPU 与内存（只读）");
    expect(resourceGets).toEqual([]);

    // Open mobile Host Resources page.
    await entry.click();
    const dialog = page.getByRole("dialog", { name: "资源管理", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("手机端仅支持查看资源占用");
    await expect(dialog).toContainText("只读");
    await expect(dialog).toContainText("Alpha Bot");
    await expect(dialog).toContainText("Mobile Alpha Task");
    await expect(dialog).toContainText("Beta Bot");
    await expect(dialog).toContainText("Mobile Beta Task");
    await expect(dialog).toContainText("PID 7101");
    await expect(dialog).toContainText("PID 7202");

    // Strictly read-only on phone even for an owner device: zero Stop buttons anywhere in the dialog.
    await expect(dialog.locator(".resources-stop-btn")).toHaveCount(0);

    // Responsive check: zero horizontal overflow at 390px phone viewport.
    const overflow = await dialog.evaluate((node) => ({
      docScroll: document.documentElement.scrollWidth,
      docClient: document.documentElement.clientWidth,
      dialogScroll: node.scrollWidth,
      dialogClient: node.clientWidth,
    }));
    expect(overflow.docScroll).toBeLessThanOrEqual(overflow.docClient);
    expect(overflow.dialogScroll).toBeLessThanOrEqual(overflow.dialogClient);

    // Default sort is memory (Alpha Bot 452 MB before Beta Bot 258 MB); switching to CPU puts Beta Bot (52.4%) first.
    const botNames = dialog.locator(".resources-bot-name");
    await expect(botNames.first()).toHaveText("Alpha Bot");
    await dialog.getByRole("combobox", { name: "排序方式", exact: true }).selectOption("cpu");
    await expect(botNames.first()).toHaveText("Beta Bot");

    // Manual refresh sends ?force=1.
    const countBeforeRefresh = resourceGets.length;
    await dialog.getByRole("button", { name: "刷新资源", exact: true }).click();
    await expect.poll(() => resourceGets.length).toBeGreaterThan(countBeforeRefresh);
    expect(resourceGets.at(-1)).toContain("force=1");

    // Navigate back closes the phone page cleanly and stops polling.
    await dialog.getByRole("button", { name: "返回", exact: true }).click();
    await expect(dialog).toBeHidden();
    const countAfterClose = resourceGets.length;
    await page.waitForTimeout(400);
    expect(resourceGets.length).toBe(countAfterClose);

    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
