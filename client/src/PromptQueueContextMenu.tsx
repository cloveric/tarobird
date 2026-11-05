import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Copy, ArrowRight, TextSelect, Pause, Play } from "lucide-react";
import { blocksText, type Message } from "../../src/client-protocol/index.js";
import { DesktopMenu } from "./DesktopMenu.js";
import { t, useLocale } from "./i18n.js";

/** Queue positions change while this menu is open. Resolve the original ID
 * against the latest snapshot, and keep the menu inside the modal's top layer. */
export function PromptQueueContextMenu({ root, conversationId, messages, locate, copy, phone, pauseState, togglePause }: {
  root: RefObject<HTMLElement | null>; conversationId: string; messages: Message[];
  locate: (message: Message) => void; copy: (text: string) => void;
  phone: boolean; pauseState: (id: string) => { paused: boolean; enabled: boolean } | undefined;
  togglePause: (id: string) => void;
}) {
  useLocale();
  const id = useId(), trigger = useRef<HTMLElement | null>(null);
  const [target, setTarget] = useState<{ id: string; point: { x: number; y: number }; selection: string }>();
  const latest = useRef(messages); latest.current = messages;
  const message = target && messages.find(item => item.id === target.id && item.conversationId === conversationId && item.status !== "deleted");
  useEffect(() => { if (target && !message) setTarget(undefined); }, [target, message]);
  useEffect(() => {
    const node = root.current; if (!node) return;
    const open = (event: MouseEvent | KeyboardEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      if (event instanceof KeyboardEvent && !(event.key === "ContextMenu" || event.key === "F10" && event.shiftKey)) return;
      if (event.target.closest("input,textarea,select,[contenteditable=true],[contenteditable=''],[role=textbox]")) return;
      const row = event.target.closest<HTMLElement>("[data-queue-message-id]");
      if (!row || !node.contains(row) || node.dataset.dragging === "true" || !latest.current.some(item => item.id === row.dataset.queueMessageId && item.conversationId === conversationId && item.status !== "deleted")) return;
      event.preventDefault(); event.stopPropagation();
      const rect = row.getBoundingClientRect(), selection = document.getSelection();
      trigger.current = row;
      setTarget({ id: row.dataset.queueMessageId!, point: event instanceof MouseEvent && (event.clientX || event.clientY) ? { x: event.clientX, y: event.clientY } : { x: rect.left + 20, y: rect.top + 32 },
        selection: selection?.rangeCount && row.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : "" });
    };
    const blur = () => setTarget(undefined);
    node.addEventListener("contextmenu", open); node.addEventListener("keydown", open); window.addEventListener("blur", blur);
    return () => { node.removeEventListener("contextmenu", open); node.removeEventListener("keydown", open); window.removeEventListener("blur", blur); };
  }, [root, conversationId]);
  useEffect(() => {
    const node = root.current; if (!node || !phone) return;
    let hold: { pointerId: number; x: number; y: number; row: HTMLElement; fired: boolean } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, suppressClickUntil = 0;
    const cancel = () => { clearTimeout(timer); timer = undefined; hold = undefined; };
    const down = (event: PointerEvent) => {
      cancel(); suppressClickUntil = 0;
      if (event.pointerType !== "touch" || !event.isPrimary || event.button !== 0 || !(event.target instanceof Element)
        || event.target.closest("button,a,input,textarea,select,[contenteditable],[role=button],[data-queue-drag-handle]")) return;
      const row = event.target.closest<HTMLElement>("[data-queue-message-id]");
      if (!row || !node.contains(row)) return;
      hold = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, row, fired: false };
      timer = setTimeout(() => {
        if (!hold || node.dataset.dragging === "true" || !row.isConnected || document.getSelection()?.toString()
          || !latest.current.some(item => item.id === row.dataset.queueMessageId && item.conversationId === conversationId && item.status !== "deleted")) return;
        hold.fired = true; suppressClickUntil = Date.now() + 800;
        trigger.current = row;
        setTarget({ id: row.dataset.queueMessageId!, point: { x: hold.x, y: hold.y }, selection: "" });
      }, 500);
    };
    const move = (event: PointerEvent) => { if (hold?.pointerId === event.pointerId && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 10) cancel(); };
    const up = (event: PointerEvent) => {
      if (hold?.pointerId !== event.pointerId) return;
      if (hold.fired) { event.preventDefault(); suppressClickUntil = Date.now() + 800; }
      cancel();
    };
    const click = (event: MouseEvent) => { if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); suppressClickUntil = 0; } };
    const selection = () => { if (document.getSelection()?.toString()) cancel(); };
    const hidden = () => { if (document.hidden) { cancel(); setTarget(undefined); } };
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up, true); document.addEventListener("pointercancel", cancel);
    node.addEventListener("scroll", cancel); window.addEventListener("blur", cancel);
    document.addEventListener("selectionchange", selection); document.addEventListener("visibilitychange", hidden);
    document.addEventListener("click", click, true);
    return () => {
      cancel(); document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up, true); document.removeEventListener("pointercancel", cancel);
      node.removeEventListener("scroll", cancel); window.removeEventListener("blur", cancel);
      document.removeEventListener("selectionchange", selection); document.removeEventListener("visibilitychange", hidden); document.removeEventListener("click", click, true);
    };
  }, [root, conversationId, phone]);
  if (!target || !message) return null;
  const pause = pauseState(message.id);
  return <DesktopMenu id={id} label={t("待执行消息操作")} open point={target.point} placement="down-start" trigger={trigger} portalTarget={trigger.current?.closest("dialog")} close={() => setTarget(undefined)} restoreFocusOnSelect={false}>
    <button type="button" role="menuitem" onClick={() => locate(message)}><ArrowRight size={16} strokeWidth={1.8} aria-hidden="true"/>{t("定位到对话气泡")}</button>
    {pause && <button type="button" role="menuitem" disabled={!pause.enabled} onClick={() => togglePause(message.id)}>{pause.paused ? <Play size={16}/> : <Pause size={16}/>} {pause.paused ? t("开始") : t("暂停")}</button>}
    <hr/>
    <button type="button" role="menuitem" onClick={() => { trigger.current?.focus({ preventScroll: true }); copy(blocksText(message.blocks)); }}><Copy size={16}/>{t("复制消息")}</button>
    {target.selection && <button type="button" role="menuitem" onClick={() => { trigger.current?.focus({ preventScroll: true }); copy(target.selection); }}><TextSelect size={16}/>{t("复制所选文本")}</button>}
  </DesktopMenu>;
}
