export type UpdateEvent = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" | "WaitingForHost" | "Installing" | "RestartingHost" };
export interface UpdateOffer { version: string; body?: string; close(): Promise<void>; downloadAndInstall(progress: (event: UpdateEvent) => void, options: { timeout: number }): Promise<void> }
export interface UpdateInfo { configured: boolean; version: string; provider?: "github" | "default"; authenticated?: boolean; login?: string }
export interface UpdateBackend { info(): Promise<UpdateInfo>; check(): Promise<UpdateOffer | null>; restart(): Promise<void> }
export interface UpdateState { phase: "initial" | "disabled" | "login-required" | "checking" | "current" | "available" | "installing" | "installed" | "restart-required" | "recovery-required" | "error"; version?: string; provider?: "github" | "default"; authenticated?: boolean; login?: string; nextVersion?: string; notes?: string; installStage?: "downloading" | "waiting" | "replacing" | "restarting"; bytes?: number; total?: number; error?: string }
const privateErrors = new Set(["design_not_saved", "github_update_login_required", "github_update_denied", "github_update_expired", "github_update_network", "github_update_configuration", "github_update_repo_unavailable", "github_update_signature", "github_update_invalid_offer", "github_update_cancelled", "github_update_browser", "github_update_response", "github_update_manifest", "github_update_keychain", "github_update_install", "github_update_busy", "github_update_bounds", "github_update_failed", "github_update_host", "github_update_permissions", "github_update_recovery", "github_update_installed_host_failed"]);
/** Native private-update failures are stable codes; never render native response detail. */
export function githubUpdateError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return privateErrors.has(code) ? code : "github_update_failed";
}
/** No automatic install: discovery and installation have separate entrypoints. */
export class UpdateController {
  state: UpdateState = { phase: "initial" }; private offer: UpdateOffer | null = null; private pending: Promise<void> | undefined;
  private listeners = new Set<() => void>();
  constructor(private backend: UpdateBackend) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  private set(value: UpdateState) { this.state = value; this.listeners.forEach((listener) => listener()); }
  private fail(error: unknown) {
    const message = this.state.provider === "github" ? githubUpdateError(error) : error instanceof Error ? error.message : String(error);
    this.set({ ...this.state, phase: message === "github_update_recovery" ? "recovery-required" : message === "github_update_login_required" ? "login-required" : "error", ...(message === "github_update_login_required" ? { authenticated: false, login: undefined } : {}), error: message });
  }
  check(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.state.phase === "installed" || this.state.phase === "restart-required" || this.state.phase === "recovery-required") return Promise.resolve();
    this.pending = this.discover().finally(() => { this.pending = undefined; }); return this.pending;
  }
  private async discover() {
    this.set({ ...this.state, phase: "checking", nextVersion: undefined, notes: undefined, error: undefined });
    try {
      const info = await this.backend.info();
      await this.offer?.close(); this.offer = null;
      this.set({ phase: "checking", version: info.version, provider: info.provider, authenticated: info.authenticated, login: info.login });
      if (!info.configured) { this.set({ ...this.state, phase: "disabled" }); return; }
      if (info.provider === "github" && !info.authenticated) { this.set({ ...this.state, phase: "login-required" }); return; }
      this.offer = await this.backend.check();
      this.set({ ...this.state, phase: this.offer ? "available" : "current", nextVersion: this.offer?.version, notes: this.offer?.body });
    } catch (error) { this.fail(error); }
  }
  install(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.offer || this.state.phase !== "available") return Promise.resolve();
    this.pending = this.performInstall(this.offer).finally(() => { this.pending = undefined; }); return this.pending;
  }
  private async performInstall(offer: UpdateOffer) {
    this.set({ ...this.state, phase: "installing", installStage: "downloading", bytes: 0 });
    try {
      // The native updater verifies the pinned signing key before installation.
      await offer.downloadAndInstall((event) => {
        if (event.event === "WaitingForHost") this.set({ ...this.state, installStage: "waiting" });
        if (event.event === "Installing") this.set({ ...this.state, installStage: "replacing" });
        if (event.event === "RestartingHost") this.set({ ...this.state, installStage: "restarting" });
        if (event.event === "Started") this.set({ ...this.state, total: event.data.contentLength });
        if (event.event === "Progress") this.set({ ...this.state, bytes: (this.state.bytes ?? 0) + event.data.chunkLength });
      }, { timeout: 300_000 });
      this.set({ ...this.state, phase: "installed" });
    } catch (error) {
      if (githubUpdateError(error) === "github_update_recovery") {
        this.set({ ...this.state, phase: "recovery-required", error: "github_update_recovery" });
      } else if (githubUpdateError(error) === "github_update_installed_host_failed") {
        this.set({ ...this.state, phase: "restart-required", error: "github_update_installed_host_failed" });
      } else this.fail(error);
    }
    finally { this.offer = null; await offer.close().catch(() => undefined); }
  }
  async cancelInstall() {
    if (this.state.phase === "installing" && (this.state.installStage === "waiting" || this.state.provider === "github" && this.state.installStage === "downloading")) {
      try { await this.offer?.close(); }
      catch (error) { this.set({ ...this.state, error: githubUpdateError(error) }); }
    }
  }
  async restart() { if (this.state.phase === "installed" || this.state.phase === "restart-required") await this.backend.restart(); }
}
