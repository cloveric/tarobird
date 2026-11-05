import { decodeBase64 } from "../../src/client-protocol/base64.js";
import { MAX_BROWSER_SURFACES, PERSONAL_BROWSER_SCOPE } from "../shared/personal-browser.mjs";
import { browserSearchURL, type BrowserSearchEngine, type BrowserDevicePreview } from "./workbench-browser-tools.js";
import { invoke, isElectron, listen } from "./desktop-bridge.js";
import { encodeDesktopBytes } from "./desktop-base64.js";
import type { HubConnection } from "./connection.js";
import { uploadFile } from "./files.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type BrowserScope = { host: string; user: string; conversation: string };
export type BrowserTabState = { zoomFactor?: number; devicePreview?: BrowserDevicePreview; tab: string; url?: string; title?: string; loading?: boolean; canGoBack?: boolean; canGoForward?: boolean; navigation?: number; sleeping?: boolean; takeover?: boolean; activity?: string; fullscreen?: boolean; popup?: boolean; requestedUrl?: string; notice?: string; error?: string };
export type BrowserReceipt = { status: "ok" | "failed" | "cancelled" | "unknown" | "paused" | "needs_user"; action?: string; window?: string; tab?: string; error?: string; url?: string; title?: string; navigation?: number; image?: { mime: string; data: string; width: number; height: number }; [key: string]: unknown };
export type BrowserEvent = { kind: string; tab?: string; scope?: BrowserScope; [key: string]: unknown };
export class BrowserDispatchRejected extends Error {}
const rejectedBeforeDispatch = new Set(["invalid_browser_args", "browser_request_id_required", "browser_user_action_required", "unsupported_action", "native_bridge_unavailable", "unknown_native_command", "unknown_desktop_command"]);
export type PreparedBrowserAction = { action: string; fields: Record<string, unknown> };
const actionFields: Record<string, readonly string[]> = {
  capabilities: [], list: [], open: ["url", "title", "restore"], navigate: ["url"], back: [], forward: [], reload: [], stop: [],
  observe: ["mode", "maxText", "maxElements"], selection: [], screenshot: ["maxWidth"], click: ["ref", "point", "snapshot"],
  type: ["ref", "text", "mode"], press: ["key", "modifiers"], scroll: ["ref", "direction", "amount", "to"], select: ["ref", "values", "labels"],
  cancel: [], takeover: [], close: [], sleep: [], wake: [], reveal: [], downloads: [],
  download_cancel: ["download"], upload: ["ref", "attachmentIds"],
};
/** The model cannot replace the authenticated App scope, page target or actor. */
export function browserPayload(input: unknown): { action: string; fields: Record<string, unknown> } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_browser_args");
  const raw = input as Record<string, unknown>, action = raw.action;
  if (typeof action !== "string" || !Object.hasOwn(actionFields, action)) throw new Error("unsupported_action");
  const permitted = new Set(["action", "navigation", ...actionFields[action]]);
  if (Object.keys(raw).some(key => !permitted.has(key))) throw new Error("invalid_browser_args");
  const { action: _action, ...fields } = raw;
  return { action, fields };
}
export function browserAddress(value: string, searchEngine: BrowserSearchEngine = "google"): string {
  const trimmed = value.trim();
  if (!trimmed) return "about:blank";
  if (trimmed === "about:blank") return trimmed;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    const url = new URL(trimmed); if (!["https:", "http:"].includes(url.protocol)) throw new Error("unsupported_scheme"); return url.href;
  }
  if (!/\s/.test(trimmed) && /^(localhost(?::\d+)?|[^/]+\.[^/]+)(\/.*)?$/.test(trimmed)) return new URL(`https://${trimmed}`).href;
  return browserSearchURL(trimmed, searchEngine);
}

// One native layout belongs to the whole window, even when several conversation
// panes have mounted workbenches. A single sequencer cannot be reset by a Tab.
let layoutSequence = 0, layoutFrame = 0, nativeSurfaceLimit = MAX_BROWSER_SURFACES;
let lastLayout: string | undefined;
const surfaces = new Map<string, { node: HTMLElement; visible: () => boolean }>();
let mutationObserver: MutationObserver | undefined, resizeObserver: ResizeObserver | undefined;
function obscured(): boolean {
  return [...document.querySelectorAll<HTMLElement>('dialog:modal, [aria-modal="true"], [role="menu"], .desktop-menu, [data-workbench-overlay], .agent-bus-dock')]
    .some(node => {
      const style = getComputedStyle(node);
      // The Bus is a sibling column on wide windows, an overlay on narrow
      // ADHD layouts. Native pages must yield only to its overlay form.
      if (node.matches(".agent-bus-dock")) return !node.hidden && node.getBoundingClientRect().width > 0
        && (style.position === "absolute" || style.position === "fixed")
        && (node.classList.contains("is-open") || style.visibility !== "hidden");
      return !node.hidden && node.getBoundingClientRect().width > 0 && style.visibility !== "hidden";
    });
}
function overlayTransition(event: Event): void {
  if (event.target instanceof Element && event.target.matches(".agent-bus-dock, .adhd-browser-dock")) scheduleBrowserLayout();
}
export function scheduleBrowserLayout(): void {
  if (!isElectron() || layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    const views = [...surfaces].filter(([, value]) => value.visible() && value.node.isConnected
      // Native views cannot inherit the App surface's CSS transform/opacity.
      // Reveal them at the settled bounds when the shared entry animation ends.
      && !value.node.closest(".workbench, .adhd-browser-dock")?.getAnimations().some(animation => animation.playState === "running")).sort(([a, x], [b, y]) => Number(!!y.node.closest(".adhd-browser-dock")) - Number(!!x.node.closest(".adhd-browser-dock")) || a.localeCompare(b)).map(([tab, { node }]) => {
      const { x, y, width, height } = node.getBoundingClientRect(); return { tab, x, y, width, height };
    }).filter(view => view.width > 0 && view.height > 0).slice(0, nativeSurfaceLimit);
    const layout = { views, hidden: document.hidden || obscured() }, key = JSON.stringify([window.devicePixelRatio, layout]);
    if (key === lastLayout) return;
    lastLayout = key; const seq = ++layoutSequence;
    // Chat streaming and editor DOM updates often leave native geometry alone.
    // Keep the sequence fence, and permit retry if the latest dispatch failed.
    void invoke("workbench_browser_layout", { seq, ...layout }).catch(() => { if (seq === layoutSequence) lastLayout = undefined; });
  });
}
export function registerBrowserSurface(tab: string, node: HTMLElement, visible: () => boolean): () => void {
  lastLayout = undefined;
  surfaces.set(tab, { node, visible });
  resizeObserver ??= new ResizeObserver(scheduleBrowserLayout); resizeObserver.observe(node);
  if (!mutationObserver) {
    mutationObserver = new MutationObserver(scheduleBrowserLayout);
    mutationObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "hidden", "class", "style", "aria-modal"] });
    window.addEventListener("resize", scheduleBrowserLayout); document.addEventListener("scroll", scheduleBrowserLayout, true);
    document.addEventListener("visibilitychange", scheduleBrowserLayout);
    document.addEventListener("transitionend", overlayTransition, true);
    document.addEventListener("transitioncancel", overlayTransition, true);
  }
  scheduleBrowserLayout();
  return () => {
    if (surfaces.get(tab)?.node === node) surfaces.delete(tab); resizeObserver?.unobserve(node); scheduleBrowserLayout();
    if (!surfaces.size) {
      mutationObserver?.disconnect(); mutationObserver = undefined; resizeObserver?.disconnect(); resizeObserver = undefined;
      window.removeEventListener("resize", scheduleBrowserLayout); document.removeEventListener("scroll", scheduleBrowserLayout, true);
      document.removeEventListener("visibilitychange", scheduleBrowserLayout);
      document.removeEventListener("transitionend", overlayTransition, true);
      document.removeEventListener("transitioncancel", overlayTransition, true);
    }
  };
}

export class BrowserUserClient {
  readonly supported = isElectron();
  private actions = new Set<string>();
  supports(action: string): boolean { return this.actions.has(action); }
  constructor(readonly scope: BrowserScope) {}
  async command(action: string, tab: string | undefined, fields: Record<string, unknown> = {}, requestId: string = crypto.randomUUID(), source: "user" | "bot" = "user"): Promise<BrowserReceipt> {
    if (!this.supported) throw new Error("workbench_browser_requires_desktop");
    const result = await invoke<BrowserReceipt>("workbench_browser", { ...fields, action, ...(tab ? { tab } : {}), requestId, source, scope: this.scope });
    if (action === "capabilities" && result.status === "ok") this.actions = new Set(Array.isArray(result.actions) ? result.actions.filter((item): item is string => typeof item === "string") : []);
    if (action === "capabilities" && result.status === "ok") {
      const limit = (result.limits as {visible?:unknown} | undefined)?.visible;
      if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) nativeSurfaceLimit = Math.min(MAX_BROWSER_SURFACES, limit);
    }
    return result;
  }
  async subscribe(receive: (event: BrowserEvent) => void): Promise<() => void> {
    if (!this.supported) return () => undefined;
    return listen<BrowserEvent>("workbench-browser", event => {
      if (event.payload.scope && JSON.stringify(event.payload.scope) !== JSON.stringify(this.scope)) return;
      receive(event.payload);
    });
  }
}

export class WorkbenchBrowserClient extends BrowserUserClient {
  constructor(scope: BrowserScope, private readonly connection: HubConnection) { super(scope); if (scope.host === PERSONAL_BROWSER_SCOPE.host) throw new Error("browser_user_action_required"); }
  /** Download and stage bytes before Host's one-shot admission. No webpage
   * receives files until execute() runs after that final admission. */
  async prepare(input: unknown, requestId: string, signal: AbortSignal): Promise<PreparedBrowserAction> {
    const { action, fields } = browserPayload(input);
    if (signal.aborted) throw new Error("workbench_cancelled");
    if (action === "upload") {
      const ids = fields.attachmentIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || ids.some(id => typeof id !== "string" || !/^att_[A-Za-z0-9_-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error("invalid_browser_upload");
      const files: string[] = []; let total = 0;
      const key = bytesToHex(sha256(new TextEncoder().encode(requestId)));
      for (let index = 0; index < ids.length; index++) {
        const blob = await this.connection.blob(ids[index], { signal }); total += blob.size;
        if (total > 25 * 1024 * 1024) throw new Error("upload_too_large");
        // The Host authorizes these attachment IDs against this command's
        // conversation/user and the source user message or its explicit quote.
        // The renderer never accepts filesystem paths.
        const begin = await this.command("upload_begin", undefined, { name: `attachment-${index + 1}${blob.type === "image/png" ? ".png" : blob.type === "image/jpeg" ? ".jpg" : ".bin"}`, mime: blob.type, size: blob.size }, `${key}-begin-${index}`, "bot");
        const upload = typeof begin.upload === "string" ? begin.upload : (begin.evidence as { upload?: string } | undefined)?.upload;
        if (begin.status !== "ok" || !upload) throw new Error(begin.error ?? "browser_upload_failed");
        for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
          if (signal.aborted) throw new Error("workbench_cancelled");
          const data = encodeDesktopBytes(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
          const written = await this.command("upload_write", undefined, { upload, data }, `${key}-part-${index}-${offset}`, "bot");
          if (written.status !== "ok") throw new Error(written.error ?? "browser_upload_failed");
        }
        files.push(upload);
      }
      return { action, fields: { ref: fields.ref, files } };
    }
    return { action, fields };
  }
  async execute(tab: string | undefined, prepared: PreparedBrowserAction, requestId: string, signal: AbortSignal): Promise<BrowserReceipt> {
    const { action, fields } = prepared;
    if (signal.aborted) throw new Error("workbench_cancelled");
    let result: BrowserReceipt;
    try { result = await this.command(action, tab, fields, requestId, "bot"); }
    catch (error) { if (error instanceof Error && rejectedBeforeDispatch.has(error.message)) throw new BrowserDispatchRejected(error.message); throw error; }
    if (action !== "screenshot" || result.status !== "ok" || !result.image) return result;
    const { image, ...receipt } = result;
    if (image.mime !== "image/png" || image.data.length > 5_592_408) throw new Error("capture_failed");
    const bytes = decodeBase64(image.data);
    if (!bytes.length || bytes.byteLength > 4 * 1024 * 1024) throw new Error("capture_failed");
    try {
      const attachmentId = await uploadFile(this.connection, this.scope.conversation, new File([bytes], "browser-screenshot.png", { type: image.mime }), () => undefined, { signal });
      return { ...receipt, screenshot: { attachmentId, mime: image.mime, width: image.width, height: image.height, bytes: bytes.byteLength } };
    } catch {
      // Capturing succeeded, but no usable attachment receipt was produced.
      // Do not leak base64 or claim the screenshot was delivered.
      return { ...receipt, status: "failed", error: "screenshot_upload_failed" };
    }
  }
}
