import { githubUpdateError } from "./update-controller.js";
import type { UpdateInvoke } from "./github-update-backend.js";

export interface AndroidUpdateState {
  phase: "initial" | "disabled" | "login-required" | "checking" | "current" | "available" | "downloading" | "verifying" | "ready" | "install-pending" | "error";
  configured?: boolean; version?: string; authenticated?: boolean; login?: string;
  nextVersion?: string; notes?: string; bytes?: number; total?: number; downloaded?: boolean; error?: string;
}
export interface AndroidUpdateBridge {
  status(): Promise<AndroidUpdateState>;
  invoke(options: { command: string; flowId?: string }): Promise<unknown>;
  cancel(): Promise<void>;
  openLogin(): Promise<void>;
  addListener(event: "state", callback: (state: AndroidUpdateState) => void): Promise<{ remove(): Promise<void> }>;
}
/** Native owns transfer/install state, including navigation out of Settings.
 * Opening the system installer is pending, never an installed-success state. */
export class AndroidUpdateController {
  private state: AndroidUpdateState = { phase: "initial" };
  private listeners = new Set<() => void>();
  private pending?: Promise<void>;
  constructor(readonly bridge: AndroidUpdateBridge) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  receive = (state: AndroidUpdateState) => { this.state = { ...state, ...(state.error ? { error: githubUpdateError(state.error) } : {}) }; this.listeners.forEach(listener => listener()); };
  private fail(error: unknown) { const code = githubUpdateError(error); this.receive({ ...this.state, phase: "error", error: code, ...(code === "github_update_login_required" ? { authenticated: false, login: undefined } : {}) }); }
  readonly invoke: UpdateInvoke = (command, args) => this.bridge.invoke({ command, ...(typeof args?.flowId === "string" ? { flowId: args.flowId } : {}) });
  async refresh() { try { this.receive(await this.bridge.status()); } catch (error) { this.fail(error); } }
  private run(work: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = work().catch(error => this.fail(error)).finally(() => { this.pending = undefined; }); return this.pending;
  }
  check() { return this.run(async () => { this.receive({ ...this.state, phase: "checking", error: undefined }); this.receive(await this.invoke("check") as AndroidUpdateState); }); }
  install() {
    if (!this.state.nextVersion || !["available", "ready", "error"].includes(this.state.phase)) return Promise.resolve();
    return this.run(async () => {
      if (!this.state.downloaded) {
        this.receive({ ...this.state, phase: "downloading", error: undefined, bytes: 0 });
        this.receive(await this.invoke("download") as AndroidUpdateState);
      }
      if (!this.state.downloaded || this.state.phase !== "ready" && this.state.phase !== "error") return;
      this.receive({ ...this.state, phase: "install-pending", error: undefined });
      this.receive(await this.invoke("install") as AndroidUpdateState);
    });
  }
  async cancel() { try { await this.bridge.cancel(); } catch (error) { this.fail(error); } }
  logout() { return this.run(async () => { await this.invoke("github_update_logout"); await this.refresh(); }); }
}
