// A Host with one conversation that has Bot messages, files and a finished run, plus the pieces a test needs to
// put the workspace rail into states the real Host cannot be driven into quickly (many items, every status).
// Those states replace the Host's /bot-comms answer with a schema-conformant one.
import { expect, type Browser, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../../src/hub/server.js";
import { RunJournal } from "../../../src/hub/run-journal.js";
import { hashSecret } from "../../../src/hub/auth.js";
import { networkId } from "../../../src/hub/private-network.js";
import { networkManifestSchema } from "../../../src/client-protocol/private-network.js";
import { fixtureInvitation, preparePairing } from "./pairing-invite.js";
import { pairingLink } from "../../src/pairing-link.js";
import { waitForClientOnline } from "./mobile.js";

export const english = JSON.parse(await readFile(path.resolve("src/locales/en.json"), "utf8")) as Record<string, string>;
export type Locale = "zh" | "en";
export const tr = (locale: Locale) => (key: string) => locale === "en" ? (english[key] ?? key) : key;

export const HOST = "演示主机";
export const LONG_BOT = "Architect-Supervisor-长名字协调员-Bot-0123456789";
export const LONG_TITLE_ZH = "会话工作区开发：右侧栏与 Bot 间通信追踪、跨主机调用、Agent Bus 协作及文件产物的完整验收（第二轮）";
export const LONG_TITLE_EN = "Workspace rail implementation: Bot-to-Bot tracking, cross-host calls, Agent Bus stages and artifacts acceptance (round two)";

async function insertBotMessage(hub: HubServer, botId: string, conversationId: string, replyTo: string, blocks: unknown[], status: "complete" | "streaming" = "complete") {
  const message = await hub.store.publishBotMessage(botId, { conversationId, replyTo, blocks: blocks as never, status });
  return message.id;
}

export interface Fixture {
  hub: HubServer; root: string; ids: Record<string, string>; mainTitle: string;
}

export async function makeHub(locale: Locale, opts: { member?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ws-look-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  await hub.profile.update({ name: HOST, revision: 0 });
  for (const [id, name, engine, model] of [
    ["bot_arch", "Architect", "claude", "claude-sonnet-4-6"],
    ["bot_rev", "Reviewer", "codex", "gpt-5.4"],
    ["bot_res", "Researcher", "pi", "gemini-2.5-pro"],
    ["bot_long", LONG_BOT, "claude", "claude-opus-4-1-20250805-extended-context"],
    ["bot_ops", "运维小助手", "codex", "gpt-5.4"],
  ] as const) {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,online) VALUES(?,?,?,?,?,1)", [id, name, hashSecret(randomBytes(16).toString("hex")), engine, model]);
  }
  const user = opts.member ? "member1" : "owner";
  if (opts.member) {
    await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('member1','成员甲','member')");
    for (const b of ["bot_arch", "bot_rev", "bot_res", "bot_long", "bot_ops"]) await hub.store.db.run("INSERT INTO bot_grants(user_id,bot_id) VALUES('member1',?)", [b]);
  }
  const nonce = randomBytes(32).toString("base64url");
  const manifest = networkManifestSchema.parse({
    v: 2, id: networkId(hub.auth.publicKey, nonce), name: "ExampleNet", authorityKey: hub.auth.publicKey, genesisNonce: nonce, revision: 1,
    hosts: [{ publicKey: hub.auth.publicKey, name: HOST, routes: [], protocol: 2, state: "active", revoked: false }],
    devices: [], revokedMembers: [], blockedBindings: [],
  });
  const membership = { manifest, signature: hub.auth.signNetworkManifest(manifest) };
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES('private-network:v1',?)",
    [JSON.stringify({ v: 1, routes: [], membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })]);
  const guard = async () => undefined;
  await hub.botMessages.grant({ sourceHost: HOST, sourceBot: "bot_arch", targetBot: "bot_rev" }, guard);
  await hub.botMessages.grant({ sourceHost: HOST, sourceBot: "bot_arch", targetBot: "bot_res" }, guard);

  const mainTitle = locale === "en" ? "Workspace Rail Implementation" : "会话工作区开发";
  const mainChat = await hub.store.createConversation(user, ["bot_arch"], mainTitle, "main-workspace-chat");
  const { message: userMsg } = await hub.store.sendMessage(user, {
    conversationId: mainChat.id, clientMsgId: "cm_main_1",
    text: locale === "en" ? "Coordinate review and benchmark summary." : "请协调评审并汇总基准测试结果。",
    attachments: [], mentions: ["bot_arch"], previewUrl: null,
  });
  const runId = "run_ws_demo_1"; const runStart = Date.now() - 12_000; const runEnd = Date.now() - 2_000;
  await hub.store.db.run("INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES(?,?,?,?,18420,'text/markdown','workspace-rail-spec.md','att_spec_1.blob',1,?)", ["att_spec_1", mainChat.id, user, "a".repeat(64), runEnd - 1000]);
  await hub.store.db.run("INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES(?,?,?,?,4280,'application/json','layout-benchmark.json','att_bench_2.blob',1,?)", ["att_bench_2", mainChat.id, user, "b".repeat(64), runEnd]);
  const runMsgId = await insertBotMessage(hub, "bot_arch", mainChat.id, userMsg.id, [
    { type: "card", title: locale === "en" ? "Workspace implementation" : "工作区实现完成",
      elements: [{ type: "markdown", text: locale === "en" ? "Updated the workspace rail." : "已完成会话工作区侧栏。" }],
      extra: {
        nativeRun: { version: 1, id: runId, revision: 2, phase: "done", startedAt: runStart, updatedAt: runEnd, endedAt: runEnd, count: 2, completed: 2, failed: 0, truncated: false, model: "claude-sonnet-4-6" },
        runChanges: { v: 1, runId, revision: 2, files: 2, edits: 2, additions: 14, deletions: 3, unavailable: 0, partial: false, childEdits: 0 },
      } },
    { type: "file", attachmentId: "att_spec_1", name: "workspace-rail-spec.md", size: 18420, mime: "text/markdown" },
    { type: "file", attachmentId: "att_bench_2", name: "layout-benchmark.json", size: 4280, mime: "application/json" },
  ]);
  await new RunJournal(hub.store).write("bot_arch", { conversationId: mainChat.id, messageId: runMsgId, runId, entries: [
    { seq: 1, revision: 1, kind: "tool", status: "done", at: runStart + 2000, endedAt: runStart + 5000, name: "edit_file", changes: [{ path: "client/src/ConversationWorkspace.tsx", diff: "@@ -1,1 +1,2 @@\n-a\n+b\n+c" }] },
    { seq: 2, revision: 2, kind: "tool", status: "done", at: runStart + 6000, endedAt: runEnd, name: "edit_file", changes: [{ path: "src/hub/bot-messages.ts", diff: "@@ -1,1 +1,1 @@\n-x\n+y" }] },
  ] });
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [userMsg.id, "bot_arch"]);
  let revConv = "", resConv = "";
  if (!opts.member) {
    const revTarget = await hub.botMessages.local({ operation: "resolve", host: HOST, bot: "bot_rev", requestId: randomUUID(), contextMessage: userMsg.id, data: {} }, "bot_arch", guard) as { conversationId: string };
    const revSent = await hub.botMessages.local({ operation: "send", host: HOST, bot: "bot_rev", conversation: revTarget.conversationId, requestId: "req-ui-rev", contextMessage: userMsg.id, data: { text: locale === "en" ? "Run the full regression suite and verify auth checks." : "运行完整回归测试并检查鉴权逻辑。" } }, "bot_arch", guard) as { messageId: string };
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [revSent.messageId, "bot_rev"]);
    await insertBotMessage(hub, "bot_rev", revTarget.conversationId, revSent.messageId, [{
      type: "card", title: locale === "en" ? "Approve shell command" : "请求执行命令审批",
      elements: [
        { type: "markdown", text: "npm run test:regression -- --reporter=verbose" },
        { type: "button", text: "Allow once", actionId: "act_allow", value: { cctb_lark: "approval", requestId: "perm-ui-1", decision: "allow_once" } },
      ] }], "streaming");
    const resTarget = await hub.botMessages.local({ operation: "resolve", host: HOST, bot: "bot_res", requestId: randomUUID(), contextMessage: userMsg.id, data: {} }, "bot_arch", guard) as { conversationId: string };
    const resSent = await hub.botMessages.local({ operation: "send", host: HOST, bot: "bot_res", conversation: resTarget.conversationId, requestId: "req-ui-res", contextMessage: userMsg.id, data: { text: locale === "en" ? "Summarize layout benchmark numbers." : "整理布局基准数据。" } }, "bot_arch", guard) as { messageId: string };
    await insertBotMessage(hub, "bot_res", resTarget.conversationId, resSent.messageId, [{ type: "text", text: locale === "en" ? "Verified: 320px rail adds 0ms layout shift." : "已验证：320px 侧栏无布局抖动。" }], "complete");
    await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [resSent.messageId, "bot_res"]);
    revConv = revTarget.conversationId; resConv = resTarget.conversationId;
  }
  // Extra conversations
  const empty = await hub.store.createConversation(user, ["bot_ops"], locale === "en" ? "Empty chat" : "空白对话", "empty-chat");
  const longTitle = await hub.store.createConversation(user, ["bot_long"], locale === "en" ? LONG_TITLE_EN : LONG_TITLE_ZH, "long-title-chat");
  const group = await hub.store.createConversation(user, ["bot_arch", "bot_rev", "bot_res", "bot_long", "bot_ops"], locale === "en" ? "Release group" : "发布群", "group-chat", { type: "group" });
  return { hub, root, mainTitle, ids: { main: mainChat.id, empty: empty.id, longTitle: longTitle.id, group: group.id, revConv, resConv, runMsgId, userMsg: userMsg.id } };
}

export async function closeHub(f: Fixture) { await f.hub.close(); await rm(f.root, { recursive: true, force: true }); }

export async function newPage(browser: Browser, locale: Locale, viewport: { width: number; height: number }, phone = false) {
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 2, locale: locale === "en" ? "en-US" : "zh-CN", serviceWorkers: "block",
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  return { context, page, errors };
}

export async function pair(page: Page, f: Fixture, locale: Locale, userId = "owner") {
  const L = tr(locale);
  await page.goto(f.hub.url);
  if (locale === "en") {
    const invitation = await fixtureInvitation(f.hub);
    await page.getByRole("button", { name: "Paste connection details", exact: true }).click();
    await page.getByLabel("Pairing information", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: f.hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: f.hub.url }] }));
    await page.getByRole("button", { name: "Use pairing information", exact: true }).click();
  } else {
    await page.getByLabel("主机名称", { exact: true }).fill(HOST);
    await preparePairing(page, f.hub);
  }
  await page.getByRole("button", { name: L("配对此设备"), exact: true }).click();
  await f.hub.auth.approve(await page.getByLabel(L("配对码"), { exact: true }).innerText(), "local-owner", userId);
  await page.getByLabel(L("配对码"), { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}

export async function openConv(page: Page, title: string) {
  await page.locator(".conversation-row").filter({ has: page.getByText(title, { exact: true }) }).first().click();
  await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
}

export async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
  await page.waitForTimeout(150);
}

export async function measure(page: Page) {
  return page.evaluate(() => {
    const r = (sel: string) => { const n = document.querySelector(sel) as HTMLElement | null; if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height), sw: n.scrollWidth, cw: n.clientWidth, vis: getComputedStyle(n).display !== "none" && b.width > 0 }; };
    return {
      vw: innerWidth, docOverflow: document.documentElement.scrollWidth - innerWidth,
      sidebar: r(".host-workspace:not([hidden]) .app-shell > .sidebar"),
      main: r(".host-workspace:not([hidden]) main"),
      rail: r("aside.conversation-workspace-rail"),
      header: r(".host-workspace:not([hidden]) .conversation-header"),
      title: r(".host-workspace:not([hidden]) .conversation-header .chat-identity>span[title]"),
      h1: r(".host-workspace:not([hidden]) .conversation-header h1"),
      trigger: r(".host-workspace:not([hidden]) .workspace-rail-trigger:not(.files-trigger)"),
      composer: r(".host-workspace:not([hidden]) .composer"),
      composerBox: r(".host-workspace:not([hidden]) .composer textarea"),
    };
  });
}

// ---- Crafted Host answers (schema conformant) --------------------------------
type Item = Record<string, unknown>;
export function item(i: number, p: Partial<Item> = {}): Item {
  const now = Date.now();
  return {
    id: `out:bot_arch:req-${i}`, kind: "outgoing_bot_message", direction: "outgoing", requestId: `req-${i}`,
    sourceHostName: HOST, sourceBotId: "bot_arch", sourceBotName: "Architect",
    targetHostName: HOST, targetBotId: "bot_rev", targetBotName: "Reviewer",
    crossHost: false, status: "replied", canJumpToTarget: false,
    sentExcerpt: `第 ${i} 条委托：检查 PR #${100 + i} 的回归测试`, replyExcerpt: `第 ${i} 条回传：全部通过。`,
    createdAt: now - i * 60_000, updatedAt: now - i * 60_000, ...p,
  };
}
export function comms(conversationId: string, items: Item[]) {
  const active = items.filter(i => ["running", "steered", "queued", "needs_approval"].includes(i.status as string)).length;
  const needsApproval = items.filter(i => i.status === "needs_approval").length;
  return { conversationId, items, summary: { total: items.length, active, needsApproval } };
}
export async function mockComms(page: Page, conversationId: string, body: unknown) {
  await page.route(`**/api/conversations/${conversationId}/bot-comms`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}
