import { PERSONAL_BROWSER_SCOPE } from "../shared/personal-browser.mjs";
import { BrowserUserClient, scheduleBrowserLayout, type BrowserEvent, type BrowserReceipt, type BrowserTabState } from "./workbench-browser.js";
import { readBrowserDevicePreview } from "./workbench-browser-tools.js";

type Snapshot = { ready: boolean; busy: boolean; tabs: BrowserTabState[]; active?: string; error?: string };
const activeKey = "tarobot.personal-browser.active";
const code = (cause: unknown) => cause instanceof Error ? cause.message : "browser_action_failed";

/** No Hub connection, conversation registration or Bot-command subscriber.
 * Native pages survive a dock/mode change; the App document owns their lifetime. */
export class PersonalBrowserController {
  private snapshot: Snapshot = { ready: false, busy: false, tabs: [] };
  private listeners = new Set<() => void>();
  private removeListener?: () => void;
  private disposed = false;
  private initializing?: Promise<void>;
  private queue = Promise.resolve();
  private events: BrowserEvent[] = [];
  private opening = new Set<string>();
  constructor(readonly browser = new BrowserUserClient(PERSONAL_BROWSER_SCOPE)) {}
  get isVisible() { return !this.disposed; }
  getSnapshot = () => this.snapshot;
  subscribe = (receive: () => void) => { this.listeners.add(receive); return () => { this.listeners.delete(receive); }; };
  private publish(patch: Partial<Snapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const receive of this.listeners) receive();
    scheduleBrowserLayout();
  }
  setError = (error?: string) => this.publish({ error });
  private accepted(result: BrowserReceipt) { if (result.status !== "ok") throw new Error(result.error ?? "browser_action_failed"); return result; }
  initialize(): Promise<void> {
    return this.initializing ??= this.initializeNow().catch(error => {
      this.removeListener?.(); this.removeListener = undefined; this.events = [];
      this.initializing = undefined; this.setError(code(error)); throw error;
    });
  }
  private async initializeNow() {
    this.accepted(await this.browser.command("capabilities", undefined));
    if (this.disposed) return;
    const stop = await this.browser.subscribe(event => {
      if (!event.scope || event.scope.host !== PERSONAL_BROWSER_SCOPE.host) return;
      if (!this.snapshot.ready) { if (this.events.length < 1024) this.events.push(event); return; }
      this.onEvent(event);
    });
    if (this.disposed) { stop(); return; }
    this.removeListener = stop;
    const result = this.accepted(await this.browser.command("list", undefined));
    if (this.disposed) return;
    const tabs = (Array.isArray(result.tabs) ? result.tabs : []).filter((tab): tab is BrowserTabState => !!tab && typeof tab === "object" && typeof tab.tab === "string").slice(0, 64);
    let previous: string | null = null; try { previous = sessionStorage.getItem(activeKey); } catch { /* optional view preference */ }
    this.publish({ ready: true, tabs: [], error: undefined });
    for (const tab of tabs) this.onEvent({ ...tab, kind: "state" }, true);
    for (const event of this.events) this.onEvent(event); this.events = [];
    this.select(this.snapshot.tabs.some(tab => tab.tab === previous) ? previous! : this.snapshot.tabs[0]?.tab);
    if (!this.snapshot.tabs.length && !this.disposed) await this.openBrowser().catch(error => this.setError(code(error)));
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      if (this.disposed) throw new Error("native_document_retired");
      this.publish({ busy: true, error: undefined });
      try { return await run(); } finally { this.publish({ busy: false }); }
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
  openBrowser = (url = "about:blank") => this.serial(async () => {
    const tab = crypto.randomUUID();
    this.opening.add(tab);
    try {
      const result = await this.browser.command("open", tab, { url });
      if (this.disposed) { await this.browser.command("close", tab, { force: true }).catch(() => {}); return; }
      // A failed navigation/live limit can still leave a real native page or
      // sleeping record. Keep it reachable for reload/close before reporting.
      if (result.status === "ok" || result.state === "live" || result.state === "sleeping") {
        this.onEvent({ ...result, tab, kind: "state" }, true); this.select(tab);
      }
      this.accepted(result);
    } finally { this.opening.delete(tab); }
  });
  close = (id: string) => this.serial(async () => {
    const result = await this.browser.command("close", id);
    if (result.error !== "tab_not_found") this.accepted(result);
    this.onEvent({ kind: "closed", tab: id });
  });
  select = (id?: string) => {
    if (id && !this.snapshot.tabs.some(tab => tab.tab === id)) return;
    this.publish({ active: id });
    try { if (id) sessionStorage.setItem(activeKey, id); else sessionStorage.removeItem(activeKey); } catch { /* optional view preference */ }
  };
  private onEvent(event: BrowserEvent, admitted = false) {
    if (this.disposed || !event.tab) return;
    const index = this.snapshot.tabs.findIndex(tab => tab.tab === event.tab);
    if (event.kind === "closed") {
      const tabs = this.snapshot.tabs.filter(tab => tab.tab !== event.tab);
      this.publish({ tabs });
      if (this.snapshot.active === event.tab) this.select(tabs[Math.min(Math.max(0, index), tabs.length - 1)]?.tab);
      return;
    }
    if (index < 0 && !admitted && !this.opening.has(event.tab) && !(event.kind === "opened" && (this.snapshot.tabs.some(tab => tab.tab === event.opener) || typeof event.opener === "string" && this.opening.has(event.opener)))) return;
    if (index < 0 && this.snapshot.tabs.length >= 64) return;
    const previous = this.snapshot.tabs[index], state: BrowserTabState = { ...previous, tab: event.tab };
    if (event.kind === "state" || event.kind === "opened") {
      for (const name of ["url", "title"] as const) if (typeof event[name] === "string") state[name] = event[name];
      for (const name of ["loading", "canGoBack", "canGoForward"] as const) if (typeof event[name] === "boolean") state[name] = event[name];
      if (typeof event.navigation === "number") state.navigation = event.navigation;
      if (typeof event.zoomFactor === "number") state.zoomFactor = event.zoomFactor;
      if (event.devicePreview) state.devicePreview = readBrowserDevicePreview(event.devicePreview);
      if (typeof event.state === "string") state.sleeping = event.state === "sleeping";
      if (event.crashed === true) state.error = "page_unavailable";
      else if (event.responsive === true || event.crashed === false) { state.error = undefined; state.notice = undefined; }
    } else if (event.kind === "sleep") state.sleeping = true;
    else if (event.kind === "fullscreen") state.fullscreen = event.enabled === true;
    else if (event.kind === "popup") state.popup = event.state === "opened";
    else if (event.kind === "tab-request" && typeof event.url === "string") state.requestedUrl = event.url;
    else if (event.kind === "gone") state.error = String(event.reason ?? "page_unavailable");
    else if (event.kind === "blocked" && event.what === "navigation") state.notice = String(event.reason ?? "unsupported_scheme");
    const tabs = [...this.snapshot.tabs]; if (index < 0) tabs.push(state); else tabs[index] = state;
    this.publish({ tabs });
    if (event.kind === "opened" || !this.snapshot.active) this.select(event.tab);
  }
  dispose() { this.disposed = true; this.removeListener?.(); this.removeListener = undefined; this.events = []; this.listeners.clear(); }
}

// One personal workspace per App document. React mounts (including effect
// replay) only attach UI; mode changes must not retire its native pages.
let personalBrowser: PersonalBrowserController | undefined;
export function getPersonalBrowserController(): PersonalBrowserController {
  return personalBrowser ??= new PersonalBrowserController();
}
