import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { runSideCommand } from "../src/host-cli/side.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { runHostCli } from "../src/host-cli/cli.js";

it("asks through the real authenticated App API, meters usage and always closes the temporary handle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "side-cli-")); await initializeHost(root, "Side test");
  const stateDir = path.join(root, "bot"); await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root }), secret = randomBytes(32).toString("base64url"), disposed = vi.fn(async () => {});
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot',?)", [hashSecret(secret)]);
  const chat = await hub.store.createConversation("owner", ["bot"], "Side", "side");
  const send = vi.fn(async ({ text }: { text: string }) => { if (text === "fail") throw new Error("private failure detail"); return { text: `contextual answer: ${text}`, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002 } }; });
  const openSideSession = vi.fn(async () => ({ nativeId: "temp", send, dispose: disposed }));
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "bot", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "main" }), sideCapability: input => ({ context: "native", concurrent: true, readOnly: input?.tools ? "advisory" : "enforced", ...(input?.tools ? { toolAccess: "inherited" } : {}), residue: "none", seesInProgressTurn: false }), openSideSession } });
  const control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  let client: LocalHostClient | undefined;
  try {
    client = await LocalHostClient.connect(root, { enroll: true });
    expect(await runSideCommand(client, "status", chat.id, { bot: "bot" })).toMatchObject({ ok: true, capability: { supported: true, tools: "inherited" } });
    expect(await client.request(`/api/conversations/${chat.id}/side?botId=bot`)).toMatchObject({ capability: { tools: "read-only" } });
    const before = await hub.store.db.get("SELECT COUNT(*) AS n FROM events");
    expect(await runSideCommand(client, "ask", chat.id, { bot: "bot", text: "why?" })).toEqual({ text: "contextual answer: why?", closeConfirmed: true });
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(openSideSession).toHaveBeenCalledWith(expect.objectContaining({ tools: "inherited" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ turnInstructions: expect.stringContaining("Use available search, network") }));
    await expect(runSideCommand(client, "ask", chat.id, { bot: "bot", text: "fail" })).rejects.toThrow("side_failed"); expect(disposed).toHaveBeenCalledTimes(2);
    expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM events")).toEqual(before);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try { await runHostCli(["side", "ask", chat.id, "--bot", "bot", "--text", "CLI entry", "--state-dir", root, "--json"]); expect(log).toHaveBeenCalledWith(expect.stringContaining("contextual answer: CLI entry")); }
    finally { log.mockRestore(); }
    expect(disposed).toHaveBeenCalledTimes(3);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(path.join(stateDir, "usage.json"), "utf8"))).toMatchObject({ requestCount: 2, unmeteredRequestCount: 1, totalCostUsd: 0.004 }));
    const timeline = await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8");
    expect(timeline).not.toContain("why?"); expect(timeline).not.toContain("private failure detail");
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", budgetUsd: 0.001 }));
    await expect(runSideCommand(client, "ask", chat.id, { bot: "bot", text: "budget rejected" })).rejects.toThrow("side_budget_exhausted");
    expect(send).toHaveBeenCalledTimes(3); expect(disposed).toHaveBeenCalledTimes(4);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
    expect(await runSideCommand(client, "status", chat.id, { bot: "bot" })).toMatchObject({ capability: { usage: "unavailable" } });
    expect(await runSideCommand(client, "ask", chat.id, { bot: "bot", text: "usage notice" })).toMatchObject({ usageAvailable: false, closeConfirmed: true });
    await hub.store.db.run("UPDATE conversations SET session_id='new_selection',binding_id='pending_selection' WHERE id=?", [chat.id]);
    await expect(runSideCommand(client, "ask", chat.id, { bot: "bot", text: "do not borrow old context" })).rejects.toThrow("side_no_main_session");
    expect(send).toHaveBeenCalledTimes(4); expect(disposed).toHaveBeenCalledTimes(5);
  } finally { await client?.close(); await control(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);
it("rejects invalid and ambiguous CLI inputs before contacting the host", async () => {
  const request = vi.fn();
  for (const options of [{ bot: "bot", text: "x", "text-file": "/unused" }, { bot: "bot", text: "x", timeout: "0" }, { bot: "bot", text: " " }, { bot: "../bad", text: "x" }]) await expect(runSideCommand({ request }, "ask", "chat", options)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

it("reports truncated CLI answers and a failed cleanup receipt", async () => {
  const capability = { supported: true, concurrent: true, liveContext: false, tools: "none", usage: "unavailable" };
  const view = { id: "side", conversationId: "chat", revision: 1, openedAt: 1, phase: "idle", capability, exchanges: [], omitted: 0 };
  const request = vi.fn().mockResolvedValueOnce({ ok: true, capability }).mockResolvedValueOnce({ ok: true, view }).mockResolvedValueOnce({ ok: true, view: { ...view, revision: 2, exchanges: [{ id: "ask", question: "why?", answer: "bounded answer", status: "complete", truncated: true }] } }).mockResolvedValueOnce({ ok: false, error: "failed" });
  expect(await runSideCommand({ request }, "ask", "chat", { bot: "bot", text: "why?", "request-id": "ask" })).toEqual({ text: "bounded answer", truncated: true, usageAvailable: false, closeConfirmed: false });
});

it("negotiates side delivery and returns attachment receipts after closing the temporary handle", async () => {
  const capability = { supported: true, concurrent: true, liveContext: false, tools: "inherited", delivery: true };
  const view = { id: "side", conversationId: "chat", revision: 1, openedAt: 1, phase: "idle", capability, exchanges: [], omitted: 0 };
  const deliveries = [{ id: "output", caption: "chart", attachments: [{ type: "image", attachmentId: "att_chart", title: "chart.png" }] }];
  const request = vi.fn().mockResolvedValueOnce({ ok: true, capability }).mockResolvedValueOnce({ ok: true, view }).mockResolvedValueOnce({ ok: true, view: { ...view, revision: 2, exchanges: [{ id: "ask", question: "chart", answer: "sent", status: "complete", deliveries }] } }).mockResolvedValueOnce({ ok: true });
  expect(await runSideCommand({ request }, "ask", "chat", { bot: "bot", text: "chart", "request-id": "ask" })).toEqual({ text: "sent", deliveries, closeConfirmed: true });
  expect(request).toHaveBeenNthCalledWith(2, "/api/conversations/chat/side", "POST", { botId: "bot", requestId: "ask", tools: "inherited", delivery: true });
});

it("uploads CLI files through the shared API, lets the engine read verified private copies and removes them on close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "side-cli-files-")); await initializeHost(root, "Side files");
  const stateDir = path.join(root, "bot"); await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root }), secret = randomBytes(32).toString("base64url"), disposed = vi.fn(async () => {});
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot',?)", [hashSecret(secret)]);
  const chat = await hub.store.createConversation("owner", ["bot"], "Side", "side"), other = await hub.store.createConversation("owner", ["bot"], "Other", "other");
  const seen: Array<{ text: string; files: Array<{ kind: string; name: string; bytes: string; text?: string }> }> = [], paths: string[] = [];
  const send = vi.fn(async ({ text, attachments = [] }: { text: string; attachments?: Array<{ kind: string; name: string; path: string; text?: string }> }) => {
    paths.push(...attachments.map(file => file.path));
    seen.push({ text, files: await Promise.all(attachments.map(async file => ({ kind: file.kind, name: file.name, bytes: (await readFile(file.path)).toString("hex"), ...(file.text !== undefined ? { text: file.text } : {}) }))) });
    return { text: `read ${attachments.length}` };
  });
  const sideCapability = () => ({ context: "native" as const, concurrent: true, readOnly: "enforced" as const, residue: "none" as const, seesInProgressTurn: false, attachments: { images: true, files: "any" as const, paths: true } });
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "bot", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "main" }), sideCapability, openSideSession: async () => ({ nativeId: "temp", send, dispose: disposed }) } });
  const control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const files = path.join(root, "inputs"); await mkdir(files);
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
  await writeFile(path.join(files, "notes.ts"), "export const MARKER = 'SIDE-FILE-91';\n"); await writeFile(path.join(files, "chart.png"), png);
  let client: LocalHostClient | undefined;
  try {
    client = await LocalHostClient.connect(root, { enroll: true });
    const route = `/api/conversations/${chat.id}/side`;
    // Older clients never opt in and keep the old capability shape.
    expect(await client.request(`${route}?botId=bot`)).not.toHaveProperty("capability.attachments");
    expect(await runSideCommand(client, "status", chat.id, { bot: "bot" })).toMatchObject({ capability: { attachments: { images: true, files: "any", maxCount: 8 } } });
    const before = await hub.store.db.get("SELECT COUNT(*) AS n FROM events"), messages = await hub.store.db.get("SELECT COUNT(*) AS n FROM messages");
    const result = await runSideCommand(client, "ask", chat.id, { bot: "bot", file: [path.join(files, "notes.ts"), path.join(files, "chart.png")] });
    expect(result).toMatchObject({ text: "read 2", closeConfirmed: true, attachments: [expect.stringMatching(/^att_/), expect.stringMatching(/^att_/)] });
    expect(seen[0]).toEqual({ text: "", files: [
      { kind: "text", name: "notes.ts", bytes: Buffer.from("export const MARKER = 'SIDE-FILE-91';\n").toString("hex"), text: "export const MARKER = 'SIDE-FILE-91';\n" },
      { kind: "image", name: "chart.png", bytes: png.toString("hex") },
    ] });
    expect(disposed).toHaveBeenCalledTimes(1);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try { await runHostCli(["side", "ask", chat.id, "--bot", "bot", "--text", "both?", "--file", path.join(files, "notes.ts"), "--file", path.join(files, "chart.png"), "--state-dir", root, "--json"]); expect(log).toHaveBeenCalledWith(expect.stringContaining("read 2")); }
    finally { log.mockRestore(); }
    expect(seen[1]!.text).toBe("both?"); expect(disposed).toHaveBeenCalledTimes(2);
    const inbound = path.join(stateDir, "workspace", ".tarobot-files");
    for (const file of paths) expect(path.relative(inbound, file)).toMatch(/^side_[A-Za-z0-9]+\/[A-Za-z0-9_-]+\/[12]-(notes\.ts|chart\.png)$/);
    expect((await readdir(inbound).catch(() => [])).filter(name => name.startsWith("side_"))).toEqual([]);
    // Uploads stay ordinary, unreferenced Hub files: never retired by the side and never in the transcript.
    const ids = (result as { attachments: string[] }).attachments;
    expect(await hub.store.db.all("SELECT attachment_id FROM retired_attachments")).toEqual([]);
    expect((await hub.store.db.all<{ id: string }>("SELECT id FROM attachments WHERE complete=1")).map(row => row.id).sort()).toEqual([...ids].sort());
    expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM message_attachments")).toEqual({ n: 0 });
    expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM events")).toEqual(before);
    expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM messages")).toEqual(messages);
    // A completed upload from another conversation is indistinguishable from a missing one.
    const foreign = await (await import("../src/host-cli/groups.js")).upload(client, other.id, path.join(files, "notes.ts"));
    const opened = await client.request(route, "POST", { botId: "bot", requestId: "open-foreign" }) as { view: { id: string } };
    await vi.waitFor(async () => expect(await client!.request(`${route}/${opened.view.id}?botId=bot`)).toMatchObject({ view: { phase: "idle" } }));
    expect(await client.request(`${route}/${opened.view.id}`, "POST", { botId: "bot", requestId: "foreign", text: "read", attachments: [foreign] })).toEqual({ ok: false, error: "attachment_unavailable" });
    await expect(client.request(`${route}/${opened.view.id}`, "POST", { botId: "bot", requestId: "path", text: "read", attachments: ["/etc/passwd"] })).rejects.toThrow();
    await client.request(`${route}/${opened.view.id}?botId=bot`, "DELETE");
    expect(send).toHaveBeenCalledTimes(2);
  } finally { await client?.close(); await control(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);

it("refuses CLI attachments before uploading when the host or engine cannot read them", async () => {
  const capability = { supported: true, concurrent: true, liveContext: false, tools: "read-only" };
  const request = vi.fn().mockResolvedValue({ ok: true, capability }), putChunk = vi.fn();
  const root = await mkdtemp(path.join(os.tmpdir(), "side-cli-old-")), file = path.join(root, "a.txt"); await writeFile(file, "x");
  try {
    await expect(runSideCommand({ request, putChunk }, "ask", "chat", { bot: "bot", file: [file] })).rejects.toThrow("side_attachment_unsupported");
    expect(request.mock.calls.map(call => call[0])).toEqual(["/api/conversations/chat/side?botId=bot&attachments=1&tools=1&delivery=1"]);
    request.mockResolvedValue({ ok: true, capability: { ...capability, attachments: { images: false, files: "text", maxCount: 8, maxFileBytes: 1, maxImageBytes: 1, maxTotalBytes: 1 } } });
    await writeFile(path.join(root, "b.png"), "xy");
    await expect(runSideCommand({ request, putChunk }, "ask", "chat", { bot: "bot", file: [path.join(root, "b.png")] })).rejects.toThrow("side_attachment_unsupported");
    await expect(runSideCommand({ request, putChunk }, "ask", "chat", { bot: "bot", file: [path.join(root, "b.png").replace(".png", ".txt")] })).rejects.toThrow();
    await writeFile(path.join(root, "c.txt"), "xy");
    await expect(runSideCommand({ request, putChunk }, "ask", "chat", { bot: "bot", file: [path.join(root, "c.txt")] })).rejects.toThrow("side_attachment_too_large");
    await expect(runSideCommand({ request, putChunk }, "ask", "chat", { bot: "bot", text: "a", "text-file": file, file: [file] })).rejects.toThrow();
    expect(request.mock.calls.some(call => String(call[0]).startsWith("/api/uploads"))).toBe(false);
    expect(putChunk).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("sends one attachment ID for repeated or identical CLI files and discloses partial content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "side-cli-dedupe-"));
  await mkdir(path.join(root, "a")); await mkdir(path.join(root, "b"));
  await writeFile(path.join(root, "a", "log.txt"), "same bytes"); await writeFile(path.join(root, "b", "log.txt"), "same bytes");
  const capability = { supported: true, concurrent: true, liveContext: false, tools: "none", usage: "unavailable", attachments: { images: false, files: "text", maxCount: 8, maxFileBytes: 1024, maxImageBytes: 1024, maxTotalBytes: 4096 } };
  const view = { id: "side", conversationId: "chat", revision: 1, openedAt: 1, phase: "idle", capability: { ...capability, attachments: undefined }, exchanges: [], omitted: 0 };
  const asks: unknown[] = [];
  const request = vi.fn().mockImplementation(async (route: string, method = "GET", body?: unknown) => {
    if (route.endsWith("&attachments=1")) return { ok: true, capability };
    if (route === "/api/uploads") return { id: "att_same", chunkBytes: 8 };
    if (route === "/api/uploads/att_same") return { complete: true, chunks: [], size: 10, sha256: "0".repeat(64) };
    if (route === "/api/conversations/chat/side" && method === "POST") return { ok: true, view };
    if (route === "/api/conversations/chat/side/side" && method === "POST") { asks.push(body); return { ok: true, view: { ...view, revision: 2, exchanges: [{ id: "ask", question: "", answer: "only the head", status: "complete", attachments: [{ type: "file", attachmentId: "att_same", name: "log.txt", size: 10, mime: "text/plain" }], partialAttachments: ["att_same"] }] } }; }
    if (method === "DELETE") return { ok: true };
    throw new Error(`unexpected ${method} ${route}`);
  });
  try {
    const result = await runSideCommand({ request, putChunk: vi.fn() }, "ask", "chat", { bot: "bot", "request-id": "ask", file: [path.join(root, "a", "log.txt"), path.join(root, "a", "..", "a", "log.txt"), path.join(root, "b", "log.txt")] });
    expect(asks).toEqual([{ botId: "bot", requestId: "ask", text: "", attachments: ["att_same"] }]);
    expect(request.mock.calls.filter(call => call[0] === "/api/uploads")).toHaveLength(2);
    expect(result).toEqual({ text: "only the head", closeConfirmed: true, attachments: ["att_same"], partialAttachments: ["att_same"], usageAvailable: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
