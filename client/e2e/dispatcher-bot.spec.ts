import { fixtureInvitation, preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { BotCatalog } from "../../src/client-protocol/bots.js";
import { pairingLink } from "../src/pairing-link.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { mobileHome, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const clientDir = () => path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist");
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
}
const ticketStatus = async (hub: HubServer, id: string) => hub.store.db.get<{ status: string; paused: number }>("SELECT status,paused FROM dispatch_tickets WHERE id=?", [id]);
/** The star is a static, lower-left badge outside the moving/clipped picture. */
async function expectStar(wrapper: Locator) {
  const star = wrapper.locator(":scope > .role-star");
  await expect(star).toBeVisible();
  await expect(wrapper.locator(":scope > .profile-avatar .role-star")).toHaveCount(0);
  const [avatar, badge] = await Promise.all([wrapper.locator(":scope > .profile-avatar").boundingBox(), star.boundingBox()]);
  expect(badge!.x).toBeLessThan(avatar!.x);
  expect(badge!.y + badge!.height).toBeGreaterThan(avatar!.y + avatar!.height);
  expect(await star.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
}

test("create a dispatcher Bot from New Bot; it gets a star and supports multiple conversations", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatcher-create-")), missing = path.join(root, "missing-cli");
  const hub = await HubServer.start({ stateDir: root, clientDir: clientDir(), managedBots: { entrypoint: path.resolve("../tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath, CLAUDE_EXECUTABLE: process.execPath, KIMI_EXECUTABLE: missing, DSH_EXECUTABLE: missing, ANTIGRAVITY_EXECUTABLE: missing } } });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture'),('beta','写作助手','fixture')");
    await pair(page, hub); await waitForClientOnline(page);
    await clickAppAction(page, "新建 Bot");
    const dialog = page.getByRole("dialog", { name: "新建 Bot", exact: true });
    await dialog.getByLabel("Bot 名称", { exact: true }).fill("调度员");
    await expect(dialog.getByText("只能在创建时选择", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: "作为幕僚长", exact: true })).toHaveAccessibleDescription(/刚开始建议先建普通 Bot，这里不勾选。/);
    const advice = dialog.locator(".new-bot-role-advice");
    await expect(advice).toHaveText("刚开始建议先建普通 Bot，这里不勾选。");
    const [adviceStyle, hintColor] = await Promise.all([advice.evaluate(node => { const style = getComputedStyle(node); return { weight: Number(style.fontWeight), color: style.color, display: style.display }; }), advice.evaluate(node => getComputedStyle(node.parentElement!).color)]);
    expect(adviceStyle.weight).toBeGreaterThanOrEqual(600); expect(adviceStyle.display).toBe("block"); expect(adviceStyle.color).not.toBe(hintColor);
    await expect(dialog.getByText("幕僚长设置", { exact: true })).toHaveCount(0);
    await dialog.getByRole("checkbox", { name: "作为幕僚长", exact: true }).check();
    await expect(dialog.getByText("上面的引擎、模型和推理强度是它自己思考用的；派出去的每张工单可以各自选择。", { exact: true })).toBeVisible();
    // Collapsed by default; every ordinary Bot is allowed until one is unticked.
    const settings = dialog.locator("details").filter({ has: page.getByText("幕僚长设置", { exact: true }) });
    await expect(settings).not.toHaveAttribute("open", /.*/);
    await settings.getByText("幕僚长设置", { exact: true }).click();
    // Every installed CLI is allowed until one is unticked (the fixture installs Codex and Claude).
    // The Host catalog probes every engine CLI, which can take several seconds.
    await expect(settings.getByRole("checkbox", { name: "Codex", exact: true })).toBeChecked({ timeout: 30_000 });
    await expect(settings.getByLabel("派活方式", { exact: true })).toHaveValue("ask");
    await expect(settings.getByLabel("同时进行的工单上限", { exact: true })).toHaveValue("2");
    await settings.getByRole("checkbox", { name: "Claude", exact: true }).uncheck();
    await settings.getByLabel("派活方式", { exact: true }).selectOption("auto");
    await settings.getByLabel("同时进行的工单上限", { exact: true }).selectOption("3");
    await page.screenshot({ path: test.info().outputPath("new-dispatcher.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible();
    await expect(page.locator(".bot-created .profile-avatar[data-role=dispatcher] > .role-star")).toBeVisible();
    const created = (await hub.store.bots("owner")).find(bot => bot.name === "调度员")!;
    expect(created.role).toBe("dispatcher");
    const saved = (await hub.dispatch.settings("owner", created.id)).settings;
    expect(saved).toMatchObject({ mode: "auto", maxConcurrent: 3 });
    expect(saved.allowedEngines).toContain("codex"); expect(saved.allowedEngines).not.toContain("claude");
    expect((await hub.store.bots("owner")).find(bot => bot.id === "alpha")?.role).toBeUndefined();
    await page.getByRole("button", { name: "开始对话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "与 调度员 的新对话", exact: true })).toBeVisible();
    await expect(page.locator(".chat-identity > .profile-avatar[data-role=dispatcher] > .role-star")).toBeVisible();
    await expectStar(page.locator(`.bot-tree[data-bot-id="${created.id}"] .bot-identity > .avatar`));
    await expect(page.getByRole("button", { name: "为 调度员 新建对话", exact: true })).toBeVisible();
    // Bot settings edit the same settings with the Host revision.
    await page.locator(`.bot-tree[data-bot-id="${created.id}"] .bot-identity`).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "新建对话", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Bot 设置", exact: true }).click();
    await page.getByRole("button", { name: "设置幕僚长", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "幕僚长设置", exact: true });
    await expect(editor.getByLabel("派活方式", { exact: true })).toHaveValue("auto");
    await expect(editor.getByRole("checkbox", { name: "Claude", exact: true })).not.toBeChecked();
    await editor.getByRole("checkbox", { name: "Claude", exact: true }).check();
    await editor.getByLabel("同时进行的工单上限", { exact: true }).selectOption("1");
    await editor.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(editor.getByText("幕僚长设置已保存。", { exact: true })).toBeVisible();
    expect((await hub.dispatch.settings("owner", created.id)).settings).toEqual({ mode: "auto", maxConcurrent: 1, allowedEngines: ["codex", "claude"] });
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [width, platform] of [[1360, "web"], [390, "ios"], [412, "android"]] as const) test(`dispatcher star, hidden worker chats and the ticket panel on ${platform}`, async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatcher-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: clientDir() });
  const phone = width < 760;
  const context = await browser.newContext({ viewport: { width, height: 844 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('disp','调度员','fixture','claude','dispatcher'),('alpha','研究助手','fixture','codex',''),('w_codex','调度员 · Codex','fixture','codex','worker')");
    const research = await hub.store.createConversation("owner", ["alpha"], "研究对话", "research");
    const home = await hub.store.createConversation("owner", ["disp"], "调度台", "home");
    const secondHome = await hub.store.createConversation("owner", ["disp"], "副调度台", "second-home");
    const squad = await hub.store.createConversation("owner", ["disp", "alpha"], "协作群", "squad", { type: "group" });
    const worker = await hub.store.createConversation("owner", ["w_codex"], "工单：整理资料", "worker", { dispatchWorker: true });
    await hub.store.db.run("UPDATE conversations SET hidden=1,ticket_json=? WHERE id=?", [JSON.stringify({ id: "t_work", dispatcherBotId: "disp", model: "gpt-6", effort: "high" }), worker.id]);
    const now = Date.now(), attempt = (id: string) => JSON.stringify([{ id: `a_${id}`, botId: "w_codex", engine: "codex", model: "gpt-6", effort: "high", conversationId: worker.id, inputMessageId: `m_${id}`, startedAt: now - 120_000, ...(id !== "work" ? { endedAt: now - 60_000, outcome: "completed" } : {}) }]);
    for (const [id, title, status, attempts, age] of [["t_work", "整理资料", "working", attempt("work"), 60_000], ["t_review", "写周报", "needs_review", attempt("review"), 120_000], ["t_queue", "翻译摘要", "queued", "[]", 180_000], ["t_done", "旧任务", "done", attempt("done"), 30_000]] as const) {
      await hub.store.db.run("INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,paused,attempts_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,?,?)", [id, "disp", home.id, `r_${id}`, title, title, status, attempts, now - 300_000, now - age]);
    }
    await hub.store.db.run("INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,paused,attempts_json,created_at,updated_at) VALUES('t_group','disp',?,'r_group','群组工单','群组工单','needs_review',0,?,?,?)", [squad.id, attempt("group"), now - 300_000, now - 90_000]);
    await hub.store.db.run("INSERT INTO engine_health(engine,state,until,reason,updated_at) VALUES('kimi','cooldown',?,'rate_limit',?),('claude','login_required',NULL,'auth',?)", [now + 3_600_000, now, now]);
    await pair(page, hub);
    await showDisconnectedBots(page); await waitForClientOnline(page);
    await page.evaluate(platform => { document.documentElement.dataset.platform = platform; }, platform);
    const nav = (name: RegExp | string) => mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name });
    // Keep the ordinary reply unread on desktop by viewing the dispatcher's primary chat first.
    if (!phone) { await page.locator(`.conversation-row[data-conversation-id="${home.id}"]`).click(); await expect(page.getByRole("heading", { name: "调度台", exact: true, level: 1 })).toBeVisible(); }
    // Worker activity neither counts as unread nor animates the worker's avatar.
    // A Host notice that woke the dispatcher: folded into one quiet line (Hub-stamped `tn_*`).
    await hub.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "tn_notice", text: "【工单完成】「写周报」（tk_review）由 Codex（gpt-6 · high）完成，等待验收。\n\n周报正文第一段", attachments: [], mentions: ["disp"],
      botSource: { hostId: "hub_fixture", hostName: "macmini", botId: "w_codex", botName: "调度员 · Codex", requestId: "tk_review", hops: 1 } });
    // A Bot-to-Bot message with a caller-supplied `tk_*` requestId (`bm_*` clientMsgId) must NOT collapse into a DispatchNotice.
    await hub.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "bm_spoof", text: "来自研究助手的普通协作消息", attachments: [], mentions: ["disp"],
      botSource: { hostId: "hub_peer", hostName: "macmini", botId: "alpha", botName: "研究助手", requestId: "tk_spoof", hops: 1 } });
    await hub.store.publishBotMessage("w_codex", { conversationId: worker.id, blocks: [{ type: "text", text: "资料整理了一半" }], status: "complete" });
    await hub.store.publishBotMessage("w_codex", { conversationId: worker.id, blocks: [{ type: "text", text: "继续整理" }], status: "streaming" });
    await hub.store.publishBotMessage("alpha", { conversationId: research.id, blocks: [{ type: "text", text: "研究结论" }], status: "complete" });
    await expect(page).toHaveTitle("(1) TaroBird");

    // Star on the dispatcher only; worker chats stay out of every list.
    if (phone) {
      await expectStar(mobileHome(page).locator(`.mh-row[data-conversation-id="${home.id}"] .mh-avatar`));
      // Its avatar also shows the tickets running in hidden conversations — scoped per conversation!
      await expect(mobileHome(page).locator(`.mh-row[data-conversation-id="${home.id}"] .mh-avatar`)).toHaveAttribute("data-agent-state", "working");
      await expect(mobileHome(page).locator(`.mh-row[data-conversation-id="${secondHome.id}"] .mh-avatar`)).not.toHaveAttribute("data-agent-state", "working");
      await expect(mobileHome(page).locator(`.mh-row[data-conversation-id="${squad.id}"] .mh-avatar`)).toHaveAttribute("data-agent-state", "done");
      await page.screenshot({ path: test.info().outputPath(`home-${platform}.png`), animations: "disabled" });
      await expect(mobileHome(page).locator(`.mh-row[data-conversation-id="${research.id}"] .role-star`)).toHaveCount(0);
      await expect(mobileHome(page).locator(`.mh-row[data-conversation-id="${worker.id}"]`)).toHaveCount(0);
      await expect(mobileHome(page).locator(`.mh-row[data-conversation-id="${research.id}"] .mh-avatar`)).toHaveAttribute("data-agent-state", "done");
      await nav("Bot").click();
      const bots = mobileHome(page).locator(".mh-bot-row");
      await expectStar(bots.filter({ hasText: "调度员" }).locator(".mh-avatar"));
      await expect(bots.filter({ hasText: "研究助手" }).locator(".role-star")).toHaveCount(0);
      // The dispatcher's engine worker is never listed as a Bot.
      await expect(bots.filter({ hasText: "调度员 · Codex" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "与 调度员 新建对话", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "与 研究助手 新建对话", exact: true })).toBeVisible();
      await expect(bots.filter({ hasText: "研究助手" })).toContainText("2 个会话");
      await expect(bots.filter({ hasText: "研究助手" }).locator(".mh-avatar")).toHaveAttribute("data-agent-state", "done");
      await page.getByRole("button", { name: "查看 调度员 的全部对话", exact: true }).click();
      await expect(mobileHome(page).getByRole("heading", { name: "调度员 的对话", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "与 调度员 新建对话", exact: true })).toBeVisible();
      await mobileHome(page).locator(`.mh-row[data-conversation-id="${home.id}"]`).click();
    } else {
      await expectStar(page.locator('.bot-tree[data-bot-id="disp"] .bot-identity > .avatar'));
      // Its Bot-level avatar shows the aggregate state across its conversations; group row shows its own ticket state.
      await expect(page.locator('.bot-tree[data-bot-id="disp"] .bot-identity > .avatar')).toHaveAttribute("data-agent-state", "working");
      await expect(page.locator(`.conversation-row[data-conversation-id="${squad.id}"] .avatar`)).toHaveAttribute("data-agent-state", "done");
      await expect(page.locator('.bot-tree[data-bot-id="alpha"] .role-star')).toHaveCount(0);
      await expect(page.locator('.bot-tree[data-bot-id="w_codex"]')).toHaveCount(0);
      await expect(page.locator(`.conversation-row[data-conversation-id="${worker.id}"]`)).toHaveCount(0);
      await expect(page.locator('.bot-tree[data-bot-id="alpha"] .conversation-row')).toHaveCount(1);
      await expect(page.locator('.bot-tree[data-bot-id="alpha"] .bot-identity > .avatar')).toHaveAttribute("data-agent-state", "done");
      await expect(page.getByRole("button", { name: "为 调度员 新建对话", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "为 研究助手 新建对话", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "更多聊天操作", exact: true }).filter({ visible: true }).click();
      await expect(page.getByRole("button", { name: "对话详情", exact: true }).filter({ visible: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "新对话", exact: true }).filter({ visible: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await expect(page.getByRole("heading", { name: "调度台", exact: true, level: 1 })).toBeVisible();
    await expect(page.locator(".chat-identity > .profile-avatar[data-role=dispatcher] > .role-star")).toBeVisible();

    const notice = page.locator(".host-workspace:not([hidden]) .dispatch-notice");
    await expect(notice).toHaveCount(1);
    await expect(notice.locator("summary")).toHaveText("【工单完成】「写周报」由 Codex（gpt-6 · high）完成，等待验收。");
    await expect(notice.getByText("周报正文第一段")).toBeHidden();
    await notice.locator("summary").click();
    await expect(notice.getByText("周报正文第一段", { exact: false })).toBeVisible();
    await notice.locator("summary").click();
    // Spoofed `tk_*` Bot-to-Bot message renders as a normal Bot-sourced message, not a DispatchNotice.
    const botMsg = page.locator(".host-workspace:not([hidden]) .message").filter({ hasText: "来自研究助手的普通协作消息" });
    await expect(botMsg.locator(".bot-message-source")).toContainText("来自 macmini · 研究助手");

    // Tickets start collapsed even with active/review items; expand on request.
    const panel = page.locator(".host-workspace:not([hidden]) .dispatch-tickets");
    const ticketsToggle = panel.getByRole("button", { name: /^工单 4/ });
    await expect(ticketsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel.locator(".dispatch-ticket-list")).toHaveCount(0);
    await ticketsToggle.click();
    await expect(ticketsToggle).toHaveAttribute("aria-expanded", "true");
    // Multi-conversation scope switcher defaults to current conversation (4) and lets the user view all (5).
    const scopeGroup = panel.getByRole("group", { name: "工单范围", exact: true });
    await expect(scopeGroup.getByRole("button", { name: "当前对话 (4)", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(scopeGroup.getByRole("button", { name: "全部 (5)", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(panel.locator(".dispatch-ticket strong")).toHaveText(["整理资料", "写周报", "翻译摘要", "旧任务"]);
    const ticket = (id: string) => panel.locator(`.dispatch-ticket[data-ticket-id="${id}"]`);
    await expect(ticket("t_work")).toContainText("进行中");
    await expect(ticket("t_work")).toContainText("Codex · gpt-6 · high");
    await expect(ticket("t_review").getByRole("button", { name: "验收", exact: true })).toBeVisible();
    await expect(ticket("t_work").getByRole("button", { name: "验收", exact: true })).toHaveCount(0);
    await expect(ticket("t_done").getByRole("button", { name: "暂停", exact: true })).toHaveCount(0);
    await expect(panel.locator(".dispatch-engines")).toContainText(/Kimi 冷却到 .*\d{2}:\d{2}/);
    await expect(panel.locator(".dispatch-engines")).toContainText("Claude 需要登录");
    // An offline Claude Bot must not render its numeric online=0 as visible text.
    await expect(page.locator(".host-workspace:not([hidden]) .composer-accessories")).toHaveText("");
    await page.mouse.move(0, 0); await page.screenshot({ path: test.info().outputPath(`tickets-${platform}.png`), animations: "disabled" });
    await panel.locator(".dispatch-engines > span").filter({ hasText: "Kimi" }).getByRole("button", { name: "清除", exact: true }).click();
    await expect(panel.locator(".dispatch-engines")).not.toContainText("Kimi");
    expect(await hub.store.db.get("SELECT 1 FROM engine_health WHERE engine='kimi'")).toBeUndefined();

    const waiting = await hub.dispatch.show({ kind: "owner", userId: "owner" }, "t_work");
    await hub.store.db.run("UPDATE dispatch_tickets SET attempts_json=? WHERE id='t_work'", [JSON.stringify(waiting.attempts.map(a => ({ ...a, waitingFor: { kind: "approval", messageId: "approval_fixture" } })))]);
    await expect(ticket("t_work").locator(".dispatch-ticket-status")).toHaveText("待你回答", { timeout: 10_000 });
    await expect(ticket("t_work")).toContainText("打开执行会话，处理问题或权限审批。");
    await expect(ticket("t_work").getByRole("button", { name: "打开", exact: true })).toBeVisible();

    await ticket("t_work").getByRole("button", { name: "暂停", exact: true }).click();
    // Unknown execution is not a stopped ticket: this fixture has no worker
    // receipt yet. Only a terminal delivery makes Resume available.
    await expect(ticket("t_work").locator(".dispatch-ticket-status")).toHaveText("正在暂停");
    await expect(ticket("t_work").getByRole("button", { name: "暂停", exact: true })).toBeDisabled();
    expect(await ticketStatus(hub, "t_work")).toEqual({ status: "working", paused: 1 });
    const input = await hub.store.sendMessage("owner", { conversationId: worker.id, clientMsgId: "stopped-input", text: "stopped", attachments: [] });
    await hub.store.db.run("UPDATE deliveries SET status='cancelled',dispatched=1 WHERE message_id=?", [input.message.id]);
    const current = await hub.dispatch.show({ kind: "owner", userId: "owner" }, "t_work");
    await hub.store.db.run("UPDATE dispatch_tickets SET attempts_json=? WHERE id='t_work'", [JSON.stringify(current.attempts.map(a => ({ ...a, inputMessageId: input.message.id })))]);
    await hub.dispatch.sweep();
    await expect(ticket("t_work").locator(".dispatch-ticket-paused")).toHaveText("已暂停");
    expect(await ticketStatus(hub, "t_work")).toEqual({ status: "queued", paused: 1 });
    await ticket("t_review").getByRole("button", { name: "验收", exact: true }).click();
    await expect(ticket("t_review").locator(".dispatch-ticket-status")).toHaveText("完成");
    expect(await ticketStatus(hub, "t_review")).toEqual({ status: "done", paused: 0 });
    await ticket("t_queue").getByRole("button", { name: "取消", exact: true }).click();
    await expect(ticket("t_queue")).toContainText("取消这张工单？");
    await ticket("t_queue").getByRole("button", { name: "确认取消工单", exact: true }).click();
    await expect(ticket("t_queue").locator(".dispatch-ticket-status")).toHaveText("已取消");
    expect(await ticketStatus(hub, "t_queue")).toEqual({ status: "cancelled", paused: 0 });

    // Ended entries can be removed, with the retained data scope stated before confirmation.
    await expect(ticket("t_work").getByRole("button", { name: "移除", exact: true })).toHaveCount(0);
    await ticket("t_done").getByRole("button", { name: "移除", exact: true }).click();
    await expect(ticket("t_done")).toContainText("从此幕僚长的工单列表移除，保留执行对话和生成文件。");
    await expect(ticket("t_done").getByRole("button", { name: "确认移除工单", exact: true })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`ticket-remove-${platform}.png`), animations: "disabled" });
    await ticket("t_done").getByRole("button", { name: "保留", exact: true }).click();
    expect((await hub.dispatch.overview({ kind: "owner", userId: "owner" }, "disp")).tickets.some(t => t.id === "t_done")).toBe(true);
    for (const id of ["t_done", "t_queue"]) {
      await ticket(id).getByRole("button", { name: "移除", exact: true }).click();
      await ticket(id).getByRole("button", { name: "确认移除工单", exact: true }).click();
      await expect(ticket(id)).toHaveCount(0);
    }
    expect((await hub.dispatch.overview({ kind: "owner", userId: "owner" }, "disp")).tickets.map(t => t.id).sort()).toEqual(["t_group", "t_review", "t_work"]);
    expect(await ticketStatus(hub, "t_done")).toEqual({ status: "done", paused: 0 });
    expect(await ticketStatus(hub, "t_queue")).toEqual({ status: "cancelled", paused: 0 });

    // Scope toggle to All reveals the group's ticket with its origin pill and jumps directly to that group.
    await scopeGroup.getByRole("button", { name: "全部 (3)", exact: true }).click();
    await expect(ticket("t_group")).toBeVisible();
    await ticket("t_group").getByRole("button", { name: "协作群", exact: true }).click();
    await expect(page.getByRole("heading", { name: "协作群", exact: true, level: 1 })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^工单 1/ })).toBeVisible();
    // Navigate back to home to open the hidden worker chat from t_work.
    await panel.getByRole("button", { name: /^工单 1/ }).click();
    await panel.getByRole("group", { name: "工单范围", exact: true }).getByRole("button", { name: "全部 (3)", exact: true }).click();
    await expect(ticket("t_work")).toBeVisible();

    // A hidden worker chat still opens from its ticket.
    await ticket("t_work").getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.getByRole("heading", { name: "工单：整理资料", exact: true, level: 1 })).toBeVisible();
    await expect(page.locator(".host-workspace:not([hidden]) .dispatch-tickets")).toHaveCount(0);

    // The device preference lists worker chats again.
    await openSettings(page);
    const toggle = page.getByRole("switch", { name: "在列表里显示工单对话", exact: true });
    await expect(toggle).not.toBeChecked(); await toggle.click(); await expect(toggle).toBeChecked();
    await expect(page.getByText("在接收主机开启此选项，然后从会话列表打开同名工单，在互动卡片上处理审批或回答问题。", { exact: true })).toBeVisible();
    // The star is not motion: it stays with animated avatars switched off.
    await page.getByRole("switch", { name: "动态头像", exact: true }).click();
    await closeSettings(page);
    if (phone) {
      await nav(/^消息/).click();
      await mobileHome(page).getByRole("button", { name: "显示全部 Bot 的对话", exact: true }).click();
      await expect(mobileHome(page).locator(`.mh-row[data-conversation-id="${worker.id}"]`)).toBeVisible();
      await expect(mobileHome(page).locator(`.mh-row[data-conversation-id="${research.id}"] .mh-avatar`)).toHaveAttribute("data-agent-motion", "off");
      await expectStar(mobileHome(page).locator(`.mh-row[data-conversation-id="${home.id}"] .mh-avatar`));
    } else {
      await page.getByRole("button", { name: "按对话", exact: true }).click();
      await expect(page.locator(`.conversation-row[data-conversation-id="${worker.id}"]`)).toBeVisible();
      // Direct conversation rows in inbox layout keep per-conversation ticket signals without cross-chat bleed.
      await expect(page.locator(`.conversation-row[data-conversation-id="${secondHome.id}"] .avatar`)).not.toHaveAttribute("data-agent-state", "working");
      await expect(page.locator(`.conversation-row[data-conversation-id="${squad.id}"] .avatar`)).toHaveAttribute("data-agent-state", "done");
      await expect(page.locator('.bot-tree[data-bot-id="w_codex"]')).toHaveCount(0);
      await page.getByRole("button", { name: "按 Bot", exact: true }).click();
      await expect(page.locator('.bot-tree[data-bot-id="disp"] .bot-identity > .avatar')).toHaveAttribute("data-agent-motion", "off");
      await expectStar(page.locator('.bot-tree[data-bot-id="disp"] .bot-identity > .avatar'));
    }
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("English New Bot Superagent row fits without overflow on narrow phones (320px/344px/360px/390px)", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatcher-narrow-en-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: clientDir() });
  await hub.profile.update({ name: "macmini", revision: (await hub.profile.read()).revision });
  const catalog: BotCatalog = {
    engines: [{ id: "codex", available: true, models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" }],
  };
  try {
    for (const [width, height] of [[320, 568], [344, 740], [360, 740], [390, 844]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      try {
        await page.goto(hub.url);
        const invitation = await fixtureInvitation(hub);
        await page.getByRole("button", { name: "Paste connection details", exact: true }).click();
        await page.getByLabel("Pairing information", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
        await page.getByRole("button", { name: "Use pairing information", exact: true }).click();
        await page.getByRole("button", { name: "Pair this device", exact: true }).click();
        await hub.auth.approve(await page.getByLabel("Pairing code", { exact: true }).innerText(), "local-owner");
        await page.getByLabel("Pairing code", { exact: true }).waitFor({ state: "hidden" });
        await page.route("**/api/bots/catalog*", route => route.fulfill({ json: catalog }));
        await page.getByRole("button", { name: "New", exact: true }).filter({ visible: true }).click();
        await page.getByRole("menuitem", { name: "New Bot", exact: true }).or(page.getByRole("button", { name: "New Bot", exact: true })).filter({ visible: true }).click();
        const dialog = page.getByRole("dialog", { name: "New Bot", exact: true });
        const roleBox = dialog.locator(".new-bot-role");
        const row = roleBox.locator(".dispatcher-role-row");
        const label = row.locator(".collaboration-check");
        const badge = row.locator(".new-bot-experimental-badge");
        const help = row.locator(".dispatcher-routing-help");
        await expect(label).toContainText("Make it a Superagent");
        await expect(badge).toHaveText("Experimental");
        await expect(help).toBeVisible();
        await roleBox.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        const metrics = await dialog.evaluate(el => {
          const form = el.querySelector<HTMLElement>(".new-bot-form")!;
          const role = el.querySelector<HTMLElement>(".new-bot-role")!;
          const roleRow = el.querySelector<HTMLElement>(".dispatcher-role-row")!;
          const check = roleRow.querySelector<HTMLElement>(".collaboration-check")!;
          const pill = roleRow.querySelector<HTMLElement>(".new-bot-experimental-badge")!;
          const helpBtn = roleRow.querySelector<HTMLElement>(".dispatcher-routing-help")!;
          return {
            formScrollW: form.scrollWidth,
            formClientW: form.clientWidth,
            roleScrollW: role.scrollWidth,
            roleClientW: role.clientWidth,
            rowScrollW: roleRow.scrollWidth,
            rowClientW: roleRow.clientWidth,
            roleRight: role.getBoundingClientRect().right,
            helpRight: helpBtn.getBoundingClientRect().right,
            badgeRight: pill.getBoundingClientRect().right,
            labelTop: check.getBoundingClientRect().top,
            badgeTop: pill.getBoundingClientRect().top,
            helpTop: helpBtn.getBoundingClientRect().top,
          };
        });
        expect(metrics.formScrollW, `${width}px form overflow`).toBeLessThanOrEqual(metrics.formClientW);
        expect(metrics.roleScrollW, `${width}px role overflow`).toBeLessThanOrEqual(metrics.roleClientW);
        expect(metrics.rowScrollW, `${width}px row overflow`).toBeLessThanOrEqual(metrics.rowClientW);
        expect(metrics.helpRight, `${width}px help button right`).toBeLessThanOrEqual(metrics.roleRight);
        expect(metrics.badgeRight, `${width}px badge right`).toBeLessThanOrEqual(metrics.roleRight);
        if (width >= 360) {
          expect(Math.abs(metrics.helpTop - metrics.labelTop), `${width}px single-line layout`).toBeLessThanOrEqual(8);
          expect(Math.abs(metrics.badgeTop - metrics.labelTop), `${width}px single-line badge`).toBeLessThanOrEqual(12);
        }
        await dialog.screenshot({ path: info.outputPath(`new-bot-en-${width}.png`), animations: "disabled" });
      } finally { await context.close(); }
    }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
