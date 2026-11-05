import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { backgroundTaskNotice } from "../src/client-protocol/background-task.js";
import { forwardedBlocks } from "../src/client-protocol/forwarding.js";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blocksText, type CardElement, type Message } from "../src/client-protocol/index.js";
import { notificationPreferencesSchema } from "../src/client-protocol/push.js";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { channelProfile, withChannelProfile } from "../src/gateway/platform-profile.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { requestCoreApproval } from "../src/core/card-actions.js";
import { CronStore } from "../src/state/cron-store.js";
import { buildCoreCronExecutor, sendCoreCronFailureNotification } from "../src/core/cron.js";
import type { CoreChannelLike, CoreBridgeLike } from "../src/core/types.js";
import { BoardStore } from "../src/state/board-store.js";
import { MiniBusStore } from "../src/state/mini-bus-store.js";
import { stableCoreNumericId } from "../src/core/message-normalizer.js";
import { anyRun } from "../src/client-protocol/run.js";
import { RunJournal } from "../src/hub/run-journal.js";
import { FileWorkflowStore } from "../src/state/file-workflow-store.js";
import * as delivery from "../src/core/delivery.js";

it.each([false, true])("updates a late Claude answer receipt in place without another prompt or terminal revival (delayed send receipt: %s)", async (delayReceipt) => {
  let origin!: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { origin = input; return { text: "Background work started" }; });
  const runtime = createCoreServiceRuntime();
  gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: engine } });
  let releaseReceipt!: () => void;
  const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
  if (delayReceipt) {
    const sendCard = gateway.send.bind(gateway);
    vi.spyOn(gateway, "send").mockImplementation(async (...args) => {
      const sent = await sendCard(...args);
      if (JSON.stringify(args[1]).includes("askq_submit")) await receiptGate;
      return sent;
    });
  }
  const c = await hub.store.createConversation("owner", ["alpha"], "Background question", "background_question");
  await send(c.id, "Start the report", "start_report");
  await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));
  // Persistent CLI callbacks run after the original turn and outside its ALS.
  const answer = withChannelProfile("feishu", () => origin.onApprovalRequest!({ engine: "claude", toolName: "AskUserQuestion",
    supportsAnswerProgress: true, toolInput: { questions: [{ question: "Which version?", header: "Version", options: [{ label: "Latest" }] }] } }));
  let card!: Message;
  await until(async () => { card = (await hub.store.snapshot("owner", c.id)).messages.find(m => buttons(m).some(b => b.name === "askq_submit"))!; return !!card; });
  expect(JSON.stringify(card.blocks)).toContain("tarocub_questions");
  const submit = buttons(card).find(b => b.name === "askq_submit")!;
  const submissions = Promise.all([tap(card, submit, "submit_answer", { q0: "0" }), tap(card, submit, "submit_answer", { q0: "0" })]);
  if (delayReceipt) await new Promise(resolve => setTimeout(resolve, 50));
  releaseReceipt();
  await submissions;
  const decision = await answer;
  expect(decision.behavior).toBe("allow"); if (decision.behavior !== "allow") throw new Error("not accepted");
  expect(decision.onAnswerProgress).toBeTypeOf("function");
  const read = async () => (await hub.store.snapshot("owner", c.id)).messages.find(m => m.id === card.id)!;
  await until(async () => blocksText((await read()).blocks).includes("no need to submit again"));
  decision.onAnswerProgress!({ phase: "sent" });
  decision.onAnswerProgress!({ phase: "working", toolName: "Bash" });
  await until(async () => blocksText((await read()).blocks).includes("running a command"));
  expect(blocksText((await read()).blocks)).toContain("Latest");
  expect(buttons(await read())).toHaveLength(0);
  const version = (await read()).version;
  for (let i = 0; i < 20; i++) decision.onAnswerProgress!({ phase: "working", toolName: "Bash" });
  expect((await read()).version).toBe(version);
  decision.onAnswerProgress!({ phase: "interrupted" });
  decision.onAnswerProgress!({ phase: "working", toolName: "Read" });
  decision.onAnswerProgress!({ phase: "finished" });
  await until(async () => blocksText((await read()).blocks).includes("follow-up was interrupted"));
  expect(blocksText((await read()).blocks)).not.toContain("generated the follow-up");
  expect(engine).toHaveBeenCalledTimes(1);
  expect((await hub.store.snapshot("owner", c.id)).messages.filter(m => blocksText(m.blocks).includes("Version"))).toHaveLength(1);
});

it("keeps an immediately approved command in its original card while the send receipt is pending", async () => {
  const runtime = createCoreServiceRuntime();
  gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } });
  const conversation = await hub.store.createConversation("owner", ["alpha"], "Approval receipt", "approval_receipt");
  let releaseReceipt!: () => void;
  const gate = new Promise<void>(resolve => { releaseReceipt = resolve; });
  const sendCard = gateway.send.bind(gateway);
  vi.spyOn(gateway, "send").mockImplementation(async (...args) => {
    const sent = await sendCard(...args);
    if (JSON.stringify(args[1]).includes('"cctb_lark":"approval"')) await gate;
    return sent;
  });
  const decision = requestCoreApproval({ channel: gateway, runtime, chatId: conversation.id, locale: "en",
    request: { engine: "claude", toolName: "Bash", toolInput: { command: "echo approval-fixture" } } });
  let card!: Message;
  await until(async () => { card = (await hub.store.snapshot("owner", conversation.id)).messages.find(message => buttons(message).length > 0)!; return !!card; });
  const allow = buttons(card).find(button => button.value?.decision === "allow_once")!;
  const submitted = tap(card, allow, "approval_receipt_submit");
  await new Promise(resolve => setTimeout(resolve, 50));
  releaseReceipt();
  await submitted;
  expect((await decision).behavior).toBe("allow");
  await until(async () => buttons((await hub.store.snapshot("owner", conversation.id)).messages.find(message => message.id === card.id)!).length === 0);
  expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(1);
});

let root: string; let stateDir: string; let hub: HubServer; let gateway: GatewayChannel | undefined; let secret: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-workflows-")); stateDir = path.join(root, "instance"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
  hub = await HubServer.start({ stateDir: path.join(root, "hub") }); secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
});
afterEach(async () => { await gateway?.disconnect(); gateway = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });
const until = async (check: () => Promise<boolean>) => { const end = Date.now() + 10_000; while (!await check()) { if (Date.now() > end) throw new Error("workflow_timeout"); await new Promise((resolve) => setTimeout(resolve, 20)); } };
const options = () => ({ stateDir, botId: "alpha", secret, engine: "codex" as const, url: hub.instanceUrl.replace("http", "ws") + "/instance" });
async function send(conversationId: string, text: string, clientMsgId: string) { await hub.store.sendMessage("owner", { conversationId, clientMsgId, text, attachments: [], mentions: ["alpha"] }); await until(async () => (await hub.store.pendingForBot("alpha")).length === 0); }
function buttons(message: Message): CardElement[] { const walk = (elements: CardElement[]): CardElement[] => elements.flatMap((item) => [item, ...walk(item.children ?? [])]); return message.blocks.flatMap((block) => block.type === "card" ? walk(block.elements).filter((element) => element.type === "button") : []); }
async function tap(message: Message, button: CardElement, receiptId: string, values: Record<string, string> = {}) { return gateway!.transport.onCall!("interaction", { receiptId, conversationId: message.conversationId, messageId: message.id, userId: "owner", actionId: button.actionId!, value: button.value ?? {}, values }); }
async function emitScopedReport(callback: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0]["onEngineEvent"], id: string, text: string) {
  const scope = { id, kind: "background" as const };
  await callback?.({ type: "scoped", scope, origin: "bound", event: { type: "tool_use", toolName: "Read", toolUseId: "read" } });
  await callback?.({ type: "scoped", scope, origin: "bound", event: { type: "tool_result", toolUseId: "read", output: "Verified" } });
  await callback?.({ type: "scoped", scope, origin: "bound", event: { type: "scope_status", status: "done" } });
  await callback?.({ type: "task_notification", scopeId: id, origin: "bound", status: "completed", text });
}

it("answers a blocking Claude free-text question through interaction while ordinary text remains queued", async () => {
  let received: unknown;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length > 1) return { text: "Queued follow-up completed" };
    received = await input.onApprovalRequest!({ engine: "claude", toolName: "AskUserQuestion", toolInput: { questions: [{ question: "Which report format?", header: "Format", options: [{ label: "Plain text" }, { label: "Spreadsheet" }] }] } });
    return { text: "Answer received" };
  });
  const runtime = createCoreServiceRuntime();
  gateway = await attachGateway({ ...options(), engine: "claude", runtime, bridge: { handleAuthorizedMessage: engine } });
  const c = await hub.store.createConversation("owner", ["alpha"], "Free text answer", "free_text_answer");
  await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "question_origin", text: "Prepare a report", attachments: [] });
  let card!: Message;
  await until(async () => { card = (await hub.store.snapshot("owner", c.id)).messages.find(m => buttons(m).some(b => b.name === "askq_submit"))!; return !!card; });
  const queued = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "ordinary_while_waiting", text: "Another ordinary task", attachments: [] });
  expect(await hub.store.db.get("SELECT dispatched,status FROM deliveries WHERE message_id=?", [queued.message.id])).toEqual({ dispatched: 0, status: "pending" });
  expect(engine).toHaveBeenCalledTimes(1);
  await tap(card, buttons(card).find(b => b.name === "askq_submit")!, "free_text_submission", { q0_other: "PDF with diagrams" });
  await until(async () => !(await hub.store.pendingForBot("alpha")).length);
  expect(JSON.stringify(received)).toContain("PDF with diagrams");
  expect(engine).toHaveBeenCalledTimes(2); expect(engine.mock.calls[1]![0].text).toContain("Another ordinary task");
  expect(runtime.pendingApprovals.size).toBe(0);
});

it("streams a native goal card, reports status and clears the same bridge goal", async () => {
  const goal = { threadId: "goal_fixture", objective: "Finish the fixture", status: "complete" as const, tokenBudget: null, tokensUsed: 123, timeUsedSeconds: 1, createdAt: 0, updatedAt: 1 };
  const clear = vi.fn(async () => ({ cleared: true })); const engine = vi.fn(async () => ({ text: "ordinary" }));
  const bridge: CoreBridgeLike = { handleAuthorizedMessage: engine, watchThreadGoal: async function (input) { expect(this).toBe(bridge); expect(input.objective).toBe(goal.objective); expect(channelProfile()).toBe("gateway"); await input.onEngineEvent?.({ type: "assistant_text", text: "Goal progress fixture", delta: true }); return { goal }; }, getThreadGoal: async () => ({ goal }), clearThreadGoal: clear };
  const runtime = createCoreServiceRuntime(); gateway = await attachGateway({ ...options(), bridge, runtime });
  const c = await hub.store.createConversation("owner", ["alpha"], "Goals", "create");
  await send(c.id, `/goal ${goal.objective}`, "goal"); await until(async () => !runtime.activeRuns.has(`lark:${c.id}`));
  expect(clear).toHaveBeenCalledTimes(1); clear.mockClear();
  await send(c.id, "/goal status", "status"); await send(c.id, "/goal clear", "clear");
  const body = (await hub.store.snapshot("owner", c.id)).messages.filter((m) => m.authorType === "bot").map((m) => blocksText(m.blocks)).join("\n");
  expect(body).toContain(goal.objective); expect(body).toContain("123"); expect(body).toContain("Goal progress fixture"); expect(clear).toHaveBeenCalledTimes(1); expect(engine).not.toHaveBeenCalled();
});

it("sanitizes actual engine choice cards, submits once and closes the original buttons", async () => {
  let choiceEvent: ((event: EngineStreamEvent) => void | Promise<void>) | undefined;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValueOnce({ text: '[tool:{"name":"lark.card","payload":{"card":{"schema":"2.0","body":{"elements":[{"tag":"button","text":{"tag":"plain_text","content":"Continue"},"value":{"cctb_lark":"choice","label":"Continue","value":"continue_fixture","conversationKey":"lark:untrusted_other"}}]}}}}]' }).mockImplementation(async input => { choiceEvent = input.onEngineEvent; await emitScopedReport(input.onEngineEvent, "choice_review", "Choice background report"); return { text: "Choice accepted" }; });
  const runtime = createCoreServiceRuntime(); gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: engine } });
  const c = await hub.store.createConversation("owner", ["alpha"], "Choice", "create"); await send(c.id, "Show choices", "question");
  const card = (await hub.store.snapshot("owner", c.id)).messages.find((message) => buttons(message).some((button) => button.text === "Continue"))!; expect(card).toBeDefined();
  const button = buttons(card).find((button) => button.text === "Continue")!; expect(button.value).toMatchObject({ conversationKey: `lark:${c.id}`, value: "continue_fixture" });
  await Promise.all([tap(card, button, "choice_tap"), tap(card, button, "choice_tap")]);
  await until(async () => engine.mock.calls.length === 2 && !runtime.chatQueue.isBusy(`lark:${c.id}`));
  expect(engine.mock.calls[1]![0].text).toContain("continue_fixture"); expect(engine.mock.calls[1]![0].conversationKey).toBe(`lark:${c.id}`);
  expect(engine.mock.calls[1]![0].requestOutputDir).toBe(path.join(stateDir, "workspace", ".tarobot-out", card.id));
  const settled = (await hub.store.snapshot("owner", c.id)).messages.find((message) => message.id === card.id)!;
  expect(buttons(settled).every((button) => button.disabled)).toBe(true);
  const background = (await hub.store.snapshot("owner", c.id)).messages.find(message => blocksText(message.blocks).includes("Choice background report"))!;
  expect(background.blocks.some(block => block.type === "card" && backgroundTaskNotice(block)?.origin === "bound" && block.extra?.scopedRun)).toBe(true);
  expect(background.replyTo).toBe(card.id); expect(buttons(background)).toHaveLength(0);
  expect(JSON.parse(JSON.stringify(settled.blocks).replaceAll(c.id, "conversation_fixture"))).toMatchSnapshot("preserved_choice_submitted");
  await tap(card, button, "choice_repeat_new_id"); expect(engine).toHaveBeenCalledTimes(2);
  await withChannelProfile("feishu", () => choiceEvent?.({ type: "task_notification", origin: "unattributed", text: "## Late choice report" }));
  const lateChoice = (await hub.store.snapshot("owner", c.id)).messages.find(m => blocksText(m.blocks).includes("Late choice report"))!;
  expect(lateChoice.replyTo).toBeUndefined();
  expect(lateChoice.blocks.some(b => b.type === "card" && backgroundTaskNotice(b)?.origin === "unattributed")).toBe(true);
  expect(blocksText(lateChoice.blocks)).toContain("## Late choice report");

});

it("creates a board task and applies its actual translated Ready button", async () => {
  const engine = vi.fn(async () => ({ text: "unused" })); gateway = await attachGateway({ ...options(), runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: engine } });
  const c = await hub.store.createConversation("owner", ["alpha"], "Board", "create"); await send(c.id, "/board add Verify client board", "add");
  const board = new BoardStore(stateDir); const task = (await board.listTasks())[0]!; expect(task.title).toBe("Verify client board"); expect(task.status).toBe("todo");
  await send(c.id, `/board show ${task.id}`, "show");
  const card = (await hub.store.snapshot("owner", c.id)).messages.find((message) => buttons(message).some((button) => JSON.stringify(button.value).includes(`/board ready ${task.id}`)))!;
  expect(card).toBeDefined(); const button = buttons(card).find((button) => JSON.stringify(button.value).includes(`/board ready ${task.id}`))!;
  await tap(card, button, "board_ready"); await until(async () => (await board.getTask(task.id))?.status === "ready");
  expect(engine).not.toHaveBeenCalled();
});

it.each(["AskUserQuestion", "Bash"])("stopping a pending %s closes the same native card without CardKit", async (toolName) => {
  const runtime = createCoreServiceRuntime();
  gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: async (input) => {
    await input.onApprovalRequest!({ engine: "claude", toolName, toolInput: toolName === "AskUserQuestion" ? { questions: [{ question: "Choose one", options: [{ label: "First" }, { label: "Second" }] }] } : { command: "echo fixture" } });
    return { text: "Stopped approval fixture" };
  } } });
  expect("rawClient" in gateway).toBe(false);
  const c = await hub.store.createConversation("owner", ["alpha"], "Pending approval", "create");
  await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "ask", text: "Ask a question", attachments: [] });
  await until(async () => !![...runtime.pendingApprovals.values()][0]?.managedCard);
  const handle = [...runtime.pendingApprovals.values()][0]!.managedCard!; expect(handle.native).toBe(true);
  await gateway.onCall!("stop", { conversationId: c.id });
  await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && runtime.pendingApprovals.size === 0);
  await until(async () => { const card = (await hub.store.snapshot("owner", c.id)).messages.find((message) => message.id === handle.messageId)!; return card.version > 1 && buttons(card).length === 0; });
  const card = (await hub.store.snapshot("owner", c.id)).messages.find((message) => message.id === handle.messageId)!;
  expect(blocksText(card.blocks)).toMatch(/取消|cancelled/);
  expect(card.blocks).toMatchSnapshot(`${toolName}_cancelled`);
});

it.each(["AskUserQuestion", "Bash"])("a late %s send receipt cannot resurrect a cancelled native card", async (toolName) => {
  const runtime = createCoreServiceRuntime();
  gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: async (input) => {
    await input.onApprovalRequest!({ engine: "claude", toolName, toolInput: toolName === "AskUserQuestion" ? { questions: [{ question: "Choose one", options: [{ label: "First" }, { label: "Second" }] }] } : { command: "echo fixture" } });
    return { text: "Cancelled before receipt" };
  } } });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let lateId: string | undefined;
  const originalSend = gateway.send.bind(gateway);
  vi.spyOn(gateway, "send").mockImplementation(async (to, content, opts) => {
    const pending = [...runtime.pendingApprovals.values()][0];
    const hold = pending && JSON.stringify(content).includes(pending.requestId);
    const receipt = await originalSend(to, content, opts);
    if (hold) { lateId = receipt.messageId; await gate; }
    return receipt;
  });
  const c = await hub.store.createConversation("owner", ["alpha"], "Late card", "create");
  try {
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "ask", text: "Ask", attachments: [] });
    await until(async () => !!lateId); expect([...runtime.pendingApprovals.values()][0]?.managedCard).toBeUndefined();
    await gateway.onCall!("stop", { conversationId: c.id });
    await until(async () => runtime.pendingApprovals.size === 0); release();
    await until(async () => { const message = (await hub.store.snapshot("owner", c.id)).messages.find((m) => m.id === lateId)!; return message.version > 1 && buttons(message).length === 0; });
    const message = (await hub.store.snapshot("owner", c.id)).messages.find((m) => m.id === lateId)!; expect(blocksText(message.blocks)).toMatch(/取消|cancelled/);
  } finally { release(); }
});

it("registers and removes a mini-bus peer within the client's group scope", async () => {
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en", groupMode: { enabled: true } }));
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('beta','Beta',?)", [hashSecret("fixture-beta")]);
  const engine = vi.fn(async () => ({ text: "unused" })); gateway = await attachGateway({ ...options(), runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: engine } });
  const c = await hub.store.createConversation("owner", ["alpha", "beta"], "Mini group", "create"); const mini = new MiniBusStore(stateDir); const chatId = stableCoreNumericId(`lark-group:${c.id}`);
  await send(c.id, "/mini here editor", "here"); expect(await mini.getPeer(chatId, "editor")).toMatchObject({ conversationKey: `lark:${c.id}` });
  await send(c.id, "/mini list", "list"); expect((await hub.store.snapshot("owner", c.id)).messages.some((m) => m.authorType === "bot" && blocksText(m.blocks).includes("editor"))).toBe(true);
  await send(c.id, "/mini remove editor", "remove"); expect(await mini.getPeer(chatId, "editor")).toBeNull(); expect(engine).not.toHaveBeenCalled();
});

it("runs fan, ask and verify through the shared Agent Bus dispatcher with Gateway replies", async () => {
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en", disableRuntimeTimeout: true }));
  const delegate = vi.fn(async () => ({ success: true, text: "peer answer" }));
  let original!: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { expect(channelProfile()).toBe("gateway"); original ??= input; return { text: "draft answer" }; });
  const runtime = createCoreServiceRuntime({ busRuntime: { loadBusConfig: async () => ({ peers: "*" as const, maxDepth: 3, port: 0, secret: "fixture-secret", parallel: ["beta"], chain: [], verifier: "beta", crew: null }), delegateToInstance: delegate } });
  gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: engine } });
  const conversation = await hub.store.createConversation("owner", ["alpha"], "Bus workflows", "create");
  for (const [id, text] of [["fan", "/fan compare this"], ["ask", "/ask beta inspect this"], ["verify", "/verify check this"]]) {
    await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: id!, text: text!, attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
  }
  expect(engine).toHaveBeenCalledTimes(2); expect(delegate).toHaveBeenCalledTimes(3);
  expect(engine.mock.calls.every(([input]) => input.disableRuntimeTimeout === true)).toBe(true);
  expect(delegate).toHaveBeenNthCalledWith(1, expect.objectContaining({ targetInstance: "beta", prompt: "compare this" }));
  expect(delegate).toHaveBeenNthCalledWith(2, expect.objectContaining({ targetInstance: "beta", prompt: "inspect this" }));
  expect(delegate).toHaveBeenNthCalledWith(3, expect.objectContaining({ targetInstance: "beta", prompt: expect.stringContaining("draft answer") }));
  const messages = (await hub.store.snapshot("owner", conversation.id)).messages.filter((message) => message.authorType === "bot");
  expect(messages.map((message) => blocksText(message.blocks)).join("\n")).toContain("peer answer"); expect(messages.every((message) => message.conversationId === conversation.id)).toBe(true);
  await withChannelProfile("feishu", () => emitScopedReport(original.onEngineEvent, "bus_review", "Original bus follow-up"));
  const updated = (await hub.store.snapshot("owner", conversation.id)).messages;
  const report = updated.find(m => m.blocks.some(b => b.type === "card" && b.extra?.scopedRun))!;
  expect(report.replyTo).toBe(updated.find(m => m.clientMsgId === "fan")!.id);
  expect(blocksText(report.blocks)).toContain("Original bus follow-up"); expect(buttons(report)).toHaveLength(0);
  expect(runtime.activeRuns.size).toBe(0);
});

it("three actual cron reminders become three independent client messages and push records", async () => {
  const engine = vi.fn(async () => ({ text: "must not invoke the engine for reminders" }));
  gateway = await attachGateway({ ...options(), runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: engine } });
  const conversation = await hub.store.createConversation("owner", ["alpha"], "Reminders", "create"); const store = new CronStore(stateDir); const now = Date.now();
  await hub.store.db.run("INSERT INTO devices VALUES('device','owner','Fixture','android','fixture',0,?,?,?)", [now, now, JSON.stringify({ provider: "fcm", token: "fixture_" + "x".repeat(40) })]);
  await hub.store.db.run("INSERT INTO device_preferences VALUES('device',?)", [JSON.stringify(notificationPreferencesSchema.parse({ enabled: true }))]);
  const job = await store.add({ channel: "lark", chatId: 1, userId: 2, chatType: "private", cronExpr: "0 9 * * *", prompt: "Reminder fixture", larkChatId: conversation.id, conversationKey: `lark:${conversation.id}`, deliveryMode: "notify" });
  for (let i = 0; i < 3; i++) await gateway.runCron!(job);
  const messages = (await hub.store.snapshot("owner", conversation.id)).messages; expect(messages).toHaveLength(3); expect(new Set(messages.map((message) => message.id)).size).toBe(3);
  const pushes = await hub.store.db.all<{ payload_json: string }>("SELECT payload_json FROM push_outbox"); expect(pushes).toHaveLength(3); expect(new Set(pushes.map((row) => JSON.parse(row.payload_json).messageId)).size).toBe(3); expect(engine).not.toHaveBeenCalled();
});

it("keeps muted scheduled tasks silent even if the engine calls native file delivery", async () => {
  const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
  const artifact = path.join(workspace, "silent.txt"); await writeFile(artifact, "scheduled artifact");
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
    await input.appPlatformTools!.call({ name: "app_send_file", arguments: { path: artifact, kind: "file" }, callId: "muted-file", sessionId: "cron-thread", abortSignal: input.abortSignal! });
    return { text: "Scheduled result" };
  });
  gateway = await attachGateway({ ...options(), runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: engine } });
  const conversation = await hub.store.createConversation("owner", ["alpha"], "Silent task", "create");
  const job = await new CronStore(stateDir).add({ channel: "lark", chatId: 1, userId: 2, chatType: "private", cronExpr: "0 9 * * *", prompt: "Prepare a file silently", larkChatId: conversation.id, conversationKey: `lark:${conversation.id}`, deliveryMode: "agent", mute: true });
  await gateway.runCron!(job);
  expect(engine).toHaveBeenCalledTimes(1);
  expect(engine.mock.calls[0]![0].requestOutputDir).toBe(path.join(stateDir, "workspace", ".tarobot-out", `cron-${job.id}`));
  expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(0);
});

it("reports a real Hub upload limit as unpublished and succeeds after reducing the file", async () => {
  await hub.close(); hub = await HubServer.start({ stateDir: path.join(root, "hub"), maxFileBytes: 4 });
  const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
  const artifact = path.join(workspace, "limited.txt"); await writeFile(artifact, "too large");
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
    const call = (callId: string) => input.appPlatformTools!.call({ name: "app_send_file", arguments: { path: artifact, kind: "file" }, callId, sessionId: "limited-thread", abortSignal: input.abortSignal! });
    expect(JSON.parse((await call("large")).text)).toMatchObject({ error: "too-large", published: false, status: 413 });
    await writeFile(artifact, "ok");
    expect(JSON.parse((await call("small")).text)).toMatchObject({ delivered: true, size: 2 });
    return { text: "Sent the smaller file" };
  });
  gateway = await attachGateway({ ...options(), runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: engine } });
  const conversation = await hub.store.createConversation("owner", ["alpha"], "Limited upload", "create");
  await send(conversation.id, "Prepare a file", "question");
  const files = (await hub.store.snapshot("owner", conversation.id)).messages.flatMap((message) => message.blocks).filter((block) => block.type === "file");
  expect(files).toHaveLength(1); expect(await gateway.downloadResource(files[0]!.attachmentId)).toEqual(Buffer.from("ok"));
});

it("scheduled long answers retain Gateway instructions and never use overflow documents, including failed card delivery", async () => {
  const answer = "定时任务结果".repeat(9000) + "\nCRON-END";
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error("feishu_cli_forbidden"); });
  const runtime = createCoreServiceRuntime({ createDocument: forbidden, createChat: forbidden, detectLarkCli: forbidden });
  gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: async (input) => { expect(channelProfile()).toBe("gateway"); expect(input.instructions).toContain("TaroBird App"); expect(input.instructions).not.toContain("tarocub gdocs"); return { text: answer }; } } });
  const conversation = await hub.store.createConversation("owner", ["alpha"], "Scheduled answer", "create"); const store = new CronStore(stateDir);
  const job = await store.add({ channel: "lark", chatId: 1, userId: 2, chatType: "private", cronExpr: "0 9 * * *", prompt: "Long result", larkChatId: conversation.id, conversationKey: `lark:${conversation.id}`, deliveryMode: "agent" });
  // A lost/invalid card must fall back to native text, never a Feishu document.
  vi.spyOn(gateway, "updateCard").mockRejectedValue(new Error("fixture_card_update_failed"));
  const send = gateway.send.bind(gateway); vi.spyOn(gateway, "send").mockImplementation(async (to, content, opts) => { if (typeof content === "object" && content && "card" in content) throw new Error("fixture_card_send_failed"); return send(to, content, opts); });
  await gateway.runCron!(job); const body = (await hub.store.snapshot("owner", conversation.id)).messages.map((message) => blocksText(message.blocks)).join("\n");
  expect(body).toContain(answer); expect(forbidden).not.toHaveBeenCalled();
}, 20_000);

it("cannot route a failed or unavailable Gateway cron to the real Feishu surface", async () => {
  const store = new CronStore(stateDir); const job = await store.add({ channel: "lark", chatId: 1, userId: 2, cronExpr: "0 9 * * *", prompt: "Scheduled fixture", larkChatId: "gw_fixture", deliveryMode: "notify" });
  const send = vi.fn(async () => ({ messageId: "forbidden" })); const channel: CoreChannelLike = { send, stream: async () => ({ messageId: "forbidden" }), updateCard: async () => undefined, downloadResource: async () => Buffer.alloc(0) };
  await expect(sendCoreCronFailureNotification(channel, job, "Gateway offline")).rejects.toThrow("gateway_channel_required");
  await expect(buildCoreCronExecutor({ channel, stateDir, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "never" }) } })(job)).rejects.toThrow("gateway_channel_required");
  expect(send).not.toHaveBeenCalled();
});


it("answers a live native async question without waiting behind its own turn", async () => {
  const runtime = createCoreServiceRuntime();
  let answer!: (result: { text: string }) => void;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
    const completion = new Promise<{ text: string }>(resolve => { answer = resolve; });
    await input.onEngineEvent?.({ type: "user_input_request", toolName: "request_user_input_async", requestId: "native-question", toolInput: { questions: [{ title: "How should I handle these items?" }, { title: "Choose a color", options: ["Orange", "Blue"] }] } });
    return completion;
  });
  const steer = vi.fn<NonNullable<CoreBridgeLike["steerActiveTurn"]>>(async input => {
    expect(input.isCurrentTurn?.()).toBe(true);
    expect(input.text).toContain("Orange");
    expect(input.text).toContain("Keep the separate items");
    answer({ text: "QUESTION_OK Orange" }); return true;
  });
  gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: engine, supportsSteering: () => true, steerActiveTurn: steer } });
  const c = await hub.store.createConversation("owner", ["alpha"], "Async question", "create_async");
  await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "async_question", text: "Ask me", attachments: [] });
  await until(async () => [...runtime.pendingApprovals.values()].some(card => Boolean(card.managedCard)));
  const card = (await hub.store.snapshot("owner", c.id)).messages.find(m => buttons(m).some(b => b.name === "askq_submit"))!;
  const button = buttons(card).find(b => b.name === "askq_submit")!;
  expect(card).toBeDefined();
  const formValues = { q0_other: "Keep the separate items", q1: "0" };
  await tap(card, button, "async_answer", formValues);
  await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));
  await tap(card, button, "async_answer_duplicate", formValues);
  expect(steer).toHaveBeenCalledTimes(1); expect(engine).toHaveBeenCalledTimes(1);
  expect((await hub.store.snapshot("owner", c.id)).messages.some(m => blocksText(m.blocks).includes("QUESTION_OK Orange"))).toBe(true);
});

// Drive the real App message handler and Hub storage: an old callback must keep
// its own request; recovery without an owner must never quote the new prompt.
it("preserves Claude background report provenance through stored cards and forwarding", async () => {
  let first: ((event: EngineStreamEvent) => Promise<void> | void) | undefined;
  let calls = 0;
  const bridge: CoreBridgeLike = { handleAuthorizedMessage: async input => {
    if (++calls === 1) { first = input.onEngineEvent; return { text: "First request acknowledged" }; }
    await first?.({ type: "task_notification", origin: "bound", status: "completed", taskId: "old", text: "## Report A\n\n~~~ts\nconst answer = 42;\n~~~" });
    await input.onEngineEvent?.({ type: "task_notification", origin: "unattributed", taskId: "recovered", text: "Recovered report" });
    return { text: "Answer B" };
  } };
  const runtime = createCoreServiceRuntime();
  gateway = await attachGateway({ ...options(), bridge, runtime });
  const chat = await hub.store.createConversation("owner", ["alpha"], "Reports", "create_reports");
  await send(chat.id, "Original request A", "a");
  await until(async () => (await hub.store.snapshot("owner", chat.id)).messages.some(m => blocksText(m.blocks).includes("First request acknowledged")));
  await send(chat.id, "New request B", "b");
  await until(async () => (await hub.store.snapshot("owner", chat.id)).messages.some(m => blocksText(m.blocks).includes("Answer B")));
  const messages = (await hub.store.snapshot("owner", chat.id)).messages;
  const original = messages.find(m => m.clientMsgId === "a")!;
  const report = messages.find(m => m.blocks.some(b => b.type === "card" && backgroundTaskNotice(b)?.origin === "bound"))!;
  expect(report.replyTo).toBe(original.id);
  expect(blocksText(report.blocks)).toContain("const answer = 42;");
  expect(JSON.stringify(report.blocks)).toContain("background_context");
  const recovered = messages.find(m => m.blocks.some(b => b.type === "card" && backgroundTaskNotice(b)?.origin === "unattributed"))!;
  expect(recovered.replyTo).toBeUndefined();
  expect(blocksText(recovered.blocks)).toContain("Background task update");
  expect(blocksText(recovered.blocks)).toContain("could not be confirmed");
  const snapshot = forwardedBlocks(report.blocks, new Map());
  expect(snapshot.some(b => b.type === "card" && backgroundTaskNotice(b))).toBe(false);
  expect(blocksText(snapshot)).toContain("Report A");
  expect(JSON.stringify(snapshot)).not.toContain("background_context");
  // Invoke a retained callback from OUTSIDE the Gateway's AsyncLocalStorage
  // dispatch, as a long-lived CLI subprocess or scheduler can do later.
  await first?.({ type: "task_notification", origin: "bound", status: "completed", text: "## Late report\n\nFull **formatting**." });
  const late = (await hub.store.snapshot("owner", chat.id)).messages.find(m => blocksText(m.blocks).includes("Late report"))!;
  expect(late.blocks.some(b => b.type === "card" && backgroundTaskNotice(b)?.origin === "bound")).toBe(true);
  expect(blocksText(late.blocks)).toContain("## Late report");
});

it("persists unconfirmed delivery on a static callback report with a missing attachment", async () => {
  let callback: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0]["onEngineEvent"];
  gateway = await attachGateway({ ...options(), runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async input => { callback = input.onEngineEvent; return { text: "Started background work" }; } } });
  const chat = await hub.store.createConversation("owner", ["alpha"], "Failed artifact", "failed_artifact");
  await send(chat.id, "Prepare artifact", "start_artifact");
  await until(async () => (await hub.store.snapshot("owner", chat.id)).messages.some(message => blocksText(message.blocks).includes("Started background work")));
  await callback?.({ type: "task_notification", origin: "bound", status: "completed", text: `Final legacy artifact\n[send-file:${path.join(root, "missing.txt")}]` });
  const report = (await hub.store.snapshot("owner", chat.id)).messages.find(message => message.blocks.some(block => block.type === "card" && backgroundTaskNotice(block)));
  expect(report?.blocks.some(block => block.type === "card" && backgroundTaskNotice(block)?.delivery === "unconfirmed")).toBe(true);
});

it("stores an old callback's complete scoped review on one read-only report while a new request runs", async () => {
  let first!: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
  const review = { id: "review_origin_a", kind: "background" as const, label: "Original report" };
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) { first = input; return { text: "Original task started" }; }
    await first.onEngineEvent?.({ type: "scoped", scope: review, origin: "bound", event: { type: "tool_use", toolName: "Read", toolUseId: "read_report", toolInput: { file_path: "report.md" } } });
    await first.onEngineEvent?.({ type: "scoped", scope: review, origin: "bound", event: { type: "thinking", text: "Review evidence from original request" } });
    await input.onEngineEvent?.({ type: "assistant_text", text: "Current request answer" });
    await first.onEngineEvent?.({ type: "scoped", scope: review, origin: "bound", event: { type: "tool_result", toolUseId: "read_report", output: "Original evidence verified" } });
    await first.onEngineEvent?.({ type: "scoped", scope: review, origin: "bound", event: { type: "scope_status", status: "done" } });
    await first.onEngineEvent?.({ type: "task_notification", scopeId: review.id, origin: "bound", status: "completed", text: "Final original report" });
    return { text: "Current request answer" };
  });
  const runtime = createCoreServiceRuntime(); gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: engine } });
  const c = await hub.store.createConversation("owner", ["alpha"], "Scoped reports", "scoped_reports");
  await send(c.id, "Original request", "origin_a"); await send(c.id, "Current request", "current_b");
  const messages = (await hub.store.snapshot("owner", c.id)).messages;
  const origin = messages.find(m => m.clientMsgId === "origin_a")!;
  const reports = messages.filter(m => m.blocks.some(b => b.type === "card" && b.extra?.scopedRun));
  expect(reports).toHaveLength(1); const report = reports[0]!;
  expect(report.replyTo).toBe(origin.id); expect(blocksText(report.blocks)).toContain("Final original report"); expect(buttons(report)).toHaveLength(0);
  expect(report.blocks.some(b => b.type === "card" && b.extra?.scopedTask && (b.extra.scopedTask as { label: string }).label === review.label)).toBe(true);
  expect(report.blocks.some(b => b.type === "card" && anyRun(b)?.phase === "done")).toBe(true);
  const journal = await new RunJournal(hub.store).read("owner", report.id, 0, "", true);
  expect(journal.entries).toContainEqual(expect.objectContaining({ scope: review, text: "Review evidence from original request" }));
  expect(journal.entries).toContainEqual(expect.objectContaining({ scope: review, callId: "read_report", output: "Original evidence verified", status: "done" }));
  expect(messages.filter(m => blocksText(m.blocks).includes("Final original report"))).toHaveLength(1);
  const current = messages.find(m => blocksText(m.blocks).includes("Current request answer"))!;
  expect(JSON.stringify(await new RunJournal(hub.store).read("owner", current.id, 0, "", true))).not.toContain("Original evidence");
});

it("retains scoped process and final reports from scheduled tasks while muted runs remain silent", async () => {
  let callback: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0]["onEngineEvent"];
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { callback = input.onEngineEvent; return { text: "Scheduled task started" }; });
  gateway = await attachGateway({ ...options(), runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: engine } });
  const c = await hub.store.createConversation("owner", ["alpha"], "Scheduled scopes", "scheduled_scopes");
  const store = new CronStore(stateDir);
  const job = await store.add({ channel: "lark", chatId: 1, userId: 2, chatType: "private", cronExpr: "0 9 * * *", prompt: "Check report", larkChatId: c.id, conversationKey: `lark:${c.id}`, deliveryMode: "agent" });
  await gateway.runCron!(job);
  expect(callback).toBeTypeOf("function");
  const scope = { id: "scheduled_review", kind: "background" as const };
  await withChannelProfile("feishu", async () => {
    await callback?.({ type: "scoped", scope, origin: "bound", event: { type: "tool_use", toolName: "Read", toolUseId: "cron_read" } });
    await callback?.({ type: "scoped", scope, origin: "bound", event: { type: "scope_status", status: "done" } });
    await callback?.({ type: "task_notification", scopeId: scope.id, origin: "bound", status: "completed", text: "Scheduled final report" });
  });
  const messages = (await hub.store.snapshot("owner", c.id)).messages;
  const reports = messages.filter(m => m.blocks.some(b => b.type === "card" && b.extra?.scopedRun));
  expect(reports).toHaveLength(1); expect(blocksText(reports[0]!.blocks)).toContain("Scheduled final report");
  expect(buttons(reports[0]!)).toHaveLength(0);
  await gateway.runCron!({ ...job, mute: true });
  expect(callback).toBeUndefined();
  expect((await hub.store.snapshot("owner", c.id)).messages).toHaveLength(messages.length);
});

it("keeps an archive continuation's late scoped report on its original continuation card request", async () => {
  let origin!: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { origin = input; return { text: "Archive analysis started" }; });
  const runtime = createCoreServiceRuntime(); gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: engine } });
  const c = await hub.store.createConversation("owner", ["alpha"], "Archive scope", "archive_scope");
  const conversationKey = `lark:${c.id}`, now = new Date().toISOString(), store = new FileWorkflowStore(stateDir);
  const extractedPath = path.join(stateDir, "workspace", "archive"); await mkdir(extractedPath, { recursive: true });
  await store.append({ uploadId: "archive_scope_fixture", chatId: stableCoreNumericId(conversationKey), userId: stableCoreNumericId("user:gwuser_owner"),
    kind: "archive", status: "awaiting_continue", sourceFiles: [], derivedFiles: [], summary: "An archive with report data", extractedPath, createdAt: now, updatedAt: now });
  const sent = await gateway.send(c.id, { card: { schema: "2.0", body: { elements: [{ tag: "button", text: { tag: "plain_text", content: "Continue Analysis" }, value: {
    cctb_lark: "continue_archive", conversationKey, bridgeChatType: "private", uploadId: "archive_scope_fixture",
  } }] } } });
  const card = (await hub.store.snapshot("owner", c.id)).messages.find(m => m.id === sent.messageId)!;
  await tap(card, buttons(card)[0]!, "archive_continue");
  await until(async () => engine.mock.calls.length === 1 && !runtime.chatQueue.isBusy(conversationKey));
  expect(origin.requestOutputDir).toBe(path.join(stateDir, "workspace", ".tarobot-out", card.id));
  expect((await store.find("archive_scope_fixture"))?.status).toBe("completed");
  await withChannelProfile("feishu", () => emitScopedReport(origin.onEngineEvent, "archive_review", "Archive background report"));
  const reports = (await hub.store.snapshot("owner", c.id)).messages.filter(m => m.blocks.some(b => b.type === "card" && b.extra?.scopedRun));
  expect(reports).toHaveLength(1); expect(reports[0]!.replyTo).toBe(card.id);
  expect(blocksText(reports[0]!.blocks)).toContain("Archive background report"); expect(buttons(reports[0]!)).toHaveLength(0);
  expect(runtime.activeRuns.size).toBe(0);
});

it("closes a message callback's process card when final report delivery throws", async () => {
  let origin!: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { origin = input; return { text: "Report started" }; });
  const runtime = createCoreServiceRuntime(); gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: engine } });
  const c = await hub.store.createConversation("owner", ["alpha"], "Failed scoped delivery", "failed_scoped_delivery");
  await send(c.id, "Start report", "start_failed_report");
  const scope = { id: "failed_delivery_review", kind: "background" as const };
  await origin.onEngineEvent?.({ type: "scoped", scope, origin: "bound", event: { type: "scope_status", status: "running" } });
  await origin.onEngineEvent?.({ type: "scoped", scope, origin: "bound", event: { type: "scope_status", status: "done" } });
  const failedDelivery = vi.spyOn(delivery, "deliverCoreResponse").mockRejectedValueOnce(new Error("final delivery unavailable"));
  try {
    await origin.onEngineEvent?.({ type: "task_notification", scopeId: scope.id, origin: "bound", status: "completed", text: "Unavailable final report" });
    const reports = (await hub.store.snapshot("owner", c.id)).messages.filter(m => m.blocks.some(b => b.type === "card" && b.extra?.scopedRun));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.blocks.some(b => b.type === "card" && anyRun(b)?.phase === "partial")).toBe(true);
    expect(blocksText(reports[0]!.blocks)).toContain("could not be fully delivered");
    expect(blocksText(reports[0]!.blocks)).not.toContain("Unavailable final report");
  } finally { failedDelivery.mockRestore(); }
});
