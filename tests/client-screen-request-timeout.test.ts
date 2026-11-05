// Real HubConnection.screenStatus/screenOpen/screenStop -> screenRequest ->
// httpRequest code path; only the network transport (hubFetch) is replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ calls: [] as { route: string; init: RequestInit }[], mode: "stall" as "stall" | "ok" | "ignore-abort" | "stall-body" | "stall-error-body",
  late: [] as ((response: Response) => void)[], body: [] as ((value: unknown) => void)[] }));
vi.mock("../client/src/transport.js", () => ({
  usesPinnedTransport: () => false,
  hubSocket: () => { throw new Error("no sockets in this test"); },
  hubFetch: (_url: string, route: string, _key: string | undefined, init: RequestInit) => {
    network.calls.push({ route, init });
    if (network.mode === "ok") {
      const body = route === "/api/screens/stop" ? { ok: true } : { supported: true, enabled: true, canManage: false, permission: "view", desktop: null, sessions: [], serverTime: Date.now() };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    // Headers arrive, the body never does (and ignores abort).
    if (network.mode === "stall-body" || network.mode === "stall-error-body")
      return Promise.resolve({ ok: network.mode === "stall-body", status: network.mode === "stall-body" ? 200 : 409, json: () => new Promise(resolve => network.body.push(resolve)) } as unknown as Response);
    // A stalled Host: no answer until the request is aborted.
    return new Promise<Response>((resolve, reject) => {
      if (network.mode === "ignore-abort") { network.late.push(resolve); return; }
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  },
}));
// The module-level client cache opens IndexedDB; screen calls never touch it.
// An inert stand-in: open requests never complete.
class InertRequest extends EventTarget {}
Object.assign(globalThis, { IDBRequest: InertRequest, IDBDatabase: class {}, IDBObjectStore: class {}, IDBIndex: class {}, IDBCursor: class {}, IDBTransaction: class {},
  indexedDB: { open: () => new InertRequest() } });
const { HubConnection, SCREEN_REQUEST_TIMEOUT_MS } = await import("../client/src/connection.js");

const hubPublicKey = `${"A".repeat(59)}=`;
function connection() {
  const value = new HubConnection({ deviceId: "device_1", name: "Viewer", publicKey: hubPublicKey, hubPublicKey, routes: [] } as never);
  const internal = value as unknown as { token: string; state: { route?: { url: string } }; httpMutations: number };
  internal.token = "token"; internal.state = { ...internal.state, route: { url: "https://127.0.0.1:9" } };
  return { value, internal };
}
const open = { desktopId: "desktop_1", displayId: "display", displayRevision: 1, requestId: "request_1", codecs: ["h264" as const], quality: "sharp" as const };

beforeEach(() => { vi.useFakeTimers(); network.calls.length = 0; network.late.length = 0; network.body.length = 0; network.mode = "stall"; });
afterEach(() => { vi.useRealTimers(); });

describe("remote-screen HTTP calls have their own short bound", () => {
  it("is 15 s, far below the general 5-minute HTTP bound", () => { expect(SCREEN_REQUEST_TIMEOUT_MS).toBe(15_000); });

  for (const [name, call, route] of [
    ["screenStatus", (c: InstanceType<typeof HubConnection>) => c.screenStatus(), "/api/screens/status"],
    ["screenOpen", (c: InstanceType<typeof HubConnection>) => c.screenOpen(open), "/api/screens/sessions"],
    ["screenStop", (c: InstanceType<typeof HubConnection>) => c.screenStop("screen_1"), "/api/screens/stop"],
  ] as const) {
    it(`${name}: a stalled Host fails with screen_request_timeout after 15 s, once, and a later call works`, async () => {
      const { value, internal } = connection();
      const pending = call(value); const outcome = pending.then(() => "resolved", (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(SCREEN_REQUEST_TIMEOUT_MS - 1);
      expect(network.calls).toHaveLength(1); expect(network.calls[0]!.route).toBe(route);
      expect(await Promise.race([outcome, Promise.resolve("still pending")])).toBe("still pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ name: "HubHttpError", status: 408, code: "screen_request_timeout" });
      // Never retried by the connection (an uncertain open is not replayed).
      await vi.advanceTimersByTimeAsync(SCREEN_REQUEST_TIMEOUT_MS * 3);
      expect(network.calls).toHaveLength(1);
      expect(internal.httpMutations).toBe(0);
      // The connection is not left blocked: the next operation goes out and succeeds.
      network.mode = "ok";
      if (name !== "screenOpen") await expect(call(value)).resolves.toBeTruthy();
      else await expect(value.screenStatus()).resolves.toMatchObject({ supported: true });
      expect(network.calls).toHaveLength(2);
    });
  }

  it("a transport that never settles on abort still releases the caller at the bound", async () => {
    network.mode = "ignore-abort";
    const { value, internal } = connection();
    const outcome = value.screenStop("screen_1").then(() => "resolved", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SCREEN_REQUEST_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ code: "screen_request_timeout" });
    expect(internal.httpMutations).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect((network.calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
    network.mode = "ok";
    await expect(value.screenStatus()).resolves.toMatchObject({ supported: true });
  });

  it("a late answer after the bound is dropped: no second decrement, no follow-up call, no late state", async () => {
    network.mode = "ignore-abort";
    const { value, internal } = connection();
    const outcome = value.screenOpen(open).then(() => "resolved", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SCREEN_REQUEST_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ code: "screen_request_timeout" });
    expect(internal.httpMutations).toBe(0);
    // The stalled transport finally answers with a valid join.
    const join = { session: { id: "screen_late", desktopId: "desktop_1", deviceId: "device_1", deviceName: "Viewer", generation: "generation_late",
      display: { id: "display", nativeId: "1", name: "D", revision: 1, x: 0, y: 0, width: 100, height: 100, scale: 1, rotation: 0 }, controlAllowed: false, state: "connecting", createdAt: 1 },
      controlTicket: "C".repeat(43), mediaTicket: "M".repeat(43), expiresAt: 2, serverTime: 1, quality: "sharp" };
    network.late.splice(0).forEach(resolve => resolve(new Response(JSON.stringify(join), { status: 201, headers: { "Content-Type": "application/json" } })));
    await vi.advanceTimersByTimeAsync(1000);
    expect(internal.httpMutations).toBe(0);
    expect(network.calls).toHaveLength(1);              // no screenStop or retry was triggered by the late join
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const mode of ["stall-body", "stall-error-body"] as const) {
    it(`a ${mode === "stall-body" ? "success" : "refusal"} whose body never arrives still ends at the bound and cleans up once`, async () => {
      network.mode = mode;
      const { value, internal } = connection();
      const outcome = value.screenStop("screen_1").then(() => "resolved", (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(SCREEN_REQUEST_TIMEOUT_MS - 1);
      expect(internal.httpMutations).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ code: "screen_request_timeout" });
      expect(internal.httpMutations).toBe(0); expect(vi.getTimerCount()).toBe(0);
      network.body.splice(0).forEach(resolve => resolve({ ok: true, error: "late" }));
      await vi.advanceTimersByTimeAsync(10);
      expect(internal.httpMutations).toBe(0);
    });
  }

  it("a route change ends a screen call at once even if the transport ignores abort (not reported as a timeout)", async () => {
    network.mode = "ignore-abort";
    const { value, internal } = connection();
    const outcome = value.screenStop("screen_1").then(() => "resolved", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    (internal as unknown as { httpEpoch: AbortController }).httpEpoch.abort();
    const error = await outcome;
    expect(error).toBeInstanceOf(DOMException); expect((error as DOMException).name).toBe("AbortError");
    expect(internal.httpMutations).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("other HTTP calls keep the general bound (no global change)", async () => {
    const { value } = connection();
    const pending = (value as unknown as { httpRequest: (route: string) => Promise<unknown> }).httpRequest("/api/other").then(() => "resolved", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SCREEN_REQUEST_TIMEOUT_MS * 2);
    expect(await Promise.race([pending, Promise.resolve("still pending")])).toBe("still pending");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await pending).toBeInstanceOf(DOMException);
  });
});
