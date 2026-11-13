import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { expectOneDisclosure } from "./fixtures/disclosure-assertions.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ConversationFolders } from "../../src/hub/conversation-folders.js";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { HubAvatars } from "../../src/hub/avatars.js";
import { avatarDataUrl } from "../../tests/helpers/avatar-fixture.js";
import type { Block } from "../../src/client-protocol/index.js";
import type { AgentBusConfig, AgentBusDetail, AgentBusRun, AgentBusWorkspace } from "../../src/client-protocol/agent-bus.js";
import type { CollaborationSnapshot } from "../../src/client-protocol/collaboration.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { settleReadingLayout } from "./fixtures/reading-position.js";

// These are production App/Hub browser journeys. Pairing, directory, history,
// and ADHD persistence are real; Agent Bus responses are controlled fixtures.
// They prove UI/CAS/retry boundaries, not execution by a real agent or Bus.
test.use({ serviceWorkers: "block" });
const ids = ["main", "research", "analysis", "writer", "review"];
const names = ["协调助手", "研究助手", "分析助手", "写作助手", "审阅助手"];
const runIdFor = (userId: string, requestId: string) => `abr_${createHash("sha256").update(JSON.stringify([userId, requestId])).digest("hex").slice(0, 32)}`;
// The Hub derives a created workspace ID from the same owner/request identity.
const createdIdFor = (userId: string, requestId: string) => `ab_${createHash("sha256").update(JSON.stringify([userId, requestId])).digest("hex").slice(0, 32)}`;
// An external build keeps verification output outside the checkout.
const clientDir = process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist");
const panel = (page: Page) => page.getByRole("complementary", { name: "Agent Bus 设置与运行", exact: true });
const node = (page: Page, index: number) => panel(page).locator(`.agent-bus-flow-node[data-node-index="${index}"]`);
const slot = (page: Page, index: number) => panel(page).locator(`.agent-bus-slot[data-slot-index="${index}"]`);

async function seed(hub: HubServer, name = "测试主机") {
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  for (const [index, id] of ids.entries()) {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES(?,?,?,1)", [id, names[index], hashSecret(`fixture-${id}`)]);
    await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
    await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES(?,'direct',?,'owner',1,?)", [`chat_${id}`, `${names[index]}记录`, `chat_${id}`]);
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','owner',0)", [`chat_${id}`]);
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot',?,0)", [`chat_${id}`, id]);
    await hub.store.publishBotMessage(id, { conversationId: `chat_${id}`, status: "complete", blocks: [{ type: "text", text: `${name} · ${names[index]}的独立记录` }] });
  }
  await new HubAvatars(hub.store).set("owner", { kind: "bot", id: "main" }, { expectedRevision: 0, dataUrl: avatarDataUrl() });
}
async function pair(page: Page, hub: HubServer, name = "测试主机") {
  await page.getByLabel("主机名称", { exact: true }).fill(name);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}
function workspace(id = "bus_one", name = "产品评审"): AgentBusWorkspace {
  return { id, name, revision: "rev_1", mode: "chain", coordinator: { botId: "main", conversationId: "chat_main" }, members: [{ botId: "research", conversationId: "chat_research" }, { botId: "review", conversationId: "chat_review" }], maxResearchQuestions: 5, maxRevisionRounds: 1, createdAt: 1, updatedAt: 1 };
}
function snapshot(workspace: AgentBusWorkspace): AgentBusRun["snapshot"] {
  const { name, mode, coordinator, members, maxResearchQuestions, maxRevisionRounds } = workspace;
  return structuredClone({ name, mode, coordinator, members, maxResearchQuestions, maxRevisionRounds });
}
async function api(page: Page, hub: HubServer, initial: AgentBusWorkspace[] = []) {
  const details = new Map<string, AgentBusDetail>(initial.map(item => [item.id, { workspace: item, runs: [] }]));
  const createCalls: { requestId: string; config: AgentBusConfig }[] = [], updates: { revision: string; config: AgentBusConfig }[] = [], starts: { requestId: string; revision: string; text: string }[] = [];
  let loseCreate = false, loseStart = false, loseRead = false, loseUpdate = false, reads = 0, holdRestartsOffline = false, startFailure: string | undefined;
  const stops: { workspaceId: string; runId: string; requestId: string; abandon?: boolean }[] = [];
  const deletes: string[] = [], permissionReads: string[] = [], permissionWrites: { botId: string; revision: string; settings: CollaborationSnapshot["settings"] }[] = [], restarts: { botId: string; receiptId: string }[] = [];
  const permissions = new Map<string, CollaborationSnapshot>(ids.map(botId => [botId, { revision: "a".repeat(64), settings: { enabled: true, peers: ids.filter(id => id !== botId), maxDepth: 3, parallel: [], chain: [], verifier: null, crew: null }, listener: "online", peers: [] }]));
  const permissionFailures = new Map<string, string>();
  const restartExecutions = new Set<string>();
  const permissionSnapshot = (botId: string): CollaborationSnapshot => ({ ...structuredClone(permissions.get(botId)!), peers: ids.filter(id => id !== botId).map(id => {
    const peer = permissions.get(id)!;
    return { id, name: names[ids.indexOf(id)]!, online: true, allowsThisBot: peer.settings.enabled && (peer.settings.peers === "*" || peer.settings.peers.includes(botId)), listener: peer.listener };
  }) });
  let readGate: { entered: () => void; wait: Promise<void> } | undefined;
  const delayNextRead = () => {
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    readGate = { entered, wait }; return { entered: enteredPromise, release };
  };
  const createReceipts = new Map<string, AgentBusWorkspace>(), runReceipts = new Map<string, AgentBusRun>(), createdIds = new Map<string, string>();
  await page.route(`${hub.url}/api/bots/*/collaboration`, async route => {
    const request = route.request(), botId = new URL(request.url()).pathname.split("/")[3]!, operation = request.method() === "GET" ? "read" : "write";
    if (operation === "read") permissionReads.push(botId);
    else permissionWrites.push({ botId, ...request.postDataJSON() });
    const failureKey = `${operation}:${botId}`, failure = permissionFailures.get(failureKey);
    if (failure) { permissionFailures.delete(failureKey); await route.fulfill({ status: failure.includes("conflict") ? 409 : 503, json: { error: failure } }); return; }
    if (operation === "write") {
      const body = request.postDataJSON(), current = permissions.get(botId)!;
      if (body.revision !== current.revision) { await route.fulfill({ status: 409, json: { error: "collaboration_conflict" } }); return; }
      permissions.set(botId, { ...current, settings: structuredClone(body.settings), revision: permissionWrites.length.toString(16).padStart(64, "0") });
    }
    await route.fulfill({ json: permissionSnapshot(botId) });
  });
  await page.route(`${hub.url}/api/bots/*/restart`, async route => {
    const botId = new URL(route.request().url()).pathname.split("/")[3]!, body = route.request().postDataJSON();
    restarts.push({ botId, receiptId: body.receiptId });
    const failureKey = `restart:${botId}`, failure = permissionFailures.get(failureKey);
    if (failure) { permissionFailures.delete(failureKey); await route.fulfill({ json: { ok: false, error: failure } }); return; }
    if (!restartExecutions.has(body.receiptId)) {
      restartExecutions.add(body.receiptId);
      if (!holdRestartsOffline) permissions.get(botId)!.listener = "online";
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(`${hub.url}/api/agent-buses**`, async route => {
    const request = route.request(), parts = new URL(request.url()).pathname.split("/").filter(Boolean), id = parts[2];
    if (request.method() === "GET") {
      if (!id) { await route.fulfill({ json: { items: [...details.values()].map(item => item.workspace) } }); return; }
      reads++; if (loseRead) { loseRead = false; await route.abort("failed"); return; }
      const known = createdIds.get(id) ?? id;
      if (!details.has(known)) { await route.fulfill({ status: 404, json: { error: "agent_bus_not_found" } }); return; }
      const value = structuredClone(details.get(known)), gate = readGate; readGate = undefined;
      if (gate) { gate.entered(); await gate.wait; }
      await route.fulfill({ json: value }); return;
    }
    if (!id && request.method() === "POST") {
      const body = request.postDataJSON(); createCalls.push(body);
      let item = createReceipts.get(body.requestId);
      if (!item) {
        const config = body.config as AgentBusConfig;
        item = { ...workspace(`bus_${details.size + 1}`, config.name), ...config, coordinator: { botId: config.coordinator.botId, conversationId: config.coordinator.conversationId ?? `chat_${config.coordinator.botId}` }, members: config.members.map(member => ({ botId: member.botId, conversationId: member.conversationId ?? `chat_${member.botId}` })) };
        createReceipts.set(body.requestId, item); details.set(item.id, { workspace: item, runs: [] }); createdIds.set(createdIdFor("owner", body.requestId), item.id);
      }
      if (loseCreate) { loseCreate = false; await route.abort("failed"); return; }
      await route.fulfill({ json: item }); return;
    }
    const detail = details.get(id!);
    if (!detail) { await route.fulfill({ status: 404, json: { error: "agent_bus_not_found" } }); return; }
    if (request.method() === "DELETE") { deletes.push(id!); details.delete(id!); await route.fulfill({ json: { ok: true } }); return; }
    if (request.method() === "PUT") {
      const body = request.postDataJSON(); updates.push(body);
      if (body.revision !== detail.workspace.revision) { await route.fulfill({ status: 409, json: { error: "agent_bus_revision_conflict" } }); return; }
      detail.workspace = { ...detail.workspace, ...body.config, revision: `rev_${updates.length + 1}` };
      if (loseUpdate) { loseUpdate = false; await route.abort("failed"); return; }
      await route.fulfill({ json: detail.workspace }); return;
    }
    if (parts[3] === "runs" && parts[5] === "stop" && request.method() === "POST") {
      const body = request.postDataJSON(); stops.push({ workspaceId: id!, runId: parts[4]!, requestId: body.requestId, ...(body.abandon ? { abandon: true } : {}) });
      const run = detail.runs.find(item => item.id === parts[4])!; run.status = body.abandon ? "interrupted" : "stopping";
      if (body.abandon) { run.error = "agent_bus_wait_abandoned"; delete run.canAbandon; }
      await route.fulfill({ json: run }); return;
    }
    if (parts[3] === "runs" && request.method() === "POST") {
      const body = request.postDataJSON(); starts.push(body);
      if (startFailure) { const error = startFailure; startFailure = undefined; await route.fulfill({ status: 409, json: { error } }); return; }
      let run = runReceipts.get(body.requestId);
      if (!run) {
        if (body.revision !== detail.workspace.revision) { await route.fulfill({ status: 409, json: { error: "agent_bus_conflict" } }); return; }
        run = { id: runIdFor("owner", body.requestId), workspaceId: id!, messageId: "fixture_message", status: "queued", text: body.text, createdAt: Date.now(), snapshot: snapshot(detail.workspace), stages: [] };
        runReceipts.set(body.requestId, run);
      }
      // Deliberately withhold the accepted receipt from polling until retry.
      // This models a lost response without letting a later GET settle it.
      if (loseStart) { loseStart = false; await route.abort("failed"); return; }
      detail.runs = [run, ...detail.runs.filter(item => item.id !== run!.id)]; detail.workspace.latestRun = run; await route.fulfill({ json: run }); return;
    }
    throw new Error(`Unexpected fixture mutation: ${request.method()} ${request.url()}`);
  });
  const publishAcceptedRun = (requestId: string) => { const run = runReceipts.get(requestId)!; const detail = details.get(run.workspaceId)!; detail.runs = [run, ...detail.runs.filter(item => item.id !== run.id)]; detail.workspace.latestRun = run; return run; };
  return { details, createCalls, updates, starts, stops, deletes, permissions, permissionReads, permissionWrites, restarts, restartExecutions, publishAcceptedRun, failNextStart: (code: string) => { startFailure = code; }, holdRestartsOffline: (hold: boolean) => { holdRestartsOffline = hold; }, failNextPermission: (operation: "read" | "write" | "restart", botId: string, code: string) => { permissionFailures.set(`${operation}:${botId}`, code); }, delayNextRead, get reads() { return reads; }, loseNextRead: () => { loseRead = true; }, loseNextCreate: () => { loseCreate = true; }, loseNextUpdate: () => { loseUpdate = true; }, loseNextStart: () => { loseStart = true; } };
}
async function setup(page: Page, initial: AgentBusWorkspace[] = [], populate?: (hub: HubServer) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-ui-")), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const hub = await HubServer.start({ stateDir: root, clientDir });
  await seed(hub); await populate?.(hub); const fixture = await api(page, hub, initial);
  await page.goto(hub.url); await pair(page, hub);
  return { root, hub, fixture, errors, close: async () => { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

test("returning from Agent Bus keeps the ADHD viewport free of outer scrollbars", async ({ page }, info) => {
  test.setTimeout(90_000);
  const f = await setup(page, [workspace()]);
  try {
    // Exercise classic scrollbars as used by macOS's Always preference.
    await page.addStyleTag({ content: "::-webkit-scrollbar{width:16px;height:16px}::-webkit-scrollbar-thumb{background:#111}" });
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const id of ids) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${names[ids.indexOf(id)]}记录`, exact: true }).check();
    const draft = page.locator('.adhd-card[data-pane-conversation="chat_main"] .composer textarea');
    await draft.fill("关闭 Bus 也保留这份草稿");
    await page.getByLabel("ADHD 每行窗口数").selectOption("4");
    for (const width of [1600, 1100, 1360, 1359]) {
      await page.setViewportSize({ width, height: 740 });
      for (let cycle = 0; cycle < 2; cycle++) {
        await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
        await expect(panel(page)).toBeVisible();
        await panel(page).getByRole("tab", { name: "配置", exact: true }).click();
        await panel(page).getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
        await expect(panel(page)).toBeHidden();
        await page.waitForTimeout(350);
        const dimensions = await page.evaluate(() => {
          const root = document.documentElement, shell = document.querySelector<HTMLElement>(".adhd-shell")!;
          const grid = document.querySelector<HTMLElement>(".adhd-grid")!;
          return { excessX: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
            excessY: Math.max(root.scrollHeight, document.body.scrollHeight) - root.clientHeight,
            shellX: shell.scrollLeft, shellY: shell.scrollTop,
            gridBar: getComputedStyle(grid).scrollbarWidth,
            gridBarDisplay: getComputedStyle(grid, "::-webkit-scrollbar").display };
        });
        await info.attach(`closed-${width}-${cycle}`, { body: JSON.stringify(dimensions), contentType: "application/json" });
        await page.screenshot({ path: info.outputPath(`closed-${width}-${cycle}.png`) });
        // Native macOS WebKit counts an absolute legend outside the dock's
        // clip in document overflow; Playwright's WebKit may not. Ensure that
        // hidden label has a containing block inside the dock in both layouts.
        expect(await page.locator(".agent-bus-mode-picker legend").evaluate(element => {
          const parent = (element as HTMLElement).offsetParent;
          return parent !== null && element.closest(".agent-bus-dock")!.contains(parent);
        })).toBe(true);
        await expect(page.locator("html")).toHaveCSS("overflow", "visible");
        expect(dimensions.excessX).toBeLessThanOrEqual(1);
        expect(dimensions.excessY).toBeLessThanOrEqual(1);
        expect(dimensions.shellX).toBe(0); expect(dimensions.shellY).toBe(0);
        expect(dimensions.gridBar === "none" || dimensions.gridBarDisplay === "none").toBe(true);
        await expect(draft).toHaveValue("关闭 Bus 也保留这份草稿");
      }
    }
    await page.setViewportSize({ width: 1100, height: 560 });
    const grid = page.locator(".adhd-grid"), box = (await grid.boundingBox())!;
    await page.mouse.move(box.x + 3, box.y + 3); await page.mouse.wheel(2000, 2000);
    await expect.poll(() => grid.evaluate(element => element.scrollLeft > 0 && element.scrollTop > 0)).toBe(true);
    await grid.evaluate(element => { element.scrollLeft = 0; });
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_review"] .send-button')).toBeInViewport();
    // A hidden board on a phone-sized window must not lock its replacement.
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.locator(".adhd-shell")).toBeHidden();
    await expect(page.locator("html")).toHaveCSS("overflow", "visible");
    await page.setViewportSize({ width: 1600, height: 850 });
    await expect(page.locator(".adhd-shell")).toBeVisible();
    await expect(draft).toHaveValue("关闭 Bus 也保留这份草稿");
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await expect(page.locator(".adhd-shell")).toHaveCount(0);
    await expect(page.locator("html")).toHaveCSS("overflow", "visible");
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const deviceScaleFactor of [1, 1.25, 1.5]) test.describe(`ADHD viewport at ${deviceScaleFactor} device scale`, () => {
  test.use({ deviceScaleFactor });
  test("pane expansion and Bus transitions keep classic scrollbars inside the workspace", async ({ page }, info) => {
    // Five viewport journeys include pairing/history and real layout transitions.
    test.setTimeout(180_000);
    page.setDefaultTimeout(10_000);
    const f = await setup(page, [workspace()], async hub => {
      for (let index = 0; index < 12; index++) await hub.store.publishBotMessage("main", {
        conversationId: "chat_main", status: "complete", blocks: [{ type: "text", text: `记录 ${index}\n\n` + "一段可以继续滚动阅读的长回复。".repeat(35) + "\n\n| 主机 | 已配置的访问线路 |\n|---|---|\n| 示例主机 | `https://example.invalid:8445` |" }],
      });
    });
    try {
      await page.addStyleTag({ content: "::-webkit-scrollbar{width:17px;height:17px}::-webkit-scrollbar-thumb{background:#111}" });
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      for (const id of ids) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${names[ids.indexOf(id)]}记录`, exact: true }).check();
      const first = page.locator('.adhd-card[data-pane-conversation="chat_main"]');
      const draft = first.locator(".composer textarea");
      await draft.fill("切换布局后仍保留草稿");
      // Check every animation frame, not only the settled dock. A transient
      // outer scrollbar can consume space and move a native desktop viewport.
      await page.evaluate(() => {
        const samples: { width: number; x: number; y: number; scrollX: number; scrollY: number }[] = [];
        (window as any).__viewportSamples = samples;
        const sample = () => {
          const root = document.documentElement;
          samples.push({ width: innerWidth, x: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
            y: Math.max(root.scrollHeight, document.body.scrollHeight) - root.clientHeight, scrollX, scrollY });
          (window as any).__viewportFrame = requestAnimationFrame(sample);
        };
        sample();
      });
      for (const width of [1600, 1360, 1359, 1100, 820]) {
        await page.setViewportSize({ width, height: 740 });
        await page.getByLabel("ADHD 每行窗口数").selectOption("4");
        await first.getByRole("button", { name: "放大此面板", exact: true }).click();
        await expect(first.locator(".send-button")).toBeInViewport();
        const scroller = first.locator(".message-scroll");
        await settleReadingLayout(scroller);
        const box = (await scroller.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -10000);
        await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(8);
        await page.mouse.wheel(0, 10000);
        await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
        await panel(page).getByRole("tab", { name: "配置", exact: true }).click();
        await panel(page).getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
        await expect(page.locator(".agent-bus-dock")).not.toHaveClass(/is-open/);
        await expect.poll(() => page.locator(".agent-bus-dock").evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
        await expect(draft).toHaveValue("切换布局后仍保留草稿");
        // Opening a saved Bus returns the board to its overview. Restore the
        // first pane and test its own minimize control independently as well.
        await first.getByRole("button", { name: "放大此面板", exact: true }).click();
        await first.getByRole("button", { name: "回到面板总览", exact: true }).click();
      }
      const samples = await page.evaluate(() => { cancelAnimationFrame((window as any).__viewportFrame); return (window as any).__viewportSamples as { width: number; x: number; y: number; scrollX: number; scrollY: number }[]; });
      await info.attach("viewport-frames", { body: JSON.stringify({ deviceScaleFactor, samples }), contentType: "application/json" });
      expect(samples.length).toBeGreaterThan(20);
      expect(samples.filter(sample => sample.x > 1 || sample.y > 1 || sample.scrollX !== 0 || sample.scrollY !== 0)).toEqual([]);
      await expect(page.locator("html")).toHaveCSS("overflow", "visible");
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
});

test("Bus is an inline folder group below list modes and shares conversation scrolling", async ({ page }, info) => {
  const items = Array.from({ length: 10 }, (_, index) => workspace(`inline_${index}`, `协作 ${index + 1}`));
  await page.setViewportSize({ width: 1360, height: 760 });
  const f = await setup(page, items, async hub => {
    await new ConversationFolders(hub.store.db).change("owner", { type: "create", id: "work", name: "工作", conversationId: "chat_main", revision: 0 });
  });
  try {
    await page.getByRole("button", { name: "按对话", exact: true }).filter({ visible: true }).click();
    for (const mode of ["chat", "adhd"] as const) {
      if (mode === "adhd") await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      const sidebar = page.locator(mode === "adhd" ? ".adhd-shell .sidebar" : ".host-workspace:not([hidden]) .sidebar");
      const list = sidebar.locator(mode === "adhd" ? ".adhd-picker-list" : ".host-directory");
      const group = sidebar.locator(".agent-bus-list"), heading = group.locator(".folder-heading");
      await expect(group.locator(".agent-bus-saved")).toHaveCount(10);
      await expect(sidebar.locator(":scope > .agent-bus-list")).toHaveCount(0);
      await expect(list.locator(".agent-bus-list")).toHaveCount(1);
      await expect(group).toHaveCSS("overflow-y", "visible");
      await expect(group).toHaveCSS("max-height", "none");
      // Folder actions now live in the group context menu; there is no
      // standalone toolbar row. Keep checking the actual list ordering.
      const modes = await sidebar.getByRole("group", { name: "列表排列方式", exact: true }).boundingBox(), box = await heading.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(modes!.y + modes!.height);
      const folderHeading = sidebar.locator('[data-folder-id="work"] > .folder-heading');
      const style = (element: Element) => { const s = getComputedStyle(element); return { font: s.fontSize, padding: s.padding, minHeight: s.minHeight }; };
      expect(await heading.evaluate(style)).toEqual(await folderHeading.evaluate(style));
      // Wheel input over Bus rows moves the same scrollport as ordinary groups.
      await group.getByRole("button", { name: "打开 Bus：协作 1", exact: true }).hover();
      await page.mouse.wheel(0, 430);
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
      expect((await heading.boundingBox())!.y).toBeLessThan(box!.y - 100);
      await folderHeading.scrollIntoViewIfNeeded(); await expect(folderHeading).toBeInViewport();
      await list.evaluate(element => { element.scrollTop = 0; });
      await heading.click();
      await expect(group.getByRole("button", { name: "打开 Bus：协作 1", exact: true })).toBeHidden();
      await expect(folderHeading).toBeInViewport();
      await sidebar.screenshot({ path: info.outputPath(`inline-bus-group-${mode}.png`) });
      await heading.click();
    }
    // Deleting the last saved Bus removes the empty system group; creation
    // stays available from the board toolbar instead of occupying a blank group.
    f.fixture.details.clear();
    await page.evaluate(() => window.dispatchEvent(new Event("tarobot:agent-buses-changed")));
    await expect(page.locator(".adhd-shell .agent-bus-list")).toBeHidden();
    await expect(page.getByRole("button", { name: "打开 Agent Bus", exact: true })).toBeVisible();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("saved Bus groups collapse across desktop layouts without closing panes or losing drafts", async ({ page }, info) => {
  const items = Array.from({ length: 4 }, (_, index) => workspace(`bus_${index}`, `协作 ${index + 1}`));
  const active: AgentBusRun = { id: "group_run", workspaceId: items[3]!.id, messageId: "group_message", status: "running", text: "后台协作", createdAt: 1, snapshot: snapshot(items[3]!), stages: [] };
  items[3]!.latestRun = active;
  const f = await setup(page, items);
  const group = () => page.locator(".agent-bus-list:visible");
  try {
    await expect(group().locator(".agent-bus-saved")).toHaveCount(4);
    await expect(group().locator(".agent-bus-list-count")).toHaveText("4");
    const expandedHeight = (await group().boundingBox())!.height;
    await group().getByRole("button", { name: "收起 Agent Bus 列表", exact: true }).click();
    await expect(group().getByRole("button", { name: "展开 Agent Bus 列表", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(group().getByRole("button", { name: "打开 Bus：协作 1", exact: true })).toBeHidden();
    expect((await group().boundingBox())!.height).toBeLessThan(expandedHeight - 80);
    await expect(group().getByRole("img", { name: "1 个 Bus 正在运行", exact: true })).toBeVisible();
    // A folded list continues observing state, without cancelling or starting work.
    f.fixture.details.get(items[3]!.id)!.workspace.latestRun = { ...active, status: "completed", finishedAt: 2 };
    await page.evaluate(() => window.dispatchEvent(new Event("tarobot:agent-buses-changed")));
    await expect(group().getByRole("img", { name: "1 个 Bus 正在运行", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    await expect(group().getByRole("button", { name: "展开 Agent Bus 列表", exact: true })).toBeVisible();
    await group().getByRole("button", { name: "展开 Agent Bus 列表", exact: true }).press("Enter");
    await group().getByRole("button", { name: "打开 Bus：协作 1", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("尚未发送的协作草稿");
    const panes = page.locator(".adhd-card:not([hidden])"), paneCount = await panes.count();
    expect(paneCount).toBeGreaterThan(0);
    const composer = panes.first().locator(".composer textarea");
    await composer.fill("成员窗口的草稿");
    await group().getByRole("button", { name: "收起 Agent Bus 列表", exact: true }).click();
    await expect(panes).toHaveCount(paneCount);
    await expect(composer).toHaveValue("成员窗口的草稿");
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("尚未发送的协作草稿");
    await page.screenshot({ path: info.outputPath("collapsed-bus-group.png") });
    expect(f.fixture.starts).toEqual([]); expect(f.fixture.stops).toEqual([]); expect(f.fixture.deletes).toEqual([]);
    // The unsent goal makes reload ask first; this journey discards it deliberately.
    page.once("dialog", dialog => void dialog.accept());
    await page.reload(); await waitForClientOnline(page);
    // A cold connection may become ready just after the list's first read.
    // Its next directory refresh is at 6s, beyond Playwright's default 5s.
    await expect(group().getByRole("button", { name: "展开 Agent Bus 列表", exact: true })).toBeVisible({ timeout: 10_000 });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("configuration guidance explains missing names, roles and Crew limits without starting work on save", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const f = await setup(page);
  try {
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page), name = editor.getByLabel("Bus 名称", { exact: true }), footer = editor.locator(".agent-bus-panel-footer small");
    const create = editor.getByRole("button", { name: "创建 Bus", exact: true });
    await expect(name).toHaveAttribute("placeholder", "例如：产品评审、研究小组");
    await expect(name).toHaveAttribute("required", "");
    await expect(editor.locator(".agent-bus-panel-header input")).toHaveCount(0);
    await expect(editor.locator(".agent-bus-name-label")).toHaveText("Bus 名称必填");
    const fieldStyle = await name.evaluate(element => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, border: style.borderTopStyle, borderWidth: parseFloat(style.borderTopWidth), borderColor: style.borderTopColor };
    });
    expect(fieldStyle.height).toBeGreaterThanOrEqual(40);
    expect(fieldStyle.border).toBe("solid");
    expect(fieldStyle.borderWidth).toBeGreaterThanOrEqual(1);
    expect(fieldStyle.borderColor).not.toBe("rgba(0, 0, 0, 0)");
    await expect(name).toHaveValue("");
    await expect(name).not.toHaveAttribute("aria-invalid", "true");
    await expect(editor.locator(".agent-bus-name-hint")).toBeEmpty();
    await name.focus(); await name.press("Tab");
    await expect(name).toHaveAccessibleDescription("请输入 Bus 名称。");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(create).toBeDisabled();
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("main");
    await editor.getByLabel("成员 1 Bot", { exact: true }).selectOption("research");
    // Complete participants do not disguise a still-empty required name.
    await expect(footer).toHaveText("请输入 Bus 名称。");
    await expect(create).toHaveAccessibleDescription("请输入 Bus 名称。");
    await expect(create).toBeDisabled();
    const localHint = editor.locator(".agent-bus-name-hint");
    await expect(localHint).toHaveText("请输入 Bus 名称。");
    const fieldBox = await name.boundingBox(), hintBox = await localHint.boundingBox();
    expect(hintBox!.y - fieldBox!.y - fieldBox!.height).toBeGreaterThanOrEqual(0);
    expect(hintBox!.y - fieldBox!.y - fieldBox!.height).toBeLessThanOrEqual(12);
    expect(await footer.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    for (const [width, palette, theme] of [[1440, "white-violet", "light"], [1024, "white-violet", "dark"], [1024, "cli", "dark"]] as const) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      await expect(name).toBeInViewport();
      await expect(create).toBeInViewport();
      expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await editor.screenshot({ path: info.outputPath(`name-field-${width}-${palette}-${theme}.png`), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => { document.documentElement.dataset.palette = "white-violet"; document.documentElement.dataset.theme = "light"; });
    await page.screenshot({ path: info.outputPath("missing-name-guidance.png") });
    await name.fill("  "); await expect(create).toBeDisabled();
    const longName = "a".repeat(79) + "😀Z";
    await name.fill(longName);
    await expect(name).toHaveValue(longName);
    await expect(localHint).toHaveText("Bus 名称最多 80 个字符。");
    await expect(editor.locator(".agent-bus-name-label small")).toHaveText(`${longName.length}/80`);
    await expect(create).toBeDisabled();
    await name.fill("研究方案");
    await expect(localHint).toBeEmpty();
    await expect(name).not.toHaveAttribute("aria-invalid", "true");
    await expect(footer).toHaveText("保存后显示成员对话，任务需手动启动。");
    await expect(create).toBeEnabled();
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("");
    await expect(footer).toHaveText("请为发起者选择 Bot。");
    // The guidance also marks the exact slot in the division list.
    await expect(slot(page, -1)).toHaveClass(/is-invalid/);
    await expect(editor.getByLabel("发起者 Bot", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(editor.getByLabel("发起者 Bot", { exact: true })).toHaveAccessibleDescription("请为发起者选择 Bot。");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("main");
    await editor.getByRole("button", { name: "研究团队", exact: true }).click();
    await expect(footer).toHaveText("请为分析员选择 Bot。");
    for (const [role, botId] of [["分析员", "analysis"], ["撰写者", "writer"], ["审阅者", "review"]] as const) await editor.getByLabel(`${role} Bot`, { exact: true }).selectOption(botId);
    const questions = editor.getByLabel("研究问题上限", { exact: true }), revisions = editor.getByLabel("修订轮数上限", { exact: true });
    await questions.fill("");
    await expect(questions).toHaveValue(""); await expect(create).toBeDisabled();
    await questions.pressSequentially("3"); await expect(questions).toHaveValue("3");
    await questions.fill("1e1"); await expect(questions).toHaveValue("1e1"); await expect(create).toBeDisabled();
    await revisions.fill(""); await expect(revisions).toHaveValue(""); await expect(create).toBeDisabled();
    await revisions.fill("1");
    for (const value of ["1.5", "11"]) {
      await questions.fill(value);
      await expect(footer).toHaveText("研究问题上限请输入 1–10 的整数。");
      await expect(create).toBeDisabled();
    }
    await questions.fill("10");
    for (const value of ["0.5", "4"]) {
      await revisions.fill(value);
      await expect(footer).toHaveText("修订轮数上限请输入 0–3 的整数。");
      await expect(create).toBeDisabled();
    }
    await revisions.scrollIntoViewIfNeeded();
    await expect(revisions).toBeInViewport();
    await page.screenshot({ path: info.outputPath("crew-limit-guidance.png") });
    await revisions.fill("0");
    await expect(footer).toHaveText("保存后显示成员对话，任务需手动启动。");
    await expect(create).toBeEnabled();
    expect(f.fixture.createCalls).toEqual([]); expect(f.fixture.starts).toEqual([]);
    await create.click();
    await expect.poll(() => f.fixture.reads).toBeGreaterThan(0);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    expect(f.fixture.createCalls).toHaveLength(1);
    expect(f.fixture.createCalls[0]!.config).toMatchObject({ name: "研究方案", mode: "crew", maxResearchQuestions: 10, maxRevisionRounds: 0 });
    expect(f.fixture.starts).toEqual([]);
    for (const id of ids) expect((await f.hub.store.snapshot("owner", `chat_${id}`)).messages).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("leaving Crew repairs only invalid hidden limits while retaining valid preferences", async ({ page }) => {
  const f = await setup(page);
  try {
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page), footer = editor.locator(".agent-bus-panel-footer small"), create = editor.getByRole("button", { name: "创建 Bus", exact: true });
    await editor.getByLabel("Bus 名称", { exact: true }).fill("模式切换");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("main");
    await editor.getByRole("button", { name: "研究团队", exact: true }).click();
    const selectMembers = async () => {
      for (const [index, role] of ["研究员", "分析员", "撰写者", "审阅者"].entries()) await editor.getByLabel(`${role} Bot`, { exact: true }).selectOption(ids[index + 1]!);
    };
    await selectMembers();
    const questions = editor.getByLabel("研究问题上限", { exact: true }), revisions = editor.getByLabel("修订轮数上限", { exact: true });
    await questions.fill("1.5"); await revisions.fill("3");
    await expect(create).toBeDisabled();
    await editor.getByRole("button", { name: "单人委托", exact: true }).click();
    await expect(questions).not.toBeVisible();
    await expect(footer).toHaveText("保存后显示成员对话，任务需手动启动。");
    await expect(create).toBeEnabled();
    await editor.getByRole("button", { name: "研究团队", exact: true }).click();
    await expect(questions).toHaveValue("5"); await expect(revisions).toHaveValue("3");
    await selectMembers();
    await questions.fill("10"); await revisions.fill("4");
    await editor.getByRole("button", { name: "并行询问", exact: true }).click();
    await expect(footer).toHaveText("保存后显示成员对话，任务需手动启动。");
    await expect(create).toBeEnabled();
    await editor.getByRole("button", { name: "研究团队", exact: true }).click();
    await expect(questions).toHaveValue("10"); await expect(revisions).toHaveValue("1");
    await create.click();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    expect(f.fixture.createCalls).toHaveLength(1);
    expect(f.fixture.createCalls[0]!.config).toMatchObject({ maxResearchQuestions: 10, maxRevisionRounds: 1 });
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("Agent Bus creates and names a host-bound ordered workflow; saving never starts it", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const f = await setup(page);
  try {
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page); await expect(editor).toBeVisible();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("产品发布评审");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("main");
    await editor.getByLabel("发起者 的记录对话", { exact: true }).selectOption("chat_main");
    // All five modes remain distinct, including exact crew role cardinality.
    for (const [mode, expected] of [["单人委托", 2], ["并行询问", 2], ["回答后复核", 2], ["研究团队", 5], ["串联步骤", 5]] as const) {
      await editor.getByRole("button", { name: mode, exact: true }).click();
      await expect(editor.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
      // Configuration is one division list: every slot stays editable in
      // place, and the run graph is not duplicated in this tab.
      await expect(editor.locator(".agent-bus-slot")).toHaveCount(expected);
      await expect(editor.locator(".agent-bus-flow")).toHaveCount(0);
      if (mode === "研究团队") {
        for (const [index, role] of ["研究员", "分析员", "撰写者", "审阅者"].entries()) {
          await expect(editor.getByLabel(`${role} Bot`, { exact: true })).toBeVisible();
          await expect(editor.getByLabel(`${role} · 角色要求`, { exact: true })).toBeVisible();
          await editor.getByLabel(`${role} Bot`, { exact: true }).selectOption(ids[index + 1]!);
        }
        await expect(editor.getByLabel("发起者 · 拆解要求", { exact: true })).toBeVisible();
        // The list scrolls with the panel; it never nests a second scroller.
        expect(await editor.locator(".agent-bus-roster").evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
        await page.screenshot({ animations: "disabled", path: info.outputPath("crew-five-members-configuration.png") });
      }
    }
    await editor.getByRole("button", { name: "移除步骤 4", exact: true }).click();
    await editor.getByRole("button", { name: "移除步骤 3", exact: true }).click();
    await editor.getByLabel("步骤 1 Bot", { exact: true }).selectOption("research");
    await editor.getByLabel("步骤 2 Bot", { exact: true }).selectOption("review");
    await editor.getByRole("button", { name: "上移步骤 2", exact: true }).click();
    await expect(editor.getByLabel("步骤 1 Bot", { exact: true })).toHaveValue("review");
    f.fixture.loseNextCreate(); await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("操作尚未确认");
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("产品发布评审");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    // Wait through the saved workspace remount/detail read, not just save()'s
    // transient tab state. A new Bus must be ready for its first explicit task.
    await expect.poll(() => f.fixture.reads).toBeGreaterThan(0);
    await expect(editor.getByRole("heading", { name: "产品发布评审", exact: true })).toBeVisible();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    await expect(page.locator(".adhd-card")).toHaveCount(3);
    expect(f.fixture.createCalls).toHaveLength(2);
    expect(f.fixture.createCalls[0]!.requestId).toBe(f.fixture.createCalls[1]!.requestId);
    expect(f.fixture.createCalls[1]!.config.members.map(member => member.botId)).toEqual(["review", "research"]);
    expect(f.fixture.createCalls[1]!.config.coordinator).toEqual({ botId: "main", conversationId: "chat_main" });
    expect(f.fixture.starts).toEqual([]);
    await expect(editor.getByLabel("Bus 所属主机", { exact: true })).toHaveText("测试主机");
    await expect(editor.getByRole("combobox", { name: "Bus 所属主机", exact: true })).toHaveCount(0);
    // Opening a saved workspace reveals its bound conversations and retains
    // each conversation's separate message history.
    for (const id of ["main", "review", "research"]) await expect(page.locator(`.adhd-card[data-pane-conversation="chat_${id}"] .message-scroll`)).toContainText("独立记录");
    await page.locator('.adhd-card[data-pane-conversation="chat_review"]').getByRole("button", { name: "移除此面板", exact: true }).click();
    await expect(page.locator(".adhd-card")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "打开 Bus：产品发布评审", exact: true })).toBeVisible();
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await editor.getByRole("button", { name: "在面板中显示成员对话", exact: true }).click();
    await expect(page.locator(".adhd-card")).toHaveCount(3);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("发布前复核");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(page.getByRole("button", { name: "打开 Bus：发布前复核", exact: true })).toBeVisible();
    expect(f.fixture.starts).toEqual([]);
    for (const id of ids) expect((await f.hub.store.snapshot("owner", `chat_${id}`)).messages).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("saved-ordered-workspace.png") });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("polling retains the editor revision and local edits until an explicit stale-edit recovery", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("我的未保存编辑");
    const reads = f.fixture.reads;
    f.fixture.details.get("bus_one")!.workspace = { ...workspace(), name: "另一窗口的修改", revision: "remote_revision" };
    await expect.poll(() => f.fixture.reads, { timeout: 7000 }).toBeGreaterThan(reads);
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("我的未保存编辑");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("当前配置与主机记录不一致");
    expect(f.fixture.updates[0]!.revision).toBe("rev_1");
    expect(f.fixture.details.get("bus_one")!.workspace.name).toBe("另一窗口的修改");
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("我的未保存编辑");
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("重新载入仍保留的任务");
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByRole("button", { name: "重新载入配置", exact: true }).click();
    const reload = page.getByRole("dialog", { name: "重新载入配置？", exact: true });
    await expect(reload).toBeVisible();
    await expect(reload).toHaveAccessibleDescription("未保存的配置（含各步骤任务）将被已保存的配置替换。 共同目标草稿会保留。");
    await expect(reload.getByRole("button", { name: "继续编辑", exact: true })).toBeFocused();
    // Enter must keep the local changes; reload is always an explicit choice.
    await page.keyboard.press("Enter");
    await expect(reload).not.toBeVisible();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("我的未保存编辑");
    await editor.getByRole("button", { name: "重新载入配置", exact: true }).click();
    await reload.getByRole("button", { name: "重新载入配置", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("另一窗口的修改");
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("重新载入仍保留的任务");
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("a collapsed idle Bus polls slowly, resumes immediately and keeps active member status fresh", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("轮询保留的草稿");
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    const collapsedReads = f.fixture.reads;
    await page.waitForTimeout(7500);
    expect(f.fixture.reads).toBe(collapsedReads);
    await expect.poll(() => f.fixture.reads, { timeout: 10_000 }).toBeGreaterThan(collapsedReads);
    const idleReads = f.fixture.reads;
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    await expect.poll(() => f.fixture.reads, { timeout: 2500 }).toBeGreaterThan(idleReads);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("轮询保留的草稿");
    const detail = f.fixture.details.get("bus_one")!;
    const run: AgentBusRun = { id: "running_poll", workspaceId: "bus_one", messageId: "running_message", status: "running", text: "另一设备启动的任务", createdAt: Date.now(), snapshot: snapshot(detail.workspace), stages: [] };
    detail.runs = [run]; detail.workspace.latestRun = run;
    const beforeActive = f.fixture.reads;
    await expect.poll(() => f.fixture.reads, { timeout: 7000 }).toBeGreaterThan(beforeActive);
    await expect(editor.getByRole("button", { name: "停止本次协作", exact: true })).toBeVisible();
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    const activeReads = f.fixture.reads;
    await expect.poll(() => f.fixture.reads, { timeout: 7000 }).toBeGreaterThan(activeReads);
    // A hidden document does not poll; coming back reads immediately even when
    // the dock stays collapsed, so final member status can settle on the board.
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForTimeout(300);
    const hiddenReads = f.fixture.reads;
    await page.waitForTimeout(4000); expect(f.fixture.reads).toBe(hiddenReads);
    run.status = "completed";
    await page.evaluate(() => { delete (document as unknown as { hidden?: boolean }).hidden; document.dispatchEvent(new Event("visibilitychange")); });
    await expect.poll(() => f.fixture.reads, { timeout: 2500 }).toBeGreaterThan(hiddenReads);
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    await expect(editor.getByRole("button", { name: "停止本次协作", exact: true })).not.toBeVisible();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("轮询保留的草稿");
    expect(f.fixture.starts).toEqual([]); expect(f.fixture.updates).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("collapsing retains configuration and task drafts; switching requires deliberate discard", async ({ page }, info) => {
  test.setTimeout(90_000);
  const f = await setup(page, [workspace(), workspace("bus_two", "第二个 Bus")]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("未保存名称");
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("还没有启动的任务");
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    await expect(editor).not.toBeVisible();
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("还没有启动的任务");
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("未保存名称");
    await page.getByRole("button", { name: "打开 Bus：第二个 Bus", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "放弃未保存的内容？", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription("未保存的配置和未发送的任务将丢失。 正在运行的协作会继续。");
    await expect(dialog.getByRole("button", { name: "继续编辑", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("未保存名称");
    // Both themes and a narrow desktop keep copy separate from equal-height actions.
    for (const [width, theme] of [[1360, "light"], [1024, "dark"]] as const) {
      await page.setViewportSize({ width, height: 800 });
      await openSettings(page);
      await page.locator('input[name="color-palette"][value="white-violet"]').check();
      await page.getByLabel("主题", { exact: true }).selectOption(theme);
      await closeSettings(page);
      // Safari does not focus buttons on pointer click. Open by keyboard so
      // this assertion checks restoration of an actual focused trigger.
      const switchBus = page.getByRole("button", { name: "打开 Bus：第二个 Bus", exact: true });
      await switchBus.focus(); await switchBus.press("Enter");
      await expect(dialog).toBeVisible();
      await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const box = await dialog.boundingBox();
      expect(box!.width).toBeLessThanOrEqual(440);
      const discard = await dialog.getByRole("button", { name: "放弃并离开", exact: true }).boundingBox();
      const keep = await dialog.getByRole("button", { name: "继续编辑", exact: true }).boundingBox();
      const note = await dialog.getByText("正在运行的协作会继续。", { exact: true }).boundingBox();
      expect(discard!.height).toBeGreaterThanOrEqual(36);
      expect(Math.abs(discard!.height - keep!.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(discard!.y - keep!.y)).toBeLessThanOrEqual(1);
      expect(keep!.x - discard!.x - discard!.width).toBeGreaterThanOrEqual(7);
      expect(keep!.y - note!.y - note!.height).toBeGreaterThanOrEqual(18);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`draft-confirm-${theme}.png`) });
      await dialog.screenshot({ path: info.outputPath(`draft-confirm-${theme}-detail.png`) });
      if (theme === "light") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "关闭确认", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.getByRole("button", { name: "打开 Bus：第二个 Bus", exact: true })).toBeFocused();
      await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("未保存名称");
      await editor.getByRole("tab", { name: "运行", exact: true }).click();
      await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("还没有启动的任务");
      await editor.getByRole("tab", { name: "配置", exact: true }).click();
    }
    await page.getByRole("button", { name: "打开 Bus：第二个 Bus", exact: true }).click();
    await dialog.getByRole("button", { name: "放弃并离开", exact: true }).click();
    await expect(editor.getByRole("heading", { name: "第二个 Bus", exact: true })).toBeVisible();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("第二个 Bus");
    expect(f.fixture.starts).toEqual([]); expect(f.fixture.updates).toEqual([]);
    await page.emulateMedia({ reducedMotion: "reduce" }); await page.setViewportSize({ width: 1024, height: 760 });
    await expect(editor).toBeVisible();
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // TaroBird deliberately keeps its limited UI motion enabled. A system
    // reduced-motion preference must not revive the retired App switch.
    expect(await page.locator(".agent-bus-dock").evaluate(element => getComputedStyle(element).transitionDuration.split(",").some(value => parseFloat(value) > 0))).toBe(true);
    await page.screenshot({ path: info.outputPath("small-desktop-reduced-motion.png") });
    await editor.getByLabel("Bus 名称", { exact: true }).focus(); await page.keyboard.press("Escape");
    await expect(editor).not.toBeVisible();
    await expect(page.getByRole("button", { name: "打开 Agent Bus", exact: true })).toBeFocused();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("an uncertain start retries the same request ID, then shows per-member recorded status", async ({ page }, info) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page); await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("评审这次发布");
    f.fixture.loseNextStart(); await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("操作尚未确认");
    await expect(editor.getByRole("alert")).toBeInViewport({ ratio: 1 });
    await expect(editor.getByRole("alert")).toHaveAttribute("data-invalid", "true");
    await expect(editor.getByRole("button", { name: "启动协作", exact: true })).toBeInViewport();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("评审这次发布");
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("排队中");
    expect(f.fixture.starts).toHaveLength(2);
    await expectOneDisclosure(editor.locator(".agent-bus-run-history > summary"));
    expect(f.fixture.starts[0]!.requestId).toBe(f.fixture.starts[1]!.requestId);
    const detail = f.fixture.details.get("bus_one")!;
    detail.runs[0] = { ...detail.runs[0]!, status: "running", stages: [{ id: "stage_research", botId: "research", conversationId: "chat_research", status: "completed", startedAt: 1, finishedAt: 2 }, { id: "stage_review", botId: "review", conversationId: "chat_review", status: "running", startedAt: 3 }] };
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("协作中", { timeout: 7000 });
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_main"] .agent-bus-pane-status')).toHaveText("Bus · 协调中");
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_research"] .agent-bus-pane-status')).toHaveText("Bus · 本步完成");
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_review"] .agent-bus-pane-status')).toHaveText("Bus · 执行中");
    for (const badge of await page.locator(".agent-bus-pane-status").all()) await expect(badge).toHaveAttribute("title", "Agent Bus 本次协作状态；关闭窗口不会停止任务。");
    await page.screenshot({ path: info.outputPath("fixture-running-member-status.png") });
    // A confirmed completion ends the prior intent. Repeating the exact same
    // prompt is a deliberate new run, unlike retrying an uncertain response.
    detail.runs[0] = { ...detail.runs[0]!, status: "completed", finishedAt: Date.now(), stages: detail.runs[0]!.stages.map(stage => ({ ...stage, status: "completed", finishedAt: Date.now() })) };
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("已完成", { timeout: 7000 });
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("评审这次发布");
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect.poll(() => f.fixture.starts.length).toBe(3);
    expect(f.fixture.starts[2]!.requestId).not.toBe(f.fixture.starts[1]!.requestId);
    const customAvatar = editor.locator('.agent-bus-flow-node [data-avatar="bot:main"] img');
    await expect(customAvatar).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => customAvatar.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(256);
    for (const avatar of await editor.locator(".agent-bus-flow-node .profile-avatar").all()) {
      const box = (await avatar.boundingBox())!;
      expect(box.width).toBeGreaterThan(20); expect(Math.abs(box.width - box.height)).toBeLessThan(1);
    }
    // First-run appearance is explicitly light. Exercise OS following only
    // after selecting system mode, rather than relying on an obsolete default.
    await page.evaluate(() => { document.documentElement.dataset.theme = "system"; });
    await page.emulateMedia({ colorScheme: "light" });
    const lightBackground = await editor.evaluate(element => getComputedStyle(element).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1100, height: 780 });
    await expect.poll(() => editor.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(lightBackground);
    await expect(editor.getByRole("button", { name: "停止本次协作", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("dark-small-running-workspace.png") });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("audit N2: an archived record error directs recovery without restoring it automatically", async ({ page }, info) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("归档恢复后再运行");
    await f.hub.store.updateConversation("owner", "chat_research", { archived: true });
    f.fixture.failNextStart("agent_bus_conversation_archived");
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("工作台 → 已归档对话");
    await expect(editor.getByRole("alert")).toContainText("恢复原记录对话");
    await expect(editor.getByRole("alert")).not.toContainText("使用专用对话");
    await page.screenshot({ path: info.outputPath("archived-record-recovery.png") });
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("归档恢复后再运行");
    expect(await f.hub.store.db.get("SELECT archived FROM conversations WHERE id=?", ["chat_research"])).toMatchObject({ archived: 1 });
    expect(f.fixture.details.get("bus_one")!.runs).toEqual([]); expect(f.errors).toEqual([]);
    // Follow the desktop wording far enough to verify that the recovery entry
    // exists; leave the user's archived record unchanged.
    await page.getByRole("button", { name: "工作台：测试主机，已连接", exact: true }).click();
    await expect(page.locator(".workspace-menu").getByRole("button", { name: /^已归档对话/ })).toBeVisible();
  } finally { await f.close(); }
});

test("audit N4: polling confirms an accepted start and the same text can become a new explicit run", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), task = editor.getByLabel("Bus 共同目标", { exact: true });
    await task.fill("重复检查发布内容");
    f.fixture.loseNextStart(); await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("操作尚未确认");
    const firstRequest = f.fixture.starts[0]!.requestId, first = f.fixture.publishAcceptedRun(firstRequest);
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("排队中", { timeout: 7000 });
    await expect.soft(task).toHaveValue("");
    await expect.soft(editor.getByRole("alert")).toHaveCount(0);
    first.status = "completed"; first.finishedAt = Date.now();
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("已完成", { timeout: 7000 });
    await task.fill("重复检查发布内容");
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect.poll(() => f.fixture.starts.length).toBe(2);
    expect.soft(f.fixture.starts[1]!.requestId).not.toBe(firstRequest);
    expect(f.fixture.details.get("bus_one")!.runs).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const draftCase of ["new draft", "same text edited", "different write error"] as const) test(`audit N4: accepting the original start preserves ${draftCase}`, async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), task = editor.getByLabel("Bus 共同目标", { exact: true });
    await task.fill("已经提交的任务");
    f.fixture.loseNextStart(); await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("操作尚未确认");
    await task.fill("确认之前写下的新任务草稿");
    if (draftCase === "same text edited") await task.fill("已经提交的任务");
    if (draftCase === "different write error") {
      await editor.getByRole("tab", { name: "配置", exact: true }).click();
      await editor.getByLabel("Bus 名称", { exact: true }).fill("我的新配置草稿");
      f.fixture.details.get("bus_one")!.workspace.revision = "remote_conflict";
      await editor.getByRole("button", { name: "保存配置", exact: true }).click();
      await expect(editor.getByRole("alert")).toContainText("当前配置与主机记录不一致");
    }
    const accepted = f.fixture.publishAcceptedRun(f.fixture.starts[0]!.requestId); accepted.status = "completed";
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("已完成", { timeout: 7000 });
    await expect(task).toHaveValue(draftCase === "same text edited" ? "已经提交的任务" : "确认之前写下的新任务草稿");
    if (draftCase === "different write error") await expect(editor.getByRole("alert")).toContainText("当前配置与主机记录不一致");
    else await expect(editor.getByRole("alert")).toHaveCount(0);
    expect(f.fixture.starts).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("audit N4: another device's same-text run does not confirm this owner's request", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), task = editor.getByLabel("Bus 共同目标", { exact: true });
    await task.fill("相同的任务正文");
    f.fixture.loseNextStart(); await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("操作尚未确认");
    const requestId = f.fixture.starts[0]!.requestId, detail = f.fixture.details.get("bus_one")!;
    for (const id of [runIdFor("owner", "another_device_request"), runIdFor("another_owner", requestId)]) {
      const reads = f.fixture.reads;
      detail.runs = [{ id, workspaceId: "bus_one", messageId: "other_message", status: "completed", text: "相同的任务正文", createdAt: Date.now(), snapshot: snapshot(detail.workspace), stages: [] }];
      await expect.poll(() => f.fixture.reads, { timeout: 7000 }).toBeGreaterThan(reads);
      await expect(task).toHaveValue("相同的任务正文");
      await expect(editor.getByRole("alert")).toContainText("操作尚未确认");
    }
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect.poll(() => f.fixture.starts.length).toBe(2);
    expect(f.fixture.starts[1]!.requestId).toBe(requestId);
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("排队中");
    await expect(task).toHaveValue(""); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("same Bus and conversation IDs stay bound to their host; the phone has no Agent Bus entry", async ({ page, browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-two-hosts-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" }), phone = await phoneContext.newPage();
  const errors: string[] = []; for (const device of [page, phone]) device.on("pageerror", error => errors.push(error.message));
  try {
    await seed(a, "主机 A"); await seed(b, "主机 B");
    const fa = await api(page, a, [workspace("same_bus", "A 工作流")]), fb = await api(page, b, [workspace("same_bus", "B 工作流")]);
    await page.goto(a.url); await pair(page, a, "主机 A"); await clickAppAction(page, "连接另一台主机"); await pair(page, b, "主机 B");
    await page.getByRole("button", { name: "按对话", exact: true }).filter({ visible: true }).click();
    const visibleSidebar = () => page.locator(".host-workspace:not([hidden]) .sidebar");
    for (const grouped of [false, true]) {
      await setListOption(page, '按主机分组', grouped);
      await expect(visibleSidebar().locator(".host-directory .agent-bus-list")).toHaveCount(1);
      await expect(visibleSidebar().getByRole("button", { name: "打开 Bus：A 工作流", exact: true })).toBeVisible();
      await expect(visibleSidebar().getByRole("button", { name: "打开 Bus：B 工作流", exact: true })).toBeVisible();
    }
    const filter = visibleSidebar().getByRole("combobox", { name: "筛选运行主机", exact: true });
    await filter.selectOption((await filter.getByRole("option", { name: /^主机 A/ }).getAttribute("value"))!);
    await expect(visibleSidebar().getByRole("button", { name: "打开 Bus：A 工作流", exact: true })).toBeVisible();
    await expect(visibleSidebar().getByRole("button", { name: "打开 Bus：B 工作流", exact: true })).toHaveCount(0);
    await visibleSidebar().getByRole("combobox", { name: "筛选运行主机", exact: true }).selectOption("");
    await page.getByRole("button", { name: "打开 Bus：A 工作流", exact: true }).filter({ visible: true }).click();
    await expect(page.locator(".adhd-card")).toHaveCount(3);
    await page.getByRole("button", { name: "打开 Bus：B 工作流", exact: true }).click();
    await expect(page.locator(".adhd-card")).toHaveCount(6);
    const pa = page.getByRole("region", { name: "对话面板：主机 A · 协调助手记录", exact: true }), pb = page.getByRole("region", { name: "对话面板：主机 B · 协调助手记录", exact: true });
    await expect(pa).toContainText("主机 A · 协调助手的独立记录"); await expect(pb).toContainText("主机 B · 协调助手的独立记录");
    await pa.locator(".composer textarea").fill("A 的草稿"); await pb.locator(".composer textarea").fill("B 的草稿");
    const editor = panel(page);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("只改 B");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    expect(fa.updates).toEqual([]); expect(fb.updates).toHaveLength(1);
    await expect(pa.locator(".composer textarea")).toHaveValue("A 的草稿"); await expect(pb.locator(".composer textarea")).toHaveValue("B 的草稿");
    await phone.goto(a.url); await pair(phone, a, "主机 A");
    await expect(phone.getByRole("button", { name: "打开 Agent Bus", exact: true })).toHaveCount(0);
    await expect(phone.locator(".agent-bus-list,.agent-bus-panel")).toHaveCount(0);
    await phone.screenshot({ path: info.outputPath("phone-without-agent-bus-entry.png") });
    expect(errors).toEqual([]);
  } finally { await phoneContext.close(); await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});


test("the first successful detail read restores the editor after an initial connection failure", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    f.fixture.loseNextRead();
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await expect(editor.getByRole("status").filter({ hasText: "暂时无法刷新协作状态" })).toBeVisible();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible({ timeout: 7000 });
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("产品评审");
    await expect(editor.getByLabel("发起者 Bot", { exact: true })).toHaveValue("main");
    await editor.getByLabel("Bus 名称", { exact: true }).fill("恢复连接后修改");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => f.fixture.updates.length).toBe(1);
    expect(f.fixture.updates[0]!.revision).toBe("rev_1");
    await expect(editor.getByRole("heading", { name: "恢复连接后修改", exact: true })).toBeVisible();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


test("audit F1: a recovered polling read clears only its read error and preserves task intent", async ({ page }, info) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), task = editor.getByLabel("Bus 共同目标", { exact: true });
    const readNotice = editor.getByRole("status").filter({ hasText: "暂时无法刷新协作状态" });
    await task.fill("网络恢复后继续准备的任务");
    const reads = f.fixture.reads; f.fixture.loseNextRead();
    await expect(readNotice).toBeVisible({ timeout: 7000 });
    expect.soft(await readNotice.innerText()).not.toContain("请求编号");
    await page.screenshot({ path: info.outputPath("poll-read-error.png") });
    await expect.poll(() => f.fixture.reads, { timeout: 7000 }).toBeGreaterThan(reads + 1);
    await expect.soft(readNotice).toHaveCount(0);
    await expect.soft(editor.getByRole("alert")).toHaveCount(0);
    await expect(task).toHaveValue("网络恢复后继续准备的任务");
    // A later successful GET must not erase an unconfirmed mutation receipt.
    f.fixture.loseNextStart(); await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("操作尚未确认");
    const afterMutation = f.fixture.reads;
    await expect.poll(() => f.fixture.reads, { timeout: 7000 }).toBeGreaterThan(afterMutation);
    await expect(editor.getByRole("alert")).toContainText("操作尚未确认");
    await expect(task).toHaveValue("网络恢复后继续准备的任务");
    expect(f.fixture.starts).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const operation of ["read", "write", "restart"] as const) test(`audit F2: permission ${operation} failure is actionable inside the dialog and retry completes preparation`, async ({ page }, info) => {
  const f = await setup(page, [workspace()]);
  try {
    const coordinator = f.fixture.permissions.get("main")!;
    coordinator.settings = { ...coordinator.settings, enabled: false, peers: [] }; coordinator.listener = "offline";
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("权限准备不会自动发送此任务");
    await editor.getByRole("button", { name: "检查并准备", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "启用这组协作", exact: true });
    f.fixture.failNextPermission(operation, "main", operation === "write" ? "collaboration_conflict" : "collaboration_listener_unknown");
    await dialog.getByRole("button", { name: "启用并连接", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "启用并连接", exact: true })).toBeEnabled();
    await expect.soft(dialog.getByRole("alert")).toContainText(operation === "write" ? "成员协作权限已被修改，请重新检查并准备" : "尚未确认成员服务状态", { timeout: 1000 });
    await page.screenshot({ path: info.outputPath(`permission-${operation}-failure.png`) });
    expect.soft(await page.locator(".agent-bus-notice[role=status]").allTextContents()).not.toEqual(expect.arrayContaining([expect.stringMatching(/正在连接|正在准备/)]));
    const reads = f.fixture.permissionReads.length;
    // Failure must stop the preparation-only four-second readiness poll.
    await page.waitForTimeout(4500);
    expect.soft(f.fixture.permissionReads.length).toBe(reads);
    expect(f.fixture.starts).toEqual([]);
    await dialog.getByRole("button", { name: "启用并连接", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(editor.getByRole("button", { name: "启动协作", exact: true })).toBeEnabled();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("权限准备不会自动发送此任务");
    expect(f.fixture.permissions.get("main")!.settings.peers).toEqual(["research", "review"]);
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("audit F3: clean configuration adopts a remote revision while retaining the unsent task", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), task = editor.getByLabel("Bus 共同目标", { exact: true });
    await task.fill("使用其他窗口已保存的新团队执行");
    const detail = f.fixture.details.get("bus_one")!;
    detail.workspace = { ...detail.workspace, name: "另一设备的新团队", revision: "remote_revision", mode: "ask", coordinator: { botId: "analysis", conversationId: "chat_analysis" }, members: [{ botId: "writer", conversationId: "chat_writer" }] };
    await expect(editor.locator(".agent-bus-run-hero")).toContainText("单人委托", { timeout: 7000 });
    await expect(task).toHaveValue("使用其他窗口已保存的新团队执行");
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect.soft(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("另一设备的新团队", { timeout: 1000 });
    await expect.soft(editor.getByLabel("发起者 Bot", { exact: true })).toHaveValue("analysis", { timeout: 1000 });
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect.poll(() => f.fixture.starts.length).toBe(1);
    expect.soft(f.fixture.starts[0]!.revision).toBe("remote_revision");
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("排队中");
    expect(detail.runs[0]!.snapshot.coordinator.botId).toBe("analysis");
    expect(detail.runs[0]!.snapshot.members.map(member => member.botId)).toEqual(["writer"]);
    expect(detail.runs[0]!.text).toBe("使用其他窗口已保存的新团队执行");
    expect(f.fixture.updates).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("audit F3: a permission confirmation retains reviewed members until it closes", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    const coordinator = f.fixture.permissions.get("main")!;
    coordinator.settings = { ...coordinator.settings, enabled: false, peers: [] }; coordinator.listener = "offline";
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("确认权限时保留的任务");
    await editor.getByRole("button", { name: "检查并准备", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "启用这组协作", exact: true });
    await expect(dialog).toContainText("协调助手 ↔ 研究助手、审阅助手");
    const reads = f.fixture.reads, detail = f.fixture.details.get("bus_one")!;
    detail.workspace = { ...detail.workspace, name: "远端新定义", revision: "remote_review_revision", mode: "ask", coordinator: { botId: "analysis", conversationId: "chat_analysis" }, members: [{ botId: "writer", conversationId: "chat_writer" }] };
    await expect.poll(() => f.fixture.reads, { timeout: 7000 }).toBeGreaterThan(reads);
    await expect(dialog).toContainText("协调助手 ↔ 研究助手、审阅助手");
    const beforePreparation = f.fixture.permissionReads.length;
    await dialog.getByRole("button", { name: "启用并连接", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(f.fixture.permissionReads.slice(beforePreparation, beforePreparation + 3)).toEqual(["main", "research", "review"]);
    expect(f.fixture.permissionWrites.map(write => write.botId)).toEqual(["main"]);
    expect(f.fixture.permissions.get("main")!.settings.peers).toEqual(["research", "review"]);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("远端新定义", { timeout: 7000 });
    await expect(editor.getByLabel("发起者 Bot", { exact: true })).toHaveValue("analysis");
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("确认权限时保留的任务");
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const action of ["stop", "delete"] as const) test(`audit F4: ${action} confirmation becomes disabled when its host disconnects`, async ({ page }, info) => {
  const f = await setup(page, [workspace()]);
  try {
    if (action === "stop") {
      const detail = f.fixture.details.get("bus_one")!;
      detail.runs = [{ id: "run_active", workspaceId: "bus_one", messageId: "fixture_message", status: "running", text: "运行中的任务", createdAt: 1, snapshot: snapshot(detail.workspace), stages: [] }];
    }
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await expect(editor.locator(".agent-bus-run-state")).toHaveText(action === "stop" ? "协作中" : "待启动");
    if (action === "delete") await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const label = action === "stop" ? "停止本次协作" : "删除 Bus";
    await editor.getByRole("button", { name: label, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: action === "stop" ? "停止本次协作？" : "删除这个 Bus？", exact: true });
    await expect(dialog).toBeVisible();
    await f.hub.close();
    await expect(page.locator(".agent-bus-scope .status-dot.offline")).toBeAttached();
    await page.screenshot({ path: info.outputPath(`${action}-confirmation-offline.png`) });
    await expect(dialog.getByRole("button", { name: label, exact: true })).toBeDisabled();
    expect(f.fixture.stops).toEqual([]); expect(f.fixture.deletes).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("audit F5: a restart receipt survives pending retries but is renewed after observed readiness", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    f.fixture.permissions.get("main")!.listener = "offline";
    f.fixture.holdRestartsOffline(true);
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), start = editor.getByRole("button", { name: "启动协作", exact: true });
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("服务恢复后才会运行的任务");
    const prepare = async () => {
      await editor.getByRole("button", { name: "检查并准备", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "启用这组协作", exact: true });
      await dialog.getByRole("button", { name: "启用并连接", exact: true }).click();
      await expect(dialog).not.toBeVisible();
    };
    await prepare(); await expect(start).toBeDisabled();
    await prepare(); await expect(start).toBeDisabled();
    expect(f.fixture.restarts).toHaveLength(2);
    expect(f.fixture.restarts[0]!.receiptId).toBe(f.fixture.restarts[1]!.receiptId);
    expect(f.fixture.restartExecutions.size).toBe(1);
    // Hold a readiness poll in flight: an existing permission snapshot must
    // remain on screen instead of flashing a loading row every four seconds.
    let releaseRead!: () => void, readBlocked = false;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    await page.route(`${f.hub.url}/api/bots/main/collaboration`, async route => {
      if (route.request().method() === "GET" && !readBlocked) { readBlocked = true; await readGate; }
      await route.fallback();
    });
    const taskTop = (await editor.getByLabel("Bus 共同目标", { exact: true }).boundingBox())!.y;
    // Only a subsequent readiness observation settles the accepted restart.
    f.fixture.permissions.get("main")!.listener = "online";
    try {
      await expect.poll(() => readBlocked, { timeout: 7000 }).toBe(true);
      await expect(editor.locator(".agent-bus-permission-check")).toHaveCount(0);
      await expect(start).toHaveAccessibleDescription("需要先准备成员协作权限。");
      expect(Math.abs((await editor.getByLabel("Bus 共同目标", { exact: true }).boundingBox())!.y - taskTop)).toBeLessThanOrEqual(1);
    } finally { releaseRead(); }
    await expect(start).toBeEnabled({ timeout: 7000 });
    f.fixture.permissions.get("main")!.listener = "offline";
    await start.click(); await expect(start).toBeDisabled();
    expect(f.fixture.starts).toEqual([]);
    f.fixture.holdRestartsOffline(false);
    await prepare();
    expect(f.fixture.restarts).toHaveLength(3);
    expect.soft(f.fixture.restarts[2]!.receiptId).not.toBe(f.fixture.restarts[1]!.receiptId);
    expect.soft(f.fixture.restartExecutions.size).toBe(2);
    await expect(start).toBeEnabled();
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("a stop confirmation never switches to a different newly polled run", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    const detail = f.fixture.details.get("bus_one")!;
    const first: AgentBusRun = { id: "run_old", workspaceId: "bus_one", messageId: "old_message", status: "running", text: "原来的任务", createdAt: 1, snapshot: snapshot(detail.workspace), stages: [] };
    detail.runs = [first];
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("协作中");
    await editor.getByRole("button", { name: "停止本次协作", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "停止本次协作？", exact: true });
    await expect(confirm).toBeVisible();
    detail.runs = [{ ...first, status: "completed", finishedAt: 2 }];
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("已完成", { timeout: 7000 });
    const expired = page.getByRole("dialog", { name: "确认已失效", exact: true });
    await expect(expired).toBeVisible();
    await expect(expired).toContainText("协作已结束或发生变化，请关闭此确认。");
    await expect(expired.getByRole("button", { name: "停止本次协作", exact: true })).toHaveCount(0);
    await expect(expired.getByRole("button", { name: "继续协作", exact: true })).toHaveCount(0);
    await expect(expired.locator("footer").getByRole("button", { name: "关闭", exact: true })).toBeEnabled();
    expect(f.fixture.stops).toEqual([]);
    // A new run must not make the old confirmation actionable again.
    detail.runs = [{ ...first, id: "run_new", messageId: "new_message", status: "queued", text: "另一窗口刚启动的任务", createdAt: 2 }, { ...first, status: "completed", finishedAt: 2 }];
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("排队中", { timeout: 7000 });
    await expect(expired).toBeVisible();
    await expect(expired.getByRole("button", { name: "停止本次协作", exact: true })).toHaveCount(0);
    await expect(expired.getByRole("button", { name: "继续协作", exact: true })).toHaveCount(0);
    expect(f.fixture.stops).toEqual([]); expect(detail.runs[0]!.status).toBe("queued");
    await expired.locator("footer").getByRole("button", { name: "关闭", exact: true }).click();
    // A fresh confirmation explicitly targets the new run.
    await editor.getByRole("button", { name: "停止本次协作", exact: true }).click();
    await expect(confirm.getByRole("button", { name: "继续协作", exact: true })).toBeVisible();
    await confirm.getByRole("button", { name: "停止本次协作", exact: true }).click();
    await expect.poll(() => f.fixture.stops.length).toBe(1);
    expect(f.fixture.stops[0]).toMatchObject({ workspaceId: "bus_one", runId: "run_new" });
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("正在停止");
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("manual reload locks inputs and is applied after an already pending background read", async ({ page }) => {
  const f = await setup(page, [workspace()]); let release: (() => void) | undefined;
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("等待重新载入的编辑");
    const gate = f.fixture.delayNextRead(); release = gate.release;
    await gate.entered;
    await editor.getByRole("button", { name: "重新载入配置", exact: true }).click();
    await page.getByRole("dialog", { name: "重新载入配置？", exact: true }).getByRole("button", { name: "重新载入配置", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
    const reads = f.fixture.reads;
    f.fixture.details.get("bus_one")!.workspace = { ...workspace(), name: "重新载入的新配置", revision: "fresh_after_poll" };
    gate.release();
    await expect.poll(() => f.fixture.reads).toBeGreaterThan(reads);
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("重新载入的新配置");
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toBeEnabled();
    await expect(editor.getByRole("tab", { name: "配置", exact: true })).toHaveAttribute("aria-selected", "true");
    await editor.getByLabel("Bus 名称", { exact: true }).fill("从新版本继续编辑");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => f.fixture.updates.length).toBe(1);
    expect(f.fixture.updates[0]!.revision).toBe("fresh_after_poll");
    expect(f.errors).toEqual([]);
  } finally { release?.(); await f.close(); }
});


test("editing a completed Bus preserves its run snapshot and badges until the next explicit start", async ({ page }, info) => {
  const original = workspace();
  const previous: AgentBusRun = { id: "completed_chain", workspaceId: original.id, messageId: "old_task", status: "completed", text: "旧串联任务", createdAt: 10, startedAt: 11, finishedAt: 20, snapshot: snapshot(original), stages: [
    { id: "s1", botId: "research", conversationId: "chat_research", status: "completed", startedAt: 11, finishedAt: 14 },
    { id: "s2", botId: "review", conversationId: "chat_review", status: "completed", startedAt: 15, finishedAt: 19 },
  ] };
  original.latestRun = previous;
  const f = await setup(page, [original]);
  const detail = f.fixture.details.get(original.id)!;
  detail.runs = [previous];
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), hero = editor.locator(".agent-bus-run-hero"), members = editor.locator(".agent-bus-flow");
    await expect(hero).toContainText("串联步骤");
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_research"] .agent-bus-pane-status')).toHaveText("Bus · 已完成");
    await node(page, 1).click();
    await expect(node(page, 1)).toHaveAttribute("aria-pressed", "true");
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("写作委托");
    await editor.getByRole("button", { name: "单人委托", exact: true }).click();
    await editor.getByLabel("成员 1 Bot", { exact: true }).selectOption("writer");
    await editor.getByLabel("成员 1 的记录对话", { exact: true }).selectOption("chat_writer");
    await editor.getByLabel("成员 1 · 任务", { exact: true }).fill("按新分工写作");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(editor.getByRole("heading", { name: "写作委托", exact: true })).toBeVisible();
    // Running evidence and next-run configuration are independent: editing
    // the future writer must not select or rewrite the historical researcher.
    await expect(node(page, 1)).toHaveAttribute("aria-pressed", "true");
    await expect(node(page, 1)).toHaveAttribute("data-bot-id", "review");
    const division = editor.locator(".agent-bus-division");
    await expect(division.getByRole("heading", { name: "最近一次运行的分工", exact: true })).toBeVisible();
    await expect(division).toContainText("步骤 1 · 研究助手");
    await expect(division).toContainText("步骤 2 · 审阅助手");
    await expect(division).not.toContainText("写作助手");
    await expect(division).not.toContainText("按新分工写作");
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.getByLabel("成员 1 Bot", { exact: true })).toHaveValue("writer");
    await expect(editor.getByLabel("成员 1 · 任务", { exact: true })).toHaveValue("按新分工写作");
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await expect(node(page, 1)).toHaveAttribute("aria-pressed", "true");
    // Configuration edits affect only the next intent. Old status evidence
    // still belongs to the immutable mode, participants and record bindings.
    await expect(hero).toContainText("已完成");
    await expect(hero).toContainText("串联步骤");
    await expect(members).toContainText("研究助手");
    await expect(members).toContainText("审阅助手");
    await expect(members).not.toContainText("写作助手");
    const nextConfig = editor.locator(".agent-bus-next-config");
    await expect(nextConfig).toContainText("上方为最近一次运行；下次启动将使用新配置。");
    await expect(nextConfig).toContainText("单人委托");
    await expect(nextConfig).toContainText("协调助手");
    await expect(nextConfig).toContainText("写作助手");
    for (const id of ["main", "research", "review"]) await expect(page.locator(`.adhd-card[data-pane-conversation="chat_${id}"] .agent-bus-pane-status`)).toHaveText("Bus · 已完成");
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_writer"]')).toBeVisible();
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_writer"] .agent-bus-pane-status')).toHaveCount(0);
    expect(f.fixture.starts).toEqual([]);
    expect(detail.runs).toEqual([previous]);
    expect(previous.snapshot).toEqual(snapshot(original));
    await page.locator('.adhd-card[data-pane-conversation="chat_research"]').getByRole("button", { name: "移除此面板", exact: true }).click();
    await editor.getByRole("button", { name: "在面板中显示成员对话", exact: true }).click();
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_research"] .agent-bus-pane-status')).toHaveText("Bus · 已完成");
    await page.screenshot({ path: info.outputPath("saved-config-preserves-run-snapshot.png") });
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("使用新版配置写作");
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect(hero).toContainText("排队中");
    await expect(hero).toContainText("单人委托");
    await expect(nextConfig).toHaveCount(0);
    await expect(members).toContainText("写作助手");
    await expect(members).not.toContainText("研究助手");
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_writer"] .agent-bus-pane-status')).toHaveText("Bus · 排队中");
    for (const id of ["research", "review"]) await expect(page.locator(`.adhd-card[data-pane-conversation="chat_${id}"] .agent-bus-pane-status`)).toHaveCount(0);
    expect(f.fixture.starts).toHaveLength(1);
    expect(f.fixture.starts[0]).toMatchObject({ revision: detail.workspace.revision, text: "使用新版配置写作" });
    expect(detail.runs[0]!.snapshot).toEqual({ name: "写作委托", mode: "ask", coordinator: { botId: "main", conversationId: "chat_main" }, members: [{ botId: "writer", conversationId: "chat_writer", instruction: "按新分工写作" }], maxResearchQuestions: 5, maxRevisionRounds: 1 });
    await expect(division.getByRole("heading", { name: "本次分工", exact: true })).toBeVisible();
    await expect(division).toContainText("成员 1 · 写作助手");
    await expect(division).toContainText("按新分工写作");
    await expect(division).toContainText("仅发起与汇报");
    expect(detail.runs[1]).toEqual(previous);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const mode of ["chain", "fan"] as const) test(`member removal in ${mode} moves tasks with their slots and keeps drafts and records until saved`, async ({ page }, info) => {
  const original = { ...workspace(), mode, members: ["research", "analysis", "review"].map(botId => ({ botId, conversationId: `chat_${botId}` })) };
  const f = await setup(page, [original]);
  try {
    const records = await f.hub.store.db.all("SELECT * FROM messages WHERE conversation_id='chat_research'");
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), noun = mode === "chain" ? "步骤" : "成员", field = mode === "chain" ? "本步任务" : "负责内容";
    const remove = (n: number) => editor.getByRole("button", { name: `移除${noun} ${n}`, exact: true });
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("保留这个任务草稿");
    // The run view is read-only.
    await expect(editor.locator(".agent-bus-slot")).toHaveCount(0);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.locator(".agent-bus-slot .is-remove")).toHaveCount(3);
    await expect(slot(page, -1).locator(".is-remove")).toHaveCount(0);
    await editor.getByLabel(`${noun} 2 · ${field}`, { exact: true }).fill("分析这一部分");
    await remove(1).press("Enter");
    // Focus moves to the slot that took the removed one's place; its task moved with it.
    await expect(editor.getByLabel(`${noun} 1 Bot`, { exact: true })).toBeFocused();
    await expect(editor.getByLabel(`${noun} 1 Bot`, { exact: true })).toHaveValue("analysis");
    await expect(editor.getByLabel(`${noun} 1 · ${field}`, { exact: true })).toHaveValue("分析这一部分");
    await expect(slot(page, 1).locator(".agent-bus-step")).toHaveText("02");
    expect(f.fixture.updates).toEqual([]);
    expect(f.fixture.details.get(original.id)!.workspace.members).toEqual(original.members);
    await page.screenshot({ animations: "disabled", path: info.outputPath(`member-removal-${mode}.png`) });
    await remove(2).click();
    await expect(remove(1)).toBeDisabled();
    await expect(remove(1)).toHaveAttribute("title", "至少保留一位成员");
    // A newly added, unassigned slot can also be removed directly.
    await editor.getByRole("button", { name: mode === "chain" ? "添加步骤" : "添加成员", exact: true }).click();
    await expect(editor.getByLabel(`${noun} 2 Bot`, { exact: true })).toBeFocused();
    await expect(editor.getByLabel(`${noun} 2 Bot`, { exact: true })).toHaveValue("");
    await remove(2).click();
    await expect(editor.getByRole("button", { name: "保存配置", exact: true })).toBeEnabled();
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => f.fixture.updates.length).toBe(1);
    expect(f.fixture.updates[0]!.config.members).toEqual([{ botId: "analysis", conversationId: "chat_analysis", instruction: "分析这一部分" }]);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("保留这个任务草稿");
    // Existing ADHD panes and the removed member's original messages survive.
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_research"]')).toBeAttached();
    expect(await f.hub.store.db.get("SELECT id FROM conversations WHERE id='chat_research'")).toBeTruthy();
    expect(await f.hub.store.db.all("SELECT * FROM messages WHERE conversation_id='chat_research'")).toEqual(records);
    expect(f.fixture.starts).toEqual([]); expect(f.fixture.deletes).toEqual([]);
    // The unsent goal makes reload ask first; this journey discards it deliberately.
    page.once("dialog", dialog => void dialog.accept());
    await page.reload(); await waitForClientOnline(page);
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    await panel(page).getByRole("tab", { name: "配置", exact: true }).click();
    await expect(panel(page).getByLabel(`${noun} 1 Bot`, { exact: true })).toHaveValue("analysis");
    await expect(panel(page).getByLabel(`${noun} 1 · ${field}`, { exact: true })).toHaveValue("分析这一部分");
    await expect(panel(page).locator(".agent-bus-slot")).toHaveCount(2);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("slot removal and tasks respect fixed roles and active-run edit locks", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    const detail = f.fixture.details.get("bus_one")!;
    detail.runs = [{ id: "removal_lock", workspaceId: "bus_one", messageId: "fixture_message", status: "running", text: "运行中", createdAt: 1, snapshot: snapshot(detail.workspace), stages: [] }];
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await expect(editor.locator(".agent-bus-division")).toContainText("运行中不可修改");
    await expect(editor.getByRole("button", { name: "编辑分工", exact: true })).toHaveCount(0);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const removals = editor.locator(".agent-bus-slot .is-remove");
    await expect(removals).toHaveCount(2);
    for (const button of await removals.all()) await expect(button).toBeDisabled();
    for (const field of await editor.locator(".agent-bus-slot textarea").all()) await expect(field).toBeDisabled();
    await expect(editor.getByRole("button", { name: "添加步骤", exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "让 协调助手 执行第 1 步", exact: true })).toBeDisabled();
    detail.runs[0]!.status = "completed";
    await expect(removals.first()).toBeEnabled({ timeout: 7000 });
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toBeEnabled();
    for (const mode of ["单人委托", "回答后复核", "研究团队"]) {
      await editor.getByRole("button", { name: mode, exact: true }).click();
      await expect(removals).toHaveCount(0);
      await expect(editor.getByRole("button", { name: "让 协调助手 执行第 1 步", exact: true })).toHaveCount(0);
    }
    expect(f.fixture.updates).toEqual([]); expect(f.fixture.starts).toEqual([]); expect(f.fixture.stops).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("repeated Bot slots show both names, bind separate chats and keep per-chat ADHD status", async ({ page }, info) => {
  const original = workspace();
  let second = "";
  const f = await setup(page, [original], async hub => {
    second = (await hub.store.createConversation("owner", ["research"], "资料复核", "repeat_record")).id;
  });
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("步骤 2 · 本步任务", { exact: true }).fill("复核资料来源");
    await editor.getByLabel("步骤 2 Bot", { exact: true }).selectOption("research");
    // The task belongs to the slot; only the record binding follows the Bot.
    await expect(editor.getByLabel("步骤 2 · 本步任务", { exact: true })).toHaveValue("复核资料来源");
    const conversations = editor.getByLabel("步骤 2 的记录对话", { exact: true });
    await expect(conversations).toHaveValue("");
    await expect(conversations.locator('option[value="chat_research"]')).toHaveAttribute("disabled", "");
    await conversations.selectOption(second);
    await editor.getByLabel("步骤 1 · 本步任务", { exact: true }).fill("整理资料");
    await expect(editor.getByLabel("步骤 1 Bot", { exact: true })).toHaveValue("research");
    await expect(editor.getByLabel("步骤 1 的记录对话", { exact: true })).toHaveValue("chat_research");
    await editor.getByRole("button", { name: "上移步骤 2", exact: true }).click();
    // Repeated Bots keep their own conversation and task while moving.
    await expect(editor.getByRole("button", { name: "下移步骤 1", exact: true })).toBeFocused();
    await expect(editor.getByLabel("步骤 1 的记录对话", { exact: true })).toHaveValue(second);
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toHaveValue("复核资料来源");
    await expect(editor.getByLabel("步骤 2 的记录对话", { exact: true })).toHaveValue("chat_research");
    await expect(editor.getByLabel("步骤 2 · 本步任务", { exact: true })).toHaveValue("整理资料");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => f.fixture.updates.length).toBe(1);
    expect(f.fixture.updates[0]!.config.members).toEqual([{ botId: "research", conversationId: second, instruction: "复核资料来源" }, { botId: "research", conversationId: "chat_research", instruction: "整理资料" }]);
    await expect(editor.locator(".agent-bus-division li")).toHaveText([/发起者 · 协调助手/, /步骤 1 · 研究助手复核资料来源/, /步骤 2 · 研究助手整理资料/]);
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("逐步核查");
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect.poll(() => f.fixture.starts.length).toBe(1);
    const detail = f.fixture.details.get(original.id)!;
    detail.runs[0]!.status = "running";
    detail.runs[0]!.stages = [{ id: "s1", botId: "research", conversationId: second, status: "completed", startedAt: 1 }, { id: "s2", botId: "research", conversationId: "chat_research", status: "running", startedAt: 2 }];
    await expect(node(page, 0)).toContainText("本步完成");
    await expect(node(page, 1)).toContainText("执行中");
    await expect(page.locator(`.adhd-card[data-pane-conversation="${second}"] .agent-bus-pane-status`)).toHaveText("Bus · 本步完成");
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_research"] .agent-bus-pane-status')).toHaveText("Bus · 执行中");
    await page.screenshot({ path: info.outputPath("bot-and-conversation.png") });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("the division list edits every slot in place while preserving ordered identities and private record bindings", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.locator(".agent-bus-flow")).toHaveCount(0);
    await expect(editor.locator(".agent-bus-slot")).toHaveCount(3);
    const selection = editor.getByLabel("步骤 2 Bot", { exact: true });
    await expect(selection).toHaveValue("review");
    await expect(selection.locator('option[value="main"],option[value="research"]')).toHaveCount(2);
    await expect(editor.getByLabel("步骤 2 的记录对话", { exact: true })).toHaveValue("chat_review");
    await expect(editor.getByLabel("步骤 1 的记录对话", { exact: true })).toHaveValue("chat_research");
    await editor.getByRole("button", { name: "上移步骤 2", exact: true }).click();
    await expect(editor.getByRole("button", { name: "下移步骤 1", exact: true })).toBeFocused();
    await expect(editor.getByLabel("步骤 1 Bot", { exact: true })).toHaveValue("review");
    await expect(editor.getByLabel("步骤 2 Bot", { exact: true })).toHaveValue("research");
    // A mode with fewer slots keeps the rest aside and says so.
    await editor.getByRole("button", { name: "单人委托", exact: true }).click();
    await expect(editor.locator(".agent-bus-slot")).toHaveCount(2);
    await expect(editor.getByLabel("成员 1 Bot", { exact: true })).toHaveValue("review");
    await expect(editor.locator(".agent-bus-roster")).toContainText("另有 1 位成员已暂存");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => f.fixture.updates.length).toBe(1);
    expect(f.fixture.updates[0]!.config.members).toEqual([{ botId: "review", conversationId: "chat_review" }]);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.locator(".agent-bus-roster")).not.toContainText("已暂存");
    expect(f.fixture.starts).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("run graph opens only the chosen member and preserves ADHD drafts and expanded focus", async ({ page }, info) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    const main = page.locator('.adhd-card[data-pane-conversation="chat_main"]');
    const research = page.locator('.adhd-card[data-pane-conversation="chat_research"]');
    const review = page.locator('.adhd-card[data-pane-conversation="chat_review"]');
    await main.locator(".composer textarea").fill("保留发起对话草稿");
    await research.getByRole("button", { name: "移除此面板", exact: true }).click();
    await review.getByRole("button", { name: "移除此面板", exact: true }).click();
    await expect(page.locator(".adhd-card")).toHaveCount(1);
    await node(page, 1).focus();
    await page.keyboard.press("Enter");
    await expect(review).toBeVisible();
    await expect(review).toHaveClass(/is-focused/);
    await expect(page.locator(".adhd-card")).toHaveCount(2);
    await expect(research).toHaveCount(0);
    await expect(main.locator(".composer textarea")).toHaveValue("保留发起对话草稿");
    await review.locator(".composer textarea").fill("保留审阅对话草稿");
    await review.getByRole("button", { name: "放大此面板", exact: true }).click();
    await expect(review).toHaveClass(/is-expanded/);
    await node(page, -1).click();
    await expect(main).toBeVisible();
    await expect(main).toHaveClass(/is-focused/);
    await expect(main).toHaveClass(/is-expanded/);
    await expect(review).toBeHidden();
    await main.getByRole("button", { name: "回到面板总览", exact: true }).click();
    await expect(review.locator(".composer textarea")).toHaveValue("保留审阅对话草稿");
    expect(f.fixture.starts).toEqual([]); expect(f.fixture.updates).toEqual([]); expect(f.fixture.stops).toEqual([]);
    await page.screenshot({ path: info.outputPath("graph-member-focus-preserves-drafts.png") });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("run graph keeps active motion enabled and stops it while hidden or terminal", async ({ page }, info) => {
  const original: AgentBusWorkspace = { ...workspace(), mode: "crew", members: ids.slice(1).map(botId => ({ botId, conversationId: `chat_${botId}` })) };
  const f = await setup(page, [original]);
  const current: AgentBusRun = { id: "graph_run", workspaceId: original.id, messageId: "graph_task", status: "running", text: "逐步审阅", createdAt: 10, startedAt: 11, snapshot: snapshot(original), stages: [
    { id: "s1", botId: "research", conversationId: "chat_research", status: "completed", startedAt: 11, finishedAt: 12 },
    { id: "s2", botId: "analysis", conversationId: "chat_analysis", status: "running", startedAt: 13 },
  ] };
  const detail = f.fixture.details.get(original.id)!; detail.runs = [current];
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    // This graph intentionally remains mounted behind aria-hidden/inert when
    // closed. Use its DOM selector for hidden-state animation observations.
    const editor = panel(page), graph = page.locator(".agent-bus-panel .agent-bus-flow");
    await expect(node(page, 0).locator(".agent-bus-flow-node-status")).toHaveText("本步完成");
    await expect(node(page, 1).locator(".agent-bus-flow-node-status")).toHaveText("执行中");
    const settledDock = () => expect.poll(() => page.locator(".agent-bus-dock").evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
    await settledDock();
    const initialWidth = await graph.locator(".agent-bus-flow-viewport").evaluate(element => {
      const samples = [element.clientWidth], observer = new ResizeObserver(() => samples.push(element.clientWidth));
      observer.observe(element); Object.assign(window, { agentBusWidthProbe: { samples, stop: () => observer.disconnect() } });
      return element.clientWidth;
    });
    const endlessAnimations = () => graph.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations === Infinity && animation.playState === "running").length);
    await expect.poll(endlessAnimations).toBeGreaterThan(0);
    await expect(graph.locator(".agent-bus-flow-edge").last()).toHaveClass(/is-active/);
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect.poll(endlessAnimations).toBe(0);
    await settledDock();
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    await expect.poll(endlessAnimations).toBeGreaterThan(0);
    await settledDock();
    const widths = await page.evaluate(() => { const probe = (window as unknown as { agentBusWidthProbe: { samples: number[]; stop: () => void } }).agentBusWidthProbe; probe.stop(); return probe.samples; });
    expect([...new Set(widths)]).toEqual([initialWidth]);
    await info.attach("dock-flow-widths", { body: JSON.stringify({ initialWidth, widths }), contentType: "application/json" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(endlessAnimations).toBeGreaterThan(0);
    await expect(node(page, 1).locator(".agent-bus-flow-node-status")).toHaveText("执行中");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(endlessAnimations).toBeGreaterThan(0);
    current.stages = [
      current.stages[0]!,
      { id: "s3", botId: "research", conversationId: "chat_research", status: "failed", startedAt: 11, finishedAt: 12, error: "One research question failed" },
      { id: "s4", botId: "research", conversationId: "chat_research", status: "completed", startedAt: 11, finishedAt: 12 },
      current.stages[1]!,
    ];
    detail.runs[0] = { ...current };
    await expect(node(page, 0).locator(".agent-bus-flow-node-status")).toHaveText("2/3 步完成", { timeout: 7000 });
    await expect(node(page, 0)).toHaveClass(/is-partial/);
    await expect(node(page, 1).locator(".agent-bus-flow-node-status")).toHaveText("执行中");
    await expect(node(page, 1)).toHaveClass(/is-running/);
    await page.screenshot({ animations: "disabled", path: info.outputPath("crew-partial-research-continues-analysis.png") });
    detail.runs[0] = { ...current, status: "stopping" };
    await expect(node(page, 1).locator(".agent-bus-flow-node-status")).toHaveText("正在停止", { timeout: 7000 });
    await expect(node(page, 1)).toHaveClass(/is-stopping/);
    await expect.poll(endlessAnimations).toBe(0);
    detail.runs[0] = { ...current, status: "cancelled", finishedAt: 14, stages: current.stages.map(stage => stage.status === "running" ? { ...stage, status: "cancelled", finishedAt: 14 } : stage) };
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("已取消", { timeout: 7000 });
    await expect(node(page, 0).locator(".agent-bus-flow-node-status")).toHaveText("2/3 步完成");
    await expect(node(page, 0)).toHaveClass(/is-partial/);
    await expect(node(page, 1).locator(".agent-bus-flow-node-status")).toHaveText("已取消");
    await expect.poll(endlessAnimations).toBe(0);
    await page.screenshot({ path: info.outputPath("graph-cancelled-keeps-completed-evidence.png") });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("saving and explicitly revealing a Bus brings its appended panes into view without moving focus or repolling the viewport", async ({ page }, info) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 1440, height: 960 });
  const oldChats: { id: string; title: string }[] = [];
  const f = await setup(page, [], async hub => {
    for (let index = 0; index < 8; index++) oldChats.push(await hub.store.createConversation("owner", ["writer"], `原有窗口 ${index + 1}`, `old_${index}`));
  });
  try {
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of oldChats) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption("2");
    const grid = page.locator(".adhd-grid"), cards = page.locator(".adhd-card"), original = oldChats.map(chat => chat.id);
    const order = () => cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.paneConversation));
    await grid.evaluate(element => { element.scrollTop = 0; });
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 名称", { exact: true }).fill("下方新 Bus");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("main");
    await editor.getByLabel("成员 1 Bot", { exact: true }).selectOption("research");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    const coordinator = page.locator('.adhd-card[data-pane-conversation="chat_main"]'), header = coordinator.locator(".conversation-header");
    await expect(cards).toHaveCount(10);
    expect(await order()).toEqual([...original, "chat_main", "chat_research"]);
    await expect(header).toBeInViewport({ ratio: 0.9 });
    await expect(coordinator.locator(".composer textarea")).not.toBeFocused();
    await page.screenshot({ path: info.outputPath("saved-bus-appended-panes-visible.png") });

    // Polls update state but never undo the user's scroll or typing position.
    const first = page.locator(`.adhd-card[data-pane-conversation="${original[0]}"]`), draft = first.locator(".composer textarea");
    await grid.evaluate(element => { element.scrollTop = 0; });
    await draft.fill("继续原有对话的草稿");
    const reads = f.fixture.reads;
    await expect.poll(() => f.fixture.reads, { timeout: 10_000 }).toBeGreaterThan(reads);
    await expect(draft).toBeFocused();
    expect(await grid.evaluate(element => element.scrollTop)).toBe(0);
    await expect(header).not.toBeInViewport();

    // Re-selecting a Bus after collapsing its dock must still reveal the
    // target after the dock transition changes the automatic column count.
    await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption("0");
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    await expect(page.locator(".agent-bus-dock")).toHaveCSS("width", "0px");
    await grid.evaluate(element => { element.scrollTop = 0; });
    await page.getByRole("button", { name: "打开 Bus：下方新 Bus", exact: true }).click();
    await expect(page.locator(".agent-bus-dock")).toHaveCSS("width", "440px");
    await expect(header).toBeInViewport({ ratio: 0.9 });
    await page.screenshot({ path: info.outputPath("reopened-bus-automatic-columns.png") });

    // Scrolling during a second dock opening cancels its pending correction.
    // Use a real wheel gesture on grid padding, not a synthetic scroll event.
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    const dock = page.locator(".agent-bus-dock");
    await expect(dock).toHaveCSS("width", "0px");
    await grid.evaluate(element => { element.scrollTop = 0; });
    const frame = (await grid.boundingBox())!;
    // Exercise wheel cancellation during a real transition without requiring
    // several Playwright round trips to fit inside its normal 240 ms duration.
    const slowTransition = await page.addStyleTag({ content: ".agent-bus-dock { transition-duration: 2s !important; }" });
    await page.getByRole("button", { name: "打开 Bus：下方新 Bus", exact: true }).click();
    await expect.poll(() => grid.evaluate(element => element.scrollTop), { intervals: [0, 5] }).toBeGreaterThan(0);
    await expect.poll(() => dock.evaluate(element => element.getAnimations().some(animation => animation.playState === "running")), { intervals: [0, 5] }).toBe(true);
    await page.mouse.move(frame.x + 3, frame.y + 3); await page.mouse.wheel(0, -4000);
    await expect(dock).toHaveCSS("width", "440px");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => grid.evaluate(element => element.scrollTop)).toBe(0);
    await expect(header).not.toBeInViewport();
    await slowTransition.evaluate(element => element.remove());
    // Merely toggling the dock does not create a new reveal intent or revive
    // the serial already cancelled by the wheel gesture.
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    await expect(dock).toHaveCSS("width", "0px");
    await grid.evaluate(element => { element.scrollTop = 0; });
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    await expect(dock).toHaveCSS("width", "440px");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await grid.evaluate(element => element.scrollTop)).toBe(0);
    await expect(header).not.toBeInViewport();

    // The system preference no longer disables App motion. Wait for the
    // same settled reveal before checking that no transition is left running.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    await expect(dock).toHaveCSS("width", "0px");
    await grid.evaluate(element => { element.scrollTop = 0; });
    await page.getByRole("button", { name: "打开 Bus：下方新 Bus", exact: true }).click();
    await expect(header).toBeInViewport({ ratio: 0.9 });
    await expect.poll(() => dock.evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
    await grid.evaluate(element => { element.scrollTop = 0; });
    const reveal = editor.getByRole("button", { name: "在面板中显示成员对话", exact: true });
    await reveal.focus(); await reveal.press("Enter");
    await expect(header).toBeInViewport({ ratio: 0.9 });
    await expect(reveal).toBeFocused();

    // An unrelated expanded pane must not keep every Bus member hidden.
    await first.getByRole("button", { name: "放大此面板", exact: true }).click();
    await expect(coordinator).toBeHidden();
    await reveal.focus(); await reveal.press("Enter");
    await expect(header).toBeInViewport({ ratio: 0.9 });
    await expect(reveal).toBeFocused();
    await expect(grid).not.toHaveClass(/has-expanded/);
    expect(await order()).toEqual([...original, "chat_main", "chat_research"]);
    await expect(draft).toHaveValue("继续原有对话的草稿");
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("reduced-motion Bus reveal waits for a late column change before correcting the viewport", async ({ page }) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 1440, height: 960 });
  // Opening the dock narrows the grid; the automatic column count follows its
  // ResizeObserver render. Defer those callbacks so that render commits well
  // after the two-frame correction, as happened intermittently in CI.
  await page.addInitScript(() => {
    const Native = window.ResizeObserver;
    window.ResizeObserver = class extends Native {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => { const delay = (window as any).__resizeDelay ?? 0; if (delay) setTimeout(() => callback(entries, observer), delay); else callback(entries, observer); });
      }
    };
  });
  const oldChats: { id: string; title: string }[] = [];
  const f = await setup(page, [], async hub => {
    for (let index = 0; index < 8; index++) oldChats.push(await hub.store.createConversation("owner", ["writer"], `原有窗口 ${index + 1}`, `old_${index}`));
  });
  try {
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of oldChats) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption("2");
    const grid = page.locator(".adhd-grid");
    await grid.evaluate(element => { element.scrollTop = 0; });
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page);
    await expect(editor.getByText("正在载入协作…", { exact: true })).toHaveCount(0);
    await editor.getByLabel("Bus 名称", { exact: true }).fill("下方新 Bus");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("main");
    await editor.getByLabel("成员 1 Bot", { exact: true }).selectOption("research");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    const header = page.locator('.adhd-card[data-pane-conversation="chat_main"]').locator(".conversation-header");
    await expect(page.locator(".adhd-card")).toHaveCount(10);
    await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption("0");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const dock = page.locator(".agent-bus-dock");
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    await expect(dock).toHaveCSS("width", "0px");
    const columns = () => grid.evaluate(element => getComputedStyle(element).getPropertyValue("--adhd-columns").trim());
    const collapsed = await columns();
    await grid.evaluate(element => { element.scrollTop = 0; });
    await page.evaluate(() => { (window as any).__resizeDelay = 400; });
    await page.getByRole("button", { name: "打开 Bus：下方新 Bus", exact: true }).click();
    await expect(dock).toHaveCSS("width", "440px");
    // The late render does change the column count; the reveal must survive it.
    await expect.poll(columns).not.toBe(collapsed);
    await expect(header).toBeInViewport({ ratio: 0.9 });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("Bus reveal at capacity keeps existing panes and reveals an available member when its coordinator cannot open", async ({ page }, info) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 1440, height: 960 });
  const fallback: AgentBusWorkspace = { ...workspace("bus_fallback", "已有成员的 Bus"), mode: "ask", members: [{ botId: "writer", conversationId: "chat_writer" }] };
  const oldChats: { id: string; title: string }[] = [];
  const f = await setup(page, [workspace(), fallback], async hub => {
    for (let index = 0; index < 11; index++) oldChats.push(await hub.store.createConversation("owner", ["analysis"], `满板窗口 ${index + 1}`, `full_${index}`));
  });
  try {
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of oldChats) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
    await page.getByRole("checkbox", { name: "加入面板：测试主机 · 写作助手记录", exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption("2");
    const cards = page.locator(".adhd-card"), order = () => cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.paneConversation));
    const original = [...oldChats.map(chat => chat.id), "chat_writer"];
    const first = page.locator(`.adhd-card[data-pane-conversation="${oldChats[0]!.id}"]`);
    await first.getByRole("button", { name: "放大此面板", exact: true }).click();
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    await expect(panel(page).getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    await expect(page.locator(".adhd-notice")).toContainText("有 3 个成员窗口尚未打开");
    await expect(first).toHaveClass(/is-expanded/);
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_main"]')).toHaveCount(0);
    expect(await order()).toEqual(original);

    await page.getByRole("button", { name: "打开 Bus：已有成员的 Bus", exact: true }).click();
    await expect(panel(page).getByRole("heading", { name: "已有成员的 Bus", exact: true })).toBeVisible();
    const writer = page.locator('.adhd-card[data-pane-conversation="chat_writer"]');
    await expect(writer.locator(".conversation-header")).toBeInViewport({ ratio: 0.9 });
    await expect(page.locator(".adhd-grid")).not.toHaveClass(/has-expanded/);
    await expect(writer.locator(".composer textarea")).not.toBeFocused();
    await expect(page.locator(".adhd-notice")).toContainText("有 1 个成员窗口尚未打开");
    await expect(cards).toHaveCount(12);
    expect(await order()).toEqual(original);
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("full-board-existing-bus-member-visible.png") });
    const removeSelectedBus = async () => {
      await panel(page).getByRole("tab", { name: "配置", exact: true }).click();
      await panel(page).getByRole("button", { name: "删除 Bus", exact: true }).click();
      await page.getByRole("dialog", { name: "删除这个 Bus？", exact: true }).getByRole("button", { name: "删除 Bus", exact: true }).click();
      await expect(panel(page)).toHaveCount(0);
    };
    await removeSelectedBus();
    await expect(page.locator(".adhd-notice")).toHaveCount(0);
    expect(f.fixture.deletes).toEqual(["bus_fallback"]);
    expect(await order()).toEqual(original);

    // Deleting a Bus must preserve an unrelated board-capacity notice that
    // replaced the Bus-specific notice after an explicit conversation click.
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    await expect(page.locator(".adhd-notice")).toContainText("有 3 个成员窗口尚未打开");
    await panel(page).locator('.agent-bus-flow-node[data-bot-id="main"]').click();
    const capacity = "最多同时打开 12 个对话。请先移除一个面板。";
    await expect(page.locator(".adhd-notice")).toContainText(capacity);
    await removeSelectedBus();
    await expect(page.locator(".adhd-notice")).toContainText(capacity);
    expect(f.fixture.deletes).toEqual(["bus_fallback", "bus_one"]);
    expect(await order()).toEqual(original);
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("a full Bus fits desktop themes and cannot displace another conversation when the board is full", async ({ page }, info) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-full-graph-"));
  const hub = await HubServer.start({ stateDir: root, clientDir });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await seed(hub);
    for (let index = 0; index < 8; index++) {
      const id = `extra_${index}`;
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES(?,?,?,1)", [id, `很长的协作成员名称 · ${index + 1} · Research and review`, hashSecret(`fixture-${id}`)]);
      await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES(?,'direct',?,'owner',1,?)", [`chat_${id}`, `额外记录 ${index + 1}`, `chat_${id}`]);
      await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','owner',0)", [`chat_${id}`]);
      await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot',?,0)", [`chat_${id}`, id]);
    }
    const large: AgentBusWorkspace = { ...workspace(), mode: "fan", members: [...ids.slice(1), ...Array.from({ length: 7 }, (_, i) => `extra_${i}`)].map(botId => ({ botId, conversationId: `chat_${botId}` })) };
    const fixture = await api(page, hub, [large]);
    await page.goto(hub.url); await pair(page, hub);
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), graph = editor.locator(".agent-bus-flow");
    await expect(editor.locator(".agent-bus-flow-node")).toHaveCount(12);
    await expect(page.locator(".adhd-card")).toHaveCount(12);
    await page.locator('.adhd-card[data-pane-conversation="chat_review"]').getByRole("button", { name: "移除此面板", exact: true }).click();
    await page.getByRole("checkbox", { name: "加入面板：测试主机 · 额外记录 8", exact: true }).check();
    await expect(page.locator(".adhd-card")).toHaveCount(12);
    await editor.locator('.agent-bus-flow-node[data-bot-id="review"]').click();
    await expect(page.getByText("最多同时打开 12 个对话。请先移除一个面板。", { exact: true })).toBeVisible();
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_review"]')).toHaveCount(0);
    await expect(page.locator('.adhd-card[data-pane-conversation="chat_extra_7"]')).toBeVisible();
    // The run graph keeps eleven long-named members inside the panel.
    expect(await graph.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const roster = editor.locator(".agent-bus-roster");
    await expect(roster.locator(".is-remove")).toHaveCount(11);
    await editor.getByLabel("成员 11 · 负责内容", { exact: true }).fill(Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 条较长的分工要求，用来确认任务框只增长到六行。`).join("\n"));
    for (const [width, palette, theme] of [[1440, "white-violet", "light"], [1100, "white-violet", "dark"], [1024, "cli", "dark"]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await openSettings(page);
      await page.locator(`input[name="color-palette"][value="${palette}"]`).check();
      if (palette !== "cli") await page.getByLabel("主题", { exact: true }).selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await closeSettings(page);
      await expect(editor).toBeVisible();
      expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await roster.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const geometry = await roster.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll(".agent-bus-slot")].map(slot => {
          const rect = slot.getBoundingClientRect(), controls = [...slot.querySelectorAll("select,textarea,button")].map(control => control.getBoundingClientRect());
          return { inside: rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1, contained: controls.every(box => box.left >= rect.left - 1 && box.right <= rect.right + 1) };
        });
      });
      expect(geometry).toHaveLength(12);
      for (const box of geometry) { expect(box.inside).toBe(true); expect(box.contained).toBe(true); }
      const controls = await roster.locator(".is-remove").evaluateAll(buttons => buttons.map(button => { const box = button.getBoundingClientRect(); return { width: box.width, height: box.height }; }));
      for (const control of controls) { expect(control.width).toBeGreaterThanOrEqual(24); expect(control.height).toBeGreaterThanOrEqual(24); }
      // Two to six lines: the long task stops growing and scrolls internally.
      const longTask = await editor.getByLabel("成员 11 · 负责内容", { exact: true }).evaluate(element => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), scrolls: element.scrollHeight > element.clientHeight + 1 }));
      expect(longTask.height).toBeGreaterThan(longTask.line * 5);
      expect(longTask.height).toBeLessThanOrEqual(longTask.line * 6 + 20);
      expect(longTask.scrolls).toBe(true);
      await page.screenshot({ path: info.outputPath(`full-roster-${width}-${palette}-${theme}.png`) });
      if (width === 1440) {
        const scroll = editor.locator(".agent-bus-panel-scroll"), board = page.locator(".adhd-grid");
        await scroll.evaluate(element => { element.scrollTop = 0; });
        const panelBox = (await scroll.boundingBox())!, boardTop = await board.evaluate(element => element.scrollTop);
        await page.mouse.move(panelBox.x + 30, panelBox.y + panelBox.height / 2);
        for (let i = 0; i < 6 && !await slot(page, 10).evaluate(element => { const box = element.getBoundingClientRect(), view = element.closest(".agent-bus-panel-scroll")!.getBoundingClientRect(); return box.bottom <= view.bottom + 1; }); i++) await page.mouse.wheel(0, 800);
        await expect(slot(page, 10)).toBeInViewport();
        expect(await board.evaluate(element => element.scrollTop)).toBe(boardTop);
        expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
        await page.screenshot({ path: info.outputPath("parallel-wheel-reaches-last-member.png"), animations: "disabled" });
        await scroll.evaluate(element => { element.scrollTop = 0; });
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await openSettings(page);
    await page.locator('input[name="color-palette"][value="white-violet"]').check();
    await page.getByLabel("主题", { exact: true }).selectOption("light");
    await page.locator("#language").selectOption("en");
    await closeSettings(page, true);
    const english = page.locator(".agent-bus-panel");
    await expect(english.getByRole("tab", { name: "Run", exact: true })).toBeVisible();
    await english.getByRole("tab", { name: "Configuration", exact: true }).click();
    const modes = english.locator(".agent-bus-mode-picker button");
    await expect(modes).toHaveCount(5);
    const labels = await modes.evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(button);
      return { name: button.textContent, fits: button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight && [...range.getClientRects()].every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1) };
    }));
    for (const label of labels) expect(label.fits, `${label.name} must remain fully readable in the compact mode selector`).toBe(true);
    expect(await english.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: info.outputPath("english-configuration-modes-1440.png") });
    expect(fixture.starts).toEqual([]); expect(fixture.updates).toEqual([]); expect(errors).toEqual([]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ordinary ADHD entry never replays an old or cancelled Bus navigation intent", async ({ page }) => {
  test.setTimeout(90_000);
  // Delay only the local draft receipt so the real App's entry guard is
  // exercised; the underlying IndexedDB write and later reload remain real.
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    const controls = { hold: false, release: () => {} }; Object.assign(window, { busDraftReceipts: controls });
    let queued: (() => void)[] = [];
    controls.release = () => { controls.hold = false; const all = queued; queued = []; for (const run of all) run(); };
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.call(this, value, key);
      if (this.name === "settings" && String(key).startsWith("draft:") && controls.hold) {
        const add = request.addEventListener.bind(request);
        request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type === "success") add(type, event => {
            const run = () => typeof listener === "function" ? listener.call(request, event) : listener.handleEvent(event);
            if (controls.hold) queued.push(run); else run();
          }, options); else add(type, listener, options);
        }) as typeof request.addEventListener;
      }
      return request;
    };
  });
  const f = await setup(page, [workspace()]);
  const release = () => page.evaluate(() => (window as unknown as { busDraftReceipts: { release: () => void } }).busDraftReceipts.release());
  const enterOrdinary = async () => {
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(page.locator(".adhd-shell")).toBeVisible();
    await expect(panel(page)).not.toBeVisible();
  };
  const returnToChat = async () => {
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await expect(page.locator(".adhd-shell")).toHaveCount(0);
  };
  const addUnsavedAttachments = async () => {
    await page.locator('input[type="file"][multiple]').setInputFiles(Array.from({ length: 33 }, (_, index) => ({ name: `draft-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from(`local draft ${index}`) })));
    await expect(page.getByText("草稿未自动保存", { exact: false })).toBeVisible();
  };
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    await expect(panel(page).getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    await returnToChat();
    await enterOrdinary(); // A prior successful Bus entry is not a new intent.
    await returnToChat();
    await page.locator('.sidebar [data-conversation-id="chat_main"]').click();
    await page.evaluate(() => { (window as unknown as { busDraftReceipts: { hold: boolean } }).busDraftReceipts.hold = true; });
    await page.locator(".composer textarea").fill("取消进入后仍然保存的草稿");
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const pending = page.locator(".adhd-entry-notice");
    await expect(pending).toContainText("正在保存草稿");
    await pending.getByRole("button", { name: "取消", exact: true }).click();
    await release();
    await expect(page.getByLabel("草稿状态", { exact: true })).toHaveText("草稿已保存");
    await expect(page.locator(".adhd-shell")).toHaveCount(0);
    await enterOrdinary();
    await returnToChat();
    await addUnsavedAttachments();
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "有草稿尚未保存", exact: true });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(confirm).not.toBeVisible();
    await expect(page.locator(".adhd-shell")).toHaveCount(0);
    await expect(page.getByText("draft-32.txt", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await confirm.getByRole("button", { name: "放弃未保存的修改", exact: true }).click();
    await expect(page.locator(".adhd-shell")).toBeVisible();
    await expect(panel(page)).not.toBeVisible();
    await returnToChat();
    // A fresh Bus intent survives deliberate continuation through the guard.
    await addUnsavedAttachments();
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    await confirm.getByRole("button", { name: "放弃未保存的修改", exact: true }).click();
    await expect(panel(page).getByRole("heading", { name: "产品评审", exact: true })).toBeVisible();
    await expect(panel(page).getByLabel("Bus 共同目标", { exact: true })).toBeVisible();
    expect(f.fixture.starts).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally { await release().catch(() => undefined); await f.close(); }
});

test("real Hub Bus stage records keep streaming without taking over ordinary chat controls", async ({ page }, info) => {
  const f = await setup(page, [workspace()]);
  const stageCard = (status: "running" | "completed"): Block => ({ type: "card", title: "Agent Bus · 真实记录", template: status === "running" ? "blue" : "green", elements: [{ type: "markdown", text: status === "running" ? "独立成员仍在执行" : "独立成员执行完成" }], extra: { agentBusStage: { runId: "record_run", workspaceId: "bus_one", stageId: "s1", status } } });
  const nativeCard = (phase: "working" | "done"): Block => ({ type: "card", title: "真正的普通前台任务", elements: [], extra: { agentBusStage: { runId: "record_run", workspaceId: "bus_one", stageId: "s2", status: "running" }, nativeRun: { version: 1, id: "native_foreground", revision: phase === "working" ? 1 : 2, phase, startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false } } });
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const chat = page.locator('.adhd-card[data-pane-conversation="chat_research"]');
    await expect(chat.locator(".composer textarea")).toBeVisible();
    const idle = async () => {
      await expect(chat.locator(".composer")).not.toHaveClass(/is-live/);
      await expect(chat.locator(".composer-stop")).toHaveCount(0);
      await expect(chat.locator(".composer-hint")).not.toContainText("普通发送将排队");
      await expect(chat.locator(".header-activity")).toHaveText("");
    };
    // Unlike the Bus API fixture, these are real persisted Hub message events,
    // including the update of the same streaming record to its terminal state.
    const record = await f.hub.store.publishBotMessage("research", { conversationId: "chat_research", status: "streaming", blocks: [stageCard("running")] });
    const row = chat.locator(`[data-message-id="${record.id}"]`);
    await expect(row).toContainText("独立成员仍在执行");
    await idle();
    await expect(row.locator(".message-avatar")).not.toHaveClass(/is-working|is-pending/);
    await expect(row.getByRole("button", { name: "转发消息", exact: true })).toBeDisabled();
    await expect(row.getByRole("button", { name: "转发消息", exact: true })).toHaveAttribute("title", "生成完成后可转发");
    expect((await f.hub.store.snapshot("owner", "chat_research")).messages.find(message => message.id === record.id)?.status).toBe("streaming");
    const ordinary = await f.hub.store.publishBotMessage("research", { conversationId: "chat_research", status: "streaming", blocks: [{ type: "text", text: "同对话里的普通回复" }] });
    await expect(chat.locator(".composer")).toHaveClass(/is-live/);
    await expect(chat.locator(".composer-stop")).toBeVisible();
    await expect(chat.locator(".composer-hint")).toContainText("普通发送将排队");
    await expect(chat.locator(".header-activity")).toContainText("正在回复");
    await expect(row.getByRole("button", { name: "转发消息", exact: true })).toBeDisabled();
    await f.hub.store.publishBotMessage("research", { id: ordinary.id, conversationId: "chat_research", status: "complete", blocks: [{ type: "text", text: "普通回复已完成，Bus 仍在执行" }] });
    await idle();
    const native = await f.hub.store.publishBotMessage("research", { conversationId: "chat_research", status: "streaming", blocks: [nativeCard("working")] });
    await expect(chat.locator(".composer")).toHaveClass(/is-live/);
    await expect(chat.locator(".composer-stop")).toBeVisible();
    await expect(chat.locator(".header-activity")).toContainText("正在回复");
    await f.hub.store.publishBotMessage("research", { id: native.id, conversationId: "chat_research", status: "complete", blocks: [nativeCard("done")] });
    await idle();
    await expect(row.getByRole("button", { name: "转发消息", exact: true })).toBeDisabled();
    expect((await f.hub.store.snapshot("owner", "chat_research")).messages.find(message => message.id === record.id)?.status).toBe("streaming");
    const terminal = await f.hub.store.publishBotMessage("research", { id: record.id, conversationId: "chat_research", status: "complete", blocks: [stageCard("completed"), { type: "text", text: "Bus 最终交付结果" }] });
    expect(terminal.version).toBeGreaterThan(record.version);
    await expect(row).toContainText("Bus 最终交付结果");
    await expect(row.getByRole("button", { name: "转发消息", exact: true })).toBeEnabled();
    await idle();
    await page.screenshot({ path: info.outputPath("real-bus-record-terminal-controls.png") });
    expect(f.fixture.starts).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


test("configuration keeps every slot editable and restores bindings and tasks when trying another mode", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const original = { ...workspace(), members: ["research", "analysis", "review"].map(botId => ({ botId, conversationId: `chat_${botId}` })) };
  const f = await setup(page, [original]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.getByLabel("步骤 3 Bot", { exact: true })).toHaveValue("review");
    await editor.getByLabel("步骤 3 · 本步任务", { exact: true }).fill("审阅并给出结论");
    await page.screenshot({ animations: "disabled", path: info.outputPath("division-editor.png") });
    await editor.getByRole("button", { name: "单人委托", exact: true }).click();
    await expect(editor.locator(".agent-bus-roster")).toContainText("另有 2 位成员已暂存");
    await editor.getByRole("button", { name: "串联步骤", exact: true }).click();
    for (const [i, member] of original.members.entries()) {
      await expect(editor.getByLabel(`步骤 ${i + 1} Bot`, { exact: true })).toHaveValue(member.botId);
      await expect(editor.getByLabel(`步骤 ${i + 1} 的记录对话`, { exact: true })).toHaveValue(member.conversationId);
    }
    await expect(editor.getByLabel("步骤 3 · 本步任务", { exact: true })).toHaveValue("审阅并给出结论");
    await expect(editor.locator(".agent-bus-roster")).not.toContainText("已暂存");
    await editor.getByRole("button", { name: "添加步骤", exact: true }).click();
    await expect(editor.getByLabel("步骤 4 Bot", { exact: true })).toBeFocused();
    await expect(slot(page, 3)).toBeInViewport();
    await editor.getByRole("button", { name: "研究团队", exact: true }).click();
    // The unassigned fourth step was empty; Crew restores three roles and a blank reviewer.
    await expect(editor.getByLabel("审阅者 · 角色要求", { exact: true })).toHaveValue("");
    await expect(editor.getByLabel("撰写者 · 角色要求", { exact: true })).toHaveValue("审阅并给出结论");
    await editor.getByLabel("审阅者 Bot", { exact: true }).selectOption("writer");
    const limit = editor.getByLabel("修订轮数上限", { exact: true });
    await limit.fill("4");
    await editor.getByLabel("分析员 Bot", { exact: true }).focus();
    await expect(limit).toHaveAttribute("aria-invalid", "true");
    await expect(limit).toHaveAccessibleDescription("修订轮数上限请输入 0–3 的整数。");
    await limit.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: "disabled", path: info.outputPath("crew-limit-other-member.png") });
    await limit.fill("1");
    await editor.getByRole("button", { name: "单人委托", exact: true }).click();
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByRole("button", { name: "串联步骤", exact: true }).click();
    await expect(editor.locator(".agent-bus-slot")).toHaveCount(2);
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("run setup explains unavailable actions and keeps task entry before the workflow", async ({ page }, info) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), task = editor.getByLabel("Bus 共同目标", { exact: true });
    const start = editor.getByRole("button", { name: "启动协作", exact: true });
    await expect(start).toHaveAccessibleDescription("填写共同目标后即可启动。");
    await expect(task).toBeInViewport();
    const taskBox = await task.boundingBox(), graphBox = await editor.locator(".agent-bus-flow").boundingBox();
    expect(taskBox!.y + taskBox!.height).toBeLessThan(graphBox!.y);
    await page.screenshot({ animations: "disabled", path: info.outputPath("run-ready-empty-task.png") });
    await task.fill("进行本轮审阅");
    await expect(start).toBeEnabled();
    await start.click();
    await expect(editor.getByRole("button", { name: "停止本次协作", exact: true })).toBeVisible();
    await expect(task).not.toBeVisible();
    const current = f.fixture.details.get("bus_one")!.runs[0]!;
    current.status = "completed";
    await expect(task).toBeVisible({ timeout: 7000 });
    await expect(task).toHaveValue("");
    const permissions = f.fixture.permissions.get("main")!; permissions.settings.enabled = false;
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("writer");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("main");
    await editor.getByLabel("发起者 的记录对话", { exact: true }).selectOption("chat_main");
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await expect(start).toHaveAccessibleDescription("需要先准备成员协作权限。");
    await expect(editor.getByRole("button", { name: "检查并准备", exact: true })).toBeInViewport();
    await page.screenshot({ animations: "disabled", path: info.outputPath("run-permissions-needed.png") });
    expect(f.fixture.starts).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("chain tasks belong to steps; the coordinator only starts and reports unless explicitly added as step 1", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  // A saved Bus from before per-step tasks: AA1 coordinates, DD1 is the only step.
  const original: AgentBusWorkspace = { ...workspace(), members: [{ botId: "review", conversationId: "chat_review" }] };
  let stepRecord = "";
  const f = await setup(page, [original], async hub => { stepRecord = (await hub.store.createConversation("owner", ["main"], "协调助手 · 研究步骤", "main_step_record")).id; });
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), division = editor.locator(".agent-bus-division");
    // The old Bus keeps its behaviour and shows it plainly; nothing runs extra.
    await expect(division.getByRole("heading", { name: "分工", exact: true })).toBeVisible();
    await expect(division.locator("li")).toHaveText([/发起者 · 协调助手仅发起与汇报/, /步骤 1 · 审阅助手未填写 · 按共同目标执行/]);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(slot(page, -1)).toContainText("仅发起与汇报");
    await expect(slot(page, -1).locator("textarea")).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
    // Explicit only: a new step for the coordinator's Bot, never its conversation.
    await editor.getByRole("button", { name: "让 协调助手 执行第 1 步", exact: true }).click();
    const first = editor.getByLabel("步骤 1 · 本步任务", { exact: true }), second = editor.getByLabel("步骤 2 · 本步任务", { exact: true });
    await expect(first).toBeFocused();
    await expect(editor.getByLabel("步骤 1 Bot", { exact: true })).toHaveValue("main");
    const record = editor.getByLabel("步骤 1 的记录对话", { exact: true });
    await expect(record).toHaveValue("");
    await expect(record.locator('option[value="chat_main"]')).toHaveAttribute("disabled", "");
    await expect(editor.getByLabel("步骤 2 Bot", { exact: true })).toHaveValue("review");
    await expect(editor.getByRole("button", { name: "让 协调助手 执行第 1 步", exact: true })).toHaveCount(0);
    await record.selectOption(stepRecord);
    await first.fill("  做示例公司的公司研究和行业调研，列出关键数据与来源  ");
    // Each task box starts at two lines and grows to at most six.
    const measure = () => second.evaluate(element => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), scrolls: element.scrollHeight > element.clientHeight + 1 }));
    const empty = await measure();
    expect(empty.height).toBeGreaterThan(empty.line * 2);
    expect(empty.height).toBeLessThan(empty.line * 3 + 20);
    await second.fill(["收益法估值", "核心假设单列", "敏感性分析", "交付 Excel 模型"].join("\n"));
    const four = await measure();
    expect(four.height - empty.height).toBeGreaterThan(four.line * 1.5);
    expect(four.scrolls).toBe(false);
    await second.fill(Array.from({ length: 12 }, (_, i) => `要求 ${i + 1}`).join("\n"));
    const many = await measure();
    expect(many.height).toBeLessThanOrEqual(many.line * 6 + 20);
    expect(many.scrolls).toBe(true);
    await second.fill("基于上一步的研究做收益法估值，并给出 Excel 模型");
    await editor.screenshot({ animations: "disabled", path: info.outputPath("chain-step-tasks-1440-light.png") });
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => f.fixture.updates.length).toBe(1);
    const saved = f.fixture.updates[0]!.config;
    expect(saved.coordinator).toEqual({ botId: "main", conversationId: "chat_main" });
    expect(saved.members).toEqual([
      { botId: "main", conversationId: stepRecord, instruction: "做示例公司的公司研究和行业调研，列出关键数据与来源" },
      { botId: "review", conversationId: "chat_review", instruction: "基于上一步的研究做收益法估值，并给出 Excel 模型" },
    ]);
    // The run view lists the division it will execute, with an explicit way back.
    await expect(division.locator("li")).toHaveText([/发起者 · 协调助手仅发起与汇报/, /步骤 1 · 协调助手做示例公司的公司研究/, /步骤 2 · 审阅助手基于上一步的研究做收益法估值/]);
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("示例公司");
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect.poll(() => f.fixture.starts.length).toBe(1);
    const run = f.fixture.details.get(original.id)!.runs[0]!;
    expect(run.snapshot.members.map(member => member.instruction)).toEqual(saved.members.map(member => member.instruction));
    run.status = "running"; run.stages = [{ id: "s1", botId: "main", conversationId: stepRecord, status: "running", startedAt: 1 }];
    await expect(division.getByRole("heading", { name: "本次分工", exact: true })).toBeVisible({ timeout: 7000 });
    await expect(division).toContainText("运行中不可修改");
    await expect(editor.getByRole("button", { name: "编辑分工", exact: true })).toHaveCount(0);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toBeDisabled();
    await expect(editor.getByLabel("步骤 1 Bot", { exact: true })).toBeDisabled();
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await page.screenshot({ animations: "disabled", path: info.outputPath("chain-step-tasks-running.png") });
    run.status = "completed"; run.stages = [{ ...run.stages[0]!, status: "completed" }, { id: "s2", botId: "review", conversationId: "chat_review", status: "completed", startedAt: 2 }];
    await expect(editor.getByRole("button", { name: "编辑分工", exact: true })).toBeVisible({ timeout: 7000 });
    await editor.getByRole("button", { name: "编辑分工", exact: true }).click();
    await expect(editor.getByRole("tab", { name: "配置", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toBeFocused();
    // Narrow overlay and dark theme: no horizontal overflow in either tab.
    await page.setViewportSize({ width: 1024, height: 760 });
    await openSettings(page);
    await page.locator('input[name="color-palette"][value="white-violet"]').check();
    await page.getByLabel("主题", { exact: true }).selectOption("dark");
    await closeSettings(page);
    for (const tab of ["配置", "运行"]) {
      await editor.getByRole("tab", { name: tab, exact: true }).click();
      expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await editor.screenshot({ animations: "disabled", path: info.outputPath(`chain-step-tasks-1024-dark-${tab === "配置" ? "configure" : "run"}.png`) });
    }
    expect(f.fixture.starts).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("mode switches keep coordinator and member tasks aside with notice and restore them where they apply", async ({ page }, info) => {
  const longTask = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 项：核对风险因素、数据口径与来源，并写明结论依据。`).join("");
  const original: AgentBusWorkspace = { ...workspace(), mode: "fan",
    coordinator: { botId: "main", conversationId: "chat_main", instruction: "从财务角度回答" },
    members: [{ botId: "research", conversationId: "chat_research", instruction: "行业研究" }, { botId: "review", conversationId: "chat_review", instruction: longTask }] };
  const f = await setup(page, [original]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), roster = editor.locator(".agent-bus-roster"), save = editor.getByRole("button", { name: "保存配置", exact: true });
    // A long task is clamped in the run view and can be expanded in place.
    const division = editor.locator(".agent-bus-division");
    await expect(division.getByRole("button", { name: "展开全文", exact: true })).toBeVisible();
    await division.getByRole("button", { name: "展开全文", exact: true }).click();
    await expect(division.getByRole("button", { name: "收起", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(division).toContainText("第 8 项");
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.getByLabel("发起者 · 负责内容", { exact: true })).toHaveValue("从财务角度回答");
    await editor.getByRole("button", { name: "串联步骤", exact: true }).click();
    await expect(editor.getByLabel("发起者 · 负责内容", { exact: true })).toHaveCount(0);
    await expect(slot(page, -1)).toContainText("发起者的任务已暂存");
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toHaveValue("行业研究");
    await page.screenshot({ animations: "disabled", path: info.outputPath("parked-coordinator-task.png") });
    await editor.getByRole("button", { name: "回答后复核", exact: true }).click();
    await expect(editor.getByLabel("发起者 · 回答要求", { exact: true })).toHaveValue("从财务角度回答");
    await expect(editor.getByLabel("复核者 · 复核重点", { exact: true })).toHaveValue("行业研究");
    await expect(roster).toContainText("另有 1 位成员已暂存");
    await expect(slot(page, -1)).not.toContainText("已暂存");
    await editor.getByRole("button", { name: "并行询问", exact: true }).click();
    await expect(editor.getByLabel("成员 2 · 负责内容", { exact: true })).toHaveValue(longTask);
    await expect(roster).not.toContainText("已暂存");
    // Returning to the saved arrangement is not an unsaved edit.
    await expect(save).toBeDisabled();
    // Changing a slot's Bot keeps its task and resets only its record.
    await editor.getByLabel("成员 1 Bot", { exact: true }).selectOption("analysis");
    await expect(editor.getByLabel("成员 1 · 负责内容", { exact: true })).toHaveValue("行业研究");
    await expect(editor.getByLabel("成员 1 的记录对话", { exact: true })).toHaveValue("");
    await editor.getByLabel("成员 1 的记录对话", { exact: true }).selectOption("chat_analysis");
    await editor.getByRole("button", { name: "串联步骤", exact: true }).click();
    await save.click();
    await expect.poll(() => f.fixture.updates.length).toBe(1);
    const saved = f.fixture.updates[0]!.config;
    expect(saved.mode).toBe("chain");
    expect(saved.coordinator).toEqual({ botId: "main", conversationId: "chat_main" });
    expect(saved.members).toEqual([{ botId: "analysis", conversationId: "chat_analysis", instruction: "行业研究" }, { botId: "review", conversationId: "chat_review", instruction: longTask }]);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.locator(".agent-bus-roster")).not.toContainText("已暂存");
    await editor.getByRole("button", { name: "并行询问", exact: true }).click();
    await expect(editor.getByLabel("发起者 · 负责内容", { exact: true })).toHaveValue("");
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("a step added in another mode stays an unsaved draft after returning to the saved mode", async ({ page }) => {
  const saved: AgentBusWorkspace = { ...workspace(), mode: "ask", members: [{ botId: "research", conversationId: "chat_research" }] };
  const f = await setup(page, [saved, workspace("bus_two", "第二个 Bus")]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), roster = editor.locator(".agent-bus-roster"), footer = editor.locator(".agent-bus-panel-footer small");
    const configTab = editor.getByRole("tab", { name: "配置", exact: true }), save = editor.getByRole("button", { name: "保存配置", exact: true });
    await configTab.click();
    await editor.getByRole("button", { name: "串联步骤", exact: true }).click();
    await editor.getByRole("button", { name: "添加步骤", exact: true }).click();
    await editor.getByLabel("步骤 2 Bot", { exact: true }).selectOption("review");
    await editor.getByLabel("步骤 2 · 本步任务", { exact: true }).fill("复核估值假设");
    // Back in the saved mode the visible form equals the saved Bus, yet the new step remains a draft.
    await editor.getByRole("button", { name: "单人委托", exact: true }).click();
    await expect(editor.getByLabel("成员 1 Bot", { exact: true })).toHaveValue("research");
    await expect(roster).toContainText("另有 1 位成员已暂存");
    await expect(configTab.locator("i")).toHaveCount(1);
    await expect(save).toBeDisabled();
    await expect(footer).toHaveText("暂存的分工尚未保存：切回能容纳它的方式即可恢复，重新载入配置可丢弃。");
    // Another device's revision is not adopted over the parked draft.
    const reads = f.fixture.reads;
    f.fixture.details.get(saved.id)!.workspace = { ...saved, name: "另一设备的修改", revision: "remote_revision" };
    await expect.poll(() => f.fixture.reads, { timeout: 7000 }).toBeGreaterThan(reads);
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("产品评审");
    await expect(roster).toContainText("另有 1 位成员已暂存");
    // Leaving asks first; keeping the draft keeps the parked step.
    await page.getByRole("button", { name: "打开 Bus：第二个 Bus", exact: true }).click();
    const leave = page.getByRole("dialog", { name: "放弃未保存的内容？", exact: true });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "继续编辑", exact: true }).click();
    await editor.getByRole("button", { name: "串联步骤", exact: true }).click();
    await expect(editor.getByLabel("步骤 2 Bot", { exact: true })).toHaveValue("review");
    await expect(editor.getByLabel("步骤 2 · 本步任务", { exact: true })).toHaveValue("复核估值假设");
    // Reload is the explicit discard: it asks, then adopts the remote revision without the parked step.
    await editor.getByRole("button", { name: "单人委托", exact: true }).click();
    await editor.getByRole("button", { name: "重新载入配置", exact: true }).click();
    const reload = page.getByRole("dialog", { name: "重新载入配置？", exact: true });
    await expect(reload).toBeVisible();
    await reload.getByRole("button", { name: "重新载入配置", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("另一设备的修改");
    await expect(roster).not.toContainText("已暂存");
    await expect(configTab.locator("i")).toHaveCount(0);
    await editor.getByRole("button", { name: "串联步骤", exact: true }).click();
    await expect(editor.locator(".agent-bus-slot")).toHaveCount(2);
    expect(f.fixture.updates).toEqual([]); expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("a coordinator task written in another mode stays an unsaved draft after returning to ask", async ({ page }) => {
  const saved: AgentBusWorkspace = { ...workspace(), mode: "ask", members: [{ botId: "research", conversationId: "chat_research" }] };
  const f = await setup(page, [saved, workspace("bus_two", "第二个 Bus")]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), save = editor.getByRole("button", { name: "保存配置", exact: true });
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByRole("button", { name: "并行询问", exact: true }).click();
    await editor.getByLabel("发起者 · 负责内容", { exact: true }).fill("从财务角度回答");
    await editor.getByRole("button", { name: "单人委托", exact: true }).click();
    await expect(slot(page, -1)).toContainText("发起者的任务已暂存");
    await expect(save).toBeDisabled();
    await expect(editor.getByRole("tab", { name: "配置", exact: true }).locator("i")).toHaveCount(1);
    const reads = f.fixture.reads;
    f.fixture.details.get(saved.id)!.workspace = { ...saved, name: "另一设备的修改", revision: "remote_revision" };
    await expect.poll(() => f.fixture.reads, { timeout: 7000 }).toBeGreaterThan(reads);
    await expect(slot(page, -1)).toContainText("发起者的任务已暂存");
    await page.getByRole("button", { name: "打开 Bus：第二个 Bus", exact: true }).click();
    const leave = page.getByRole("dialog", { name: "放弃未保存的内容？", exact: true });
    await expect(leave).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(leave).not.toBeVisible();
    await editor.getByRole("button", { name: "并行询问", exact: true }).click();
    await expect(editor.getByLabel("发起者 · 负责内容", { exact: true })).toHaveValue("从财务角度回答");
    // Discarding on leave is explicit and drops only the draft.
    await editor.getByRole("button", { name: "单人委托", exact: true }).click();
    await page.getByRole("button", { name: "打开 Bus：第二个 Bus", exact: true }).click();
    await leave.getByRole("button", { name: "放弃并离开", exact: true }).click();
    await expect(editor.getByRole("heading", { name: "第二个 Bus", exact: true })).toBeVisible();
    expect(f.fixture.updates).toEqual([]); expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

// 2026-10-19 hands-on re-audit: journeys that the earlier assertions missed.
test("re-audit: a parked step whose record chat is chosen elsewhere keeps its task and falls back to a dedicated record", async ({ page }, info) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByRole("button", { name: "添加步骤", exact: true }).click();
    await editor.getByLabel("步骤 3 Bot", { exact: true }).selectOption("analysis");
    await editor.getByLabel("步骤 3 · 本步任务", { exact: true }).fill("未保存：交叉验证所有来源并列出分歧。");
    await editor.getByLabel("步骤 3 的记录对话", { exact: true }).selectOption("chat_analysis");
    await editor.getByRole("button", { name: "单人委托", exact: true }).click();
    await expect(editor.locator(".agent-bus-roster")).toContainText("另有 2 位成员已暂存");
    // The visible slot explicitly takes the parked step's record conversation.
    await editor.getByLabel("成员 1 Bot", { exact: true }).selectOption("analysis");
    await editor.getByLabel("成员 1 的记录对话", { exact: true }).selectOption("chat_analysis");
    await editor.getByRole("button", { name: "串联步骤", exact: true }).click();
    await expect(editor.locator(".agent-bus-slot")).toHaveCount(4);
    await expect(editor.getByLabel("步骤 1 的记录对话", { exact: true })).toHaveValue("chat_analysis");
    await expect(editor.getByLabel("步骤 3 Bot", { exact: true })).toHaveValue("analysis");
    await expect(editor.getByLabel("步骤 3 · 本步任务", { exact: true })).toHaveValue("未保存：交叉验证所有来源并列出分歧。");
    await expect(editor.getByLabel("步骤 3 的记录对话", { exact: true })).toHaveValue("");
    await slot(page, 2).scrollIntoViewIfNeeded();
    await page.screenshot({ animations: "disabled", path: info.outputPath("parked-step-restored.png") });
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => f.fixture.updates.length).toBe(1);
    expect(f.fixture.updates[0]!.config.members).toEqual([{ botId: "analysis", conversationId: "chat_analysis" }, { botId: "review", conversationId: "chat_review" }, { botId: "analysis", instruction: "未保存：交叉验证所有来源并列出分歧。" }]);
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("re-audit: clicking the selected mode keeps Crew roles in place and keeps blank steps", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByRole("button", { name: "添加步骤", exact: true }).click();
    await expect(editor.locator(".agent-bus-slot")).toHaveCount(4);
    await editor.getByRole("button", { name: "串联步骤", exact: true }).click();
    await expect.soft(editor.locator(".agent-bus-slot")).toHaveCount(4);
    await expect.soft(editor.getByLabel("步骤 3 Bot", { exact: true })).toHaveValue("");
    await editor.getByRole("button", { name: "研究团队", exact: true }).click();
    await expect(editor.getByLabel("研究员 Bot", { exact: true })).toHaveValue("research");
    await expect(editor.getByLabel("分析员 Bot", { exact: true })).toHaveValue("review");
    await editor.getByLabel("研究员 Bot", { exact: true }).selectOption("");
    await editor.getByLabel("审阅者 · 角色要求", { exact: true }).fill("重点核对估值假设");
    await editor.getByRole("button", { name: "研究团队", exact: true }).click();
    await expect(editor.getByLabel("研究员 Bot", { exact: true })).toHaveValue("");
    await expect(editor.getByLabel("分析员 Bot", { exact: true })).toHaveValue("review");
    await expect(editor.getByLabel("审阅者 · 角色要求", { exact: true })).toHaveValue("重点核对估值假设");
    expect(f.fixture.updates).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("re-audit: Escape that ends IME composition never collapses the Bus panel", async ({ page, browserName }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), dock = page.locator(".agent-bus-dock");
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const field = editor.getByLabel("步骤 1 · 本步任务", { exact: true });
    await field.focus();
    await field.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", isComposing: true, bubbles: true, cancelable: true })));
    await expect(dock).toHaveClass(/is-open/);
    if (browserName === "chromium") {
      // A real composition session: Chromium reports this Escape as composing.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", { text: "gu", selectionStart: 2, selectionEnd: 2 });
      await page.keyboard.press("Escape");
      await expect(dock).toHaveClass(/is-open/);
      await cdp.send("Input.insertText", { text: "古" });
    }
    // An ordinary Escape still collapses the panel and keeps the draft.
    await field.focus();
    await page.keyboard.press("Escape");
    await expect(dock).not.toHaveClass(/is-open/);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("re-audit: pasted text over a limit is kept and blocked with a count instead of being truncated", async ({ page }, info) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), footer = editor.locator(".agent-bus-panel-footer small");
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const field = editor.getByLabel("步骤 1 · 本步任务", { exact: true }), save = editor.getByRole("button", { name: "保存配置", exact: true });
    const pasted = "【方法】" + "使用 DCF 与可比公司法交叉验证。".repeat(500) + "【交付物】最后交付 Excel 表格。";
    await field.click();
    await page.keyboard.insertText(pasted);
    await expect.soft(field).toHaveValue(pasted);
    await expect.soft(field).toHaveAttribute("aria-invalid", "true");
    await expect.soft(slot(page, 0).locator(".agent-bus-instruction small")).toHaveText(`${pasted.length}/8000`);
    await expect.soft(footer).toHaveText("步骤 1的任务最多 8000 字。");
    await expect.soft(save).toBeDisabled();
    await page.screenshot({ animations: "disabled", path: info.outputPath("over-limit-task.png") });
    await field.fill(pasted.slice(-7000));
    await expect(field).not.toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeEnabled();
    await field.fill("");
    await expect(save).toBeDisabled();
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    const goal = editor.getByLabel("Bus 共同目标", { exact: true }), longGoal = "目标".repeat(24_500) + "【结尾要求】";
    await goal.click();
    await page.keyboard.insertText(longGoal);
    await expect(goal).toHaveValue(longGoal);
    await expect(goal).toHaveAttribute("aria-invalid", "true");
    await expect(editor.locator(".agent-bus-task small")).toHaveText(`${longGoal.length}/48000`);
    await expect(footer).toHaveText(`共同目标最多 48000 字，当前 ${longGoal.length} 字。`);
    await expect(editor.getByRole("button", { name: "启动协作", exact: true })).toBeDisabled();
    await page.screenshot({ animations: "disabled", path: info.outputPath("over-limit-goal.png") });
    await goal.fill(longGoal.slice(-100));
    await expect(editor.getByRole("button", { name: "启动协作", exact: true })).toBeEnabled();
    expect(f.fixture.updates).toEqual([]); expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("re-audit: a Bus deleted elsewhere locks the editor and explains the deletion", async ({ page }, info) => {
  const f = await setup(page, [workspace(), workspace("bus_two", "第二个 Bus")]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("步骤 1 · 本步任务", { exact: true }).fill("未保存的任务");
    f.fixture.details.delete("bus_one");
    const notice = editor.locator(".agent-bus-gone");
    await expect(notice).toContainText("这个 Bus 已被删除", { timeout: 8000 });
    await expect(notice).toBeInViewport();
    await expect(page.locator(".agent-bus-pane-status")).toHaveCount(0);
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toHaveAttribute("readonly", "");
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toBeEnabled();
    await editor.getByLabel("步骤 1 · 本步任务", { exact: true }).focus();
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toBeFocused();
    await expect(editor.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
    await expect(editor.getByText(/尚不支持 Agent Bus/)).toHaveCount(0);
    await page.screenshot({ animations: "disabled", path: info.outputPath("deleted-elsewhere.png") });
    await notice.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.locator(".agent-bus-dock")).not.toHaveClass(/is-open/);
    await expect(page.locator(".agent-bus-panel")).toHaveCount(1);
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toHaveValue("未保存的任务");
    await page.getByRole("button", { name: "打开 Bus：第二个 Bus", exact: true }).click();
    const leave = page.getByRole("dialog", { name: "放弃未保存的内容？", exact: true });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toHaveValue("未保存的任务");
    expect(f.fixture.updates).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("re-audit: editing after an uncertain create resolves that request instead of creating a second Bus", async ({ page }) => {
  const f = await setup(page);
  try {
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 名称", { exact: true }).fill("周报汇总（错别字");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("writer");
    await editor.getByLabel("成员 1 Bot", { exact: true }).selectOption("review");
    f.fixture.loseNextCreate();
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("操作尚未确认");
    await editor.getByLabel("Bus 名称", { exact: true }).fill("周报汇总");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByRole("heading", { name: "周报汇总", exact: true })).toBeVisible();
    expect(f.fixture.createCalls).toHaveLength(2);
    expect(f.fixture.createCalls[1]).toEqual(f.fixture.createCalls[0]);
    expect(f.fixture.details.size).toBe(1);
    expect(f.fixture.updates.map(update => update.config.name)).toEqual(["周报汇总"]);
    await expect(page.getByRole("button", { name: "打开 Bus：周报汇总", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开 Bus：周报汇总（错别字", exact: true })).toHaveCount(0);
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("re-audit: retrying a save whose response was lost adopts that save instead of reporting a conflict", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), save = editor.getByRole("button", { name: "保存配置", exact: true }), configTab = editor.getByRole("tab", { name: "配置", exact: true });
    await configTab.click();
    await editor.getByLabel("步骤 1 · 本步任务", { exact: true }).fill("审阅周报，指出风险。");
    f.fixture.loseNextUpdate();
    await save.click();
    await expect(editor.getByRole("alert")).toContainText("操作尚未确认");
    await save.click();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(editor.getByRole("alert")).toHaveCount(0);
    await expect(configTab.locator("i")).toHaveCount(0);
    expect(f.fixture.updates).toHaveLength(2);
    // A genuinely different remote revision is still reported as a conflict.
    await configTab.click();
    await editor.getByLabel("步骤 1 · 本步任务", { exact: true }).fill("本地第二次修改");
    const detail = f.fixture.details.get("bus_one")!;
    detail.workspace = { ...detail.workspace, name: "另一设备的修改", revision: "remote_revision" };
    await save.click();
    await expect(editor.getByRole("alert")).toContainText("当前配置与主机记录不一致");
    await expect(editor.getByLabel("步骤 1 · 本步任务", { exact: true })).toHaveValue("本地第二次修改");
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("re-audit: unsaved Bus edits and goals ask before the page unloads", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    const prevented = () => page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await expect(editor.getByRole("heading", { name: "产品评审", exact: true })).toBeVisible();
    expect(await prevented()).toBe(false);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const field = editor.getByLabel("步骤 1 · 本步任务", { exact: true });
    await field.fill("未保存的步骤任务");
    await expect.poll(prevented).toBe(true);
    await field.fill("");
    await expect.poll(prevented).toBe(false);
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("未发送的共同目标");
    await expect.poll(prevented).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("re-audit: the run view shows its failure reason in view, distinguishes same-name Bots and ignores rename-only edits", async ({ page }, info) => {
  const saved: AgentBusWorkspace = { ...workspace(), mode: "fan", members: [{ botId: "research", conversationId: "chat_research" }, { botId: "research_twin", conversationId: "chat_research_twin" }] };
  const f = await setup(page, [saved], async hub => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES(?,?,?,1)", ["research_twin", "研究助手", hashSecret("fixture-research_twin")]);
    await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", ["research_twin", "owner", "research_twin", "{}"]);
    await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('chat_research_twin','direct','同名研究记录','owner',1,'chat_research_twin')");
    await hub.store.db.run("INSERT INTO conversation_members VALUES('chat_research_twin','user','owner',0)");
    await hub.store.db.run("INSERT INTO conversation_members VALUES('chat_research_twin','bot','research_twin',0)");
  });
  try {
    const now = Date.now();
    f.fixture.details.get(saved.id)!.runs = [{ id: "abr_failed", workspaceId: saved.id, messageId: "fixture_message", status: "failed", text: "评估估值", createdAt: now, finishedAt: now, error: "[request_too_large] Bus request exceeds 262144 bytes", snapshot: snapshot(saved),
      stages: [{ id: "s1", botId: "research", conversationId: "chat_research", status: "completed", startedAt: now, finishedAt: now }, { id: "s2", botId: "research_twin", conversationId: "chat_research_twin", status: "failed", startedAt: now, finishedAt: now, error: "[request_too_large] x" }] }];
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page), hero = editor.locator(".agent-bus-run-hero"), division = editor.locator(".agent-bus-division");
    await expect(hero).toContainText("未完成");
    await expect.soft(hero.getByText(/超过传输上限/)).toBeInViewport();
    await expect.soft(division).toContainText("成员 1 · 研究助手 · search");
    await expect.soft(division).toContainText("成员 2 · 研究助手 · h_twin");
    await page.screenshot({ animations: "disabled", path: info.outputPath("failed-run-hero-and-labels.png") });
    await expect(division.getByRole("heading", { level: 3 })).toHaveText("分工");
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("产品评审 v2");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => f.fixture.updates.length).toBe(1);
    await expect.soft(division.getByRole("heading", { level: 3 })).toHaveText("分工");
    await expect.soft(editor.locator(".agent-bus-next-config")).toHaveCount(0);
    // A real division change still says the next start uses the new configuration.
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("成员 1 · 负责内容", { exact: true }).fill("只看行业数据");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => f.fixture.updates.length).toBe(2);
    await expect(division.getByRole("heading", { level: 3 })).toHaveText("最近一次运行的分工");
    await expect(editor.locator(".agent-bus-next-config")).toContainText("下次启动将使用新配置");
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


test("re-audit: a legacy schema rejection allows a corrected create payload", async ({ page }) => {
  const f = await setup(page);
  const attempts: { requestId: string; config: AgentBusConfig }[] = [];
  try {
    // Model the old strict member schema: it rejects instructions before any
    // mutation. Other routes and the accepted payload use the regular fixture.
    await page.route("**/api/agent-buses", async route => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON(); attempts.push(body);
      if (body.config.members.some((member: { instruction?: string }) => member.instruction)) {
        await route.fulfill({ status: 400, json: { error: "invalid_request" } }); return;
      }
      return route.fallback();
    });
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 名称", { exact: true }).fill("旧主机配置修正");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("writer");
    await editor.getByLabel("成员 1 Bot", { exact: true }).selectOption("review");
    const task = slot(page, 0).locator("textarea");
    await task.fill("旧主机暂不支持此字段");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("请求内容无效");
    expect(f.fixture.details.size).toBe(0);
    await task.fill("");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByRole("heading", { name: "旧主机配置修正", exact: true })).toBeVisible();
    expect(attempts).toHaveLength(2); expect(attempts[1]!.requestId).not.toBe(attempts[0]!.requestId);
    expect(f.fixture.details.size).toBe(1); expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


test("an offline coordinator requires explicit end-wait confirmation and never claims the task stopped", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    const detail = f.fixture.details.get("bus_one")!;
    detail.runs = [{ id: "run_stranded", workspaceId: "bus_one", messageId: "fixture_message", status: "stopping", canAbandon: true, text: "等待离线发起者", createdAt: 1, snapshot: snapshot(detail.workspace), stages: [] }];
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("button", { name: "结束等待", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "结束等待？", exact: true });
    await expect(dialog).toContainText("原任务可能仍在主机上执行");
    await dialog.getByRole("button", { name: "继续协作", exact: true }).click();
    expect(f.fixture.stops).toEqual([]);
    await editor.getByRole("button", { name: "结束等待", exact: true }).click();
    await dialog.getByRole("button", { name: "结束等待", exact: true }).click();
    await expect.poll(() => f.fixture.stops.length).toBe(1);
    expect(f.fixture.stops[0]).toMatchObject({ runId: "run_stranded", abandon: true });
    await expect(editor.locator(".agent-bus-run-state")).toHaveText("已中断");
    await expect(editor).toContainText("已结束等待，未重发任务");
    expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


for (const [code, expected] of [
  ["agent_bus_conflict", "当前配置与主机记录不一致，请重新载入并核对。当前内容已保留。"],
  ["agent_bus_busy", "这组协作仍在执行，请完成或停止后再操作。"],
]) test(`start rejection ${code} retains the goal and explains the current action`, async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("仍需提交的共同目标");
    f.fixture.failNextStart(code);
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect(editor.getByRole("alert")).toHaveText(expected);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("仍需提交的共同目标");
    expect(f.fixture.starts).toHaveLength(1);
    expect(f.fixture.details.get("bus_one")!.runs).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("an end-wait rejection explains the changed state without claiming a stop", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    const detail = f.fixture.details.get("bus_one")!;
    detail.runs = [{ id: "run_stranded", workspaceId: "bus_one", messageId: "fixture_message", status: "stopping", canAbandon: true, text: "等待离线发起者", createdAt: 1, snapshot: snapshot(detail.workspace), stages: [] }];
    let rejected = 0;
    await page.route("**/api/agent-buses/bus_one/runs/run_stranded/stop", async route => {
      rejected++;
      await route.fulfill({ status: 409, json: { error: "agent_bus_abandon_unavailable" } });
    });
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    await panel(page).getByRole("button", { name: "结束等待", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "结束等待？", exact: true });
    await dialog.getByRole("button", { name: "结束等待", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("当前已不能结束等待，请关闭此提示并刷新运行状态。原任务没有被强制停止。");
    expect(rejected).toBe(1);
    expect(detail.runs[0]?.status).toBe("stopping");
    expect(f.fixture.starts).toEqual([]);
  } finally { await f.close(); }
});


test("invisible-only names and goals are blocked without altering meaningful Unicode", async ({ page }) => {
  const f = await setup(page, [workspace()]);
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    const goal = editor.getByLabel("Bus 共同目标", { exact: true });
    await goal.fill("\u200b\u200d\u2060");
    await expect(editor.getByRole("button", { name: "启动协作", exact: true })).toBeDisabled();
    await goal.fill("👨‍👩‍👧‍👦\nمی‌خواهم");
    await expect(goal).toHaveValue("👨‍👩‍👧‍👦\nمی‌خواهم");
    await expect(editor.getByRole("button", { name: "启动协作", exact: true })).toBeEnabled();
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const name = editor.getByLabel("Bus 名称", { exact: true });
    await name.fill("\u200b\u200d");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(editor.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
    await name.fill("家庭👨‍👩‍👧‍👦");
    await expect(editor.getByRole("button", { name: "保存配置", exact: true })).toBeEnabled();
    expect(f.fixture.updates).toEqual([]); expect(f.fixture.starts).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("Bus offline editing keeps focus and drafts while remote actions stay disabled", async ({ page }, info) => {
  const f = await setup(page, [workspace()]); let restored: HubServer | undefined;
  try {
    await page.getByRole("button", { name: "打开 Bus：产品评审", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const field = editor.getByLabel("步骤 1 · 本步任务", { exact: true });
    await field.fill("断网前"); await field.focus();
    const port = Number(new URL(f.hub.url).port); await f.hub.close();
    await expect(page.locator(".agent-bus-scope .status-dot.offline")).toBeAttached();
    await expect(field).toBeEnabled(); await expect(field).toBeFocused();
    await page.keyboard.insertText("继续编辑");
    await expect(field).toHaveValue("断网前继续编辑");
    for (const name of ["保存配置", "重新载入配置", "删除 Bus"]) await expect(editor.getByRole("button", { name, exact: true })).toBeDisabled();
    // Allow an actual route-probe failure and reconnect attempt while the Hub is down.
    await page.waitForTimeout(5000);
    const panes = page.locator(".adhd-card");
    await expect(panes.first().locator(".offline-banner")).toBeVisible();
    await expect(panes.locator(".error-banner").filter({ hasText: "正在自动重试" })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("offline-draft-and-single-notice.png") });
    expect(f.fixture.updates).toEqual([]); expect(f.fixture.starts).toEqual([]);
    restored = await HubServer.start({ stateDir: f.root, port, clientDir });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".agent-bus-scope .status-dot.online")).toBeAttached();
    await expect(field).toBeFocused(); await expect(field).toHaveValue("断网前继续编辑");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => f.fixture.updates.length).toBe(1);
    expect(f.fixture.updates[0]!.config.members[0]!.instruction).toBe("断网前继续编辑");
    expect(f.errors).toEqual([]);
  } finally { await restored?.close(); await f.close(); }
});
