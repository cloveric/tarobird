import { designOpenSchema, type DesignFormat } from "../../src/client-protocol/workbench-design.js";
import type { HubConnection } from "./connection.js";
import { anySignal, timeoutSignal } from "./abort-signals.js";
import type { WorkbenchCancelFrame, WorkbenchCommandFrame, WorkbenchContext, WorkbenchReceipt, WorkbenchRegistration, WorkbenchTarget } from "../../src/client-protocol/workbench.js";

export type OpenedDesign = { registration: WorkbenchRegistration; target: WorkbenchTarget; revision: number; created: boolean };
type Options = {
  eligible(): boolean;
  open(requestId: string, check: () => void, signal: AbortSignal, format?: DesignFormat): Promise<OpenedDesign>;
};
type Pending = { abort: AbortController; admitted: boolean; epoch: number };
function untilCancelled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("workbench_cancelled"));
    if (signal.aborted) { abort(); void promise.catch(() => undefined); return; }
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A chat-local address, not an editor. Registering this endpoint loads no
 * WorkbenchController, canvas, persisted document or native browser page. */
export class WorkbenchDesignOpener {
  readonly windowId = `design_open_${crypto.randomUUID().replaceAll("-", "")}`;
  readonly generation = crypto.randomUUID();
  private readonly userId: string | undefined;
  private disposed = false;
  private epoch = -1;
  private confirmed = -1;
  private registration?: Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly pending = new Map<string, Pending>();
  private readonly received = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly stops: Array<() => void> = [];
  constructor(private readonly connection: HubConnection, private readonly conversationId: string, private readonly options: Options) {
    this.userId = connection.state.user?.id;
    this.stops.push(connection.subscribe(() => this.sync()), connection.subscribeWorkbench(frame => this.receive(frame)));
    this.sync();
  }
  private available() {
    return !this.disposed && this.options.eligible() && !this.connection.isClosed && !this.connection.isReadOnly
      && this.connection.state.status === "online" && this.connection.state.workbenchDesignOpenAvailable === true
      && !!this.userId && this.connection.state.user?.id === this.userId;
  }
  private target(): WorkbenchTarget { return { deviceId: this.connection.identity.deviceId, windowId: this.windowId }; }
  private snapshot(): WorkbenchRegistration {
    return { windowId: this.windowId, generation: this.generation, conversationId: this.conversationId,
      capabilities: ["design.open.v1", ...(this.connection.state.workbenchSlidesAvailable ? ["design.slides.v1" as const] : [])], tabs: [], visible: true };
  }
  private sync() {
    if (!this.available()) {
      for (const task of this.pending.values()) task.abort.abort();
      this.confirmed = -1; this.epoch = -1; return;
    }
    const epoch = this.connection.sessionEpoch;
    if (this.epoch === epoch) return;
    this.epoch = epoch; this.confirmed = -1;
    const registration = this.register(epoch);
    this.registration = registration;
    // Optional UI metadata must never break ordinary chat or produce an
    // unhandled rejection when an App goes offline during registration.
    void registration.catch(() => undefined);
  }
  private async register(epoch: number) {
    await this.connection.send({ v: 1, type: "workbench.register", registration: this.snapshot() });
    // WS registration and HTTP native input use different transports. Confirm
    // this once per connection epoch, in the background, rather than adding a
    // round trip to every message or assuming send() is a server ACK.
    const signal = anySignal([this.lifetime.signal, timeoutSignal(2000)]);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!this.available() || this.connection.sessionEpoch !== epoch) return;
      const targets = await untilCancelled(this.connection.http<Array<WorkbenchRegistration & {deviceId: string}>>(`/api/conversations/${this.conversationId}/workbench/targets`, { signal }), signal);
      if (!this.available() || this.connection.sessionEpoch !== epoch) return;
      if (targets.some(target => target.deviceId === this.connection.identity.deviceId && target.windowId === this.windowId && target.generation === this.generation && target.capabilities.includes("design.open.v1"))) {
        this.confirmed = epoch; return;
      }
      await new Promise<void>((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(new Error("workbench_cancelled")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 40);
        if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
      });
    }
    throw new Error("workbench_open_unavailable");
  }
  async context(existing?: WorkbenchContext): Promise<WorkbenchContext | undefined> {
    if (!this.available()) return existing;
    this.sync();
    if (!this.registration) this.registration = this.register(this.connection.sessionEpoch);
    try { await this.registration; } catch { this.registration = undefined; return existing; }
    if (!this.available() || this.confirmed !== this.connection.sessionEpoch) return existing;
    const openTarget = this.target();
    return { ...(existing ?? { target: openTarget }), openTarget };
  }
  private receive(frame: WorkbenchCommandFrame | WorkbenchCancelFrame) {
    if (frame.type === "workbench.cancel") { this.pending.get(frame.dispatchId)?.abort.abort(); return; }
    if (frame.request.operation !== "design.open" || frame.target.windowId !== this.windowId) return;
    if (this.received.has(frame.dispatchId)) return;
    this.received.add(frame.dispatchId);
    if (this.received.size > 128) this.received.delete(this.received.values().next().value!);
    const task: Pending = { abort: new AbortController(), admitted: false, epoch: this.connection.sessionEpoch };
    this.pending.set(frame.dispatchId, task);
    const timer = setTimeout(() => task.abort.abort(), Math.max(0, frame.deadline - Date.now()));
    this.queue = this.queue.catch(() => undefined).then(() => this.execute(frame, task)).finally(() => {
      clearTimeout(timer); this.pending.delete(frame.dispatchId);
    });
    void this.queue.catch(() => undefined);
  }
  private async execute(frame: WorkbenchCommandFrame, task: Pending) {
    const receipt = { requestId: frame.request.requestId, target: frame.target };
    const check = () => {
      if (!this.available() || task.abort.signal.aborted || this.connection.sessionEpoch !== task.epoch || Date.now() >= frame.deadline) throw new Error("workbench_cancelled");
      if (frame.userId !== this.userId || frame.conversationId !== this.conversationId || frame.generation !== this.generation || frame.target.deviceId !== this.connection.identity.deviceId || frame.target.tabId) throw new Error("workbench_target_mismatch");
    };
    let result: WorkbenchReceipt;
    try {
      check();
      const {format} = designOpenSchema.parse(frame.request.payload ?? {});
      if (format === "slides" && !this.connection.state.workbenchSlidesAvailable) throw new Error("workbench_slides_host_update_required");
      const admission = await untilCancelled(this.connection.http<{admitted: boolean; generation: string; target: WorkbenchTarget}>("/api/workbench/admit", {
        method: "POST", body: JSON.stringify({ dispatchId: frame.dispatchId }), signal: task.abort.signal,
      }), task.abort.signal);
      check();
      if (!admission.admitted || admission.generation !== frame.generation || JSON.stringify(admission.target) !== JSON.stringify(frame.target)) throw new Error("workbench_admission_changed");
      task.admitted = true;
      const opened = await untilCancelled(this.options.open(frame.request.requestId, check, task.abort.signal, format), task.abort.signal);
      check();
      if (!opened.registration.visible || opened.registration.conversationId !== this.conversationId || opened.target.deviceId !== this.connection.identity.deviceId || opened.target.windowId !== opened.registration.windowId || !opened.registration.tabs.some(tab => tab.id === opened.target.tabId && tab.kind === "design")) throw new Error("workbench_target_mismatch");
      await this.connection.send({ v: 1, type: "workbench.register", registration: opened.registration });
      check();
      result = { ...receipt, status: "applied", saved: true, revision: opened.revision, result: { target: opened.target, created: opened.created } };
    } catch (cause) {
      result = { ...receipt, status: task.admitted ? "unknown" : "not_executed", error: cause instanceof Error ? cause.message.slice(0, 128) : "workbench_open_failed" };
    }
    // Never send a retired session's receipt through a replacement socket.
    if (this.connection.sessionEpoch === task.epoch && this.connection.state.status === "online") {
      try { await this.connection.send({ v: 1, type: "workbench.receipt", dispatchId: frame.dispatchId, receipt: result }); } catch { /* Host retains the unknown outcome. */ }
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.lifetime.abort();
    for (const task of this.pending.values()) task.abort.abort();
    for (const stop of this.stops) stop();
    if (this.epoch >= 0 && this.connection.state.status === "online") void this.connection.send({ v: 1, type: "workbench.unregister", windowId: this.windowId }).catch(() => undefined);
  }
}
