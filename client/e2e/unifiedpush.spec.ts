import { test, expect } from "@playwright/test";
import { checkUnifiedState, registerUnifiedDistributor, unifiedScope, unifiedSubscription, UnifiedOperations, type UnifiedBridge, type UnifiedRegistration } from "../src/unifiedpush-controller.js";

const scope = unifiedScope(`hub_${"a".repeat(64)}`, "same_device");
const other = unifiedScope(`hub_${"b".repeat(64)}`, "same_device");
const state: UnifiedRegistration = { ...scope, schemaVersion: 2, phase: "active", registrationId: "generation_one", endpoint: "https://ntfy.example.test/upabcdefghijklmnop", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
function bridge(current: UnifiedRegistration) {
  let listener: ((state: UnifiedRegistration) => void) | undefined; let removed = 0;
  const native: UnifiedBridge = { state: async () => current, register: async () => { listener?.(current); return current; }, addListener: async (_event, callback) => { listener = callback; return { remove: async () => { removed++; listener = undefined; } }; } };
  return { native, emit: (value: UnifiedRegistration) => listener?.(value), removed: () => removed };
}
test("scope hashes match native registry and distinguish the same device ID on different Hubs", () => {
  expect(scope.instance).toBe("up_68d73792edf56c750f9e2ea5a9189f3bd30ce0da42b82ad04c98f6f7e7eded9e"); expect(other.instance).not.toBe(scope.instance);
  expect(() => unifiedScope("hub_invalid", "same_device")).toThrow("identity");
});
test("registration requires matching encryption metadata and a Hub receipt", async () => {
  const fixture = bridge(state); let saves = 0;
  await registerUnifiedDistributor(fixture.native, scope, "test.distributor", async (value) => { saves++; expect(value).toEqual({ provider: "unifiedpush", endpoint: state.endpoint, keys: state.keys }); });
  expect(saves).toBe(1); expect(fixture.removed()).toBe(1);
  const denied = bridge(state);
  await expect(registerUnifiedDistributor(denied.native, scope, "test.distributor", async () => { throw new Error("endpoint_not_allowlisted"); })).rejects.toThrow("allowlisted");
  expect(denied.removed()).toBe(1);
});
test("old native APIs and invalid or unencrypted endpoints fail explicitly", () => {
  expect(() => checkUnifiedState({ instance: "same_device" }, scope)).toThrow("client_update_required");
  expect(() => checkUnifiedState({ ...state, ...other }, scope)).toThrow("identity_conflict");
  expect(() => unifiedSubscription({ ...state, keys: undefined }, scope)).toThrow("encryption");
  expect(() => unifiedSubscription({ ...state, error: "unifiedpush_registration_failed" }, scope)).toThrow("registration_failed");
  expect(() => unifiedSubscription({ ...state, endpoint: "http://unsafe.test/topic" }, scope)).toThrow();
  expect(unifiedSubscription({ ...state, ...other }, scope)).toBeUndefined();
  expect(unifiedSubscription({ ...state, phase: "removing", endpoint: undefined }, scope)).toBeUndefined();
});
test("other-host and previous-generation callbacks cannot complete a new registration", async () => {
  const fixture = bridge({ ...state, endpoint: undefined, keys: undefined }); const started = deferred<void>();
  fixture.native.state = async () => { started.resolve(); return { ...state, endpoint: undefined, keys: undefined }; };
  let saves = 0;
  const pending = registerUnifiedDistributor(fixture.native, scope, "test.distributor", async () => { saves++; }, 1000);
  await started.promise;
  fixture.emit({ ...state, ...other }); fixture.emit({ ...state, registrationId: "old_generation" });
  await new Promise((resolve) => setTimeout(resolve, 20)); expect(saves).toBe(0);
  fixture.emit(state); await pending; expect(saves).toBe(1); expect(fixture.removed()).toBe(1);
});
test("timed-out native registration cannot write to the Hub after its late reply", async () => {
  const fixture = bridge(state); const nativeReply = deferred<UnifiedRegistration>(); fixture.native.register = () => nativeReply.promise; let saves = 0;
  await expect(registerUnifiedDistributor(fixture.native, scope, "test.distributor", async () => { saves++; }, 20)).rejects.toThrow("timeout");
  nativeReply.resolve(state); fixture.emit(state); await new Promise((resolve) => setTimeout(resolve, 20));
  expect(saves).toBe(0); expect(fixture.removed()).toBe(1);
});
test("slow Hub PUT stays ahead of DELETE even beyond the native registration timeout", async () => {
  const queue = new UnifiedOperations(), fixture = bridge(state), put = deferred<void>(), started = deferred<void>(), log: string[] = [];
  const register = queue.run(scope.instance, () => registerUnifiedDistributor(fixture.native, scope, "test.distributor", async () => { log.push("PUT start"); started.resolve(); await put.promise; log.push("PUT done"); }, 15));
  await started.promise; const remove = queue.run(scope.instance, async () => { log.push("DELETE"); });
  await new Promise((resolve) => setTimeout(resolve, 35)); expect(log).toEqual(["PUT start"]);
  put.resolve(); await Promise.all([register, remove]); expect(log).toEqual(["PUT start", "PUT done", "DELETE"]);
});
test("per-host failures release their queue without blocking another host", async () => {
  const queue = new UnifiedOperations(), blocked = deferred<void>(), log: string[] = [];
  const a = queue.run(scope.instance, async () => { await blocked.promise; throw new Error("offline"); });
  const failure = expect(a).rejects.toThrow("offline");
  const retry = queue.run(scope.instance, async () => { log.push("A retry"); });
  await queue.run(other.instance, async () => { log.push("B independent"); }); expect(log).toEqual(["B independent"]);
  blocked.resolve(); await failure; await retry; expect(log).toEqual(["B independent", "A retry"]);
});
test("whole-device reset drains previous operations and fences new registrations", async () => {
  const queue = new UnifiedOperations(), pending = deferred<void>(), reset = deferred<void>(), log: string[] = [];
  const a = queue.run(scope.instance, async () => { await pending.promise; log.push("old write"); });
  const all = queue.all(async () => { log.push("reset start"); await reset.promise; log.push("reset done"); });
  const b = queue.run(other.instance, async () => { log.push("new write"); });
  pending.resolve(); await a; await expect.poll(() => log).toEqual(["old write", "reset start"]);
  reset.resolve(); await Promise.all([all,b]); expect(log).toEqual(["old write", "reset start", "reset done", "new write"]);
});

test("a stale failure before register returns cannot override its successful current state", async () => {
  const fixture = bridge(state);
  fixture.native.register = async () => { fixture.emit({ ...state, error: "unifiedpush_registration_failed", endpoint: undefined }); return state; };
  let saves = 0; await registerUnifiedDistributor(fixture.native, scope, "test.distributor", async () => { saves++; }); expect(saves).toBe(1);
});
