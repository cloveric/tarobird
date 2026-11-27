import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { blocksText, uploadSchema, type Json } from "../src/client-protocol/index.js";
import { sideAttachmentRefSchema } from "../src/client-protocol/side.js";
import { isRecordedVoiceBlock } from "../src/client-protocol/voice-presentation.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { createDefaultTranscribeVoice } from "../src/core/voice.js";
import { attachGateway } from "../src/gateway/service.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import type { HubSideSessions } from "../src/hub/side-sessions.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { Bridge } from "../src/runtime/bridge.js";
import { transcribeViaTingwuCloud } from "../src/runtime/asr-cloud.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { uploadFile } from "../client/src/files.js";
import { markRecordedVoiceFile } from "../client/src/voice-recording-marker.js";
import { fakePiModel, fakePiSpawner } from "./helpers/pi-fake-rpc.js";

vi.mock("../src/runtime/asr-cloud.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime/asr-cloud.js")>(),
  transcribeViaTingwuCloud: vi.fn(),
}));

class FakeStream extends EventEmitter {
  emitData(chunk: string) { this.emit("data", chunk); }
}
class FakeWritable {
  lines: string[] = [];
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) this.lines.push(text);
    callback?.(null);
    return true;
  }
}
class FakeClaudeChild extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill() { return true; }
  frames() { return this.stdin.lines.map((line) => JSON.parse(line) as Record<string, any>); }
  emitJson(value: object) { this.stdout.emitData(JSON.stringify(value) + "\n"); }
}

const access = {
  load: async () => ({ multiChat: true, policy: "allowlist" as const, allowlist: [] as number[], pendingPairs: [], pairedUsers: [] }),
  issuePairingCode: async () => ({ code: "000000" }),
};

const until = async (check: () => Promise<boolean> | boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("audio recording vs uploaded file distinction", () => {
  let root: string;
  let hub: HubServer;
  let gateway: GatewayChannel | undefined;

  beforeEach(async () => {
    vi.mocked(transcribeViaTingwuCloud).mockReset().mockRejectedValue(new Error("cloud ASR must not run"));
    root = await mkdtemp(path.join(os.tmpdir(), "audio-recording-vs-upload-"));
    hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  });

  afterEach(async () => {
    await gateway?.disconnect();
    gateway = undefined;
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });

  async function sendAttachment(conversationId: string, clientMsgId: string, name: string, mime: string, text: string, recording?: boolean) {
    const bytes = Buffer.from(`audio-fixture-${clientMsgId}-${name}`);
    const upload = await hub.attachments.create("owner", {
      conversationId,
      name,
      mime,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(recording !== undefined ? { recording } : {}),
    });
    await hub.attachments.putChunk("owner", upload.id, 0, bytes);
    await hub.attachments.complete("owner", upload.id);
    return hub.store.sendMessage("owner", { conversationId, clientMsgId, text, attachments: [upload.id] });
  }

  function cloudConfiguredLocalTranscriber(stateDir: string) {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => "这是语音录音转写文本" }));
    const transcribe = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      watchdog: { recordSuccess: vi.fn(), recordFailure: vi.fn().mockResolvedValue(undefined) } as never,
      execFileImpl: ((file: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string, errout: string) => void) => {
        if (file === "ffprobe") cb(null, args.includes("stream=codec_type") ? JSON.stringify({ streams: [{ codec_type: "audio" }] }) : "5", "");
        else cb(new Error("unexpected command"), "", "");
      }) as never,
      chunkAfterSeconds: 100_000,
      maxAudioSeconds: 100_000,
      env: { TINGWU_ASR_DIR: path.join(root, "tingwu"), ASR_CLOUD_MODE: "cloud" },
      stateDir,
    });
    return { transcribe, fetchImpl };
  }

  it("delivers uploaded audio files to Pi without transcription while transcribing recordings", async () => {
    const stateDir = path.join(root, "pi-bot");
    const workspace = path.join(stateDir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", workspace, locale: "zh", approvalMode: "bypass" }));
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_bot','Pi Bot',?)", [hashSecret(secret)]);

    const prompts: string[] = [];
    const spawner = fakePiSpawner(() => ({
      model: fakePiModel("anthropic", "claude-sonnet-4-5"),
      onPrompt: (run) => {
        prompts.push(String(run.command.message));
        run.reply("Pi handled input");
        run.finish();
      },
    }));
    const adapter = new PiRpcAdapter({
      launch: { command: "pi", args: [] },
      workspacePath: workspace,
      stateDir,
      configPath: path.join(stateDir, "config.json"),
      childEnv: { PI_CODING_AGENT_DIR: path.join(root, "pi-agent") },
      bridgeExtensionPath: null,
      spawnFn: spawner.spawn,
      killProcessTreeFn: () => undefined,
      queryCatalogFn: async () => ({ models: [], current: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "medium" } }),
      idleSweepIntervalMs: 0,
      startupTimeoutMs: 500,
    });
    const bridge = new Bridge(access, new SessionManager(new SessionStore(path.join(stateDir, "session.json")), adapter), adapter);
    const transcribeHook = vi.fn(async () => "录音转写内容");
    gateway = await attachGateway({
      stateDir,
      botId: "pi_bot",
      secret,
      engine: "pi",
      url: hub.instanceUrl.replace("http", "ws") + "/instance",
      bridge,
      runtime: createCoreServiceRuntime({ transcribeMedia: transcribeHook }),
    });

    const conv = await hub.store.createConversation("owner", ["pi_bot"], "Pi Audio", "pi-audio");
    // 1. Uploaded audio files: .m4a (explicit recording: false), .mp3 (omitted/legacy), and a file named voice-<ts>.m4a (recording: false)
    await sendAttachment(conv.id, "pi-m4a", "meeting.m4a", "audio/mp4", "原样保留附件", false);
    await sendAttachment(conv.id, "pi-mp3", "podcast.mp3", "audio/mpeg", "原样保留mp3");
    await sendAttachment(conv.id, "pi-named-upload", "voice-1791780593981.m4a", "audio/mp4", "这是上传的录音文件", false);
    await until(async () => (await hub.store.pendingForBot("pi_bot")).length === 0 && prompts.length === 3);

    expect(transcribeHook).not.toHaveBeenCalled();
    expect(transcribeViaTingwuCloud).not.toHaveBeenCalled();
    expect(prompts[0]).toContain("Attachment: ");
    expect(prompts[0]).toMatch(/meeting\.m4a/);
    expect(prompts[1]).toMatch(/podcast\.mp3/);
    expect(prompts[2]).toMatch(/voice-1791780593981\.m4a/);
    expect(prompts.every((p) => !p.includes("[Bridge media transcription completed]"))).toBe(true);

    // 2. Recorded voice messages: explicit recording: true and legacy App fallback voice-<ts>.webm
    await sendAttachment(conv.id, "pi-rec", "voice-1791780593999.m4a", "audio/mp4", "", true);
    await sendAttachment(conv.id, "pi-legacy-rec", "voice-1791780594000.webm", "audio/webm", "");
    await until(async () => (await hub.store.pendingForBot("pi_bot")).length === 0 && prompts.length === 5);

    expect(transcribeHook).toHaveBeenCalledTimes(2);
    expect(prompts[3]).toContain("[Bridge media transcription completed]");
    expect(prompts[3]).toContain("录音转写内容");
    expect(prompts[4]).toContain("[Bridge media transcription completed]");

    const messages = (await hub.store.snapshot("owner", conv.id)).messages;
    const userBlocks = messages.filter((m) => m.authorType === "user").map((m) => m.blocks);
    expect(userBlocks[0]!.some((b) => b.type === "file" && b.name === "meeting.m4a")).toBe(true);
    expect(userBlocks[1]!.some((b) => b.type === "file" && b.name === "podcast.mp3")).toBe(true);
    expect(userBlocks[2]!.some((b) => b.type === "file" && b.name === "voice-1791780593981.m4a")).toBe(true);
    expect(userBlocks[3]!.some((b) => b.type === "audio" && b.recording === true)).toBe(true);
    expect(userBlocks[4]!.some((b) => b.type === "audio" && b.name === "voice-1791780594000.webm")).toBe(true);
    await adapter.destroy();
  });

  it("delivers uploaded audio files to Claude Code without transcription while transcribing recordings", async () => {
    const stateDir = path.join(root, "claude-bot");
    const workspace = path.join(stateDir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", workspace, locale: "en", approvalMode: "bypass" }));
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('claude_bot','Claude Bot',?)", [hashSecret(secret)]);

    const children: FakeClaudeChild[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      workspacePath: workspace,
      spawnFn: (() => {
        const child = new FakeClaudeChild();
        children.push(child);
        const origWrite = child.stdin.write.bind(child.stdin);
        let initialized = false;
        child.stdin.write = (chunk: string, cb?: (err?: Error | null) => void) => {
          const ok = origWrite(chunk, cb);
          try {
            const frame = JSON.parse(chunk.toString().trim()) as { type?: string; request_id?: string; request?: { subtype?: string } };
            if (frame.type === "control_request" && frame.request?.subtype === "initialize" && frame.request_id) {
              queueMicrotask(() => {
                child.emitJson({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: {} } });
                child.emitJson({ type: "control_request", request_id: "mcp-list-1", request: { subtype: "mcp_message", server_name: "tarocub_app", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } } });
              });
            }
            if (frame.type === "user") {
              queueMicrotask(() => {
                if (!initialized) {
                  initialized = true;
                  child.emitJson({ type: "system", subtype: "init", session_id: "sess-claude-1" });
                }
                child.emitJson({ type: "assistant", session_id: "sess-claude-1", message: { content: [{ type: "text", text: "Claude ack" }] } });
                child.emitJson({ type: "result", session_id: "sess-claude-1", subtype: "success", is_error: false, result: "Claude ack" });
              });
            }
          } catch { /* ignore */ }
          return ok;
        };
        return child;
      }) as never,
    });
    const bridge = new Bridge(access, new SessionManager(new SessionStore(path.join(stateDir, "session.json")), adapter), adapter);
    const transcribeHook = vi.fn(async () => "Claude recording transcript");
    gateway = await attachGateway({
      stateDir,
      botId: "claude_bot",
      secret,
      engine: "claude",
      url: hub.instanceUrl.replace("http", "ws") + "/instance",
      bridge,
      runtime: createCoreServiceRuntime({ transcribeMedia: transcribeHook }),
    });

    const conv = await hub.store.createConversation("owner", ["claude_bot"], "Claude Audio", "claude-audio");
    const userFrames = () => children[0]?.frames().filter((f) => f.type === "user") ?? [];
    await sendAttachment(conv.id, "cl-wav", "clip.wav", "audio/wav", "Pass this wav file", false);
    await until(async () => (await hub.store.pendingForBot("claude_bot")).length === 0 && userFrames().length >= 1);

    expect(transcribeHook).not.toHaveBeenCalled();
    expect(transcribeViaTingwuCloud).not.toHaveBeenCalled();
    const firstTurnText = JSON.stringify(userFrames()[0]);
    expect(firstTurnText).toContain("Attachment: ");
    expect(firstTurnText).toContain("clip.wav");
    expect(firstTurnText).not.toContain("Bridge media transcription completed");

    await sendAttachment(conv.id, "cl-rec", "voice-1791780594111.m4a", "audio/mp4", "", true);
    await until(async () => (await hub.store.pendingForBot("claude_bot")).length === 0 && userFrames().length >= 2);
    expect(transcribeHook).toHaveBeenCalledTimes(1);
    const secondTurnText = JSON.stringify(userFrames()[1]);
    expect(secondTurnText).toContain("Bridge media transcription completed");
    expect(secondTurnText).toContain("Claude recording transcript");
    await adapter.destroy();
  });

  it("preserves Feishu/Lark forwarded audio file transcription and cloud-only no-retry behavior", async () => {
    const stateDir = path.join(root, "lark-bot");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
    vi.mocked(transcribeViaTingwuCloud).mockRejectedValueOnce(new Error("fixture cloud failure"));
    const { transcribe, fetchImpl } = cloudConfiguredLocalTranscriber(stateDir);
    const engine = vi.fn(async () => ({ text: "notified" }));
    const channel = {
      send: vi.fn(async () => ({ messageId: "m_reply" })),
      stream: vi.fn(async () => ({ messageId: "m_stream" })),
      downloadResource: vi.fn(async () => Buffer.from("forwarded audio")),
    };

    await withChannelProfile("feishu", async () => {
      await handleCoreMessage({
        channel,
        bridge: { handleAuthorizedMessage: engine },
        runtime: createCoreServiceRuntime({ transcribeMedia: transcribe }),
        stateDir,
        message: {
          messageId: "om_fwd",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "帮我看看这段转发录音",
          rawContentType: "file",
          resources: [{ type: "file", fileKey: "fk_fwd", fileName: "forwarded-meeting.m4a" }],
          mentions: [],
          mentionAll: false,
          mentionedBot: true,
          createTime: Date.now(),
        },
      });
    });

    expect(transcribeViaTingwuCloud).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(engine).toHaveBeenCalledTimes(1);
    expect((engine.mock.calls[0] as any[])[0].text).toContain("Do not automatically re-upload");
  });

  it("client uploadFile marks only recorded voice files on capable Hosts and omits the field on older Hosts", async () => {
    const oldUploadSchema = z.object({
      conversationId: uploadSchema.shape.conversationId,
      name: uploadSchema.shape.name,
      size: uploadSchema.shape.size,
      mime: uploadSchema.shape.mime,
      sha256: uploadSchema.shape.sha256,
    }).strict();

    const createPayloads: Array<Record<string, unknown>> = [];
    const makeConnection = (audioRecordingMarkerAvailable: boolean) => ({
      state: { status: "online" as const, audioRecordingMarkerAvailable },
      subscribe: () => () => undefined,
      resume: () => undefined,
      isClosed: false,
      beginFileTransfer: () => () => undefined,
      http: async (url: string, init?: { method?: string; body?: unknown }) => {
        if (url === "/api/uploads" && init?.method === "POST") {
          const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
          createPayloads.push(parsed);
          return { id: `att_${createPayloads.length}` };
        }
        if (url.endsWith("/complete")) return { id: "att_done", sha256: "0".repeat(64), size: 3 };
        if (init?.method === "PUT") return { ok: true };
        return { complete: true, chunks: [0] };
      },
    });

    const recorded = markRecordedVoiceFile(new File([new Uint8Array([1, 2, 3])], "voice-1791780593981.m4a", { type: "audio/mp4" }));
    const uploadedPicker = new File([new Uint8Array([1, 2, 3])], "voice-1791780593981.m4a", { type: "audio/mp4" });
    const uploadedShare = {
      name: "shared.mp3",
      size: 3,
      type: "audio/mpeg",
      readChunk: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
    };
    const uploadedText = new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" });

    const modern = makeConnection(true);
    await uploadFile(modern as never, "conv_1", recorded, () => undefined);
    await uploadFile(modern as never, "conv_1", uploadedPicker, () => undefined);
    await uploadFile(modern as never, "conv_1", uploadedShare, () => undefined);
    await uploadFile(modern as never, "conv_1", uploadedText, () => undefined);
    expect(createPayloads.slice(0, 4).map((p) => p.recording)).toEqual([true, false, false, undefined]);
    expect("recording" in createPayloads[3]!).toBe(false);

    const legacy = makeConnection(false);
    await uploadFile(legacy as never, "conv_1", recorded, () => undefined);
    await uploadFile(legacy as never, "conv_1", uploadedPicker, () => undefined);
    for (const payload of createPayloads.slice(4)) {
      expect("recording" in payload).toBe(false);
      expect(() => oldUploadSchema.parse(payload)).not.toThrow();
    }
  });

  it("isRecordedVoiceBlock uses explicit flag first and falls back only to legacy voice-<timestamp> filenames", () => {
    expect(isRecordedVoiceBlock({ type: "audio", name: "custom.m4a", recording: true })).toBe(true);
    expect(isRecordedVoiceBlock({ type: "audio", name: "voice-1791780593981.m4a", recording: false })).toBe(false);
    expect(isRecordedVoiceBlock({ type: "audio", name: "voice-1791780593981.webm" })).toBe(true);
    expect(isRecordedVoiceBlock({ type: "audio", name: "song.mp3" })).toBe(false);
    expect(isRecordedVoiceBlock({ type: "file", name: "voice-1791780593981.m4a" })).toBe(false);
  });

  it("rejects recording: true on non-audio MIME in uploadSchema and defensively guards HubStore.sendMessage", async () => {
    const base = { conversationId: "conv_1", size: 12, sha256: "a".repeat(64) };
    expect(uploadSchema.safeParse({ ...base, name: "report.pdf", mime: "application/pdf", recording: true }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...base, name: "clip.mp4", mime: "video/mp4", recording: true }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...base, name: "photo.png", mime: "image/png", recording: true }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...base, name: "report.pdf", mime: "application/pdf", recording: false }).success).toBe(true);
    expect(uploadSchema.safeParse({ ...base, name: "voice-1791780593981.m4a", mime: "Audio/mp4", recording: true }).success).toBe(true);

    // Defensive DB guard: even if attachment_recording has 1 for a non-audio MIME, HubStore emits a file block.
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('guard_bot','Guard Bot','fixture')");
    const conv = await hub.store.createConversation("owner", ["guard_bot"], "Guard", "guard-conv");
    await hub.store.db.run("INSERT INTO attachments VALUES('att_pdf',?,'owner',?,12,'application/pdf','report.pdf','att_pdf.blob',1,?)", [conv.id, "a".repeat(64), Date.now()]);
    await hub.store.db.run("INSERT INTO attachment_recording(attachment_id, recording) VALUES('att_pdf', 1)");
    await hub.store.db.run("INSERT INTO attachments VALUES('att_vid',?,'owner',?,12,'video/mp4','clip.mp4','att_vid.blob',1,?)", [conv.id, "b".repeat(64), Date.now()]);
    await hub.store.db.run("INSERT INTO attachment_recording(attachment_id, recording) VALUES('att_vid', 1)");
    const sent = await hub.store.sendMessage("owner", { conversationId: conv.id, clientMsgId: "guard-msg", text: "", attachments: ["att_pdf", "att_vid"] });
    expect(sent.message.blocks).toEqual([
      { type: "file", attachmentId: "att_pdf", name: "report.pdf", size: 12, mime: "application/pdf" },
      { type: "file", attachmentId: "att_vid", name: "clip.mp4", size: 12, mime: "video/mp4" },
    ]);
  });

  it("handles mixed-case Audio/* MIME without misclassifying Audio/webm as video or breaking legacy voice fallback", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('case_bot','Case Bot','fixture')");
    const conv = await hub.store.createConversation("owner", ["case_bot"], "Case Audio", "case-audio");

    const uploadedWebm = await sendAttachment(conv.id, "case-webm", "podcast.webm", "Audio/webm", "保留音频文件", false);
    expect(uploadedWebm.message.blocks.some((b) => b.type === "file" && b.name === "podcast.webm" && b.mime === "Audio/webm")).toBe(true);

    const legacyVoice = await sendAttachment(conv.id, "case-legacy", "voice-1700000000000.m4a", "Audio/mp4", "");
    expect(legacyVoice.message.blocks).toEqual([{ type: "audio", attachmentId: expect.any(String), name: "voice-1700000000000.m4a" }]);

    const stateDir = path.join(root, "case-gateway");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
    const transcribe = vi.fn(async () => "must not run");
    const prepareVideo = vi.fn(async () => ({ durationSeconds: 5, framePaths: [], mode: "frames" as const }));
    const engine = vi.fn(async () => ({ text: "handled" }));
    const channel = {
      profile: "gateway" as const,
      send: vi.fn(async () => ({ messageId: "m_reply" })),
      stream: vi.fn(async () => ({ messageId: "m_stream" })),
      downloadResource: vi.fn(async () => Buffer.from("webm audio bytes")),
    };

    await withChannelProfile("gateway", async () => {
      await handleCoreMessage({
        channel,
        bridge: { handleAuthorizedMessage: engine },
        runtime: createCoreServiceRuntime({ transcribeMedia: transcribe, prepareVideoInput: prepareVideo }),
        stateDir,
        message: {
          messageId: "msg_case_webm",
          chatId: conv.id,
          chatType: "p2p",
          senderId: "gwuser_owner",
          content: "inspect audio",
          rawContentType: "text",
          resources: [{ type: "file", fileKey: "att_case_webm", fileName: "podcast.webm", mime: "Audio/webm" }],
          mentions: [],
          mentionAll: false,
          mentionedBot: true,
          createTime: Date.now(),
        },
      });
    });

    expect(prepareVideo).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(engine).toHaveBeenCalledTimes(1);
    expect((engine.mock.calls[0] as any[])[0].text).not.toContain("[Bridge video prepared]");
  });

  it("queued-message card reports attachment reading instead of media transcription for uploaded audio in App", async () => {
    const stateDir = path.join(root, "queued-gateway");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));

    const runQueued = async (messageId: string, resource: { type: "file" | "audio"; fileKey: string; fileName: string; mime?: string; recording?: boolean }) => {
      const updates: unknown[] = [];
      const transcribe = vi.fn(async () => "转写内容");
      const engine = vi.fn(async () => ({ text: "done" }));
      const runtime = createCoreServiceRuntime({ transcribeMedia: transcribe });
      runtime.queueCards.set(messageId, { messageId: `card_${messageId}` });
      const channel = {
        profile: "gateway" as const,
        send: vi.fn(async () => ({ messageId: "m_reply" })),
        stream: vi.fn(async () => ({ messageId: "m_stream" })),
        updateCard: vi.fn(async (_id: string, card: unknown) => { updates.push(card); }),
        downloadResource: vi.fn(async () => Buffer.from("audio-bytes")),
      };
      await withChannelProfile("gateway", async () => {
        await handleCoreMessage({
          channel,
          bridge: { handleAuthorizedMessage: engine },
          runtime,
          stateDir,
          message: {
            messageId,
            chatId: "conv_q",
            chatType: "p2p",
            senderId: "gwuser_owner",
            content: "处理附件",
            rawContentType: "text",
            resources: [resource],
            mentions: [],
            mentionAll: false,
            mentionedBot: true,
            createTime: Date.now(),
          },
        });
      });
      return { startedCard: JSON.stringify(updates[0] ?? ""), transcribeCalls: transcribe.mock.calls.length, engineCalls: engine.mock.calls.length };
    };

    const uploaded = await runQueued("q_upload", { type: "file", fileKey: "fk_1", fileName: "meeting.m4a", mime: "audio/mp4" });
    expect(uploaded.transcribeCalls).toBe(0);
    expect(uploaded.engineCalls).toBe(1);
    expect(uploaded.startedCard).toContain("正在读取附件");
    expect(uploaded.startedCard).not.toContain("正在转写音视频");

    const nonRecordingAudio = await runQueued("q_nonrec", { type: "audio", fileKey: "fk_2", fileName: "song.mp3", recording: false });
    expect(nonRecordingAudio.transcribeCalls).toBe(0);
    expect(nonRecordingAudio.engineCalls).toBe(1);
    expect(nonRecordingAudio.startedCard).toContain("正在读取附件");
    expect(nonRecordingAudio.startedCard).not.toContain("正在转写音视频");

    const recording = await runQueued("q_rec", { type: "audio", fileKey: "fk_3", fileName: "voice-1791780593981.m4a", recording: true });
    expect(recording.transcribeCalls).toBe(1);
    expect(recording.engineCalls).toBe(1);
    expect(recording.startedCard).toContain("正在转写音视频");
  });

  it("HubServer gates side.ask recording metadata by Gateway instance.hello capability", async () => {
    const legacySecret = randomBytes(32).toString("base64url");
    const modernSecret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('legacy_side','Legacy Side',?)", [hashSecret(legacySecret)]);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('modern_side','Modern Side',?)", [hashSecret(modernSecret)]);
    await hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES('dev_side','owner','dev','web','fixture',0,0)");
    const session = { deviceId: "dev_side", userId: "owner", expiresAt: Date.now() + 3_600_000 };
    const legacyConv = await hub.store.createConversation("owner", ["legacy_side"], "Legacy Side", "legacy-side");
    const modernConv = await hub.store.createConversation("owner", ["modern_side"], "Modern Side", "modern-side");

    const upload = async (conversationId: string, name: string, mime: string, recording?: boolean) => {
      const bytes = Buffer.from(`side-${conversationId}-${name}`);
      const created = await hub.attachments.create("owner", {
        conversationId, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        ...(recording !== undefined ? { recording } : {}),
      });
      await hub.attachments.putChunk("owner", created.id, 0, bytes);
      await hub.attachments.complete("owner", created.id);
      return created.id;
    };

    const legacyTxt = await upload(legacyConv.id, "notes.txt", "text/plain", false);
    const legacyAud = await upload(legacyConv.id, "voice-1791780593981.m4a", "audio/mp4", true);
    const modernTxt = await upload(modernConv.id, "notes.txt", "text/plain", false);
    const modernAud = await upload(modernConv.id, "voice-1791780593981.m4a", "audio/mp4", true);
    const modernUploadAud = await upload(modernConv.id, "meeting.m4a", "audio/mp4", false);

    const legacyAttachmentRefSchema = sideAttachmentRefSchema.omit({ recording: true }).strict();
    const capability = { supported: true, concurrent: true, liveContext: false, tools: "read-only" as const };
    const legacyAskRefs: unknown[] = [];
    const modernAskRefs: unknown[] = [];

    // 1. Simulated pre-PR #161 Gateway (does not advertise attachments.recording.v1 in instance.hello).
    const legacyWs = new WebSocket(hub.instanceUrl.replace("http", "ws") + "/instance");
    await new Promise<void>((resolve, reject) => {
      legacyWs.once("open", () => {
        legacyWs.send(JSON.stringify({ v: 1, type: "instance.hello", capabilities: [], botId: "legacy_side", secret: legacySecret, engine: "codex", model: "", effort: "" }));
      });
      legacyWs.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; id?: string; method?: string; params?: Record<string, unknown> };
        if (frame.type === "instance.ready") resolve();
        if (frame.type === "instance.call" && frame.id) {
          try {
            if (frame.method === "side.open") {
              legacyWs.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, result: { ok: true, view: { id: "side_old", conversationId: legacyConv.id, revision: 0, openedAt: 0, phase: "idle", capability, exchanges: [], omitted: 0 } } }));
            } else if (frame.method === "side.ask") {
              const refs = frame.params!.attachments as unknown[];
              for (const r of refs) legacyAttachmentRefSchema.parse(r);
              legacyAskRefs.push(...refs);
              legacyWs.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, result: { ok: true, view: { id: "side_old", conversationId: legacyConv.id, revision: 1, openedAt: 0, phase: "idle", capability, exchanges: [], omitted: 0 } } }));
            } else {
              legacyWs.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, result: { ok: true } }));
            }
          } catch {
            legacyWs.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, error: "gateway_call_failed" }));
          }
        }
      });
      legacyWs.once("error", reject);
    });

    // 2. Real modern GatewayTransport (advertises attachments.recording.v1 automatically).
    const modernDir = path.join(root, "modern-side-dir");
    await mkdir(modernDir, { recursive: true });
    await writeFile(path.join(modernDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
    const modernTransport = new GatewayTransport({
      url: hub.instanceUrl.replace("http", "ws") + "/instance",
      botId: "modern_side",
      secret: modernSecret,
      stateDir: modernDir,
      engine: "codex",
    });
    modernTransport.onCall = async (method, params): Promise<Json> => {
      if (method === "side.open") return { ok: true, view: { id: "side_new", conversationId: modernConv.id, revision: 0, openedAt: 0, phase: "idle", capability, exchanges: [], omitted: 0 } };
      if (method === "side.ask") {
        const refs = (params as { attachments: unknown[] }).attachments;
        for (const r of refs) sideAttachmentRefSchema.parse(r);
        modernAskRefs.push(...refs);
        return { ok: true, view: { id: "side_new", conversationId: modernConv.id, revision: 1, openedAt: 0, phase: "idle", capability, exchanges: [], omitted: 0 } };
      }
      return { ok: true };
    };
    await modernTransport.connect();
    await until(async () => (await hub.store.bots("owner")).some((b) => b.id === "modern_side" && b.online));

    const sideSessions = (hub as unknown as { sideSessions: HubSideSessions }).sideSessions;
    try {
      expect(await sideSessions.request(session, legacyConv.id, "legacy_side", "side.open", { requestId: "open-old" })).toMatchObject({ ok: true });
      expect(await sideSessions.request(session, legacyConv.id, "legacy_side", "side.ask", { sideId: "side_old", requestId: "ask-old", text: "check", attachments: [legacyTxt, legacyAud] })).toMatchObject({ ok: true });
      expect(legacyAskRefs).toHaveLength(2);
      expect(legacyAskRefs.every((r) => !("recording" in (r as Record<string, unknown>)))).toBe(true);

      expect(await sideSessions.request(session, modernConv.id, "modern_side", "side.open", { requestId: "open-new" })).toMatchObject({ ok: true });
      expect(await sideSessions.request(session, modernConv.id, "modern_side", "side.ask", { sideId: "side_new", requestId: "ask-new", text: "check", attachments: [modernTxt, modernAud, modernUploadAud] })).toMatchObject({ ok: true });
      expect(modernAskRefs.map((r) => (r as { recording?: boolean }).recording)).toEqual([undefined, true, false]);
    } finally {
      legacyWs.close();
      await modernTransport.disconnect();
    }
  });
});
