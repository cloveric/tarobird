import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAdapter } from "../src/codex/adapter.js";
import type { Conversation, Message } from "../src/client-protocol/index.js";
import type { NormalizedMessage } from "../src/core/channel-events.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import type { GatewayTransport } from "../src/gateway/transport.js";
import { Bridge, type AccessStoreLike, type SessionManagerLike } from "../src/runtime/bridge.js";
import { classifyFailure } from "../src/runtime/error-classification.js";
import { resolveEngineOverride } from "../src/state/instance-config.js";
import { fakeChannel, fakeLarkMessage } from "./helpers/core-compat-fixtures.js";

describe("dispatcher ticket engine override", () => {
  let stateDir: string;
  beforeEach(async () => { stateDir = await mkdtemp(path.join(os.tmpdir(), "engine-override-")); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "en" })); });
  afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

  it("derives the override from the queued conversation's ticket marker only", async () => {
    const base: Conversation = { id: "chat", type: "direct", title: "Ticket", ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1 };
    const message: Message = { id: "msg_1", conversationId: "chat", authorId: "owner", authorType: "user", status: "complete", version: 1, createdAt: 1, blocks: [{ type: "text", text: "Do it" }] };
    const received: NormalizedMessage[] = [];
    let queued: { message: Message; conversation: Conversation } | undefined;
    const channel = new GatewayChannel({ capabilities: [], options: { stateDir, botId: "bot" }, takeQueued: async () => queued, request: async () => null, deliverySettled: () => {}, refreshStatus: async () => {}, isBusy: () => false } as unknown as GatewayTransport);
    channel.on("message", value => { received.push(value); });
    const take = async (conversation: Conversation, id: string) => { queued = { message: { ...message, id }, conversation }; await channel.takeQueued("chat"); return received.at(-1)!; };
    const ticket = { id: "tkt_1", dispatcherBotId: "dispatcher" };
    expect((await take({ ...base, hidden: true, ticket: { ...ticket, model: " gpt-5.5 ", effort: "high" } }, "msg_1")).engineOverride).toEqual({ model: "gpt-5.5", effort: "high" });
    expect((await take({ ...base, hidden: true, ticket: { ...ticket, effort: "low" } }, "msg_2")).engineOverride).toEqual({ effort: "low" });
    expect(await take({ ...base, hidden: true, ticket: { ...ticket, model: " ", effort: "" } }, "msg_3")).not.toHaveProperty("engineOverride");
    expect(await take(base, "msg_4")).not.toHaveProperty("engineOverride");
  });

  it("passes the override from Core to the Bridge turn and omits it otherwise", async () => {
    const channel = { ...fakeChannel(), profile: "gateway" as const };
    const bridge = { handleAuthorizedMessage: vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: "done" })) };
    const runtime = createCoreServiceRuntime();
    const engineOverride = { model: "sonnet", effort: "low" as const };
    await withChannelProfile("gateway", () => handleCoreMessage({ channel, bridge, runtime, stateDir, message: { ...fakeLarkMessage({ messageId: "om_ticket" }), engineOverride } }));
    await withChannelProfile("gateway", () => handleCoreMessage({ channel, bridge, runtime, stateDir, message: fakeLarkMessage({ messageId: "om_plain" }) }));
    expect(bridge.handleAuthorizedMessage.mock.calls[0]![0].engineOverride).toEqual(engineOverride);
    expect(bridge.handleAuthorizedMessage.mock.calls[1]![0]).not.toHaveProperty("engineOverride");
  });

  it("forwards the override from the Bridge to the native adapter", async () => {
    const access: AccessStoreLike = { load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [84], pairedUsers: [], pendingPairs: [] }), issuePairingCode: vi.fn() };
    const manager: SessionManagerLike = { getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "session" }), getExistingSession: vi.fn(), bindSession: vi.fn() };
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }) };
    const bridge = new Bridge(access, manager, adapter), input = { chatId: 84, conversationKey: "lark:chat", userId: 42, chatType: "private", text: "Hello", files: [] };
    await bridge.handleAuthorizedMessage({ ...input, engineOverride: { model: "gpt-5.5" } });
    await bridge.handleAuthorizedMessage(input);
    const sent = vi.mocked(adapter.sendUserMessage).mock.calls.map(call => call[1]);
    expect(sent[0]!.engineOverride).toEqual({ model: "gpt-5.5" });
    expect(sent[1]).not.toHaveProperty("engineOverride");
  });

  it("validates the requested effort per engine and keeps the Bot effort only when the model supports it", () => {
    const configured = { model: "claude-opus-5-5[1m]", effort: "xhigh", approvalMode: "normal" };
    expect(resolveEngineOverride("claude", configured, undefined)).toBe(configured);
    expect(resolveEngineOverride("claude", configured, { effort: "low" })).toEqual({ ...configured, effort: "low" });
    expect(resolveEngineOverride("claude", configured, { model: "claude-sonnet-4-6" })).toEqual({ ...configured, model: "claude-sonnet-4-6", effort: undefined });
    expect(() => resolveEngineOverride("claude", configured, { model: "haiku", effort: "low" })).toThrow("Invalid model selection: haiku does not support effort");
    expect(classifyFailure(new Error("Invalid model selection: haiku does not support effort"))).toBe("engine-settings");
    expect(() => resolveEngineOverride("kimi", {}, { effort: "xhigh" })).toThrow('Invalid model selection: kimi-default has no "xhigh" effort (available: low, high, max)');
    expect(classifyFailure(new Error('Invalid model selection: kimi-default has no "xhigh" effort (available: low, high, max)'))).toBe("engine-settings");
  });
});
