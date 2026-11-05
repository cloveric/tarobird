import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { pushSubscriptionSchema, type PushSubscription } from "../../src/client-protocol/push.js";

export interface UnifiedScope { instance: string; hostId: string; deviceId: string; migrateLegacy?: boolean }
export interface UnifiedRegistration { confirmed?: boolean; remoteRemoval?: boolean; schemaVersion?: number; instance?: string; hostId?: string; deviceId?: string; registrationId?: string; phase?: string; endpoint?: string; keys?: { p256dh: string; auth: string }; error?: string; distributor?: string; sharedDistributor?: string; registrationCount?: number }
export interface UnifiedBridge {
  state(scope: UnifiedScope): Promise<UnifiedRegistration>;
  register(options: UnifiedScope & { distributor: string }): Promise<UnifiedRegistration>;
  addListener(event: "registrationChanged", listener: (state: UnifiedRegistration) => void): Promise<{ remove(): Promise<void> }>;
}
export function unifiedScope(hostId: string, deviceId: string, migrateLegacy = false): UnifiedScope {
  if (!/^hub_[0-9a-f]{64}$/.test(hostId) || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error("unifiedpush_identity_invalid");
  return { instance: `up_${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([hostId, deviceId]))))}`, hostId, deviceId, migrateLegacy };
}
export function checkUnifiedState(state: UnifiedRegistration, scope: UnifiedScope): UnifiedRegistration {
  if (state.schemaVersion !== 2) throw new Error("unifiedpush_client_update_required");
  if (state.instance !== scope.instance || state.hostId !== scope.hostId || state.deviceId !== scope.deviceId) throw new Error("unifiedpush_identity_conflict");
  return state;
}
export function unifiedSubscription(state: UnifiedRegistration, scope: UnifiedScope): PushSubscription | undefined {
  if (state.instance !== scope.instance || state.hostId !== scope.hostId || state.deviceId !== scope.deviceId) return;
  checkUnifiedState(state, scope);
  if (state.error) throw new Error(state.error);
  if (state.phase !== "active" || !state.endpoint) return;
  if (!state.keys) throw new Error("unifiedpush_encryption_required");
  return pushSubscriptionSchema.parse({ provider: "unifiedpush", endpoint: state.endpoint, keys: state.keys });
}
export async function registerUnifiedDistributor(native: UnifiedBridge, scope: UnifiedScope, distributor: string, save: (subscription: PushSubscription, registrationId: string) => Promise<void>, timeoutMs = 30_000): Promise<void> {
  let subscription: PushSubscription | undefined, failure: unknown, generation: string | undefined, closed = false;
  let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; });
  const receive = (state: UnifiedRegistration) => {
    if (closed || state.instance !== scope.instance || state.hostId !== scope.hostId || state.deviceId !== scope.deviceId) return;
    if (!generation) return;
    if (state.registrationId !== generation) return;
    try { failure = undefined; subscription = unifiedSubscription(state, scope); if (subscription) finish(); } catch (error) { failure = error; finish(); }
  };
  const listener = await native.addListener("registrationChanged", receive);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready: PushSubscription;
  try {
    ready = await Promise.race([
      (async () => {
        const registered = checkUnifiedState(await native.register({ ...scope, distributor }), scope);
        if (closed) throw new Error("unifiedpush_registration_timeout");
        generation = registered.registrationId; if (!generation) throw new Error("unifiedpush_registration_missing");
        receive(registered);
        receive(await native.state(scope)); await done;
        if (closed) throw new Error("unifiedpush_registration_timeout"); if (failure) throw failure;
        if (!subscription) throw new Error("unifiedpush_registration_timeout");
        return subscription;
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("unifiedpush_registration_timeout")), timeoutMs); }),
    ]);
  } finally { closed = true; clearTimeout(timer); await listener.remove(); }
  // Only endpoint acquisition times out. Keep this pairing's operation queued
  // until the Hub write settles, so a later DELETE cannot overtake this PUT.
  await save(ready, generation!);
}

/** Ordering belongs to a pairing. Slow A never stalls B; the legacy whole-device
 * reset is the only operation allowed to fence every pairing at once. */
export class UnifiedOperations {
  private readonly pending = new Map<string, Promise<unknown>>();
  private barrier: Promise<unknown> = Promise.resolve();
  run<T>(instance: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(instance);
    const task = Promise.all([this.barrier, previous?.catch(() => undefined)]).then(operation);
    this.pending.set(instance, task);
    const clear = () => { if (this.pending.get(instance) === task) this.pending.delete(instance); };
    void task.then(clear, clear); return task;
  }
  all<T>(operation: () => Promise<T>): Promise<T> {
    const task = Promise.all([this.barrier, ...[...this.pending.values()].map((work) => work.catch(() => undefined))]).then(operation);
    this.barrier = task.catch(() => undefined); return task;
  }
}
