/** Remote screen keyboard model. Pure and browser-safe (no imports), shared by
 * the viewer UI and the target services. Codes are W3C `KeyboardEvent.code`
 * values, i.e. key positions: the target's own keyboard layout decides which
 * character a position types. For a macOS target they are Mac keys (Meta =
 * Command, Alt = Option); for a Windows target Meta is the Windows key. A
 * controller maps its codes for the target platform with
 * `screenControllerCode` BEFORE sending. */

/** Target (controlled computer) platforms, as `status.desktop.platform` reports
 * them. A new target platform joins this list together with its negotiated
 * protocol value, key mapping and shortcuts. */
export const SCREEN_TARGET_PLATFORMS = Object.freeze(['macos', 'windows'] as const);
export type ScreenTargetPlatform = typeof SCREEN_TARGET_PLATFORMS[number];
/** The controller's own keyboard, which produced the `KeyboardEvent.code`. */
export type ScreenControllerPlatform = 'mac' | 'windows';
function forTarget<T>(table: Readonly<Record<ScreenTargetPlatform, T>>, target: ScreenTargetPlatform): T {
  if (!Object.hasOwn(table, target)) throw new Error('screen_target_platform_unknown');
  return table[target];
}

/** HIToolbox virtual key codes (ANSI positions). */
export const SCREEN_MAC_KEYCODES: Readonly<Record<string, number>> = Object.freeze({
  KeyA: 0x00, KeyS: 0x01, KeyD: 0x02, KeyF: 0x03, KeyH: 0x04, KeyG: 0x05, KeyZ: 0x06, KeyX: 0x07, KeyC: 0x08, KeyV: 0x09,
  KeyB: 0x0b, KeyQ: 0x0c, KeyW: 0x0d, KeyE: 0x0e, KeyR: 0x0f, KeyY: 0x10, KeyT: 0x11, KeyO: 0x1f, KeyU: 0x20, KeyI: 0x22,
  KeyP: 0x23, KeyL: 0x25, KeyJ: 0x26, KeyK: 0x28, KeyN: 0x2d, KeyM: 0x2e,
  Digit1: 0x12, Digit2: 0x13, Digit3: 0x14, Digit4: 0x15, Digit6: 0x16, Digit5: 0x17, Digit9: 0x19, Digit7: 0x1a, Digit8: 0x1c, Digit0: 0x1d,
  Equal: 0x18, Minus: 0x1b, BracketRight: 0x1e, BracketLeft: 0x21, Quote: 0x27, Semicolon: 0x29, Backslash: 0x2a,
  Comma: 0x2b, Slash: 0x2c, Period: 0x2f, Backquote: 0x32, IntlBackslash: 0x0a,
  Enter: 0x24, Tab: 0x30, Space: 0x31, Backspace: 0x33, Escape: 0x35, Delete: 0x75, Insert: 0x72,
  Home: 0x73, End: 0x77, PageUp: 0x74, PageDown: 0x79,
  ArrowLeft: 0x7b, ArrowRight: 0x7c, ArrowDown: 0x7d, ArrowUp: 0x7e,
  MetaRight: 0x36, MetaLeft: 0x37, ShiftLeft: 0x38, CapsLock: 0x39, AltLeft: 0x3a, ControlLeft: 0x3b,
  ShiftRight: 0x3c, AltRight: 0x3d, ControlRight: 0x3e,
  F1: 0x7a, F2: 0x78, F3: 0x63, F4: 0x76, F5: 0x60, F6: 0x61, F7: 0x62, F8: 0x64, F9: 0x65, F10: 0x6d, F11: 0x67, F12: 0x6f,
  F13: 0x69, F14: 0x6b, F15: 0x71, F16: 0x6a, F17: 0x40, F18: 0x4f, F19: 0x50,
  Numpad0: 0x52, Numpad1: 0x53, Numpad2: 0x54, Numpad3: 0x55, Numpad4: 0x56, Numpad5: 0x57, Numpad6: 0x58, Numpad7: 0x59,
  Numpad8: 0x5b, Numpad9: 0x5c, NumpadDecimal: 0x41, NumpadMultiply: 0x43, NumpadAdd: 0x45, NumpadDivide: 0x4b,
  NumpadEnter: 0x4c, NumpadSubtract: 0x4e, NumpadEqual: 0x51, NumLock: 0x47,
});

/** Set in a Windows key descriptor for an extended (E0-prefixed) key. */
export const SCREEN_WINDOWS_EXTENDED = 0x100;
const E0 = SCREEN_WINDOWS_EXTENDED;
/** Windows keys as Set 1 scan codes, for `SendInput` with `KEYEVENTF_SCANCODE`
 * (`| SCREEN_WINDOWS_EXTENDED` adds `KEYEVENTF_EXTENDEDKEY`). A scan code is a
 * position, like the Mac codes above, so the two tables name the same keys and
 * every code the protocol accepts has an entry in both. The values are the
 * `win` column of Chromium's `dom_code_data.inc`, the public table from which
 * Chrome Remote Desktop injects keys the same way (high byte E0 = extended).
 * Num Lock is the exception: that table lists it as E0 45, but injected that
 * way it does not toggle (measured on Windows 11); plain 0x45 does, and maps to
 * VK_NUMLOCK. Pause, plain 0x45 in that table, is not a key this protocol sends. */
export const SCREEN_WINDOWS_SCANCODES: Readonly<Record<string, number>> = Object.freeze({
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyH: 0x23, KeyG: 0x22, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f,
  KeyB: 0x30, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyY: 0x15, KeyT: 0x14, KeyO: 0x18, KeyU: 0x16, KeyI: 0x17,
  KeyP: 0x19, KeyL: 0x26, KeyJ: 0x24, KeyK: 0x25, KeyN: 0x31, KeyM: 0x32,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit6: 0x07, Digit5: 0x06, Digit9: 0x0a, Digit7: 0x08, Digit8: 0x09, Digit0: 0x0b,
  Equal: 0x0d, Minus: 0x0c, BracketRight: 0x1b, BracketLeft: 0x1a, Quote: 0x28, Semicolon: 0x27, Backslash: 0x2b,
  Comma: 0x33, Slash: 0x35, Period: 0x34, Backquote: 0x29, IntlBackslash: 0x56,
  Enter: 0x1c, Tab: 0x0f, Space: 0x39, Backspace: 0x0e, Escape: 0x01, Delete: E0 | 0x53, Insert: E0 | 0x52,
  Home: E0 | 0x47, End: E0 | 0x4f, PageUp: E0 | 0x49, PageDown: E0 | 0x51,
  ArrowLeft: E0 | 0x4b, ArrowRight: E0 | 0x4d, ArrowDown: E0 | 0x50, ArrowUp: E0 | 0x48,
  MetaRight: E0 | 0x5c, MetaLeft: E0 | 0x5b, ShiftLeft: 0x2a, CapsLock: 0x3a, AltLeft: 0x38, ControlLeft: 0x1d,
  ShiftRight: 0x36, AltRight: E0 | 0x38, ControlRight: E0 | 0x1d,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, F11: 0x57, F12: 0x58,
  F13: 0x64, F14: 0x65, F15: 0x66, F16: 0x67, F17: 0x68, F18: 0x69, F19: 0x6a,
  Numpad0: 0x52, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, Numpad7: 0x47,
  Numpad8: 0x48, Numpad9: 0x49, NumpadDecimal: 0x53, NumpadMultiply: 0x37, NumpadAdd: 0x4e, NumpadDivide: E0 | 0x35,
  NumpadEnter: E0 | 0x1c, NumpadSubtract: 0x4a, NumpadEqual: 0x59, NumLock: 0x45,
});

/** CGEventFlags. Device bits (low word) let apps tell left from right modifiers. */
export const SCREEN_FLAG = Object.freeze({
  capsLock: 0x00010000, shift: 0x00020000, control: 0x00040000, option: 0x00080000, command: 0x00100000,
  numericPad: 0x00200000, secondaryFn: 0x00800000,
});
export const SCREEN_MODIFIERS: Readonly<Record<string, { flag: number; device: number }>> = Object.freeze({
  ControlLeft: { flag: SCREEN_FLAG.control, device: 0x0001 }, ControlRight: { flag: SCREEN_FLAG.control, device: 0x2000 },
  ShiftLeft: { flag: SCREEN_FLAG.shift, device: 0x0002 }, ShiftRight: { flag: SCREEN_FLAG.shift, device: 0x0004 },
  MetaLeft: { flag: SCREEN_FLAG.command, device: 0x0008 }, MetaRight: { flag: SCREEN_FLAG.command, device: 0x0010 },
  AltLeft: { flag: SCREEN_FLAG.option, device: 0x0020 }, AltRight: { flag: SCREEN_FLAG.option, device: 0x0040 },
});
/** Hardware keyboards stamp these on arrow/navigation/function keys; some apps check them. */
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp']);
const FN = new Set(['Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert', ...Array.from({ length: 19 }, (_, i) => `F${i + 1}`)]);
export function screenKeyExtraFlags(code: string): number {
  if (ARROWS.has(code)) return SCREEN_FLAG.numericPad | SCREEN_FLAG.secondaryFn;
  if (FN.has(code)) return SCREEN_FLAG.secondaryFn;
  return code.startsWith('Numpad') || code === 'NumLock' ? SCREEN_FLAG.numericPad : 0;
}
export function screenIsModifier(code: string): boolean { return Object.hasOwn(SCREEN_MODIFIERS, code); }

/** How the modifiers of a controller keyboard of the other kind reach the target.
 * `command`: the main shortcut modifier stays the main one. Windows keyboard →
 * Mac: Ctrl→⌘ and Win→⌃ (Ctrl+C keeps copying). Mac keyboard → Windows: ⌘→Ctrl
 * and ⌃→Win (⌘C keeps copying).
 * `physical`: no remapping (Ctrl stays Control, Win/⌘ stays Meta). Alt is
 * Option in both. A keyboard of the target's own kind is never remapped. */
export type ScreenModifierMode = 'command' | 'physical';
const COMMAND_MODE: Readonly<Record<string, string>> = Object.freeze({
  ControlLeft: 'MetaLeft', ControlRight: 'MetaRight', MetaLeft: 'ControlLeft', MetaRight: 'ControlRight',
});
type ControllerCode = (code: string, controller: ScreenControllerPlatform, mode: ScreenModifierMode) => string;
const TARGET_CODES: Readonly<Record<ScreenTargetPlatform, ControllerCode>> = Object.freeze({
  // A macOS target receives Mac keys; only a Windows keyboard in `command` mode swaps Ctrl and Win.
  macos: (code, controller, mode) => controller === 'windows' && mode === 'command' ? COMMAND_MODE[code] ?? code : code,
  // A Windows target receives Windows keys; only a Mac keyboard in `command` mode swaps ⌘ and ⌃.
  windows: (code, controller, mode) => controller === 'mac' && mode === 'command' ? COMMAND_MODE[code] ?? code : code,
});
/** Whether `ScreenModifierMode` changes anything: only when the controller's
 * keyboard is not of the target's kind. */
export function screenModifierModeApplies(controller: ScreenControllerPlatform, target: ScreenTargetPlatform = 'macos'): boolean {
  if (!Object.hasOwn(TARGET_CODES, target)) throw new Error('screen_target_platform_unknown');
  return (controller === 'windows') !== (target === 'windows');
}
/** The code to send for `code` pressed on the controller's keyboard, for the
 * target platform being controlled (macOS unless stated). */
export function screenControllerCode(code: string, controller: ScreenControllerPlatform, mode: ScreenModifierMode = 'command', target: ScreenTargetPlatform = 'macos'): string {
  return forTarget(TARGET_CODES, target)(code, controller, mode);
}

export type ScreenShortcut = { id: string; codes: readonly string[]; label: { zh: string; en: string; ja: string } & Partial<Record<string, string>> };
/** Mac shortcuts the controller's own OS would intercept. The UI sends these as
 * explicit key sequences: modifiers down in order, key down/up, modifiers up reversed. */
export const SCREEN_SHORTCUTS: ReadonlyArray<ScreenShortcut> = Object.freeze([
  { id: 'escape', codes: ['Escape'], label: { zh: 'Esc', en: 'Esc', ja: 'Esc' } },
  { id: 'app-switcher', codes: ['MetaLeft', 'Tab'], label: { zh: '切换应用 ⌘Tab', en: 'Switch app ⌘Tab', ja: 'アプリ切替 ⌘Tab' } },
  { id: 'spotlight', codes: ['MetaLeft', 'Space'], label: { zh: '聚焦搜索 ⌘空格', en: 'Spotlight ⌘Space', ja: 'Spotlight ⌘Space' } },
  { id: 'input-source', codes: ['ControlLeft', 'Space'], label: { zh: '切换输入法 ⌃空格', en: 'Input source ⌃Space', ja: '入力ソース ⌃Space' } },
  { id: 'force-quit', codes: ['MetaLeft', 'AltLeft', 'Escape'], label: { zh: '强制退出 ⌘⌥Esc', en: 'Force Quit ⌘⌥Esc', ja: '強制終了 ⌘⌥Esc' } },
  { id: 'quit-app', codes: ['MetaLeft', 'KeyQ'], label: { zh: '退出应用 ⌘Q', en: 'Quit app ⌘Q', ja: 'アプリ終了 ⌘Q' } },
  { id: 'close-window', codes: ['MetaLeft', 'KeyW'], label: { zh: '关闭窗口 ⌘W', en: 'Close window ⌘W', ja: 'ウィンドウを閉じる ⌘W' } },
  { id: 'hide-app', codes: ['MetaLeft', 'KeyH'], label: { zh: '隐藏应用 ⌘H', en: 'Hide app ⌘H', ja: '非表示 ⌘H' } },
  { id: 'mission-control', codes: ['ControlLeft', 'ArrowUp'], label: { zh: '调度中心 ⌃↑', en: 'Mission Control ⌃↑', ja: 'Mission Control ⌃↑' } },
  { id: 'show-desktop', codes: ['MetaLeft', 'F3'], label: { zh: '显示桌面 ⌘F3', en: 'Show desktop ⌘F3', ja: 'デスクトップ ⌘F3' } },
]);
/** Windows shortcuts the controller's own OS would intercept. A button sends
 * key positions, and the target's layout decides what a letter, digit or
 * punctuation position means: on an AZERTY target the W position is Z. So this
 * list holds only keys every layout keeps in place (Esc, Tab, Space, function
 * keys, modifiers), and each button does what its label says on any layout.
 * Letter shortcuts such as Win+D or Ctrl+W are deliberately not offered here.
 * Nothing that opens an elevated window (which then refuses remote input), and
 * never the secure attention sequence. */
export const SCREEN_WINDOWS_SHORTCUTS: ReadonlyArray<ScreenShortcut> = Object.freeze([
  { id: 'escape', codes: ['Escape'], label: { zh: 'Esc', en: 'Esc', ja: 'Esc' } },
  { id: 'app-switcher', codes: ['AltLeft', 'Tab'], label: { zh: '切换窗口 Alt+Tab', en: 'Switch window Alt+Tab', ja: 'ウィンドウ切替 Alt+Tab' } },
  { id: 'start-menu', codes: ['MetaLeft'], label: { zh: '开始菜单 Win', en: 'Start menu Win', ja: 'スタート Win' } },
  { id: 'task-view', codes: ['MetaLeft', 'Tab'], label: { zh: '任务视图 Win+Tab', en: 'Task view Win+Tab', ja: 'タスクビュー Win+Tab' } },
  { id: 'input-source', codes: ['MetaLeft', 'Space'], label: { zh: '切换输入法 Win+空格', en: 'Input language Win+Space', ja: '入力切替 Win+Space' } },
  { id: 'close-window', codes: ['AltLeft', 'F4'], label: { zh: '关闭窗口 Alt+F4', en: 'Close window Alt+F4', ja: '閉じる Alt+F4' } },
  { id: 'close-tab', codes: ['ControlLeft', 'F4'], label: { zh: '关闭标签页 Ctrl+F4', en: 'Close tab Ctrl+F4', ja: 'タブを閉じる Ctrl+F4' } },
]);
const TARGET_SHORTCUTS: Readonly<Record<ScreenTargetPlatform, ReadonlyArray<ScreenShortcut>>> = Object.freeze({ macos: SCREEN_SHORTCUTS, windows: SCREEN_WINDOWS_SHORTCUTS });
/** The explicit shortcut list offered when controlling a `target` computer. */
export function screenShortcuts(target: ScreenTargetPlatform = 'macos'): ReadonlyArray<ScreenShortcut> {
  return forTarget(TARGET_SHORTCUTS, target);
}
/** Expands a shortcut into ordered key events (down…, up reversed). */
export function screenShortcutEvents(codes: readonly string[]): { code: string; down: boolean }[] {
  if (!codes.length || codes.length > 4 || codes.some(code => !Object.hasOwn(SCREEN_MAC_KEYCODES, code))) throw new Error('screen_shortcut_invalid');
  return [...codes.map(code => ({ code, down: true })), ...[...codes].reverse().map(code => ({ code, down: false }))];
}

/** W3C wheel deltas (pixels, deltaY > 0 scrolls content down) to CGScrollWheel
 * pixel deltas (wheel1 > 0 scrolls up). Line/page modes are converted by the UI. */
export function screenWheelToMac(dx: number, dy: number): { wheel1: number; wheel2: number } {
  const clamp = (v: number) => Math.max(-2000, Math.min(2000, Math.round(v)));
  return { wheel1: clamp(-dy), wheel2: clamp(-dx) };
}

/** `WHEEL_DELTA` units per W3C pixel on a Windows target: one wheel notch (120)
 * for the 100 px a Chromium page reports for one notch. */
export const SCREEN_WINDOWS_WHEEL_PER_PIXEL = 1.2;
export const SCREEN_WINDOWS_WHEEL_MAX = 2400;
/** W3C wheel deltas (pixels) to `MOUSEEVENTF_WHEEL` / `MOUSEEVENTF_HWHEEL`
 * amounts. Windows counts the other way vertically (positive = away from the
 * user = content up) and the same way horizontally (positive = right). Amounts
 * are whole numbers; `carry` is the fraction not yet sent, to be passed back
 * with the next delta so slow scrolling is not rounded away. */
export function screenWheelToWindows(dx: number, dy: number, carry: { vertical: number; horizontal: number } = { vertical: 0, horizontal: 0 }):
  { vertical: number; horizontal: number; carry: { vertical: number; horizontal: number } } {
  // Millionths of a unit: sums of decimal fractions must not drift below a whole unit.
  const exactly = (value: number) => Math.round(value * 1e6) / 1e6;
  const step = (pixels: number, rest: number) => {
    if (!pixels) return { whole: 0, rest };  // this axis did not move: what it is owed stays owed
    const exact = exactly(pixels * SCREEN_WINDOWS_WHEEL_PER_PIXEL + (Math.sign(rest) === Math.sign(pixels) ? rest : 0));
    const whole = Math.max(-SCREEN_WINDOWS_WHEEL_MAX, Math.min(SCREEN_WINDOWS_WHEEL_MAX, Math.trunc(exact)));
    return { whole: whole || 0, rest: Math.abs(exact) > SCREEN_WINDOWS_WHEEL_MAX ? 0 : exactly(exact - whole) };
  };
  const vertical = step(-dy, carry.vertical), horizontal = step(dx, carry.horizontal);
  return { vertical: vertical.whole, horizontal: horizontal.whole, carry: { vertical: vertical.rest, horizontal: horizontal.rest } };
}
