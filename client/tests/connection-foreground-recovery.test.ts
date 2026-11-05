import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientCache, Identity } from "../src/storage.js";

const io = vi.hoisted(() => ({ socket: vi.fn() }));
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ randomNonce: () => "nonce", signChallenge: async () => "signature", verifyHub: async () => {} }));
vi.mock("../src/transport.js", () => ({ hubSocket: io.socket, hubFetch: vi.fn(), usesPinnedTransport: () => true }));
vi.mock("../src/native.js", () => ({ nativePlatform: () => "android" }));
vi.mock("../src/share-inbox.js", () => ({ syncShareUploadLimit: async () => {} }));
import { HubConnection } from "../src/connection.js";

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", hasFocus: () => true }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function connected() {
  const socket = () => ({ readyState: 1, onopen: undefined as undefined | (() => void),
    onmessage: undefined as undefined | ((event: { data: string }) => void),
    onclose: undefined as undefined | ((event: { code: number; reason: string }) => void), send: vi.fn(), close: vi.fn() });
  io.socket.mockImplementation(socket);
  const identity: Identity = { deviceId: "device", name: "Fixture", publicKey: "device-key", hubPublicKey: "trusted", routes: [] };
  const cache = {
    discardSnapshot: async () => {}, syncResume: async () => ({ cursors: {}, syncLineages: {} }), selectedConversation: async () => "chat",
    saveConversations: async () => {}, saveProfiles: async () => {}, outbox: async () => [],
    apply: vi.fn(async (_event: unknown) => undefined),
  };
  const connection = new HubConnection(identity, cache as unknown as ClientCache);
  Reflect.set(connection, "selectRoute", async () => ({ route: { name: "VPS", url: "https://hub.example" }, latency: 100 }));
  Reflect.set(connection, "presence", () => {});
  Reflect.set(connection, "refreshNotificationPreferences", async () => {});
  await Reflect.get(connection, "connect").call(connection);
  const ws = io.socket.mock.results[0]!.value as ReturnType<typeof socket>;
  const send = (frame: object) => ws.onmessage!({ data: JSON.stringify({ v: 1, ...frame }) });
  const receive = async (frame: object) => { send(frame); await vi.advanceTimersByTimeAsync(0); };
  ws.onopen!(); await vi.advanceTimersByTimeAsync(0);
  await receive({ type: "challenge", nonce: "server-nonce", signature: "signature", publicKey: "trusted" });
  await receive({ type: "ready", sessionToken: "token", expiresAt: Date.now() + 900_000,
    user: { id: "owner", name: "Owner", role: "owner" }, bots: [], conversations: [] });
  expect(connection.state.status).toBe("online");
  return { connection, cache, ws, send, receive };
}

it.each([false, true])("foreground resume (force=%s) drains already received frames before replacing a closed socket", async force => {
  const { connection, cache, ws, send } = await connected();
  let release!: () => void;
  cache.apply.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
  const frame = (seq: number) => ({ type: "event", conversationId: "chat", seq, kind: "message.created", at: Date.now(),
    payload: { id: `message-${seq}`, conversationId: "chat", authorId: "bot", authorType: "bot", blocks: [{ type: "text", text: "received before closing" }], status: "complete", version: 1, createdAt: Date.now() } });
  send(frame(1)); await vi.advanceTimersByTimeAsync(0);
  expect(cache.apply).toHaveBeenCalledOnce();
  send(frame(2)); ws.readyState = WebSocket.CLOSED;
  Reflect.set(connection, "retry", 8);
  ws.onclose!({ code: 1006, reason: "" });
  connection.resume(force); connection.resume(); await vi.advanceTimersByTimeAsync(0);
  expect.soft(io.socket).toHaveBeenCalledTimes(1);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect.soft(cache.apply.mock.calls.map(([event]) => (event as { seq: number }).seq)).toEqual([1, 2]);
  expect(io.socket).toHaveBeenCalledTimes(2);
  connection.close();
});

it("closing the connection while foreground recovery waits never reopens it", async () => {
  const { connection, cache, ws, send } = await connected();
  let release!: () => void;
  cache.apply.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
  send({ type: "event", conversationId: "chat", seq: 1, kind: "message.created", at: Date.now(),
    payload: { id: "pending", conversationId: "chat", authorId: "bot", authorType: "bot", blocks: [], status: "complete", version: 1, createdAt: Date.now() } });
  await vi.advanceTimersByTimeAsync(0);
  ws.readyState = WebSocket.CLOSED; ws.onclose!({ code: 1006, reason: "" });
  connection.resume(); connection.close(); release();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(io.socket).toHaveBeenCalledTimes(1);
  expect(connection.state.status).toBe("offline");
});

it.each([false, true])("foreground liveness counts arriving traffic, not delayed pong processing (fresh reply=%s)", async fresh => {
  const { connection, cache, send } = await connected();
  let release!: () => void;
  cache.apply.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
  send({ type: "event", conversationId: "chat", seq: 1, kind: "message.created", at: Date.now(),
    payload: { id: "before-background", conversationId: "chat", authorId: "bot", authorType: "bot", blocks: [], status: "complete", version: 1, createdAt: Date.now() } });
  await vi.advanceTimersByTimeAsync(0);
  // This response arrived before suspension, behind the pending cache write.
  send({ type: "pong" });
  await vi.advanceTimersByTimeAsync(5000);
  connection.resume();
  await vi.advanceTimersByTimeAsync(9000);
  expect(io.socket).toHaveBeenCalledTimes(1);
  release(); await vi.advanceTimersByTimeAsync(0);
  if (fresh) { send({ type: "pong" }); await vi.advanceTimersByTimeAsync(0); }
  // Only a genuinely new reply proves the resumed connection still works.
  await vi.advanceTimersByTimeAsync(7001);
  expect(io.socket).toHaveBeenCalledTimes(fresh ? 1 : 2);
  if (fresh) await vi.advanceTimersByTimeAsync(9000);
  expect(io.socket).toHaveBeenCalledTimes(2);
  connection.close();
});

it("advances session identity only after each authenticated ready", async () => {
  const { connection } = await connected();
  expect(connection.sessionEpoch).toBe(1);
  await Reflect.get(connection, "connect").call(connection);
  const ws = io.socket.mock.results.at(-1)!.value;
  const receive = async (frame: object) => { ws.onmessage({ data: JSON.stringify({ v: 1, ...frame }) }); await vi.advanceTimersByTimeAsync(0); };
  ws.onopen(); await vi.advanceTimersByTimeAsync(0);
  await receive({ type: "challenge", nonce: "second-nonce", signature: "signature", publicKey: "trusted" });
  expect(connection.sessionEpoch).toBe(1);
  await receive({ type: "ready", sessionToken: "second-token", expiresAt: Date.now() + 900_000,
    user: { id: "owner", name: "Owner", role: "owner" }, bots: [], conversations: [] });
  expect(connection.state.status).toBe("online"); expect(connection.sessionEpoch).toBe(2);
  await receive({ type: "pong" }); expect(connection.sessionEpoch).toBe(2);
  connection.close();
});
