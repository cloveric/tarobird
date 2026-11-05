import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { ClientCache, Identity } from "../src/storage.js";

vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ randomNonce: () => "fixture-nonce" }));
vi.mock("../src/transport.js", () => ({ hubSocket: vi.fn(), hubFetch: vi.fn(), usesPinnedTransport: () => false }));
import { HubConnection, type ConnectionState } from "../src/connection.js";
import { navigationItems } from "../src/conversation-inbox.js";

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-17T10:00:00Z"));
  vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("document", new EventTarget());
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture() {
  const identity: Identity = { deviceId: "fixture", name: "Fixture", publicKey: "fixture", routes: [] };
  const connection = new HubConnection(identity, {} as ClientCache);
  connection.state = { ...connection.state, status: "online", bots: [
    { id: "on", name: "Connected", engine: "", model: "", effort: "", online: 1 },
    { id: "off", name: "Stopped", engine: "", model: "", effort: "", online: 0 },
  ] };
  const conversations = [
    { id: "direct", type: "direct", botIds: ["on"] },
    { id: "stopped", type: "direct", botIds: ["off"] },
    { id: "group", type: "group", botIds: ["off"] },
  ] as Conversation[];
  const update = (patch: Partial<ConnectionState>) => Reflect.get(connection, "update").call(connection, patch);
  const listed = (show = false, viewingHistory = false) => navigationItems({ connection, bots: connection.state.bots, conversations, viewingHistory }, show);
  return { connection, update, listed };
}

it("keeps only previously visible direct chats for five minutes without claiming the host is online", () => {
  const { connection, update, listed } = fixture();
  update({ status: "offline" });
  expect(connection.state.status).toBe("offline");
  expect(listed().bots.map(b => b.id)).toEqual(["on"]);
  expect(listed().conversations.map(c => c.id)).toEqual(["direct", "group"]);
  vi.advanceTimersByTime(299_999);
  expect(listed().conversations.map(c => c.id)).toContain("direct");
  const changed = vi.fn(); connection.subscribe(changed);
  vi.advanceTimersByTime(1);
  expect(changed).toHaveBeenCalledOnce();
  expect(listed().conversations.map(c => c.id)).toEqual(["group"]);
  expect(listed(true).conversations).toHaveLength(3);
  expect(listed(false, true).conversations).toHaveLength(3);
});

it("does not extend the deadline when retrying or receiving repeated foreground signals", () => {
  const { connection, update, listed } = fixture();
  update({ status: "offline" }); vi.advanceTimersByTime(240_000);
  update({ status: "connecting" }); connection.resume();
  update({ status: "offline", error: "Still unavailable" }); update({ status: "connecting" });
  vi.advanceTimersByTime(59_999); expect(listed().bots).toHaveLength(1);
  vi.advanceTimersByTime(1); expect(listed().bots).toHaveLength(0);
});

it("clears an old timer on authenticated recovery and gives the next outage its own deadline", () => {
  const { update, listed } = fixture();
  update({ status: "offline" }); vi.advanceTimersByTime(240_000); update({ status: "online" });
  vi.advanceTimersByTime(60_000); expect(listed().bots).toHaveLength(1);
  update({ status: "connecting" }); vi.advanceTimersByTime(299_999);
  expect(listed().bots).toHaveLength(1);
  vi.advanceTimersByTime(1); expect(listed().bots).toHaveLength(0);
});

it("expires on foreground resume after sleep even if the background timer has not fired", () => {
  const { connection, update, listed } = fixture(); update({ status: "connecting" });
  const changed = vi.fn(); connection.subscribe(changed);
  vi.setSystemTime(Date.now() + 300_001); connection.resume();
  expect(changed).toHaveBeenCalledOnce(); expect(listed().bots).toHaveLength(0);
});

it.each(["close", "revoked"])("does not retain navigation authority after %s", reason => {
  const { connection, update, listed } = fixture(); update({ status: "offline" });
  if (reason === "revoked") connection.suspendNetwork(); else connection.close();
  expect(listed().bots).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  expect(listed(false, true).conversations).toHaveLength(3);
});

it("keeps hosts isolated and applies explicit Bot offline status immediately", () => {
  const a = fixture(), b = fixture(); a.update({ status: "offline" });
  vi.advanceTimersByTime(300_000);
  expect(a.listed().bots).toHaveLength(0); expect(b.listed().bots).toHaveLength(1);
  b.update({ bots: b.connection.state.bots.map(bot => ({ ...bot, online: 0 })) });
  expect(b.listed().bots).toHaveLength(0);
});
