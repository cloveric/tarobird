import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { DesignShareBroker, metaDesignShareRepository, type DesignSharePeer } from "../src/hub/workbench-design-sharing.js";
import { designShareRequestFrameSchema, type DesignShareServerFrame } from "../src/client-protocol/workbench-design-sharing.js";
import { DesignShareClient, joinDesignShare, openDesignShare, type DesignShareTransport } from "../client/src/workbench-design-collaboration.js";
import { memoryDesign } from "../client/tests/design-session-fixture.js";

let broker: DesignShareBroker;
function device(userId: string, deviceId: string) {
  const listeners = new Set<(frame: DesignShareServerFrame) => void>();
  const peer: DesignSharePeer = { key: {}, userId, deviceId, active: () => true, validate: async () => undefined,
    send: async frame => { for (const listener of [...listeners]) listener(frame); } };
  const transport: DesignShareTransport = {
    send: input => { const frame = designShareRequestFrameSchema.parse(input); /* connection.ts: ws.send(JSON.stringify(frame)) */ void broker.handle(peer, JSON.parse(JSON.stringify(frame))).then(result => peer.send(result)); },
    onFrame: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, onStatus: () => () => {} };
  return { client: new DesignShareClient(transport, 5_000) };
}

describe("bounded large results through source, broker and mirror", () => {
  let directory: string, store: HubStore, conversationId: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "opus-large-reply-"));
    store = await HubStore.open(directory);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    await store.db.run("INSERT INTO users VALUES('guest','Guest','member')");
    conversationId = (await store.createConversation("owner", ["bot"], "Share", "new")).id;
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversationId]);
    broker = new DesignShareBroker({ requireMember: (u, c) => store.db.serial(() => store.requireMember(u, c)), userName: async u => (await store.user(u))?.name, repository: metaDesignShareRepository(store.db) },
      { limits: { dispatchTimeoutMs: 2_000, presenceIntervalMs: 5 } });
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });

  it("comments.snapshot of a legal (< 2 MiB) comments record", async () => {
    const owner = device("owner", "mac"), guest = device("guest", "laptop");
    const made = memoryDesign();
    // 140 legal comments of 9,000 characters (limits: 10,000 chars/message, 500 threads, 2 MiB record).
    for (let i = 0; i < 140; i++) expect(await made.session.request("comments.create", { anchor: `#a${i}`, label: "Board", text: `${i} ${"x".repeat(9_000)}` })).toMatchObject({ status: 201 });
    const local = await made.session.request("comments.snapshot", {}) as { status: number; body: unknown };
    const localBytes = new TextEncoder().encode(JSON.stringify(local.body)).length;
    expect(local.status).toBe(200);
    const { view } = await openDesignShare(owner.client, made.session, { conversationId, windowId: "w-src", title: "Deck" });
    const shareId = (view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
    const mirror = await joinDesignShare(guest.client, { shareId, windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    expect(mirror.state().disconnected).toBe(false);
    const remote = await mirror.session.request("comments.snapshot", {}).then(value => ({ resolved: (value as { status: number }).status, threads: (value as { body: { threads: unknown[] } }).body.threads.length }), (error: { code?: string; message: string }) => ({ rejected: error.code ?? error.message }));
    expect(localBytes).toBeGreaterThan(1024 * 1024);
    expect(remote).toEqual({ resolved: 200, threads: 140 });
    expect(mirror.state().disconnected).toBe(false);
    // Repeated large reads keep the same joined session usable.
    const again = await mirror.session.request("comments.snapshot", {}).then(() => "ok", (error: { code?: string }) => error.code);
    expect(again).toBe("ok");
  }, 30_000);
  it("history.diff of one ordinary rewrite of a long-line HTML file", async () => {
    const owner = device("owner", "mac"), guest = device("guest", "laptop");
    const made = memoryDesign();
    const html = (tag: string) => Array.from({ length: 400 }, (_, i) => `<div style="${tag}-${i}">${"s".repeat(1_400)}</div>`).join("\n");
    const put = (content: string) => { const doc = made.session.document; const bytes = new TextEncoder().encode(content); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return made.session.request("publish", { files: { "project/Main.dc.html": { base64: btoa(bin), contentType: "text/html", ifMatch: doc.files["project/Main.dc.html"]?.sha256 ?? null } } }); };
    expect(await put(html("a"))).toMatchObject({ status: 200 });
    expect(await put(html("b"))).toMatchObject({ status: 200 });
    const version = made.store.history!.versions.at(-1)!.n;
    const localDiff = await made.session.historyDiff({ version, path: "project/Main.dc.html" });
    const localBytes = new TextEncoder().encode(JSON.stringify(localDiff)).length;
    const { view } = await openDesignShare(owner.client, made.session, { conversationId, windowId: "w-src", title: "Deck" });
    const shareId = (view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
    const mirror = await joinDesignShare(guest.client, { shareId, windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    const remote = await mirror.session.historyDiff({ version, path: "project/Main.dc.html" }).then(() => "ok", (error: { code?: string; message: string }) => error.code ?? error.message);
    expect(localBytes).toBeGreaterThan(512 * 1024);
    expect(remote).toBe("ok");
    expect(mirror.state().disconnected).toBe(false);
  });
});
