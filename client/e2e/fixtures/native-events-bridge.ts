// SDK boundary substitution. These handles do not prove OS bridge delivery or removal.
type Behavior = { fail?: number; hold?: boolean; replay?: unknown; remove?: "throw" | "reject"; removeEmit?: { name: string; value: unknown } };
type Handle = { name: string; callback: (value: any) => void; removeCalls: number; remove: () => Promise<void> };
export const bridge = {
  pushRevision: 0, pushToken: undefined as string | undefined, pushFailed: false,
  platform: "ios", behavior: {} as Record<string, Behavior>, handles: [] as Handle[], calls: [] as string[],
  pending: new Map<string, (() => void)[]>(), launch: undefined as string | undefined,
  async read(name: string) {
    this.calls.push(name); const behavior = this.behavior[name] ?? {};
    if (behavior.fail) { behavior.fail--; throw new Error(`${name} failed`); }
    if (behavior.hold) await new Promise<void>((resolve) => { this.pending.set(name, [...this.pending.get(name) ?? [], resolve]); });
    return this.launch;
  },
  register(name: string, callback: (value: any) => void) {
    this.calls.push(name); const behavior = this.behavior[name] ?? {};
    const handle: Handle = { name, callback, removeCalls: 0, remove: () => {
      handle.removeCalls++; this.calls.push(`${name} remove`);
      if (behavior.removeEmit) this.emit(behavior.removeEmit.name, behavior.removeEmit.value);
      if (behavior.remove === "throw") throw new Error("remove threw");
      return behavior.remove === "reject" ? Promise.reject(new Error("remove rejected")) : Promise.resolve();
    } };
    this.handles.push(handle);
    // Capacitor retained events can arrive before addListener resolves.
    if (behavior.replay !== undefined) callback(behavior.replay);
    if (behavior.fail) { behavior.fail--; return Promise.reject(new Error(`${name} failed`)); }
    if (behavior.hold) return new Promise<Handle>((resolve) => { this.pending.set(name, [...this.pending.get(name) ?? [], () => resolve(handle)]); });
    return Promise.resolve(handle);
  },
  release(name: string) { for (const release of this.pending.get(name) ?? []) release(); this.pending.delete(name); },
  emit(name: string, value: unknown) {
    if (name === "registration" || name === "registrationError") { this.pushRevision++; this.pushFailed = name === "registrationError"; this.pushToken = this.pushFailed ? undefined : (value as { value: string }).value; }
    for (const handle of this.handles.filter((h) => h.name === name)) handle.callback(value); },
};
export const App = {
  getInfo: async () => ({ id: "com.tarobot.client" }),
  getLaunchUrl: async () => { const url = await bridge.read("launch"); return url ? { url } : undefined; },
  addListener: (name: string, callback: (value: any) => void) => bridge.register(name, callback),
};
export const PushNotifications = {
  checkPermissions: async () => ({ receive: "granted" }),
  requestPermissions: async () => ({ receive: "granted" }),
  register: async () => {
    bridge.calls.push("register");
    if (bridge.behavior.register?.fail) bridge.emit("registrationError", { error: "current failure" });
    else bridge.emit("registration", { value: "a".repeat(64) });
  },
  addListener: (name: string, callback: (value: any) => void) => bridge.register(name, callback),
};
export const getCurrent = async () => { const url = await bridge.read("current"); return url ? [url] : null; };
export const onOpenUrl = async (callback: (value: string[]) => void) => { const handle = await bridge.register("openUrl", callback); return () => { void handle.remove(); }; };
export const onAction = async (callback: (value: any) => void) => { const handle = await bridge.register("notificationAction", callback); return { unregister: handle.remove }; };

export const getCurrentWindow = () => ({
  listen: async (name: string, callback: (value: unknown) => void) => {
    const handle = await bridge.register(name, callback);
    return () => handle.remove();
  },
});
