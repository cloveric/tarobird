import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientCache, Identity } from "../src/storage.js";
import { CANVAS_AGENT_HOST_CAPABILITY } from "../../src/client-protocol/infinite-canvas.js";

const io = vi.hoisted(() => ({ socket: vi.fn(), fetch: vi.fn() }));
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ randomNonce: () => "nonce", signChallenge: async () => "signature", verifyHub: async () => {} }));
vi.mock("../src/transport.js", () => ({ hubSocket: io.socket, hubFetch: io.fetch, usesPinnedTransport: () => false }));
vi.mock("../src/share-inbox.js", () => ({ syncShareUploadLimit: async () => {} }));
import { HubConnection } from "../src/connection.js";

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "hidden", hasFocus: () => false }));
  vi.stubGlobal("WebSocket", { OPEN: 1 });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function fixture() {
  const ws = { readyState: 1, onopen: undefined as undefined | (() => void), onmessage: undefined as undefined | ((event: { data: string }) => void), send: vi.fn(), close: vi.fn() };
  io.socket.mockReturnValue(ws);
  const hubPublicKey = Buffer.from("302a300506032b6570032100" + "01".repeat(32), "hex").toString("base64");
  const identity: Identity = { deviceId: "device", name: "Fixture", publicKey: "device-key", hubPublicKey, routes: [] };
  const cache = {
    discardSnapshot: async () => {}, syncResume: async () => ({ cursors: {}, syncLineages: {} }), selectedConversation: async () => "",
    saveConversations: async () => {}, saveProfiles: async () => {}, outbox: async () => [], activeMessages: async () => [],
  };
  const connection = new HubConnection(identity, cache as unknown as ClientCache);
  Reflect.set(connection, "selectRoute", async () => ({ route: { name: "Direct", url: "https://hub.example" }, latency: 1 }));
  Reflect.set(connection, "presence", () => {});
  Reflect.set(connection, "refreshNotificationPreferences", async () => {});
  const receive = async (frame: object) => { ws.onmessage!({ data: JSON.stringify({ v: 1, ...frame }) }); await vi.advanceTimersByTimeAsync(0); };
  await Reflect.get(connection, "connect").call(connection);
  ws.onopen!();
  await vi.advanceTimersByTimeAsync(0);
  await receive({ type: "challenge", nonce: "server-nonce", signature: "server-signature", publicKey: hubPublicKey });
  const ready = (supported: boolean) => receive({
    type: "ready", serverCapabilities: supported ? [CANVAS_AGENT_HOST_CAPABILITY] : [], sessionToken: "token", expiresAt: Date.now() + 900_000,
    user: { id: "owner", name: "Owner", role: "owner" }, bots: [], conversations: [],
  });
  const onEvent = vi.fn();
  const sessions: Map<string, unknown> = Reflect.get(connection, "canvasAgentSessions");
  const rememberSession = () => sessions.set("client", {
    clientId: "client", windowId: "window", tabId: "tab", conversationId: "chat",
    token: "fixture_grant", expiresAt: Date.now() + 900_000, protocolVersion: 12, onEvent, closed: false,
  });
  const keepSocketAlive = async () => {
    for (let tick = 0; tick < 15; tick++) {
      await vi.advanceTimersByTimeAsync(2_000);
      await receive({ type: "pong" });
    }
  };
  return { connection, ws, ready, onEvent, sessions, rememberSession, keepSocketAlive };
}

it("retires stale Canvas state and gates usage before network traffic on a legacy Hub reconnect", async () => {
  const { connection, ws, ready, onEvent, sessions, rememberSession, keepSocketAlive } = await fixture();
  const readyPromise = ready(false);
  rememberSession();
  await readyPromise;
  expect(connection.state).toMatchObject({ status: "online", canvasAgentAvailable: false });
  expect(sessions.size).toBe(0);
  expect(onEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "closed", clientId: "client" }));
  await expect(connection.fetchInfiniteCanvasArtifact()).rejects.toThrow("canvas_agent_unavailable");
  await expect(connection.canvasAgentAttach("chat", "window", "tab", "new_client", () => {})).rejects.toThrow("canvas_agent_unavailable");
  await keepSocketAlive();
  expect(io.fetch.mock.calls.some(([, route]) => String(route).includes("canvas-agent") || String(route).includes("plugins/artifacts"))).toBe(false);
  expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).not.toContain("canvas.agent.attach");
  expect(ws.close).not.toHaveBeenCalled();
});

it("treats a negotiated Canvas endpoint returning 404 as terminal for an existing attachment", async () => {
  const { connection, ws, ready, onEvent, sessions, rememberSession, keepSocketAlive } = await fixture();
  await ready(true);
  expect(connection.state.canvasAgentAvailable).toBe(true);
  rememberSession();
  io.fetch.mockResolvedValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
  await Reflect.get(connection, "renewCanvasAgentSession").call(connection, "client");
  expect(sessions.size).toBe(0);
  expect(onEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "closed" }));
  await keepSocketAlive();
  expect(io.fetch.mock.calls.filter(([, route]) => route === "/api/canvas-agent/token")).toHaveLength(1);
  expect(ws.close).not.toHaveBeenCalled();
});
