import { useLayoutEffect, useRef, type ReactNode, type RefObject, type ClipboardEventHandler, type DragEventHandler } from "react";
import { ArrowLeft, X } from "lucide-react";
import { t } from "./i18n.js";
import { useBackAction } from "./back-navigation.js";
import { HostLocation } from "./RuntimeHost.js";
import { useDialogDrag } from "./dialog-drag.js";
import { useSettingsPageViewport } from "./SettingsPageHeader.js";
import "./settings-dialog.css";

export function CreationDialog({ title, children, headerActions, close, onBack, busy = false, closeLabel, returnFocus, initialFocus, describedBy, back = false, movable = false, mobilePage = false, showHost = true, className = "", onPaste, onDragOver, onDrop }: { title: string; describedBy?: string; children: ReactNode; headerActions?: ReactNode; close: () => void; onBack?: () => void; busy?: boolean; back?: boolean; movable?: boolean; mobilePage?: boolean; showHost?: boolean; closeLabel?: string; returnFocus?: RefObject<HTMLElement | null>; className?: string; onPaste?: ClipboardEventHandler<HTMLDialogElement>; onDragOver?: DragEventHandler<HTMLDialogElement>; onDrop?: DragEventHandler<HTMLDialogElement>; initialFocus?: RefObject<HTMLElement | null> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const header = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null), body = useRef<HTMLDivElement>(null);
  useSettingsPageViewport(body);
  const backdropPress = useRef(false);
  // Back/Escape may pop an inner step; explicit close and backdrop retain close semantics.
  useBackAction(dialog, () => { if (!busy) (onBack ?? close)(); });
  // Restore during the removal commit. A passive cleanup can run after the
  // newly opened conversation's animation-frame focus and steal it back.
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.showModal();
    if (initialFocus?.current) initialFocus.current.focus({ preventScroll: true });
    // Start passive dialogs at their title instead of decorating the close
    // button on open. Tab still reaches that button with its visible ring.
    else if (document.activeElement === closeButton.current || document.activeElement === backButton.current) heading.current?.focus({ preventScroll: true });
    return () => { node?.close(); (returnFocus?.current ?? before)?.focus({ preventScroll: true }); };
  }, [returnFocus, initialFocus]);
  // A nested form can replace its focused submit/cancel button without closing
  // the dialog. Keep keyboard navigation in the newly displayed step.
  useLayoutEffect(() => {
    const node = dialog.current;
    if (node?.open && !node.contains(document.activeElement)) heading.current?.focus({ preventScroll: true });
  }, [title]);
  // Settings are small movable dialogs on desktop and fixed pages on phones.
  const canMove = movable || mobilePage;
  useDialogDrag(dialog, header, canMove);
  return <dialog ref={dialog} onKeyDown={event => { if (event.key === "Escape" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) { event.preventDefault(); event.stopPropagation(); } }} onPaste={onPaste} onDragOver={onDragOver} onDrop={onDrop} className={`creation-dialog new-chat-panel ${canMove ? "is-movable" : ""} ${mobilePage ? "mobile-settings-dialog" : ""} ${className}`} aria-label={title} aria-describedby={describedBy} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) (onBack ?? close)(); }} onPointerDown={(event) => {
    const r = event.currentTarget.getBoundingClientRect();
    backdropPress.current = event.button === 0 && event.target === event.currentTarget && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
  }} onClick={(event) => {
    const startedOutside = backdropPress.current; backdropPress.current = false;
    // Releasing a drag/selection outside the dialog is not a backdrop click.
    if (startedOutside && event.target === event.currentTarget && !busy) {
      const r = event.currentTarget.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
    }
  }}>
    <header ref={header}>{mobilePage && <button ref={backButton} type="button" className="icon-button settings-dialog-back" disabled={busy} aria-label={onBack ? t("返回") : closeLabel ?? t("返回")} onClick={onBack ?? close}><ArrowLeft size={20}/></button>}<h2 ref={heading} tabIndex={-1}>{title}</h2><button ref={closeButton} type="button" className={`icon-button${mobilePage ? " settings-dialog-close" : ""}`} disabled={busy} aria-label={closeLabel ?? t("关闭新建对话")} onClick={close}>{back ? <ArrowLeft size={20}/> : <X size={20}/>}</button>{headerActions}</header>
    {mobilePage ? <div ref={body} className="settings-dialog-body">{showHost && <HostLocation/>}{children}</div> : <>{showHost && <HostLocation/>}{children}</>}
  </dialog>;
}
