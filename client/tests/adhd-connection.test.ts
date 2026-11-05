import { expect, it, vi } from "vitest";
import type { Identity } from "../src/storage.js";
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ randomNonce: () => "fixture-nonce" }));
vi.mock("../src/transport.js", () => ({ hubSocket: vi.fn(), hubFetch: vi.fn(), usesPinnedTransport: () => false }));
import { HubConnection } from "../src/connection.js";
function fixture() {
  const identity: Identity = { deviceId: "fixture", name: "Fixture", publicKey: "fixture", routes: [] };
  const connection = new HubConnection(identity);
  Reflect.set(connection, "syncing", false);
  const event = (id: string) => Reflect.get(connection, "eventApplied").call(connection, id);
  const update = (full = false) => Reflect.get(connection, "update").call(connection, {}, full);
  return { connection, event, update };
}
it("invalidates only the event's history while retaining the global receipt watermark", () => {
  const { connection, event, update } = fixture();
  update(true); const b = connection.conversationRevision("b");
  for (let i = 0; i < 50; i++) event("a");
  expect(connection.conversationRevision("a")).toBe(connection.state.cacheRevision);
  expect(connection.conversationRevision("b")).toBe(b);
  update(true); expect(connection.conversationRevision("b")).toBe(connection.state.cacheRevision);
  expect(connection.conversationRevision("a")).toBe(connection.state.cacheRevision);
});
it("publishes every touched history when a replay batch fills or disconnect publishes its prefix", () => {
  const { connection, event, update } = fixture();
  Reflect.set(connection, "syncing", true); connection.state = { ...connection.state, status: "online" };
  for (let i = 0; i < 31; i++) event(i % 2 ? "a" : "b");
  expect(connection.state.cacheRevision).toBe(0); event("c");
  expect(["a", "b", "c"].map(id => connection.conversationRevision(id))).toEqual([1, 1, 1]);
  event("d"); update(); expect(connection.conversationRevision("d")).toBe(2); expect(connection.conversationRevision("a")).toBe(1);
  expect(connection.conversationRevision("untouched")).toBe(0);
});
