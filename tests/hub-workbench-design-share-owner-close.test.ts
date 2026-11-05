import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubError, HubStore } from "../src/hub/store.js";
import { DesignShareBroker, metaDesignShareRepository, type DesignSharePeer } from "../src/hub/workbench-design-sharing.js";
import { DESIGN_SHARE_LIMITS, type DesignShareServerFrame } from "../src/client-protocol/workbench-design-sharing.js";
import { DesignShareClient, DesignShareManager, designShareListActions, type DesignShareTransport, type DesignShareView } from "../client/src/workbench-design-collaboration.js";
import { emptyDesign } from "../client/src/workbench-design.js";
import { memoryDesign } from "../client/tests/design-session-fixture.js";

// Owners end shares without the shared document's DesignSession: a share whose
// document was deleted while offline, or whose window is gone, would otherwise
// stay open (with its grants) and count against the owner's share limit forever.
// The real broker on a real HubStore; devices are in-process transports carrying
// the frames a socket would. Not a browser, socket or multi-device acceptance test.
let broker: DesignShareBroker;
function device(userId: string, deviceId: string) {
  const listeners = new Set<(frame: DesignShareServerFrame) => void>(), statuses = new Set<(online: boolean) => void>(), calls: string[] = [];
  let alive = true, key: object = {};
  const peer: DesignSharePeer = { get key() { return key; }, userId, deviceId, active: () => alive,
    validate: async () => { if (!alive) throw new HubError("device_revoked", 401); },
    send: async frame => { if (!alive) return; for (const listener of [...listeners]) listener(frame); } };
  const transport: DesignShareTransport = { send: frame => { calls.push(frame.request.op); if (!alive) throw new Error("design_share_app_unavailable"); void broker.handle(peer, frame).then(result => peer.send(result)); },
    onFrame: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, onStatus: listener => { statuses.add(listener); return () => { statuses.delete(listener); }; } };
  const client = new DesignShareClient(transport, 5_000);
  /** The App connection drops/returns: what HubConnection reports to the share client. */
  const setOnline = (online: boolean) => { broker.disconnect(peer); alive = online; if (online) key = {}; for (const listener of [...statuses]) listener(online); };
  return { peer, client, calls, setOnline, manager: new DesignShareManager(client) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

describe("owners end shares by ID, without the shared document", () => {
  let directory: string, store: HubStore, conversationId: string;
  const record = (shareId: string) => metaDesignShareRepository(store.db).get(shareId);
  const listed = async (who: ReturnType<typeof device>) => ((await who.client.request({ op: "list", conversationId })) as { shares: DesignShareView[] }).shares;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "hub-design-share-owner-close-"));
    store = await HubStore.open(directory);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    await store.db.run("INSERT INTO users VALUES('guest','Guest','member')");
    conversationId = (await store.createConversation("owner", ["bot"], "Share", "new")).id;
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversationId]);
    broker = new DesignShareBroker({ requireMember: (userId, conversation) => store.db.serial(() => store.requireMember(userId, conversation)), userName: async userId => (await store.user(userId))?.name, repository: metaDesignShareRepository(store.db) },
      { limits: { dispatchTimeoutMs: 2_000, presenceIntervalMs: 5 } });
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });

  /** WorkbenchController.endDesignShare while the App is offline: the design is gone, its share is not. */
  async function orphan(owner: ReturnType<typeof device>, name: string) {
    const made = memoryDesign(emptyDesign(name));
    const view = await owner.manager.share(made.session, { conversationId, windowId: "w-src", title: name });
    await owner.manager.grant(made.session, "guest", "editor");
    owner.setOnline(false);
    await owner.manager.close(made.session).catch(() => owner.manager.forget(made.session)).catch(() => undefined);
    owner.setOnline(true); await settle();
    return view.shareId;
  }

  it("does not adopt an open reply after another owner device has already ended that share", async () => {
    const mac = device("owner", "mac"), phone = device("owner", "phone");
    const made = memoryDesign(emptyDesign("pending-open"));
    let release!: () => void, opened!: (id: string) => void, hold = true;
    const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<string>(resolve => { opened = resolve; });
    const send = mac.peer.send.bind(mac.peer);
    mac.peer.send = async frame => {
      const id = frame.type === "design.share.result" && frame.ok ? (frame.result as { shareId?: string } | undefined)?.shareId : undefined;
      if (id && hold) { hold = false; opened(id); await blocked; }
      return send(frame);
    };
    const opening = mac.manager.share(made.session, { conversationId, windowId: "w-src", title: "Pending" });
    const outcome = opening.then(() => "unexpected success", (error: Error) => error.message);
    const shareId = await waiting;
    await phone.manager.closeShare(shareId); release();
    expect(await outcome).toBe("design_share_source_stopped");
    expect(mac.manager.sourceFor(made.session)).toBeUndefined();
    expect((await mac.manager.share(made.session, { conversationId, windowId: "w-src", title: "Again" })).shareId).not.toBe(shareId);
  });

  it("ends a share whose document was deleted while offline, from the device that held it", async () => {
    const mac = device("owner", "mac"), guest = device("guest", "laptop");
    const shareId = await orphan(mac, "deleted");
    // The defect this repairs: the share and the grant survived the deletion.
    expect(await record(shareId)).toMatchObject({ state: "open", members: { guest: "editor" } });
    const own = (await listed(mac)).find(share => share.shareId === shareId)!;
    expect(own).toMatchObject({ role: "owner", onThisDevice: true, sourceOnline: false });
    expect(designShareListActions(own)).toEqual({ open: false, end: true });
    await mac.manager.closeShare(shareId);
    expect(await record(shareId)).toMatchObject({ state: "closed" });
    expect(await listed(guest)).toEqual([]);
    await expect(guest.client.request({ op: "join", shareId, windowId: "w-guest" })).rejects.toThrow("design_share_closed");
  });

  it("lets the owner's other device end it; the serving window retires and a joined copy shows the end", async () => {
    const mac = device("owner", "mac"), phone = device("owner", "phone");
    const made = memoryDesign(emptyDesign("active"));
    const view = await mac.manager.share(made.session, { conversationId, windowId: "w-src", title: "Active" });
    const onPhone = (await listed(phone)).find(share => share.shareId === view.shareId)!;
    expect(onPhone).toMatchObject({ role: "owner", onThisDevice: false, sourceOnline: true });
    expect(designShareListActions(onPhone)).toEqual({ open: true, end: true });
    await phone.manager.join(onPhone, { windowId: "w-phone", user: () => ({ id: "owner", name: "Owner" }) });
    expect(phone.manager.mirrorFor(view.shareId)).toBeDefined();
    await phone.manager.closeShare(view.shareId);
    expect(await record(view.shareId)).toMatchObject({ state: "closed" });
    // An open joined copy keeps its viewer and shows that the share ended (as when the source stops sharing).
    await vi.waitFor(() => expect(phone.manager.mirrorFor(view.shareId)?.mirror.state().revoked).toBe(true));
    // The source window hears the close and stops serving; sharing again makes a new share.
    await vi.waitFor(() => expect(mac.manager.sourceFor(made.session)).toBeUndefined());
    const again = await mac.manager.share(made.session, { conversationId, windowId: "w-src", title: "Active" });
    expect(again.shareId).not.toBe(view.shareId);
  });

  it("a source window that was offline when its share ended does not stay stuck on the closed share", async () => {
    const mac = device("owner", "mac"), phone = device("owner", "phone");
    const made = memoryDesign(emptyDesign("offline-source"));
    const view = await mac.manager.share(made.session, { conversationId, windowId: "w-src", title: "Offline" });
    mac.setOnline(false);
    // Ended elsewhere (the Host has always authorised any owner device).
    await phone.client.request({ op: "close", shareId: view.shareId });
    mac.setOnline(true); await settle();
    // The reconnect attach is refused as closed: the stale source must not block a new share.
    const again = await mac.manager.share(made.session, { conversationId, windowId: "w-src", title: "Offline" });
    expect(again.shareId).not.toBe(view.shareId);
    expect(await record(again.shareId)).toMatchObject({ state: "open" });
  });

  it("refuses a grantee and keeps the share; grantees are offered Open, never End", async () => {
    const mac = device("owner", "mac"), guest = device("guest", "laptop");
    const shareId = await orphan(mac, "granted");
    const forGuest = (await listed(guest)).find(share => share.shareId === shareId)!;
    expect(forGuest).toMatchObject({ role: "editor" });
    expect(designShareListActions(forGuest)).toEqual({ open: true, end: false });
    await expect(guest.manager.closeShare(shareId)).rejects.toThrow("design_share_forbidden");
    expect(await record(shareId)).toMatchObject({ state: "open", members: { guest: "editor" } });
  });

  it("recovers the owner's share quota from shares that nothing could close before", async () => {
    const mac = device("owner", "mac");
    const orphans: string[] = [];
    for (let i = 0; i < DESIGN_SHARE_LIMITS.sharesPerOwner; i++) orphans.push(await orphan(mac, `deleted-${i}`));
    const fresh = memoryDesign(emptyDesign("fresh"));
    await expect(mac.manager.share(fresh.session, { conversationId, windowId: "w-src", title: "Fresh" })).rejects.toThrow("design_share_limit");
    await mac.manager.closeShare(orphans[0]!);
    expect((await mac.manager.share(fresh.session, { conversationId, windowId: "w-src", title: "Fresh" })).shareId).toMatch(/^ds_/);
  });

  it("retires this manager's active source only after the Host confirms the close", async () => {
    const mac = device("owner", "mac");
    const made = memoryDesign(emptyDesign("served"));
    const view = await mac.manager.share(made.session, { conversationId, windowId: "w-src", title: "Served" });
    const source = mac.manager.sourceFor(made.session)!.source;
    // Offline: nothing was closed, so the source is kept for its reconnect.
    mac.setOnline(false);
    await expect(mac.manager.closeShare(view.shareId)).rejects.toThrow("design_share_app_unavailable");
    expect(mac.manager.sourceFor(made.session)?.source).toBe(source);
    mac.setOnline(true); await settle();
    expect(source.attached).toBe(true);
    mac.calls.length = 0;
    await mac.manager.closeShare(view.shareId);
    expect(source.stopped).toBe(true);
    expect(mac.manager.sourceFor(made.session)).toBeUndefined();
    // Closed already: no detach afterwards, and no re-attach on the next reconnect.
    mac.setOnline(false); mac.setOnline(true); await settle();
    expect(mac.calls).toEqual(["close"]);
  });
});
