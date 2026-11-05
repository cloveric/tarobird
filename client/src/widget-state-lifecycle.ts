import { readWidgetState, saveWidgetState } from "./widget-state.js";

export const WIDGET_STATE_FLUSH_MS = 900;
const MAX_SESSIONS = 64;
export type WidgetStateResult = "saved" | "timeout" | "invalid" | "discarded";
const sessions = new Map<MessageEventSource, WidgetStateSession>();
const retiringOwners = new Map<string, Promise<WidgetStateResult[]>>();
const ownerListeners = new Set<() => void>();
const failures = new Map<string, true>();
const cacheKey = (scope: string, hash: string) => JSON.stringify([scope, hash]);
let listening = false;

export function widgetStateFailed(scope: string | undefined, hash: string | undefined): boolean {
  return !!scope && !!hash && failures.has(cacheKey(scope, hash));
}
function receive(event: MessageEvent) { if (event.source) sessions.get(event.source)?.receive(event.data); }
function syncListener() {
  if (sessions.size && !listening) { window.addEventListener("message", receive); listening = true; }
  else if (!sessions.size && listening) { window.removeEventListener("message", receive); listening = false; }
}

/** A lease keeps only the current opaque frame's state channel alive while its
 * owning React row remains mounted. It grants no composer or Host authority. */
export class WidgetStateSession {
  readonly owner: string;
  readonly scope?: string;
  readonly hash: string;
  private readonly source: Window;
  private readonly key: string;
  private readonly done: (result: WidgetStateResult) => void;
  private request?: { id: string; promise: Promise<WidgetStateResult>; resolve: (result: WidgetStateResult) => void; timer: ReturnType<typeof setTimeout> };
  private closed = false;
  private initialized = false;
  constructor(options: { owner: string; scope?: string; hash: string; source: Window; key: string; done: (result: WidgetStateResult) => void }) {
    if (sessions.size >= MAX_SESSIONS || sessions.has(options.source)) throw new Error("widget_state_session_limit");
    this.owner = options.owner; this.scope = options.scope; this.hash = options.hash;
    this.source = options.source; this.key = options.key; this.done = options.done;
    sessions.set(this.source, this); syncListener();
  }
  get retiring() { return !!this.request || this.closed; }
  get finished() { return this.closed; }
  markInitialized() { this.initialized = true; }
  receive(raw: unknown) {
    if (this.closed || !raw || typeof raw !== "object") return;
    const data = raw as Record<string, unknown>;
    if (data.key !== this.key) return;
    if (data.type === "tarobot-widget-state") {
      if (this.scope && saveWidgetState(this.scope, this.hash, data.state)) failures.delete(cacheKey(this.scope, this.hash));
    } else if (data.type === "tarobot-widget-state-flushed" && this.request && data.id === this.request.id) {
      const valid = data.ok === true && (data.state === undefined || typeof data.state === "string" && (!this.scope || saveWidgetState(this.scope, this.hash, data.state)));
      if (valid && data.state !== undefined && this.scope) failures.delete(cacheKey(this.scope, this.hash));
      this.finish(valid ? "saved" : "invalid");
    }
  }
  retire(): Promise<WidgetStateResult> {
    if (this.request) return this.request.promise;
    if (this.closed) return Promise.resolve("discarded");
    // No document was sent, so there cannot be authored state to lose.
    if (!this.initialized) { this.finish("saved"); return Promise.resolve("saved"); }
    let resolve!: (value: WidgetStateResult) => void;
    const promise = new Promise<WidgetStateResult>(done => { resolve = done; });
    const id = crypto.randomUUID();
    const timer = setTimeout(() => this.finish("timeout"), WIDGET_STATE_FLUSH_MS);
    this.request = { id, promise, resolve, timer };
    try { this.source.postMessage({ type: "tarobot-widget-state-flush", key: this.key, id }, "*"); }
    catch { this.finish("invalid"); }
    return promise;
  }
  discard() { this.finish("discarded"); }
  invalidate() { this.finish("invalid"); }
  private finish(result: WidgetStateResult) {
    if (this.closed) return;
    this.closed = true;
    if (this.request) clearTimeout(this.request.timer);
    sessions.delete(this.source); syncListener();
    if (this.scope) {
      const key = cacheKey(this.scope, this.hash);
      if (result === "timeout" || result === "invalid") {
        failures.delete(key); failures.set(key, true);
        while (failures.size > 64) failures.delete(failures.keys().next().value!);
      }
    }
    try { this.done(result); } finally { this.request?.resolve(result); }
  }
}

export function subscribeWidgetStateOwners(listener: () => void) { ownerListeners.add(listener); return () => { ownerListeners.delete(listener); }; }
export function widgetStateOwnerRetiring(owner: string) { return retiringOwners.has(owner); }
export function hasWidgetStateSessions(owner: string) { return retiringOwners.has(owner) || [...sessions.values()].some(session => session.owner === owner); }
export function flushWidgetStateOwner(owner: string): Promise<WidgetStateResult[]> {
  const previous = retiringOwners.get(owner); if (previous) return previous;
  const owned = [...sessions.values()].filter(session => session.owner === owner);
  if (!owned.length) return Promise.resolve([]);
  let resolve!: (results: WidgetStateResult[]) => void;
  const promise = new Promise<WidgetStateResult[]>(done => { resolve = done; });
  retiringOwners.set(owner, promise); ownerListeners.forEach(listener => listener());
  void Promise.all(owned.map(async session => {
    try { return await session.retire(); }
    catch { try { session.invalidate(); } catch { /* A consumer callback must not trap navigation. */ } return "invalid" as const; }
  })).then(results => {
    retiringOwners.delete(owner); resolve(results);
    // Navigation's continuation runs before external-store consumers are told
    // to restart. Do not eagerly mount an old conversation just before leaving.
    queueMicrotask(() => ownerListeners.forEach(listener => listener()));
  });
  return promise;
}
/** Only App-owned DOM roots provide owner tokens; opaque guests cannot inspect
 * or modify them. The no-widget path stays synchronous for ordinary navigation. */
export function flushWidgetStateWithin(roots: ParentNode[]): Promise<unknown> | undefined {
  const owners = new Set(roots.flatMap(root => [...root.querySelectorAll<HTMLElement>("[data-widget-owner]")].map(node => node.dataset.widgetOwner!)));
  const active = [...owners].filter(hasWidgetStateSessions);
  return active.length ? Promise.all(active.map(flushWidgetStateOwner)) : undefined;
}
/** Logout, revoked identity and owner destruction do not retain old authority. */
export function discardWidgetStateOwner(owner: string) { for (const session of [...sessions.values()]) if (session.owner === owner) session.discard(); }
/** A newly visible copy must not read before an older retiring copy commits. */
export async function restoredWidgetState(scope: string | undefined, hash: string, self: WidgetStateSession): Promise<string | undefined> {
  if (!scope) return;
  await Promise.all([...sessions.values()].filter(session => session !== self && session.scope === scope && session.hash === hash && session.retiring).map(session => session.retire()));
  return readWidgetState(scope, hash);
}
