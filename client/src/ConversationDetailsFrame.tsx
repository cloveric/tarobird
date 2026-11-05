import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { CreationDialog } from "./CreationDialog.js";
import { useBackAction } from "./back-navigation.js";
import { t } from "./i18n.js";
import "./conversation-details.css";

/** Desktop details are nonmodal: the conversation remains usable beside them.
 * Phones use the existing native-dialog/back stack, with a full-page layout. */
export function ConversationDetailsFrame({ phone, children, close, busy, returnFocus, suspended = false, resumeTarget }: {
  suspended?: boolean; resumeTarget?: string; phone: boolean; children: ReactNode; close: () => void; busy: boolean; returnFocus?: RefObject<HTMLElement | null>;
}) {
  const panel = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null), savedScroll = useRef(0);
  useLayoutEffect(() => {
    if (suspended) return;
    const node = content.current;
    // Sibling dialogs restore focus during their unmount. Restore this page's
    // entry after that commit, when it is no longer inert behind the old modal.
    const frame = requestAnimationFrame(() => {
      if (node && resumeTarget && node.isConnected) { node.scrollTop = savedScroll.current; node.querySelector<HTMLElement>(`[data-details-destination="${resumeTarget}"]`)?.focus({ preventScroll: true }); }
    });
    return () => { cancelAnimationFrame(frame); if (node) savedScroll.current = node.scrollTop; };
  }, [suspended, resumeTarget]);
  useBackAction(panel, () => { if (!busy) close(); });
  useLayoutEffect(() => {
    if (phone || suspended) return;
    const node = panel.current;
    if (!resumeTarget) closeButton.current?.focus({ preventScroll: true });
    return () => {
      // Do not steal focus from a clicked conversation or a newly opened dialog.
      if (node?.contains(document.activeElement) || document.activeElement === document.body) returnFocus?.current?.focus({ preventScroll: true });
    };
  }, [phone, returnFocus, suspended, resumeTarget]);
  if (suspended) return null;
  if (phone) return <CreationDialog back title={t("对话详情")} className="conversation-details-phone" closeLabel={t("返回聊天")} close={close} busy={busy} returnFocus={returnFocus}>
    <div ref={content} className="conversation-details-content">{children}</div>
  </CreationDialog>;
  return <aside ref={panel} className="conversation-details" aria-label={t("对话详情")} onKeyDown={event => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !event.defaultPrevented && !document.querySelector("dialog[open]")) { event.preventDefault(); if (!busy) close(); }
  }}>
    <header><h2>{t("对话详情")}</h2><button ref={closeButton} type="button" className="icon-button" disabled={busy} aria-label={t("关闭对话详情")} onClick={close}><X size={20}/></button></header>
    <div ref={content} className="conversation-details-content">{children}</div>
  </aside>;
}
