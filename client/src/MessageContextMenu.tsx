import { useEffect, useLayoutEffect, useId, useRef, useState, type RefObject } from "react";
import { Copy, Forward, MessageSquare, TextSelect, ListChecks, Trash2 } from "lucide-react";
import { blocksText, type Message } from "../../src/client-protocol/index.js";
import { DesktopMenu } from "./DesktopMenu.js";
import { t, useLocale } from "./i18n.js";
import { messageSelectionCopy, type MessageSelectionCopy } from "./message-selection-clipboard.js";

type Target = { scope: string; id: string; point: { x: number; y: number }; selection?: MessageSelectionCopy };
/** Delegated desktop actions, keyed to the live message rather than a recycled
 * virtual row. Phone long-press and editable-field menus retain their owners. */
export function MessageContextMenu({ root, scope, enabled, messages, quoteBlocked, quote, forward, copy, opened, select, remove, deletionAvailable }: {
  root: RefObject<HTMLElement | null>; scope: string; enabled: boolean; messages: Message[]; quoteBlocked: boolean;
  quote: (message: Message) => void; forward: (message: Message, trigger: HTMLElement | null) => void;
  copy: (text: string, html?: string) => void; opened: () => void;
  select: (message: Message, trigger: HTMLElement | null) => void; remove: (message: Message, trigger: HTMLElement | null) => void; deletionAvailable: boolean;
}) {
  useLocale();
  const id = useId(), trigger = useRef<HTMLElement | null>(null);
  const [target, setTarget] = useState<Target>();
  const latest = useRef(messages); latest.current = messages;
  const onOpen = useRef(opened); onOpen.current = opened;
  const message = enabled && target?.scope === scope ? messages.find(m => m.id === target.id && m.conversationId === scope && m.status !== "deleted") : undefined;
  useEffect(() => { if (target && !message) setTarget(undefined); }, [target, message]);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || !message) return;
    // A delayed scroll notification must not re-enable follow-latest while the
    // reader is choosing an action. Real scrolling still dismisses the menu.
    node.dataset.contextMenu = "true";
    return () => { delete node.dataset.contextMenu; };
  }, [root, message?.id]);
  useEffect(() => {
    const node = root.current;
    if (!enabled || !node) return;
    const open = (event: MouseEvent | KeyboardEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      if (event instanceof KeyboardEvent && !(event.key === "ContextMenu" || event.key === "F10" && event.shiftKey)) return;
      // Editable question cards keep cut/paste/undo and their native selection.
      if (event.target.closest("input,textarea,select,[contenteditable=true],[contenteditable=''],[role=textbox]")) return;
      const row = event.target.closest<HTMLElement>("article[data-message-id]");
      // A projected group represents several records. Single-message actions
      // must not silently target its first member (including keyboard menus).
      if (row?.querySelector("[data-background-group-id]")) { event.preventDefault(); return; }
      if (!row || !node.contains(row) || !latest.current.some(m => m.id === row.dataset.messageId && m.conversationId === scope && m.status !== "deleted")) return;
      event.preventDefault(); event.stopPropagation();
      const rect = row.getBoundingClientRect(), selection = document.getSelection();
      // Capture before opening the menu changes focus/selection. Both keyboard
      // copy and this action must use the same selected-item numbering.
      const selected = selection?.rangeCount && row.contains(selection.getRangeAt(0).commonAncestorContainer) && selection.toString()
        ? messageSelectionCopy(selection) ?? { text: selection.toString() } : undefined;
      trigger.current = row;
      onOpen.current();
      setTarget({ scope, id: row.dataset.messageId!, selection: selected, point: event instanceof MouseEvent && (event.clientX || event.clientY) ? { x: event.clientX, y: event.clientY } : { x: Math.max(8, rect.left + 40), y: Math.max(8, rect.top + 32) } });
    };
    // Below document-level native menu handling, above the message descendants.
    node.addEventListener("contextmenu", open);
    node.addEventListener("keydown", open);
    const blur = () => setTarget(undefined);
    window.addEventListener("blur", blur);
    return () => { node.removeEventListener("contextmenu", open); node.removeEventListener("keydown", open); window.removeEventListener("blur", blur); };
  }, [root, enabled, scope]);
  if (!target || !message) return null;
  const forwardReady = ["complete", "error"].includes(message.status);
  const copyText = (text: string, html?: string) => { trigger.current?.focus({ preventScroll: true }); copy(text, html); };
  return <DesktopMenu id={id} label={t("消息操作")} open point={target.point} placement="down-start" trigger={trigger} close={() => setTarget(undefined)} restoreFocusOnSelect={false}>
    <button type="button" role="menuitem" disabled={quoteBlocked} title={quoteBlocked ? t("对话已归档，恢复后可引用") : undefined} onClick={() => quote(message)}><MessageSquare size={16}/>{t("回复")}</button>
    <button type="button" role="menuitem" disabled={!forwardReady} title={!forwardReady ? t("生成完成后可转发") : undefined} onClick={() => { trigger.current?.focus({ preventScroll: true }); forward(message, trigger.current); }}><Forward size={16}/>{t("转发")}</button>
    <hr/>
    <button type="button" role="menuitem" onClick={() => copyText(blocksText(message.blocks))}><Copy size={16}/>{t("复制消息")}</button>
    {target.selection && <button type="button" role="menuitem" onClick={() => copyText(target.selection!.text, target.selection!.html)}><TextSelect size={16}/>{t("复制所选文本")}</button>}
    <hr/>
    <button type="button" role="menuitem" disabled={!deletionAvailable} aria-describedby={!deletionAvailable ? `${id}-deletion-unavailable` : undefined} title={!deletionAvailable ? t("请更新主机后使用消息删除。") : undefined} onClick={() => select(message, trigger.current)}><ListChecks size={16}/>{t("多选消息")}</button>
    <button type="button" role="menuitem" className="message-delete-action text-danger" disabled={!deletionAvailable} aria-describedby={!deletionAvailable ? `${id}-deletion-unavailable` : undefined} title={!deletionAvailable ? t("请更新主机后使用消息删除。") : undefined} onClick={() => remove(message, trigger.current)}><Trash2 size={16}/>{t("删除消息")}</button>
    {!deletionAvailable && <p id={`${id}-deletion-unavailable`} className="muted">{t("请更新主机后使用消息删除。")}</p>}
  </DesktopMenu>;
}
