import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

// Ticket polling of a dispatcher: the conversation's list and the list avatar
// share one bounded read, pause while the window is hidden, and never let a
// stalled request or an older response stick.
test.use({ serviceWorkers: "block" });
const clientDir = () => path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist");
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
}
// Older reads (no summary) still count, so each assertion isolates one behaviour.
const isList = (url: string) => /\/api\/bots\/disp\/tickets(\?summary=1(&capabilities=1)?)?$/.test(url);
const isAvatar = (url: string) => /\/api\/bots\/disp\/tickets\?open=1(&summary=1)?$/.test(url);
const avatar = (page: Page) => page.locator('.bot-tree[data-bot-id="disp"] .bot-identity > .avatar');

async function dispatcher(page: Page, run: (hub: HubServer, reads: { url: string; at: number }[]) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatcher-polling-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: clientDir() });
  const reads: { url: string; at: number }[] = [];
  page.on("request", request => { if (/\/api\/bots\/disp\/tickets(\?|$)/.test(request.url())) reads.push({ url: request.url(), at: Date.now() }); });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('disp','调度员','fixture','claude','dispatcher'),('alpha','研究助手','fixture','codex',''),('w_codex','调度员 · Codex','fixture','codex','worker')");
    await hub.store.createConversation("owner", ["alpha"], "研究对话", "research");
    const home = await hub.store.createConversation("owner", ["disp"], "调度台", "home");
    const worker = await hub.store.createConversation("owner", ["w_codex"], "工单：整理资料", "worker", { dispatchWorker: true });
    await hub.store.db.run("UPDATE conversations SET hidden=1,ticket_json=? WHERE id=?", [JSON.stringify({ id: "t_work", dispatcherBotId: "disp" }), worker.id]);
    const attempts = JSON.stringify([{ id: "a_work", botId: "w_codex", engine: "codex", model: "", effort: "", conversationId: worker.id, inputMessageId: "m_work", startedAt: Date.now() }]);
    await hub.store.db.run("INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,paused,attempts_json,created_at,updated_at) VALUES('t_work','disp',?,'r_work','整理资料','整理资料','working',0,?,?,?)", [home.id, attempts, Date.now(), Date.now()]);
    await pair(page, hub); await showDisconnectedBots(page); await waitForClientOnline(page);
    await run(hub, reads);
  } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await hub.close(); await rm(root, { recursive: true, force: true }); }
}
const openDispatcher = async (page: Page) => {
  await page.getByRole("button", { name: "打开 调度员", exact: true }).click();
  const toggle = page.locator(".host-workspace:not([hidden]) .dispatch-tickets-trigger");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.locator('.host-workspace:not([hidden]) [data-ticket-id="t_work"]')).toBeVisible();
};
// Pairing opens the dispatcher's conversation first; start elsewhere when the avatar must poll alone.
const openResearch = async (page: Page) => {
  await page.getByRole("button", { name: "打开 研究助手", exact: true }).click();
  await expect(page.getByRole("heading", { name: "研究对话", exact: true, level: 1 })).toBeVisible();
};
const count = (reads: { url: string; at: number }[], match: (url: string) => boolean, since = 0) => reads.filter(read => read.at >= since && match(read.url)).length;
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

test("an open dispatcher conversation serves the list avatar; the avatar poll resumes after leaving", async ({ page }) => {
  test.setTimeout(120_000);
  await dispatcher(page, async (_hub, reads) => {
    await openResearch(page);
    const alone = Date.now();
    await expect.poll(() => count(reads, isAvatar, alone), { timeout: 20_000 }).toBeGreaterThan(0);
    await openDispatcher(page);
    await pause(page, 1_000);
    const since = Date.now();
    await pause(page, 17_000);
    // ~4 s list cadence; no separate avatar read while the list publishes.
    expect(count(reads, isList, since)).toBeGreaterThanOrEqual(3);
    expect(count(reads, isAvatar, since)).toBe(0);
    await expect(avatar(page)).toHaveAttribute("data-agent-state", "working");
    // Both polls request the summary projection only.
    expect(reads.every(read => new URL(read.url).searchParams.get("summary") === "1")).toBe(true);
    await openResearch(page);
    const left = Date.now();
    // The list released the avatar: its freshness lapses within one interval.
    await expect.poll(() => count(reads, isAvatar, left), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(count(reads, isList, left + 1_000)).toBe(0);
  });
});

test("a stalled avatar read is abandoned and retried; its late answer never reverts the list's newer state", async ({ page }) => {
  test.setTimeout(120_000);
  await dispatcher(page, async (hub, reads) => {
    await openResearch(page);
    // 1. A read that never answers is abandoned after 8 s and the next interval retries.
    let stalled: Route | undefined;
    await page.route(url => isAvatar(url.href), async route => { if (!stalled) { stalled = route; return; } await route.continue(); });
    await expect.poll(() => !!stalled, { timeout: 20_000 }).toBe(true);
    const first = Date.now();
    await expect.poll(() => count(reads, isAvatar, first + 1), { timeout: 20_000 }).toBeGreaterThan(0);
    const retry = reads.find(read => isAvatar(read.url) && read.at > first)!.at - first;
    expect(retry).toBeGreaterThanOrEqual(7_500);
    await page.unroute(url => isAvatar(url.href));
    await stalled!.abort().catch(() => undefined);

    // 2. Hold an avatar answer that says "working", let the open list read the
    // newer state, then deliver the old answer: the avatar keeps the newer state.
    let held: { route: Route; response: Awaited<ReturnType<Route["fetch"]>> } | undefined;
    await page.route(url => isAvatar(url.href), async route => { if (held) { await route.continue(); return; } held = { route, response: await route.fetch() }; });
    await expect.poll(() => !!held, { timeout: 20_000 }).toBe(true);
    const heldAt = Date.now();
    await hub.store.db.run("UPDATE dispatch_tickets SET status='needs_review',updated_at=? WHERE id='t_work'", [Date.now()]);
    await openDispatcher(page);
    await expect(avatar(page)).toHaveAttribute("data-agent-state", "done");
    // Record every later state: the next list read would mask a brief revert.
    await avatar(page).evaluate(node => {
      const seen: (string | null)[] = [];
      Object.assign(window, { avatarStates: seen, avatarNode: node });
      new MutationObserver(() => seen.push(node.getAttribute("data-agent-state"))).observe(node, { attributes: true, attributeFilter: ["data-agent-state"] });
    });
    expect(Date.now() - heldAt, "the held avatar read must still be live (8 s bound)").toBeLessThan(7_000);
    await held!.route.fulfill({ response: held!.response });
    await pause(page, 1_500);
    expect(await page.evaluate(() => { const { avatarStates, avatarNode } = window as unknown as { avatarStates: string[]; avatarNode: Element }; return { states: avatarStates, connected: avatarNode.isConnected }; })).toEqual({ states: [], connected: true });
  });
});

test("a stalled list read retries; a stalled ticket action unlocks and its retry repeats the same request id", async ({ page }) => {
  test.setTimeout(120_000);
  await dispatcher(page, async (_hub, reads) => {
    await openDispatcher(page);
    let stalled: Route | undefined;
    await page.route(url => isList(url.href), async route => { if (!stalled) { stalled = route; return; } await route.continue(); });
    await expect.poll(() => !!stalled, { timeout: 10_000 }).toBe(true);
    const first = Date.now();
    await expect.poll(() => count(reads, isList, first + 1), { timeout: 20_000 }).toBeGreaterThan(0);
    // Abandoned at 8 s, next read 4 s later.
    expect(reads.find(read => isList(read.url) && read.at > first)!.at - first).toBeGreaterThanOrEqual(7_500);
    await page.unroute(url => isList(url.href));
    await stalled!.abort().catch(() => undefined);

    const bodies: string[] = [];
    let held: Route | undefined;
    await page.route("**/api/tickets/t_work/action", async route => {
      bodies.push(route.request().postData() ?? "");
      if (!held) { held = route; return; }
      await route.continue();
    });
    const ticket = page.locator('.host-workspace:not([hidden]) [data-ticket-id="t_work"]');
    await ticket.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(ticket.getByRole("button", { name: "暂停", exact: true })).toBeDisabled();
    // The unanswered action is abandoned after 20 s: the result is unknown, controls unlock.
    await expect(page.locator(".host-workspace:not([hidden]) .dispatch-tickets-error")).toHaveText("操作结果未确认，请稍后重试。", { timeout: 25_000 });
    await expect(ticket.getByRole("button", { name: "暂停", exact: true })).toBeEnabled();
    await ticket.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(ticket.locator(".dispatch-ticket-status")).toHaveText("正在暂停");
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1]!)).toEqual(JSON.parse(bodies[0]!));
    await held!.abort().catch(() => undefined);
  });
});

test("an unconfirmed action is retried with its request id, but a later pause or resume is a new request", async ({ page }) => {
  test.setTimeout(120_000);
  await dispatcher(page, async hub => {
    await openDispatcher(page);
    const owner = { kind: "owner" as const, userId: "owner" };
    const ticket = page.locator('.host-workspace:not([hidden]) [data-ticket-id="t_work"]');
    const error = page.locator(".host-workspace:not([hidden]) .dispatch-tickets-error");
    const paused = async () => (await hub.store.db.get<{ paused: number }>("SELECT paused FROM dispatch_tickets WHERE id='t_work'"))!.paused;
    // Per action: "lost" never reaches the Host; "applied" reaches it but its answer is lost.
    const plan: Record<string, ("lost" | "applied")[]> = { pause: ["lost", "applied"], resume: ["applied"] };
    const posts: { action: string; requestId: string }[] = [];
    await page.route("**/api/tickets/t_work/action", async route => {
      const body = JSON.parse(route.request().postData() ?? "{}") as { action: string; requestId: string };
      posts.push(body);
      const step = plan[body.action]?.shift();
      if (step === "lost") { await route.abort(); return; }
      if (step === "applied") { await route.fetch(); await route.abort(); return; }
      await route.continue();
    });
    const click = async (name: "暂停" | "继续") => { await expect(ticket.getByRole("button", { name, exact: true })).toBeEnabled({ timeout: 10_000 }); await ticket.getByRole("button", { name, exact: true }).click(); };

    // 1. Unknown result, Host unchanged: the retry repeats the same request.
    await click("暂停");
    await expect(error).toHaveText("操作结果未确认，请稍后重试。");
    expect((await hub.dispatch.show(owner, "t_work")).attempts[0]).not.toHaveProperty("stopRequested");
    await click("暂停");
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]!.requestId).toBe(posts[0]!.requestId);
    await expect.poll(async () => (await hub.dispatch.show(owner, "t_work")).attempts[0]?.stopRequested).toBe("pause");
    await expect(error).toHaveText("操作结果未确认，请稍后重试。");

    // 2. The worker's terminal evidence settles the stop as queued + paused.
    const current = await hub.dispatch.show(owner, "t_work");
    const input = await hub.store.sendMessage("owner", { conversationId: current.attempts[0]!.conversationId, clientMsgId: "stopped-input", text: "stopped", attachments: [] });
    await hub.store.db.run("UPDATE deliveries SET status='cancelled',dispatched=1 WHERE message_id=?", [input.message.id]);
    await hub.store.db.run("UPDATE dispatch_tickets SET attempts_json=? WHERE id='t_work'", [JSON.stringify(current.attempts.map(a => ({ ...a, inputMessageId: input.message.id })))]);
    await hub.dispatch.sweep();
    await expect(ticket.locator(".dispatch-ticket-paused")).toHaveText("已暂停", { timeout: 10_000 });

    // 3. A resume the Host applied, with its answer lost.
    await click("继续");
    await expect.poll(() => posts.length).toBe(3);
    await expect.poll(paused).toBe(0);
    await expect(error).toHaveText("操作结果未确认，请稍后重试。");

    // 4. After those transitions, a new pause and a new resume are new requests and take effect.
    await click("暂停");
    await expect.poll(paused).toBe(1);
    await click("继续");
    await expect.poll(paused).toBe(0);
    const ids = (action: string) => posts.filter(post => post.action === action).map(post => post.requestId);
    expect(ids("pause")).toHaveLength(3);
    expect(ids("pause")[2]).not.toBe(ids("pause")[0]);
    expect(ids("resume")).toHaveLength(2);
    expect(ids("resume")[1]).not.toBe(ids("resume")[0]);
  });
});

test("worker progress after an unconfirmed pause does not change the retry's request id", async ({ page }) => {
  test.setTimeout(90_000);
  await dispatcher(page, async hub => {
    await openDispatcher(page);
    const owner = { kind: "owner" as const, userId: "owner" };
    const ticket = page.locator('.host-workspace:not([hidden]) [data-ticket-id="t_work"]');
    const posts: { action: string; requestId: string }[] = [];
    let lost = false;
    await page.route("**/api/tickets/t_work/action", async route => {
      posts.push(JSON.parse(route.request().postData() ?? "{}"));
      if (!lost) { lost = true; await route.abort(); return; }
      await route.continue();
    });
    await ticket.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(page.locator(".host-workspace:not([hidden]) .dispatch-tickets-error")).toHaveText("操作结果未确认，请稍后重试。");
    // The worker asks for approval: the ticket changes (and its updatedAt moves) without settling the pause.
    const before = await hub.dispatch.show(owner, "t_work");
    await hub.store.db.run("UPDATE dispatch_tickets SET attempts_json=?,updated_at=? WHERE id='t_work'", [JSON.stringify(before.attempts.map(a => ({ ...a, waitingFor: { kind: "approval", messageId: "approval_fixture" } }))), before.updatedAt + 1_000]);
    await expect(ticket.locator(".dispatch-ticket-status")).toHaveText("待你回答", { timeout: 10_000 });
    await ticket.getByRole("button", { name: "暂停", exact: true }).click();
    await expect.poll(async () => (await hub.dispatch.show(owner, "t_work")).attempts[0]?.stopRequested).toBe("pause");
    expect(posts.map(post => post.action)).toEqual(["pause", "pause"]);
    expect(posts[1]!.requestId).toBe(posts[0]!.requestId);
  });
});

test("a hidden window stops the list poll and reads again as soon as it is visible", async ({ page }) => {
  test.setTimeout(90_000);
  await dispatcher(page, async (_hub, reads) => {
    await openDispatcher(page);
    const visibility = (state: "hidden" | "visible") => page.evaluate(value => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
    await visibility("hidden");
    await pause(page, 1_000);
    const since = Date.now();
    await pause(page, 10_000);
    expect(count(reads, isList, since)).toBe(0);
    expect(count(reads, isAvatar, since)).toBe(0);
    const shown = Date.now();
    await visibility("visible");
    await expect.poll(() => count(reads, isList, shown), { timeout: 1_500 }).toBeGreaterThan(0);
  });
});


test("ticket removal retries the same request and survives a late list reply and reload", async ({ page }) => {
  test.setTimeout(90_000);
  await dispatcher(page, async hub => {
    await openDispatcher(page);
    const owner = { kind: "owner" as const, userId: "owner" };
    const ended = await hub.dispatch.create(owner, "disp", { requestId: "remove-ended", title: "可移除的旧工单", request: "Preserve its records" });
    await hub.dispatch.update(owner, "disp", { ticketId: ended.id, status: "done" });
    const row = page.locator(`.host-workspace:not([hidden]) [data-ticket-id="${ended.id}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    const posts: { action: string; requestId: string }[] = [];
    await page.route(`**/api/tickets/${ended.id}/action`, async route => {
      posts.push(JSON.parse(route.request().postData() ?? "{}"));
      if (posts.length === 1) { await route.abort(); return; }
      await route.continue();
    });
    const remove = async () => {
      await row.getByRole("button", { name: "移除", exact: true }).click();
      await row.getByRole("button", { name: "确认移除工单", exact: true }).click();
    };
    await remove();
    await expect(page.locator(".host-workspace:not([hidden]) .dispatch-tickets-error")).toHaveText("操作结果未确认，请稍后重试。");
    expect((await hub.dispatch.list(owner, "disp")).tickets.some(t => t.id === ended.id)).toBe(true);
    // A fresh read saying "done" must not count as a successful removal receipt.
    await page.waitForResponse(response => isList(response.url()) && response.status() === 200);
    await expect(row).toBeVisible();
    let held: { route: Route; response: Awaited<ReturnType<Route["fetch"]>> } | undefined;
    await page.route(url => isList(url.href), async route => {
      if (held) { await route.continue(); return; }
      held = { route, response: await route.fetch() };
    });
    await expect.poll(() => !!held, { timeout: 10_000 }).toBe(true);
    await remove();
    await expect(row).toHaveCount(0);
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]);
    await held!.route.fulfill({ response: held!.response }).catch(() => undefined);
    await pause(page, 500);
    await expect(row).toHaveCount(0);
    expect((await hub.dispatch.show(owner, ended.id)).status).toBe("done");
    await page.unroute(url => isList(url.href));
    await page.reload(); await waitForClientOnline(page); await openDispatcher(page);
    await expect(row).toHaveCount(0);
    expect((await hub.dispatch.list(owner, "disp")).tickets.map(t => t.id)).toEqual(["t_work"]);
  });
});
