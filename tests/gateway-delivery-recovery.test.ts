import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { redeliverRecoveredCoreObligations } from "../src/core/delivery-recovery.js";
import { readDeliveryObligations } from "../src/state/delivery-obligation-store.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { blocksText } from "../src/client-protocol/index.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { gatewayCrashFixture } from "./helpers/gateway-crash-fixture.js";
import * as instanceConfig from "../src/state/instance-config.js";
import { createRunRecord, recordRunEvent } from "../src/core/run-record.js";
import { initialCoreRunState, renderCoreRunCard } from "../src/core/card-renderer.js";
import { RunJournal } from "../src/hub/run-journal.js";

it("keeps captured details when shutdown interrupts the live publication acknowledgement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-publication-stop-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const chat = await hub.store.createConversation("owner", ["alpha"], "Journal", "journal");
  let release!: () => void, messageId = "";
  const held = new Promise<void>(resolve => { release = resolve; });
  const publish = hub.store.publishBotMessage.bind(hub.store);
  const intercepted = vi.spyOn(hub.store, "publishBotMessage").mockImplementationOnce(async (...args) => {
    const message = await publish(...args); messageId = message.id; await held; return message;
  });
  const transport = new GatewayTransport({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret });
  const channel = new GatewayChannel(transport);
  try {
    await channel.connect(); await vi.waitFor(() => expect(transport.capabilities).toContain("runs.v1"));
    const state = initialCoreRunState(chat.id); state.nativeRun = createRunRecord();
    for (let i = 0; i < 13; i++) recordRunEvent(state.nativeRun, { type: "tool_use", toolUseId: String(i), toolName: "Read" });
    const sending = channel.send(chat.id, { card: renderCoreRunCard(state) }).catch(error => error);
    await vi.waitFor(() => expect(messageId).not.toBe(""));
    await channel.disconnect(); expect(await sending).toMatchObject({ message: "gateway_stopped" });
    const outbox = JSON.parse(await readFile(path.join(stateDir, "gateway-outbox.json"), "utf8"));
    expect(outbox.requests.filter((r: any) => r.method === "run.write").flatMap((r: any) => r.params.entries)).toHaveLength(13);
    release(); await channel.connect();
    await transport.request("conversation", { conversationId: chat.id });
    expect((await new RunJournal(hub.store).read("owner", messageId, 0)).entries).toHaveLength(13);
  } finally { release(); await channel.disconnect(); intercepted.mockRestore(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);

it("persists unsent run details on channel shutdown and replays them before a reused channel continues", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-journal-stop-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const chat = await hub.store.createConversation("owner", ["alpha"], "Journal", "journal");
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let started = false;
  const write = RunJournal.prototype.write;
  const intercepted = vi.spyOn(RunJournal.prototype, "write").mockImplementationOnce(async function(this: RunJournal, botId, input) { started = true; await held; return write.call(this, botId, input); });
  const transport = new GatewayTransport({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret });
  const channel = new GatewayChannel(transport);
  try {
    await channel.connect(); await vi.waitFor(() => expect(transport.capabilities).toContain("runs.v1"));
    const state = initialCoreRunState(chat.id); state.nativeRun = createRunRecord();
    for (let i = 0; i < 13; i++) recordRunEvent(state.nativeRun, { type: "tool_use", toolUseId: String(i), toolName: "Read" });
    const sent = await channel.send(chat.id, { card: renderCoreRunCard(state) });
    await vi.waitFor(() => expect(started).toBe(true));
    await channel.disconnect();
    const outbox = JSON.parse(await readFile(path.join(stateDir, "gateway-outbox.json"), "utf8"));
    expect(outbox.requests.filter((r: any) => r.method === "run.write").flatMap((r: any) => r.params.entries)).toHaveLength(13);
    release();
    await transport.connect(); // Both public connect paths must restore the writer.
    await transport.request("conversation", { conversationId: chat.id });
    expect((await new RunJournal(hub.store).read("owner", sent.messageId, 0)).entries).toHaveLength(13);
    recordRunEvent(state.nativeRun, { type: "tool_use", toolUseId: "new", toolName: "Read" });
    await channel.updateCard(sent.messageId, renderCoreRunCard(state));
    await vi.waitFor(async () => expect((await new RunJournal(hub.store).read("owner", sent.messageId, 0)).entries).toHaveLength(14));
  } finally { release(); await channel.disconnect(); intercepted.mockRestore(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);

it.each([false, true])("recovers a final answer and guarded image before retiring interrupted input (run sweep failed: %s), without Feishu delivery", async sweepFails => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-final-recovery-")), stateDir = path.join(root, "bot");
  const workspace = path.join(stateDir, "workspace"); await mkdir(workspace, { recursive: true });
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", workspacePath: workspace }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const c = await hub.store.createConversation("owner", ["alpha"], "Recovery", "create");
  const { message } = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "original", text: "Generate report", attachments: [] });
  const image = path.join(workspace, "report.png"); await writeFile(image, "image fixture");
  const base = { channel: "lark", state: "attempting", attempts: 0, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000, ownerPid: 99_999_999 };
  await writeFile(path.join(stateDir, "delivery-obligations.json"), JSON.stringify({ obligations: [
    { ...base, id: "client_final", chatId: c.id, conversationKey: `lark:${c.id}`, replyTo: message.id, content: `Final report saved before crash\n[send-image:${image}]\n[cron-add:{"in":"1h","prompt":"Must not repeat"}]` },
    { ...base, id: "feishu_final", chatId: "oc_previous", content: "Only Feishu should receive this" },
  ] }));
  const feishu = { send: vi.fn(async () => ({ messageId: "feishu_result" })) };
  await redeliverRecoveredCoreObligations({ channel: feishu, stateDir, locale: "zh" });
  expect(feishu.send).toHaveBeenCalledTimes(1);
  expect(feishu.send.mock.calls[0]).toEqual(expect.arrayContaining(["oc_previous"]));
  expect((await readDeliveryObligations(stateDir)).find((r) => r.id === "client_final")).toMatchObject({ attempts: 0, ownerPid: 99_999_999 });
  await mkdir(path.join(stateDir, "gateway-receipts"));
  await writeFile(path.join(stateDir, "gateway-receipts", createHash("sha256").update(`message:${message.id}`).digest("hex") + ".json"), JSON.stringify({ state: "running" }));
  await writeFile(path.join(stateDir, "gateway-outbox.json"), JSON.stringify({ requests: [{ v: 1, type: "instance.request", id: "old_publication", method: "publish", params: { id: "old_partial", conversationId: c.id, replyTo: message.id, status: "streaming", version: 1, blocks: [{ type: "text", text: "Partial text from journal" }] } }] }));
  const engine = vi.fn(async () => ({ text: "Do not rerun" }));
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error("feishu_forbidden"); });
  const warnings: string[] = [];
  if (sweepFails) vi.spyOn(hub.store, "recoverOrphanRuns").mockRejectedValueOnce(new Error("transient_sweep_failure"));
  const options = { onWarning: (warning: string) => warnings.push(warning), stateDir, url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, bridge: { handleAuthorizedMessage: engine }, runtime: createCoreServiceRuntime({ createDocument: forbidden, createChat: forbidden, detectLarkCli: forbidden }) };
  let channel = await attachGateway(options);
  try {
    await vi.waitFor(async () => expect(await hub.store.pendingForBot("alpha")).toHaveLength(0), { timeout: 8000 });
    const snapshot = await hub.store.snapshot("owner", c.id);
    const recovered = snapshot.messages.filter((m) => m.authorType === "bot" && m.blocks.some((b) => b.type === "text" && b.text.includes("Final report saved before crash")));
    expect(recovered).toHaveLength(1); expect(recovered[0]!.status).toBe("complete"); expect(blocksText(recovered[0]!.blocks)).toContain("♻️");
    expect(JSON.stringify(snapshot.messages)).not.toContain("Must not repeat"); expect(JSON.stringify(snapshot.messages)).not.toContain("Only Feishu should receive");
    expect(JSON.stringify(snapshot.messages)).toContain('"attachmentId"');
    expect(snapshot.messages.find((m) => m.id === "old_partial")?.status).toBe("error");
    expect((await readDeliveryObligations(stateDir)).every((r) => r.state === "delivered")).toBe(true);
    expect(engine).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
    expect(warnings.includes("gateway_run_recovery_failed")).toBe(sweepFails);
    await channel.disconnect(); channel = await attachGateway(options);
    await vi.waitFor(async () => expect((await hub.store.bots("owner"))[0]?.online).toBe(1));
    // Round-trip after the boot barrier proves recovery settled; no second copy.
    await channel.transport.request("conversation", { conversationId: c.id });
    expect((await hub.store.snapshot("owner", c.id)).messages).toEqual(snapshot.messages);
  } finally { await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);

it.each(["sweep", "configuration"] as const)("does not spend a durable delivery attempt when disconnect interrupts boot %s", async phase => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-stopped-recovery-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") }), secret = randomBytes(32).toString("base64url");
  let release: () => void = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  const sweep = vi.spyOn(hub.store, "recoverOrphanRuns");
  const loadConfig = instanceConfig.loadInstanceConfig, config = vi.spyOn(instanceConfig, "loadInstanceConfig");
  if (phase === "sweep") sweep.mockImplementationOnce(async () => { await held; });
  else config.mockImplementationOnce(async (...args) => { await held; return loadConfig(...args); });
  let channel: Awaited<ReturnType<typeof attachGateway>> | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const c = await hub.store.createConversation("owner", ["alpha"], "Interrupted boot", "create");
    const owed = { id: "last_retry", channel: "lark", chatId: c.id, conversationKey: `lark:${c.id}`, content: "The saved final answer still deserves its last delivery attempt", state: "attempting", attempts: 2, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000, ownerPid: 99_999_999 };
    await writeFile(path.join(stateDir, "delivery-obligations.json"), JSON.stringify({ obligations: [owed] }));
    const options = { stateDir, url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, bridge: { handleAuthorizedMessage: vi.fn(async () => ({ text: "Must not rerun" })) }, runtime: createCoreServiceRuntime() };
    channel = await attachGateway(options);
    await vi.waitFor(() => expect(phase === "sweep" ? sweep : config).toHaveBeenCalledTimes(1));
    const disconnected = channel.disconnect();
    if (phase === "configuration") release();
    await disconnected;
    // Real disconnect rejects the pending WebSocket sweep or stops a worker
    // awaiting config IO: neither may claim or rewrite the saved obligation.
    expect(await readDeliveryObligations(stateDir)).toEqual([owed]);
    expect((await hub.store.snapshot("owner", c.id)).messages).toEqual([]);
    release();
    channel = await attachGateway(options);
    await vi.waitFor(async () => expect(await readDeliveryObligations(stateDir)).toEqual([expect.objectContaining({ id: owed.id, state: "delivered", attempts: 3 })]), { timeout: 5000 });
    expect((await hub.store.snapshot("owner", c.id)).messages.filter(message => blocksText(message.blocks).includes(owed.content))).toHaveLength(1);
    expect(options.bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  } finally { release(); await channel?.disconnect(); sweep.mockRestore(); config.mockRestore(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);

it("holds input behind one boot sweep across a real Hub reconnect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-boot-barrier-"));
  const stateDir = path.join(root, "hub"); let hub = await HubServer.start({ stateDir }); const port = Number(new URL(hub.url).port);
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const c = await hub.store.createConversation("owner", ["alpha"], "Recovery ordering", "create");
  await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "one", text: "Wait for recovery", attachments: [] });
  let release: () => void = () => {}; const held = new Promise<void>((resolve) => { release = resolve; });
  const transport = new GatewayTransport({ stateDir: path.join(root, "bot"), url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret });
  const boot = vi.fn(async () => { await held; }); transport.onBoot = boot;
  const channel = new GatewayChannel(transport), invoke = vi.fn(); channel.on("message", invoke);
  await channel.connect();
  try {
    await vi.waitFor(() => expect(boot).toHaveBeenCalledTimes(1));
    await transport.request("conversation", { conversationId: c.id }); expect(invoke).not.toHaveBeenCalled();
    await hub.close(); hub = await HubServer.start({ stateDir, port });
    await vi.waitFor(async () => expect((await hub.store.bots("owner"))[0]?.online).toBe(1), { timeout: 5000 });
    await transport.request("conversation", { conversationId: c.id });
    expect(boot).toHaveBeenCalledTimes(1); expect(invoke).not.toHaveBeenCalled();
    release(); await vi.waitFor(async () => expect(await hub.store.pendingForBot("alpha")).toHaveLength(0), { timeout: 5000 });
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { release(); await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);

it.each([false, true])("recovers a complete long reply after SIGKILL between durable body commit and publication (background=%s)", async (background) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-long-crash-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const text = "完整正文🙂\n".repeat(100000) + "LONG_LEDGER_END", responseFile = path.join(root, "response.txt"); await writeFile(responseFile, text);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const c = await hub.store.createConversation("owner", ["alpha"], "Crash recovery", "create");
  const options = { stateDir, responseFile, url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, background };
  let fixture = gatewayCrashFixture({ ...options, crash: true });
  try {
    await vi.waitFor(() => expect(fixture.messages, fixture.output()).toContain("ready"), { timeout: 15000 });
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "original", text: "Generate a long answer", attachments: [] });
    await vi.waitFor(() => expect(fixture.messages, fixture.output()).toContain("before-publish"), { timeout: 15000 });
    expect(fixture.messages.filter((m) => m === "engine")).toHaveLength(1);
    const owed = (await readDeliveryObligations(stateDir))[0]!; expect(owed.contentRef?.bytes).toBeGreaterThan(1024 * 1024); expect(owed.state).toBe("attempting");
    expect((await stat(path.join(stateDir, "delivery-obligations.json"))).size).toBeLessThan(2000);
    expect(JSON.stringify(await hub.store.snapshot("owner", c.id))).not.toContain("LONG_LEDGER_END");
    expect(await readFile(path.join(stateDir, "gateway-outbox.json"), "utf8").catch(() => "")).not.toContain("LONG_LEDGER_END");
    await fixture.kill(); fixture = gatewayCrashFixture({ ...options, crash: false });
    await vi.waitFor(async () => expect((await readDeliveryObligations(stateDir))[0]?.state, fixture.output()).toBe("delivered"), { timeout: 15000 });
    await vi.waitFor(async () => expect(await hub.store.pendingForBot("alpha")).toHaveLength(0), { timeout: 5000 });
    const snapshot = await hub.store.snapshot("owner", c.id), matches = snapshot.messages.filter((m) => blocksText(m.blocks).includes("LONG_LEDGER_END"));
    expect(matches).toHaveLength(1); expect(matches[0]!.status).toBe("complete"); expect(blocksText(matches[0]!.blocks)).toContain("♻️"); expect(blocksText(matches[0]!.blocks)).toContain(text);
    expect(fixture.messages).not.toContain("engine");
    await fixture.kill(); fixture = gatewayCrashFixture({ ...options, crash: false });
    await vi.waitFor(() => expect(fixture.messages, fixture.output()).toContain("ready"), { timeout: 15000 });
    await vi.waitFor(() => expect(fixture.messages, fixture.output()).toContain("boot-complete"), { timeout: 15000 });
    expect((await hub.store.snapshot("owner", c.id)).messages).toEqual(snapshot.messages); expect(fixture.messages).not.toContain("engine");
  } finally { await fixture.kill(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 45000);
