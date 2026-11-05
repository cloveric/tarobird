import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { FilePlus2 } from "lucide-react";
import { attachmentDropModal, getDropFeedback, subscribeDropFeedback } from "./attachment-drop.js";
import { useLocale } from "./i18n.js";
import "./attachment-drop.css";

export function AttachmentDropFeedback() {
  useLocale();
  const feedback = useSyncExternalStore(subscribeDropFeedback, getDropFeedback);
  if (!feedback) return null;
  const rect = feedback.bounds;
  const card = <div className={`attachment-drop-feedback${feedback.error ? " is-error" : ""}`} role={feedback.error ? "alert" : "status"}
    style={rect ? { left: Math.min(innerWidth - 150, Math.max(150, rect.left + rect.width / 2)), top: Math.max(48, rect.top + Math.min(130, rect.height / 3)) } : undefined}>
    {!feedback.error && <FilePlus2 size={23} aria-hidden="true"/>}<span><strong>{feedback.message}</strong>{feedback.detail && <small>{feedback.detail}</small>}</span>
  </div>;
  // A top-layer dialog makes its siblings inert. Keep the rejection hint
  // visible and announced inside that dialog, without making it a drop target.
  const modal = attachmentDropModal();
  return modal ? createPortal(card, modal) : card;
}
