import { addGlobalListener } from "./global-event-hub.js";

/** WebKit can keep :focus-visible when dialogs restore a clicked trigger and
 * when the window becomes active again. Preserve focus, but show button rings
 * only for keyboard use once the user has chosen an input method. */
export function installFocusIntent(): () => void {
  const root = document.documentElement;
  const pointer = () => { if (root.dataset.focusIntent !== "pointer") root.dataset.focusIntent = "pointer"; };
  const move = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || event.pointerType === "pen") pointer();
  };
  const keyboard = (event: KeyboardEvent) => {
    // OS/app-switch shortcuts and modifier keys are not in-page navigation.
    // Option+Tab is WebKit's macOS shortcut for reaching all controls.
    if (event.metaKey || event.ctrlKey || (event.altKey && event.key !== "Tab") ||
      ["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
    root.dataset.focusIntent = "keyboard";
  };
  const cleanups = [
    addGlobalListener(document, "pointerdown", pointer, { capture: true }),
    addGlobalListener(document, "pointermove", move, { capture: true }),
    addGlobalListener(document, "keydown", keyboard, { capture: true }),
  ];
  // Deliberately retain the last input method across blur/focus. Activating
  // the native window must not turn a restored pointer focus into navigation.
  return () => {
    for (const cleanup of cleanups) cleanup();
    delete root.dataset.focusIntent;
  };
}
