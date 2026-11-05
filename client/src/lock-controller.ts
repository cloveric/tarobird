export interface LockBackend { load(): Promise<boolean>; save(enabled: boolean): Promise<void>; available(): Promise<boolean>; authenticate(): Promise<void>; active(): Promise<boolean>; privacy(enabled: boolean): Promise<void> }
export interface LockState { ready: boolean; enabled: boolean; available: boolean; locked: boolean; busy: boolean; error?: string }
/** Controls the app's local screen lock; device trust remains a separate Hub policy. */
export class LockController {
  state: LockState = { ready: false, enabled: false, available: false, locked: true, busy: false };
  private listeners = new Set<() => void>(); private pending?: Promise<void>;
  constructor(private backend: LockBackend) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  private set(value: Partial<LockState>) { this.state = { ...this.state, ...value }; this.listeners.forEach((listener) => listener()); }
  private run(work: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    this.set({ busy: true, error: undefined });
    this.pending = work().catch((error: unknown) => this.set({ error: error instanceof Error ? error.message : String(error) })).finally(() => { this.pending = undefined; this.set({ busy: false }); }); return this.pending;
  }
  initialize(): Promise<void> { return this.run(async () => { const enabled = await this.backend.load(); await this.backend.privacy(enabled); const available = await this.backend.available(); this.set({ ready: true, enabled, locked: enabled, available }); }); }
  background(): void { if (this.state.enabled && !this.state.busy) this.set({ locked: true }); }
  lock(): void { if (this.state.enabled) this.set({ locked: true }); }
  unlock(): Promise<void> { return this.run(async () => { if (!this.state.ready || !this.state.enabled) return; await this.backend.authenticate(); if (await this.backend.active()) this.set({ locked: false }); }); }
  setEnabled(enabled: boolean): Promise<void> { return this.run(async () => {
    if (!this.state.ready || enabled === this.state.enabled) return;
    await this.backend.authenticate(); if (!await this.backend.active()) return;
    const previous = this.state.enabled;
    try { await this.backend.privacy(enabled); await this.backend.save(enabled); }
    catch (error) { await this.backend.privacy(previous).catch(() => undefined); throw error; }
    this.set({ enabled, locked: enabled && !await this.backend.active() });
  }); }
}
