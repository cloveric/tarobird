import { useLayoutEffect, useRef, type ClipboardEvent, type PointerEvent, type RefObject } from "react";
import { canReadDesktopClipboardImage, clipboardHTMLImages, imagePlaceholder, readDesktopClipboardImage } from "./composer-clipboard-image.js";
import { t } from "./i18n.js";

/** Keyboard navigation can leave focus on an attachment or toolbar button.
 * Accept file paste throughout the input area; isolate portals and other inputs. */
export function useComposerPaste({ scope, input, disabled, add, change, reject, fail }: { scope: string; input: RefObject<HTMLTextAreaElement | null>; disabled: boolean; add(files: File[]): boolean | void; change(text: string): void; reject?(): void; fail?(message: string): void }) {
  const epoch = useRef(0);
  useLayoutEffect(() => { epoch.current++; return () => { epoch.current++; }; }, [scope, disabled]);
  return (event: ClipboardEvent<HTMLElement>) => {
    const field = input.current, target = event.target;
    if (!field || !(target instanceof Node) || !event.currentTarget.contains(target) || event.defaultPrevented) return;
    if (target instanceof Element && target !== field && target.closest("input, textarea, [contenteditable=true]")) return;
    const items = Array.from(event.clipboardData.items);
    const imageItem = items.some(item => item.kind === "file" && item.type.startsWith("image/"));
    let files = Array.from(event.clipboardData.files);
    if (!files.length) files = items.filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => !!file);
    const plain = event.clipboardData.getData("text/plain");
    const imageOnly = !plain.trim() || imagePlaceholder(plain);
    // Rich text often carries small icons/avatars. Only inspect its HTML for
    // image-only pastes. An explicit image item whose File is unavailable can
    // use native recovery even with a caption; ordinary prose keeps its undo.
    if (!files.length && (disabled || !imageOnly && !imageItem)) return;
    const inserted = plain.replace(/\r\n?/g, "\n");
    let hasImage = false;
    const failure = () => fail?.(t("未能粘贴图片，请重新复制，或将图片保存后拖入。"));
    if (!files.length && imageOnly) {
      try { const html = clipboardHTMLImages(event.clipboardData.getData("text/html")); files = html.files; hasImage = html.hasImage; }
      catch { failure(); return; }
    }
    if (!files.length) {
      // Keep the browser's text insertion and undo history. Only image-like
      // pastes ask Electron for its standard image representation.
      if (disabled || !canReadDesktopClipboardImage() || !(imageItem || hasImage || imagePlaceholder(plain))) return;
      const generation = ++epoch.current, value = field.value, start = field.selectionStart, end = field.selectionEnd;
      const prefix = value.slice(0,start), suffix = value.slice(end);
      if (target !== field) {
        // Buttons in the composer accept paste too; their browser default does
        // not insert text into the textarea, so perform that insertion here.
        event.preventDefault(); event.stopPropagation(); field.focus({ preventScroll: true });
        if (inserted && !document.execCommand("insertText",false,inserted)) change(prefix + inserted + suffix);
      }
      // Default paste runs after this handler. Blink can invalidate both File
      // and getData while still inserting native text. Recover only that
      // bounded insertion; the main process must still match clipboard text.
      void new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
        if (generation !== epoch.current || input.current !== field || !field.isConnected) return;
        let clipboardText = plain;
        if (!plain && imageItem && target === field) {
          const after = field.value;
          if (after.length < prefix.length + suffix.length || !after.startsWith(prefix) || !after.endsWith(suffix)) { failure(); return; }
          clipboardText = after.slice(prefix.length, after.length - suffix.length);
        }
        const normalized = clipboardText.replace(/\r\n?/g, "\n");
        const expected = prefix + normalized + suffix, rawExpected = prefix + clipboardText + suffix;
        const file = await readDesktopClipboardImage(clipboardText);
        if (generation !== epoch.current || input.current !== field || !field.isConnected) return;
        const pasted = field.value === expected ? normalized : field.value === rawExpected ? clipboardText : undefined;
        if (!file || pasted === undefined || field.disabled || field.readOnly) { failure(); return; }
        if (add([file]) === false) return;
        // Do not erase edited text or move a caret the person has since moved.
        if (imagePlaceholder(clipboardText) && document.activeElement === field && field.selectionStart === start + pasted.length && field.selectionEnd === start + pasted.length) {
          field.setSelectionRange(start,start + pasted.length);
          if (!document.execCommand("insertText",false,"")) change(value.slice(0,start) + value.slice(end));
        }
      }).catch(() => { if (generation === epoch.current && input.current === field && field.isConnected) failure(); });
      return;
    }
    epoch.current++;
    event.preventDefault(); event.stopPropagation();
    if (disabled) { reject?.(); return; }
    const start = field.selectionStart, end = field.selectionEnd, generation = epoch.current;
    const accepted = add(files) !== false;
    const text = accepted && imagePlaceholder(plain) && files.every(file => file.type.startsWith("image/") && file.size > 0) ? "" : inserted;
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
