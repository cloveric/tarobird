import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

// Disposable local Hub, real SQLite, durable Gateway outbox and signed client.
// Events are synthetic: this does NOT measure provider CLI, VPS or phone paint.
const sourceRoot = process.env.TAROBOT_BENCH_SOURCE ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => import(pathToFileURL(path.join(sourceRoot, "src", file)).href);
const { HubServer } = await source("hub/server.ts");
const { GatewayChannel } = await source("gateway/channel.ts");
const { GatewayTransport } = await source("gateway/transport.ts");
const { createCoreRunCardController } = await source("core/message-handler.ts");
const { hashSecret, deviceProof, parsePublicKey, serverProof } = await source("hub/auth.ts");
const { nodeFrameReader } = await source("client-protocol/fragments-node.ts");
const { CAPABILITIES } = await source("client-protocol/index.ts");
const { applyMessageDelta } = await source("client-protocol/stream.ts");

async function until(check: () => boolean, label: string, timeout = 15000) {
  const deadline = performance.now() + timeout;
  while (!check()) { if (performance.now() > deadline) throw new Error(`Timed out: ${label}`); await sleep(5); }
}
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! * 10) / 10;
};

for (let repeat = 1; repeat <= Number(process.env.TAROBOT_BENCH_REPEATS ?? 1); repeat++) for (const scenario of [
  { name: "short", bots: 1, tools: 0, textChars: 0, reconnect: false },
  { name: "long-history-concurrent", bots: 5, tools: 100, textChars: 0, reconnect: false },
  { name: "long-answer-concurrent", bots: 5, tools: 0, textChars: 64 * 1024, reconnect: false },
  { name: "live-tools-concurrent", bots: 5, tools: 0, textChars: 4096, reconnect: false },
  { name: "large-tool-output-concurrent", bots: 5, tools: 0, textChars: 4096, reconnect: false },
  { name: "gateway-reconnect", bots: 1, tools: 0, textChars: 0, reconnect: true },
].filter(scenario => !process.env.TAROBOT_BENCH_SCENARIO || scenario.name === process.env.TAROBOT_BENCH_SCENARIO)) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-run-transport-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const channels: any[] = [], controllers: any[] = [], conversations: string[] = [];
  let socket: WebSocket | undefined;
  const frames: any[] = [], sent = new Map<string, number>(), received = new Map<string, number>();
  const messages = new Map<string, any>();
  const phases = new Map<string, string>();
  let measuring = false, downstreamBytes = 0, messageUpdates = 0, fullCardUpdates = 0, deltaUpdates = 0, runWrites = 0, publishCalls = 0;
  const roundTrips: number[] = [];
  const rpcErrors: Record<string, number> = {};
  const publishedAt = new Map<string, number>(), receiptAfterPublish: number[] = [], publicationLag: number[] = [];
  try {
    for (let i = 0; i < scenario.bots; i++) {
      const id = `bot_${i}`, secret = randomBytes(32).toString("base64url"), stateDir = path.join(root, id);
      await mkdir(stateDir);
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, hashSecret(secret)]);
      const chat = await hub.store.createConversation("owner", [id], id, `chat_${i}`);
      conversations.push(chat.id);
      const transport = new GatewayTransport({ stateDir, botId: id, secret, url: hub.instanceUrl.replace("http", "ws") + "/instance" });
      const original = transport.request.bind(transport);
      transport.request = async (method: string, params: unknown) => {
        const measure = measuring, start = performance.now();
        if (measure && method === "run.write") runWrites++;
        if (measure && method === "publish") {
          publishCalls++;
          if (process.env.TAROBOT_BENCH_STAGES === "1") {
            const body = JSON.stringify(params);
            for (const [marker, emitted] of sent) if (!publishedAt.has(marker) && body.includes(marker)) { publishedAt.set(marker, start); publicationLag.push(start - emitted); }
          }
        }
        try { return await original(method, params); }
        catch (error) {
          const key = `${method}:${error instanceof Error ? error.message : "unknown"}`;
          rpcErrors[key] = (rpcErrors[key] ?? 0) + 1; throw error;
        } finally { if (measure) roundTrips.push(performance.now() - start); }
      };
      const channel = new GatewayChannel(transport); channels.push(channel);
      await channel.connect();
      await until(() => transport.capabilities?.includes("runs.v1"), "gateway ready");
    }
    const pair = generateKeyPairSync("ed25519");
    // Bootstrap the trusted benchmark device in this disposable Hub. Public
    // pairing now requires an invitation; this measures streaming, not pairing.
    const pairing = await hub.auth.pair({ deviceId: "benchmark", name: "Benchmark", platform: "web", publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "127.0.0.1");
    await hub.auth.approve(pairing.code, "local-owner");
    socket = new WebSocket(hub.url.replace("http", "ws") + "/ws");
    const reader = nodeFrameReader();
    socket.on("message", data => {
      if (measuring) downstreamBytes += Buffer.byteLength(data.toString());
      const frame = reader.read(data.toString());
      if (!frame) return;
      if (frame.type === "snapshot.message") socket!.send(JSON.stringify({ v: 1, type: "snapshot.ack", id: frame.id, count: frame.index + 1 }));
      if (frame.type !== "event") { frames.push(frame); return; }
      if (!["message.created", "message.updated", "message.stream"].includes(frame.kind)) return;
      const message = frame.kind === "message.stream" ? applyMessageDelta(messages.get(frame.payload.messageId), frame.payload) : frame.payload;
      messages.set(message.id, message);
      if (measuring) { messageUpdates++; if (frame.kind === "message.stream") { deltaUpdates++; if (frame.payload.ops.some((op: any) => op.op === "replaceBlock")) fullCardUpdates++; } else fullCardUpdates++; }
      for (const block of message.blocks ?? []) {
        const phase = block.extra?.nativeRun?.phase;
        if (phase) phases.set(frame.conversationId, phase);
      }
      const body = JSON.stringify(message);
      for (const [marker, start] of sent) if (!received.has(marker) && body.includes(marker)) { received.set(marker, performance.now() - start); const published = publishedAt.get(marker); if (published !== undefined) receiptAfterPublish.push(performance.now() - published); }
    });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    const nonce = randomBytes(32).toString("base64url");
    socket.send(JSON.stringify({ v: 1, type: "hello", deviceId: "benchmark", nonce, protocolVersions: [1], capabilities: CAPABILITIES, cursors: {} }));
    await until(() => frames.some(frame => frame.type === "challenge"), "client challenge");
    const challenge = frames.find(frame => frame.type === "challenge");
    assert(verify(null, serverProof("benchmark", challenge.nonce, nonce), parsePublicKey(hub.auth.publicKey), Buffer.from(challenge.signature, "base64")));
    socket.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof("benchmark", challenge.nonce, nonce), pair.privateKey).toString("base64") }));
    await until(() => frames.some(frame => frame.type === "sync.complete"), "client sync");

    for (const [i, channel] of channels.entries()) {
      const controller = await channel.inConversation(conversations[i], () => createCoreRunCardController({ channel, chatId: conversations[i], conversationKey: conversations[i], bridgeChatType: "private", locale: "en" }));
      controllers.push(controller);
      await channel.inConversation(conversations[i], async () => {
        for (let j = 0; j < scenario.tools; j++) {
          await controller.apply({ type: "tool_use", toolName: "Read", toolUseId: `tool_${j}`, toolInput: { path: `/fixture/${j}.txt` } });
          await controller.apply({ type: "tool_result", toolUseId: `tool_${j}`, output: "fixture output\n".repeat(600) });
        }
        const marker = `WARM_${i}_END`; sent.set(marker, performance.now());
        await controller.apply({ type: "assistant_text", text: marker + "x".repeat(scenario.textChars) });
      });
    }
    await until(() => received.size === sent.size, "warmup output");
    await until(() => channels.every(channel => !channel.isBusy()), "warmup journal drained");
    await sleep(200);
    sent.clear(); received.clear(); measuring = true;
    const cpu = process.cpuUsage(), wallStart = performance.now();
    for (let j = 0; j < 40; j++) {
      if (scenario.reconnect && j === 8) channels[0].transport.reconnectAfterDeliveryFailure();
      for (const [i, controller] of controllers.entries()) {
        if (["live-tools-concurrent", "large-tool-output-concurrent"].includes(scenario.name)) await channels[i].inConversation(conversations[i], async () => {
          for (let k = 0; k < (scenario.name === "live-tools-concurrent" ? 6 : 1); k++) {
            await controller.apply({ type: "tool_use", toolName: "Read", toolUseId: `live_${j}_${k}`, toolInput: { path: `/fixture/${j}_${k}.txt` } });
            await controller.apply({ type: "tool_result", toolUseId: `live_${j}_${k}`, output: scenario.name === "large-tool-output-concurrent" ? "x".repeat(65536) : "fixture output\n".repeat(600) });
          }
        });
        const marker = `MARK_${i}_${j}_END`; sent.set(marker, performance.now());
        await channels[i].inConversation(conversations[i], () => controller.apply({ type: "assistant_text", text: ` ${marker}`, delta: true }));
      }
      await sleep(Math.max(0, wallStart + (j + 1) * 50 - performance.now()));
    }
    await until(() => received.size === sent.size, "all measured deltas");
    const terminalStart = performance.now();
    await Promise.all(controllers.map((controller, i) => channels[i].inConversation(conversations[i], () => controller.finish("BENCHMARK_FINAL"))));
    await until(() => conversations.every(chat => phases.get(chat) === "done"), "all terminal receipts");
    const terminalFlushMs = performance.now() - terminalStart;
    const elapsedMs = performance.now() - wallStart, used = process.cpuUsage(cpu);
    measuring = false;
    assert.equal(received.size, scenario.bots * 40);
    let verifiedToolEntries = 0;
    for (let i = 0; i < scenario.bots; i++) {
      const rows = await hub.store.db.all("SELECT payload FROM run_journal WHERE bot_id=?", [`bot_${i}`]);
      const tools = rows.map((row: any) => JSON.parse(row.payload)).filter((entry: any) => entry.kind === "tool");
      assert.equal(tools.length, scenario.tools + (scenario.name === "live-tools-concurrent" ? 240 : scenario.name === "large-tool-output-concurrent" ? 40 : 0));
      assert(tools.every((entry: any) => entry.status === "done"), "Missing final tool revision");
      verifiedToolEntries += tools.length;
    }
    assert(!frames.some(frame => frame.type === "error"), "Client protocol error");
    console.log(JSON.stringify({ scenario: scenario.name, repeat, source: sourceRoot, bots: scenario.bots, historicalToolsPerBot: scenario.tools, answerChars: scenario.textChars,
      events: sent.size, received: received.size, verifiedToolEntries, medianMs: percentile([...received.values()], 0.5), p95Ms: percentile([...received.values()], 0.95), p99Ms: percentile([...received.values()], 0.99), maxMs: percentile([...received.values()], 1),
      messageUpdates, fullCardUpdates, deltaUpdates, downstreamBytes, runWrites, publishCalls, rpcErrors,
      ...(publicationLag.length ? { publicationLagP95Ms: percentile(publicationLag, .95), receiptAfterPublishP95Ms: percentile(receiptAfterPublish, .95) } : {}), rpcP95Ms: percentile(roundTrips, 0.95), elapsedMs: Math.round(elapsedMs), terminalFlushMs: Math.round(terminalFlushMs), cpuMs: Math.round((used.user + used.system) / 1000),
      scope: "synthetic public events -> real local Gateway/Hub/SQLite -> signed WebSocket client receipt; no CLI/VPS/phone rendering" }));
  } finally {
    socket?.terminate();
    for (const channel of channels) await channel.disconnect();
    await hub.close(); await rm(root, { recursive: true, force: true });
  }
}
