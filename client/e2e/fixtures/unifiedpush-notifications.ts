// Controlled Firebase Task and legacy broadcast boundary, not real FCM.
const listeners = new Map<string, Set<(value: any) => void>>();
export const firebaseFixture = {
  clearHold: false, releaseClear: undefined as (() => void) | undefined,
  calls: [] as string[], hold: false, error: "", token: "fixture-shared-device-token",
  pending: [] as { resolve(value: { token: string }): void; reject(error: Error): void }[],
  async clear() { this.calls.push("clearFirebase"); if (this.clearHold) await new Promise<void>((resolve) => { this.releaseClear = resolve; }); },
  register() {
    this.calls.push("getToken");
    if (this.hold) return new Promise<{ token: string }>((resolve, reject) => this.pending.push({ resolve, reject }));
    return this.error ? Promise.reject(new Error(this.error)) : Promise.resolve({ token: this.token });
  },
  release(index: number, error?: string) {
    const pending = this.pending[index];
    if (error) pending?.reject(new Error(error)); else pending?.resolve({ token: this.token });
  },
  emit(event: string, value: unknown) { for (const listener of listeners.get(event) ?? []) listener(value); },
};
export const PushNotifications = {
  removeAllDeliveredNotifications: async () => { firebaseFixture.calls.push("clear delivered"); },
  requestPermissions: async () => ({ receive: "granted" }),
  addListener: async (event: string, listener: (data: any) => void) => {
    firebaseFixture.calls.push(`listen ${event}`);
    const group = listeners.get(event) ?? new Set(); listeners.set(event, group); group.add(listener);
    return { remove: async () => { group.delete(listener); } };
  },
  register: async () => {
    firebaseFixture.calls.push("legacy register");
    void firebaseFixture.register().then(({ token }) => firebaseFixture.emit("registration", { value: token }), (error) => firebaseFixture.emit("registrationError", { error: String(error) }));
  },
};
