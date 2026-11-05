import { afterEach, expect, test, vi } from "vitest";
import { maintainPushBinding, type SystemPushDevice, type PushMaintenanceConnection } from "../client/src/push-maintenance.js";
const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); });
function fixture(provider: string | null = "fcm", enabled = true) {
  let state: PushMaintenanceConnection["state"] = { status: "online" }, binding = { provider, enabled, revision: provider ? "revision-1" : null };
  const watchers = new Set<() => void>(); const patches: any[] = [];
  let changed = () => {}, foreground = () => {};
  const tokens = ["token_" + "a".repeat(40)];
  const token = vi.fn(async (_refresh: boolean) => tokens.at(-1)!);
  const http = vi.fn(async (_route: string, init: RequestInit = {}) => {
    if (init.method === "PATCH") { patches.push(JSON.parse(String(init.body))); return { ok: true }; }
    return { ...binding };
  });
  const connection = { get state() { return state; }, subscribe(f: () => void) { watchers.add(f); return () => { watchers.delete(f); }; }, http } as unknown as PushMaintenanceConnection;
  const device: SystemPushDevice = { provider: "fcm", token, observe(f) { changed = f; return () => { changed = () => {}; }; } };
  return { http, token, tokens, patches, get binding() { return binding; }, setBinding(value: typeof binding) { binding = value; }, connection,
    settings(enabled: boolean) { state = { ...state, notifications: { preferences: { enabled } } }; watchers.forEach(f => f()); },
    change: () => changed(), foreground: () => foreground(), state(status: string) { state = { status }; watchers.forEach(f => f()); },
    start(guard?: <T>(work: () => Promise<T>) => Promise<T>) { const stop = maintainPushBinding(connection, device, f => { foreground = f; return () => { foreground = () => {}; }; }, guard); stops.push(stop); return stop; } };
}
const settled = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
test.each([[null, true], ["fcm", false], ["unifiedpush", true], ["apns", true], ["webpush", true]] as const)("does not register or request a token for %s enabled=%s", async (provider, enabled) => {
  const f = fixture(provider, enabled); f.start(); await settled(); f.change(); f.foreground(); await settled(); expect(f.patches).toEqual([]); expect(f.token).not.toHaveBeenCalled();
});
test("a slow host does not delay token delivery to another host", async () => {
  const slow = fixture(), fast = fixture(); let resolve!: (value: unknown) => void;
  slow.http.mockImplementationOnce(() => new Promise(r => { resolve = r; }) as any);
  slow.start(); fast.start(); await settled(); expect(fast.patches).toHaveLength(1); expect(slow.patches).toHaveLength(0);
  resolve(slow.binding); await settled(); expect(slow.patches).toHaveLength(1);
});
test("native hint and healthy foreground both refresh; ordinary state notifications do not", async () => {
  const f = fixture(); f.start(); await settled(); f.state("online"); await settled(); expect(f.patches).toHaveLength(1);
  f.tokens.push("new_" + "b".repeat(40)); f.change(); await settled(); expect(f.patches.at(-1).token).toBe(f.tokens.at(-1)); expect(f.token).toHaveBeenLastCalledWith(false);
  f.foreground(); await settled(); expect(f.token).toHaveBeenLastCalledWith(true); expect(f.patches).toHaveLength(3);
});
test("a conflict refetches native token before using new binding revision", async () => {
  const f = fixture(); let conflict = true;
  f.http.mockImplementation(async (_route, init = {}) => {
    if (init.method !== "PATCH") return { ...f.binding };
    f.patches.push(JSON.parse(String(init.body)));
    if (conflict) { conflict = false; f.tokens.push("new_" + "b".repeat(40)); f.setBinding({ ...f.binding, revision: "revision-2" }); throw { status: 409 }; }
    return { ok: true } as any;
  });
  f.start(); await settled(); expect(f.patches).toHaveLength(2); expect(f.patches[1]).toMatchObject({ expectedRevision: "revision-2", token: f.tokens.at(-1) }); expect(f.token).toHaveBeenCalledTimes(2);
});
test("a switch to UnifiedPush while reading native token stops the conflict retry", async () => {
  const f = fixture(); f.http.mockImplementation(async (_route, init = {}) => {
    if (init.method !== "PATCH") return { ...f.binding };
    f.patches.push(JSON.parse(String(init.body))); f.setBinding({ ...f.binding, provider: "unifiedpush", revision: "revision-2" }); throw { status: 409 };
  });
  f.start(); await settled(); expect(f.patches).toHaveLength(1); expect(f.token).toHaveBeenCalledTimes(1);
});
test.each(["dispose", "offline"])("%s before native read completes prevents PATCH", async (end) => {
  const f = fixture(); let resolve!: (token: string) => void; f.token.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const stop = f.start(); await settled(); if (end === "dispose") stop(); else f.state("offline"); resolve(f.tokens[0]!); await settled(); expect(f.patches).toHaveLength(0);
});
test("old Hub never gets an unconditional PUT, and errors recover on foreground", async () => {
  const f = fixture(); f.http.mockRejectedValueOnce({ status: 404 }); f.start(); await settled(); expect(f.token).not.toHaveBeenCalled(); f.foreground(); await settled(); expect(f.patches).toHaveLength(1); expect(f.http.mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true);
});
test("repeated conflicts are bounded until the next external event", async () => {
  const f = fixture(); f.http.mockImplementation(async (_route, init = {}) => { if (init.method === "PATCH") { f.patches.push(init.body); throw { status: 409 }; } return { ...f.binding }; });
  f.start(); await settled(); expect(f.patches).toHaveLength(2); expect(f.token).toHaveBeenCalledTimes(2);
});

test("a native hint at the drain completion boundary is not lost", async () => {
  const f = fixture(); let first = true;
  f.start(work => {
    const result = work();
    if (first) { first = false; void result.then(() => queueMicrotask(() => f.change())); }
    return result;
  });
  await settled(); expect(f.patches).toHaveLength(2);
});

test("initial and same-value settings reads do not register again; a known consent change still refreshes", async () => {
  const f = fixture(); f.start(); await settled(); expect(f.token).toHaveBeenCalledTimes(1);
  f.settings(true); await settled(); f.settings(true); await settled(); expect(f.token).toHaveBeenCalledTimes(1);
  f.setBinding({ ...f.binding, enabled: false }); f.settings(false); await settled(); expect(f.token).toHaveBeenCalledTimes(1);
  f.setBinding({ ...f.binding, enabled: true }); f.settings(true); await settled(); expect(f.token).toHaveBeenCalledTimes(2);
});
