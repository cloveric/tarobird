/** A short tap in the chat history can dismiss iOS keyboards without a Done
 * key, including when native inset reporting is delayed. Never consume the tap
 * or interfere with controls, scrolling, long-press selection or another field. */
export function installIosKeyboardDismiss(doc: Document, enabled: () => boolean) {
  const fields = 'input,textarea,[contenteditable=true]';
  const controls = 'button,a,input,textarea,select,label,summary,[role=button],[contenteditable=true]';
  let press: { id: number; x: number; y: number; at: number; field: HTMLElement } | undefined;
  const down = (event: PointerEvent) => {
    press = undefined;
    const field = doc.activeElement, target = event.target as Element | null;
    if (!enabled() || event.pointerType !== 'touch' || !field?.matches(fields) || !target?.closest('.message-scroll') || target.closest(controls)) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, field: field as HTMLElement };
  };
  const move = (event: PointerEvent) => {
    if (press && (press.id !== event.pointerId || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8)) press = undefined;
  };
  const up = (event: PointerEvent) => {
    const current = press; press = undefined;
    const target = event.target as Element | null;
    if (!enabled() || !current || current.id !== event.pointerId || current.field !== doc.activeElement
      || !target?.closest('.message-scroll') || target.closest(controls)
      || event.timeStamp - current.at > 350 || Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8
      || doc.getSelection()?.isCollapsed === false) return;
    current.field.blur();
  };
  const cancel = () => { press = undefined; };
  doc.addEventListener('pointerdown', down, true);
  doc.addEventListener('pointermove', move, true);
  doc.addEventListener('pointerup', up, true);
  doc.addEventListener('pointercancel', cancel, true);
  return () => {
    cancel(); doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('pointerup', up, true); doc.removeEventListener('pointercancel', cancel, true);
  };
}
