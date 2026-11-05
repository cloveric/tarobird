import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoreSideSessions, SIDE_HANDLE_ATTACHMENT_BYTES, SideSessionError, type SideAttachmentSupport } from "../src/core/side-sessions.js";
import { SIDE_INLINE_TEXT_LIMIT, materializeSideAttachments, releaseSideAttachments, sweepSideAttachments, writeFully } from "../src/core/side-attachments.js";
import type { EngineSideAttachment, EngineSideSession } from "../src/codex/adapter.js";
import { SIDE_ATTACHMENT_IMAGE_BYTES, sideAskSchema, sideReplySchema, type SideAttachmentRef, type SideView } from "../src/client-protocol/side.js";

const scope = { userId: "owner", deviceId: "desktop", conversationId: "main" };
const capability = { supported: true, concurrent: true, liveContext: false, tools: "read-only" as const };
const any: SideAttachmentSupport = { images: true, files: "any", paths: true }, textOnly: SideAttachmentSupport = { images: false, files: "text", paths: false };
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const ref = (id: string, data: Buffer | string, name = `${id}.txt`, mime = "text/plain"): SideAttachmentRef => ({ id, name, mime, size: Buffer.byteLength(data), sha256: sha(data) });
const roots: string[] = [], managers: CoreSideSessions[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.closeAll())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), "side-attachments-")); roots.push(root); return root; }
async function* body(...chunks: Array<Buffer | string>) { for (const chunk of chunks) yield Buffer.from(chunk); }

function fixture(prepared: (refs: SideAttachmentRef[]) => EngineSideAttachment[] | Promise<EngineSideAttachment[]> = refs => refs.map(r => ({ attachmentId: r.id, path: `/copy/${r.id}`, name: r.name, mime: r.mime, size: r.size, kind: "text", text: "content" }))) {
  const handle: EngineSideSession = { nativeId: "temporary", send: vi.fn(async ({ text }) => ({ text: `answer:${text}` })), dispose: vi.fn(async () => {}) };
  const prepareAttachments = vi.fn(async (_scope: unknown, _side: string, _request: string, refs: SideAttachmentRef[], _signal: AbortSignal) => prepared(refs));
  const releaseAttachments = vi.fn(async (_side: string, _request?: string) => {});
  const manager = new CoreSideSessions({ open: async () => handle, beforeAsk: async () => {}, record: async () => {}, prepareAttachments, releaseAttachments }); managers.push(manager);
  const start = async () => { const opened = manager.open(scope, "open", capability); if (!opened.ok || !opened.view) throw new Error("open failed"); const id = opened.view.id; await vi.waitFor(() => expect(manager.read(scope, id).view?.phase).toBe("idle")); return id; };
  const finished = async (id: string): Promise<SideView> => { await vi.waitFor(() => expect(manager.read(scope, id).view?.phase).toBe("idle")); return manager.read(scope, id).view!; };
  return { manager, handle, start, finished, prepareAttachments, releaseAttachments };
}

describe("side attachment protocol", () => {
  it("keeps text-only asks compatible and accepts attachment-only asks", () => {
    expect(sideAskSchema.parse({ botId: "bot", requestId: "r", text: "why?" })).toEqual({ botId: "bot", requestId: "r", text: "why?" });
    expect(sideAskSchema.parse({ botId: "bot", requestId: "r", attachments: ["att_1"] })).toEqual({ botId: "bot", requestId: "r", text: "", attachments: ["att_1"] });
    for (const bad of [{ text: " " }, { text: "x", attachments: [] }, { text: "x", attachments: ["a", "a"] }, { text: "x", attachments: Array.from({ length: 9 }, (_, i) => `a${i}`) }, { text: "x", attachments: ["../etc"] }, { attachments: ["a"], path: "/x" }]) {
      expect(sideAskSchema.safeParse({ botId: "bot", requestId: "r", ...bad }).success).toBe(false);
    }
    // A pre-attachment client parses every reply that does not opt in.
    expect(sideReplySchema.safeParse({ ok: true, capability: { ...capability, attachments: { images: true, files: "any", maxCount: 8, maxFileBytes: 1, maxImageBytes: 1, maxTotalBytes: 1 } } }).success).toBe(true);
  });
});

describe("side attachment lifecycle", () => {
  it("passes verified copies to the engine, shows display metadata and deduplicates by content", async () => {
    const f = fixture(), id = await f.start();
    const refs = [ref("att_a", "alpha", "a.md", "text/markdown"), ref("att_b", "png", "b.png", "image/png")];
    const accepted = f.manager.ask(scope, id, "q1", "", refs, any);
    expect(accepted.ok && accepted.view?.exchanges[0]).toMatchObject({ question: "", attachments: [{ type: "file", attachmentId: "att_a", name: "a.md", size: 5, mime: "text/markdown" }, { type: "image", attachmentId: "att_b", title: "b.png" }] });
    expect(f.manager.ask(scope, id, "q1", "", refs, any).ok).toBe(true);
    expect(() => f.manager.ask(scope, id, "q1", "", [refs[1]!, refs[0]!], any)).toThrow("failed");
    expect(() => f.manager.ask(scope, id, "q1", "", [refs[0]!, { ...refs[1]!, sha256: sha("other") }], any)).toThrow("failed");
    expect(() => f.manager.ask(scope, id, "q1", "text", refs, any)).toThrow("failed");
    const view = await f.finished(id);
    expect(view.exchanges[0]).toMatchObject({ status: "complete" });
    expect(f.prepareAttachments).toHaveBeenCalledTimes(1);
    expect(f.prepareAttachments.mock.calls[0]!.slice(1, 4)).toEqual([id, "q1", refs]);
    expect(vi.mocked(f.handle.send).mock.calls[0]![0].attachments?.map(file => file.path)).toEqual(["/copy/att_a", "/copy/att_b"]);
    await f.manager.close(scope, id);
    expect(f.releaseAttachments).toHaveBeenCalledWith(id);
    expect(vi.mocked(f.handle.dispose).mock.invocationCallOrder[0]!).toBeLessThan(f.releaseAttachments.mock.invocationCallOrder[0]!);
  });
  it("refuses unsupported or oversized attachments without consuming the request ID", async () => {
    const f = fixture(), id = await f.start();
    const image = ref("att_img", "x", "x.png", "image/png");
    expect(() => f.manager.ask(scope, id, "q", "look", [image])).toThrow("attachment_unsupported");
    expect(() => f.manager.ask(scope, id, "q", "look", [image], textOnly)).toThrow("attachment_unsupported");
    expect(() => f.manager.ask(scope, id, "q", "look", [{ ...image, size: SIDE_ATTACHMENT_IMAGE_BYTES + 1 }], any)).toThrow("attachment_too_large");
    expect(() => f.manager.ask(scope, id, "q", "look", Array.from({ length: 3 }, (_, i) => ({ ...ref(`att_${i}`, "x"), size: 60 * 1024 * 1024 })), any)).toThrow("attachment_too_large");
    expect(f.manager.read(scope, id).view?.exchanges).toEqual([]);
    // An SVG is not a native image: content decides, so a text engine may read it.
    expect(f.manager.ask(scope, id, "q", "look", [ref("att_svg", "<svg/>", "x.svg", "image/svg+xml")], textOnly).ok).toBe(true);
    await f.finished(id);
    const big = { ...ref("att_big", "x"), size: 60 * 1024 * 1024 };
    for (let i = 0; i < Math.floor(SIDE_HANDLE_ATTACHMENT_BYTES / big.size); i++) { f.manager.ask(scope, id, `fill${i}`, "q", [{ ...big, id: `att_f${i}` }], any); await f.finished(id); }
    expect(() => f.manager.ask(scope, id, "over", "q", [big], any)).toThrow("attachment_too_large");
  });
  it("rejects content a text-only engine cannot read and marks prefixes it saw only partly", async () => {
    const f = fixture(refs => refs.map(r => ({ attachmentId: r.id, path: `/copy/${r.id}`, name: r.name, mime: r.mime, size: r.size, kind: r.id === "att_bin" ? "binary" : "text", text: "head", partial: r.id === "att_log" }))), id = await f.start();
    f.manager.ask(scope, id, "bin", "read", [ref("att_bin", "%PDF")], textOnly);
    expect((await f.finished(id)).exchanges[0]).toMatchObject({ status: "error", error: "attachment_unsupported" });
    expect(f.handle.send).not.toHaveBeenCalled();
    expect(f.releaseAttachments).toHaveBeenCalledWith(id, "bin");
    f.manager.ask(scope, id, "log", "read", [ref("att_log", "long")], textOnly);
    expect((await f.finished(id)).exchanges[1]).toMatchObject({ status: "complete", partialAttachments: ["att_log"] });
    // With read-only tools the whole copy remains readable, so nothing is partial.
    f.manager.ask(scope, id, "log2", "read", [ref("att_log", "long")], any);
    expect((await f.finished(id)).exchanges[2]).not.toHaveProperty("partialAttachments");
    // Kimi-like: text and images with path access, but binary documents are refused.
    const kimi: SideAttachmentSupport = { images: true, files: "text", paths: true };
    f.manager.ask(scope, id, "log3", "read", [ref("att_log", "long")], kimi);
    expect((await f.finished(id)).exchanges[3]).not.toHaveProperty("partialAttachments");
    f.manager.ask(scope, id, "bin2", "read", [ref("att_bin", "%PDF")], kimi);
    expect((await f.finished(id)).exchanges[4]).toMatchObject({ status: "error", error: "attachment_unsupported" });
    expect(f.handle.send).toHaveBeenCalledTimes(3);
  });
  it("returns budget and removes one question's copies when they never reached the engine", async () => {
    const MB = 1024 * 1024, f = fixture(() => { throw new SideSessionError("attachment_unavailable"); }), id = await f.start();
    const pair = (n: number) => [0, 1].map(i => ({ ...ref(`att_${n}_${i}`, "x"), size: 64 * MB }));
    // Three failed 128 MiB questions exceed the 256 MiB handle budget only if failures were kept.
    for (const n of [0, 1, 2]) {
      expect(f.manager.ask(scope, id, `q${n}`, "read", pair(n), any).ok).toBe(true);
      expect((await f.finished(id)).exchanges.at(-1)).toMatchObject({ status: "error", error: "attachment_unavailable" });
      expect(f.releaseAttachments).toHaveBeenLastCalledWith(id, `q${n}`);
    }
    expect(f.handle.send).not.toHaveBeenCalled();
  });
  it("aborts preparation on close and removes copies written after the close", async () => {
    let finish!: () => void;
    const f = fixture(() => new Promise(resolve => { finish = () => resolve([]); })), id = await f.start();
    f.manager.ask(scope, id, "q", "read", [ref("att_a", "x")], any);
    await vi.waitFor(() => expect(f.prepareAttachments).toHaveBeenCalled());
    const signal = f.prepareAttachments.mock.calls[0]![4];
    const closing = f.manager.close(scope, id);
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    finish(); await closing;
    expect(f.handle.send).not.toHaveBeenCalled();
    expect(f.releaseAttachments).toHaveBeenCalledWith(id);
  });
  it("reports cleanup failure when private copies cannot be removed", async () => {
    const f = fixture(), id = await f.start();
    f.manager.ask(scope, id, "q", "read", [ref("att_a", "x")], any); await f.finished(id);
    f.releaseAttachments.mockRejectedValueOnce(new Error("EPERM"));
    expect(await f.manager.close(scope, id)).toEqual({ ok: false, error: "failed" });
  });
});

describe("materialized side copies", () => {
  it("verifies size and hash, classifies by content and bounds inlined text", async () => {
    const root = await temp(), png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const big = "汉".repeat(SIDE_INLINE_TEXT_LIMIT - 10) + "tail";
    const data: Record<string, Buffer> = { att_png: png, att_txt: Buffer.from("héllo 世界\n"), att_bin: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]), att_big: Buffer.from(big), att_rest: Buffer.from("rest") };
    const refs = [ref("att_png", data.att_png!, "photo", "application/octet-stream"), ref("att_txt", data.att_txt!, "../../notes.md"), ref("att_bin", data.att_bin!, "spec.pdf", "application/pdf"), ref("att_big", data.att_big!, "big.log"), ref("att_rest", data.att_rest!, "rest.txt")];
    const files = await materializeSideAttachments({ directory: path.join(root, "side_abc", "q1"), refs, signal: new AbortController().signal, download: async (attachment) => body(data[attachment]!.subarray(0, 3), data[attachment]!.subarray(3)) });
    expect(files.map(file => [file.attachmentId, file.kind, file.mime])).toEqual([["att_png", "image", "image/png"], ["att_txt", "text", "text/plain"], ["att_bin", "binary", "application/pdf"], ["att_big", "text", "text/plain"], ["att_rest", "text", "text/plain"]]);
    expect(files[1]).toMatchObject({ text: "héllo 世界\n" }); expect(files[1]).not.toHaveProperty("partial");
    // One shared inline budget per question; the rest stays readable by path.
    expect(files[3]!.text!.length).toBe(SIDE_INLINE_TEXT_LIMIT - files[1]!.text!.length);
    expect(files[3]).toMatchObject({ partial: true });
    expect(files[4]).toMatchObject({ text: "", partial: true });
    for (const file of files) { expect(path.dirname(file.path)).toBe(path.join(root, "side_abc", "q1")); expect(await readFile(file.path)).toEqual(data[file.attachmentId]); }
    expect((await stat(files[0]!.path)).mode & 0o077).toBe(0);
  });
  it("truncates long names on whole code points within a portable byte length", async () => {
    const root = await temp(), data = Buffer.from("x");
    const names = ["a" + "😀".repeat(70) + ".md", "第".repeat(118) + ".pdf", "n".repeat(300) + ".txt"];
    const files = await materializeSideAttachments({ directory: path.join(root, "side_n", "q1"), refs: names.map((name, i) => ref(`att_${i}`, data, name)), signal: new AbortController().signal, download: async () => body(data) });
    for (const [i, file] of files.entries()) {
      const leaf = path.basename(file.path);
      // Engines receive the path in JSON: no lone surrogate, and the name on disk is the same string.
      expect((leaf as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
      expect(await readdir(path.dirname(file.path))).toContain(leaf);
      expect(Buffer.byteLength(`${leaf}.part`)).toBeLessThanOrEqual(255);
      expect(leaf.endsWith(path.extname(names[i]!))).toBe(true);
      expect(file.name).toBe(names[i]);
    }
  });
  it("refuses tampered, oversized or failed downloads without leaving partial files", async () => {
    const root = await temp(), directory = path.join(root, "side_x", "q");
    const good = ref("att_a", "abc");
    for (const download of [async () => body("abd"), async () => body("abcd"), async () => body("ab"), async () => { throw new Error("404 /private/path"); }]) {
      await expect(materializeSideAttachments({ directory, refs: [good], signal: new AbortController().signal, download })).rejects.toThrow("attachment_unavailable");
    }
    expect(await readdir(directory)).toEqual([]);
    const controller = new AbortController(); controller.abort(new Error("closed"));
    await expect(materializeSideAttachments({ directory, refs: [good], signal: controller.signal, download: async () => body("abc") })).rejects.toThrow("closed");
  });
  it("completes short writes and refuses a copy whose written bytes differ from the Hub hash", async () => {
    const root = await temp(), payload = Buffer.from("0123456789abcdef".repeat(4096)), refs = [ref("att_a", payload, "a.bin", "application/octet-stream")];
    const probe = await open(path.join(root, "probe"), "w"), proto = Object.getPrototypeOf(probe) as { write: (...args: any[]) => Promise<{ bytesWritten: number }> }; await probe.close();
    const original = proto.write;
    const download = async () => body(payload.subarray(0, 5000), payload.subarray(5000));
    // At most 7 bytes per positional write: the loop must still finish exactly.
    const short = vi.spyOn(proto, "write").mockImplementation(function (this: unknown, buffer: Uint8Array, offset: number, length: number, position: number) { return original.call(this, buffer, offset, Math.min(length, 7), position); });
    try {
      const [file] = await materializeSideAttachments({ directory: path.join(root, "side_w", "q1"), refs, signal: new AbortController().signal, download });
      expect(await readFile(file!.path)).toEqual(payload);
      expect(short.mock.calls.length).toBeGreaterThan(payload.length / 7 - 1);
    } finally { short.mockRestore(); }
    // A write that reports success for bytes it never wrote is caught by re-hashing the copy.
    const lying = vi.spyOn(proto, "write").mockImplementation(async function (this: unknown, buffer: Uint8Array, offset: number, length: number, position: number) { await original.call(this, buffer, offset, 1, position); return { bytesWritten: length }; });
    try {
      await expect(materializeSideAttachments({ directory: path.join(root, "side_w", "q2"), refs, signal: new AbortController().signal, download })).rejects.toThrow("attachment_unavailable");
      expect(await readdir(path.join(root, "side_w", "q2"))).toEqual([]);
    } finally { lying.mockRestore(); }
    await expect(writeFully({ write: async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) }) } as never, Buffer.from("x"), 0)).rejects.toThrow("short_write");
  });

  it("removes only one handle's directory and sweeps only stale side directories", async () => {
    const root = await temp();
    for (const name of ["side_live", "side_stale", "side_other", "msg_main"]) { await mkdir(path.join(root, name, "q"), { recursive: true }); await writeFile(path.join(root, name, "q", "f"), "x"); }
    await mkdir(path.join(root, "side_live", "q2"), { recursive: true });
    await releaseSideAttachments(root, "side_live", "q2");
    await releaseSideAttachments(root, "side_live", "../side_stale");
    expect(await readdir(path.join(root, "side_live"))).toEqual(["q"]);
    await releaseSideAttachments(root, "side_other");
    await releaseSideAttachments(root, "../msg_main");
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    await utimes(path.join(root, "side_stale"), old, old); await utimes(path.join(root, "msg_main"), old, old);
    await sweepSideAttachments(root, 2 * 60 * 60_000);
    expect((await readdir(root)).sort()).toEqual(["msg_main", "side_live"]);
  });
});
