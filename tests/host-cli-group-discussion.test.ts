import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceProof } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { HOST_CLI_HELP, runHostCli } from "../src/host-cli/cli.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runGroupsCommand } from "../src/host-cli/groups.js";
import { initializeHost } from "../src/host-cli/setup.js";
import type { GroupDiscussionView, GroupSettingsSnapshot } from "../src/client-protocol/group-discussion.js";
import { bootstrapTrusted, postPairing } from "./helpers/pairing-invite.js";

const keypair = generateKeyPairSync("ed25519");
const publicKey = keypair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
let root: string, hub: HubServer;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "groups-cli-")); });
afterEach(async () => { vi.restoreAllMocks(); await hub?.close(); await rm(root, { recursive: true, force: true }); });

/** An authenticated App session; the CLI client talks to the same HTTP API. */
async function session(): Promise<{ token: string; capabilities: string[] }> {
  // No owner exists yet to issue an invite: bootstrap in-process, while the
  // public route keeps refusing a first registration without one.
  const device = { deviceId: "device", name: "CLI test", platform: "web" as const, publicKey };
  expect(await postPairing(hub.url, device)).toEqual({ status: 403, body: { error: "pairing_invite_required" } });
  await bootstrapTrusted(hub.auth, device);
  const ws = new WebSocket(hub.url.replace("http", "ws") + "/ws"); await new Promise(resolve => ws.once("open", resolve));
  const frames: Record<string, unknown>[] = []; ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
  const next = async (type: string) => { for (let i = 0; i < 400; i++) { const frame = frames.find(f => f.type === type); if (frame) return frame; await new Promise(r => setTimeout(r, 5)); } throw new Error(type); };
  const nonce = randomBytes(32).toString("base64url");
  ws.send(JSON.stringify({ v: 1, type: "hello", deviceId: "device", nonce, protocolVersions: [1], capabilities: ["management.v1"], cursors: {} }));
  const challenge = await next("challenge");
  ws.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof("device", challenge.nonce as string, nonce), keypair.privateKey).toString("base64") }));
  const ready = await next("ready"); ws.close();
  return { token: ready.sessionToken as string, capabilities: ready.serverCapabilities as string[] };
}
function client(token: string, capabilities: string[]) {
  const call = async (route: string, method = "GET", body?: BodyInit, type?: string) => {
    const response = await fetch(hub.url + route, { method, body, headers: { Authorization: `Bearer ${token}`, ...(type ? { "Content-Type": type } : {}) } });
    const value = await response.json() as { error?: string };
    if (!response.ok) throw new Error(value.error ?? "cli_http_error");
    return value;
  };
  return {
    ready: { serverCapabilities: capabilities },
    request: <T>(route: string, method = "GET", body?: unknown) => call(route, method, body === undefined ? undefined : JSON.stringify(body), "application/json") as Promise<T>,
    putChunk: <T>(route: string, bytes: Buffer) => call(route, "PUT", new Uint8Array(bytes)) as Promise<T>,
  };
}

describe("groups CLI against the real Hub API", () => {
  it("saves parallel replies through the shared settings API without starting work and gates older hosts", async () => {
    hub = await HubServer.start({ stateDir: root });
    for (const id of ['alpha', 'beta']) await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', [id, id, 'fixture']);
    const chat = await hub.store.createConversation('owner', ['alpha', 'beta'], 'Panel', 'parallel-panel', { type: 'group' });
    const { token, capabilities } = await session(), cli = client(token, capabilities);
    const current = await runGroupsCommand(cli, 'show', chat.id, {}) as GroupSettingsSnapshot;
    const file = path.join(root, 'parallel-settings.json');
    await writeFile(file, JSON.stringify({ title: 'Panel', expectedTitle: 'Panel', botIds: chat.botIds, expectedBotIds: chat.botIds,
      policy: { ...current.policy, mode: 'parallel' }, expectedRevision: current.revision }));
    await expect(runGroupsCommand(client(token, capabilities.filter(cap => cap !== 'groups.parallel.v1')), 'update', chat.id, { from: file })).rejects.toThrow('主机尚不支持并行回复');
    const updated = await runGroupsCommand(cli, 'update', chat.id, { from: file }) as { settings: GroupSettingsSnapshot };
    expect(updated.settings.policy.mode).toBe('parallel');
    expect((await runGroupsCommand(cli, 'status', chat.id, {}) as GroupDiscussionView).run).toBeNull();
    expect(await hub.store.db.get('SELECT COUNT(*) AS n FROM deliveries')).toEqual({ n: 0 });
    await hub.close(); hub = await HubServer.start({ stateDir: root });
    expect((await hub.store.groupSettings('owner', chat.id)).policy.mode).toBe('parallel');
  });
  it("shows/updates settings and starts, controls and reads a discussion with the App's rules", async () => {
    hub = await HubServer.start({ stateDir: root });
    for (const id of ["alpha", "beta"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, "fixture"]);
    const chat = await hub.store.createConversation("owner", ["alpha", "beta"], "Panel", "panel", { type: "group" });
    const { token, capabilities } = await session();
    expect(capabilities).toContain("groups.discussion.v1");
    const cli = client(token, capabilities), receipt = vi.fn();
    const shown = await runGroupsCommand(cli, "show", chat.id, {}) as GroupSettingsSnapshot;
    expect(shown.policy).toEqual({ mode: "mentions", botOrder: ["alpha", "beta"], maxRounds: 3 });
    const settingsFile = path.join(root, "settings.json");
    await writeFile(settingsFile, JSON.stringify({ title: "Panel", botIds: ["alpha", "beta"], expectedTitle: "Panel", expectedBotIds: ["alpha", "beta"],
      policy: { mode: "independent", botOrder: ["beta", "alpha"], maxRounds: 2 }, expectedRevision: shown.revision }));
    const updated = await runGroupsCommand(cli, "update", chat.id, { from: settingsFile }) as { settings: GroupSettingsSnapshot };
    expect(updated.settings.policy).toEqual({ mode: "independent", botOrder: ["beta", "alpha"], maxRounds: 2 });
    // The same stale document is now a conflict, exactly as in the App.
    await writeFile(settingsFile, JSON.stringify({ title: "Panel", botIds: ["alpha", "beta"], expectedTitle: "Panel", expectedBotIds: ["alpha", "beta"],
      policy: { mode: "sequential", botOrder: ["beta", "alpha"], maxRounds: 2 }, expectedRevision: shown.revision }));
    await expect(runGroupsCommand(cli, "update", chat.id, { from: settingsFile })).rejects.toThrow("group_settings_conflict");
    const topicFile = path.join(root, "topic.txt"), attachment = path.join(root, "brief.md");
    await writeFile(topicFile, "Which plan?"); await writeFile(attachment, "# Brief\n");
    await expect(runGroupsCommand(cli, "start", chat.id, { "text-file": topicFile, revision: shown.revision })).rejects.toThrow("group_settings_conflict");
    const started = await runGroupsCommand(cli, "start", chat.id, { "text-file": topicFile, revision: updated.settings.revision, file: [attachment], "request-id": "cli-start" }, receipt) as GroupDiscussionView;
    expect(receipt).toHaveBeenCalledExactlyOnceWith("cli-start");
    expect(started.run).toMatchObject({ mode: "independent", stage: "blind", topic: "Which plan?", status: "running" });
    expect(started.run!.steps.map(step => step.botId)).toEqual(["beta", "alpha"]);
    const topic = await hub.store.messageForUser("owner", started.run!.topicMessageId!);
    expect(topic.blocks).toEqual([{ type: "text", text: "Which plan?" }, expect.objectContaining({ type: "file", name: "brief.md" })]);
    expect((await hub.groupDiscussions.dispatch("beta", started.run!.steps[0]!.inputMessageId!))!.topicAttachments).toEqual(["brief.md"]);
    // Same request ID and payload: replay, never a second run.
    expect((await runGroupsCommand(cli, "start", chat.id, { "text-file": topicFile, revision: updated.settings.revision, file: [attachment], "request-id": "cli-start" }) as GroupDiscussionView).run!.id).toBe(started.run!.id);
    const status = await runGroupsCommand(cli, "status", chat.id, {}) as GroupDiscussionView;
    const noteFile = path.join(root, "note.txt"); await writeFile(noteFile, "Keep maintenance costs low");
    await expect(runGroupsCommand(client(token, capabilities.filter(cap => cap !== "groups.discussion.composer.v1")), "note", chat.id, { run: status.run!.id, "text-file": noteFile })).rejects.toThrow("更新主机");
    await runGroupsCommand(cli, "note", chat.id, { run: status.run!.id, "text-file": noteFile, "request-id": "cli-note" }, receipt);
    await runGroupsCommand(cli, "note", chat.id, { run: status.run!.id, "text-file": noteFile, "request-id": "cli-note" });
    expect(receipt).toHaveBeenCalledWith("cli-note");
    expect(await hub.store.db.all("SELECT id FROM messages WHERE client_msg_id LIKE 'gdnote_%'")).toHaveLength(1);
    // An attachment-only note uses the same contract as the App composer.
    await runGroupsCommand(cli, "note", chat.id, { run: status.run!.id, file: [attachment], "request-id": "cli-file-note" });
    await runGroupsCommand(cli, "note", chat.id, { run: status.run!.id, file: [attachment], "request-id": "cli-file-note" });
    await expect(runGroupsCommand(cli, "note", chat.id, { run: status.run!.id })).rejects.toThrow("至少一个 --file");
    const notes = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE client_msg_id LIKE 'gdnote_%'");
    expect(notes).toHaveLength(2);
    expect(notes.map(row => JSON.parse(row.blocks_json))).toContainEqual([expect.objectContaining({ type: "file", name: "brief.md" })]);
    expect(status.run!.actions).toEqual(["pause", "end"]);
    const paused = await runGroupsCommand(cli, "pause", chat.id, { run: status.run!.id, revision: status.run!.revision, "request-id": "cli-pause" }) as GroupDiscussionView;
    // No worker has received an input yet, so nothing is speaking: paused now.
    expect(paused.run!.status).toBe("paused");
    await expect(runGroupsCommand(cli, "retry", chat.id, { run: status.run!.id, revision: status.run!.revision })).rejects.toThrow("group_discussion_conflict");
    const ended = await runGroupsCommand(cli, "end", chat.id, { run: status.run!.id, revision: paused.run!.revision }) as GroupDiscussionView;
    expect(ended.run).toMatchObject({ status: "ended", outcome: "stopped" });
  });

  it("selects speakers, adds-and-continues, replaces a paused topic and ends without a revision", async () => {
    hub = await HubServer.start({ stateDir: root });
    for (const id of ["alpha", "beta", "gamma"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, "fixture"]);
    const chat = await hub.store.createConversation("owner", ["alpha", "beta", "gamma"], "Panel", "recovery-panel", { type: "group" });
    const { token, capabilities } = await session();
    expect(capabilities).toContain("groups.discussion.recovery.v1");
    const cli = client(token, capabilities), legacy = client(token, capabilities.filter(cap => cap !== "groups.discussion.recovery.v1"));
    const shown = await runGroupsCommand(cli, "show", chat.id, {}) as GroupSettingsSnapshot;
    const settingsFile = path.join(root, "settings.json");
    await writeFile(settingsFile, JSON.stringify({ title: "Panel", botIds: shown.group.botIds, expectedTitle: "Panel", expectedBotIds: shown.group.botIds,
      policy: { ...shown.policy, mode: "sequential", maxRounds: 2 }, expectedRevision: shown.revision }));
    const { settings } = await runGroupsCommand(cli, "update", chat.id, { from: settingsFile }) as { settings: GroupSettingsSnapshot };
    const topicFile = path.join(root, "topic.txt"), noteFile = path.join(root, "note.txt");
    await writeFile(topicFile, "TYPO question"); await writeFile(noteFile, "CORRECT question");
    await expect(runGroupsCommand(legacy, "start", chat.id, { "text-file": topicFile, revision: settings.revision, participants: "gamma,alpha" })).rejects.toThrow("更新主机");
    const started = await runGroupsCommand(cli, "start", chat.id, { "text-file": topicFile, revision: settings.revision, participants: "gamma,alpha" }) as GroupDiscussionView;
    expect(started.run!.participants.map(participant => participant.botId)).toEqual(["alpha", "gamma"]);
    // The speaker is stopped: paused on its unfinished turn.
    const first = started.run!.steps[0]!;
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [first.inputMessageId!]);
    await hub.groupDiscussions.settleInput(first.botId, first.inputMessageId!);
    await hub.store.failDelivery(first.botId, first.inputMessageId!, "interrupted");
    await hub.groupDiscussions.settleInput(first.botId, first.inputMessageId!, "interrupted");
    let status = await runGroupsCommand(cli, "status", chat.id, {}) as GroupDiscussionView;
    expect(status.run).toMatchObject({ status: "paused", pauseReason: "turn_interrupted" });
    await expect(runGroupsCommand(cli, "note", chat.id, { run: status.run!.id, "text-file": noteFile, then: "resume" })).rejects.toThrow("--revision");
    await expect(runGroupsCommand(cli, "note", chat.id, { run: status.run!.id, "text-file": noteFile, then: "skip", revision: status.run!.revision })).rejects.toThrow("--then");
    await expect(runGroupsCommand(cli, "note", chat.id, { run: status.run!.id, "text-file": noteFile, "if-running": true })).rejects.toThrow("group_discussion_paused");
    const continued = await runGroupsCommand(cli, "note", chat.id, { run: status.run!.id, "text-file": noteFile, then: "resume", revision: status.run!.revision }) as GroupDiscussionView;
    expect(continued.run).toMatchObject({ status: "running", noteCount: 1, latestNote: { text: "CORRECT question" } });
    expect(continued.run!.steps.at(-1)).toMatchObject({ botId: "gamma", status: "queued" });
    // Pause holds gamma's undelivered input; a new topic then replaces the run.
    await runGroupsCommand(cli, "pause", chat.id, { run: status.run!.id });
    status = await runGroupsCommand(cli, "status", chat.id, {}) as GroupDiscussionView;
    expect(status.run!.status).toBe("paused");
    await writeFile(topicFile, "Fresh topic");
    const replaced = await runGroupsCommand(cli, "start", chat.id, { "text-file": topicFile, revision: settings.revision, supersedes: status.run!.id }) as GroupDiscussionView;
    expect(replaced.run).toMatchObject({ topic: "Fresh topic", status: "running" });
    expect((await hub.store.db.get("SELECT status FROM group_discussions WHERE id=?", [status.run!.id]))).toEqual({ status: "ended" });
    const ended = await runGroupsCommand(cli, "end", chat.id, { run: replaced.run!.id }) as GroupDiscussionView;
    expect(ended.run).toMatchObject({ id: replaced.run!.id, status: "ended" });
    await expect(runGroupsCommand(cli, "resume", chat.id, { run: replaced.run!.id })).rejects.toThrow("缺少 --revision");
  });

  it("identifies the topic required for a note before uploading to the root group", async () => {
    hub = await HubServer.start({ stateDir: root });
    for (const id of ["alpha", "beta"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, "fixture"]);
    const group = await hub.store.createConversation("owner", ["alpha", "beta"], "Panel", "note-target-group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "Topic", "note-target-topic", { parentId: group.id });
    const old = await hub.store.groupSettings("owner", group.id);
    await hub.store.updateGroup("owner", group.id, { title: group.title, expectedTitle: group.title, botIds: group.botIds, expectedBotIds: group.botIds, expectedRevision: old.revision, policy: { ...old.policy, mode: "sequential" } });
    const settings = await hub.store.groupSettings("owner", group.id);
    const started = await hub.groupDiscussions.start("owner", topic.id, { requestId: "topic-run", revision: settings.revision, text: "Only in this topic" });
    const { token, capabilities } = await session(), cli = client(token, capabilities);
    const file = path.join(root, "note-target.txt"); await writeFile(file, "The note belongs to the topic");
    await expect(runGroupsCommand(cli, "note", group.id, { run: started.run!.id, file: [file], "request-id": "wrong-target" })).rejects.toThrow(`groups note ${topic.id}`);
    expect(await hub.store.db.all("SELECT id FROM attachments WHERE conversation_id=?", [group.id])).toHaveLength(0);
    // The explicit target retains the exact-run and replay contract, even after
    // the discussion ends. It never follows a newer active run automatically.
    const options = { run: started.run!.id, "text-file": file, "request-id": "topic-note" };
    await runGroupsCommand(cli, "note", topic.id, options);
    await runGroupsCommand(cli, "end", group.id, { run: started.run!.id });
    await runGroupsCommand(cli, "note", topic.id, options);
    expect(await hub.store.db.all("SELECT id FROM messages WHERE client_msg_id LIKE 'gdnote_%'")).toHaveLength(1);
  });

  it("refuses an old Hub before any request and validates options per command", async () => {
    const request = vi.fn(), putChunk = vi.fn();
    await expect(runGroupsCommand({ ready: { serverCapabilities: [] }, request, putChunk }, "show", "group", {})).rejects.toThrow("请先更新主机");
    const modern = { ready: { serverCapabilities: ["groups.discussion.v1"] }, request, putChunk };
    await expect(runGroupsCommand(modern, "show", "group", { run: "x" })).rejects.toThrow("不支持 --run");
    await expect(runGroupsCommand(modern, "start", "chat", { "text-file": "/missing" })).rejects.toThrow("缺少 --revision");
    await expect(runGroupsCommand(modern, "pause", "chat", { revision: "r1" })).rejects.toThrow("缺少 --run");
    await expect(runGroupsCommand(modern, "skip", "chat", {})).rejects.toThrow("用法");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("tarobot groups entry point", () => {
  it("routes flags, allows repeated --file and prints request IDs to stderr", async () => {
    await initializeHost(root, "CLI fixture");
    const view = { settings: { group: { id: "g", type: "group", title: "G", ownerId: "owner", botIds: ["a", "b"], archived: false, createdAt: 1 }, policy: { mode: "sequential", botOrder: ["a", "b"], maxRounds: 2 }, revision: "gs_x" }, run: null };
    const request = vi.fn().mockResolvedValue(view), close = vi.fn();
    const connect = vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ request, close, ready: { serverCapabilities: ["groups.discussion.v1"] } } as unknown as LocalHostClient);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runHostCli(["groups", "status", "g", "--state-dir", root]);
    expect(connect).toHaveBeenCalledExactlyOnceWith(await realpath(root), {});
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/conversations/g/discussion");
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(view);
    expect(close).toHaveBeenCalledTimes(1);
    expect(HOST_CLI_HELP).toContain("groups start CONVERSATION --text-file FILE --revision REV");
    await expect(runHostCli(["groups", "pause", "g", "--run", "a", "--run=b", "--state-dir", root])).rejects.toThrow("不能重复 --run");
    await expect(runHostCli(["groups", "status", "g", "--yes", "--state-dir", root])).rejects.toThrow("不支持 --yes");
    expect(HOST_CLI_HELP).toContain("[--participants BOT,BOT] [--supersedes RUN_ID]");
    expect(HOST_CLI_HELP).toContain("[--then resume|retry --revision REV] [--if-running]");
    // New flags reach the command (which refuses them on an older Host before any request).
    request.mockClear();
    await expect(runHostCli(["groups", "note", "g", "--run", "r", "--then", "resume", "--revision", "r2", "--if-running", "--state-dir", root])).rejects.toThrow("更新主机");
    // Repeatable note attachments must reach capability negotiation, not be
    // rejected by the generic duplicate-target guard.
    await expect(runHostCli(["groups", "note", "g", "--run", "r", "--file", "/first.md", "--file", "/second.md", "--state-dir", root])).rejects.toThrow("更新主机");
    await expect(runHostCli(["groups", "start", "g", "--text-file", "/missing", "--revision", "gs_x", "--participants", "a,b", "--state-dir", root])).rejects.toThrow("更新主机");
    await expect(runHostCli(["groups", "status", "g", "--participants", "a,b", "--state-dir", root])).rejects.toThrow("不支持 --participants");
    expect(request).not.toHaveBeenCalled();
  });
});
