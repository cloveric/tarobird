import { expandedIphoneWindow } from './ios-window.js';

interface KeyboardAccessory {
  setAccessoryBarVisible(options: { isVisible: boolean }): Promise<void>;
}

export function loadNativeKeyboardAccessory(): Promise<KeyboardAccessory> {
  // Capacitor's proxy synthesizes a `then` method too. Returning the proxy
  // through a Promise would invoke that nonexistent native method and stall.
  return import('@capacitor/keyboard').then(({ Keyboard }) => ({
    setAccessoryBarVisible: options => Keyboard.setAccessoryBarVisible(options),
  }));
}

/** The native plugin hides WebKit's Done bar by default. Expanded iPhones
 * need that explicit escape when their keyboard has no dismissal key. Keep
 * compact phones and iPads on their existing policy, including after folding. */
export function installExpandedIphoneKeyboardBar(
  win: Window,
  load: () => Promise<KeyboardAccessory>,
  report = () => console.warn('ios_keyboard_accessory_unavailable'),
): () => void {
  if (!/\biPhone\b/.test(win.navigator.userAgent)) return () => {};
  let stopped = false, desired = false, pending = false;
  // Native plugin state survives document reloads. Reconcile once per iPhone
  // document instead of assuming that a new JS world means a hidden bar.
  let requested: boolean | undefined;
  let keyboard: KeyboardAccessory | undefined;
  const flush = async () => {
    if (pending || requested === desired) return;
    pending = true;
    try {
      keyboard ??= await load();
      // Re-read after loading: the display may have folded or the owner may
      // have unmounted. Serialize native requests so an old Show cannot win
      // over a later Hide. A failed request is not retried on every resize.
      while (requested !== desired) {
        requested = desired;
        try {
          await keyboard.setAccessoryBarVisible({ isVisible: requested });
          // The plugin changes the getter but does not refresh an already-open
          // keyboard. Refresh its current responder without programmatically
          // blurring or rewriting the field. Ignore an intermediate stale request.
          if (requested === desired) {
            (win as Window & { tarobotKeyboardInsets?: { refreshAccessory?(): void } })
              .tarobotKeyboardInsets?.refreshAccessory?.();
          }
        }
        catch { report(); }
      }
    } catch { report(); }
    finally { pending = false; }
  };
  const update = () => {
    desired = !stopped && expandedIphoneWindow('ios', win.navigator.userAgent, win.innerWidth, win.innerHeight);
    void flush();
  };
  win.addEventListener('resize', update);
  update();
  return () => {
    stopped = true;
    win.removeEventListener('resize', update);
    desired = false;
    void flush();
  };
}
