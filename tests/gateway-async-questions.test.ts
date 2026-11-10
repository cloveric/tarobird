import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blocksText, type CardElement, type Message } from "../src/client-protocol/index.js";
import { attachGateway } from "../src/gateway/service.js";
import { gatewayActiveWorkCount, gatewayDrainBlockers } from "../src/gateway/activity.js";
import { UsageStore } from "../src/state/usage-store.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { EngineSteeringRejectedError } from "../src/codex/adapter.js";
import { normalizeAsyncUserInput } from "../src/core/async-user-input.js";
import { CoreGoalRunController } from "../src/core/bus.js";
import { nativeRun, isRunActive } from "../src/client-protocol/run.js";

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

const questionEvent = { type: "user_input_request" as const, toolName: "request_user_input_async" as const, requestId: "native_question", toolInput: { questions: [{ title: "How should I group the items?", options: null }, { title: "Choose a format", options: ["Table", "List"] }] } };
const answers = { q0_other: "Separate the uncertain items", q1: "0" };

it("preserves the configured runtime timeout policy on an answer follow-up", async () => {
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en", disableRuntimeTimeout: true }));
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) await input.onEngineEvent?.(questionEvent);
    return { text: "Completed" };
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id);
  await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));
  await tap(first.message, first.button, "timeout_policy_answer", answers);
  await until(async () => engine.mock.calls.length === 2 && !runtime.chatQueue.isBusy(`lark:${c.id}`));
  expect(engine.mock.calls.map(([input]) => input.disableRuntimeTimeout)).toEqual([true, true]);
});

it("cancels only a queued answer from its submitted receipt and retains the answers", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) await input.onEngineEvent?.(questionEvent);
    return { text: "Completed" };
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`;
  await until(async () => !runtime.chatQueue.isBusy(key));
  let release!: () => void, ordinaryRan = false;
  const blocker = runtime.chatQueue.enqueue(key, () => new Promise<void>(resolve => { release = resolve; }));
  await until(async () => !!release);
  let ordinary: Promise<void> | undefined;
  try {
    await tap(first.message, first.button, "queued_answer_receipt", answers);
    ordinary = runtime.chatQueue.enqueue(key, async () => { ordinaryRan = true; });
    await until(async () => blocksText((await hub.store.messageForUser("owner", first.message.id)).blocks).includes("Answer queued"));
    const receipt = await hub.store.messageForUser("owner", first.message.id);
    const cancel = buttons(receipt).find(button => typeof button.value?.taskId === "string");
    expect(cancel, "a submitted but queued answer must offer scoped cancellation").toBeDefined();
    await tap(receipt, cancel!, "cancel_queued_answer");
    await tap(receipt, cancel!, "cancel_queued_answer_again");
    await until(async () => blocksText((await hub.store.messageForUser("owner", first.message.id)).blocks).includes("Follow-up stopped"));
    const kept = await hub.store.messageForUser("owner", first.message.id);
    expect(blocksText(kept.blocks)).toContain("Separate the uncertain items");
    expect(buttons(kept)).toHaveLength(0);
    expect(ordinaryRan).toBe(false);
    release(); await blocker; await ordinary;
    await until(async () => !runtime.chatQueue.isBusy(key));
    expect(engine).toHaveBeenCalledTimes(1);
    expect(ordinaryRan).toBe(true);
    expect(runtime.cancelledQueueTaskIds.size).toBe(0);
    expect(runtime.queueCards.size).toBe(0);
    const timeline = (await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(timeline.filter(event => event.type === "turn.completed" && event.metadata?.taskId === cancel!.value!.taskId)).toEqual([
      expect.objectContaining({ outcome: "skipped", detail: "queued answer cancelled by user", metadata: expect.objectContaining({ action: "choice", phase: "queue" }) }),
    ]);
  } finally { release(); await blocker; await ordinary; await until(async () => !runtime.chatQueue.isBusy(key)); }
});

it("does not stop a running follow-up when an old queued cancel button is clicked", async () => {
  let finish!: () => void;
  let activeSignal: AbortSignal | undefined;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) { await input.onEngineEvent?.(questionEvent); return { text: "Completed" }; }
    activeSignal = input.abortSignal;
    return new Promise(resolve => { finish = () => resolve({ text: "Follow-up complete" }); });
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`;
  await until(async () => !runtime.chatQueue.isBusy(key));
  let release!: () => void;
  const blocker = runtime.chatQueue.enqueue(key, () => new Promise<void>(resolve => { release = resolve; }));
  await until(async () => !!release);
  try {
    await tap(first.message, first.button, "queue_then_run", answers);
    await until(async () => buttons(await hub.store.messageForUser("owner", first.message.id)).some(b => typeof b.value?.taskId === "string"));
    const receipt = await hub.store.messageForUser("owner", first.message.id);
    const cancel = buttons(receipt).find(b => typeof b.value?.taskId === "string")!;
    release(); await blocker; await until(async () => !!finish);
    await tap(receipt, cancel, "stale_cancel");
    expect(activeSignal?.aborted).toBe(false);
    finish(); await until(async () => !runtime.chatQueue.isBusy(key));
    expect(runtime.queueCards.size).toBe(0);
  } finally { release(); finish?.(); await blocker; await until(async () => !runtime.chatQueue.isBusy(key)); }
});

it("keeps Gateway answers in order even if the optional transport requests preempt mode", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) await input.onEngineEvent?.(questionEvent);
    return { text: "Completed" };
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`;
  await until(async () => !runtime.chatQueue.isBusy(key));
  let release!: () => void;
  const blocker = runtime.chatQueue.enqueue(key, () => new Promise<void>(resolve => { release = resolve; }));
  await until(async () => !!release);
  try {
    await tap(first.message, first.button, "answer_before_preempt", answers);
    runtime.queuePolicy.preempt = true;
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "preempt_answer", text: "Use the new request instead", attachments: [] });
    await until(async () => runtime.chatQueue.pendingCount(key) >= 2);
    release(); await blocker; await until(async () => !runtime.chatQueue.isBusy(key));
    expect(engine).toHaveBeenCalledTimes(3);
    expect(engine.mock.calls[1]![0].text).toContain("User answers to request_user_input_async");
    expect(engine.mock.calls[2]![0].text).toContain("Use the new request instead");
    expect(blocksText((await hub.store.messageForUser("owner", first.message.id)).blocks)).toContain("Follow-up reply generated");
    expect(runtime.queueCards.size).toBe(0);
    expect(runtime.cancelledQueueTaskIds.size).toBe(0);
  } finally { release(); await blocker; await until(async () => !runtime.chatQueue.isBusy(key)); }
});

const runOf = (message: Message) => message.blocks.flatMap(block => block.type === "card" && nativeRun(block) ? [nativeRun(block)!] : [])[0];
async function form(c: string, except?: string) {
  let message: Message | undefined;
  await until(async () => { message = (await hub.store.snapshot("owner", c)).messages.find(m => m.id !== except && buttons(m).some(b => b.name === "askq_submit")); return !!message; });
  return { message: message!, button: buttons(message!).find(b => b.name === "askq_submit")! };
}
async function start(bridge: CoreBridgeLike, beforeSend?: (runtime: ReturnType<typeof createCoreServiceRuntime>, conversationId: string) => void, firstMessage = "Ask") {
  const runtime = createCoreServiceRuntime(); gateway = await attachGateway({ ...options(), runtime, bridge });
  const c = await hub.store.createConversation("owner", ["alpha"], "Async fixture", "create_async");
  beforeSend?.(runtime, c.id);
  await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "ask", text: firstMessage, attachments: [] });
  return { runtime, c };
}
function waitForAbort(input: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0]) {
  return new Promise<{ text: string }>(resolve => { if (input.abortSignal?.aborted) resolve({ text: "stopped" }); else input.abortSignal?.addEventListener("abort", () => resolve({ text: "stopped" }), { once: true }); });
}

it("keeps a signed Bot task queued and never treats its text as an async question answer", async () => {
  let finish!: (result: { text: string }) => void;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) {
      // The Hub can expose the question before its publication response has
      // returned. Install the completion handle before making the card visible.
      const completion = new Promise<{ text: string }>(resolve => { finish = resolve; });
      await input.onEngineEvent?.(questionEvent);
      return completion;
    }
    expect(input.text).toContain("Table");
    return { text: "Bot task processed" };
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), before = JSON.stringify((await hub.store.messageForUser("owner", first.message.id)).blocks);
  const pending = runtime.pendingApprovals.size;
  const receipt = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "bot_queue", text: "Table", attachments: [],
    botSource: { hostId: "hub_fixture", hostName: "Other computer", botId: "other_bot", botName: "Other Bot", requestId: "request", hops: 1 } });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(engine).toHaveBeenCalledTimes(1); expect(runtime.pendingApprovals.size).toBe(pending);
  expect(JSON.stringify((await hub.store.messageForUser("owner", first.message.id)).blocks)).toBe(before);
  finish({ text: "Origin complete" });
  await until(async () => engine.mock.calls.length === 2 && (await hub.store.pendingForBot("alpha")).length === 0);
  expect(runtime.pendingApprovals.size).toBe(pending);
  expect((await hub.store.messageForBot("alpha", receipt.message.id)).botSource?.hops).toBe(1);
  expect(engine.mock.calls[0]![0].turnInstructions).not.toContain("Cross-Bot request for THIS turn");
  const instructions = engine.mock.calls[1]![0].turnInstructions;
  expect(instructions).toContain("Cross-Bot request for THIS turn");
  expect(instructions).toContain('"hostId":"hub_fixture"');
  expect(instructions).toContain('"botId":"other_bot"');
  expect(instructions).toContain('"hops":1');
  expect(instructions).toContain("Reply in this conversation");
  expect(instructions).toContain("Do not also send results or progress");
  expect(instructions).toContain("Interrupted turns are reported as failed");
  expect(engine.mock.calls[0]![0].turnInstructions).not.toContain("Reply in this conversation");
});

it("keeps owner attachment attribution with batching configured when a Bot task arrives", async () => {
  let release!: () => void;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => { if (engine.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; }); return { text: "Done" }; });
  const runtime = createCoreServiceRuntime({ queuePolicy: { batchWindowMs: 1000 } });
  gateway = await attachGateway({ ...options(), runtime, bridge: { handleAuthorizedMessage: engine } });
  const c = await hub.store.createConversation("owner", ["alpha"], "Attribution race", "race");
  const bytes = Buffer.from("Owner attachment");
  const file = await hub.attachments.create("owner", { conversationId: c.id, name: "owner.txt", mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  await hub.attachments.putChunk("owner", file.id, 0, bytes); await hub.attachments.complete("owner", file.id);
  const owner = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "owner_attachment", text: "Read my attachment", attachments: [file.id] });
  await until(async () => !!release);
  const bot = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "bot_after_attachment", text: "Independent Bot task", attachments: [],
    botSource: { hostId: "hub_fixture", hostName: "Other computer", botId: "other_bot", botName: "Other Bot", requestId: "race", hops: 1 } });
  release();
  await until(async () => engine.mock.calls.length === 2 && (await hub.store.pendingForBot("alpha")).length === 0);
  expect(engine.mock.calls[0]![0].text).toContain("Read my attachment");
  expect(engine.mock.calls[0]![0].turnInstructions).not.toContain("Cross-Bot request for THIS turn");
  expect(engine.mock.calls[0]![0].turnInstructions).toContain(`--context-message ${owner.message.id}`);
  expect(engine.mock.calls[1]![0].turnInstructions).toContain("Cross-Bot request for THIS turn");
  expect(engine.mock.calls[1]![0].turnInstructions).toContain(`--context-message ${bot.message.id}`);
}, 15_000);

it("normalizes free text, every option and repeated prompts without losing answers", () => {
  const result = normalizeAsyncUserInput({ questions: [{ title: "Same?" }, { title: "Same?", options: ["One", { label: "Two", description: "Second" }] }] }, "zh");
  expect(result.questions.map(q => q.question)).toEqual(["Same?", "Same? (2)"]);
  expect(result.questions.every(q => q.allowFreeText)).toBe(true);
  expect(() => normalizeAsyncUserInput({ questions: [{ title: "Valid" }, {}] }, "zh")).toThrow();
  expect(() => normalizeAsyncUserInput({ questions: [] }, "zh")).toThrow();
});

it("deduplicates native events and admits one completed-origin answer with a subsequent question", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) {
      await Promise.all([input.onEngineEvent?.(questionEvent), input.onEngineEvent?.(questionEvent)]);
      return { text: "Continue independently" };
    }
    expect(input.text).toContain("Separate the uncertain items"); expect(input.text).toContain("Table");
    await input.onEngineEvent?.({ ...questionEvent, requestId: "second_question", toolInput: { questions: [{ title: "Another detail?" }] } });
    return { text: "Follow-up started" };
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));
  const first = await form(c.id); await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`)); expect(runtime.pendingApprovals.size).toBe(1);
  await Promise.all([tap(first.message, first.button, "answer_a", answers), tap(first.message, first.button, "answer_b", answers)]);
  await until(async () => engine.mock.calls.length === 2 && !runtime.chatQueue.isBusy(`lark:${c.id}`));
  expect(engine).toHaveBeenCalledTimes(2); expect(runtime.pendingApprovals.size).toBe(1);
  await until(async () => blocksText((await hub.store.messageForUser("owner", first.message.id)).blocks).includes("Follow-up reply generated"));
  const next = await form(c.id, first.message.id); expect(blocksText(next.message.blocks)).toContain("Another detail?");
  expect(await gateway!.onCall!("stop", { conversationId: c.id })).toEqual({ stopped: true });
  const timeline = (await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(timeline.find(event => event.metadata?.source === "gateway.stop")).toMatchObject({ outcome: "success", metadata: { cancelledQuestions: 1 } });
  await until(async () => runtime.pendingApprovals.size === 0);
  await tap(next.message, next.button, "late_answer", { q0_other: "Too late" }); expect(engine).toHaveBeenCalledTimes(2);
});

it.each(["finished", "stopped", "failed"])("shows a live answer follow-up and settles its run card on %s", async outcome => {
  let finish!: (result: { text: string }) => void, fail!: (error: Error) => void;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) { await input.onEngineEvent?.(questionEvent); return { text: "Origin completed" }; }
    await input.onEngineEvent?.({ type: "assistant_text", text: "Checking the follow-up now" });
    await input.onEngineEvent?.({ type: "tool_use", toolName: "Read", toolUseId: "followup_read", toolInput: { path: "fixture.txt" } });
    return new Promise((resolve, reject) => {
      finish = resolve; fail = reject;
      input.abortSignal?.addEventListener("abort", () => resolve({ text: "stopped" }), { once: true });
    });
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`;
  await until(async () => !runtime.chatQueue.isBusy(key));
  try {
    await tap(first.message, first.button, "visible_followup", answers);
    await until(async () => !!finish);
    const live = (await hub.store.snapshot("owner", c.id)).messages.find(m => m.replyTo === first.message.id && runOf(m));
    expect(live, "a submitted answer must expose its running work before the final reply").toBeDefined();
    await until(async () => runOf(await hub.store.messageForUser("owner", live!.id))?.current?.name === "Read");
    expect(isRunActive(runOf(await hub.store.messageForUser("owner", live!.id))!.phase)).toBe(true);
    if (outcome === "stopped") await gateway!.onCall!("stop", { conversationId: c.id });
    else if (outcome === "failed") fail(new Error("fixture failure"));
    else finish({ text: "Visible follow-up result" });
    await until(async () => !runtime.chatQueue.isBusy(key));
    const final = await hub.store.messageForUser("owner", live!.id);
    expect(isRunActive(runOf(final)!.phase)).toBe(false);
    expect(runOf(final)!.phase).toBe(outcome === "finished" ? "done" : outcome === "stopped" ? "stopped" : "error");
    const replies = (await hub.store.snapshot("owner", c.id)).messages.filter(m => m.replyTo === first.message.id && blocksText(m.blocks).includes("Visible follow-up result"));
    if (outcome === "finished") expect(replies.map(m => m.id)).toEqual([live!.id]);
  } finally { finish?.({ text: "cleanup" }); }
});

it("keeps the first waiting prompt editable behind a question follow-up and executes the revised order once", async () => {
  let finish!: (result: { text: string }) => void;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) { await input.onEngineEvent?.(questionEvent); return { text: "Origin completed" }; }
    if (engine.mock.calls.length === 2) return new Promise(resolve => { finish = resolve; });
    return { text: "Next input completed" };
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`, queue = new HubPromptQueue(hub.store);
  await until(async () => !runtime.chatQueue.isBusy(key));
  try {
    await tap(first.message, first.button, "editable_followup", answers);
    await until(async () => !!finish);
    const a = (await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "first_waiting", text: "First waiting", attachments: [] })).message;
    const b = (await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "second_waiting", text: "Second waiting", attachments: [] })).message;
    // Allow the actual Hub/Gateway dispatch path to settle while the answer runs.
    await new Promise(resolve => setTimeout(resolve, 150));
    const snapshot = await queue.read("owner", "alpha", c.id);
    expect(snapshot.items.map(item => [item.message.id, item.state, item.canEdit, item.canMove, item.canCancel])).toEqual([
      [a.id, "queued", true, true, true], [b.id, "queued", true, true, true],
    ]);
    const changed = await queue.mutate("owner", c.id, { botId: "alpha", requestId: "move_first_waiting", revision: snapshot.revision, action: { type: "move", messageId: a.id, beforeId: null } });
    await queue.mutate("owner", c.id, { botId: "alpha", requestId: "edit_first_waiting", revision: changed.revision, action: { type: "edit", messageId: a.id, text: "Revised first waiting" } });
    expect((await hub.store.snapshot("owner", c.id)).messages.filter(m => m.replyTo === a.id || m.replyTo === b.id)).toEqual([]);
    finish({ text: "Follow-up complete" });
    await until(async () => engine.mock.calls.length === 4 && !runtime.chatQueue.isBusy(key));
    expect(engine.mock.calls.slice(2).map(([input]) => input.text)).toEqual(["Second waiting", "Revised first waiting"]);
    expect((await queue.read("owner", "alpha", c.id)).items).toEqual([]);
  } finally { finish?.({ text: "cleanup" }); }
});

it("leaves a reserved prompt editable through Host drain and resumes it once", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: "Completed" }));
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const key = `lark:${c.id}`, queue = new HubPromptQueue(hub.store);
  await until(async () => engine.mock.calls.length === 1 && !runtime.chatQueue.isBusy(key));
  let release!: () => void;
  const held = runtime.chatQueue.enqueue(key, () => new Promise<void>(resolve => { release = resolve; }));
  await until(async () => !!release);
  const next = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "drain_pull", text: "Wait through drain", attachments: [] });
  await until(async () => runtime.chatQueue.pendingCount(key) > 0);
  const drain = vi.spyOn(hub, "hostDrainStatus").mockReturnValue({ draining: true, drained: false });
  try {
    release(); await held; await until(async () => !runtime.chatQueue.isBusy(key));
    expect((await queue.read("owner", "alpha", c.id)).items[0]).toMatchObject({ message: { id: next.message.id }, state: "queued", canEdit: true });
    expect(engine).toHaveBeenCalledTimes(1);
    drain.mockRestore(); await hub.cancelHostDrain();
    await until(async () => engine.mock.calls.length === 2 && !runtime.chatQueue.isBusy(key));
    expect(engine.mock.calls[1]![0].text).toBe("Wait through drain");
  } finally { release(); drain.mockRestore(); }
});

it("recovers a lost pull response through delivery replay and executes the claimed input once", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: "Completed" }));
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  await until(async () => engine.mock.calls.length === 1 && !runtime.chatQueue.isBusy(`lark:${c.id}`));
  let dropped = false;
  const sendFrame = (hub as any).send.bind(hub);
  const wire = vi.spyOn(hub as any, "send").mockImplementation(async (...args: any[]) => {
    const [socket, frame] = args;
    if (!dropped && frame.type === "instance.result" && frame.id.startsWith("pull_") && frame.result?.message) {
      dropped = true; socket.terminate(); return;
    }
    return sendFrame(...args);
  });
  try {
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "lost_pull", text: "Recover this claim once", attachments: [] });
    await until(async () => dropped && engine.mock.calls.length === 2 && (await hub.store.pendingForBot("alpha")).length === 0 && !runtime.chatQueue.isBusy(`lark:${c.id}`));
    expect(engine.mock.calls.map(([input]) => input.text)).toEqual(["Ask", "Recover this claim once"]);
  } finally { wire.mockRestore(); }
});

it.each([false, true])("keeps waiting input in the unified pending queue behind an answer (cancel=%s)", async cancel => {
  let finish!: (result: { text: string }) => void;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) { await input.onEngineEvent?.(questionEvent); return { text: "Origin completed" }; }
    if (engine.mock.calls.length === 2) return new Promise(resolve => { finish = resolve; });
    return { text: "Next input completed" };
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`, queue = new HubPromptQueue(hub.store);
  await until(async () => !runtime.chatQueue.isBusy(key));
  try {
    await tap(first.message, first.button, "ordered_followup", answers);
    await until(async () => !!finish);
    const next = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "next", text: "Next ordinary input", attachments: [] });
    await until(async () => runtime.chatQueue.pendingCount(key) > 0);
    const snapshot = await queue.read("owner", "alpha", c.id);
    expect(snapshot.items[0]).toMatchObject({ message: { id: next.message.id }, state: "queued", canCancel: true });
    expect((await hub.store.snapshot("owner", c.id)).messages.filter(m => m.replyTo === next.message.id)).toEqual([]);
    if (cancel) {
      const mutation = { botId: "alpha", requestId: "cancel_unified", revision: snapshot.revision, action: { type: "cancel" as const, messageId: next.message.id } };
      await queue.mutate("owner", c.id, mutation);
      await queue.mutate("owner", c.id, mutation);
      expect(runtime.activeRuns.get(key)?.abortController.signal.aborted).toBe(false);
    }
    finish({ text: "Follow-up complete" });
    await until(async () => engine.mock.calls.length === (cancel ? 2 : 3) && !runtime.chatQueue.isBusy(key));
    expect((await queue.read("owner", "alpha", c.id)).items).toEqual([]);
    const replies = (await hub.store.snapshot("owner", c.id)).messages.filter(m => m.replyTo === next.message.id);
    expect(replies).toHaveLength(cancel ? 0 : 1);
    if (!cancel) expect(blocksText(replies[0]!.blocks)).toContain("Next input completed");
  } finally { finish?.({ text: "cleanup" }); }
});

it("retains a waiting attachment in the editable queue until preparation starts", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: "Completed" }));
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const key = `lark:${c.id}`, queue = new HubPromptQueue(hub.store);
  await until(async () => engine.mock.calls.length === 1 && !runtime.chatQueue.isBusy(key));
  let release!: () => void, finishDownload!: (bytes: Buffer) => void;
  const held = runtime.chatQueue.enqueue(key, () => new Promise<void>(resolve => { release = resolve; }));
  await until(async () => !!release);
  const download = vi.spyOn(gateway!, "downloadResource").mockImplementation(() => new Promise(resolve => { finishDownload = resolve; }));
  await hub.store.db.run("INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES('queue_file',?,'owner','fixture',5,'text/plain','notes.txt','fixture',1,0)", [c.id]);
  try {
    const sent = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "with_file", text: "Read notes", attachments: ["queue_file"] });
    await until(async () => runtime.chatQueue.pendingCount(key) > 0);
    expect((await queue.read("owner", "alpha", c.id)).items[0]).toMatchObject({ state: "queued", canEdit: true });
    expect(runtime.queueCards.size).toBe(0);
    release(); await held; await until(async () => !!finishDownload);
    expect((await queue.read("owner", "alpha", c.id)).items[0]).toMatchObject({ state: "dispatched", canEdit: false });
    finishDownload(Buffer.from("hello"));
    await until(async () => engine.mock.calls.length === 2 && !runtime.chatQueue.isBusy(key));
    const completed = (await hub.store.snapshot("owner", c.id)).messages.find(m => m.replyTo === sent.message.id)!;
    expect(runOf(completed)?.phase).toBe("done");
    expect(JSON.stringify(completed.blocks)).not.toContain('"appQueue"');
  } finally { release(); finishDownload?.(Buffer.from("hello")); download.mockRestore(); }
});

it("does not leak a queue card when malformed config falls back before the run starts", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: "Completed" }));
  const { runtime, c } = await start({ handleAuthorizedMessage: engine }); const key = `lark:${c.id}`;
  await until(async () => engine.mock.calls.length === 1 && !runtime.chatQueue.isBusy(key));
  const enqueue = runtime.chatQueue.enqueue.bind(runtime.chatQueue);
  vi.spyOn(runtime.chatQueue, "enqueue").mockImplementation((chat, job, options) => enqueue(chat, job, { ...options, waitNotifyAfterMs: 0 }));
  let release!: () => void;
  const held = runtime.chatQueue.enqueue(key, () => new Promise<void>(resolve => { release = resolve; }));
  await until(async () => !!release);
  try {
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "config_failure", text: "Read", attachments: [] });
    await until(async () => runtime.chatQueue.pendingCount(key) > 0);
    expect(runtime.queueCards.size).toBe(0);
    await writeFile(path.join(stateDir, "config.json"), "{invalid json");
    release(); await held; await until(async () => !runtime.chatQueue.isBusy(key));
    expect(engine).toHaveBeenCalledTimes(2);
    expect(runtime.queueCards.size).toBe(0);
    expect(gatewayDrainBlockers(runtime, "alpha").some(b => b.type === "queue")).toBe(false);
  } finally { release(); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" })); vi.restoreAllMocks(); }
});

it("does not start an answer engine after stop races with run-card publication", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { await input.onEngineEvent?.(questionEvent); return { text: "Origin completed" }; });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`;
  await until(async () => !runtime.chatQueue.isBusy(key));
  let release!: () => void, creating = false;
  const held = new Promise<void>(resolve => { release = resolve; }), send = gateway!.send.bind(gateway);
  const spy = vi.spyOn(gateway!, "send").mockImplementation(async (to, body, options) => {
    if (options?.replyTo === first.message.id && typeof body === "object" && "card" in body) { creating = true; await held; }
    return send(to, body, options);
  });
  try {
    await tap(first.message, first.button, "stop_during_presentation", answers);
    await until(async () => creating);
    await gateway!.onCall!("stop", { conversationId: c.id }); release();
    await until(async () => !runtime.chatQueue.isBusy(key));
    expect(engine).toHaveBeenCalledTimes(1);
    const live = (await hub.store.snapshot("owner", c.id)).messages.find(m => m.replyTo === first.message.id && runOf(m));
    expect(runOf(live!)?.phase).toBe("stopped");
    await until(async () => blocksText((await hub.store.messageForUser("owner", first.message.id)).blocks).includes("Follow-up stopped"));
  } finally { release(); spy.mockRestore(); }
});

it.each([false, true])("keeps follow-up text and reports file delivery truthfully (missing=%s)", async missing => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) { await input.onEngineEvent?.(questionEvent); return { text: "Origin completed" }; }
    const file = path.join(input.requestOutputDir!, "answer.txt");
    if (!missing) await writeFile(file, "verified answer file");
    return { text: `Here is the answer file.\n[send-file:${file}]` };
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`;
  await until(async () => !runtime.chatQueue.isBusy(key));
  await tap(first.message, first.button, "answer_file", answers);
  await until(async () => engine.mock.calls.length === 2 && !runtime.chatQueue.isBusy(key));
  const messages = (await hub.store.snapshot("owner", c.id)).messages;
  const reply = messages.find(m => m.replyTo === first.message.id && runOf(m));
  expect(blocksText(reply!.blocks)).toContain("Here is the answer file.");
  expect(runOf(reply!)?.phase).toBe(missing ? "error" : "done");
  const files = messages.flatMap(m => m.blocks).filter(b => b.type === "file");
  expect(files).toHaveLength(missing ? 0 : 1);
  if (!missing) expect(await gateway!.downloadResource(files[0]!.attachmentId)).toEqual(Buffer.from("verified answer file"));
  await until(async () => blocksText((await hub.store.messageForUser("owner", first.message.id)).blocks).includes(missing ? "Follow-up failed" : "Follow-up reply generated"));
});

it.each(["finished", "stopped", "failed", "skipped"])("updates the same queued answer receipt through %s without a duplicate answer", async outcome => {
  let finishOther!: (result: { text: string }) => void;
  let finishAnswer!: (result: { text: string }) => void;
  let failAnswer!: (error: Error) => void;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) { await input.onEngineEvent?.(questionEvent); return { text: "Origin completed" }; }
    return new Promise((resolve, reject) => {
      if (engine.mock.calls.length === 2) finishOther = resolve;
      else { finishAnswer = resolve; failAnswer = reject; }
      input.abortSignal?.addEventListener("abort", () => resolve({ text: "stopped" }), { once: true });
    });
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`;
  const read = async () => hub.store.messageForUser("owner", first.message.id);
  await until(async () => !runtime.chatQueue.isBusy(key));
  await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "other", text: "Separate task", attachments: [] });
  await until(async () => !!finishOther);
  try {
    await tap(first.message, first.button, "queued_answer", answers);
    await until(async () => blocksText((await read()).blocks).includes("Answer queued"));
    expect(gatewayActiveWorkCount(runtime)).toBeGreaterThan(0);
    expect(gatewayDrainBlockers(runtime, "alpha")).toContainEqual({ botId: "alpha", type: "queue", count: 1, conversationKey: key });
    expect(buttons(await read())).toHaveLength(1);
    expect(buttons(await read())[0]!.value?.taskId).toMatch(/^answer:/);
    expect(blocksText((await read()).blocks)).toContain(answers.q0_other);
    if (outcome === "skipped") gateway!.canSteerConversation = async () => false;
    finishOther({ text: "Separate task completed" });
    if (outcome !== "skipped") {
      await until(async () => blocksText((await read()).blocks).includes("Processing your answer"));
      await until(async () => !!finishAnswer);
      if (outcome === "stopped") await gateway!.onCall!("stop", { conversationId: c.id });
      else if (outcome === "failed") failAnswer(new Error("fixture failure"));
      else finishAnswer({ text: "Answer follow-up result" });
    }
    const label = { finished: "Follow-up reply generated", stopped: "Follow-up stopped", failed: "Follow-up failed", skipped: "Queued answer not delivered" }[outcome]!;
    await until(async () => blocksText((await read()).blocks).includes(label));
    await until(async () => !runtime.chatQueue.isBusy(key));
    await tap(first.message, first.button, "duplicate_answer", answers);
    expect(engine).toHaveBeenCalledTimes(outcome === "skipped" ? 2 : 3);
    expect(blocksText((await read()).blocks)).toContain(label);
  } finally { finishOther?.({ text: "cleanup" }); finishAnswer?.({ text: "cleanup" }); }
});

it.each(["queued", "processing"])("recovers an async answer left %s by worker shutdown without executing it again", async phase => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) { await input.onEngineEvent?.(questionEvent); return { text: "Origin completed" }; }
    return waitForAbort(input);
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`;
  await until(async () => !runtime.chatQueue.isBusy(key));
  if (phase === "queued") {
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "other", text: "Separate task", attachments: [] });
    await until(async () => engine.mock.calls.length === 2);
  }
  await tap(first.message, first.button, "answer_before_restart", answers);
  const label = phase === "queued" ? "Answer queued" : "Processing your answer";
  await until(async () => blocksText((await hub.store.messageForUser("owner", first.message.id)).blocks).includes(label));
  await gateway!.disconnect(); gateway = undefined;
  await until(async () => !runtime.chatQueue.isBusy(key));
  const afterRestart = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: "Must not rerun" }));
  gateway = await attachGateway({ ...options(), runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: afterRestart } });
  await until(async () => blocksText((await hub.store.messageForUser("owner", first.message.id)).blocks).includes("Follow-up interrupted."));
  const recovered = await hub.store.messageForUser("owner", first.message.id);
  expect(blocksText(recovered.blocks)).toContain(answers.q0_other);
  expect(recovered.status).toBe("error"); expect(buttons(recovered)).toHaveLength(0);
  expect(afterRestart).not.toHaveBeenCalled();
});

it("closes the receipt when budget enforcement blocks the answer before execution", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { await input.onEngineEvent?.(questionEvent); return { text: "Origin completed" }; });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id);
  await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en", budgetUsd: 1 }));
  await new UsageStore(stateDir).record({ inputTokens: 1, outputTokens: 1, costUsd: 2 });
  await tap(first.message, first.button, "blocked_answer", answers);
  await until(async () => blocksText((await hub.store.messageForUser("owner", first.message.id)).blocks).includes("Follow-up could not start"));
  expect(engine).toHaveBeenCalledTimes(1);
});

it.each(["missing-handle", "failed-update"])("keeps the fallback submission receipt truthful after %s", async mode => {
  let finish!: (result: { text: string }) => void;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length === 1) { await input.onEngineEvent?.(questionEvent); return { text: "Origin completed" }; }
    return new Promise(resolve => { finish = resolve; input.abortSignal?.addEventListener("abort", () => resolve({ text: "stopped" }), { once: true }); });
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id), key = `lark:${c.id}`;
  await until(async () => !runtime.chatQueue.isBusy(key));
  if (mode === "missing-handle") [...runtime.pendingApprovals.values()][0]!.managedCard = undefined;
  else vi.spyOn(gateway!, "updateCard").mockRejectedValueOnce(new Error("fixture update failure"));
  try {
    await tap(first.message, first.button, "fallback_answer", answers);
    let receipt: Message | undefined;
    await until(async () => {
      receipt = (await hub.store.snapshot("owner", c.id)).messages.find(m => m.id !== first.message.id && blocksText(m.blocks).includes("Answer received; no need to submit again"));
      return !!receipt && !!finish;
    });
    finish({ text: "Follow-up completed" });
    await until(async () => !runtime.chatQueue.isBusy(key));
    expect(receipt!.blocks.some(b => b.type === "card" && b.extra?.answerFollowup)).toBe(false);
    await hub.store.recoverOrphanRuns("alpha", Date.now() + 1);
    expect(await hub.store.messageForUser("owner", receipt!.id)).toEqual(receipt);
    expect((await hub.store.messageForUser("owner", first.message.id)).status).toBe("deleted");
  } finally { finish?.({ text: "cleanup" }); }
});

it("keeps answer setup in drain accounting before it has an active run slot", async () => {
  const runtime = createCoreServiceRuntime(), key = "lark:gw_setup";
  let release!: () => void;
  const job = runtime.chatQueue.enqueue(key, () => new Promise<void>(resolve => { release = resolve; }));
  await until(async () => !!release);
  expect(runtime.activeRuns.size).toBe(0);
  expect(gatewayActiveWorkCount(runtime)).toBe(1);
  expect(gatewayDrainBlockers(runtime, "alpha")).toEqual([{ botId: "alpha", type: "queue", count: 1, conversationKey: key }]);
  release(); await job;
  expect(gatewayActiveWorkCount(runtime)).toBe(0);
});

it("steers into the originating turn ahead of a queued ordinary message and processes that message once", async () => {
  let finish!: (result: { text: string }) => void;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length > 1) return { text: "Queued ordinary message processed" };
    const done = new Promise<{ text: string }>(resolve => { finish = resolve; });
    input.abortSignal?.addEventListener("abort", () => finish({ text: "stopped" }), { once: true });
    await input.onEngineEvent?.(questionEvent); return done;
  });
  const steer = vi.fn(async () => { finish({ text: "Answer received" }); return true; });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine, supportsSteering: () => true, steerActiveTurn: steer });
  const first = await form(c.id);
  const queued = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "ordinary", text: "Next ordinary message", attachments: [] });
  // The editable input stays at the Hub boundary; it must not be captured by
  // the worker queue before the current turn receives its answer.
  expect(await hub.store.db.get("SELECT dispatched,status FROM deliveries WHERE message_id=?", [queued.message.id])).toEqual({ dispatched: 0, status: "pending" });
  expect(runtime.chatQueue.pendingCount(`lark:${c.id}`)).toBe(0);
  await Promise.all([tap(first.message, first.button, "live_a", answers), tap(first.message, first.button, "live_b", answers)]);
  await until(async () => engine.mock.calls.length === 2 && !runtime.chatQueue.isBusy(`lark:${c.id}`));
  expect(steer).toHaveBeenCalledTimes(1); expect(engine.mock.calls[1]![0].text).toContain("Next ordinary message");
  await until(async () => blocksText((await hub.store.messageForUser("owner", first.message.id)).blocks).includes("Answer delivered to the current task"));
});

it.each(["false", "rejected", "unknown"])("handles %s steering without falling back behind its live origin", async outcome => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { await input.onEngineEvent?.(questionEvent); return waitForAbort(input); });
  const steer = vi.fn(async () => { if (outcome === "unknown") throw new Error("transport_uncertain"); if (outcome === "rejected") throw new EngineSteeringRejectedError("not_ready"); return false; });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine, supportsSteering: () => true, steerActiveTurn: steer });
  const first = await form(c.id); await tap(first.message, first.button, "rejected_answer", answers);
  expect(runtime.chatQueue.pendingCount(`lark:${c.id}`)).toBe(0); expect(engine).toHaveBeenCalledTimes(1);
  if (outcome === "unknown") {
    expect(runtime.pendingApprovals.size).toBe(0);
    const closed = (await hub.store.snapshot("owner", c.id)).messages.find(m => m.id === first.message.id)!;
    expect(blocksText(closed.blocks)).toContain("unconfirmed"); expect(buttons(closed)).toHaveLength(0);
  } else {
    const retry = await form(c.id, first.message.id);
    expect(JSON.stringify(retry.message.blocks)).toContain(answers.q0_other);
    await tap(first.message, first.button, "retired_answer", answers); expect(steer).toHaveBeenCalledTimes(1);
  }
  await gateway!.onCall!("stop", { conversationId: c.id });
  await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));
});

it("stopping during a pending steer cannot replace cancellation with submitted", async () => {
  let finishSteer!: (accepted: boolean) => void;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { await input.onEngineEvent?.(questionEvent); return waitForAbort(input); });
  const steer = vi.fn(() => new Promise<boolean>(resolve => { finishSteer = resolve; }));
  const { runtime, c } = await start({ handleAuthorizedMessage: engine, supportsSteering: () => true, steerActiveTurn: steer });
  const first = await form(c.id); const submit = tap(first.message, first.button, "racing_stop", answers);
  await until(async () => steer.mock.calls.length === 1);
  await gateway!.onCall!("stop", { conversationId: c.id }); finishSteer(true); await submit;
  await until(async () => runtime.pendingApprovals.size === 0 && !runtime.chatQueue.isBusy(`lark:${c.id}`));
  const closed = (await hub.store.snapshot("owner", c.id)).messages.find(m => m.id === first.message.id)!;
  expect(blocksText(closed.blocks)).toContain("cancelled"); expect(blocksText(closed.blocks)).not.toContain("Submitted");
});

it("disconnect closes completed-origin forms and session changes do not accept their answers", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { await input.onEngineEvent?.({ ...questionEvent, requestId: `native_${engine.mock.calls.length}` }); return { text: "finished" }; });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id); await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));
  gateway!.canSteerConversation = async () => false;
  await tap(first.message, first.button, "changed_binding", answers);
  expect(runtime.pendingApprovals.size).toBe(0); expect(engine).toHaveBeenCalledTimes(1);
  await send(c.id, "ask again", "ask_again");
  expect(runtime.pendingApprovals.size).toBe(1);
  await gateway!.disconnect(); gateway = undefined; expect(runtime.pendingApprovals.size).toBe(0);
});

it("stopping a completed-origin question during a binding read prevents queue admission", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { await input.onEngineEvent?.(questionEvent); return { text: "finished" }; });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id); await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));
  let release!: (allowed: boolean) => void;
  const read = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; })); gateway!.canSteerConversation = read;
  const submit = tap(first.message, first.button, "stop_during_read", answers);
  await until(async () => read.mock.calls.length === 1);
  await gateway!.onCall!("stop", { conversationId: c.id }); release(true); await submit;
  expect(engine).toHaveBeenCalledTimes(1); expect(runtime.pendingApprovals.size).toBe(0);
  expect(runtime.chatQueue.isBusy(`lark:${c.id}`)).toBe(false);
});

it.each([
  ["message", false], ["message", true], ["answer follow-up", false], ["answer follow-up", true],
] as const)("queues an answer from a completed %s while a goal survives (newer turn: %s)", async (origin, newerTurn) => {
  const originCall = origin === "message" ? 1 : 2;
  const goal = new CoreGoalRunController();
  let finishNext: ((result: { text: string }) => void) | undefined;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    const call = engine.mock.calls.length;
    if (call <= originCall) {
      await input.onEngineEvent?.({ ...questionEvent, requestId: `goal_question_${call}` });
      return { text: "Question origin finished" };
    }
    if (newerTurn && call === originCall + 1) {
      return new Promise(resolve => {
        finishNext = resolve;
        input.abortSignal?.addEventListener("abort", () => resolve({ text: "stopped" }), { once: true });
      });
    }
    return { text: "Answer follow-up completed" };
  });
  // A true receipt would reveal an answer incorrectly injected into the newer
  // turn. With no turn running, false must not trap the answer in retry forms.
  const steer = vi.fn(async () => newerTurn);
  const attachGoal = (runtime: ReturnType<typeof createCoreServiceRuntime>, conversationId: string) => {
    runtime.activeRuns.set(`lark:${conversationId}`, { abortController: goal, startedAt: Date.now(), goalWatch: true });
  };
  const { runtime, c } = await start({ handleAuthorizedMessage: engine, supportsSteering: () => true, steerActiveTurn: steer }, origin === "message" ? attachGoal : undefined);
  const key = `lark:${c.id}`;
  try {
    let target = await form(c.id);
    await until(async () => !runtime.chatQueue.isBusy(key));
    if (origin === "answer follow-up") {
      attachGoal(runtime, c.id);
      await tap(target.message, target.button, "seed_answer", answers);
      target = await form(c.id, target.message.id);
      await until(async () => !runtime.chatQueue.isBusy(key));
    }
    expect(goal.liveConcurrentTurn()).toBeNull();
    if (newerTurn) {
      await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "newer_turn", text: "A separate task", attachments: [] });
      await until(async () => engine.mock.calls.length === originCall + 1 && !!finishNext);
    }
    await tap(target.message, target.button, "goal_origin_answer", answers);
    finishNext?.({ text: "Separate task completed" });
    await until(async () => !runtime.chatQueue.isBusy(key));
    expect(steer).not.toHaveBeenCalled();
    expect(engine).toHaveBeenCalledTimes(originCall + (newerTurn ? 2 : 1));
    expect(engine.mock.calls.at(-1)![0].text).toContain("Separate the uncertain items");
    expect(runtime.activeRuns.get(key)?.abortController).toBe(goal);
    expect(goal.signal.aborted).toBe(false);
  } finally { finishNext?.({ text: "fixture cleanup" }); }
});

it.each([false, true])("steers an answer into its live origin across a real goal lifecycle (promoted: %s)", async promoted => {
  let finishOrigin: ((result: { text: string }) => void) | undefined;
  let finishGoal: (() => void) | undefined;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    const result = new Promise<{ text: string }>(resolve => { finishOrigin = resolve; });
    input.abortSignal?.addEventListener("abort", () => finishOrigin?.({ text: "stopped" }), { once: true });
    await input.onEngineEvent?.(questionEvent);
    return result;
  });
  const steer = vi.fn<NonNullable<CoreBridgeLike["steerActiveTurn"]>>(async input => {
    expect(input.isCurrentTurn?.()).toBe(true);
    finishOrigin?.({ text: "Origin received its answer" });
    return true;
  });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine, supportsSteering: () => true, steerActiveTurn: steer,
    watchThreadGoal: async () => {
      await new Promise<void>(resolve => { finishGoal = resolve; });
      return { goal: { threadId: "goal_session", objective: "Keep working", status: "complete", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, createdAt: 0, updatedAt: 1 } };
    }, clearThreadGoal: async () => ({ cleared: true }),
  }, undefined, "/goal Keep working");
  const key = `lark:${c.id}`;
  try {
    await until(async () => runtime.activeRuns.get(key)?.goalWatch === true && !!finishGoal);
    const goal = runtime.activeRuns.get(key)!.abortController as CoreGoalRunController;
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "attached_origin", text: "Ask me a question", attachments: [] });
    const target = await form(c.id);
    const origin = goal.liveConcurrentTurn(); expect(origin).not.toBeNull();
    if (promoted) {
      finishGoal!();
      await until(async () => runtime.activeRuns.get(key) === origin);
    }
    await tap(target.message, target.button, "live_goal_answer", answers);
    expect(steer).toHaveBeenCalledTimes(1);
    await until(async () => !runtime.chatQueue.isBusy(key));
    expect(engine).toHaveBeenCalledTimes(1);
    expect(runtime.pendingApprovals.size).toBe(0);
  } finally {
    finishOrigin?.({ text: "fixture cleanup" }); finishGoal?.();
    await until(async () => !runtime.activeRuns.has(key));
  }
});

/** A Codex-style autonomous goal whose own native turn asks an async question. */
function questioningGoal(engine: CoreBridgeLike["handleAuthorizedMessage"], steer: NonNullable<CoreBridgeLike["steerActiveTurn"]>) {
  const finishers: Array<() => void> = [];
  const bridge: CoreBridgeLike = { handleAuthorizedMessage: engine, supportsSteering: () => true, steerActiveTurn: steer,
    watchThreadGoal: async input => {
      const pursuit = finishers.length;
      const settled = new Promise<void>(resolve => { finishers.push(resolve); input.abortSignal?.addEventListener("abort", () => resolve(), { once: true }); });
      await input.onEngineEvent?.({ ...questionEvent, requestId: `goal_question_${pursuit}` });
      await settled;
      return { goal: { threadId: "goal_session", objective: input.objective, status: input.abortSignal?.aborted ? "paused" : "complete",
        tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, createdAt: 0, updatedAt: 1 } };
    }, clearThreadGoal: async () => ({ cleared: true }) };
  return { bridge, finishGoals: () => { for (const finish of finishers) finish(); } };
}

it("presents an autonomous goal's question and queues its answer behind an attached turn without steering", async () => {
  let finishAttached: ((result: { text: string }) => void) | undefined;
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
    if (engine.mock.calls.length > 1) return { text: "Goal answer follow-up" };
    return new Promise(resolve => { finishAttached = resolve; input.abortSignal?.addEventListener("abort", () => resolve({ text: "stopped" }), { once: true }); });
  });
  // The goal has no host-side pending turn: a true receipt would reveal the
  // goal's answer injected into the unrelated attached turn.
  const steer = vi.fn(async () => true);
  const { bridge, finishGoals } = questioningGoal(engine, steer);
  const { runtime, c } = await start(bridge, undefined, "/goal Keep working");
  const key = `lark:${c.id}`;
  try {
    const target = await form(c.id);
    const goal = runtime.activeRuns.get(key)!.abortController as CoreGoalRunController;
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "attached_turn", text: "A separate task", attachments: [] });
    await until(async () => !!finishAttached && goal.liveConcurrentTurn() !== null);
    await tap(target.message, target.button, "goal_answer", answers);
    expect(steer).not.toHaveBeenCalled(); expect(engine).toHaveBeenCalledTimes(1);
    expect(runtime.chatQueue.pendingCount(key)).toBe(1);
    finishAttached!({ text: "Separate task completed" });
    await until(async () => engine.mock.calls.length === 2 && !runtime.chatQueue.isBusy(key));
    expect(engine.mock.calls[1]![0].text).toContain("Separate the uncertain items");
    expect(engine.mock.calls[1]![0].text).toContain("goal_question_0");
    expect(runtime.pendingApprovals.size).toBe(0);
    expect(runtime.activeRuns.get(key)?.abortController).toBe(goal); expect(goal.signal.aborted).toBe(false);
  } finally {
    finishAttached?.({ text: "fixture cleanup" }); finishGoals();
    await until(async () => !runtime.activeRuns.has(key));
  }
});

it("keeps a surviving goal's question through a stop routed to its attached turn and closes it with the goal", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => waitForAbort(input));
  const steer = vi.fn(async () => true);
  const { bridge, finishGoals } = questioningGoal(engine, steer);
  const { runtime, c } = await start(bridge, undefined, "/goal Keep working");
  const key = `lark:${c.id}`;
  try {
    const target = await form(c.id);
    const goal = runtime.activeRuns.get(key)!.abortController as CoreGoalRunController;
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "attached_turn", text: "A separate task", attachments: [] });
    await until(async () => goal.liveConcurrentTurn() !== null);
    expect(await gateway!.onCall!("stop", { conversationId: c.id })).toEqual({ stopped: true });
    await until(async () => !runtime.chatQueue.isBusy(key));
    expect(goal.signal.aborted).toBe(false); expect(runtime.pendingApprovals.size).toBe(1);
    expect(await gateway!.onCall!("stop", { conversationId: c.id })).toEqual({ stopped: true });
    await until(async () => runtime.pendingApprovals.size === 0 && !runtime.activeRuns.has(key));
    await tap(target.message, target.button, "late_goal_answer", answers);
    expect(buttons((await hub.store.snapshot("owner", c.id)).messages.find(m => m.id === target.message.id)!)).toHaveLength(0);
    expect(engine).toHaveBeenCalledTimes(1); expect(steer).not.toHaveBeenCalled();
  } finally { finishGoals(); }
});

it("closes a replaced goal's question and never admits its answer", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: "unexpected turn" }));
  const { bridge, finishGoals } = questioningGoal(engine, vi.fn(async () => true));
  const { runtime, c } = await start(bridge, undefined, "/goal First objective");
  const key = `lark:${c.id}`;
  try {
    const first = await form(c.id);
    const firstGoal = runtime.activeRuns.get(key)!.abortController as CoreGoalRunController;
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "replace_goal", text: "/goal Second objective", attachments: [] });
    const second = await form(c.id, first.message.id);
    expect(firstGoal.signal.aborted).toBe(true);
    expect(runtime.pendingApprovals.size).toBe(1);
    await tap(first.message, first.button, "replaced_goal_answer", answers);
    await until(async () => !runtime.chatQueue.isBusy(key));
    expect(engine).not.toHaveBeenCalled();
    expect(buttons((await hub.store.snapshot("owner", c.id)).messages.find(m => m.id === first.message.id)!)).toHaveLength(0);
    expect(buttons((await hub.store.snapshot("owner", c.id)).messages.find(m => m.id === second.message.id)!)).toHaveLength(1);
  } finally {
    finishGoals();
    await until(async () => !runtime.activeRuns.has(key));
  }
});

it("closes a restart-orphaned question only in its original conversation", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => { await input.onEngineEvent?.(questionEvent); return { text: "Done" }; });
  const { runtime, c } = await start({ handleAuthorizedMessage: engine });
  const first = await form(c.id); await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));
  for (const pending of runtime.pendingApprovals.values()) clearTimeout(pending.timer);
  runtime.pendingApprovals.clear();
  const wrong = await hub.store.createConversation("owner", ["alpha"], "Other", "other_async");
  await gateway!.transport.onCall!("interaction", { receiptId: "forged_context", conversationId: wrong.id, messageId: first.message.id,
    userId: "owner", actionId: first.button.actionId!, value: first.button.value ?? {}, values: answers });
  expect(buttons((await hub.store.snapshot("owner", c.id)).messages.find(m => m.id === first.message.id)!)).toHaveLength(1);
  await tap(first.message, first.button, "orphan_answer", answers);
  const closed = (await hub.store.snapshot("owner", c.id)).messages.find(m => m.id === first.message.id)!;
  expect(buttons(closed)).toHaveLength(0); expect(blocksText(closed.blocks)).toContain("inactive");
  expect(engine).toHaveBeenCalledTimes(1);
});
