import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientCache, Identity } from "../src/storage.js";

const io = vi.hoisted(() => ({ socket: vi.fn(), sign: vi.fn(), verify: vi.fn() }));
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ randomNonce: () => "fixture-nonce", signChallenge: io.sign, verifyHub: io.verify }));
vi.mock("../src/transport.js", () => ({ hubSocket: io.socket, hubFetch: vi.fn(), usesPinnedTransport: () => false }));
import { HubConnection } from "../src/connection.js";

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("document", new EventTarget()); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const socket = () => ({ readyState: 1, onopen: undefined as undefined | (() => void), onclose: undefined as undefined | ((event: { code: number }) => void), onmessage: undefined as undefined | ((event: { data: string }) => void), send: vi.fn(), close: vi.fn() });
it("allows remote browser authentication the same jitter budget as native connections", async () => {
  const ws = socket(); io.socket.mockReturnValue(ws);
  const { connect } = fixture(async () => {});
  await connect(); ws.onopen!(); await vi.advanceTimersByTimeAsync(3000);
  expect(ws.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4000);
  expect(ws.close).toHaveBeenCalled();
});
function fixture(discardSnapshot: () => Promise<void>) {
  const identity: Identity = { deviceId: "fixture", name: "Fixture", publicKey: "fixture", routes: [] };
  const cache = { discardSnapshot, syncResume: vi.fn().mockResolvedValue({ cursors: {}, syncLineages: {} }), selectedConversation: vi.fn().mockResolvedValue("") };
  const connection = new HubConnection(identity, cache as unknown as ClientCache);
  vi.spyOn(Reflect.get(connection, "routePerformance"), "failed");
  Reflect.set(connection, "selectRoute", async () => ({ route: { name: "Direct", url: "https://hub.example" }, latency: 1 }));
  const connect = () => (Reflect.get(connection, "connect") as () => Promise<void>).call(connection);
  return { connection, cache, connect };
}

it("explains failed local cache preparation without sending an unauthenticated hello", async () => {
  const ws = socket(); io.socket.mockReturnValue(ws);
  const { connection, cache, connect } = fixture(async () => { throw new Error("Local cache unavailable"); });
  const errors: string[] = [];
  connection.subscribe(() => { if (connection.state.error) errors.push(connection.state.error); });
  await connect(); ws.onopen!();
  await vi.advanceTimersByTimeAsync(0);
  expect(errors).toContain("Local cache unavailable");
  expect(ws.close).toHaveBeenCalled();
  expect(cache.syncResume).not.toHaveBeenCalled(); expect(ws.send).not.toHaveBeenCalled();
});

it("ignores a late cache failure from a superseded connection", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  const first = socket(), second = socket(); io.socket.mockReturnValueOnce(first).mockReturnValue(second);
  const { connection, connect } = fixture(() => pending);
  await connect(); first.onopen!(); await connect();
  reject(new Error("Stale cache error")); await vi.advanceTimersByTimeAsync(0);
  expect(connection.state.error).toBeUndefined();
  expect(connection.state.status).toBe("connecting"); expect(second.close).not.toHaveBeenCalled();
});
it("pauses reconnect attempts on storage quota failure until an explicit resume", async () => {
  const ws = socket(); io.socket.mockReturnValue(ws);
  const { connection, connect } = fixture(async () => { throw new DOMException("Sensitive storage implementation details", "QuotaExceededError"); });
  await connect(); ws.onopen!(); await vi.advanceTimersByTimeAsync(60_000);
  expect(io.socket).toHaveBeenCalledTimes(1);
  expect(connection.state.error).toContain("本机存储空间不足");
  expect(connection.state.error).not.toContain("Sensitive");
  connection.resume(); await vi.advanceTimersByTimeAsync(0);
  expect(io.socket).toHaveBeenCalledTimes(2);
});

it("does not retry a permanently closed cache or penalize a healthy route", async () => {
  const ws = socket(); io.socket.mockReturnValue(ws);
  const { connection, cache, connect } = fixture(async () => { Reflect.set(cache, "isClosed", true); throw new Error("local_cache_closed"); });
  await connect(); ws.onopen!(); await vi.advanceTimersByTimeAsync(60_000);
  expect(io.socket).toHaveBeenCalledTimes(1);
  expect(connection.state.error).toContain("本地消息缓存已关闭");
  expect(connection.state.error).not.toContain("检查主机和网络");
  expect(Reflect.get(connection, "failedRoutes").size).toBe(0);
  expect(Reflect.get(connection, "routePerformance").failed).not.toHaveBeenCalled();
  connection.resume(); connection.resume(true); await connect(); await vi.advanceTimersByTimeAsync(60_000);
  expect(io.socket).toHaveBeenCalledTimes(1);
});

it("keeps transient local cache errors out of route health while allowing a retry", async () => {
  const ws = socket(); io.socket.mockReturnValue(ws);
  const { connection, connect } = fixture(async () => { throw new Error("Temporary local failure"); });
  await connect(); ws.onopen!(); await vi.advanceTimersByTimeAsync(0);
  expect(Reflect.get(connection, "failedRoutes").size).toBe(0);
  expect(Reflect.get(connection, "routePerformance").failed).not.toHaveBeenCalled();
  expect(io.socket).toHaveBeenCalledTimes(2);
});

it("does not blame the route when handshake time is spent preparing local cache", async () => {
  const ws = socket(); io.socket.mockReturnValue(ws);
  const { connection, connect } = fixture(() => new Promise(() => {}));
  await connect(); ws.onopen!(); await vi.advanceTimersByTimeAsync(7000);
  expect(connection.state.error).toContain("本地消息缓存准备超时");
  expect(Reflect.get(connection, "failedRoutes").size).toBe(0);
  expect(Reflect.get(connection, "routePerformance").failed).not.toHaveBeenCalled();
});

for (const code of ["system_keychain_busy", "device_key_unavailable", "device_key_invalid", "system_keychain_unavailable", "device_signature_pending"]) it(`does not penalize a route for local signing failure ${code}`, async () => {
  const ws = socket(); io.socket.mockReturnValue(ws); io.sign.mockRejectedValue(new Error(code));
  const { connection, connect } = fixture(async () => {});
  ws.close.mockImplementation(() => ws.onclose?.({ code: 1006 }));
  await connect(); ws.onopen!(); await vi.advanceTimersByTimeAsync(0);
  ws.onmessage!({ data: JSON.stringify({ v: 1, type: "challenge", nonce: "nonce", signature: "signature", publicKey: "key" }) });
  await vi.advanceTimersByTimeAsync(0);
  expect(io.sign).toHaveBeenCalledOnce(); expect(ws.close).toHaveBeenCalled();
  expect(Reflect.get(connection, "failedRoutes").size).toBe(0);
  expect(Reflect.get(connection, "routePerformance").failed).not.toHaveBeenCalled();
});

it("still penalizes forged Hub challenges before signing", async () => {
  const ws = socket(); io.socket.mockReturnValue(ws); io.verify.mockRejectedValue(new Error("hub_identity_mismatch"));
  const { connection, connect } = fixture(async () => {});
  ws.close.mockImplementation(() => ws.onclose?.({ code: 1006 }));
  await connect(); ws.onopen!(); await vi.advanceTimersByTimeAsync(0);
  ws.onmessage!({ data: JSON.stringify({ v: 1, type: "challenge", nonce: "nonce", signature: "signature", publicKey: "key" }) });
  await vi.advanceTimersByTimeAsync(0);
  expect(io.sign).not.toHaveBeenCalled(); expect(Reflect.get(connection, "failedRoutes").size).toBe(1);
});

it("keeps startup and send errors actionable when a cache retires", async () => {
  const { connection, cache } = fixture(async () => {});
  for (const method of ["activeMessages", "profiles", "identityRevoked", "identity", "outbox", "conversationFolders", "networkMembership"]) Reflect.set(cache, method, async () => undefined);
  Reflect.set(cache, "activeMessages", async () => { Reflect.set(cache, "isClosed", true); throw new Error("local_cache_closed"); });
  await expect(connection.start()).rejects.toThrow("本地消息缓存已关闭");
  await expect(connection.send({ v: 1, type: "message.send", conversationId: "chat", clientMsgId: "pending", text: "keep", attachments: [] })).rejects.toThrow("本地消息缓存已关闭");
  expect(io.socket).not.toHaveBeenCalled(); expect(connection.isClosed).toBe(true);
});

it("allows an immediate stop on a live socket after cache retirement but never queues a new message", async () => {
  const { connection, cache } = fixture(async () => {}), ws = socket(), enqueue = vi.fn();
  Reflect.set(cache, "isClosed", true); Reflect.set(cache, "enqueue", enqueue);
  Reflect.set(connection, "ws", ws); Reflect.set(connection, "state", { ...connection.state, status: "online" });
  await connection.send({ v: 1, type: "turn.stop", conversationId: "chat" });
  expect(ws.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ v: 1, type: "turn.stop", conversationId: "chat" }));
  expect(connection.isClosed).toBe(false);
  await expect(connection.send({ v: 1, type: "message.send", conversationId: "chat", clientMsgId: "new", text: "never enqueue", attachments: [] })).rejects.toThrow("本地消息缓存已关闭");
  expect(enqueue).not.toHaveBeenCalled(); expect(connection.isClosed).toBe(true);
  expect(ws.send).toHaveBeenCalledOnce();
});
