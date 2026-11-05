export const native = {
  calls: [] as { command: string; args?: any }[], handlers: new Set<() => void>(), pending: null as any,
  failures: {} as Record<string, number>, holds: {} as Record<string, boolean>, releases: new Map<string, (() => void)[]>(),
  permission: "granted", permissionError: "", requestError: "", requestResult: "granted", livePeek: false,
  activate(target: unknown, silent = false) { this.pending = { id: crypto.randomUUID(), activatedAt: performance.now(), target }; if (!silent) this.emit(); },
  peek() { if (!this.pending) return null; const { activatedAt, ...action } = this.pending; return { ...action, ageMs: performance.now() - activatedAt }; },
  emit() { this.handlers.forEach((handler) => handler()); },
  release(command: string) { this.holds[command] = false; this.releases.get(command)?.forEach((release) => release()); this.releases.delete(command); },
};
export * from "../../node_modules/@tauri-apps/api/core.js";
export const isTauri = () => true;
export const invoke = async <T>(command: string, args?: any): Promise<T> => {
  native.calls.push({ command, args });
  const captured = native.peek();
  if (native.holds[command]) await new Promise<void>((resolve) => native.releases.set(command, [...native.releases.get(command) ?? [], resolve]));
  if (native.failures[command]) { native.failures[command]!--; throw new Error(`${command}_failed`); }
  if (command === "desktop_notifications_supported") return true as T;
  // Notification routing exercises a client-only desktop with two saved hosts;
  // it does not bootstrap a real embedded Host in this browser fixture.
  if (command === "desktop_host") return { available: false } as T;
  if (command === "desktop_notification_context") return "fixture-document" as T;
  if (["desktop_notification_show", "desktop_notification_clear"].includes(command) && args.documentId !== "fixture-document") throw new Error("native_notification_cancelled");
  if (command === "desktop_notification_peek") return (native.livePeek ? native.peek() : captured) as T;
  if (command === "desktop_notification_ack" && native.pending?.id === args.id) native.pending = null;
  if (command === "desktop_notification_clear" && (!args?.hostId || native.pending?.target.hostId === args.hostId)) native.pending = null;
  if (command === "desktop_notification_permission") {
    if (native.permissionError) throw native.permissionError;
    if (args.request && native.requestError) throw native.requestError;
    return (args.request ? native.requestResult : native.permission) as T;
  }
  if (command === "update_info") return { configured: false, version: "fixture" } as T;
  return undefined as T;
};
export const listen = async (event: string, handler: () => void) => {
  native.calls.push({ command: `listen ${event}` }); native.handlers.add(handler);
  const command = `listen ${event}`;
  if (native.holds[command]) await new Promise<void>((resolve) => native.releases.set(command, [...native.releases.get(command) ?? [], resolve]));
  return () => { native.calls.push({ command: `unlisten ${event}` }); native.handlers.delete(handler); };
};
export const getCurrent = async () => null;
export const onOpenUrl = async () => () => {};
export const onAction = async () => { throw new Error("legacy_notification_must_not_be_used"); };
export const isPermissionGranted = async () => { throw new Error("legacy_permission_must_not_be_used"); };
export const sendNotification = () => { throw new Error("legacy_send_must_not_be_used"); };
