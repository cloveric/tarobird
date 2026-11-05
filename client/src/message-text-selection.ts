import type { MouseEvent } from "react";

/** Select one visible message surface, never its virtual row or the page.
 * Keep native word/drag selection in code, editing fields and phone hold menus.
 * React portal events still bubble here, so DOM containment is essential. */
export function selectMessageBubble(event: MouseEvent<HTMLDivElement>) {
  const root = event.currentTarget, target = event.target;
  if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
    || !(target instanceof Element) || !root.contains(target)
    || root.closest("[data-hold-root],[inert],.is-selecting")) return;
  if (target.closest("button,a,input,textarea,select,label,summary,audio,video,pre,code,[role=button],[role=textbox],[contenteditable]:not([contenteditable=false]),.message-reference,.native-question")) return;

  // A native answer owns its prose, while its progress/footer controls are
  // separate. A legacy card owns just that card even in a multi-card message.
  const surface = target.closest<HTMLElement>(".native-run-prose,.rich-card")
    ?? (root.closest(".message.user") && (target === root || target.closest(".markdown")) ? root : undefined);
  if (!surface || !root.contains(surface) || !surface.querySelector(".markdown")) return;
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(surface);
  event.preventDefault();
  selection.removeAllRanges();
  selection.addRange(range);
}
