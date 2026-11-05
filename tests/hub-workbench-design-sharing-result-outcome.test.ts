import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { DesignShareBroker, metaDesignShareRepository, type DesignSharePeer } from "../src/hub/workbench-design-sharing.js";
import { DESIGN_SHARE_LIMITS, type DesignShareServerFrame } from "../src/client-protocol/workbench-design-sharing.js";
import { DesignShareClient, joinDesignShare, openDesignShare, type DesignShareTransport } from "../client/src/workbench-design-collaboration.js";
import { memoryDesign } from "../client/tests/design-session-fixture.js";

let broker: DesignShareBroker;
function device(userId: string, deviceId: string, onSend?: (frame: DesignShareServerFrame) => Promise<void>) {
  const listeners = new Set<(frame: DesignShareServerFrame) => void>();
  const peer: DesignSharePeer = { key: {}, userId, deviceId, active: () => true, validate: async () => undefined,
    send: async frame => { await onSend?.(frame); for (const l of [...listeners]) l(frame); } };
  let writeRequestId = "";
  const transport: DesignShareTransport = { send: frame => { if (frame.request.op === "call" && frame.request.call === "comments.reply") writeRequestId = frame.requestId; void broker.handle(peer, JSON.parse(JSON.stringify(frame))).then(result => peer.send(result)); },
    onFrame: l => { listeners.add(l); return () => { listeners.delete(l); }; }, onStatus: () => () => {} };
  return { client: new DesignShareClient(transport, 10_000), writeRequestId: () => writeRequestId };
}

describe("a committed comment whose response is interrupted between parts", () => {
  let directory: string, store: HubStore, conversationId: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "opus-midstream-"));
    store = await HubStore.open(directory);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    await store.db.run("INSERT INTO users VALUES('guest','Guest','member')");
    conversationId = (await store.createConversation("owner", ["bot"], "Share", "new")).id;
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversationId]);
    broker = new DesignShareBroker({ requireMember: (u, c) => store.db.serial(() => store.requireMember(u, c)), userName: async u => (await store.user(u))?.name, repository: metaDesignShareRepository(store.db) },
      { limits: { dispatchTimeoutMs: 5_000, presenceIntervalMs: 5 } });
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });

  for (const [action, atPart] of [["lower to viewer", 1], ["end the share", 1], ["lower to viewer", 2], ["end the share", 2], ["source reply budget full", 0]] as const) it(`after committing: ${action}, fragment ${atPart}`, async () => {
    const made = memoryDesign(undefined, { user: () => ({ id: "owner", name: "Owner" }) });
    // A long, legal thread (61 messages of 9,000 characters; limits: 200 messages, 10,000 chars, 2 MiB record).
    const created = await made.session.request("comments.create", { anchor: "#a", label: "Board", text: "x".repeat(9_000) }) as { status: number; body: { thread: { id: string } } };
    const threadId = created.body.thread.id;
    for (let i = 0; i < 60; i++) await made.session.request("comments.reply", { id: threadId, text: `${i} ${"y".repeat(9_000)}` });
    const owner = device("owner", "mac");
    const { view } = await openDesignShare(owner.client, made.session, { conversationId, windowId: "w-src", title: "Deck" });
    const shareId = (view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "commenter" });
    let parts = 0, acted = false, committedAtAction = false, actionRequestId = "";
    const guest = device("guest", "laptop", async frame => {
      if (frame.type === "design.share.result" && frame.requestId === guest.writeRequestId() && frame.part && ++parts === atPart && !acted) {
        acted = true; actionRequestId = frame.requestId;
        committedAtAction = made.store.comments!.threads.find(t => t.id === threadId)!.messages.some(m => m.text === "guest reply");
        if (action === "lower to viewer") await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
        else await owner.client.request({ op: "close", shareId });
      }
    });
    const mirror = await joinDesignShare(guest.client, { shareId, windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    const release = action === "source reply budget full" ? owner.client.reserveReply(DESIGN_SHARE_LIMITS.resultBufferBytes) : undefined;
    const outcome = await mirror.session.request("comments.reply", { id: threadId, text: "guest reply" })
      .then(value => ({ resolved: (value as { status: number }).status }), (error: { code?: string; message: string }) => ({ rejected: error.code ?? error.message }));
    release?.();
    const committed = made.store.comments!.threads.find(t => t.id === threadId)!.messages.some(m => m.text === "guest reply" && m.author.principal === "user:guest");

    expect(committed).toBe(true);
    if (atPart) { expect(acted).toBe(true); expect(committedAtAction).toBe(true); } // the owner acted only after the source had committed the reply
    // Delivery stopped after a commit: this is uncertain, never a definite refusal.
    expect(outcome).toEqual({ rejected: "design_share_outcome_unknown" });
  });
});
