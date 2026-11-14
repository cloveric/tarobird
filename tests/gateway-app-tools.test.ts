import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, truncate } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppPlatformTools } from "../src/gateway/app-tools.js";
import { appAgentInstructions, appTurnInstructions, botCollaborationInstructions } from "../src/gateway/agent-instructions.js";
import { stripAlreadyDeliveredAppArtifacts } from "../src/gateway/app-delivery.js";
import { GatewayArtifactUploadError } from "../src/gateway/channel.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { preflightCoreDeliveryPath, resolveCoreDeliveryRoots } from "../src/core/delivery-preflight.js";
import { larkAgentInstructions } from "../src/core/agent-instructions.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { extractCoreToolTagMatches, parseCoreToolTagPayload } from "../src/core/shared/tool-tags.js";

// Compatibility standing budget: +100 for the complete widget envelope instead
// of payload-only shorthand. Native-widget budgets stay at 1600 in widget-format-policy.
const APP_INSTRUCTION_BUDGET = 1700;

describe("App platform contract", () => {
  it("routes routine Bot follow-ups through durable messages and forbids ambiguous steering fallback", () => {
    for (const engine of ["codex", "claude", "kimi", "deepseek", "antigravity"] as const) {
      expect(appAgentInstructions({ engine })).toContain("messages send/wait (--help), not steer");
    }
    const guide = botCollaborationInstructions();
    expect(guide).toContain("even while the recipient is working");
    expect(guide).toContain("normal reply in the collaboration conversation");
    expect(guide).toContain("acknowledgements need no acknowledgement");
    expect(guide).toContain("bot_message_collaboration_archived");
    expect(guide).toContain("New information or failures arising after the reply");
    expect(guide).not.toContain("tasks, reports and follow-ups");
    expect(guide).toContain("pending/unknown outcome is not a rejection");
    expect(guide).toContain("accepted means admission, not task completion");
    expect(appAgentInstructions({ context: "discussion" })).toContain("do not delegate");
  });
  it("requires bounded filesystem discovery and does not turn failed reads into missing files", () => {
    const guide = appTurnInstructions("熟悉外置盘 gdrive 项目文件夹", { engine: "claude" });
    expect(guide).toContain("explicit short timeout");
    expect(guide).toContain("not an empty/missing folder");
    expect(guide).toContain("only when the user authorized");
    expect(appTurnInstructions("你好", { engine: "claude" })).toBeUndefined();
  });
  it("identifies the current TaroBot surface for every engine and context", () => {
    for (const engine of ["codex", "claude", "kimi", "deepseek", "antigravity"] as const) {
      for (const context of ["chat", "card", "comment", "cron", "bus", "meeting"] as const) {
        for (const nativeDelivery of [false, true]) {
          const app = appAgentInstructions({ engine, context, nativeDelivery, nativeBatchDelivery: nativeDelivery });
          expect(app).toContain("You are replying in TaroBird App");
          expect(app).toContain("not Feishu/Lark or Telegram");
          expect(app).toContain("overrides old TaroCub/Lark labels in resumed history");
          expect(app).toContain("Available skills do not identify the chat channel");
          expect(app).not.toContain("You are replying in TaroCub App");
          expect(app).not.toContain("AskUserQuestion→Lark card");
          expect(app).toContain("A new user message does not stop your tasks");
          expect(app).toContain("Never ask the user to stay silent");
          expect(app.length).toBeLessThan(APP_INSTRUCTION_BUDGET);
        }
      }
    }
  });
  it("provides a captioned fallback example accepted by the real directive parser while ordinary JSON stays inert", () => {
    for (const engine of ["claude", "kimi", "deepseek", "antigravity"] as const) {
      const guide = appTurnInstructions("发送带说明的文件", { engine })!;
      const matches = extractCoreToolTagMatches(guide);
      expect(matches).toHaveLength(1);
      expect(parseCoreToolTagPayload(matches[0]!.payload)).toMatchObject({ name: "send.batch", payload: { files: [{ path: "/workspace/report.pdf", caption: "Report" }] } });
      expect(extractCoreToolTagMatches(guide.replace("```tool-call", "```json"))).toEqual([]);
    }
  });
  it("keeps ordinary turns short and independent of Feishu, while retaining a working fallback", () => {
    for (const engine of ["codex", "claude", "kimi", "deepseek", "antigravity"] as const) {
      const app = appAgentInstructions({ engine });
      expect(app.length).toBeLessThan(APP_INSTRUCTION_BUDGET);
      expect(app).toContain("[send-file:/absolute/path]");
      expect(app).toContain("otherwise send.choice");
      expect(app).not.toMatch(/tarobot gdocs|cron\.add|curl|CDP\/9222|Lark Docs/);
      expect(withChannelProfile("gateway", () => larkAgentInstructions({ engine }))).toBe(app);
      expect(appTurnInstructions("你好", { engine })).toBeUndefined();
      expect(appTurnInstructions("帮我建立 Google Docs", { engine })).toContain("tarobot gdocs create");
      const browser = appTurnInstructions("浏览器登录", { engine }) ?? "";
      // Work in the signed-in main Chrome; another Chrome only on the user's word.
      expect(browser).toContain("unless the user named that port or browser");
      expect(browser).toContain('open -a "Google Chrome"');
      expect(browser).toContain("ask before quitting or relaunching it");
      // Cookies, passwords and keychain stay closed unless the user asks; a needed
      // or failed read is reported, not silently skipped.
      expect(browser).toContain("cookies, passwords or keychain unless the user explicitly asks for it in this conversation");
      expect(browser).toContain("if a task needs them, ask first");
      expect(browser).toContain("tell the user what was needed and why it failed");
      expect(browser).not.toContain("No shell/AppleScript");
    }
    expect(larkAgentInstructions()).toBe("");
    expect(appAgentInstructions({ nativeDelivery: true })).toContain("app_send_file");
    expect(appAgentInstructions({ nativeDelivery: true })).not.toContain("[send-file:");
    expect(appTurnInstructions("添加定时任务", { context: "cron" })).not.toContain("cron.add");
  });
});

describe("native App artifact delivery", () => {
  let root: string, stateDir: string, file: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "app-tools-")); stateDir = path.join(root, "bot");
    await mkdir(path.join(stateDir, "workspace"), { recursive: true });
    file = path.join(stateDir, "workspace", "report.txt"); await writeFile(file, "verified artifact");
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  function fixture(conversationId = "gw_a", receipts = new GatewayReceipts(stateDir)) {
    const signal = new AbortController();
    const sendArtifact = vi.fn(async () => ({ messageId: `msg_${conversationId}` }));
    const sendArtifactBatch = vi.fn(async () => ({ messageId: `batch_${conversationId}` }));
    const onDelivered = vi.fn();
    const tools = createAppPlatformTools({ channel: { sendArtifact, sendArtifactBatch }, stateDir, conversationId, receipts, signal: signal.signal, onDelivered, turnText: "发送图片和文件" });
    const call = (args: unknown = { path: file, kind: "file", caption: "报告说明" }, callId = "delivery-1") => tools.call({ name: "app_send_file", arguments: args, callId, sessionId: "native-thread", abortSignal: new AbortController().signal });
    const batch = (artifacts: unknown[] = [{ path: file, kind: "file", caption: "报告说明" }], callId = "batch-1") => tools.call({ name: "app_send_batch", arguments: { artifacts, caption: "批次说明" }, callId, sessionId: "native-thread", abortSignal: new AbortController().signal });
    return { tools, call, batch, signal, sendArtifact, sendArtifactBatch, onDelivered };
  }
  it("returns a receipt, scopes its recipient, and reuses the receipt across replay/restart", async () => {
    const h = fixture();
    const [first, second] = await Promise.all([h.call(), h.call()]);
    expect(first).toEqual(second);
    expect(JSON.parse(first.text)).toMatchObject({ delivered: true, messageId: "msg_gw_a", sha256: createHash("sha256").update("verified artifact").digest("hex") });
    expect(h.sendArtifact).toHaveBeenCalledTimes(1);
    expect(h.sendArtifact).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "gw_a", caption: "报告说明", bytes: Buffer.from("verified artifact") }));
    const restarted = fixture();
    expect(await restarted.call()).toEqual(first);
    expect(await restarted.call(undefined, "replayed-fresh-id")).toEqual(first); expect(restarted.sendArtifact).not.toHaveBeenCalled();
    const changed = await h.call({ path: file, kind: "file", caption: "different" });
    expect(changed.isError).toBe(true); expect(changed.text).toContain("reused");
    const other = fixture("gw_b"); await other.call(); expect(other.sendArtifact).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "gw_b" }));
  });
  it("rejects recipient overrides, credentials, symlink escapes and cancelled/ended turns", async () => {
    const h = fixture();
    vi.stubEnv("CCTB_LARK_ALLOW_ANY_FILE_PATH", "1");
    await writeFile(path.join(root, "outside.txt"), "private");
    const escape = path.join(stateDir, "workspace", "escape.txt"); await symlink(path.join(root, "outside.txt"), escape);
    const credential = path.join(stateDir, "workspace", ".env"); await writeFile(credential, "TOKEN=fixture");
    for (const [i, args] of [{ path: file, kind: "file", conversationId: "gw_victim" }, { path: escape, kind: "file" }, { path: credential, kind: "file" }, { path: "relative.txt", kind: "file" }].entries()) {
      expect((await h.call(args, String(i))).isError).toBe(true);
    }
    h.signal.abort(); expect((await h.call()).isError).toBe(true);
    expect(h.sendArtifact).not.toHaveBeenCalled(); expect(h.onDelivered).not.toHaveBeenCalled();
  });
  it("does not convert failed or uncertain delivery into success or retry its side effect", async () => {
    const h = fixture(); h.sendArtifact.mockRejectedValueOnce(new Error("lost publish ACK"));
    const first = await h.call(); expect(first.isError).toBe(true); expect(first.text).toContain("delivery_uncertain");
    expect(await h.call()).toEqual(first); expect(h.sendArtifact).toHaveBeenCalledTimes(1); expect(h.onDelivered).not.toHaveBeenCalled();
  });
  it.each([new GatewayArtifactUploadError("too-large", 413), new GatewayArtifactUploadError("upload_failed")])("reports upload failure as definitely unpublished and allows a repaired call", async (error) => {
    const h = fixture(); h.sendArtifact.mockRejectedValueOnce(error);
    const failed = await h.call();
    expect(JSON.parse(failed.text)).toMatchObject({ error: error.code, published: false, retryable: true });
    expect(await h.call()).toEqual(failed); expect(h.sendArtifact).toHaveBeenCalledTimes(1);
    const repaired = await h.call(undefined, "corrected-file");
    expect(JSON.parse(repaired.text).delivered).toBe(true); expect(h.sendArtifact).toHaveBeenCalledTimes(2);
  });
  it("shares successful native sends across fresh call IDs but still sends changed bytes", async () => {
    const h = fixture();
    const [first, second] = await Promise.all([h.call(undefined, "first"), h.call(undefined, "second")]);
    expect(first).toEqual(second); expect(h.sendArtifact).toHaveBeenCalledTimes(1);
    const timeline = (await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(timeline.filter((event) => event.type === "file.accepted")).toHaveLength(1);
    await writeFile(file, "changed bytes"); await h.call(undefined, "updated");
    expect(h.sendArtifact).toHaveBeenCalledTimes(2);
  });
  it("cannot bypass App roots through a legacy marker or legacy environment override", async () => {
    vi.stubEnv("CCTB_LARK_ALLOW_ANY_FILE_PATH", "1");
    const outside = path.join(root, "outside.txt"); await writeFile(outside, "private");
    const check = async () => preflightCoreDeliveryPath(outside, await resolveCoreDeliveryRoots({ stateDir, allowAnyAbsolutePath: true }));
    expect(await withChannelProfile("gateway", check)).toMatchObject({ ok: false, reason: "outside-workspace" });
    expect(await check()).toMatchObject({ ok: true });
  });
  it("delivers outside-workspace single files and batches by default in full access, then honors a downgrade", async () => {
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", approvalMode: "bypass" }));
    const outside = path.join(root, "external-report.txt"); await writeFile(outside, "external artifact");
    const h = fixture();
    expect(JSON.parse((await h.call({ path: outside, kind: "file" }, "external-single")).text)).toMatchObject({ delivered: true });
    expect(h.sendArtifact).toHaveBeenCalledWith(expect.objectContaining({ bytes: Buffer.from("external artifact") }));
    expect(JSON.parse((await h.batch([{ path: outside, kind: "file", caption: "Batch" }], "external-batch")).text)).toMatchObject({ delivered: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", approvalMode: "normal" }));
    expect(JSON.parse((await h.call({ path: outside, kind: "file" }, "after-downgrade")).text)).toMatchObject({ error: "outside-workspace", published: false });
    expect(JSON.parse((await h.batch([{ path: outside, kind: "file" }], "batch-after-downgrade")).text)).toMatchObject({ error: "outside-workspace", published: false });
    expect(h.sendArtifact).toHaveBeenCalledTimes(1); expect(h.sendArtifactBatch).toHaveBeenCalledTimes(1);
  });
  it("persists native registration separately from persona and serves capability help without publishing", async () => {
    const persona = path.join(stateDir, "agent.md"); await writeFile(persona, "My persona");
    const h = fixture(); expect(await h.tools.isRegistered("legacy-thread")).toBe(false);
    await h.tools.register("native-thread"); expect(await fixture().tools.isRegistered("native-thread")).toBe(true);
    const guide = await h.tools.call({ name: "app_capability", arguments: { topic: "documents" }, callId: "help", sessionId: "native-thread", abortSignal: new AbortController().signal });
    expect(guide.text).toContain("tarobot gdocs create"); expect(h.sendArtifact).not.toHaveBeenCalled();
    expect(await readFile(persona, "utf8")).toBe("My persona");
  });
  it("removes only already delivered executable directives and preserves unsent siblings and quoted examples", async () => {
    const text = `[send-file:${file}]\n\`[send-file:${file}]\`\n` + '```tool-call\n' + JSON.stringify({ name: "send.batch", payload: { files: [{ path: file }, { path: path.join(root, "other.txt"), caption: "other caption" }] } }) + '\n```';
    const h = fixture(); await h.call();
    const cleaned = await stripAlreadyDeliveredAppArtifacts(text, [h.onDelivered.mock.calls[0]![0]]);
    expect(cleaned).toContain(`\`[send-file:${file}]\``);
    expect(cleaned.match(new RegExp("report.txt", "g"))).toHaveLength(1);
    expect(cleaned).toContain("other caption"); expect(cleaned).toContain("other.txt");
  });
  it("keeps a final artifact whose bytes changed after native delivery at the same path", async () => {
    const h = fixture(); await h.call();
    const sent = h.onDelivered.mock.calls[0]![0];
    await writeFile(file, "updated final artifact");
    const directive = `[send-file:${file}]`;
    expect(await stripAlreadyDeliveredAppArtifacts(directive, [sent])).toBe(directive);
  });
  it("keeps the exact v1 tool contract on old native threads, without advertising batch support", async () => {
    const h = fixture();
    const version = "8ef5114a6d1726e315c98b2f864bcd5fda7518204122312ae1454e722942972b";
    const id = createHash("sha256").update("old-native").digest("hex");
    await mkdir(path.join(stateDir, "app-tool-threads"));
    const record = JSON.stringify({ toolVersion: version });
    await writeFile(path.join(stateDir, "app-tool-threads", `${id}.json`), record);
    const old = await h.tools.forSession!("old-native");
    expect(await h.tools.isRegistered("old-native")).toBe(true);
    expect(createHash("sha256").update(JSON.stringify(old!.definitions)).digest("hex")).toBe(version);
    expect(old!.instructions + old!.turnInstructions).not.toContain("app_send_batch");
    const help = await old!.call({ name: "app_capability", arguments: { topic: "files" }, callId: "help", sessionId: "old-native", abortSignal: h.signal.signal });
    expect(help.text).not.toContain("app_send_batch");
    expect((await old!.call({ name: "app_send_batch", arguments: {}, callId: "not-installed", sessionId: "old-native", abortSignal: h.signal.signal })).isError).toBe(true);
    expect(await readFile(path.join(stateDir, "app-tool-threads", `${id}.json`), "utf8")).toBe(record);
    await h.tools.register("new-native");
    expect((await h.tools.forSession!("new-native"))!.instructions).toContain("app_send_batch");
    expect(await h.tools.forSession!("missing-thread")).toBeUndefined();
    await writeFile(path.join(stateDir, "app-tool-threads", `${id}.json`), JSON.stringify({ toolVersion: "unknown-version" }));
    expect(await h.tools.forSession!("old-native")).toBeUndefined();
  });
  it("new Workbench tool labels are neutral and separate destination from native authoring", () => {
    const h = fixture();
    const description = h.tools.definitions.find(tool => tool.name === "app_workbench")!.description;
    expect(description).not.toMatch(/baoyu|宝玉|宝育/i);
    expect(description).toContain("independent of the authoring skill");
    expect(description).toContain("engine's native presentation skill");
  });
  it.each([
    "5f91d0787128d99ba2e938b4b91e0ba1ecc359dae5273c7eb3b4db7d8e9d9fdb",
    "641f6f3c0dca3e7b52c9c22b82fa019b6bd6d8a01dd6c85db9e9a4be87c74a83",
  ])("keeps the frozen v12 contract %s resumable with corrected on-demand guidance", async version => {
    const h = fixture(), id = "v12-thread";
    const file = path.join(stateDir, "app-tool-threads", `${createHash("sha256").update(id).digest("hex")}.json`);
    await mkdir(path.dirname(file)); const record = JSON.stringify({ toolVersion: version }); await writeFile(file, record);
    const resumed = await h.tools.forSession!(id);
    expect(await h.tools.isRegistered(id)).toBe(true);
    expect(createHash("sha256").update(JSON.stringify(resumed!.definitions)).digest("hex")).toBe(version);
    const guide = await resumed!.call({ name: "app_capability", arguments: { topic: "browser" }, callId: "v12-guide", sessionId: id, abortSignal: h.signal.signal });
    expect(guide.text).toContain("Workbench is a destination, not a skill selection");
    expect(await readFile(file, "utf8")).toBe(record);
  });
  it("keeps v2 batch threads resumable while new threads describe external full-access paths", async () => {
    const h = fixture(), version = "4ced9591d11ef38a38d87d3df86297ebfa998d95d32d662a7e061d33cbe0344a";
    const file = path.join(stateDir, "app-tool-threads", `${createHash("sha256").update("v2-thread").digest("hex")}.json`);
    await mkdir(path.dirname(file)); const record = JSON.stringify({ toolVersion: version }); await writeFile(file, record);
    const resumed = await h.tools.forSession!("v2-thread");
    expect(await h.tools.isRegistered("v2-thread")).toBe(true);
    expect(createHash("sha256").update(JSON.stringify(resumed!.definitions)).digest("hex")).toBe(version);
    expect(resumed!.definitions.some(tool => tool.name === "app_send_batch")).toBe(true);
    const help = await resumed!.call({ name: "app_capability", arguments: { topic: "files" }, callId: "v2-help", sessionId: "v2-thread", abortSignal: h.signal.signal });
    expect(help.text).toContain("Full-access Bots allow external paths by default");
    expect(help.text).toContain("TAROBOT_ALLOW_ANY_FILE_PATH=1"); expect(help.text).not.toContain("lark.env");
    expect(await readFile(file, "utf8")).toBe(record);
    await h.tools.register("v3-thread");
    expect(JSON.stringify((await h.tools.forSession!("v3-thread"))!.definitions).match(/Full-access Bots/g)).toHaveLength(2);
  });
  it("reuses a whole batch and each member across concurrent calls and durable replay", async () => {
    const h = fixture();
    const [a, b] = await Promise.all([h.batch(), h.batch(undefined, "duplicate")]);
    expect(a).toEqual(b); expect(h.sendArtifactBatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(a.text)).toMatchObject({ delivered: true, messageId: "batch_gw_a", files: [{ name: "report.txt", size: 17 }] });
    expect(a.text).not.toContain(file);
    expect(JSON.parse((await h.call()).text).messageId).toBe("batch_gw_a"); expect(h.sendArtifact).not.toHaveBeenCalled();
    const restored = fixture(); expect(await restored.batch()).toEqual(a);
    expect(await restored.batch(undefined, "fresh-id")).toEqual(a); expect(restored.sendArtifactBatch).not.toHaveBeenCalled();
    expect((await restored.batch([{ path: file, kind: "file", caption: "changed" }])).text).toContain("reused");
    await writeFile(file, "new file bytes"); await h.batch(undefined, "updated"); expect(h.sendArtifactBatch).toHaveBeenCalledTimes(2);
  });
  it("preflights every member and rejects unsafe, oversized or duplicate batches before publication", async () => {
    const h = fixture(), bad = path.join(stateDir, "workspace", ".env"); await writeFile(bad, "TEST=fixture");
    const good = { path: file, kind: "file" };
    for (const [index, artifacts] of [[good, { path: bad, kind: "file" }], [good, { ...good, recipient: "someone" }], [good, good], [], Array(51).fill(good)].entries()) {
      expect((await h.batch(artifacts, `invalid-${index}`)).isError).toBe(true);
    }
    expect((await h.batch(Array.from({ length: 6 }, (_, i) => ({ ...good, caption: "图".repeat(12_000 - 1) + i })), "caption-bytes")).isError).toBe(true);
    expect((await h.batch(Array.from({ length: 3 }, (_, i) => ({ ...good, caption: "\u0001".repeat(12_000 - 1) + i })), "escaped-caption-bytes")).isError).toBe(true);
    const empty = path.join(stateDir, "workspace", "empty.txt"); await writeFile(empty, "");
    expect(JSON.parse((await h.batch([good, { path: empty, kind: "file" }], "empty-file")).text)).toMatchObject({ error: "empty_file", index: 1, published: false });
    const sparse = path.join(stateDir, "workspace", "large.bin"); await writeFile(sparse, ""); await truncate(sparse, 300 * 1024 * 1024);
    expect((await h.batch([{ path: sparse, kind: "file", caption: "one" }, { path: sparse, kind: "file", caption: "two" }], "large")).text).toContain("batch_too_large");
    expect(h.sendArtifactBatch).not.toHaveBeenCalled(); expect(h.onDelivered).not.toHaveBeenCalled();
  });
  it("does not republish batch members after an uncertain acknowledgment, but allows repair after upload failure", async () => {
    const h = fixture(); h.sendArtifactBatch.mockRejectedValueOnce(new GatewayArtifactUploadError("upload_failed"));
    expect(JSON.parse((await h.batch()).text)).toMatchObject({ error: "upload_failed", published: false });
    h.sendArtifactBatch.mockRejectedValueOnce(new Error("publish acknowledgment lost"));
    expect((await h.batch(undefined, "second")).text).toContain("delivery_uncertain");
    expect((await h.batch(undefined, "third")).text).toContain("delivery_uncertain");
    expect((await h.call()).text).toContain("delivery_uncertain");
    expect(h.sendArtifactBatch).toHaveBeenCalledTimes(2); expect(h.sendArtifact).not.toHaveBeenCalled();
    expect(h.onDelivered).not.toHaveBeenCalled();
  });
  it("refuses overlapping batches after a single delivery and cancels a batch before work begins", async () => {
    const h = fixture(); await h.call();
    expect(JSON.parse((await h.batch()).text)).toMatchObject({ error: "batch_overlaps_existing_delivery", published: false });
    h.signal.abort(); expect((await h.batch(undefined, "cancelled")).text).toContain("turn_ended");
    expect(h.sendArtifactBatch).not.toHaveBeenCalled();
  });
});
