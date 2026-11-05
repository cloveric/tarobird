import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewaySteering } from "../src/gateway/steering.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import type { GatewayTransport } from "../src/gateway/transport.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import { NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY, type NativeInputObserver, type NativeInputProgress } from "../src/client-protocol/native-input.js";
import type { Message } from "../src/client-protocol/index.js";
import type { NormalizedMessage } from "../src/core/channel-events.js";

const nativeId = (userId: string, requestId: string) => createHash("sha256").update(JSON.stringify([userId, requestId])).digest("hex");

describe("Ordinary input to a Claude background-review target", () => {
  let root: string, fixtures = 0;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "review-input-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const record = (patch: Partial<Message> = {}, text = "Also check B"): Message => ({ id: "msg_input", conversationId: "chat", authorId: "owner", authorType: "user", clientMsgId: "input", mentions: ["bot"], status: "complete", version: 2, createdAt: 1,
    blocks: [{ type: "text", text }, { type: "steering", botId: "bot", targetId: "review_1", outcome: "pending", mode: "message" }], ...patch });
  function fixture(options: { capabilities?: string[]; mode?: "p2p" | "group"; message?: Message; progress?: NativeInputProgress[] } = {}) {
    const runtime = createCoreServiceRuntime(), key = buildCoreConversationKey("chat");
    const capability = { sendNow: true, cancel: true, modelReceipt: true };
    const bridge = { supportsSteering: () => true, inFlightSendBehavior: () => "steer" as const,
      nativeInputCapability: vi.fn(async () => capability), controlNativeInput: vi.fn(async () => ({ outcome: "accepted" as const, result: "cancelled" as const })),
      steerActiveTurn: vi.fn(async () => true), backgroundInputTarget: vi.fn(async (): Promise<string | undefined> => "review_1"), handleAuthorizedMessage: vi.fn() };
    const progress = options.progress ?? [{ state: "queued" }];
    const dispatched: Array<{ message: Message; admission: { reviewAdmission: "native"; nativeInput: NativeInputObserver } }> = [];
    let finishTurn!: () => void;
    const channel = {
      canSteerConversation: vi.fn(async () => true),
      getChatMode: vi.fn(async () => options.mode ?? "p2p"),
      dispatchNativeTurn: vi.fn((message: Message, _conversation: unknown, admission: { reviewAdmission: "native"; nativeInput: NativeInputObserver }) => {
        dispatched.push({ message, admission });
        for (const item of progress) admission.nativeInput.onProgress(item);
        return new Promise<void>((resolve) => { finishTurn = resolve; });
      }),
      transport: { capabilities: options.capabilities ?? [NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY], options: { botId: "bot" },
        request: vi.fn(async (method: string, params?: { messageId?: string }): Promise<unknown> => {
          if (method === "fetch") return options.message ?? (params?.messageId === "msg_second" ? record({ id: "msg_second", clientMsgId: "second" }, "Also check C") : record());
          if (method === "conversation") return { id: "chat", type: options.mode === "group" ? "group" : "direct", title: "Chat", ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1 };
          return null;
        }) },
    };
    // Each fixture owns its receipts; a restarted Gateway reuses them.
    const stateDir = path.join(root, String(++fixtures));
    const create = () => gatewaySteering(bridge, runtime, channel as unknown as GatewayChannel, stateDir);
    const run = create();
    const input = { conversationId: "chat", userId: "owner", requestId: "input", targetId: "review_1", text: "Also check B", mode: "message", messageId: "msg_input" };
    return { runtime, key, bridge, channel, create, run, input, dispatched, finish: () => finishTurn() };
  }

  it("offers an input-only target without send-now only when explicitly requested and negotiated", async () => {
    const f = fixture();
    expect(await f.run("steer.status", { conversationId: "chat", backgroundReview: true })).toEqual({ supported: true, targetId: "review_1", targetKind: "background-review", sendBehavior: "steer", nativeInput: { sendNow: false, cancel: true, modelReceipt: true } });
    // An older App/Hub never asks: it keeps today's waiting route.
    expect(await f.run("steer.status", { conversationId: "chat" })).toMatchObject({ supported: true, reason: "idle" });
    for (const capabilities of [[NATIVE_INPUT_CAPABILITY], [NATIVE_REVIEW_INPUT_CAPABILITY], []]) {
      expect(await fixture({ capabilities }).run("steer.status", { conversationId: "chat", backgroundReview: true })).not.toHaveProperty("targetKind");
    }
    expect(await fixture({ mode: "group" }).run("steer.status", { conversationId: "chat", backgroundReview: true })).not.toHaveProperty("targetKind");
    const none = fixture(); none.bridge.backgroundInputTarget.mockResolvedValue(undefined);
    expect(await none.run("steer.status", { conversationId: "chat", backgroundReview: true })).toMatchObject({ reason: "idle" });
    expect(none.channel.getChatMode).not.toHaveBeenCalled();
    // An older strict Gateway call shape still rejects unknown fields.
    await expect(f.run("steer.status", { conversationId: "chat", backgroundReview: false })).rejects.toThrow();
  });

  it("never exposes a review target beside a live or queued Core turn", async () => {
    const live = fixture(); live.runtime.activeRuns.set(live.key, { abortController: new AbortController() });
    const status = await live.run("steer.status", { conversationId: "chat", backgroundReview: true }) as { targetId: string; targetKind?: string };
    expect(status.targetKind).toBeUndefined(); expect(status.targetId).not.toBe("review_1");
    const queued = fixture(); void queued.runtime.chatQueue.enqueue(queued.key, () => new Promise(() => undefined));
    expect(await queued.run("steer.status", { conversationId: "chat", backgroundReview: true })).toMatchObject({ reason: "idle" });
  });

  it("starts one new turn for the verified record and reports only native admission", async () => {
    const f = fixture();
    f.channel.transport.capabilities.push("steering.outcome.v1");
    expect(await f.run("steer", f.input)).toEqual({ outcome: "accepted" });
    expect(f.dispatched).toHaveLength(1);
    const [{ message, admission }] = f.dispatched;
    expect(message.id).toBe("msg_input");
    expect(admission.reviewAdmission).toBe("native");
    expect(admission.nativeInput.id).toBe(nativeId("owner", "input"));
    // Never written into the review: no steer of an active turn.
    expect(f.bridge.steerActiveTurn).not.toHaveBeenCalled();
    expect(f.channel.transport.request).toHaveBeenCalledWith("input.progress", { conversationId: "chat", userId: "owner", requestId: "input", targetId: "review_1", progress: { state: "queued" } });
    // A retry or a restarted Gateway checks the same receipt; nothing runs twice.
    expect(await f.create()("steer", f.input)).toEqual({ outcome: "accepted" });
    expect(f.channel.dispatchNativeTurn).toHaveBeenCalledTimes(1);
    // While that turn runs (queued behind or continuing the review), send-now stays unavailable.
    f.runtime.activeRuns.set(f.key, { abortController: new AbortController() });
    expect(await f.run("steer.status", { conversationId: "chat", backgroundReview: true })).toMatchObject({ nativeInput: { sendNow: false } });
    // Withdrawal reaches the same native identity through the existing control.
    await f.run("input.control", { conversationId: "chat", userId: "owner", requestId: "control", inputId: "input", action: "cancel" });
    expect(f.bridge.controlNativeInput).toHaveBeenCalledWith(expect.objectContaining({ inputId: nativeId("owner", "input"), action: "cancel" }));
    f.finish();
    // A later ordinary run of the same conversation gets the CLI's capability again.
    await vi.waitFor(async () => expect(await f.run("steer.status", { conversationId: "chat" })).toMatchObject({ nativeInput: { sendNow: true } }));
  });

  it("admits one new foreground turn per review target even before Core claims it", async () => {
    const f = fixture();
    const second = { ...f.input, requestId: "second", messageId: "msg_second", text: "Also check C" };
    expect(await f.run("steer", f.input)).toEqual({ outcome: "accepted" });
    // The first turn is dispatched but still awaiting its receipt and Core admission.
    expect(f.dispatched).toHaveLength(1); expect(f.runtime.activeRuns.has(f.key)).toBe(false); expect(f.runtime.chatQueue.isBusy(f.key)).toBe(false);
    // Another genuine input for the same, now-consumed target is a stale target, not a queued Core turn.
    expect(await f.run("steer", second)).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.channel.dispatchNativeTurn).toHaveBeenCalledTimes(1);
    expect(f.channel.transport.request).not.toHaveBeenCalledWith("fetch", { messageId: "msg_second" });
    expect(await f.run("steer.status", { conversationId: "chat", backgroundReview: true })).toMatchObject({ supported: true, reason: "idle" });
    // Once Core runs that turn, ordinary follow-up input steers it, still without send-now.
    f.runtime.activeRuns.set(f.key, { abortController: new AbortController() });
    const live = await f.run("steer.status", { conversationId: "chat", backgroundReview: true }) as { targetId: string; targetKind?: string; nativeInput: { sendNow: boolean } };
    expect(live.targetKind).toBeUndefined(); expect(live.nativeInput.sendNow).toBe(false);
    expect(await f.run("steer", { ...second, requestId: "follow", messageId: undefined, targetId: live.targetId })).toEqual({ outcome: "accepted" });
    expect(f.bridge.steerActiveTurn).toHaveBeenCalledTimes(1); expect(f.channel.dispatchNativeTurn).toHaveBeenCalledTimes(1);
    // After that turn ends, a later review is offered again.
    f.runtime.activeRuns.delete(f.key); f.finish();
    await vi.waitFor(async () => expect(await f.run("steer.status", { conversationId: "chat", backgroundReview: true })).toMatchObject({ targetId: "review_1", targetKind: "background-review" }));
  });

  it("rejects only an explicit pre-write refusal and keeps every other first receipt uncertain", async () => {
    expect(await fixture({ progress: [{ state: "dropped", reason: "not_admitted" }] }).run("steer", fixture().input)).toEqual({ outcome: "rejected", reason: "not_ready" });
    expect(await fixture({ progress: [{ state: "unknown", reason: "no_admission_receipt" }] }).run("steer", fixture().input)).toEqual({ outcome: "unknown", reason: "uncertain" });
    const silent = fixture({ progress: [] });
    const sending = silent.run("steer", silent.input);
    await vi.waitFor(() => expect(silent.dispatched).toHaveLength(1));
    // The turn ended without a native receipt: it may still have been written.
    silent.finish();
    expect(await sending).toEqual({ outcome: "unknown", reason: "uncertain" });
  });

  it("returns an uncertain receipt before the Hub RPC expires without resending or suppressing late evidence", async () => {
    const f = fixture({ progress: [] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let result: unknown;
    const sending = f.run("steer", f.input).then(value => { result = value; return value; });
    try {
      await vi.waitFor(() => expect(f.dispatched).toHaveLength(1));
      // The Hub allows 10 s for this RPC. Leave headroom for transport and
      // receipt persistence rather than racing that deadline.
      await vi.advanceTimersByTimeAsync(9000);
      await vi.waitFor(() => expect(result).toEqual({ outcome: "unknown", reason: "uncertain" }));
      f.dispatched[0]!.admission.nativeInput.onProgress({ state: "queued" });
      expect(f.channel.transport.request).toHaveBeenCalledWith("input.progress", expect.objectContaining({ progress: { state: "queued" } }));
      expect(await f.create()("steer", f.input)).toEqual({ outcome: "unknown", reason: "uncertain" });
      expect(f.channel.dispatchNativeTurn).toHaveBeenCalledTimes(1);
    } finally { f.finish(); await sending; vi.useRealTimers(); }
  });

  it("rechecks every precondition before anything reaches Claude", async () => {
    const cases: Array<[string, (f: ReturnType<typeof fixture>) => void, unknown, Record<string, unknown>?]> = [
      ["review changed", f => f.bridge.backgroundInputTarget.mockResolvedValue("review_2"), { outcome: "rejected", reason: "stale" }],
      ["binding changed", f => f.channel.canSteerConversation.mockResolvedValue(false), { outcome: "rejected", reason: "binding_changed" }],
      ["older Hub without the record ID", () => undefined, { outcome: "rejected", reason: "stale" }, { messageId: undefined }],
      ["slash command", () => undefined, { outcome: "rejected", reason: "unsupported" }, { text: "/compact" }],
      ["native capability gone", f => f.bridge.nativeInputCapability.mockResolvedValue(undefined as never), { outcome: "rejected", reason: "unsupported" }],
      ["queued Core turn", f => { void f.runtime.chatQueue.enqueue(f.key, () => new Promise(() => undefined)); }, { outcome: "rejected", reason: "stale" }],
    ];
    for (const [, arrange, expected, patch] of cases) {
      const f = fixture(); arrange(f);
      const input = { ...f.input, ...patch }; if (patch && "messageId" in patch && patch.messageId === undefined) delete (input as { messageId?: string }).messageId;
      expect(await f.run("steer", input)).toEqual(expected);
      expect(f.channel.dispatchNativeTurn).not.toHaveBeenCalled();
    }
    const group = fixture({ mode: "group" });
    expect(await group.run("steer", group.input)).toEqual({ outcome: "rejected", reason: "unsupported" });
    expect(group.channel.dispatchNativeTurn).not.toHaveBeenCalled();
    const negotiated = fixture({ capabilities: [NATIVE_INPUT_CAPABILITY] });
    expect(await negotiated.run("steer", negotiated.input)).toEqual({ outcome: "rejected", reason: "unsupported" });
  });

  it("binds the turn to the caller's own authenticated record", async () => {
    for (const message of [record({ authorId: "intruder" }), record({ clientMsgId: "other" }), record({ conversationId: "elsewhere" }), record({}, "Different text"),
      record({ blocks: [{ type: "text", text: "Also check B" }, { type: "steering", botId: "other_bot", targetId: "review_1", outcome: "pending", mode: "message" }] }),
      record({ blocks: [{ type: "text", text: "Also check B" }, { type: "steering", botId: "bot", targetId: "review_9", outcome: "pending", mode: "message" }] }),
      record({ blocks: [{ type: "text", text: "Also check B" }, { type: "steering", botId: "bot", targetId: "review_1", outcome: "pending" }] })]) {
      const f = fixture({ message });
      expect(await f.run("steer", f.input)).toEqual({ outcome: "rejected", reason: "stale" });
      expect(f.channel.dispatchNativeTurn).not.toHaveBeenCalled();
    }
  });

  it("keeps a live run target on the steering path and rejects a review ID for it", async () => {
    const f = fixture(); f.runtime.activeRuns.set(f.key, { abortController: new AbortController() });
    expect(await f.run("steer", f.input)).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.channel.dispatchNativeTurn).not.toHaveBeenCalled();
    expect(f.bridge.steerActiveTurn).not.toHaveBeenCalled();
  });

  it("withholds the review target while a pushed Hub message awaits Core admission", async () => {
    const conversationRecord = (id: string) => ({ id, type: "direct" as const, title: id, ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1 });
    const transport = { capabilities: [NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY], options: { stateDir: path.join(root, "push"), botId: "bot" },
      refreshStatus: async () => undefined, deliverySettled: () => undefined, reconnectAfterDeliveryFailure: () => undefined,
      request: vi.fn(async (method: string, params?: { messageId?: string; conversationId?: string }): Promise<unknown> => {
        if (method === "fetch") return record();
        if (method === "conversation") return conversationRecord(params?.conversationId ?? "chat");
        return null;
      }) } as unknown as GatewayTransport & { onMessage: (message: Message, conversation: ReturnType<typeof conversationRecord>) => Promise<void> };
    const channel = new GatewayChannel(transport);
    channel.canSteerConversation = async () => true;
    const dispatch = vi.spyOn(channel, "dispatchNativeTurn");
    // A real inbound delivery whose Core turn has not been admitted yet.
    let admitCore!: () => void;
    const held = new Promise<void>(resolve => { admitCore = resolve; });
    channel.on("message", async () => { await held; });
    const runtime = createCoreServiceRuntime();
    const bridge = { supportsSteering: () => true, inFlightSendBehavior: () => "steer" as const, steerActiveTurn: vi.fn(async () => true), handleAuthorizedMessage: vi.fn(),
      nativeInputCapability: vi.fn(async () => ({ sendNow: true, cancel: true, modelReceipt: true })), backgroundInputTarget: vi.fn(async (): Promise<string | undefined> => "review_1") };
    const run = gatewaySteering(bridge, runtime, channel, path.join(root, "push-steering"));
    void transport.onMessage({ ...record({ id: "msg_pushed", clientMsgId: "pushed" }, "Pushed task"), blocks: [{ type: "text", text: "Pushed task" }] }, conversationRecord("chat"));
    await vi.waitFor(() => expect(channel.hasPendingAdmission("chat")).toBe(true));
    expect(runtime.activeRuns.size).toBe(0); expect(runtime.chatQueue.isBusy(buildCoreConversationKey("chat"))).toBe(false);
    expect(await run("steer.status", { conversationId: "chat", backgroundReview: true })).toMatchObject({ supported: true, reason: "idle" });
    expect(await run("steer", { conversationId: "chat", userId: "owner", requestId: "input", targetId: "review_1", text: "Also check B", mode: "message", messageId: "msg_input" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(dispatch).not.toHaveBeenCalled();
    // Another conversation's review is unaffected.
    expect(channel.hasPendingAdmission("other")).toBe(false);
    expect(await run("steer.status", { conversationId: "other", backgroundReview: true })).toMatchObject({ targetId: "review_1", targetKind: "background-review" });
    admitCore();
    await vi.waitFor(() => expect(channel.hasPendingAdmission("chat")).toBe(false));
    expect(await run("steer.status", { conversationId: "chat", backgroundReview: true })).toMatchObject({ targetId: "review_1", targetKind: "background-review" });
  });

  it("dispatches the record as a new turn without a Hub delivery acknowledgement", async () => {
    const requests: string[] = [];
    const transport = { capabilities: [NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY], options: { stateDir: root, botId: "bot" }, refreshStatus: async () => undefined,
      request: async (method: string) => { requests.push(method); return null; } };
    const seen: NormalizedMessage[] = [];
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    channel.on("message", async (message) => { seen.push(message); expect(channel.currentMessageId()).toBe("msg_input"); });
    const nativeInput = { id: "native", onProgress: vi.fn() };
    const conversation = { id: "chat", type: "direct" as const, title: "Chat", ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1 };
    await channel.dispatchNativeTurn(record(), conversation, { reviewAdmission: "native", nativeInput });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ messageId: "msg_input", chatId: "chat", chatType: "p2p", content: "Also check B", resources: [], reviewAdmission: "native", nativeInput });
    expect(seen[0]).not.toHaveProperty("replyToMessageId");
    expect(requests).not.toContain("ack"); expect(requests).not.toContain("delivery.fail");
    // A second dispatch of the same record (including after a restart) is a no-op.
    await channel.dispatchNativeTurn(record(), conversation, { reviewAdmission: "native", nativeInput });
    const restarted = new GatewayChannel(transport as unknown as GatewayTransport);
    restarted.on("message", async (message) => { seen.push(message); });
    await restarted.dispatchNativeTurn(record(), conversation, { reviewAdmission: "native", nativeInput });
    expect(seen).toHaveLength(1);
  });
});
