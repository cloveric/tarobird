/** Remote screen keyboard model. Pure and browser-safe (no imports), shared by
 * the viewer UI and the macOS target service. Codes are W3C `KeyboardEvent.code`
 * values interpreted as Mac keys: Meta = Command, Alt = Option, Control = Control.
 * A Windows controller remaps its codes with `screenControllerCode` BEFORE sending. */

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

/** How a non-Mac controller's physical modifiers reach the Mac.
 * `command`: Ctrl→⌘ and Win→⌃ (Windows shortcuts like Ctrl+C keep working).
 * `physical`: no remapping (Ctrl→⌃, Win→⌘). Alt is Option in both. */
export type ScreenModifierMode = 'command' | 'physical';
const COMMAND_MODE: Readonly<Record<string, string>> = Object.freeze({
  ControlLeft: 'MetaLeft', ControlRight: 'MetaRight', MetaLeft: 'ControlLeft', MetaRight: 'ControlRight',
});
export function screenControllerCode(code: string, platform: 'mac' | 'windows', mode: ScreenModifierMode = 'command'): string {
  return platform === 'windows' && mode === 'command' ? COMMAND_MODE[code] ?? code : code;
}

/** Mac shortcuts the controller's own OS would intercept. The UI sends these as
 * explicit key sequences: modifiers down in order, key down/up, modifiers up reversed. */
export const SCREEN_SHORTCUTS: ReadonlyArray<{ id: string; codes: readonly string[]; label: { zh: string; en: string } }> = Object.freeze([
  { id: 'escape', codes: ['Escape'], label: { zh: 'Esc', en: 'Esc' } },
  { id: 'app-switcher', codes: ['MetaLeft', 'Tab'], label: { zh: '切换应用 ⌘Tab', en: 'Switch app ⌘Tab' } },
  { id: 'spotlight', codes: ['MetaLeft', 'Space'], label: { zh: '聚焦搜索 ⌘空格', en: 'Spotlight ⌘Space' } },
  { id: 'input-source', codes: ['ControlLeft', 'Space'], label: { zh: '切换输入法 ⌃空格', en: 'Input source ⌃Space' } },
  { id: 'force-quit', codes: ['MetaLeft', 'AltLeft', 'Escape'], label: { zh: '强制退出 ⌘⌥Esc', en: 'Force Quit ⌘⌥Esc' } },
  { id: 'quit-app', codes: ['MetaLeft', 'KeyQ'], label: { zh: '退出应用 ⌘Q', en: 'Quit app ⌘Q' } },
  { id: 'close-window', codes: ['MetaLeft', 'KeyW'], label: { zh: '关闭窗口 ⌘W', en: 'Close window ⌘W' } },
  { id: 'hide-app', codes: ['MetaLeft', 'KeyH'], label: { zh: '隐藏应用 ⌘H', en: 'Hide app ⌘H' } },
  { id: 'mission-control', codes: ['ControlLeft', 'ArrowUp'], label: { zh: '调度中心 ⌃↑', en: 'Mission Control ⌃↑' } },
  { id: 'show-desktop', codes: ['MetaLeft', 'F3'], label: { zh: '显示桌面 ⌘F3', en: 'Show desktop ⌘F3' } },
]);
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
