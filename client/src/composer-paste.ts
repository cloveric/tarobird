import { useLayoutEffect, useRef, type ClipboardEvent, type PointerEvent, type RefObject } from "react";

/** Keyboard navigation can leave focus on an attachment or toolbar button.
 * Accept file paste throughout the input area; isolate portals and other inputs. */
export function useComposerPaste({ scope, input, disabled, add, change, reject }: { scope: string; input: RefObject<HTMLTextAreaElement | null>; disabled: boolean; add(files: File[]): void; change(text: string): void; reject?(): void }) {
  const epoch = useRef(0);
  useLayoutEffect(() => { epoch.current++; return () => { epoch.current++; }; }, [scope]);
  return (event: ClipboardEvent<HTMLElement>) => {
    const field = input.current, target = event.target;
    if (!field || !(target instanceof Node) || !event.currentTarget.contains(target) || event.defaultPrevented) return;
    if (target instanceof Element && target !== field && target.closest("input, textarea, [contenteditable=true]")) return;
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return; // Preserve native text paste and its undo history.
    event.preventDefault(); event.stopPropagation();
    if (disabled) { reject?.(); return; }
    const start = field.selectionStart, end = field.selectionEnd, text = event.clipboardData.getData("text/plain"), generation = epoch.current;
    add(files);
    if (text) change(field.value.slice(0, start) + text + field.value.slice(end));
    requestAnimationFrame(() => {
      if (generation !== epoch.current || input.current !== field || !field.isConnected) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(start + text.length, start + text.length);
    });
  };
}


/** Clicking noninteractive composer chrome must not strand WebKit focus on body. */
export function focusComposerBackground(event: PointerEvent<HTMLElement>, input: RefObject<HTMLTextAreaElement | null>) {
  const target = event.target;
  if (event.pointerType !== "mouse" || event.button !== 0 || !(target instanceof HTMLElement) || !event.currentTarget.contains(target)) return;
  if (target.closest("button, a, input, textarea, audio, video, label, [contenteditable], [role=button]")) return;
  const rect = target.getBoundingClientRect();
  if (event.clientX > rect.left + target.clientWidth || event.clientY > rect.top + target.clientHeight) return; // Native scrollbar.
  if (input.current?.disabled || input.current?.readOnly) return;
  event.preventDefault(); input.current?.focus({ preventScroll: true });
}
