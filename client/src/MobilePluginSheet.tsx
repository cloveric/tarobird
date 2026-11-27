import { useLayoutEffect, useRef } from "react";
import { ChevronLeft, Puzzle, X } from "lucide-react";
import type { InstalledPluginRecord } from "./plugin-registry.js";
import { PluginSandboxFrame } from "./PluginSandboxFrame.js";
import { useBackAction } from "./back-navigation.js";
import { t, useLocale } from "./i18n.js";
import "./plugins.css";

/** Full-screen mobile runtime host for phone-compatible side-panel plugins.
 * Uses a native modal `<dialog>` with safe-area insets and Android Back / Escape handling. */
export function MobilePluginSheet({
  plugin,
  title,
  close,
}: {
  plugin: InstalledPluginRecord;
  title: string;
  close: () => void;
}) {
  useLocale();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closingRef = useRef(false);

  useBackAction(dialogRef, close, 120);

  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    closingRef.current = false;
    node?.showModal();
    return () => {
      closingRef.current = true;
      node?.close();
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="plugin-mobile-sheet"
      aria-label={title}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        close();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget || closingRef.current || event.currentTarget.open) return;
        event.currentTarget.showModal();
        close();
      }}
    >
      <header className="plugin-mobile-sheet-header">
        <button type="button" className="icon-button" aria-label={t("返回")} onClick={close}>
          <ChevronLeft size={22}/>
        </button>
        <div className="plugin-mobile-sheet-title">
          <Puzzle size={16} aria-hidden="true"/>
          <h2>{title}</h2>
        </div>
        <button type="button" className="icon-button" aria-label={t("关闭插件面板")} onClick={close}>
          <X size={18}/>
        </button>
      </header>
      <div className="plugin-mobile-sheet-body">
        <PluginSandboxFrame plugin={plugin} title={title}/>
      </div>
    </dialog>
  );
}
