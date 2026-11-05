import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { t } from "./i18n.js";

type Rejection = "directory" | "disabled";
type Target = {
  node: RefObject<HTMLElement | null>; scope: string; enabled: boolean;
  windowFallback: boolean; label: string; disabledMessage?: string; add(files: File[]): void;
  reject?: (reason: Rejection) => void; hover(value: boolean): void;
};
export type DropFeedback = { message: string; detail?: string; error?: boolean; bounds?: { left: number; top: number; width: number; height: number } };
const targets = new Set<Target>(), listeners = new Set<() => void>();
let feedback: DropFeedback | undefined, feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let scopes = 0, depth = 0;
let gesture: { target?: Target; scope?: string; cancelled?: "changed" | "escape" } | undefined;
const isFileTransfer = (transfer: DataTransfer | null) => !!transfer && (Array.from(transfer.types).includes("Files") || Array.from(transfer.items ?? []).some(item => item.kind === "file") || transfer.files.length > 0);
const element = (target: EventTarget | null) => target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
const visible = (node: HTMLElement | null): node is HTMLElement => !!node && node.isConnected && !node.closest("[hidden], [inert]") && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
// Inline report/widget cards also use an open dialog. Only a modal blocks the
// conversation behind it. Older WebViews throw on an unsupported :modal query.
function modalDialogs() {
  return [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter(dialog => {
    if (!visible(dialog)) return false;
    try { return dialog.matches(":modal"); }
    catch {
      if (dialog.classList.contains("widget-panel")) return dialog.classList.contains("widget-expanded");
      if (dialog.classList.contains("report-panel")) return !!dialog.closest(".report-expanded");
      return true;
    }
  });
}
export function attachmentDropModal() {
  const dialogs = modalDialogs();
  return [...dialogs].reverse().find(dialog => dialog.contains(document.activeElement)) ?? dialogs.at(-1);
}
const blocked = () => modalDialogs().length > 0 || [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="menu"]')].some(visible);
function show(value?: DropFeedback, temporary = false) {
  clearTimeout(feedbackTimer);
  if (JSON.stringify(feedback) !== JSON.stringify(value)) { feedback = value; for (const notify of listeners) notify(); }
  if (temporary) feedbackTimer = setTimeout(() => show(), 5000);
}
export const subscribeDropFeedback = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };
export const getDropFeedback = () => feedback;
function highlight(target?: Target) { for (const item of targets) item.hover(item === target); }
function clearGesture() { clearTimeout(hoverTimer); gesture = undefined; depth = 0; highlight(); show(); }
function resolve(event: globalThis.DragEvent) {
  const hit = element(event.target);
  // The QR importer owns its file gesture, even while ordinary chat is inert.
  if (hit?.closest("dialog.pairing-scanner")) return { owned: true } as const;
  if (blocked()) return { message: t("请先关闭弹窗，再添加附件。") } as const;
  const active = [...targets].filter(item => visible(item.node.current));
  const direct = active.filter(item => hit && item.node.current!.contains(hit));
  // A disabled side panel must never fall through into the main conversation.
  const target = direct.find(item => !direct.some(other => other !== item && item.node.current!.contains(other.node.current)))
    ?? (active.filter(item => item.windowFallback).length === 1 ? active.find(item => item.windowFallback) : undefined);
  if (!target) return { message: active.length ? t("请将文件拖到要发送的对话面板中。") : t("请先打开一个对话，再拖入文件。") } as const;
  return { target, message: target.enabled ? undefined : target.disabledMessage ?? t("当前对话暂时无法添加附件。") } as const;
}
function destination(event: globalThis.DragEvent) {
  gesture ??= {};
  const result = resolve(event);
  if (gesture.cancelled || gesture.target && (!targets.has(gesture.target) || gesture.scope !== gesture.target.scope || !visible(gesture.target.node.current))) {
    gesture.cancelled ??= "changed";
    return { message: gesture.cancelled === "escape" ? t("拖放已取消，请重新拖入文件。") : t("对话已切换，拖放已取消，请重新拖入文件。") } as const;
  }
  if ("target" in result && result.target) { gesture.target = result.target; gesture.scope = result.target.scope; }
  return result;
}
function drag(event: globalThis.DragEvent) {
  // Browsers may protect/empty the transfer on leave. Still retire the gesture
  // when it leaves the window; otherwise its target can poison the next drag.
  if (event.type === "dragleave") {
    const outside = !event.relatedTarget && (event.clientX < 0 || event.clientY < 0 || event.clientX >= innerWidth || event.clientY >= innerHeight);
    if (gesture && (--depth <= 0 || outside)) clearGesture();
    return;
  }
  if (!isFileTransfer(event.dataTransfer)) return;
  event.preventDefault();
  if (event.type === "dragenter" && gesture?.cancelled === "escape" && depth === 0) clearGesture();
  if (event.type === "dragenter") depth++;
  const result = destination(event);
  if ("owned" in result) { if (event.type === "drop") clearGesture(); else { highlight(); show(); } return; }
  const target = "target" in result ? result.target : undefined;
  if (event.type !== "drop") {
    event.dataTransfer!.dropEffect = target?.enabled && !result.message ? "copy" : "none";
    highlight(target?.enabled && !result.message ? target : undefined);
    const rect = target?.enabled && !result.message ? target.node.current!.getBoundingClientRect() : undefined;
    show(result.message ? { message: result.message } : {
      message: t("松开以添加附件"), detail: target?.label ? t("添加到「{0}」", target.label) : t("添加到当前对话"),
      ...(rect ? { bounds: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } } : {}),
    });
    // A removed DOM node or an OS-side cancel can omit dragleave/dragend.
    // Hide stale decoration after the dragover heartbeat stops, but retain
    // the captured scope so a stalled gesture cannot target a different chat.
    clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { highlight(); show(); }, 1000);
    return;
  }
  event.stopPropagation(); clearGesture();
  if (result.message) {
    if (target && !target.enabled && target.reject) target.reject("disabled");
    else show({ message: result.message, error: true }, true);
    return;
  }
  if (!target) return;
  const transfer = event.dataTransfer!;
  const items = Array.from(transfer.items ?? []).filter(item => item.kind === "file");
  let directory = false;
  const files = items.length ? items.flatMap(item => {
    if (item.webkitGetAsEntry?.()?.isDirectory) { directory = true; return []; }
    const file = item.getAsFile(); return file ? [file] : [];
  }) : Array.from(transfer.files);
  if (files.length) target.add(files);
  if (directory) target.reject?.("directory");
  else if (!files.length) show({ message: t("未能读取拖入的文件，请使用「添加附件」重新选择。"), error: true }, true);
}
function escape(event: KeyboardEvent) {
  if (event.key === "Escape" && gesture) { gesture.cancelled = "escape"; depth = 0; highlight(); show(); }
}
// External drags need not dispatch dragend into this document. Ordinary pointer
// input resumes only after that OS gesture ends, so it also clears stale hints.
function pointer(event: PointerEvent) { if (gesture && !event.buttons) clearGesture(); }
export function installAttachmentDropGuard() {
  if (scopes++ === 0) {
    for (const type of ["dragenter", "dragover", "dragleave", "drop"]) window.addEventListener(type, drag as EventListener, true);
    window.addEventListener("dragend", clearGesture, true); window.addEventListener("blur", clearGesture);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("pointerdown", clearGesture, true); window.addEventListener("pointermove", pointer, true);
  }
  let disposed = false;
  return () => {
    if (disposed) return; disposed = true;
    if (--scopes === 0) {
      for (const type of ["dragenter", "dragover", "dragleave", "drop"]) window.removeEventListener(type, drag as EventListener, true);
      window.removeEventListener("dragend", clearGesture, true); window.removeEventListener("blur", clearGesture);
      window.removeEventListener("keydown", escape, true); clearGesture();
      window.removeEventListener("pointerdown", clearGesture, true); window.removeEventListener("pointermove", pointer, true);
    }
  };
}

/** One HTML File intake per window. No native pathname or filesystem grant is
 * introduced. Native windows keep dragDropEnabled:false so WebView owns Files. */
export function useAttachmentDrop(scope: string, enabled: boolean, add: (files: File[]) => void, reject?: (reason: Rejection) => void,
  options: { target?: RefObject<HTMLElement | null>; windowFallback?: boolean; label?: string; disabledMessage?: string } = {}) {
  const local = useRef<HTMLElement>(null), node = options.target ?? local;
  const [hover, setHover] = useState(false);
  const entry = useRef<Target>({ node, scope, enabled, add, reject, hover: setHover, windowFallback: !!options.windowFallback, label: options.label ?? "" }).current;
  useLayoutEffect(() => {
    if (entry.scope !== scope && gesture?.target === entry) { gesture.cancelled = "changed"; highlight(); show(); }
    Object.assign(entry, { node, scope, enabled, add, reject, windowFallback: !!options.windowFallback, label: options.label ?? "", disabledMessage: options.disabledMessage });
    if (!enabled) setHover(false);
  });
  useLayoutEffect(() => {
    targets.add(entry); const stop = installAttachmentDropGuard();
    return () => { targets.delete(entry); if (gesture?.target === entry) { gesture.cancelled = "changed"; highlight(); show(); } stop(); };
  }, [entry]);
  return { hover, ref: node, events: {} };
}
