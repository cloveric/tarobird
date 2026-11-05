import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSideDeliveryTools, SIDE_DELIVERY_FILES, type SideDeliveryBudget } from "../src/gateway/side-delivery.js";
import { GatewayArtifactUploadError, type GatewayChannel } from "../src/gateway/channel.js";
import { gatewaySideSessions } from "../src/gateway/side.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import type { EngineSideSession } from "../src/codex/adapter.js";
import { sideReplySchema } from "../src/client-protocol/side.js";

describe("temporary side delivery", () => {
  let root: string, file: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "side-delivery-"));
    await mkdir(path.join(root, "workspace"));
    file = path.join(root, "workspace", "sample.png");
    await writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64"));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  function fixture(budget: SideDeliveryBudget = { bytes: 0, files: 0 }) {
    const controller = new AbortController(), publish = vi.fn();
    const uploadSideArtifact = vi.fn<GatewayChannel["uploadSideArtifact"]>(async () => "att_one");
    const tools = createSideDeliveryTools({ stateDir: root, conversationId: "conversation_a", signal: controller.signal, budget, publish, channel: { uploadSideArtifact } });
    const call = (args: unknown = { path: file, kind: "image" }, callId = "one", name = "app_send_file") => tools.call({ name, arguments: args, callId, sessionId: "side_native", abortSignal: new AbortController().signal });
    return { controller, publish, uploadSideArtifact, tools, call, budget };
  }
  it("delivers only into its side, deduplicates retries and writes no main receipts or transcript", async () => {
    const f = fixture();
    const [first, duplicate] = await Promise.all([f.call(), f.call()]);
    expect(first).toEqual(duplicate);
    expect(JSON.parse(first.text)).toMatchObject({ delivered: true, destination: "side", temporary: true });
    await f.call(undefined, "another-id");
    expect(f.uploadSideArtifact).toHaveBeenCalledTimes(1); expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.uploadSideArtifact.mock.calls[0]?.[0]).toBe("conversation_a");
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ attachments: [{ type: "image", attachmentId: "att_one", title: "sample.png" }] }));
    expect(await readdir(root)).toEqual(["workspace"]);
    expect((await f.call({ path: file, kind: "image", caption: "changed" })).isError).toBe(true);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it("rejects recipient overrides, credentials and unrelated tools without asking approval", async () => {
    const f = fixture();
    await writeFile(path.join(root, "workspace", ".credentials.json"), "fixture only");
    for (const args of [{ path: file, kind: "image", conversationId: "other" }, { path: path.join(root, "workspace", ".credentials.json"), kind: "file" }]) expect((await f.call(args)).isError).toBe(true);
    expect((await f.call({}, "widget", "app_show_widget")).isError).toBe(true);
    expect(f.uploadSideArtifact).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
    expect(f.tools.instructions).toContain("No additional approval");
  });
  it("keeps long captions separate from filenames and displays a single caption", async () => {
    const f = fixture(), caption = "说明".repeat(2000);
    expect(JSON.parse((await f.call({ path: file, kind: "image", caption })).text).delivered).toBe(true);
    expect(f.publish.mock.calls[0]?.[0]).toMatchObject({ attachments: [{ title: "sample.png", caption }] });
    expect(f.publish.mock.calls[0]?.[0]).not.toHaveProperty("caption");
  });
  it("publishes a batch only after every upload and preserves captions", async () => {
    const f = fixture(); let release!: () => void;
    f.uploadSideArtifact.mockImplementationOnce(async () => "att_one").mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return "att_two"; });
    const pending = f.call({ artifacts: [{ path: file, kind: "image", caption: "first" }, { path: file, kind: "file" }], caption: "overview" }, "batch", "app_send_batch");
    await vi.waitFor(() => expect(f.uploadSideArtifact).toHaveBeenCalledTimes(2));
    expect(f.publish).not.toHaveBeenCalled(); release();
    expect(JSON.parse((await pending).text)).toMatchObject({ delivered: true, destination: "side" });
    expect(f.publish.mock.calls[0]?.[0]).toMatchObject({ caption: "overview", attachments: [{ title: "sample.png", caption: "first" }, { name: "sample.png" }] });
  });
  it("does not publish partial uploads or late results after closing", async () => {
    const failed = fixture();
    failed.uploadSideArtifact.mockResolvedValueOnce("att_one").mockRejectedValueOnce(new GatewayArtifactUploadError("upload_failed"));
    const batch = { artifacts: [{ path: file, kind: "image" }, { path: file, kind: "file" }] };
    expect((await failed.call(batch, "batch", "app_send_batch")).isError).toBe(true);
    expect(failed.publish).not.toHaveBeenCalled(); expect(failed.budget).toEqual({ bytes: 0, files: 0 });
    const late = fixture(); let release!: () => void;
    late.uploadSideArtifact.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return "att_late"; });
    const result = late.call(); await vi.waitFor(() => expect(late.uploadSideArtifact).toHaveBeenCalled());
    late.controller.abort(); release(); expect((await result).isError).toBe(true); expect(late.publish).not.toHaveBeenCalled();
    expect((await late.call(undefined, "again")).isError).toBe(true);
  });
  it("reserves handle capacity before parallel uploads", async () => {
    const f = fixture({ bytes: 0, files: SIDE_DELIVERY_FILES - 1 }); let release!: () => void;
    f.uploadSideArtifact.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return "att_one"; });
    const pending = f.call(); await vi.waitFor(() => expect(f.uploadSideArtifact).toHaveBeenCalledTimes(1));
    expect((await f.call({ path: file, kind: "image", caption: "distinct" }, "two")).isError).toBe(true);
    release(); expect((await pending).isError).toBeUndefined(); expect(f.budget.files).toBe(SIDE_DELIVERY_FILES);
  });
  it("uses the Bot's configured workspace for both the native side and delivery", async () => {
    const workspace = path.join(root, "custom-project"); await mkdir(workspace);
    const output = path.join(workspace, "chart.png"); await writeFile(output, await readFile(file));
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", workspacePath: workspace }));
    const uploadSideArtifact = vi.fn<GatewayChannel["uploadSideArtifact"]>(async () => "att_custom");
    const engine: EngineSideSession = { nativeId: "side", dispose: async () => {}, send: async input => {
      const result = await input.appPlatformTools!.call({ name: "app_send_file", arguments: { path: output, kind: "image" }, callId: "custom", sessionId: "side", abortSignal: input.abortSignal });
      expect(JSON.parse(result.text)).toMatchObject({ delivered: true }); return { text: "sent" };
    } };
    const openSideSession = vi.fn(async () => engine);
    const bridge = { openSideSession, sideCapability: () => ({ context: "native", readOnly: "advisory", toolAccess: "inherited", residue: "none", concurrent: true, seesInProgressTurn: false, delivery: true }) } as unknown as CoreBridgeLike;
    const side = gatewaySideSessions(bridge, root, "bot", async () => true, undefined, undefined, { uploadSideArtifact });
    const scope = { conversationId: "chat", userId: "owner", deviceId: "device" };
    try {
      const opened = sideReplySchema.parse(await side.call("side.open", { ...scope, requestId: "open", tools: "inherited", delivery: true }));
      if (!opened.ok || !opened.view) throw new Error("side open failed");
      const read = async () => { const reply = sideReplySchema.parse(await side.call("side.read", { ...scope, sideId: opened.view!.id })); return reply.ok ? reply.view : undefined; };
      await vi.waitFor(async () => expect((await read())?.phase).toBe("idle"));
      await side.call("side.ask", { ...scope, sideId: opened.view.id, requestId: "ask", text: "send" });
      await vi.waitFor(async () => expect((await read())?.exchanges[0]).toMatchObject({ status: "complete", deliveries: [{ attachments: [{ attachmentId: "att_custom" }] }] }));
      expect(openSideSession).toHaveBeenCalledWith(expect.objectContaining({ workspaceOverride: workspace }));
      expect(uploadSideArtifact).toHaveBeenCalledTimes(1);
    } finally { await side.close(); }
  });
});
