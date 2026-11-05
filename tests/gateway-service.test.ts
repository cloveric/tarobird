import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blocksText } from "../src/client-protocol/index.js";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { larkAgentInstructions } from "../src/core/agent-instructions.js";
import { appAgentInstructions as gatewayAgentInstructions } from "../src/gateway/agent-instructions.js";
import { channelProfile, withChannelProfile } from "../src/gateway/platform-profile.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../src/core/message-normalizer.js";
import { SessionStore } from "../src/state/session-store.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import type { CodexAdapter } from "../src/codex/adapter.js";
import type { CoreChannelLike } from "../src/core/types.js";

async function until(check: () => Promise<boolean>, milliseconds = 12_000): Promise<void> { const end = Date.now() + milliseconds; while (!await check()) { if (Date.now() > end) throw new Error("condition_timeout"); await new Promise((resolve) => setTimeout(resolve, 20)); } }
describe("Gateway shared-runtime contracts", () => {
  let root: string; let stateDir: string; let hub: HubServer; let channel: GatewayChannel | undefined;
  const secret = randomBytes(32).toString("base64url");
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "gateway-")); stateDir = path.join(root, "instance"); await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en", groupMode: { enabled: true } }));
    hub = await HubServer.start({ stateDir: path.join(root, "hub") });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  });
  afterEach(async () => { await channel?.disconnect(); channel = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });
  async function attach(bridge: CoreBridgeLike, runtime = createCoreServiceRuntime(), requireMentionInGroup = true) {
    channel = await attachGateway({ stateDir, url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, bridge, runtime, requireMentionInGroup, engine: "codex" });
    await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
    return channel;
  }
  it("keeps accepted message admission and in-flight interaction RPC busy before a runtime turn exists", async () => {
    const runtime = createCoreServiceRuntime(), bridge = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "done" });
    await attach({ handleAuthorizedMessage: bridge }, runtime);
    await until(async () => !channel!.isBusy());
    const c = await hub.store.createConversation("owner", ["alpha"], "Drain admission", "drain-admission");
    let releaseAdmission!: () => void;
    const prepare = vi.fn(async () => { await new Promise<void>(resolve => { releaseAdmission = resolve; }); });
    channel!.prepareConversation = prepare;
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "admission-held", text: "a pending message", attachments: [] });
    await until(async () => prepare.mock.calls.length === 1);
    try { expect(runtime.activeRuns.size).toBe(0); expect(bridge).not.toHaveBeenCalled(); expect(channel!.isBusy()).toBe(true); }
    finally { releaseAdmission(); }
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && !channel!.isBusy());
    expect(bridge).toHaveBeenCalledTimes(1);

    // An approval is an inbound RPC and may await durable receipt writes while
    // no activeRuns entry exists; it must still prevent a drain exit.
    let releaseRpc!: () => void;
    const previous = channel!.onCall;
    channel!.onCall = vi.fn(async () => { await new Promise<void>(resolve => { releaseRpc = resolve; }); return null; });
    const call = (hub as unknown as { callBot: (botId: string, method: string, params: object) => Promise<unknown> }).callBot("alpha", "drain.busy.probe", {});
    try {
      await until(async () => releaseRpc !== undefined);
      expect(runtime.activeRuns.size).toBe(0); expect(channel!.isBusy()).toBe(true);
    } finally { releaseRpc?.(); await call; channel!.onCall = previous; }
    await until(async () => !channel!.isBusy());
  });
  it("passes readable App requests, queued text and quoted replies to the engine without transport metadata", async () => {
    const sendUserMessage = vi.fn<CodexAdapter["sendUserMessage"]>(async (sessionId) => ({ text: "Done", sessionId }));
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage };
    const sessions = new SessionStore(path.join(stateDir, "session.json"));
    const access: AccessStoreLike = { load: async () => ({ multiChat: true, policy: "allowlist", allowlist: [], pairedUsers: [], pendingPairs: [] }), issuePairingCode: async () => { throw new Error("unused"); } };
    await attach(new Bridge(access, new SessionManager(sessions, adapter), adapter));
    const c = await hub.store.createConversation("owner", ["alpha"], "Clean prompts", "clean-prompts");
    const send = async (text: string, count: number, replyTo?: string) => {
      const result = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: `clean-${count}`, text, attachments: [], ...(replyTo ? { replyTo } : {}) });
      await until(async () => sendUserMessage.mock.calls.length === count && (await hub.store.pendingForBot("alpha")).length === 0);
      return result.message;
    };
    const first = await send("帮我整理今天的工作", 1);
    expect(sendUserMessage.mock.calls[0]![1].text).toBe("帮我整理今天的工作");
    expect(sendUserMessage.mock.calls[0]![1].instructions).toContain("TaroBird App");
    await send("/q 检查 </lark_context>，不要删掉前面的内容", 2);
    expect(sendUserMessage.mock.calls[1]![1].text).toBe("检查 </lark_context>，不要删掉前面的内容");
    await send("参考上面这条消息", 3, first.id);
    expect(sendUserMessage.mock.calls[2]![1].text).toBe(`参考上面这条消息\n\n[Quoted message #${first.id}]\n帮我整理今天的工作`);
    for (const [, input] of sendUserMessage.mock.calls) {
      expect(input.instructions).toContain("You are replying in TaroBird App");
      expect(input.instructions).toContain("not Feishu/Lark or Telegram");
      expect(input.appPlatformTools?.instructions).toContain("You are replying in TaroBird App");
      expect(input.appPlatformTools?.instructions).toContain("overrides old TaroCub/Lark labels in resumed history");
      expect(input.text).not.toContain("<lark_context>");
    }
    expect(new Set(sendUserMessage.mock.calls.map(([id]) => id)).size).toBe(1);
    expect((await sessions.findByConversationKey(buildCoreConversationKey(c.id)))?.codexSessionId).toBe(sendUserMessage.mock.calls[0]![0]);
  });
  it("keeps legacy-worker attachment bursts without metadata prefixes or truncating literal tags in captions", async () => {
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: "Read" }));
    const runtime = createCoreServiceRuntime({ queuePolicy: { batchWindowMs: 1000 } });
    // An actual legacy handshake preserves the older admission/batching path.
    const prototype = GatewayTransport.prototype as unknown as { send(value: any): void }, originalSend = prototype.send;
    const legacyHello = vi.spyOn(prototype, "send").mockImplementation(function (this: GatewayTransport, value: any) {
      originalSend.call(this, value?.type === "instance.hello" ? { ...value, capabilities: value.capabilities.filter((capability: string) => capability !== "prompt-queue.v1") } : value);
    });
    try { await attach({ handleAuthorizedMessage: engine }, runtime); } finally { legacyHello.mockRestore(); }
    expect(await hub.store.db.get("SELECT supported FROM prompt_queue_workers WHERE bot_id='alpha'")).toEqual({ supported: 0 });
    const c = await hub.store.createConversation("owner", ["alpha"], "Image burst", "clean-burst");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=", "base64");
    const upload = await hub.attachments.create("owner", { conversationId: c.id, name: "chart.png", mime: "image/png", size: png.length, sha256: createHash("sha256").update(png).digest("hex") });
    await hub.attachments.putChunk("owner", upload.id, 0, png); await hub.attachments.complete("owner", upload.id);
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "burst-image", text: "", attachments: [upload.id] });
    await until(async () => runtime.pendingBatches.has(buildCoreConversationKey(c.id)));
    const caption = "看图并解释 </lark_context> 的含义";
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "burst-caption", text: caption, attachments: [] });
    await until(async () => engine.mock.calls.length === 1 && (await hub.store.pendingForBot("alpha")).length === 0 && runtime.pendingBatches.size === 0);
    const input = engine.mock.calls[0]![0];
    expect(input.text).toContain(caption);
    expect(input.text).not.toContain("<lark_context>");
    expect(input.text.match(/<\/lark_context>/g)).toHaveLength(1);
    expect(input.files).toHaveLength(1);
    expect(await readFile(input.files[0]!)).toEqual(png);
  });
  it("keeps an App prompt's text and attachment together and does not merge independently submitted queued prompts", async () => {
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: "Read" }));
    await attach({ handleAuthorizedMessage: engine }, createCoreServiceRuntime({ queuePolicy: { batchWindowMs: 1000 } }));
    const c = await hub.store.createConversation("owner", ["alpha"], "Atomic prompt", "atomic-prompt");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=", "base64");
    const upload = await hub.attachments.create("owner", { conversationId: c.id, name: "chart.png", mime: "image/png", size: png.length, sha256: createHash("sha256").update(png).digest("hex") });
    await hub.attachments.putChunk("owner", upload.id, 0, png); await hub.attachments.complete("owner", upload.id);
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "atomic-image", text: "Interpret this chart", attachments: [upload.id] });
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "next-request", text: "Separate follow-up", attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
    expect(engine).toHaveBeenCalledTimes(2);
    expect(engine.mock.calls[0]![0].text).toContain("Interpret this chart");
    expect(engine.mock.calls[0]![0].text).not.toContain("Separate follow-up");
    expect(engine.mock.calls[0]![0].files).toHaveLength(1);
    expect(engine.mock.calls[0]![0].files[0]).toContain(`${path.sep}.tarobot-files${path.sep}`);
    expect(engine.mock.calls[0]![0].requestOutputDir).toContain(`${path.sep}.tarobot-out${path.sep}`);
    expect(await readFile(engine.mock.calls[0]![0].files![0]!)).toEqual(png);
    expect(engine.mock.calls[1]![0].text).toContain("Separate follow-up");
    expect(engine.mock.calls[1]![0].files ?? []).toHaveLength(0);
  });
  it("releases old messages after sustained traffic while retaining the recent stream state", async () => {
    const gateway = await attach({ handleAuthorizedMessage: async () => ({ text: "unused" }) });
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Cache pressure", "cache-pressure");
    const first = await gateway.send(conversation.id, { text: "Original cached content" });
    await hub.store.publishBotMessage("alpha", { id: first.messageId, conversationId: conversation.id, blocks: [{ type: "text", text: "Current Hub content" }] });
    let recent = first;
    for (let i = 0; i < 160; i++) recent = await gateway.send(conversation.id, { text: `Recent ${i}` });
    const request = vi.spyOn(gateway.transport, "request");
    try {
      expect((await gateway.fetchMessage(recent.messageId))?.content).toContain("Recent 159");
      expect(request.mock.calls.some(([method]) => method === "fetch")).toBe(false);
      expect((await gateway.fetchMessage(first.messageId))?.content).toContain("Current Hub content");
      expect(request.mock.calls.some(([method]) => method === "fetch")).toBe(true);
    } finally { request.mockRestore(); }
    // This is 160 sequential durable Hub writes, not a latency budget. Leave
    // headroom for the full suite's parallel disk traffic without reducing load.
  }, 20_000);
  it("keeps backlog order when the first quoted message needs a slow parent fetch, while other conversations proceed", async () => {
    const first = await hub.store.createConversation("owner", ["alpha"], "Ordered", "ordered");
    const other = await hub.store.createConversation("owner", ["alpha"], "Independent", "independent");
    const parent = await hub.store.publishBotMessage("alpha", { conversationId: first.id, blocks: [{ type: "text", text: "Reference" }] });
    await hub.store.sendMessage("owner", { conversationId: first.id, clientMsgId: "first", text: "FIRST", replyTo: parent.id, attachments: [] });
    await hub.store.sendMessage("owner", { conversationId: first.id, clientMsgId: "second", text: "SECOND", attachments: [] });
    await hub.store.sendMessage("owner", { conversationId: other.id, clientMsgId: "other", text: "INDEPENDENT", attachments: [] });
    let release!: () => void, fetched = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const request = GatewayTransport.prototype.request;
    const spy = vi.spyOn(GatewayTransport.prototype, "request").mockImplementation(async function (this: GatewayTransport, method, params) {
      if (method === "fetch" && (params as { messageId: string }).messageId === parent.id) { fetched = true; await held; }
      return request.call(this, method, params);
    });
    const seen: string[] = [];
    try {
      await attach({ handleAuthorizedMessage: async (input) => { seen.push(input.text.includes("INDEPENDENT") ? "INDEPENDENT" : input.text.includes("FIRST") ? "FIRST" : "SECOND"); return { text: "done" }; } });
      await until(async () => fetched && seen.includes("INDEPENDENT"));
      expect(seen).not.toContain("SECOND"); release();
      await until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
      expect(seen.filter((text) => text !== "INDEPENDENT")).toEqual(["FIRST", "SECOND"]);
    } finally { release(); spy.mockRestore(); }
  });
  it.each(["native-file", "native-batch", "marker", "directive"])("delivers an external artifact through %s with full access and verifies the Hub's stored bytes", async mode => {
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", approvalMode: "bypass", locale: "en" }));
    const file = path.join(root, "external-artifact.txt"), bytes = Buffer.from(`External artifact via ${mode}`); await writeFile(file, bytes);
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
      if (mode === "marker") return { text: `[send-file:${file}]` };
      if (mode === "directive") return { text: '```tool-call\n' + JSON.stringify({ name: "send.file", payload: { path: file } }) + '\n```' };
      const sent = await input.appPlatformTools!.call({ name: mode === "native-file" ? "app_send_file" : "app_send_batch",
        arguments: mode === "native-file" ? { path: file, kind: "file" } : { artifacts: [{ path: file, kind: "file" }] },
        callId: mode, sessionId: "external-thread", abortSignal: input.abortSignal! });
      expect(JSON.parse(sent.text)).toMatchObject({ delivered: true });
      return { text: "Delivered" };
    });
    const gateway = await attach({ handleAuthorizedMessage: engine });
    const c = await hub.store.createConversation("owner", ["alpha"], "External artifact", `external-${mode}`);
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: `external-${mode}`, text: "发送外置盘文件", attachments: [] });
    await until(async () => engine.mock.calls.length > 0 && (await hub.store.pendingForBot("alpha")).length === 0);
    const files = (await hub.store.snapshot("owner", c.id)).messages.flatMap(message => message.blocks).filter(block => block.type === "file");
    expect(files).toHaveLength(1);
    expect(await gateway.downloadResource(files[0]!.attachmentId)).toEqual(bytes);
  });
  it("publishes a native ten-image gallery and captioned PDF atomically, with exact bytes and no legacy duplicates", async () => {
    const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4r8AAAAASUVORK5CYII=", "base64");
    const images = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const file = path.join(workspace, `image-${i}.png`); await writeFile(file, png);
      return { path: file, kind: "image", caption: `图 ${i + 1}` };
    }));
    const pdf = path.join(workspace, "report.pdf"), pdfBytes = Buffer.from("%PDF-1.4\nFixture\n%%EOF"); await writeFile(pdf, pdfBytes);
    const artifacts = [...images, { path: pdf, kind: "file", caption: "原始文档" }];
    const activity = vi.fn();
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
      const args = { name: "app_send_batch", arguments: { artifacts, caption: "整批说明" }, callId: "native-batch", sessionId: "batch-thread", abortSignal: input.abortSignal!, onActivity: activity };
      const receipt = await input.appPlatformTools!.call(args);
      expect(JSON.parse(receipt.text)).toMatchObject({ delivered: true, files: expect.any(Array) });
      expect(await input.appPlatformTools!.call({ ...args, callId: "repeated-batch" })).toEqual(receipt);
      expect(activity).toHaveBeenCalledTimes(44); // create/status/chunk/complete for each actual upload; replay adds none.
      return { text: artifacts.map((artifact) => `[send-file:${artifact.path}]`).join("\n") };
    });
    const gateway = await attach({ handleAuthorizedMessage: engine });
    const c = await hub.store.createConversation("owner", ["alpha"], "Native batch", "native-batch");
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "batch-input", text: "把图和 PDF 一起发送", attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && engine.mock.calls.length > 0);
    const messages = (await hub.store.snapshot("owner", c.id)).messages;
    const deliveries = messages.filter((message) => message.blocks.some((block) => block.type === "file" || block.type === "card" && block.elements.some((element) => element.type === "image")));
    expect(deliveries).toHaveLength(1);
    const sent = deliveries[0]!; expect(sent.replyTo).toBe(messages.find((message) => message.authorType === "user")!.id);
    expect(blocksText(sent.blocks)).toContain("整批说明"); expect(blocksText(sent.blocks)).toContain("原始文档");
    const card = sent.blocks.find((block) => block.type === "card")!; if (card.type !== "card") throw new Error("missing gallery");
    expect(card.elements.map((element) => element.text)).toEqual(images.map((image) => image.caption));
    for (const image of card.elements) expect(await gateway.downloadResource(image.attachmentId!)).toEqual(png);
    const file = sent.blocks.find((block) => block.type === "file")!; if (file.type !== "file") throw new Error("missing PDF");
    expect(await gateway.downloadResource(file.attachmentId)).toEqual(pdfBytes);
    const events = (await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "file.accepted" && event.metadata?.via === "app_send_batch")).toHaveLength(11);
  });
  it.each(["failure", "cancel"])("keeps a native batch invisible when the second upload cannot finish: %s", async (mode) => {
    const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
    const artifacts = await Promise.all(["one.txt", "two.txt"].map(async (name) => { const file = path.join(workspace, name); await writeFile(file, name); return { path: file, kind: "file" }; }));
    const abort = new AbortController(), originalFetch = globalThis.fetch;
    let completed = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const target = String(url);
      if (target.startsWith(hub.url + "/api/instance/uploads/") && target.endsWith("/complete")) {
        if (mode === "failure" && completed === 1) return new Response("fixture upload failure", { status: 503 });
        const response = await originalFetch(url, options); completed++;
        if (mode === "cancel") abort.abort();
        return response;
      }
      return originalFetch(url, options);
    });
    try {
      const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
        const sent = await input.appPlatformTools!.call({ name: "app_send_batch", arguments: { artifacts }, callId: mode, sessionId: "batch-thread", abortSignal: abort.signal });
        expect(JSON.parse(sent.text)).toMatchObject({ published: false, error: mode === "cancel" ? "turn_ended" : "upload_failed", index: 1 });
        return { text: "The batch did not publish." };
      });
      await attach({ handleAuthorizedMessage: engine });
      const c = await hub.store.createConversation("owner", ["alpha"], "Interrupted batch", mode);
      await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: mode, text: "send batch", attachments: [] });
      await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && engine.mock.calls.length > 0);
      expect(completed).toBe(1);
      expect((await hub.store.snapshot("owner", c.id)).messages.flatMap((message) => message.blocks).some((block) => block.type === "file")).toBe(false);
    } finally { fetchSpy.mockRestore(); }
  });
  it("reuses the real handler and renders a 50k-character answer and 10 tables without Feishu SDK/CLI", async () => {
    const answer = "长文内容".repeat(12_500) + "\n" + Array.from({ length: 10 }, (_, i) => `\n| A${i} | B |\n|---|---|\n| 1 | 2 |\n`).join("\n") + "\nCOMPLETE-END";
    const forbidden = vi.fn(async (): Promise<never> => { throw new Error("real_feishu_forbidden"); });
    const runtime = createCoreServiceRuntime({ createChat: forbidden, createDocument: forbidden, detectLarkCli: forbidden });
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
      expect(channelProfile()).toBe("gateway"); expect(input.instructions).toContain("TaroBird App"); expect(input.instructions).not.toContain("tarocub gdocs");
      await input.onEngineEvent?.({ type: "thinking", text: "Thinking example" });
      await input.onEngineEvent?.({ type: "assistant_text", text: answer, delta: true });
      return { text: answer };
    });
    const gateway = await attach({ handleAuthorizedMessage: engine }, runtime);
    expect("rawClient" in gateway).toBe(false);
    expect("rawClient" in gateway).toBe(false);
    const c = await hub.store.createConversation("owner", ["alpha"], "Long answer", "long");
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "question", text: "Test", attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && engine.mock.calls.length === 1);
    const messages = (await hub.store.snapshot("owner", c.id)).messages.filter((m) => m.authorType === "bot" && m.status !== "deleted");
    const body = messages.map((m) => blocksText(m.blocks)).join("\n");
    expect(body).toContain("长文内容".repeat(12_500)); expect(body).toContain("COMPLETE-END"); expect(body).toContain("| A9 | B |"); expect(forbidden).not.toHaveBeenCalled();
    expect(messages.filter((m) => blocksText(m.blocks).includes("COMPLETE-END"))).toHaveLength(1);
  }, 20_000);
  it("shares active runs with the Feishu surface and delivers stop immediately", async () => {
    let aborted = false; let engineStarted = false; const runtime = createCoreServiceRuntime();
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
      if (engine.mock.calls.length > 1) return { text: "Next completed" };
      engineStarted = true;
      await new Promise<void>(resolve => { if (input.abortSignal?.aborted) { aborted = true; resolve(); } else input.abortSignal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); });
      return { text: "Stopped" };
    });
    await attach({ handleAuthorizedMessage: engine }, runtime);
    const c = await hub.store.createConversation("owner", ["alpha"], "Stop", "stop");
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "start", text: "Start", attachments: [] });
    await until(async () => engineStarted && runtime.activeRuns.has(buildCoreConversationKey(c.id)));
    const queued = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "after-stop", text: "Next after stopped turn", attachments: [] });
    expect(await hub.store.db.get("SELECT dispatched FROM deliveries WHERE message_id=?", [queued.message.id])).toEqual({ dispatched: 0 });
    const started = Date.now(); await channel!.onCall!("stop", { conversationId: c.id });
    await until(async () => aborted); expect(Date.now() - started).toBeLessThan(1000);
    await until(async () => !runtime.activeRuns.has(buildCoreConversationKey(c.id)) && !(await hub.store.pendingForBot("alpha")).length);
    expect(engine).toHaveBeenCalledTimes(2); expect(engine.mock.calls[1]![0].text).toContain("Next after stopped turn");
  });
  it.each(["file", "audio", "video"] as const)("keeps a legacy %s directive's caption and exact bytes in one App message", async (kind) => {
    const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
    const artifact = path.join(workspace, `legacy.${kind === "audio" ? "wav" : kind === "video" ? "mp4" : "txt"}`);
    await writeFile(artifact, "legacy artifact bytes");
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: '```tool-call\n' + JSON.stringify({ name: `send.${kind}`, payload: { path: artifact, caption: "文件与说明同消息" } }) + '\n```' }));
    const gateway = await attach({ handleAuthorizedMessage: engine });
    const c = await hub.store.createConversation("owner", ["alpha"], "Compatibility files", "legacy-files");
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "legacy-question", text: "发送带说明的附件", attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && engine.mock.calls.length > 0);
    const messages = (await hub.store.snapshot("owner", c.id)).messages.filter((m) => m.authorType === "bot" && m.status !== "deleted");
    const delivered = messages.filter((m) => m.blocks.some((b) => b.type === "file" || b.type === "audio"));
    expect(delivered).toHaveLength(1);
    expect(blocksText(delivered[0]!.blocks)).toContain("文件与说明同消息");
    expect(messages.filter((m) => blocksText(m.blocks).includes("文件与说明同消息"))).toHaveLength(1);
    const block = delivered[0]!.blocks.find((b) => b.type === "file" || b.type === "audio")!;
    if (!("attachmentId" in block)) throw new Error("missing attachment");
    expect(await gateway.downloadResource(block.attachmentId)).toEqual(Buffer.from("legacy artifact bytes"));
  });
  it.each([true, false])("delivers through native App tools with one captioned attachment and a verified follow-up receipt (prose=%s)", async (prose) => {
    const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
    const artifact = path.join(workspace, "native.txt"); await writeFile(artifact, "native artifact bytes");
    const activity = vi.fn(() => { if (!prose) throw new Error("observer failed"); });
    let lateTool: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0]["appPlatformTools"];
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
      expect(input.appPlatformTools).toBeDefined(); lateTool = input.appPlatformTools;
      const call = { name: "app_send_file", arguments: { path: artifact, kind: "file", caption: "文件和说明一起发送" }, callId: "native-delivery", sessionId: "fixture-thread", abortSignal: input.abortSignal!, onActivity: activity };
      const first = await lateTool!.call(call); expect(first.isError).toBeUndefined();
      expect(await lateTool!.call(call)).toEqual(first);
      expect(activity).toHaveBeenCalledTimes(4);
      // A model that repeats a legacy marker must not deliver the same file twice.
      await input.onEngineEvent?.({ type: "assistant_text", text: `[send-file:${artifact}]` });
      return { text: `${prose ? "已经发送。\n" : ""}[send-file:${artifact}]` };
    });
    const runtime = createCoreServiceRuntime();
    const gateway = await attach({ handleAuthorizedMessage: engine }, runtime);
    const c = await hub.store.createConversation("owner", ["alpha"], "Native files", "native-files");
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "file-question", text: "文件呢", attachments: [] });
    // An attachment receipt can settle the input before the model turn has
    // finished. Check the actual run lifetime before asserting a late call.
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && engine.mock.calls.length > 0 && runtime.activeRuns.size === 0);
    expect(engine).toHaveBeenCalledTimes(1);
    const messages = (await hub.store.snapshot("owner", c.id)).messages;
    const attachments = messages.filter((message) => message.blocks.some((block) => block.type === "file"));
    expect(attachments).toHaveLength(1); expect(attachments[0]!.replyTo).toBe(messages.find((message) => message.authorType === "user")!.id); expect(blocksText(attachments[0]!.blocks)).toContain("文件和说明一起发送");
    const file = attachments[0]!.blocks.find((block) => block.type === "file")!;
    expect(file.type).toBe("file"); if (file.type !== "file") throw new Error("missing artifact");
    expect(await gateway.downloadResource(file.attachmentId)).toEqual(Buffer.from("native artifact bytes"));
    expect(messages.map((message) => blocksText(message.blocks)).join("\n")).not.toContain("未核实");
    const late = await lateTool!.call({ name: "app_send_file", arguments: { path: artifact, kind: "file" }, callId: "late", sessionId: "fixture-thread", abortSignal: new AbortController().signal });
    expect(late.isError).toBe(true); expect(late.text).toContain("turn_ended");
  });
  it("does not resend a natively delivered file when the engine errors after streaming a legacy marker", async () => {
    const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
    const artifact = path.join(workspace, "already-delivered.txt"); await writeFile(artifact, "native artifact before engine failure");
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
      const sent = await input.appPlatformTools!.call({ name: "app_send_file", arguments: { path: artifact, kind: "file" }, callId: "native-before-error", sessionId: "fixture-thread", abortSignal: input.abortSignal! });
      expect(sent.isError).toBeUndefined();
      await input.onEngineEvent?.({ type: "assistant_text", text: `已经发送。\n[send-file:${artifact}]` });
      throw new Error("fixture engine failed after complete streamed response");
    });
    await attach({ handleAuthorizedMessage: engine });
    const c = await hub.store.createConversation("owner", ["alpha"], "Error after delivery", "native-error");
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "file-question", text: "文件呢", attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && engine.mock.calls.length > 0);
    const messages = (await hub.store.snapshot("owner", c.id)).messages;
    expect(messages.filter((message) => message.blocks.some((block) => block.type === "file"))).toHaveLength(1);
    expect(engine).toHaveBeenCalledTimes(1);
  });
  it.each(["error", "short-final", "repair", "partial-repair"])("retains every native batch member during %s recovery", async (mode) => {
    // These cases exercise path rejection and repair, so select scoped access
    // explicitly rather than relying on the full-access default.
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", approvalMode: "normal", locale: "en" }));
    const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
    const artifacts = await Promise.all(["first.txt", "second.txt"].map(async (name) => { const file = path.join(workspace, name); await writeFile(file, name); return { path: file, kind: "file" }; }));
    const outside = await Promise.all(["outside-a.txt", "outside-b.txt"].map(async (name) => { const file = path.join(root, name); await writeFile(file, name); return file; }));
    const markers = artifacts.map((artifact) => `[send-file:${artifact.path}]`).join("\n");
    const answer = "This report contains the complete analysis and both requested attachments are ready for download.";
    let calls = 0;
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
      calls++;
      if (mode.endsWith("repair") && calls === 1) return { text: "Initial answer.\n" + outside.map((file) => `[send-file:${file}]`).join("\n") };
      const sent = await input.appPlatformTools!.call({ name: "app_send_batch", arguments: { artifacts: mode === "partial-repair" ? artifacts.slice(0, 1) : artifacts }, callId: `batch-${calls}`, sessionId: "recovery-thread", abortSignal: input.abortSignal! });
      expect(sent.isError).toBeUndefined();
      await input.onEngineEvent?.({ type: "assistant_text", text: mode === "partial-repair" ? "Only the first file was repaired." : `${answer}\n${markers}` });
      if (mode === "error") throw new Error("fixture engine failed after batch delivery");
      return { text: mode.endsWith("repair") ? "Repaired." : `Done.\n${markers}` };
    });
    await attach({ handleAuthorizedMessage: engine });
    const c = await hub.store.createConversation("owner", ["alpha"], "Batch recovery", mode);
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "question", text: "Prepare two reports", attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && calls > 0);
    const messages = (await hub.store.snapshot("owner", c.id)).messages;
    expect(messages.filter((message) => message.blocks.some((block) => block.type === "file"))).toHaveLength(1);
    expect(messages.flatMap((message) => message.blocks).filter((block) => block.type === "file")).toHaveLength(mode === "partial-repair" ? 1 : 2);
    expect(messages.map((message) => blocksText(message.blocks)).join("\n").includes("Delivery failed:")).toBe(mode === "partial-repair");
    expect(calls).toBe(mode.endsWith("repair") ? 2 : 1);
  });
  it("does not revive a delivered marker when a short final reply falls back to the stream", async () => {
    const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
    const artifact = path.join(workspace, "streamed.txt"); await writeFile(artifact, "streamed artifact");
    const answer = "This report contains the complete analysis and the requested attachment is ready for download.";
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
      await input.appPlatformTools!.call({ name: "app_send_file", arguments: { path: artifact, kind: "file" }, callId: "stream-fallback", sessionId: "fixture-thread", abortSignal: input.abortSignal! });
      await input.onEngineEvent?.({ type: "assistant_text", text: `${answer}\n[send-file:${artifact}]` });
      return { text: `Done.\n[send-file:${artifact}]` };
    });
    await attach({ handleAuthorizedMessage: engine });
    const c = await hub.store.createConversation("owner", ["alpha"], "Streamed files", "stream-native");
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "question", text: "Prepare a report", attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && engine.mock.calls.length > 0);
    const messages = (await hub.store.snapshot("owner", c.id)).messages;
    expect(engine).toHaveBeenCalledTimes(1);
    expect(messages.filter((message) => message.blocks.some((block) => block.type === "file"))).toHaveLength(1);
    expect(messages.map((message) => blocksText(message.blocks)).join("\n")).toContain(answer);
  });
  it.each([{ repeat: true, repair: true }, { repeat: false, repair: true }, { repeat: false, repair: false }])("counts native repairs and retains earlier receipts across repair attempts: %j", async ({ repeat, repair }) => {
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", approvalMode: "normal", locale: "en" }));
    const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
    const original = path.join(workspace, "original.txt"); await writeFile(original, "already sent");
    const corrected = path.join(workspace, "corrected.txt"); await writeFile(corrected, "corrected artifact");
    const outside = path.join(root, "outside.txt"); await writeFile(outside, "outside workspace");
    let calls = 0;
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
      calls++;
      const artifact = calls === 1 || !repair ? original : corrected;
      const sent = await input.appPlatformTools!.call({ name: "app_send_file", arguments: { path: artifact, kind: "file" }, callId: `repair-${calls}`, sessionId: "fixture-thread", abortSignal: input.abortSignal! });
      expect(sent.isError).toBeUndefined();
      return { text: calls === 1 ? `First answer.\n[send-file:${outside}]` : `Repaired.${repeat ? `\n[send-file:${original}]` : ""}` };
    });
    await attach({ handleAuthorizedMessage: engine });
    const c = await hub.store.createConversation("owner", ["alpha"], "Repair native files", "native-repair");
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "question", text: "Prepare both files", attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && calls > 0);
    const messages = (await hub.store.snapshot("owner", c.id)).messages;
    expect(engine).toHaveBeenCalledTimes(2);
    expect(messages.filter((message) => message.blocks.some((block) => block.type === "file"))).toHaveLength(repair ? 2 : 1);
    expect(messages.map((message) => blocksText(message.blocks)).join("\n").includes("Delivery failed:")).toBe(!repair);
  });
  it("rejects a native publish whose source input already failed", async () => {
    let inputId = "";
    const workspace = path.join(stateDir, "workspace"); await mkdir(workspace);
    const artifact = path.join(workspace, "late.txt"); await writeFile(artifact, "late file");
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async (input) => {
      await until(async () => !!inputId);
      await hub.store.failDelivery("alpha", inputId, "failed");
      const sent = await input.appPlatformTools!.call({ name: "app_send_file", arguments: { path: artifact, kind: "file" }, callId: "late-file", sessionId: "fixture-thread", abortSignal: input.abortSignal! });
      expect(sent.isError).toBe(true);
      return { text: "Not delivered" };
    });
    await attach({ handleAuthorizedMessage: engine });
    const c = await hub.store.createConversation("owner", ["alpha"], "Failed input", "failed-input");
    inputId = (await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "question", text: "Prepare a file", attachments: [] })).message.id;
    await until(async () => engine.mock.results.length > 0);
    await engine.mock.results[0]!.value;
    await channel!.disconnect(); channel = undefined;
    expect((await hub.store.snapshot("owner", c.id)).messages.filter((message) => message.blocks.some((block) => block.type === "file"))).toHaveLength(0);
  });
  it("legacy-worker composer stop cancels attachment bursts, closes their timeline and leaves other conversations alone", async () => {
    const engine = vi.fn(async () => ({ text: "must not run" }));
    const runtime = createCoreServiceRuntime({ queuePolicy: { batchWindowMs: 3000 } });
    // Pull workers keep each submission independent; the old push worker still
    // owns its accepted attachment burst and must retain scoped stop behavior.
    const prototype = GatewayTransport.prototype as unknown as { send(value: any): void }, originalSend = prototype.send;
    const legacyHello = vi.spyOn(prototype, "send").mockImplementation(function (this: GatewayTransport, value: any) {
      originalSend.call(this, value?.type === "instance.hello" ? { ...value, capabilities: value.capabilities.filter((capability: string) => capability !== "prompt-queue.pull.v1") } : value);
    });
    try { await attach({ handleAuthorizedMessage: engine }, runtime); } finally { legacyHello.mockRestore(); }
    const c = await hub.store.createConversation("owner", ["alpha"], "Burst", "burst");
    const another = await hub.store.createConversation("owner", ["alpha"], "Other", "other");
    const otherController = new AbortController();
    runtime.activeRuns.set(buildCoreConversationKey(another.id), { abortController: otherController, startedAt: Date.now() });
    const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=", "base64");
    const upload = await hub.attachments.create("owner", { conversationId: c.id, name: "image.png", mime: "image/png", size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    await hub.attachments.putChunk("owner", upload.id, 0, data); await hub.attachments.complete("owner", upload.id);
    const input = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "burst_image", text: "analyse later", attachments: [upload.id] });
    await until(async () => runtime.pendingBatches.has(buildCoreConversationKey(c.id)));
    expect(await channel!.onCall!("stop", { conversationId: c.id, userId: "owner" })).toEqual({ stopped: true });
    expect(runtime.pendingBatches.size).toBe(0); expect(otherController.signal.aborted).toBe(false);
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
    await new Promise((resolve) => setTimeout(resolve, 3100)); expect(engine).not.toHaveBeenCalled();
    const messages = (await hub.store.snapshot("owner", c.id)).messages;
    expect(messages.some((m) => blocksText(m.blocks).includes("Also cancelled 1 message(s)"))).toBe(true);
    const timeline = (await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { detail: string; metadata?: Record<string, unknown> });
    expect(timeline.some((row) => row.detail === "batch-cancelled" && row.metadata?.messageId === input.message.id)).toBe(true);
    expect(timeline.some((row) => row.metadata?.source === "gateway.stop" && row.metadata.cancelledPendingBurst === 1)).toBe(true);
    await expect(channel!.onCall!("stop", { conversationId: "../invalid" })).rejects.toThrow();
    expect(otherController.signal.aborted).toBe(false);
    runtime.activeRuns.delete(buildCoreConversationKey(another.id));
  });
  it("binds to the existing session record and has no default platform instructions", async () => {
    const sessions = new SessionStore(path.join(stateDir, "session.json"));
    await sessions.upsert({ telegramChatId: 42, conversationKey: "lark:existing", codexSessionId: "native_session", status: "idle", updatedAt: new Date().toISOString() });
    const engine = vi.fn(async () => ({ text: "Bound" })); await attach({ handleAuthorizedMessage: engine });
    const c = await hub.store.createConversation("owner", ["alpha"], "Bind", "bind"); await hub.store.updateConversation("owner", c.id, { sessionId: "native_session" });
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "bound", text: "Continue", attachments: [] });
    await until(async () => engine.mock.calls.length > 0 && (await hub.store.pendingForBot("alpha")).length === 0);
    expect((await sessions.findByConversationKey(buildCoreConversationKey(c.id)))?.codexSessionId).toBe("native_session");
    expect(await sessions.findByChatId(stableCoreNumericId(buildCoreConversationKey(c.id)))).not.toBeNull();
    expect(larkAgentInstructions()).toBe("");
    expect(gatewayAgentInstructions().length).toBeLessThan(3400); expect(gatewayAgentInstructions()).not.toContain("Lark cards do not render LaTeX");
  });
  it.each(["missing", "corrupt", "interrupted", "legacy"])("explains a %s binding failure once and lets an owner clear it without invoking the model", async (mode) => {
    const engine = vi.fn(async () => ({ text: "Recovered conversation" })); await attach({ handleAuthorizedMessage: engine });
    const c = await hub.store.createConversation("owner", ["alpha"], "Recover", "recover");
    const bound = await hub.store.updateConversation("owner", c.id, { sessionId: "missing_native" });
    const file = path.join(stateDir, "gateway-bindings", `${createHash("sha256").update(buildCoreConversationKey(c.id)).digest("hex")}.json`);
    const receipt = mode === "corrupt" ? "corrupt receipt" : JSON.stringify({ bindingId: bound.bindingId, state: "applying" });
    if (mode === "corrupt" || mode === "interrupted") { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, receipt); }
    if (mode === "legacy") await hub.store.db.run("UPDATE conversations SET binding_id=NULL WHERE id=?", [c.id]);
    const input = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "blocked", text: "must not reach model", attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
    const replies = (await hub.store.snapshot("owner", c.id)).messages.filter((m) => m.authorType === "bot" && m.status !== "deleted");
    expect(replies).toHaveLength(1); expect(replies[0]).toMatchObject({ status: "error", replyTo: input.message.id });
    expect(blocksText(replies[0]!.blocks)).toContain("not sent to the model"); expect(engine).not.toHaveBeenCalled();
    const timeline = (await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(timeline).toContainEqual(expect.objectContaining({ type: "turn.completed", outcome: "error", metadata: expect.objectContaining({ messageId: input.message.id, phase: "conversation-prepare" }) }));
    await hub.store.updateConversation("owner", c.id, { sessionId: null, expectedBindingId: mode === "legacy" ? null : bound.bindingId });
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "reset_after_clear", text: "/reset", attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0); expect(engine).not.toHaveBeenCalled();
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "after_clear", text: "new request", attachments: [] });
    await until(async () => engine.mock.calls.length === 1 && (await hub.store.pendingForBot("alpha")).length === 0);
    if (mode === "corrupt" || mode === "interrupted") expect(await readFile(file, "utf8")).toBe(receipt);
  });
  it("applies a UI binding once, preserves the previous session and respects resume, detach and reset after reconnect", async () => {
    const sessions = new SessionStore(path.join(stateDir, "session.json")), calls: string[] = [];
    const adapter: CodexAdapter = { createSession: vi.fn(), validateExternalSession: async (sessionId) => ({ sessionId, cwd: stateDir }), sendUserMessage: async (sessionId) => { const resolved = sessionId.startsWith("telegram-") ? `native_fresh_${calls.length}` : sessionId; calls.push(resolved); return { text: "reply", sessionId: resolved }; } };
    const access: AccessStoreLike = { load: async () => ({ multiChat: true, policy: "allowlist", allowlist: [], pairedUsers: [], pendingPairs: [] }), issuePairingCode: async () => { throw new Error("unused"); } };
    const bridge = new Bridge(access, new SessionManager(sessions, adapter), adapter);
    await attach(bridge);
    const c = await hub.store.createConversation("owner", ["alpha"], "Binding lifecycle", "binding-lifecycle"), key = buildCoreConversationKey(c.id);
    let turn = 0;
    const send = async (text: string) => { await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: `binding_${++turn}`, text, attachments: [] }); await until(async () => (await hub.store.pendingForBot("alpha")).length === 0); };
    await send("original"); const original = calls.at(-1)!;
    await sessions.upsert({ telegramChatId: 42, conversationKey: "lark:existing", codexSessionId: "native_source", resume: null, status: "idle", updatedAt: new Date().toISOString() });
    await hub.store.updateConversation("owner", c.id, { sessionId: "native_source" });
    await send("bound"); expect(calls.at(-1)).toBe("native_source");
    expect((await sessions.findByConversationKey(key))?.suspendedPrevious?.sessionId).toBe(original);
    await send("/detach");
    expect((await sessions.findByConversationKey(key))?.codexSessionId, (await hub.store.snapshot("owner", c.id)).messages.map((m) => blocksText(m.blocks)).join("\n")).toBe(original);
    await channel!.disconnect(); channel = undefined; await attach(bridge);
    await send("after detach and reconnect"); expect(calls.at(-1)).toBe(original);
    await send("/resume thread native_other"); await send("after resume"); expect(calls.at(-1)).toBe("native_other");
    await send("/detach"); await send("after second detach"); expect(calls.at(-1)).toBe(original);
    await hub.store.updateConversation("owner", c.id, { sessionId: "native_source" });
    await send("explicitly bind the same target again"); expect(calls.at(-1)).toBe("native_source");
    await send("/reset"); await send("fresh after reset"); expect(calls.at(-1)).not.toBe("native_source"); expect(calls.at(-1)).not.toBe(original);
    expect((await sessions.findByConversationKey("lark:existing"))?.codexSessionId).toBe("native_source");
  }, 20_000);
  it.each(["codex", "claude"])("detaches a UI-selected %s session from a previously unbound conversation", async (engine) => {
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale: "en" }));
    const sessions = new SessionStore(path.join(stateDir, "session.json"));
    await sessions.upsert({ telegramChatId: 42, conversationKey: "lark:source", codexSessionId: "source_session", resume: null, status: "idle", updatedAt: new Date().toISOString() });
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: async (sessionId) => ({ text: "reply", sessionId }) };
    const access: AccessStoreLike = { load: async () => ({ multiChat: true, policy: "allowlist", allowlist: [], pairedUsers: [], pendingPairs: [] }), issuePairingCode: async () => { throw new Error("unused"); } };
    await attach(new Bridge(access, new SessionManager(sessions, adapter), adapter));
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Empty destination", `empty_${engine}`), key = buildCoreConversationKey(conversation.id);
    await hub.store.updateConversation("owner", conversation.id, { sessionId: "source_session" });
    for (const [id, text] of [["bound", "Continue"], ["detach", "/detach"]]) {
      await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: `${engine}_${id}`, text: text!, attachments: [] });
      await until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
    }
    expect(await sessions.findByConversationKey(key)).toBeNull();
    expect((await sessions.findByConversationKey("lark:source"))?.codexSessionId).toBe("source_session");
  });
  it("applies a pending binding inside the turn queue, never in the middle of an active turn", async () => {
    const sessions = new SessionStore(path.join(stateDir, "session.json")), runtime = createCoreServiceRuntime();
    let release!: () => void, started = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: async (sessionId, input) => { if (input.text.includes("HOLD_SESSION")) { started = true; await held; } return { text: "done", sessionId: sessionId.startsWith("tarobot-") ? "original" : sessionId }; } };
    const access: AccessStoreLike = { load: async () => ({ multiChat: true, policy: "allowlist", allowlist: [], pairedUsers: [], pendingPairs: [] }), issuePairingCode: async () => { throw new Error("unused"); } };
    const bridge = new Bridge(access, new SessionManager(sessions, adapter), adapter);
    const surface = bridge.createAuthenticatedSurface();
    const steer = vi.spyOn(surface, "steerActiveTurn").mockResolvedValue(true);
    vi.spyOn(bridge, "createAuthenticatedSurface").mockReturnValue(surface);
    await attach(bridge, runtime);
    const c = await hub.store.createConversation("owner", ["alpha"], "Queued binding", "queued-binding"), key = buildCoreConversationKey(c.id);
    const send = (text: string) => hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: text, text, attachments: [] });
    await send("first"); await until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
    await sessions.upsert({ telegramChatId: 42, conversationKey: "lark:source", codexSessionId: "source", status: "idle", updatedAt: new Date().toISOString() });
    try {
      await send("HOLD_SESSION"); await until(async () => started);
      await hub.store.updateConversation("owner", c.id, { sessionId: "source" });
      const queued = await send("queued");
      await until(async () => (await hub.store.db.serial(() => hub.store.db.get<{ dispatched: number }>("SELECT dispatched FROM deliveries WHERE message_id=? AND bot_id='alpha'", [queued.message.id])))?.dispatched === 0);
      expect(runtime.chatQueue.pendingCount(key)).toBe(0);
      expect((await sessions.findByConversationKey(key))?.codexSessionId).toBe("original");
      expect(steer).not.toHaveBeenCalled();
    } finally { release(); }
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
    expect((await sessions.findByConversationKey(key))?.codexSessionId).toBe("source");
    expect((await sessions.findByConversationKey(key))?.suspendedPrevious?.sessionId).toBe("original");
  });
  it("persists explicit mentions across restart and never broadcasts unmentioned group input, even to a listen-all worker", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('beta','Beta',?)", [hashSecret("beta-key")]);
    const conversation = await hub.store.createConversation("owner", ["alpha", "beta"], "Group", "group");
    await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "mention-beta", text: "@beta only", mentions: ["beta"], attachments: [] });
    await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "mention-alpha", text: "@alpha only", mentions: ["alpha"], attachments: [] });
    await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "unmentioned", text: "Anyone?", attachments: [] });
    await hub.close(); hub = await HubServer.start({ stateDir: path.join(root, "hub") });
    // Owner rule (group discussion modes): an unmentioned group message is
    // transcript only; it is never queued for any Bot.
    expect((await hub.store.pendingForBot("alpha")).map((m) => [m.clientMsgId, m.mentions])).toEqual([["mention-alpha", ["alpha"]]]);
    const engine = vi.fn(async () => ({ text: "Group response" })); await attach({ handleAuthorizedMessage: engine });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
    expect(engine).toHaveBeenCalledTimes(1);
    await channel!.disconnect(); channel = undefined;
    await attach({ handleAuthorizedMessage: engine }, createCoreServiceRuntime(), false);
    const listenAll = await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "listen-all", text: "Listen all enabled", attachments: [] });
    expect(await hub.store.db.all("SELECT * FROM deliveries WHERE message_id=?", [listenAll.message.id])).toEqual([]);
    await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "listen-all-mention", text: "@alpha again", mentions: ["alpha"], attachments: [] });
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && engine.mock.calls.length === 2);
    expect(engine).toHaveBeenCalledTimes(2);
    expect((await hub.store.pendingForBot("beta")).map((m) => m.clientMsgId)).not.toContain("mention-alpha");
  });
  it("reuses one Bot configuration while new chats and group topics create distinct native sessions", async () => {
    const sessions = new SessionStore(path.join(stateDir, "session.json"));
    const calls: string[] = [];
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: async (sessionId) => { calls.push(sessionId); return { text: "isolated reply", sessionId }; } };
    const access: AccessStoreLike = { load: async () => ({ multiChat: true, policy: "allowlist", allowlist: [], pairedUsers: [], pendingPairs: [] }), issuePairingCode: async () => { throw new Error("unused"); } };
    await attach(new Bridge(access, new SessionManager(sessions, adapter), adapter));
    const direct = await hub.store.createConversation("owner", ["alpha"], "First", "first");
    const another = await hub.store.createConversation("owner", ["alpha"], "Second", "second");
    const group = await hub.store.createConversation("owner", ["alpha"], "Group", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "Topic", "topic", { parentId: group.id });
    for (const c of [direct, another, group, topic, topic]) {
      const count = calls.length;
      await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: `turn_${count}`, text: "hello", attachments: [], mentions: ["alpha"] });
      await until(async () => calls.length > count && (await hub.store.pendingForBot("alpha")).length === 0);
    }
    expect(new Set(calls.slice(0, 4)).size).toBe(4); expect(calls[4]).toBe(calls[3]);
    expect(await hub.store.bots("owner")).toHaveLength(1);
  });
  it("serializes real Feishu and Gateway handlers bound to one engine session", async () => {
    const sessions = new SessionStore(path.join(stateDir, "session.json")); const nativeSession = `shared_${randomBytes(8).toString("hex")}`;
    const feishuKey = "lark:fixture_chat"; const chatId = stableCoreNumericId(feishuKey); const userId = stableCoreNumericId("user:fixture_user");
    await sessions.upsert({ telegramChatId: chatId, conversationKey: feishuKey, codexSessionId: nativeSession, status: "idle", updatedAt: new Date().toISOString() });
    const access: AccessStoreLike = { load: async () => ({ multiChat: true, policy: "allowlist", allowlist: [chatId, userId], pairedUsers: [], pendingPairs: [] }), issuePairingCode: async () => { throw new Error("pairing_not_expected"); } };
    let release: () => void = () => undefined; const held = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = []; let active = 0; let maximum = 0;
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: async (sessionId, input) => {
      expect(sessionId).toBe(nativeSession); started.push(input.text); active++; maximum = Math.max(maximum, active);
      try { if (started.length === 1) await held; return { text: `Done ${started.length}` }; } finally { active--; }
    } };
    const bridge = new Bridge(access, new SessionManager(sessions, adapter), adapter); const runtime = createCoreServiceRuntime(); await attach(bridge, runtime);
    let index = 0; const feishu: CoreChannelLike = { send: async () => ({ messageId: `feishu_fixture_${++index}` }), stream: async () => ({ messageId: "unused" }), updateCard: async () => undefined, downloadResource: async () => Buffer.alloc(0) };
    const c = await hub.store.createConversation("owner", ["alpha"], "Shared session", "create"); await hub.store.updateConversation("owner", c.id, { sessionId: nativeSession });
    const gatewayAccess = { chatId: stableCoreNumericId(`lark:${c.id}`), userId: stableCoreNumericId("user:gwuser_owner"), chatType: "private" };
    expect((await bridge.checkAccess(gatewayAccess)).kind).toBe("deny");
    const first = handleCoreMessage({ channel: feishu, bridge, runtime, stateDir, message: { messageId: "feishu_input", chatId: "fixture_chat", chatType: "p2p", senderId: "fixture_user", content: "Feishu first", rawContentType: "text", resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now() } });
    try {
      await until(async () => started.length === 1);
      await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "gateway_second", text: "Gateway second", attachments: [] });
      await until(async () => !!runtime.activeRuns.get(`lark:${c.id}`));
      await new Promise((resolve) => setTimeout(resolve, 80)); expect(started).toEqual([expect.stringContaining("Feishu first")]);
      release(); await first;
      await until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
      expect(started).toEqual([expect.stringContaining("Feishu first"), expect.stringContaining("Gateway second")]); expect(maximum).toBe(1);
      expect((await sessions.findByConversationKey(`lark:${c.id}`))?.codexSessionId).toBe(nativeSession);
      expect((await bridge.checkAccess(gatewayAccess)).kind).toBe("deny");
    } finally { release(); await first; }
  });
  it("sends opted-in forwards as reference text with nested image resources, without running a forwarded slash command", async () => {
    const calls: { text: string; files: string[] }[] = [];
    await attach({ handleAuthorizedMessage: async (input) => { calls.push({ text: input.text, files: input.files }); return { text: "Forward read" }; } });
    const source = await hub.store.createConversation("owner", ["alpha"], "Source", "source");
    const target = await hub.store.createConversation("owner", ["alpha"], "Target", "target", { type: "group" });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=", "base64");
    const attachmentId = await hub.attachments.importForBot("alpha", { conversationId: source.id, name: "chart.png", mime: "image/png", size: png.length, sha256: createHash("sha256").update(png).digest("hex") }, png);
    const original = await hub.store.publishBotMessage("alpha", { conversationId: source.id, blocks: [{ type: "text", text: "/new" }, { type: "card", elements: [{ type: "column", children: [{ type: "image", attachmentId }] }] }] });
    await hub.attachments.forward("owner", { v: 1, type: "message.forward", clientMsgId: "quiet", conversationId: target.id, sourceMessageId: original.id });
    expect(await hub.store.pendingForBot("alpha")).toHaveLength(0);
    await hub.attachments.forward("owner", { v: 1, type: "message.forward", clientMsgId: "reply", conversationId: target.id, sourceMessageId: original.id, mentions: ["alpha"] });
    await until(async () => calls.length === 1 && (await hub.store.pendingForBot("alpha")).length === 0);
    expect(calls[0]!.text).toContain("[Forwarded message from Alpha · Source]"); expect(calls[0]!.text).toContain("/new"); expect(calls[0]!.files).toHaveLength(1);
  });
  it("delivers ten images plus a PDF and carries quoted attachments into the next engine turn", async () => {
    const received: { text: string; files: string[] }[] = [];
    await attach({ handleAuthorizedMessage: async (input) => { received.push({ text: input.text, files: input.files }); return { text: "Files received" }; } });
    const c = await hub.store.createConversation("owner", ["alpha"], "Attachments", "attachments");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=", "base64");
    const stream = "BT /F1 12 Tf 30 100 Td (Document example) Tj ET";
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let pdfText = "%PDF-1.4\n"; const offsets = [0]; for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdfText)); pdfText += `${i + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = Buffer.byteLength(pdfText); pdfText += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const pdf = Buffer.from(pdfText);
    const attachments: string[] = [];
    for (let i = 0; i < 11; i++) {
      const data = i < 10 ? png : pdf;
      const input = { conversationId: c.id, name: i < 10 ? `image-${i}.png` : "example.pdf", mime: i < 10 ? "image/png" : "application/pdf", size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
      const { id } = await hub.attachments.create("owner", input); await hub.attachments.putChunk("owner", id, 0, data); await hub.attachments.complete("owner", id); attachments.push(id);
    }
    const first = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "files", text: "Read all attachments", attachments });
    await until(async () => received.length === 1 && (await hub.store.pendingForBot("alpha")).length === 0);
    expect(received[0]!.files).toHaveLength(11); expect(received[0]!.text).toContain("Read all attachments");
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "quoted", text: "Use the same attachments", attachments: [], replyTo: first.message.id });
    await until(async () => received.length === 2 && (await hub.store.pendingForBot("alpha")).length === 0);
    expect(received[1]!.files).toHaveLength(11); expect(received[1]!.text).toContain("Use the same attachments");
  }, 20_000);
});
