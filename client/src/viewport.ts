export interface ViewportMetrics {
  width: number;
  height: number;
  coarse: boolean;
  visibleHeight?: number;
  offsetTop?: number;
  scale?: number;
  nativeKeyboard?: boolean;
  /** Only for native overlay mode; never pass for native-resized windows. */
  nativeKeyboardHeight?: number;
}

/** Native resize already changes the WebView: never subtract keyboard height
 * a second time. A browser's visual viewport can instead shrink independently. */
export function appViewport(metrics: ViewportMetrics): { height: number; top: number; keyboard: boolean } | undefined {
  if ((!metrics.coarse && metrics.width > 760) || !Number.isFinite(metrics.height) || metrics.height <= 0) return;
  // Preserve browser pinch zoom/panning; it must not be reinterpreted as IME.
  if (metrics.scale !== undefined && Math.abs(metrics.scale - 1) > 0.02) return;
  const overlay = metrics.nativeKeyboardHeight !== undefined;
  const keyboardHeight = Number.isFinite(metrics.nativeKeyboardHeight) ? Math.max(0, metrics.nativeKeyboardHeight!) : 0;
  const height = Math.max(1, Math.min(metrics.height - keyboardHeight, Number.isFinite(metrics.visibleHeight) && metrics.visibleHeight! > 0 ? metrics.visibleHeight! : metrics.height));
  const top = overlay ? 0 : Math.max(0, Math.min(metrics.height - height, Number.isFinite(metrics.offsetTop) ? metrics.offsetTop! : 0));
  return { height, top, keyboard: !!metrics.nativeKeyboard || metrics.height - height > 120 };
}

export type KeyboardEvents = {
  addListener(event: 'keyboardWillShow' | 'keyboardDidShow' | 'keyboardWillHide' | 'keyboardDidHide', callback: (info?: { keyboardHeight: number }) => void): Promise<{ remove(): Promise<void> }>;
};

export interface KeyboardMotion { duration: number; easing: string }
/** Compatibility timing. New iOS shells report UIKit's duration per change;
 * older shells use 0.25 s with a private curve approximation. The
 * ease-out approximation stays until a device check of another curve. AOSP
 * synchronizes the IME with apps that register an insets-animation callback
 * (Capacitor Keyboard does) in 285 ms on PathInterpolator(0.2, 0, 0, 1). OEM
 * keyboards and ROMs may differ. */
export const nativeKeyboardMotion = {
  ios: { duration: 250, easing: 'ease-out' },
  android: { duration: 285, easing: 'cubic-bezier(.2,0,0,1)' },
} as const satisfies Record<string, KeyboardMotion>;

/** Fields that bring up the soft keyboard and may need revealing above it. */
const textField = 'input:not([type="button"]):not([type="checkbox"]):not([type="color"]):not([type="file"]):not([type="hidden"]):not([type="image"]):not([type="radio"]):not([type="range"]):not([type="reset"]):not([type="submit"]),textarea,select,[contenteditable="true"]';
/** Native shells keep their latest report on the page, so a controller
 * installed later, or after a reload, starts from the current state. */
type KeyboardReport = { height?: number; at?: number; duration?: number };

/** New iOS shells measure the keyboard in this window. Old binaries retain
 * Capacitor's event path; never let the two sources compete. */
export function hasWindowKeyboardInsets(win: Window): boolean {
  try { return (win as Window & { tarobotKeyboardInsets?: { supported?(): boolean } }).tarobotKeyboardInsets?.supported?.() === true; }
  catch { return false; }
}

/** One controller for all hosts, login and lock UI. rAF coalesces native and
 * visual-viewport notifications without starting React renders per frame.
 * With a native overlay the WebView keeps its size and the keyboard covers
 * it; the shell animates to the keyboard's end state with the OS timing. */
export function installAppViewport(win: Window, doc: Document, nativeOverlay: KeyboardMotion | boolean = false) {
  const root = doc.documentElement, visual = win.visualViewport;
  const coarse = win.matchMedia('(pointer: coarse)');
  const motion = nativeOverlay === true ? nativeKeyboardMotion.ios : nativeOverlay || undefined;
  const windowInsets = !!motion && hasWindowKeyboardInsets(win);
  let frame = 0, revealFrame = 0, revealPending = false, stopped = false, nativeKeyboard = false, nativeKeyboardHeight = 0;
  let motionKeyboard = 0, motionSentAt: number | undefined, reportedDuration: number | undefined, motionTimer: ReturnType<typeof setTimeout> | undefined;
  let width = win.innerWidth, height = win.innerHeight;
  const handles: Array<{ remove(): Promise<void> }> = [];
  const previous = { height: root.style.getPropertyValue('--app-height'), top: root.style.getPropertyValue('--app-top'), motion: root.style.getPropertyValue('--keyboard-motion'), keyboard: root.getAttribute('data-keyboard-open'), resize: root.getAttribute('data-keyboard-resize') };
  if (motion) root.setAttribute('data-keyboard-resize', 'overlay');
  const set = (name: string, value: string) => { if (root.style.getPropertyValue(name) !== value) { if (value) root.style.setProperty(name, value); else root.style.removeProperty(name); } };
  const settle = () => { clearTimeout(motionTimer); motionTimer = undefined; root.removeAttribute('data-keyboard-motion'); };
  const update = () => {
    frame = 0; if (stopped) return;
    const value = appViewport({ width: win.innerWidth, height: win.innerHeight, coarse: coarse.matches || windowInsets, visibleHeight: visual?.height, offsetTop: visual?.offsetTop, scale: visual?.scale, nativeKeyboard, ...(motion ? { nativeKeyboardHeight } : {}) });
    // Only the keyboard animates. A window size change (rotation, split view)
    // or zoom ends a running keyboard transition and applies at once; so does
    // a report older than the OS animation (late bridge, resume, restored page).
    // A visual-viewport-only change inside the keyboard's window follows it.
    const resized = win.innerWidth !== width || win.innerHeight !== height;
    // A split-view/window resize can keep the same IME height. The inner
    // form still shrinks or wraps, without another keyboard/focus event.
    // Recheck only native keyboard resizes; reveal ignores the chat composer
    // and writes nothing when the active field already fits.
    if (motion && nativeKeyboard && resized) revealPending = true;
    width = win.innerWidth; height = win.innerHeight;
    if (motion && nativeKeyboardHeight !== motionKeyboard) {
      motionKeyboard = nativeKeyboardHeight;
      const lag = motionSentAt === undefined ? 0 : Math.max(0, Date.now() - motionSentAt);
      const duration = reportedDuration ?? motion.duration;
      if (resized || !value || lag >= duration) settle();
      else {
        // The native event can arrive frames after the OS animation started.
        set('--keyboard-motion', `${duration}ms ${motion.easing} ${-Math.round(lag)}ms`);
        root.setAttribute('data-keyboard-motion', '');
        clearTimeout(motionTimer);
        motionTimer = setTimeout(settle, duration - lag + 100);
      }
    } else if (resized || !value) settle();
    set('--app-height', value ? `${value.height}px` : ''); set('--app-top', value ? `${value.top}px` : '');
    root.setAttribute('data-keyboard-open', value?.keyboard ? 'true' : 'false');
    if (revealPending && value?.keyboard) {
      revealPending = false;
      if (revealFrame) win.cancelAnimationFrame(revealFrame);
      revealFrame = win.requestAnimationFrame(() => reveal(value));
    }
  };
  // KeyboardResize.None leaves WebKit's native frame unchanged, so it cannot
  // reveal a lower form field after the app's inner pane shrinks. Scroll only
  // inner containers; moving the document would reintroduce the header/composer
  // jump this controller prevents. A sheet that still moves with the keyboard
  // grows its scroll range each frame, so follow it while the field is outside
  // the final band. The chat composer rides on the shell and is never measured.
  const reveal = (value: { top: number; height: number }) => {
    revealFrame = 0;
    const field = doc.activeElement;
    if (stopped || !nativeKeyboard || !field?.matches(textField) || field.closest('.composer-wrap')) return;
    const top = value.top + 8, bottom = value.top + value.height - 8;
    for (let parent = field.parentElement; parent && parent !== doc.body && parent !== root; parent = parent.parentElement) {
      if (parent.scrollHeight <= parent.clientHeight || !/^(auto|scroll)$/.test(win.getComputedStyle(parent).overflowY)) continue;
      const box = parent.getBoundingClientRect(), target = field.getBoundingClientRect();
      const upper = Math.max(box.top + 8, top), lower = Math.min(box.bottom - 8, bottom);
      if (lower <= upper) continue;
      const delta = target.top < upper ? target.top - upper : target.bottom > lower ? Math.min(target.top - upper, target.bottom - lower) : 0;
      if (delta) parent.scrollTop += delta;
    }
    const rect = field.getBoundingClientRect();
    if (motionTimer !== undefined && (rect.top < top || rect.bottom > bottom)) revealFrame = win.requestAnimationFrame(() => reveal(value));
  };
  const schedule = () => { if (!stopped && !frame) frame = win.requestAnimationFrame(update); };
  /** Overlay keyboards report their end-state height once per change. A repeat
   * (did-show, same IME) changes nothing, so a form the reader has scrolled is
   * not pulled back. */
  const keyboardFrame = (report: KeyboardReport | undefined) => {
    const next = Number.isFinite(report?.height) ? Math.max(0, report!.height!) : 0;
    if (next === nativeKeyboardHeight) return false;
    nativeKeyboardHeight = next; nativeKeyboard = revealPending = next > 0;
    motionSentAt = Number.isFinite(report?.at) ? report!.at : undefined;
    reportedDuration = Number.isFinite(report?.duration) ? Math.min(1000, Math.max(0, report!.duration!)) : undefined;
    return true;
  };
  // NativeInsets (Android) and KeyboardInsets (iOS) share this overlap contract.
  const insetEvent = (event: Event) => { if (keyboardFrame((event as CustomEvent<KeyboardReport>).detail)) schedule(); };
  // A keyboard that stays open does not report again when focus moves on.
  const focusIn = (event: FocusEvent) => { if (nativeKeyboard && (event.target as Element | null)?.matches?.(textField)) { revealPending = true; schedule(); } };
  win.addEventListener('resize', schedule); visual?.addEventListener('resize', schedule); visual?.addEventListener('scroll', schedule); coarse.addEventListener('change', schedule);
  if (motion) {
    win.addEventListener('tarobot-keyboard', insetEvent); doc.addEventListener('focusin', focusIn);
    keyboardFrame((win as Window & { __tarobotKeyboard?: KeyboardReport }).__tarobotKeyboard);
  }
  update();
  return {
    async attachKeyboard(keyboard: KeyboardEvents): Promise<void> {
      if (stopped) return;
      for (const event of ['keyboardWillShow', 'keyboardDidShow', 'keyboardWillHide', 'keyboardDidHide'] as const) {
        if (stopped) return;
        const handle = await keyboard.addListener(event, info => {
          if (stopped) return;
          const shown = event.endsWith('Show');
          if (motion) { if (keyboardFrame({ height: shown ? info?.keyboardHeight : 0 })) schedule(); return; }
          nativeKeyboard = shown;
          schedule();
        });
        if (stopped) await handle.remove(); else handles.push(handle);
      }
    },
    dispose() {
      stopped = true;
      if (frame) win.cancelAnimationFrame(frame);
      if (revealFrame) win.cancelAnimationFrame(revealFrame);
      clearTimeout(motionTimer);
      win.removeEventListener('resize', schedule); visual?.removeEventListener('resize', schedule); visual?.removeEventListener('scroll', schedule); coarse.removeEventListener('change', schedule);
      if (motion) { win.removeEventListener('tarobot-keyboard', insetEvent); doc.removeEventListener('focusin', focusIn); }
      for (const handle of handles) void handle.remove().catch(() => undefined);
      set('--app-height', previous.height); set('--app-top', previous.top); set('--keyboard-motion', previous.motion);
      root.removeAttribute('data-keyboard-motion');
      if (previous.keyboard === null) root.removeAttribute('data-keyboard-open'); else root.setAttribute('data-keyboard-open', previous.keyboard);
      if (previous.resize === null) root.removeAttribute('data-keyboard-resize'); else root.setAttribute('data-keyboard-resize', previous.resize);
    },
  };
}
