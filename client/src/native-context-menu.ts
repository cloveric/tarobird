import { isDesktop, isElectron, invoke } from "./desktop-bridge.js";
import type { PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import { t } from "./i18n.js";

/** Only the desktop shell owns this menu. Browser and mobile selection menus
 * remain native to their platform; React-owned menus get first refusal. */
export function installNativeContextMenu(): () => void {
  if (!isDesktop()) return () => undefined;
  let revision = 0, disposed = false;
  const invalidate = () => { revision++; };
  const context = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const current = ++revision;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (!target) return;
    const field = target.closest("input,textarea");
    const input = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : undefined;
    const textInput = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement && ["text", "search", "url", "email", "tel", "password", "number"].includes(input.type);
    const editable = textInput && !input!.disabled && !input!.readOnly || target.isContentEditable;
    const readonly = textInput && !input!.disabled && input!.readOnly;
    const password = input instanceof HTMLInputElement && input.type === "password";
    const selected = input ? input.selectionStart !== null && input.selectionStart !== input.selectionEnd : !!document.getSelection()?.toString();
    const items: PredefinedMenuItemOptions[] = [];
    if (editable) {
      // Undo/Redo predefined responders are supported only on macOS. Native
      // edit commands preserve the input's undo stack and selection/IME state.
      if (/Mac/.test(navigator.platform)) items.push({ item: "Undo", text: t("撤销") }, { item: "Redo", text: t("重做") }, { item: "Separator" });
      if (!password) items.push({ item: "Cut", text: t("剪切") }, { item: "Copy", text: t("复制") });
      items.push({ item: "Paste", text: t("粘贴") }, { item: "SelectAll", text: t("全选") });
    } else if (readonly) {
      if (!password) items.push({ item: "Copy", text: t("复制") });
      items.push({ item: "SelectAll", text: t("全选") });
    } else if (selected && !password && !input?.disabled) items.push({ item: "Copy", text: t("复制") });
    if (!items.length) return;
    const rect = target.getBoundingClientRect();
    const point = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: rect.left + 8, y: rect.bottom };
    void (async () => {
      if (isElectron()) {
        if (!disposed && current === revision && target.isConnected) await invoke("desktop_context_menu", { items, point });
        return;
      }
      const [{ Menu }, { LogicalPosition }] = await Promise.all([import("@tauri-apps/api/menu"), import("@tauri-apps/api/dpi")]);
      if (disposed || current !== revision || !target.isConnected) return;
      const menu = await Menu.new({ items });
      try {
        if (!disposed && current === revision && target.isConnected) await menu.popup(new LogicalPosition(point.x, point.y));
      } finally { await menu.close(); }
    })().catch(() => { console.warn("Native text context menu unavailable; standard edit shortcuts remain available."); });
  };
  // Bubble after component handlers, so sidebar rename and other App menus
  // are not replaced. Never touch pointerdown defaults or keyboard shortcuts.
  document.addEventListener("contextmenu", context);
  document.addEventListener("pointerdown", invalidate, true);
  document.addEventListener("keydown", invalidate, true);
  window.addEventListener("blur", invalidate);
  return () => {
    disposed = true; invalidate();
    document.removeEventListener("contextmenu", context);
    document.removeEventListener("pointerdown", invalidate, true);
    document.removeEventListener("keydown", invalidate, true);
    window.removeEventListener("blur", invalidate);
  };
}
