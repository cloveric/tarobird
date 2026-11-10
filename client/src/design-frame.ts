import { designFormatSchema, designFormatTitle } from "../../src/client-protocol/workbench-design.js";
import { exportAttachment } from "./attachment-export.js";
import type { DesignSession } from "./workbench-design-session.js";
import { designEditorLocks } from "./workbench-library.js";
import { designExportPrompt } from "./design-export-prompt.js";

// data: documents have their own opaque origin even with allow-same-origin.
// That flag permits the editor to operate its own nested preview DOM; it does
// not make it same-origin with TaroBird. Never replace this with an App/blob URL.
const loaderURL = () => location.protocol === "tarobot:" ? "tarobot-widget://sandbox/design-loader.html" : new URL("design-loader.html", document.baseURI).href;
const runtimes = new Map<string, Promise<string>>();
const loadRuntime = (format = "canvas") => {
  let runtime = runtimes.get(format);
  if (!runtime) { runtime = fetch(new URL(({canvas:"design",slides:"slides"} as Record<string,string>)[format] + "-sandbox.html", document.baseURI)).then(async response => { if (!response.ok) throw new Error("design_editor_load_failed"); return response.text(); }).catch(error => { runtimes.delete(format); throw error; }); runtimes.set(format, runtime); }
  return runtime;
};
const overlays = () => [...document.querySelectorAll<HTMLElement>('dialog:modal,[aria-modal="true"],[role="menu"],.desktop-menu,[data-workbench-overlay]')].some(node => !node.hidden && node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== "hidden");
const frames = new WeakMap<DesignSession, DesignFrame>();
export function designFrame(session: DesignSession) { let frame = frames.get(session); if (!frame) { frame = new DesignFrame(session); frames.set(session, frame); } return frame; }

/** Keep the editor DOM alive through a React unmount until its save handshake
 * finishes. Its surface is clipped to the workbench placeholder and yields to
 * App menus/dialogs. No detached frame can send chat or invoke native tools. */
class DesignFrame {
  private iframe?: HTMLIFrameElement;
  private port?: MessagePort;
  private placeholder?: HTMLElement;
  private ready = false;
  private revealReady = false;
  private revealed = false;
  private quitPrepared = false;
  private quitLock = false;
  private quitEpoch = 0;
  private generation = 0;
  private unbind?: () => void;
  private unsubscribe?: () => void;
  private unsubscribeEvents?: () => void;
  private releaseLease?: () => void;
  /** Settles once the current lease is actually released (Web Locks release asynchronously). */
  private leaseReleased: Promise<void> = Promise.resolve();
  private observer?: ResizeObserver;
  private mutation?: MutationObserver;
  private themeObserver?: MutationObserver;
  private colorScheme?: MediaQueryList;
  private raf = 0;
  private dark = false;
  private locks = 0;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private exportPrompt?: ReturnType<typeof designExportPrompt>;
  private exportBusy = false;
  private activate: () => void = () => {};
  private pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private report: (error?: string) => void = () => {};
  constructor(private readonly session: DesignSession) {}
  attach(element: HTMLElement, report: (error?: string) => void, activate: () => void) {
    this.placeholder = element; this.report = report; this.activate = activate;
    if (!this.iframe) this.open();
    else this.observePlaceholder();
    this.layout();
    return () => {
      if (this.placeholder !== element) return;
      this.placeholder = undefined; this.observer?.disconnect(); this.layout();
      this.exportPrompt?.cancel(); this.exportPrompt = undefined;
      // A failed flush retains the editor for retry; never pretend it was saved.
      void this.flush().then(() => { if (!this.placeholder) this.destroy(); }, () => {});
    };
  }
  private observePlaceholder() {
    this.observer?.disconnect();
    if (!this.placeholder) return;
    this.observer = new ResizeObserver(this.layout); this.observer.observe(this.placeholder);
  }
  private updateTheme = () => {
    const dark = document.documentElement.dataset.theme === "dark" || getComputedStyle(document.documentElement).colorScheme === "dark";
    if (dark === this.dark) return;
    this.dark = dark;
    if (this.port) this.iframe?.contentWindow?.postMessage({ type: "tarobot-design-theme", dark }, "*");
  };
  private beforeUnload = (event: BeforeUnloadEvent) => {
    // A cross-origin dirty notification cannot be guaranteed to arrive before
    // a close. Only the native pre-quit flush, with input locked, grants exit.
    // Direct browser/OS unload retains a conservative confirmation instead.
    if (this.quitPrepared) return;
    void this.flush().catch(() => {});
    event.preventDefault(); event.returnValue = "";
  };
  private quit = (event: Event) => {
    const detail = (event as CustomEvent<{ pending: Promise<boolean>[]; cancel?: boolean }>).detail;
    if (!detail || !Array.isArray(detail.pending)) return;
    if (detail.cancel) { this.quitEpoch++; this.quitLock = this.quitPrepared = false; this.layout(); return; }
    // Reuse only this still-locked editor's confirmed save. Another editor or
    // a cancelled quit must prepare again, even after an App bundle replacement.
    if (this.quitPrepared && this.quitLock) { detail.pending.push(Promise.resolve(true)); return; }
    const epoch = ++this.quitEpoch, generation = this.generation;
    this.quitLock = true; this.quitPrepared = false;
    if (this.iframe) this.iframe.inert = true;
    this.layout();
    detail.pending.push(this.session.flush().then(() => {
      if (epoch !== this.quitEpoch || generation !== this.generation) return false;
      this.quitPrepared = true; return true;
    }, () => {
      if (epoch === this.quitEpoch) { this.quitLock = false; this.layout(); }
      return false;
    }));
  };
  private open() {
    const format = designFormatSchema.safeParse(this.session.document.format ?? "canvas");
    if (!format.success) { this.report("design_format_unavailable"); return; }
    const frame = document.createElement("iframe"); this.iframe = frame; const generation = ++this.generation;
    this.updateTheme();
    this.themeObserver = new MutationObserver(this.updateTheme);
    // Pane drags write root CSS variables every frame; they do not change the
    // appearance. Observe theme inputs without forcing style reads on drags.
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "class"] });
    this.colorScheme = matchMedia("(prefers-color-scheme: dark)"); this.colorScheme.addEventListener("change", this.updateTheme);
    // A Bot update recreates the frame without remounting the React surface.
    this.observePlaceholder();
    frame.title = designFormatTitle(format.data); frame.className = "workbench-design-frame"; frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    frame.referrerPolicy = "no-referrer"; frame.allow = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen *"; frame.allowFullscreen = true;
    frame.style.cssText = "position:fixed;z-index:11;border:0;display:none;";
    const lock = () => {
      if (this.quitLock) throw new Error("design_closing");
      this.locks++; this.layout(); if (this.iframe) this.iframe.inert = true;
      return () => { this.locks = Math.max(0, this.locks - 1); this.layout(); };
    };
    this.unbind = this.session.bindEditor({ flush: () => this.flush(), reload: () => this.reload(), retire: () => this.retire(), discard: () => this.destroy(), lock,
      // A deletion check: release this frame's shared lease while it stays inert;
      // restoring re-acquires it for the same live frame (never after destroy).
      suspend: async () => {
        const unlock = lock(), generation = this.generation, released = this.leaseReleased; this.releaseLease?.(); this.releaseLease = undefined;
        await released;
        return async () => { try { if (this.generation === generation && this.iframe) await this.lease(); } finally { unlock(); } };
      } });
    this.readyTimer = setTimeout(() => { if (this.iframe === frame && !this.ready) this.report("design_editor_load_failed"); }, 20000);
    addEventListener("message", this.message); addEventListener("beforeunload", this.beforeUnload); addEventListener("tarobot:design-quit", this.quit); addEventListener("resize", this.layout); document.addEventListener("scroll", this.layout, true); document.addEventListener("visibilitychange", this.layout);
    this.mutation = new MutationObserver(this.layout); this.mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "hidden", "class", "aria-modal"] });
    // The editor loads, and so can write, only while holding its design's shared
    // lock and after confirming the stored document: a device-library deletion
    // takes that lock exclusively and never races an editor still loading.
    void Promise.all([loadRuntime(this.session.document.format), this.lease()]).then(async () => {
      if (this.iframe !== frame || this.generation !== generation) return;
      await this.session.refresh();
      if (this.iframe !== frame || this.generation !== generation) return;
      frame.src = loaderURL(); document.body.appendChild(frame); this.layout();
    }).catch(error => { if (this.iframe === frame) this.report(error instanceof Error && error.message === "design_not_found" ? "design_not_found" : "design_editor_load_failed"); });
  }
  private message = (event: MessageEvent) => {
    if (event.source !== this.iframe?.contentWindow || event.origin !== "null") return;
    const frame = this.iframe, value = event.data;
    // Canvas waits for its host's reveal acknowledgement before displaying
    // the artboard. Without it, every open waits for the upstream fallback.
    // Readiness is not visibility: menus, backgrounding and a retired surface
    // must still prevent this frame from being revealed.
    if (value?.__frame_reveal_ready === true && (this.session.document.format ?? "canvas") === "canvas") {
      this.revealReady = true; this.layout(); return;
    }
    if (value?.type === "tarobot-design-bootstrap") {
      void loadRuntime(this.session.document.format).then(html => { if (this.iframe === frame) frame?.contentWindow?.postMessage({ type: "tarobot-design-html", html }, "*"); }); return;
    }
    if (value?.type === "tarobot-design-ready" && !this.port) {
      const channel = new MessageChannel(), generation = this.generation; this.port = channel.port1;
      let count = 0;
      channel.port1.onmessage = ({ data }) => {
        if (this.generation !== generation || !Number.isSafeInteger(data?.id) || typeof data?.operation !== "string") return;
        if (count >= 32) { channel.port1.postMessage({ id: data.id, error: "design_busy" }); return; }
        count++;
        void this.session.request(data.operation, data.payload).then(result => { if (generation === this.generation) channel.port1.postMessage({ id: data.id, result }); }, () => { if (generation === this.generation) channel.port1.postMessage({ id: data.id, error: "design_save_failed" }); }).finally(() => { count--; });
      };
      this.unsubscribeEvents = this.session.onEvent(event=>{if(this.generation===generation)channel.port1.postMessage({type:"design-event",event});});
      let revision = this.session.document.revision;
      this.unsubscribe = this.session.subscribe(()=>{ if(generation===this.generation && revision!==this.session.document.revision) {revision=this.session.document.revision;channel.port1.postMessage({type:"document-changed",revision});} });
      frame!.contentWindow!.postMessage({ type: "tarobot-design-init", dark: this.dark }, "*", [channel.port2]); return;
    }
    if (value?.type === "tarobot-design-error") { clearTimeout(this.readyTimer); this.report("design_editor_load_failed"); return; }
    if (value?.type === "editor:ready") { this.ready = true; clearTimeout(this.readyTimer); this.report(undefined); return; }
    if (value?.type === "tarobot-design-focus" && this.interactive()) {
      this.activate(); return;
    }
    if (value?.type === "editor:flushed" && typeof value.requestId === "string") {
      const task = this.pending.get(value.requestId); if (!task) return; this.pending.delete(value.requestId); clearTimeout(task.timer);
      value.saved === true ? task.resolve() : task.reject(new Error("design_not_saved")); return;
    }
    if (value?.type === "editor:save-file") {
      const id = value.requestId;
      // A design is executable content. It may request a download only while
      // the user is actually interacting, never on load or from a Bot write.
      if (!this.interactive() || this.exportBusy) { frame!.contentWindow?.postMessage({ type: "editor:save-file-result", requestId: id, outcome: "declined" }, "*"); return; }
      if (typeof id !== "string" || id.length > 100 || typeof value.filename !== "string" || value.filename.length > 256 || !(value.data instanceof Blob || value.data instanceof ArrayBuffer || ArrayBuffer.isView(value.data))) return;
      const blob = value.data instanceof Blob ? value.data : new Blob([value.data]);
      if (blob.size > 64 * 1024 * 1024) { frame!.contentWindow?.postMessage({ type: "editor:save-file-result", requestId: id, outcome: "failed" }, "*"); return; }
      const name = value.filename.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
      this.exportBusy = true;
      const generation = this.generation;
      const save = () => generation === this.generation && !!this.placeholder && !this.locks && !this.quitLock ? exportAttachment(blob, name) : Promise.resolve(false);
      const prompt = navigator.userActivation?.isActive ? undefined : designExportPrompt(name, save);
      this.exportPrompt = prompt;
      void (prompt?.result ?? save()).then(saved => { if (frame === this.iframe) frame!.contentWindow?.postMessage({ type: "editor:save-file-result", requestId: id, outcome: saved ? "saved" : "declined" }, "*"); }, () => { if (frame === this.iframe) frame!.contentWindow?.postMessage({ type: "editor:save-file-result", requestId: id, outcome: "failed" }, "*"); }).finally(() => {
        if (generation === this.generation) { this.exportBusy = false; if (this.exportPrompt === prompt) this.exportPrompt = undefined; }
      });
    }
    // The upstream agent/comment bridge is deliberately not given permission
    // to send tasks. The user writes in the regular conversation composer.
    if (value?.type === "editor:suggest-prompt") frame!.contentWindow?.postMessage({ type: "editor:suggest-prompt-result", requestId: value.requestId, ok: false }, "*");
    if (value?.type === "editor:compose") frame!.contentWindow?.postMessage({ type: "editor:compose-result", requestId: value.requestId, opened: false }, "*");
  };
  private interactive() {
    const element = this.placeholder, rect = element?.getBoundingClientRect();
    return !!(element?.isConnected && rect && rect.width > 0 && rect.height > 0 && !element.closest("[hidden]") && !document.hidden && !overlays() && !this.locks && !this.quitLock);
  }
  private layout = () => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0; if (!this.iframe) return;
      const element = this.placeholder, rect = element?.getBoundingClientRect();
      const visible = element?.isConnected && rect && rect.width > 0 && rect.height > 0 && !element.closest("[hidden]") && !document.hidden && !overlays();
      this.iframe.style.display = visible ? "block" : "none";
      this.iframe.inert = !visible || this.locks > 0 || this.quitLock;
      if (visible) {
        // The editor lives under body so it can finish saving after unmount.
        // Follow the actual Workbench surface (phone is above desktop), rather
        // than placing the portal behind its opaque background. Menus/dialogs
        // still hide it above; its bounds never include the title or footer.
        const surface = element.closest(".workbench") ?? element;
        const zIndex = Math.max(11, (Number.parseInt(getComputedStyle(surface).zIndex, 10) || 0) + 1);
        Object.assign(this.iframe.style, { zIndex: String(zIndex), left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        if (this.revealReady && !this.revealed && !this.iframe.inert && this.iframe.contentWindow) {
          this.revealed = true;
          this.iframe.contentWindow.postMessage({ __frame_revealed: true }, "*");
        }
      }
    });
  };
  async flush(): Promise<void> {
    if (!this.iframe || !this.ready) return;
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); this.report("design_not_saved"); reject(new Error("design_not_saved")); }, 10000);
      this.pending.set(requestId, { resolve, reject, timer }); this.iframe!.contentWindow!.postMessage({ type: "editor:flush", requestId }, "*");
    });
  }
  /** Resolves once this frame holds the shared editor lock; destroy releases it,
   * including a request still waiting to be granted. */
  private lease(): Promise<void> {
    const name = designEditorLocks.get(this.session);
    if (!name || typeof navigator === "undefined" || !navigator.locks) return Promise.resolve();
    this.releaseLease?.();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    this.releaseLease = release;
    return new Promise((resolve, reject) => {
      const request = navigator.locks.request(name, { mode: "shared" }, () => { resolve(); return held; });
      this.leaseReleased = request.then(() => undefined, () => undefined); request.catch(reject);
    });
  }
  async reload() { await this.flush(); const placeholder = this.placeholder; this.destroy(); this.placeholder = placeholder; if (placeholder) this.open(); }
  async retire() { this.placeholder = undefined; this.layout(); await this.flush(); this.destroy(); }
  private destroy() {
    this.exportPrompt?.cancel(); this.exportPrompt = undefined; this.exportBusy = false;
    this.generation++; this.ready = this.revealReady = this.revealed = false; this.quitEpoch++; this.quitLock = this.quitPrepared = false; clearTimeout(this.readyTimer); this.port?.close(); this.port = undefined;
    this.unsubscribe?.(); this.unsubscribe=undefined; this.unsubscribeEvents?.(); this.unsubscribeEvents=undefined;
    this.iframe?.remove(); this.iframe = undefined; this.unbind?.(); this.unbind = undefined;
    this.mutation?.disconnect(); this.observer?.disconnect(); cancelAnimationFrame(this.raf); this.raf = 0;
    this.themeObserver?.disconnect(); this.colorScheme?.removeEventListener("change", this.updateTheme); this.colorScheme = undefined;
    removeEventListener("message", this.message); removeEventListener("beforeunload", this.beforeUnload); removeEventListener("tarobot:design-quit", this.quit); removeEventListener("resize", this.layout); document.removeEventListener("scroll", this.layout, true); document.removeEventListener("visibilitychange", this.layout);
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error("design_editor_closed")); } this.pending.clear();
    // Callers flush before destroying, except when discarding deleted content.
    this.releaseLease?.(); this.releaseLease = undefined;
  }
}
