import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EngineSideAttachment, EngineSideSession, SideCapability } from "../src/codex/adapter.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { SIDE_INLINE_TEXT_LIMIT } from "../src/core/side-attachments.js";
import { workspaceArtifactRoot } from "../src/core/artifact-paths.js";
import { gatewaySideSessions } from "../src/gateway/side.js";
import type { SideTranscribe } from "../src/gateway/side-audio.js";
import { sideReplySchema, type SideAttachmentRef, type SideView } from "../src/client-protocol/side.js";
import { PartialMediaTranscriptionError } from "../src/runtime/media-transcript.js";

const scope = { conversationId: "gw_chat", userId: "owner", deviceId: "desktop" };
// NUL bytes keep the recording out of the text and image paths, as real audio does.
const voice = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0]);
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "gateway-side-audio-")); await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" })); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const ref = (id: string, name: string, mime: string, bytes: Buffer): SideAttachmentRef => ({ id, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
function fixture({ files = "text", transcribe }: { files?: "text" | "any"; transcribe?: SideTranscribe } = {}) {
  const bodies = new Map<string, Buffer>(), sent: Array<EngineSideAttachment[] | undefined> = [];
  const engine: EngineSideSession = { nativeId: "fork", dispose: vi.fn(async () => {}), send: vi.fn(async input => { sent.push(input.attachments); return { text: "answer" }; }) };
  const native: SideCapability = { context: "native", concurrent: true, readOnly: "enforced", residue: "none", seesInProgressTurn: true, attachments: { images: true, files, paths: false } };
  const bridge = { openSideSession: vi.fn(async () => engine), sideCapability: () => native } as unknown as CoreBridgeLike;
  const download = async (id: string) => (async function* () { yield new Uint8Array(bodies.get(id)!); })();
  const side = gatewaySideSessions(bridge, root, "bot", async () => true, download, transcribe);
  const add = (id: string, name: string, mime: string, bytes: Buffer) => { bodies.set(id, bytes); return ref(id, name, mime, bytes); };
  const open = async () => {
    const opened = await side.call("side.open", { ...scope, requestId: "open" }) as { ok: true; view: SideView };
    await vi.waitFor(async () => expect(((await side.call("side.read", { ...scope, sideId: opened.view.id })) as { view: SideView }).view.phase).toBe("idle"));
    return opened.view.id;
  };
  const exchange = async (sideId: string, requestId: string, done: (status: string) => boolean = status => status !== "running") => {
    let found: SideView["exchanges"][number] | undefined;
    await vi.waitFor(async () => {
      const view = ((await side.call("side.read", { ...scope, sideId })) as { view: SideView }).view;
      found = view.exchanges.find(item => item.id === requestId);
      expect(found && done(found.status) && view.phase === "idle").toBe(true);
    });
    return found!;
  };
  return { side, engine, sent, add, open, exchange, attachmentRoot: workspaceArtifactRoot(root, "input", "gateway") };
}

it("reports audio only to callers that opt in, and only with a transcriber and attachment support", async () => {
  const f = fixture({ transcribe: vi.fn(async () => "") });
  const opted = sideReplySchema.parse(await f.side.call("side.status", { ...scope, attachments: true, audio: true }));
  expect(opted).toMatchObject({ ok: true, capability: { attachments: { files: "text", audio: true } } });
  const plain = sideReplySchema.parse(await f.side.call("side.status", { ...scope, attachments: true }));
  expect(plain.ok && plain.capability?.attachments).toBeDefined();
  expect(plain.ok && plain.capability?.attachments && "audio" in plain.capability.attachments).toBe(false);
  const audioOnly = sideReplySchema.parse(await f.side.call("side.status", { ...scope, audio: true }));
  expect(audioOnly.ok && audioOnly.capability && "attachments" in audioOnly.capability).toBe(false);
  const without = sideReplySchema.parse(await fixture().side.call("side.status", { ...scope, attachments: true, audio: true }));
  expect(without.ok && without.capability?.attachments && "audio" in without.capability.attachments).toBe(false);
  await f.side.close();
});

it("gives a text-only engine the host transcript of the verified private copy, never the recording", async () => {
  const transcribe = vi.fn<SideTranscribe>(async file => {
    expect(await readFile(file)).toEqual(voice);
    return "明天下午三点开会";
  });
  const f = fixture({ transcribe }), audio = f.add("att_voice", "voice-1.m4a", "audio/mp4", voice), sideId = await f.open();
  await f.side.call("side.ask", { ...scope, sideId, requestId: "ask", text: "强制本地转写 这段说了什么", attachments: [audio] });
  expect(await f.exchange(sideId, "ask")).toMatchObject({ status: "complete", answer: "answer", attachments: [{ type: "file", attachmentId: "att_voice", mime: "audio/mp4" }] });
  const [file, options] = transcribe.mock.calls[0]!;
  expect(file.startsWith(path.join(f.attachmentRoot, sideId, "ask"))).toBe(true);
  expect(options).toMatchObject({ messageText: "强制本地转写 这段说了什么", mediaKind: "audio", stateDir: root });
  // Temporary by design: no host transcript cache entry outlives the side handle.
  expect(options).not.toHaveProperty("reuse");
  expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
  const [delivered] = f.sent[0]!;
  expect(delivered).toMatchObject({ attachmentId: "att_voice", name: "voice-1.m4a", mime: "text/plain", kind: "text" });
  expect(delivered!.text).toContain("[Bridge media transcription completed]");
  expect(delivered!.text).toContain("明天下午三点开会");
  expect(delivered!.partial).toBeUndefined();
  expect(delivered!.path).toBe(`${file}.transcript.txt`);
  expect(await readFile(delivered!.path, "utf8")).toBe(delivered!.text);
  await f.side.close();
});

it("keeps a failed or empty transcription retryable without calling the model", async () => {
  const transcribe = vi.fn<SideTranscribe>().mockRejectedValueOnce(new Error("ASR not configured")).mockResolvedValueOnce("   ").mockResolvedValueOnce("可以重试");
  const f = fixture({ transcribe }), audio = f.add("att_voice", "voice-2.webm", "audio/webm", voice), sideId = await f.open();
  for (const requestId of ["broken", "silent"]) {
    await f.side.call("side.ask", { ...scope, sideId, requestId, text: "", attachments: [audio] });
    expect(await f.exchange(sideId, requestId)).toMatchObject({ status: "error", error: "failed" });
    expect(existsSync(path.join(f.attachmentRoot, sideId, requestId))).toBe(false);
  }
  expect(f.engine.send).not.toHaveBeenCalled();
  await f.side.call("side.ask", { ...scope, sideId, requestId: "retry", text: "", attachments: [audio] });
  expect(await f.exchange(sideId, "retry")).toMatchObject({ status: "complete" });
  // webm is also a video container: the transcriber still checks its streams.
  expect(transcribe.mock.calls[2]![1]).toMatchObject({ mediaKind: "unknown" });
  expect(f.sent[0]![0]!.text).toContain("可以重试");
  await f.side.close();
});

it("stops the transcription itself and never reaches the model", async () => {
  let signal: AbortSignal | undefined;
  const transcribe = vi.fn<SideTranscribe>((_file, options) => new Promise((_resolve, reject) => {
    signal = options!.abortSignal; signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  const f = fixture({ transcribe }), audio = f.add("att_voice", "voice-3.m4a", "audio/mp4", voice), sideId = await f.open();
  await f.side.call("side.ask", { ...scope, sideId, requestId: "long", text: "", attachments: [audio] });
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
  await f.side.call("side.stop", { ...scope, sideId });
  expect(await f.exchange(sideId, "long")).toMatchObject({ status: "stopped", error: "cancelled" });
  expect(signal?.aborted).toBe(true);
  expect(f.engine.send).not.toHaveBeenCalled();
  await f.side.close();
});

it("keeps usable partial speech with its gaps marked, within the shared inline budget", async () => {
  const transcribe = vi.fn<SideTranscribe>(async () => { throw new PartialMediaTranscriptionError("第一段内容", [2], 3); });
  const f = fixture({ transcribe }), sideId = await f.open();
  const notes = f.add("att_notes", "notes.txt", "text/plain", Buffer.from("x".repeat(SIDE_INLINE_TEXT_LIMIT - 40)));
  const audio = f.add("att_voice", "meeting.m4a", "audio/mp4", voice);
  await f.side.call("side.ask", { ...scope, sideId, requestId: "gaps", text: "总结", attachments: [notes, audio] });
  expect(await f.exchange(sideId, "gaps")).toMatchObject({ status: "complete" });
  const [, transcript] = f.sent[0]!;
  expect(transcript).toMatchObject({ kind: "text", partial: true });
  expect(transcript!.text).toHaveLength(40);
  const full = await readFile(transcript!.path, "utf8");
  expect(full).toContain("[Bridge media transcription partial]");
  expect(full).toContain("第一段内容");
  await f.side.close();
});

it("leaves video and other binary files on their existing path", async () => {
  const transcribe = vi.fn<SideTranscribe>(async () => "never");
  const f = fixture({ files: "any", transcribe }), clip = f.add("att_clip", "clip.mp4", "video/mp4", voice), sideId = await f.open();
  await f.side.call("side.ask", { ...scope, sideId, requestId: "clip", text: "看看", attachments: [clip] });
  expect(await f.exchange(sideId, "clip")).toMatchObject({ status: "complete" });
  expect(transcribe).not.toHaveBeenCalled();
  expect(f.sent[0]![0]).toMatchObject({ kind: "binary", mime: "video/mp4" });
  await f.side.close();
});

it("without a host transcriber, a text-only engine still refuses audio as before", async () => {
  const f = fixture(), audio = f.add("att_voice", "voice-4.m4a", "audio/mp4", voice), sideId = await f.open();
  await f.side.call("side.ask", { ...scope, sideId, requestId: "old", text: "", attachments: [audio] });
  expect(await f.exchange(sideId, "old")).toMatchObject({ status: "error", error: "attachment_unsupported" });
  expect(f.engine.send).not.toHaveBeenCalled();
  await f.side.close();
});
