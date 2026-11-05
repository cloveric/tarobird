import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const BACK_EVENT = "tarocub-native-back";
type Action = { element: RefObject<HTMLElement | null>; run: () => boolean | void; priority: number; order: number };
const actions = new Set<Action>();
let order = 0;

function onBack(event: Event): void {
  if (event.defaultPrevented || document.documentElement.dataset.mobileLocked === "true") return;
  const visible = [...actions].flatMap((action) => {
    const node = action.element.current;
    return node?.isConnected && !node.closest("[hidden],[inert]") && node.getClientRects().length
      ? [{ ...action, node, modal: !!node.closest("dialog[open]") }] : [];
  }).sort((a, b) => {
    // Native dialog top layers take precedence over CSS overlays. Within a
    // nested dialog, React may mount the child's effect before its parent's.
    if (a.modal !== b.modal) return a.modal ? -1 : 1;
    if (a.node.contains(b.node)) return 1;
    if (b.node.contains(a.node)) return -1;
    return b.priority - a.priority || b.order - a.order;
  });
  for (const action of visible) {
    if (action.run() !== false) { event.preventDefault(); return; }
  }
}

/** Return false only when this surface has no navigation step to consume. */
export function useBackAction(element: RefObject<HTMLElement | null>, run: () => boolean | void, priority = 100): void {
  const current = useRef(run);
  useLayoutEffect(() => { current.current = run; });
  useEffect(() => {
    const action = { element, run: () => current.current(), priority, order: ++order };
    if (!actions.size) window.addEventListener(BACK_EVENT, onBack);
    actions.add(action);
    return () => { actions.delete(action); if (!actions.size) window.removeEventListener(BACK_EVENT, onBack); };
  }, [element, priority]);
}

export function dispatchNativeBack(): boolean {
  return !window.dispatchEvent(new Event(BACK_EVENT, { cancelable: true }));
}

export type BackBridge = {
  addListener(name: "backButton", callback: () => void): Promise<{ remove(): Promise<void> }>;
  minimizeApp(): Promise<void>;
};

/** The handler is live only until cleanup, including during async registration. */
export function listenForAndroidBack(bridge: BackBridge, dispatch = dispatchNativeBack): () => void {
  let disposed = false;
  let listener: { remove(): Promise<void> } | undefined;
  void bridge.addListener("backButton", () => {
    if (!disposed && !dispatch()) void bridge.minimizeApp().catch(() => console.warn("native_back_minimize_failed"));
  }).then((value) => {
    if (disposed) return value.remove();
    listener = value;
  }).catch(() => console.warn("native_back_registration_failed"));
  return () => { disposed = true; void listener?.remove().catch(() => console.warn("native_back_cleanup_failed")); };
}
