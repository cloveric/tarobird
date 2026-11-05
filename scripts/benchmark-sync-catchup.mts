// Isolated signed Hub catch-up benchmark; synthetic messages only.
// npx tsx scripts/benchmark-sync-catchup.mts [scenario-prefix]
// Set TMPDIR to an approved external test directory before running.
// Processing and ACK delays are injected costs, not physical phone measurements.
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { performance } from "node:perf_hooks";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${REPO}/package.json`);
const source = (file: string) => import(pathToFileURL(path.join(REPO, "src", file)).href);
const { WebSocket } = require("ws") as typeof import("ws");
const { HubServer } = await source("hub/server.ts");
const { deviceProof } = await source("hub/auth.ts");
const { nodeFrameReader } = await source("client-protocol/fragments-node.ts");
const { CAPABILITIES } = await source("client-protocol/index.ts");
const { SNAPSHOT_ACTIVITY_CAPABILITY } = await source("client-protocol/snapshot.ts");

type Frame = Record<string, any>;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const keypair = generateKeyPairSync("ed25519");
const publicKey = keypair.publicKey.export({ type: "spki", format: "der" }).toString("base64");

/** Emulates the App: one serial receive chain, per-frame "IDB" cost, snapshot ACK after processing. */
class Phone {
  reader = nodeFrameReader();
  chain: Promise<void> = Promise.resolve();
  frames: { frame: Frame; recv: number; applied?: number }[] = [];
  waiters = new Set<() => void>();
  constructor(readonly ws: InstanceType<typeof WebSocket>, readonly procMs: (f: Frame) => number, readonly ackDelayMs: number) {
    ws.on("message", raw => {
      const recv = performance.now();
      const frame = this.reader.read(raw.toString()) as Frame | undefined; if (!frame) return;
      const entry = { frame, recv } as { frame: Frame; recv: number; applied?: number }; this.frames.push(entry);
      if (frame.type === "pong" || frame.type === "challenge" || frame.type === "ready") { entry.applied = recv; this.notify(); return; }
      this.chain = this.chain.then(async () => {
        const cost = this.procMs(frame); if (cost > 0) await sleep(cost);
        if (frame.type === "snapshot.message") {
          const ack = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: "snapshot.ack", id: frame.id, count: Number(frame.index) + 1 })); };
          this.ackDelayMs ? setTimeout(ack, this.ackDelayMs) : ack();
        }
        entry.applied = performance.now(); this.notify();
      });
    });
  }
  notify() { for (const w of this.waiters) w(); }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async until(predicate: (e: { frame: Frame; recv: number; applied?: number }) => boolean, timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find(predicate); if (hit) return hit;
      if (Date.now() > deadline) throw new Error("timeout");
      await new Promise<void>(r => { const w = () => { this.waiters.delete(w); r(); }; this.waiters.add(w); setTimeout(w, 50); });
    }
  }
}

async function scenario(name: string, opts: { desktop?: boolean; legacy?: boolean; behind: number; baseMessages: number; idleConversations: number; procMs: number; ackDelayMs: number; finalBytes: number; updatesPerReply: number }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hubsync-"));
  const hub = await HubServer.start({ stateDir: root });
  try {
    const pair = await (await fetch(`${hub.url}/api/pair`, { method: "POST", body: JSON.stringify({ deviceId: "device", name: "phone-sim", platform: "ios", publicKey }) })).json() as { code: string };
    await hub.auth.approve(pair.code, "local-owner");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const hist = await hub.store.createConversation("owner", ["bot"], "History", "hist");
    const live = await hub.store.createConversation("owner", ["bot"], "Live", "live");
    const cursors: Record<string, number> = {};
    for (let i = 0; i < opts.idleConversations; i++) {
      const c = await hub.store.createConversation("owner", ["bot"], `Idle ${i}`, `idle-${i}`);
      await hub.store.publishBotMessage("bot", { conversationId: c.id, blocks: [{ type: "text", text: "hello" }] });
      cursors[c.id] = (await hub.store.syncHead("owner", c.id)).seq;
    }
    await hub.store.publishBotMessage("bot", { conversationId: live.id, blocks: [{ type: "text", text: "seed" }] });
    cursors[live.id] = (await hub.store.syncHead("owner", live.id)).seq;
    // Base history the phone already has.
    for (let i = 0; i < opts.baseMessages; i++) await hub.store.publishBotMessage("bot", { conversationId: hist.id, blocks: [{ type: "text", text: `old ${i} ` + "o".repeat(800) }] });
    cursors[hist.id] = (await hub.store.syncHead("owner", hist.id)).seq;
    // Backlog: streaming replies (one durable message.updated per App publication, as in production).
    let produced = 0; const genStarted = performance.now();
    while (produced < opts.behind) {
      const first = await hub.store.publishBotMessage("bot", { conversationId: hist.id, blocks: [{ type: "text", text: "…" }], status: "streaming" }); produced++;
      for (let u = 1; u <= opts.updatesPerReply && produced < opts.behind; u++, produced++) {
        const text = "t".repeat(Math.ceil(opts.finalBytes * u / opts.updatesPerReply));
        await hub.store.publishBotMessage("bot", { id: first.id, conversationId: hist.id, blocks: [{ type: "text", text }], status: u === opts.updatesPerReply ? "complete" : "streaming", version: u + 1 });
      }
    }
    const generationMs = performance.now() - genStarted;

    let desktop: Phone | undefined;
    if (opts.desktop) {
      const all: Record<string, number> = { ...cursors, [hist.id]: (await hub.store.syncHead("owner", hist.id)).seq };
      const dws = new WebSocket(hub.url.replace("http", "ws") + "/ws");
      await new Promise<void>((resolve, reject) => { dws.once("open", () => resolve()); dws.once("error", reject); });
      desktop = new Phone(dws, () => 0, 0); const dn = randomBytes(32).toString("base64url");
      desktop.send({ type: "hello", deviceId: "device", nonce: dn, protocolVersions: [1], capabilities: [...CAPABILITIES, SNAPSHOT_ACTIVITY_CAPABILITY], cursors: all });
      const dc = (await desktop.until(e => e.frame.type === "challenge")).frame;
      desktop.send({ type: "auth", signature: sign(null, deviceProof("device", dc.nonce, dn), keypair.privateKey).toString("base64") });
      await desktop.until(e => e.frame.type === "sync.complete");
    }
    const ws = new WebSocket(hub.url.replace("http", "ws") + "/ws");
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    const phone = new Phone(ws, f => f.type === "event" || f.type === "snapshot.message" ? opts.procMs : 0, opts.ackDelayMs);
    const nonce = randomBytes(32).toString("base64url");
    phone.send({ type: "hello", deviceId: "device", nonce, protocolVersions: [1], capabilities: [...CAPABILITIES, SNAPSHOT_ACTIVITY_CAPABILITY].filter(cap => !opts.legacy || !["snapshot.delta.v1", "sync.conversations.v1"].includes(cap)), cursors, preferredConversationId: live.id });
    const challenge = (await phone.until(e => e.frame.type === "challenge")).frame;
    const authAt = performance.now();
    phone.send({ type: "auth", signature: sign(null, deviceProof("device", challenge.nonce, nonce), keypair.privateKey).toString("base64") });
    const ready = await phone.until(e => e.frame.type === "ready");
    // A reply arrives in a different conversation while catch-up is running.
    await sleep(30);
    const livePublishedAt = performance.now();
    const liveMessage = await hub.store.publishBotMessage("bot", { conversationId: live.id, blocks: [{ type: "text", text: "LIVE during sync" }] });
    const liveFrame = await phone.until(e => e.frame.type === "event" && e.frame.conversationId === live.id && e.frame.payload?.id === liveMessage.id);
    const desktopLive = desktop ? await desktop.until(e => e.frame.type === "event" && e.frame.payload?.id === liveMessage.id) : undefined;
    const syncComplete = await phone.until(e => e.frame.type === "sync.complete");
    await phone.until(e => e.frame.type === "sync.complete" && e.applied !== undefined);
    while (liveFrame.applied === undefined) await sleep(5);
    const syncAppliedAt = phone.frames.find(e => e.frame.type === "sync.complete")!.applied!;
    // Baseline: live event after synchronization.
    const afterAt = performance.now();
    const after = await hub.store.publishBotMessage("bot", { conversationId: live.id, blocks: [{ type: "text", text: "LIVE after sync" }] });
    const afterFrame = await phone.until(e => e.frame.type === "event" && e.frame.payload?.id === after.id);
    while (afterFrame.applied === undefined) await sleep(2);
    const histFrames = phone.frames.filter(e => e.frame.conversationId === hist.id || e.frame.type?.startsWith("snapshot"));
    const kinds = histFrames.reduce<Record<string, number>>((acc, e) => { const k = e.frame.type === "event" ? `event:${e.frame.kind}` : e.frame.type; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
    const bytes = histFrames.reduce((s, e) => s + Buffer.byteLength(JSON.stringify(e.frame)), 0);
    const result = {
      name, ...opts, generationMs: Math.round(generationMs),
      authToReadyMs: Math.round(ready.recv - authAt),
      readyToSyncCompleteRecvMs: Math.round(syncComplete.recv - ready.recv),
      readyToSyncCompleteAppliedMs: Math.round(syncAppliedAt - ready.recv),
      liveDuringSync_recvMs: Math.round(liveFrame.recv - livePublishedAt),
      liveDuringSync_appliedMs: Math.round(liveFrame.applied! - livePublishedAt),
      desktopLiveDuringPhoneSync_recvMs: desktopLive ? +(desktopLive.recv - livePublishedAt).toFixed(1) : undefined,
      liveAfterSync_recvMs: +(afterFrame.recv - afterAt).toFixed(1),
      liveAfterSync_appliedMs: +(afterFrame.applied! - afterAt).toFixed(1),
      historyFrames: kinds, historyBytes: bytes, snapshotMode: histFrames.find(e => e.frame.type === "snapshot.begin")?.frame.mode ?? "replace-or-replay", historyMiB: +(bytes / 1048576).toFixed(2),
    };
    console.log(JSON.stringify(result));
    ws.terminate(); desktop?.ws.terminate();
    return result;
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
}

await mkdir(os.tmpdir(), { recursive: true });
const only = process.argv[2];
const base = { baseMessages: 50, idleConversations: 56, finalBytes: 20_000, updatesPerReply: 300 };
const runs: [string, Parameters<typeof scenario>[1]][] = [
  ["idle-no-backlog", { ...base, behind: 0, procMs: 0, ackDelayMs: 0 }],
  ["replay-900-proc0", { ...base, behind: 900, procMs: 0, ackDelayMs: 0 }],
  ["replay-900-proc5", { ...base, behind: 900, procMs: 5, ackDelayMs: 0 }],
  ["replay-900-proc15", { ...base, behind: 900, procMs: 15, ackDelayMs: 0 }],
  ["snapshot-1200-proc5-rtt0", { ...base, baseMessages: 400, behind: 1200, procMs: 5, ackDelayMs: 0 }],
  ["snapshot-1200-proc5-rtt100", { ...base, baseMessages: 400, behind: 1200, procMs: 5, ackDelayMs: 100 }],
  ["dual-replay-900-150KB", { ...base, finalBytes: 150_000, desktop: true, behind: 900, procMs: 5, ackDelayMs: 0 }],
  ["dual-snapshot-1200-150KB-rtt100", { ...base, finalBytes: 150_000, baseMessages: 400, desktop: true, behind: 1200, procMs: 5, ackDelayMs: 100 }],
  ["legacy-snapshot-1200-proc5-rtt250", { ...base, legacy: true, baseMessages: 400, behind: 1200, procMs: 5, ackDelayMs: 250 }],
  ["snapshot-1200-proc5-rtt250", { ...base, baseMessages: 400, behind: 1200, procMs: 5, ackDelayMs: 250 }],
];
for (const [name, opts] of runs) if (!only || name.startsWith(only)) await scenario(name, opts);
