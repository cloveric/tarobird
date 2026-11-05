import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { DesignShareBroker, metaDesignShareRepository, type DesignSharePeer } from "../src/hub/workbench-design-sharing.js";
import type { DesignShareServerFrame } from "../src/client-protocol/workbench-design-sharing.js";
import { DesignShareClient, openDesignShare, type DesignShareTransport } from "../client/src/workbench-design-collaboration.js";
import { memoryDesign } from "../client/tests/design-session-fixture.js";

let broker: DesignShareBroker;
function device(userId: string, deviceId: string, stallParts: boolean | number = false) {
  const listeners = new Set<(frame: DesignShareServerFrame) => void>();
  let terminated = false;
  const peer: DesignSharePeer & { terminate(): void } = { terminate: () => { terminated = true; }, key: {}, userId, deviceId, active: () => !terminated, validate: async () => undefined,
    send: async frame => {
      if (stallParts && frame.type === "design.share.result" && frame.part) {
        if (typeof stallParts === "number") await new Promise(resolve => setTimeout(resolve, stallParts));
        else await new Promise<never>(() => {});
      }
      for (const listener of [...listeners]) listener(frame);
    } };
  const transport: DesignShareTransport = { send: frame => { void broker.handle(peer, JSON.parse(JSON.stringify(frame))).then(result => peer.send(result)); },
    onFrame: l => { listeners.add(l); return () => { listeners.delete(l); }; }, onStatus: () => () => {} };
  return { client: new DesignShareClient(transport, 5_000), terminated: () => terminated };
}

describe("stalled participant result delivery", () => {
  let directory: string, store: HubStore, conversationId: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "opus-stall-"));
    store = await HubStore.open(directory);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    await store.db.run("INSERT INTO users VALUES('guest','Guest','member')");
    conversationId = (await store.createConversation("owner", ["bot"], "Share", "new")).id;
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversationId]);
    broker = new DesignShareBroker({ requireMember: (u, c) => store.db.serial(() => store.requireMember(u, c)), userName: async u => (await store.user(u))?.name, repository: metaDesignShareRepository(store.db) },
      { limits: { dispatchTimeoutMs: 1_000, presenceIntervalMs: 5, resultBufferBytes: 1024 * 1024 } });
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });

  it.each([[70, 600, "ok"], [95, 800, "design_share_timeout"]] as const)("keeps a progressing connection alive (%i comments, %i ms per fragment)", async (count, delay, expected) => {
    const made = memoryDesign();
    for (let i = 0; i < count; i++) await made.session.request("comments.create", { anchor: `#a${i}`, label: "Board", text: `${i} ${"x".repeat(9000)}` });
    const owner = device("owner", "mac"), slow = device("guest", "laptop", delay);
    const { view } = await openDesignShare(owner.client, made.session, { conversationId, windowId: "source", title: "Design" });
    const shareId = view.shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
    await slow.client.request({ op: "join", shareId, windowId: "guest" });
    const read = await slow.client.request({ op: "call", shareId, windowId: "guest", call: "comments.snapshot", payload: {} }).then(() => "ok", (error: Error) => error.message);
    expect(read).toBe(expected); expect(slow.terminated()).toBe(false);
    expect((broker as unknown as { outgoingReplyBytes: number }).outgoingReplyBytes).toBe(0);
    // Even if the whole result exceeded its cap, other App operations remain usable.
    expect(await slow.client.request({ op: "call", shareId, windowId: "guest", call: "session", payload: {} })).toMatchObject({ status: 200 });
  }, 30_000);

  it("expires a stalled stream, terminates its peer and makes room for other members", async () => {
    const made = memoryDesign(undefined, { user: () => ({ id: "owner", name: "Owner" }) });
    for (let i = 0; i < 70; i++) await made.session.request("comments.create", { anchor: `#a${i}`, label: "Board", text: `${i} ${"x".repeat(9_000)}` });
    const owner = device("owner", "mac");
    const { view } = await openDesignShare(owner.client, made.session, { conversationId, windowId: "w-src", title: "Deck" });
    const shareId = (view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
    const stalled = device("guest", "laptop", true), phone = device("owner", "phone");
    await stalled.client.request({ op: "join", shareId, windowId: "w-guest" });
    await phone.client.request({ op: "join", shareId, windowId: "w-phone" });
    const first = await stalled.client.request({ op: "call", shareId, windowId: "w-guest", call: "comments.snapshot", payload: {} }).then(() => "ok", (e: { code?: string }) => e.code);
    // Well past the Host dispatch deadline (1 s) and the requester's own timeout (2 s).
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const held = (broker as unknown as { outgoingReplyBytes: number }).outgoingReplyBytes;
    const other = await phone.client.request({ op: "call", shareId, windowId: "w-phone", call: "comments.snapshot", payload: {} }).then(() => "ok", (e: { code?: string }) => e.code);
    expect(held).toBe(0);
    expect(stalled.terminated()).toBe(true);
    expect(other).toBe("ok");
    expect(first).toBe("design_share_timeout");
  }, 20_000);
});
