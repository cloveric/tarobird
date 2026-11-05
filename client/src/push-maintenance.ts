import { anySignal, timeoutSignal } from "./abort-signals.js";
import { pushBindingSchema, pushSubscriptionSchema, type PushSubscription } from "../../src/client-protocol/push.js";
export type PushMaintenanceConnection = {
  state: { status: string; notifications?: unknown };
  subscribe(listener: () => void): () => void;
  http(route: string, init?: RequestInit): Promise<unknown>;
};

export const PUSH_FOREGROUND_EVENT = "tarocub:push-foreground";
export type SystemPushDevice = {
  provider: "apns" | "fcm";
  token(refresh: boolean): Promise<string>;
  observe(changed: () => void): () => void;
  /** Builds the Hub write; may refuse (for example an unroutable APNs topic).
   * Its own Hub reads use the loop's cancellation and timeout signal. */
  subscription?(token: string, signal: AbortSignal): Promise<PushSubscription>;
};
/** Each host owns its loop and cancellation. No host waits for another host's
 * network, and no token is retained in client storage or notification settings. */
export function maintainPushBinding(connection: PushMaintenanceConnection, device: SystemPushDevice,
  foreground: (changed: () => void) => () => void, guard: <T>(work: () => Promise<T>) => Promise<T> = (work) => work()): () => void {
  let stopped = false, running = false, pending = 0;
  // Reading settings publishes a fresh object. Only a consent change should
  // start token work; diagnostic GETs must remain free of registration effects.
  const consent = () => (connection.state.notifications as { preferences?: { enabled?: boolean } } | undefined)?.preferences?.enabled;
  let status = connection.state.status, enabled = consent();
  const controller = new AbortController();
  const current = () => !stopped && connection.state.status === "online";
  const signal = () => anySignal([controller.signal, timeoutSignal(20_000)]);
  const sync = async (refresh: boolean) => {
    // A conflict permits one fresh read, including a fresh native token. Never
    // replay an old token under a newer consent revision or use PUT as fallback.
    for (let attempt = 0; attempt < 2 && current(); attempt++) {
      const binding = pushBindingSchema.parse(await connection.http("/api/push", { signal: signal() }));
      if (!current() || !binding.enabled || binding.provider !== device.provider || !binding.revision) return;
      const token = await device.token(refresh || attempt > 0);
      if (!current()) return;
      const subscription = device.subscription ? await device.subscription(token, signal()) : pushSubscriptionSchema.parse({ provider: device.provider, token });
      if (!current()) return;
      try {
        await connection.http("/api/push", { method: "PATCH", signal: signal(), body: JSON.stringify({ ...subscription, expectedRevision: binding.revision }) });
        return;
      } catch (error) {
        if (!(error && typeof error === "object" && "status" in error && error.status === 409)) throw error;
      }
    }
  };
  const request = (refresh: boolean) => {
    if (!current()) return;
    pending = Math.max(pending, refresh ? 2 : 1);
    if (running) return;
    running = true;
    void (async () => {
      try { while (pending && current()) {
        const refresh = pending === 2; pending = 0;
        // Android uses the same per-host/native-cleanup barrier as settings.
        try { await guard(async () => { if (current()) await sync(refresh); }); }
        catch { /* Offline, denied permission, old Hub/shell: retry on next foreground/reconnect. */ }
      } } finally { running = false; }
    })();
  };
  const unsubscribe = connection.subscribe(() => {
    const next = connection.state, nextEnabled = consent();
    // The initial settings GET fills an unknown preference; the initial/online
    // sync already inspected the authoritative binding and must not run twice.
    const changed = status !== next.status || enabled !== undefined && enabled !== nextEnabled;
    status = next.status; enabled = nextEnabled;
    if (changed) request(true);
  });
  const unobserve = device.observe(() => request(false));
  const unforeground = foreground(() => request(true));
  request(true);
  return () => { stopped = true; pending = 0; controller.abort(); unsubscribe(); unobserve(); unforeground(); };
}
