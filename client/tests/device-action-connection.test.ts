import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import vector from "../../tests/fixtures/device-action-vector.json";

const io = vi.hoisted(() => ({ fetch: vi.fn(), sign: vi.fn() }));
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ signDeviceAction: io.sign }));
vi.mock("../src/transport.js", () => ({ hubFetch: io.fetch }));
import { HubConnection } from "../src/connection.js";
import type { Identity } from "../src/storage.js";

let connection: HubConnection;
const token = "fixture-only-session";
const statement = { ...vector.statement, sessionHash: createHash("sha256").update(token).digest("hex") };
beforeEach(() => {
  vi.resetAllMocks(); io.sign.mockResolvedValue(vector.signature);
  const identity: Identity = { deviceId: statement.deviceId, name: "Fixture", publicKey: vector.publicKey, hubPublicKey: statement.hubPublicKey, routes: [] };
  connection = new HubConnection(identity);
  // Begin at the authenticated transport boundary; no real cache or UI involved.
  Reflect.set(connection, "token", token);
  connection.state.route = { name: "Direct", url: "https://hub.example" };
  io.fetch.mockImplementation(async (_url, route) => Response.json(route === "/api/devices/challenge" ? statement : { ok: true }));
});
const approve = (signal?: AbortSignal) => connection.http("/api/devices/approve", { method: "POST", body: JSON.stringify({ code: statement.action.target }), signal });

it("signs the bound challenge before posting the intended approval", async () => {
  expect(await approve()).toEqual({ ok: true });
  expect(io.sign).toHaveBeenCalledOnce(); expect(io.fetch).toHaveBeenCalledTimes(2);
  const [, route, , init] = io.fetch.mock.calls[1];
  expect(route).toBe("/api/devices/approve");
  expect(JSON.parse(init.body)).toEqual({ code: statement.action.target, proof: { nonce: statement.nonce, signature: vector.signature } });
  expect(init.headers.get("Authorization")).toBe(`Bearer ${token}`);
});

it.each(["renewal", "epoch", "abort", "close"])("does not submit after %s while signing is pending", async (condition) => {
  const abort = new AbortController();
  io.sign.mockImplementation(async () => {
    if (condition === "renewal") Reflect.set(connection, "token", "renewed-session");
    if (condition === "epoch") Reflect.set(connection, "httpEpoch", new AbortController());
    if (condition === "abort") abort.abort();
    if (condition === "close") Reflect.set(connection, "closed", true);
    return vector.signature;
  });
  await expect(approve(abort.signal)).rejects.toMatchObject({ code: "device_action_cancelled" });
  expect(io.fetch).toHaveBeenCalledOnce();
});

it("rejects a substituted challenge without signing", async () => {
  io.fetch.mockResolvedValue(Response.json({ ...statement, action: { operation: "approve", target: "12345678" } }));
  await expect(approve()).rejects.toMatchObject({ code: "device_action_invalid" });
  expect(io.sign).not.toHaveBeenCalled(); expect(io.fetch).toHaveBeenCalledOnce();
});

it("does not downgrade to unsigned operations on an older Hub", async () => {
  io.fetch.mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 }));
  await expect(approve()).rejects.toMatchObject({ code: "device_action_unavailable" });
  expect(io.sign).not.toHaveBeenCalled(); expect(io.fetch).toHaveBeenCalledOnce();
});

it("does not submit when the signing key is unavailable", async () => {
  io.sign.mockRejectedValue(new Error("device_key_unavailable"));
  await expect(approve()).rejects.toMatchObject({ code: "device_action_signing_failed" });
  expect(io.fetch).toHaveBeenCalledOnce();
});
