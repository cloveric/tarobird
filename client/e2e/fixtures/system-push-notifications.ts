const listeners = new Map<string, Set<(value: any) => void>>();
export const native = {
  calls: [] as string[], auto: true, permission: "granted", revision: 0, token: "a".repeat(64), failed: false,
  hold: "", released: [] as (() => void)[], retained: false, unavailable: false,
  async stage(name: string) { this.calls.push(name); if (this.hold === name) await new Promise<void>(resolve => this.released.push(resolve)); },
  release() { this.hold = ""; this.released.splice(0).forEach(resolve => resolve()); },
  emit(event: string, value: unknown) { for (const listener of [...listeners.get(event) ?? []]) listener(value); },
  update(token: string, failed = false) { this.token = token; this.failed = failed; this.revision++; this.emit(failed ? "registrationError" : "registration", { value: token }); },
  async snapshot() { await this.stage("snapshot"); if (this.unavailable) throw { code: "UNIMPLEMENTED" }; return { revision: this.revision, token: this.failed ? undefined : this.token, failed: this.failed }; },
  listeners() { return [...listeners.values()].reduce((sum, group) => sum + group.size, 0); },
};
export const PushNotifications = {
  checkPermissions: async () => { await native.stage("permission"); return { receive: native.permission }; },
  requestPermissions: async () => { await native.stage("PROMPT"); return { receive: native.permission }; },
  addListener: async (event: string, listener: (data: any) => void) => {
    const group = listeners.get(event) ?? new Set(); listeners.set(event, group); group.add(listener);
    if (native.retained && event === "registration") listener({ value: "retained_" + "b".repeat(50) });
    await native.stage(`listen ${event}`);
    return { remove: async () => { group.delete(listener); } };
  },
  register: async () => { native.calls.push("APNs register"); if (native.auto) native.update(native.token); },
};
