import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { DesignShareBroker, metaDesignShareRepository, type DesignSharePeer } from "../src/hub/workbench-design-sharing.js";
import type { DesignShareServerFrame } from "../src/client-protocol/workbench-design-sharing.js";
import { DesignShareClient, joinDesignShare, openDesignShare, type DesignShareTransport } from "../client/src/workbench-design-collaboration.js";
import { designTextFile, type DesignDocument } from "../client/src/workbench-design.js";
import { memoryDesign } from "../client/tests/design-session-fixture.js";

let broker: DesignShareBroker;
const wire = (document: DesignDocument, file: string, content: string) => { const encoded = designTextFile(content, "text/plain"); return { [file]: { base64: encoded.base64, contentType: encoded.contentType, ifMatch: document.files[file]?.sha256 ?? null } }; };

describe("joining while the owner keeps saving", () => {
  let directory: string, store: HubStore, conversationId: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "opus-join-catchup-"));
    store = await HubStore.open(directory);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    await store.db.run("INSERT INTO users VALUES('guest','Guest','member')");
    conversationId = (await store.createConversation("owner", ["bot"], "Share", "new")).id;
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversationId]);
    broker = new DesignShareBroker({ requireMember: (u, c) => store.db.serial(() => store.requireMember(u, c)), userName: async u => (await store.user(u))?.name, repository: metaDesignShareRepository(store.db) },
      { limits: { dispatchTimeoutMs: 2_000, presenceIntervalMs: 5 } });
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });

  it("restarts an obsolete manifest read and joins the current snapshot", async () => {
    const made = memoryDesign();
    const ownerListeners = new Set<(frame: DesignShareServerFrame) => void>();
    const ownerPeer: DesignSharePeer = { key: {}, userId: "owner", deviceId: "mac", active: () => true, validate: async () => undefined, send: async frame => { for (const l of [...ownerListeners]) l(frame); } };
    const owner = new DesignShareClient({ send: frame => { void broker.handle(ownerPeer, frame).then(result => ownerPeer.send(result)); }, onFrame: l => { ownerListeners.add(l); return () => { ownerListeners.delete(l); }; }, onStatus: () => () => {} }, 5_000);
    await made.session.request("publish", { files: wire(made.session.document, "project/note.txt", "initial") });
    const { view } = await openDesignShare(owner, made.session, { conversationId, windowId: "w-src", title: "Deck" });
    const shareId = (view as { shareId: string }).shareId;
    await owner.request({ op: "grant", shareId, userId: "guest", role: "viewer" });

    const guestListeners = new Set<(frame: DesignShareServerFrame) => void>();
    const deliver = (frame: DesignShareServerFrame) => { for (const l of [...guestListeners]) l(frame); };
    let fetches = 0, holdFirstFetchReply: string | undefined;
    const initialSha = made.store.design.files["project/note.txt"].sha256, shaA = designTextFile("owner save A", "text/plain").sha256;
    let heldInitial = false, racedA = false;
    const guestPeer: DesignSharePeer = { key: {}, userId: "guest", deviceId: "laptop", active: () => true, validate: async () => undefined,
      send: async frame => {
        // Save A: after the source served the member's fetch of note.txt, before that reply arrives.
        if (frame.type === "design.share.result" && frame.requestId === holdFirstFetchReply) {
          holdFirstFetchReply = undefined;
          await made.session.request("publish", { files: wire(made.session.document, "project/note.txt", "owner save A") });
          await new Promise(resolve => setTimeout(resolve, 20)); // change event for A reaches the member first
        }
        deliver(frame);
      } };
    const transport: DesignShareTransport = { send: frame => {
      const run = () => void broker.handle(guestPeer, frame).then(result => guestPeer.send(result));
      if (frame.request.op === "fetch") fetches++;
      if (frame.request.op === "fetch" && frame.request.sha256 === initialSha && !heldInitial) { heldInitial = true; holdFirstFetchReply = frame.requestId; }
      // Save B: while the member is fetching A (only the candidate's catch-up refresh fetches A during join).
      if (frame.request.op === "fetch" && frame.request.sha256 === shaA && !racedA) { racedA = true; void made.session.request("publish", { files: wire(made.session.document, "project/note.txt", "owner save B") }).then(run); return; }
      run();
    }, onFrame: l => { guestListeners.add(l); return () => { guestListeners.delete(l); }; }, onStatus: () => () => {} };
    const guest = new DesignShareClient(transport, 5_000);
    const outcome = await joinDesignShare(guest, { shareId, windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) })
      .then(async mirror => { const shown = new TextDecoder().decode(Buffer.from(mirror.session.document.files["project/note.txt"].base64, "base64")); await mirror.leave({ discard: true }); return { joined: true, shown }; },
        (error: { code?: string; message: string }) => ({ joined: false, error: error.code ?? error.message }));

    expect(outcome).toEqual({ joined: true, shown: "owner save B" });
  });
});
