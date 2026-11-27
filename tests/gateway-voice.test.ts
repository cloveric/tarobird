import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isActiveTranscriptionMessage } from "../src/client-protocol/voice-presentation.js";
import { blocksText, type CardElement } from "../src/client-protocol/index.js";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { PartialMediaTranscriptionError } from "../src/runtime/media-transcript.js";
import { createDefaultTranscribeVoice } from "../src/core/voice.js";
import { transcribeViaTingwuCloud, CloudAsrEmptyResultError } from "../src/runtime/asr-cloud.js";

// Cloud process behavior is covered by asr-cloud-routing. This Gateway suite
// verifies routing/caption/cancellation contracts without launching a CLI.
vi.mock("../src/runtime/asr-cloud.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime/asr-cloud.js")>(),
  transcribeViaTingwuCloud: vi.fn(),
}));

let root: string, stateDir: string, secret: string, hub: HubServer, gateway: GatewayChannel | undefined;
beforeEach(async () => {
  vi.mocked(transcribeViaTingwuCloud).mockReset().mockResolvedValue("long cloud transcript");
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-voice-")); stateDir = path.join(root, "instance"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  hub = await HubServer.start({ stateDir: path.join(root, "hub") }); secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
});
afterEach(async () => { await gateway?.disconnect(); gateway = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });
const until = async (check: () => Promise<boolean>) => { const end = Date.now() + 10_000; while (!await check()) { if (Date.now() > end) throw new Error("voice_timeout"); await new Promise((resolve) => setTimeout(resolve, 20)); } };
async function attach(transcribeMedia: ReturnType<typeof createDefaultTranscribeVoice>, bridge: CoreBridgeLike, engine: "pi" | "claude" | "codex" | "kimi" | "antigravity" | "deepseek" = "codex") {
  const runtime = createCoreServiceRuntime({ transcribeMedia });
  gateway = await attachGateway({ stateDir, botId: "alpha", secret, engine, url: hub.instanceUrl.replace("http", "ws") + "/instance", bridge, runtime });
  return runtime;
}
async function send(conversationId: string, id: string, name = "voice.webm", mime = "audio/webm", text = "结合这段录音回答", recording = true) {
  const bytes = Buffer.from(`fixture audio ${id}`), upload = await hub.attachments.create("owner", { conversationId, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...(recording ? { recording: true } : {}) });
  await hub.attachments.putChunk("owner", upload.id, 0, bytes); await hub.attachments.complete("owner", upload.id);
  return hub.store.sendMessage("owner", { conversationId, clientMsgId: id, text, attachments: [upload.id] });
}
const drained = () => until(async () => (await hub.store.pendingForBot("alpha")).length === 0);
const transcript = "今天讨论产品的新功能，明天进行验收。";
function transcriber(duration: number, env: NodeJS.ProcessEnv = {}) {
  const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => transcript }));
  const transcribe = createDefaultTranscribeVoice({ httpUrl: "http://127.0.0.1:8412/transcribe", cliPython: "", cliScript: "", fetchImpl: fetchImpl as never,
    watchdog: { recordSuccess: vi.fn(), recordFailure: vi.fn().mockResolvedValue(undefined) } as never,
    execFileImpl: ((file: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string, errout: string) => void) => {
      if (file === "ffprobe") cb(null, args.includes("stream=codec_type") ? JSON.stringify({ streams: [{ codec_type: "audio" }] }) : String(duration), "");
      else if (file === "ffmpeg") void writeFile(args.at(-1)!.replace(/%0\dd/, "000"), Buffer.alloc(160)).then(() => cb(null, "", ""));
      else cb(new Error("unexpected command"), "", "");
    }) as never,
    chunkAfterSeconds: 100_000, maxAudioSeconds: 100_000, env, stateDir });
  return { transcribe, fetchImpl };
}
it("sends a short microphone recording with its caption through shared local ASR and publishes the transcript", async () => {
  const { transcribe, fetchImpl } = transcriber(5), engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "语音处理完成" });
  const hook = vi.fn(transcribe); await attach(hook, { handleAuthorizedMessage: engine });
  const c = await hub.store.createConversation("owner", ["alpha"], "Voice", "create"); await send(c.id, "short", "voice-1791780593981.webm", "audio/webm", "结合这段录音回答", false); await drained();
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(hook.mock.calls[0]![0]).toMatch(/\.webm$/);
  expect(hook.mock.calls[0]![1]).toMatchObject({ messageText: expect.stringContaining("结合这段录音回答"), stateDir, abortSignal: expect.any(AbortSignal) });
  expect(engine).toHaveBeenCalledTimes(1); expect(engine.mock.calls[0]![0].text).toContain(transcript); expect(engine.mock.calls[0]![0].text).toContain("Bridge media transcription completed"); expect(engine.mock.calls[0]![0].text).toContain("结合这段录音回答");
  expect(engine.mock.calls[0]![0].text).not.toContain("<lark_context>");
  const messages = (await hub.store.snapshot("owner", c.id)).messages;
  expect(messages.filter((m) => m.authorType === "user")).toHaveLength(1);
  expect(messages.find((m) => m.authorType === "user")!.blocks.map((b) => b.type)).toEqual(["text", "audio"]);
  expect(messages.some((m) => m.version > 1 && blocksText(m.blocks).includes("音频转写完成") && blocksText(m.blocks).includes(transcript))).toBe(true);
  expect(messages.filter(m => m.authorType === "bot").some(m => blocksText(m.blocks).includes("voice-1791780593981.webm"))).toBe(false);
});
it("routing keywords in forwarded content or attachment names cannot override automatic ASR", async () => {
  const { transcribe, fetchImpl } = transcriber(5, { TINGWU_ASR_DIR: path.join(root, "tingwu") });
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "processed" });
  await attach(transcribe, { handleAuthorizedMessage: engine });
  const source = await hub.store.createConversation("owner", ["alpha"], "Source", "source");
  const target = await hub.store.createConversation("owner", ["alpha"], "Target", "target");
  await send(source.id, "filename", "强制云端转写.webm", "audio/webm", "只总结录音"); await drained();
  expect(transcribeViaTingwuCloud).not.toHaveBeenCalled();
  const original = await send(source.id, "explicit", "voice.webm", "audio/webm", "强制云端转写"); await drained();
  expect(transcribeViaTingwuCloud).toHaveBeenCalledTimes(1);
  await hub.attachments.forward("owner", { v: 1, type: "message.forward", conversationId: target.id, sourceMessageId: original.message.id, clientMsgId: "forward", mentions: ["alpha"] }); await drained();
  expect(transcribeViaTingwuCloud).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(engine).toHaveBeenCalledTimes(3);
});
it("routes a long recording through Tingwu, while explicit local routing bypasses cloud", async () => {
  const dir = path.join(root, "tingwu"), { transcribe, fetchImpl } = transcriber(901, { TINGWU_ASR_DIR: dir });
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "processed" }); await attach(transcribe, { handleAuthorizedMessage: engine });
  const c = await hub.store.createConversation("owner", ["alpha"], "Long voice", "create"); await send(c.id, "long", "voice-1791780593982.m4a", "audio/mp4", "整理会议记录", true); await drained();
  expect(fetchImpl).not.toHaveBeenCalled(); const input = engine.mock.calls[0]![0]; expect(input.text).toContain("long cloud transcript"); expect(input.text).toContain("Bridge media transcription completed");
  expect(transcribeViaTingwuCloud).toHaveBeenCalledWith(expect.stringMatching(/voice-1791780593982\.m4a$/), expect.objectContaining({
    config: expect.objectContaining({ dir, thresholdSeconds: 900 }), jobRootDir: path.join(stateDir, "asr-jobs"), abortSignal: expect.any(AbortSignal),
  }));
  await send(c.id, "local", "voice-1791780593983.m4a", "audio/mp4", "强制本地转写", true); await drained();
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(engine.mock.calls[1]![0].text).toContain(transcript);
  expect(transcribeViaTingwuCloud).toHaveBeenCalledTimes(1);
});
it("keeps missing segment markers and partial text without pretending the transcription is complete", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "partial accepted" });
  await attach(async () => { throw new PartialMediaTranscriptionError("保留下来的内容", [2], 3); }, { handleAuthorizedMessage: engine });
  const c = await hub.store.createConversation("owner", ["alpha"], "Partial", "create"); await send(c.id, "partial"); await drained();
  expect(engine.mock.calls[0]![0].text).toContain("Bridge media transcription partial"); expect(engine.mock.calls[0]![0].text).toContain("保留下来的内容"); expect(engine.mock.calls[0]![0].text).not.toContain("Bridge media transcription completed");
  expect((await hub.store.snapshot("owner", c.id)).messages.some((m) => blocksText(m.blocks).includes("缺失片段: 2 / 3"))).toBe(true);
});
it("rejects an empty voice transcript without invoking the engine", async () => {
  const engine = vi.fn(async () => ({ text: "must not run" })); await attach(async () => "   ", { handleAuthorizedMessage: engine });
  const c = await hub.store.createConversation("owner", ["alpha"], "Empty", "create"); await send(c.id, "empty"); await drained(); expect(engine).not.toHaveBeenCalled();
  expect((await hub.store.snapshot("owner", c.id)).messages.some((m) => blocksText(m.blocks).includes("转写失败"))).toBe(true);
});
it("stops transcription, releases the queue, and keeps later messages usable", async () => {
  const engine = vi.fn(async () => ({ text: "next works" })); let entered = false;
  const runtime = await attach(async (_file, options) => new Promise((_resolve, reject) => { entered = true; options?.abortSignal?.addEventListener("abort", () => reject(new Error("fixture cancelled")), { once: true }); }), { handleAuthorizedMessage: engine });
  const c = await hub.store.createConversation("owner", ["alpha"], "Cancel", "create"); await send(c.id, "cancel"); await until(async () => entered);
  expect((await hub.store.snapshot("owner", c.id)).messages.some((m) => blocksText(m.blocks).includes("正在转写音频"))).toBe(true);
  expect(await gateway!.onCall!("stop", { conversationId: c.id })).toEqual({ stopped: true }); await drained();
  // Stop acknowledges cancellation before the queued command finishes cleanup.
  // Wait for the actual queue release, not just the original delivery receipt.
  await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`)); expect(engine).not.toHaveBeenCalled();
  expect((await hub.store.snapshot("owner", c.id)).messages.some((m) => blocksText(m.blocks).includes("已停止转写"))).toBe(true);
  await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "next", text: "hello", attachments: [] }); await drained(); expect(engine).toHaveBeenCalledTimes(1);
});
it.each([["reply.mp3", "audio/mpeg"], ["reply.m4a", "audio/mp4"], ["reply.wav", "audio/wav"]])("preserves outgoing %s playback metadata and bytes", async (name, mime) => {
  await attach(async () => "unused", { handleAuthorizedMessage: async () => ({ text: "unused" }) });
  const c = await hub.store.createConversation("owner", ["alpha"], "Response", "create"), bytes = Buffer.from("fixture audio reply");
  const sent = await gateway!.send(c.id, { audio: { source: bytes, fileName: name } }); const message = (await hub.store.snapshot("owner", c.id)).messages.find((m) => m.id === sent.messageId)!;
  const block = message.blocks[0]!; expect(block.type).toBe("audio"); if (block.type !== "audio") throw new Error("missing audio");
  const attachment = await hub.attachments.download({ userId: "owner" }, block.attachmentId); expect(attachment.row.mime).toBe(mime); expect(await readFile(attachment.path)).toEqual(bytes);
});
it.each(["file", "video"])("keeps MP4 playback metadata when delivered as %s", async kind => {
  await attach(async () => "unused", { handleAuthorizedMessage: async () => ({ text: "unused" }) });
  const c = await hub.store.createConversation("owner", ["alpha"], "Video", "create");
  const bytes = await readFile("client/e2e/fixtures/media/clip.mp4"), name = "视频_720p.MP4";
  const sent = await gateway!.send(c.id, { [kind]: { source: bytes, fileName: name } });
  const message = (await hub.store.snapshot("owner", c.id)).messages.find(m => m.id === sent.messageId)!;
  const block = message.blocks[0]!; expect(block).toMatchObject({ type: "file", name, mime: "video/mp4" });
  if (block.type !== "file") throw new Error("missing video file");
  const attachment = await hub.attachments.download({ userId: "owner" }, block.attachmentId);
  expect(attachment.row.mime).toBe("video/mp4"); expect(await readFile(attachment.path)).toEqual(bytes);
});
it("passes native MCP approvals and tool results through the same Gateway cards", async () => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const toolName = "mcp__hexin-ifind-ds-stock-mcp__query", toolInput = { query: "fixture query" };
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockImplementation(async (input) => {
    expect(await input.onApprovalRequest!({ engine: "claude", toolName, toolInput })).toMatchObject({ behavior: "allow", scope: "once" });
    await input.onEngineEvent!({ type: "tool_use", toolName, toolInput, toolUseId: "mcp_fixture" });
    await input.onEngineEvent!({ type: "tool_result", toolName, toolUseId: "mcp_fixture", output: "MCP fixture returned 42" });
    await gate; return { text: "MCP completed" };
  });
  const runtime = await attach(async () => "unused", { handleAuthorizedMessage: engine }); const c = await hub.store.createConversation("owner", ["alpha"], "MCP", "create");
  await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "mcp", text: "query", attachments: [] }); await until(async () => !![...runtime.pendingApprovals.values()][0]?.managedCard);
  const cardId = [...runtime.pendingApprovals.values()][0]!.managedCard!.messageId; const card = (await hub.store.snapshot("owner", c.id)).messages.find((m) => m.id === cardId)!;
  const walk = (elements: CardElement[]): CardElement[] => elements.flatMap((e) => [e, ...walk(e.children ?? [])]);
  const button = card.blocks.flatMap((b) => b.type === "card" ? walk(b.elements) : []).find((e) => e.type === "button" && JSON.stringify(e.value).includes("allow_once"))!; expect(button).toBeDefined();
  await gateway!.transport.onCall!("interaction", { receiptId: "approve_mcp", conversationId: c.id, messageId: card.id, userId: "owner", actionId: button.actionId!, value: button.value!, values: {} });
  try { await until(async () => JSON.stringify((await hub.store.snapshot("owner", c.id)).messages).includes("MCP fixture returned 42")); } finally { release(); }
  await drained();
  const body = JSON.stringify((await hub.store.snapshot("owner", c.id)).messages); expect(body).toContain("hexin-ifind-ds-stock-mcp"); expect(body).toContain("MCP completed"); expect(runtime.pendingApprovals.size).toBe(0);
});

it("reports configured HTTP ASR failure without claiming no ASR was configured", async () => {
  const { transcribe, fetchImpl } = transcriber(5);
  fetchImpl.mockResolvedValue({ ok: false, status: 503 } as never);
  await expect(transcribe("fixture.wav")).rejects.toThrow("ASR HTTP server returned 503");
});

it.each(["zh", "en"])("explains cloud-only failure in the real Gateway card and reply (%s)", async locale => {
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale }));
  vi.mocked(transcribeViaTingwuCloud).mockRejectedValue(new Error("PRIVATE_ADAPTER_STDERR /private/audio"));
  const { transcribe, fetchImpl } = transcriber(5, { TINGWU_ASR_DIR: path.join(root, "tingwu"), ASR_CLOUD_MODE: "cloud" });
  const engine = vi.fn(async () => ({ text: "must not run" })); await attach(transcribe, { handleAuthorizedMessage: engine });
  const c = await hub.store.createConversation("owner", ["alpha"], "Cloud failure", "create");
  await send(c.id, `cloud-failure-${locale}`, "voice.m4a", "audio/mp4"); await drained();
  const messages = (await hub.store.snapshot("owner", c.id)).messages.filter(m => m.authorType === "bot");
  const body = messages.map(m => blocksText(m.blocks)).join("\n");
  expect(body).toContain(locale === "en" ? "cloud-only" : "全部云端");
  expect(body).not.toMatch(/较短|shorter|PRIVATE_ADAPTER_STDERR|\/private\/audio/);
  expect(messages.filter(m => blocksText(m.blocks).includes(locale === "en" ? "cloud-only" : "全部云端"))).toHaveLength(2);
  expect(fetchImpl).not.toHaveBeenCalled(); expect(engine).not.toHaveBeenCalled();
});
it("does not transcribe uploaded audio files in the App and passes the file directly to the engine without cloud billing", async () => {
  vi.mocked(transcribeViaTingwuCloud).mockRejectedValue(new Error("cloud must not be called"));
  const { transcribe, fetchImpl } = transcriber(901, { TINGWU_ASR_DIR: root, ASR_CLOUD_MODE: "cloud" });
  const hook = vi.fn(transcribe);
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "file received" });
  await attach(hook, { handleAuthorizedMessage: engine });
  const c = await hub.store.createConversation("owner", ["alpha"], "Uploaded audio", "create");
  await send(c.id, "upload-m4a", "meeting.m4a", "audio/mp4", "保留原文件", false);
  await send(c.id, "upload-mp3", "podcast.mp3", "audio/mpeg", "", false);
  await send(c.id, "upload-wav", "sample.wav", "audio/wav", "", false);
  await send(c.id, "upload-octet", "recording.m4a", "application/octet-stream", "", false);
  await drained();
  expect(hook).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(transcribeViaTingwuCloud).not.toHaveBeenCalled();
  expect(engine).toHaveBeenCalledTimes(4);
  expect(engine.mock.calls[0]![0].files.some((f) => f.endsWith("meeting.m4a"))).toBe(true);
  expect(engine.mock.calls[1]![0].files.some((f) => f.endsWith("podcast.mp3"))).toBe(true);
  expect(engine.mock.calls[2]![0].files.some((f) => f.endsWith("sample.wav"))).toBe(true);
  expect(engine.mock.calls[3]![0].files.some((f) => f.endsWith("recording.m4a"))).toBe(true);
  const messages = (await hub.store.snapshot("owner", c.id)).messages;
  expect(messages.filter((m) => m.authorType === "user").every((m) => m.blocks.some((b) => b.type === "file"))).toBe(true);
  expect(messages.some((m) => blocksText(m.blocks).includes("音频转写") || blocksText(m.blocks).includes("转写未完成"))).toBe(false);
});

it("describes empty cloud output without diagnosing credentials or using local ASR", async () => {
  vi.mocked(transcribeViaTingwuCloud).mockRejectedValue(new CloudAsrEmptyResultError("empty"));
  const { transcribe, fetchImpl } = transcriber(5, { TINGWU_ASR_DIR: root, ASR_CLOUD_MODE: "cloud" });
  const engine = vi.fn(async () => ({ text: "must not run" })); await attach(transcribe, { handleAuthorizedMessage: engine });
  const c = await hub.store.createConversation("owner", ["alpha"], "Empty cloud", "create"); await send(c.id, "empty-cloud", "voice.m4a", "audio/mp4"); await drained();
  const body = (await hub.store.snapshot("owner", c.id)).messages.map(m => blocksText(m.blocks)).join("\n");
  expect(body).toContain("云端未返回转写文字"); expect(body).not.toContain("检查通义配置"); expect(fetchImpl).not.toHaveBeenCalled(); expect(engine).not.toHaveBeenCalled();
});

it("extracts audio for an App .3gp video before calling the cloud adapter", async () => {
  const { transcribe, fetchImpl } = transcriber(5, { TINGWU_ASR_DIR: root, ASR_CLOUD_MODE: "cloud" });
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "video inspected" });
  const runtime = await attach(transcribe, { handleAuthorizedMessage: engine });
  runtime.prepareVideoInput = async () => ({ durationSeconds: 5, framePaths: [], mode: "frames" });
  const c = await hub.store.createConversation("owner", ["alpha"], "Video audio privacy", "create");
  await send(c.id, "3gp-cloud", "clip.3gp", "video/3gpp", "结合这段录音回答", false); await drained();
  expect(transcribeViaTingwuCloud).toHaveBeenCalledTimes(1);
  expect(vi.mocked(transcribeViaTingwuCloud).mock.calls[0]![0]).toMatch(/tarobot-asr-audio-.*audio\.wav$/);
  expect(fetchImpl).not.toHaveBeenCalled(); expect(engine).toHaveBeenCalledTimes(1);
});

it.each([
  ["pi", "zh"],
  ["claude", "en"],
  ["codex", "zh"],
  ["kimi", "en"],
  ["antigravity", "zh"],
  ["deepseek", "en"],
] as const)("publishes active transcription metadata, hides steering targets, stops cleanly and delivers queued input (%s/%s)", async (engineName, locale) => {
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: engineName, locale }));
  await hub.store.db.run("UPDATE bots SET engine=? WHERE id='alpha'", [engineName]);
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "queued reply" });
  let entered = false;
  let aborted = false;
  const runtime = await attach(
    async (_file, options) => new Promise((_resolve, reject) => {
      entered = true;
      options?.abortSignal?.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
    }),
    {
      handleAuthorizedMessage: engine,
      supportsSteering: () => true,
      inFlightSendBehavior: () => (engineName === "pi" || engineName === "claude" || engineName === "antigravity" ? "steer" : undefined),
      nativeInputCapability: async () => (engineName === "claude" ? { sendNow: true, cancel: true, modelReceipt: true } : undefined),
      steerActiveTurn: vi.fn(async () => false),
    },
    engineName,
  );
  const c = await hub.store.createConversation("owner", ["alpha"], "Stop transcription", `stop-${engineName}`);
  await send(c.id, `voice-${engineName}`);
  await until(async () => entered);
  const activeSnap = (await hub.store.snapshot("owner", c.id)).messages;
  const progress = activeSnap.find((m) => m.authorType === "bot" && blocksText(m.blocks).includes(locale === "en" ? "Transcribing audio" : "正在转写音频"));
  expect(progress).toBeDefined();
  expect(progress!.status).toBe("streaming");
  expect(isActiveTranscriptionMessage(progress!)).toBe(true);

  const steerStatus = await gateway!.onCall!("steer.status", { conversationId: c.id, backgroundReview: true }) as { targetId?: string; reason?: string };
  expect(steerStatus.targetId).toBeUndefined();
  expect(steerStatus.reason).toBe("idle");

  // Message typed while transcribing queues behind the active transcription instead of steering or cancelling it.
  await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: `queued-${engineName}`, text: "no transcription", attachments: [] });
  expect(engine).not.toHaveBeenCalled();

  expect(await gateway!.onCall!("stop", { conversationId: c.id })).toEqual({ stopped: true });
  await drained();
  await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));
  expect(aborted).toBe(true);
  const finalSnap = (await hub.store.snapshot("owner", c.id)).messages;
  const stoppedCard = finalSnap.find((m) => m.id === progress!.id)!;
  expect(stoppedCard.status).toBe("complete");
  expect(isActiveTranscriptionMessage(stoppedCard)).toBe(false);
  expect(blocksText(stoppedCard.blocks)).toContain(locale === "en" ? "Transcription stopped" : "已停止转写");
  expect(finalSnap.some((m) => blocksText(m.blocks).includes("准备飞书消息时失败") || blocksText(m.blocks).includes("failed to prepare the Lark message"))).toBe(false);
  expect(finalSnap.some((m) => m.status === "error" || blocksText(m.blocks).includes("未处理完成"))).toBe(false);
  expect(finalSnap.some((m) => blocksText(m.blocks) === "已停止。" || blocksText(m.blocks) === "Stopped.")).toBe(false);
  expect(engine).toHaveBeenCalledTimes(1);
  expect(engine.mock.calls[0]![0].text).toContain("no transcription");
});

it("recovers active transcription cards after worker disconnect mid-transcription and unblocks clearMessages", async () => {
  let entered = false;
  await attach(
    async (_file, options) => new Promise((_resolve, reject) => {
      entered = true;
      options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted on disconnect")), { once: true });
    }),
    { handleAuthorizedMessage: vi.fn(async () => ({ text: "must not run" })) },
  );
  const c = await hub.store.createConversation("owner", ["alpha"], "Disconnect recovery", "disconnect-recovery");
  await send(c.id, "voice-disconnect");
  await until(async () => entered);
  const progress = (await hub.store.snapshot("owner", c.id)).messages.find(m => m.authorType === "bot" && isActiveTranscriptionMessage(m));
  expect(progress).toBeDefined();

  // Disconnect mid-transcription: terminal updateCard cannot land on the stopped transport.
  await gateway!.disconnect();
  gateway = undefined;

  // Reattach a new worker; recovery must settle the orphaned transcription card without rerunning it.
  const nextEngine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "recovered follow-up" });
  const nextTranscribe = vi.fn(async () => "should not rerun");
  await attach(nextTranscribe, { handleAuthorizedMessage: nextEngine });
  await drained();
  await until(async () => !isActiveTranscriptionMessage(await hub.store.messageForUser("owner", progress!.id)));

  const settled = await hub.store.messageForUser("owner", progress!.id);
  expect(settled.status).toBe("complete");
  expect(isActiveTranscriptionMessage(settled)).toBe(false);
  expect(blocksText(settled.blocks)).toContain("转写已中断");
  expect(nextTranscribe).not.toHaveBeenCalled();

  const plan = await hub.store.planClearMessages("owner", c.id);
  expect(plan.throughId).toBeDefined();
  await expect(hub.store.clearMessages("owner", c.id, { throughId: plan.throughId! })).resolves.toMatchObject({ remaining: 0 });
});

it("settles an orphaned active transcription card even when a cached complete receipt exists", async () => {
  const c = await hub.store.createConversation("owner", ["alpha"], "Cached receipt orphan", "cached-orphan");
  const sent = await send(c.id, "voice-cached");
  const progress = await hub.store.publishBotMessage("alpha", {
    conversationId: c.id,
    replyTo: sent.message.id,
    status: "streaming",
    blocks: [{ type: "card", elements: [{ type: "markdown", text: "**正在转写音频…**" }], extra: { appTranscription: { version: 1, active: true, at: Date.now() - 100 } } }],
  });
  await mkdir(path.join(stateDir, "gateway-receipts"), { recursive: true });
  await writeFile(
    path.join(stateDir, "gateway-receipts", createHash("sha256").update(`message:${sent.message.id}`).digest("hex") + ".json"),
    JSON.stringify({ state: "complete", result: { ok: true, result: null } }),
  );

  await attach(async () => "must not rerun", { handleAuthorizedMessage: vi.fn(async () => ({ text: "must not run" })) });
  await drained();
  await until(async () => !isActiveTranscriptionMessage(await hub.store.messageForUser("owner", progress.id)));

  const settled = await hub.store.messageForUser("owner", progress.id);
  expect(settled.status).toBe("complete");
  expect(isActiveTranscriptionMessage(settled)).toBe(false);
  expect(blocksText(settled.blocks)).toContain("转写已中断");
  const plan = await hub.store.planClearMessages("owner", c.id);
  await expect(hub.store.clearMessages("owner", c.id, { throughId: plan.throughId! })).resolves.toMatchObject({ remaining: 0 });
});

it("reports stop confirmation instead of silently dropping it when stop races with transcription completion updateCard on multi-audio messages", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "must not run" });
  const transcribe = vi.fn(async (file: string) => `transcript for ${path.basename(file)}`);
  const runtime = await attach(transcribe, { handleAuthorizedMessage: engine });
  const c = await hub.store.createConversation("owner", ["alpha"], "Multi audio race", "multi-race");

  // Intercept the completion updateCard of the first audio attachment and trigger stop mid-RPC.
  const originalUpdateCard = gateway!.updateCard.bind(gateway!);
  let intercepted = false;
  vi.spyOn(gateway!, "updateCard").mockImplementation(async (messageId, card) => {
    if (!intercepted && JSON.stringify(card).includes("音频转写完成")) {
      intercepted = true;
      await gateway!.onCall!("stop", { conversationId: c.id });
    }
    return originalUpdateCard(messageId, card);
  });

  const ids: string[] = [];
  for (const name of ["first.webm", "second.webm"]) {
    const bytes = Buffer.from(`fixture ${name}`);
    // Microphone recordings: since the recording marker, only these are transcribed (an uploaded audio file is a file).
    const upload = await hub.attachments.create("owner", { conversationId: c.id, name, mime: "audio/webm", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), recording: true });
    await hub.attachments.putChunk("owner", upload.id, 0, bytes);
    await hub.attachments.complete("owner", upload.id);
    ids.push(upload.id);
  }
  await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "two-audio", text: "", attachments: ids });
  await drained();
  await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));

  expect(intercepted).toBe(true);
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(engine).not.toHaveBeenCalled();
  const messages = (await hub.store.snapshot("owner", c.id)).messages.filter(m => m.authorType === "bot");
  expect(messages.some(m => blocksText(m.blocks).includes("音频转写完成"))).toBe(true);
  expect(messages.some(m => blocksText(m.blocks) === "已停止。")).toBe(true);
});

it("aborts cleanly before engine run when stop races with single-audio completion updateCard", async () => {
  const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockResolvedValue({ text: "must not run" });
  const runtime = await attach(async () => "single transcript", { handleAuthorizedMessage: engine });
  const c = await hub.store.createConversation("owner", ["alpha"], "Single audio race", "single-race");

  const originalUpdateCard = gateway!.updateCard.bind(gateway!);
  let intercepted = false;
  vi.spyOn(gateway!, "updateCard").mockImplementation(async (messageId, card) => {
    if (!intercepted && JSON.stringify(card).includes("音频转写完成")) {
      intercepted = true;
      await gateway!.onCall!("stop", { conversationId: c.id });
    }
    return originalUpdateCard(messageId, card);
  });

  await send(c.id, "single-race-msg", "voice-1791780593982.webm", "audio/webm", "");
  await drained();
  await until(async () => !runtime.chatQueue.isBusy(`lark:${c.id}`));

  expect(intercepted).toBe(true);
  expect(engine).not.toHaveBeenCalled();
  const messages = (await hub.store.snapshot("owner", c.id)).messages.filter(m => m.authorType === "bot");
  expect(messages.some(m => blocksText(m.blocks).includes("音频转写完成"))).toBe(true);
  expect(messages.some(m => blocksText(m.blocks) === "已停止。")).toBe(true);
});
