import { githubUpdateError, type UpdateBackend, type UpdateEvent, type UpdateInfo, type UpdateOffer } from "./update-controller.js";

export type UpdateInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
interface UpdateChannel { onmessage: (event: UpdateEvent) => void }

/** Private release credentials and downloads stay in Rust. JavaScript holds opaque offer IDs. */
export function createDesktopUpdateBackend(options: { invoke: UpdateInvoke; channel: () => UpdateChannel; publicCheck: () => Promise<UpdateOffer | null> }): UpdateBackend {
  let provider: UpdateInfo["provider"];
  return {
    async info() {
      const info = await options.invoke("github_update_info") as UpdateInfo;
      provider = info.provider;
      return info;
    },
    async check() {
      if (provider !== "github") return options.publicCheck();
      const offer = await options.invoke("github_update_check") as { offerId: string; version: string; body?: string } | null;
      if (!offer) return null;
      return {
        version: offer.version, body: offer.body,
        close: async () => { await options.invoke("github_update_close", { offerId: offer.offerId }); },
        downloadAndInstall: async progress => {
          const onEvent = options.channel(); onEvent.onmessage = progress;
          await options.invoke("github_update_install", { offerId: offer.offerId, onEvent });
        },
      };
    },
    restart: async () => { await options.invoke("restart_client"); },
  };
}

export interface GitHubLoginState { phase: "idle" | "starting" | "waiting" | "authorized" | "error"; userCode?: string; error?: string }
interface LoginFlow { flowId: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }
interface LoginClock { schedule(callback: () => void, delay: number): unknown; clear(handle: unknown): void }
const browserClock: LoginClock = { schedule: (callback, delay) => setTimeout(callback, delay), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
const authorizationUrl = "https://github.com/login/device";

/** Each attempt owns its timers and flow. Cancellation fences both late starts and late polls. */
export class GitHubUpdateLoginController {
  private state: GitHubLoginState = { phase: "idle" };
  private generation = 0;
  private flow?: LoginFlow;
  private pollTimer?: unknown;
  private expiryTimer?: unknown;
  private clock: LoginClock;
  private listeners = new Set<() => void>();
  constructor(private options: { invoke: UpdateInvoke; open(url: string): Promise<void>; authorized(): Promise<void>; clock?: LoginClock }) { this.clock = options.clock ?? browserClock; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  private set(state: GitHubLoginState) { this.state = state; this.listeners.forEach(listener => listener()); }
  private detach() {
    this.generation++;
    if (this.pollTimer !== undefined) this.clock.clear(this.pollTimer);
    if (this.expiryTimer !== undefined) this.clock.clear(this.expiryTimer);
    this.pollTimer = this.expiryTimer = undefined;
    const flow = this.flow; this.flow = undefined; return flow;
  }
  private async close(flow: LoginFlow) { await this.options.invoke("github_update_login_cancel", { flowId: flow.flowId }).catch(() => undefined); }
  async cancel() { const flow = this.detach(); this.set({ phase: "idle" }); if (flow) await this.close(flow); }
  async start() {
    const previous = this.detach(), generation = this.generation;
    this.set({ phase: "starting" });
    try {
      if (previous) { await this.close(previous); if (generation !== this.generation) return; }
      const flow = { ...await this.options.invoke("github_update_login_start") as LoginFlow };
      if (generation !== this.generation) { await this.close(flow); return; }
      this.flow = flow;
      if (flow.verificationUri !== authorizationUrl || !flow.flowId || !flow.userCode || !Number.isFinite(flow.expiresIn) || flow.expiresIn <= 0 || !Number.isFinite(flow.interval) || flow.interval <= 0) throw "github_update_configuration";
      this.set({ phase: "waiting", userCode: flow.userCode });
      this.expiryTimer = this.clock.schedule(() => this.fail("github_update_expired", generation), flow.expiresIn * 1000);
      this.schedulePoll(flow.interval, generation);
      await this.openAuthorization();
    } catch (error) { this.fail(error, generation); }
  }
  async openAuthorization() {
    if (this.state.phase !== "waiting") return;
    const generation = this.generation;
    try { await this.options.open(authorizationUrl); if (generation === this.generation && this.state.error) this.set({ ...this.state, error: undefined }); }
    catch { if (generation === this.generation) this.set({ ...this.state, error: "github_update_browser" }); }
  }
  private schedulePoll(interval: number, generation: number) {
    this.pollTimer = this.clock.schedule(() => { this.pollTimer = undefined; void this.poll(generation); }, Math.max(1, interval) * 1000);
  }
  private async poll(generation: number) {
    const flow = this.flow; if (!flow || generation !== this.generation) return;
    try {
      const result = await this.options.invoke("github_update_login_poll", { flowId: flow.flowId }) as { status: "pending" | "authorized"; interval?: number };
      if (generation !== this.generation) return;
      if (result.status === "authorized") {
        this.detach(); this.set({ phase: "authorized" }); await this.options.authorized();
      } else if (result.status === "pending") {
        // GitHub's slow_down response increases the native interval for all later polls.
        if (result.interval !== undefined && Number.isFinite(result.interval)) flow.interval = Math.max(flow.interval, result.interval);
        this.schedulePoll(flow.interval, generation);
      } else this.fail("github_update_failed", generation);
    } catch (error) { this.fail(error, generation); }
  }
  private fail(error: unknown, generation: number) {
    if (generation !== this.generation) return;
    const flow = this.detach(); this.set({ phase: "error", error: githubUpdateError(error) });
    if (flow) void this.close(flow);
  }
}
