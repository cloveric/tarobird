import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientCache, Identity } from "../src/storage.js";
import { DESIGN_SHARE_CLIENT_CAPABILITY, WORKBENCH_DESIGN_SHARE_CAPABILITY } from "../../src/client-protocol/workbench-design-sharing.js";
import { DesignShareClient } from "../src/workbench-design-collaboration.js";

const io = vi.hoisted(() => ({ socket: vi.fn() }));
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ randomNonce: () => "nonce", signChallenge: async () => "signature", verifyHub: async () => {} }));
vi.mock("../src/transport.js", () => ({ hubSocket: io.socket, hubFetch: vi.fn(), usesPinnedTransport: () => false }));
vi.mock("../src/share-inbox.js", () => ({ syncShareUploadLimit: async () => {} }));
import { HubConnection } from "../src/connection.js";

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "hidden", hasFocus: () => false }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function fixture() {
  const ws = { readyState: 1, onopen: undefined as undefined | (() => void), onmessage: undefined as undefined | ((event: { data: string }) => void), send: vi.fn(), close: vi.fn() };
  io.socket.mockReturnValue(ws);
  const hubPublicKey = Buffer.from("302a300506032b6570032100" + "01".repeat(32), "hex").toString("base64");
  const identity: Identity = { deviceId: "device", name: "Fixture", publicKey: "device-key", hubPublicKey, routes: [] };
  const cache = {
    discardSnapshot: async () => {}, syncResume: async () => ({ cursors: {}, syncLineages: {} }), selectedConversation: async () => "",
    saveConversations: async () => {}, saveProfiles: async () => {}, outbox: async () => [], activeMessages: async () => [], enqueue: vi.fn(),
  };
  const connection = new HubConnection(identity, cache as unknown as ClientCache);
  Reflect.set(connection, "selectRoute", async () => ({ route: { name: "Direct", url: "https://hub.example" }, latency: 1 }));
  Reflect.set(connection, "presence", () => {}); Reflect.set(connection, "refreshNotificationPreferences", async () => {});
  const receive = async (frame: object) => { ws.onmessage!({ data: JSON.stringify({ v: 1, ...frame }) }); await vi.advanceTimersByTimeAsync(0); };
  await Reflect.get(connection, "connect").call(connection); ws.onopen!(); await vi.advanceTimersByTimeAsync(0);
  await receive({ type: "challenge", nonce: "server-nonce", signature: "server-signature", publicKey: hubPublicKey });
  const ready = async () => receive({ type: "ready", serverCapabilities: [WORKBENCH_DESIGN_SHARE_CAPABILITY], sessionToken: "token", expiresAt: Date.now() + 900_000,
    user: { id: "owner", name: "Owner", role: "owner" }, bots: [], conversations: [] });
  return { connection, ws, cache, receive, ready };
}

it("connects production DesignShareClient to all four parsed frame types without entering the chat outbox", async () => {
  const { connection, ws, cache, receive, ready } = await fixture(); await ready();
  expect(JSON.parse(ws.send.mock.calls[0]![0]).capabilities).toContain(DESIGN_SHARE_CLIENT_CAPABILITY);
  const client = new DesignShareClient(connection.designShareTransport), events = vi.fn(); client.on(events);
  const result = client.request({ op: "list", conversationId: "chat" }, "raw-list");
  expect(JSON.parse(ws.send.mock.calls.at(-1)![0])).toMatchObject({ type: "design.share.request", requestId: "raw-list" });
  await receive({ type: "design.share.result", requestId: "raw-list", ok: true, result: { shares: [] } });
  await expect(result).resolves.toEqual({ shares: [] });
  const shareId = `ds_${"a".repeat(24)}`;
  await receive({ type: "design.share.event", shareId, generation: 1, event: { type: "source", online: false } });
  await receive({ type: "design.share.dispatch", shareId, generation: 1, dispatchId: "d_one", deadline: Date.now() + 5000, from: { userId: "guest", name: "Guest", role: "viewer", requestId: "remote" }, kind: "call", payload: { call: "list", payload: {} } });
  await receive({ type: "design.share.cancel", shareId, dispatchId: "d_one", reason: "design_share_requester_gone" });
  expect(events.mock.calls.map(([frame]) => frame.type)).toEqual(["design.share.event", "design.share.dispatch", "design.share.cancel"]);
  // The existing promise API still consumes only its own request ID.
  const legacy = connection.designShare({ op: "list", conversationId: "chat" }, "legacy-list");
  await receive({ type: "design.share.result", requestId: "legacy-list", ok: true, result: { shares: [] } });
  await expect(legacy).resolves.toEqual({ shares: [] });
  expect(cache.enqueue).not.toHaveBeenCalled(); expect(ws.close).not.toHaveBeenCalled(); client.dispose();
});

it("refuses offline, unsupported, revoked and windowless sends instead of queueing them", async () => {
  const { connection, ws, cache, ready } = await fixture(); await ready();
  const frame = { v: 1 as const, type: "design.share.request" as const, requestId: "raw", request: { op: "list" as const, conversationId: "chat" } };
  ws.send.mockClear();
  for (const changes of [{ status: "connecting" }, { workbenchDesignShareAvailable: false }]) {
    const before = connection.state; Reflect.set(connection, "state", { ...before, ...changes });
    expect(() => connection.designShareTransport.send(frame)).toThrow("design_share_app_unavailable"); Reflect.set(connection, "state", before);
  }
  Reflect.set(connection, "deviceRevoked", true);
  expect(() => connection.designShareTransport.send(frame)).toThrow("design_share_app_unavailable"); Reflect.set(connection, "deviceRevoked", false);
  expect(() => connection.designShareTransport.send({ ...frame, request: { op: "presence", shareId: `ds_${"a".repeat(24)}`, patch: {} } } as never)).toThrow();
  expect(ws.send).not.toHaveBeenCalled(); expect(cache.enqueue).not.toHaveBeenCalled();
});

it("ignores pre-ready shared frames and isolates a broken frame subscriber", async () => {
  const { connection, ws, receive, ready } = await fixture(), listener = vi.fn();
  connection.designShareTransport.onFrame(() => { throw new Error("retired window"); });
  const stop = connection.designShareTransport.onFrame(listener);
  const frame = { type: "design.share.event", shareId: `ds_${"a".repeat(24)}`, generation: 1, event: { type: "source", online: false } };
  await receive(frame); expect(listener).not.toHaveBeenCalled();
  await ready(); await receive(frame); expect(listener).toHaveBeenCalledOnce(); expect(ws.close).not.toHaveBeenCalled();
  stop(); await receive(frame); expect(listener).toHaveBeenCalledOnce();
});
