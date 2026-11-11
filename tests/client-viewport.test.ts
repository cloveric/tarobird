import { afterEach, describe, expect, it, vi } from 'vitest';
import { appViewport, hasWindowKeyboardInsets, installAppViewport, nativeKeyboardMotion, type KeyboardEvents } from '../client/src/viewport.js';

/** Minimal window/document for the controller: frames run only on demand. */
function fakeViewport(height = 839, visual: (EventTarget & { height: number; offsetTop: number; scale: number }) | null = null) {
  const properties = new Map<string, string>(), attributes = new Map<string, string>();
  const root = { style: { getPropertyValue: (key: string) => properties.get(key) ?? '', setProperty: (key: string, value: string) => properties.set(key, value), removeProperty: (key: string) => properties.delete(key) }, getAttribute: (key: string) => attributes.get(key) ?? null, setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key), hasAttribute: (key: string) => attributes.has(key) };
  const frames: FrameRequestCallback[] = [];
  const media = Object.assign(new EventTarget(), { matches: true });
  const win = Object.assign(new EventTarget(), { innerWidth: 400, innerHeight: height, visualViewport: visual, matchMedia: () => media, requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback), cancelAnimationFrame: () => undefined });
  const doc = Object.assign(new EventTarget(), { documentElement: root, activeElement: null });
  const flush = () => { for (const callback of frames.splice(0)) callback(0); };
  const pending = () => frames.length;
  const keyboard = (height: number, at?: number, duration?: number) => win.dispatchEvent(Object.assign(new Event('tarobot-keyboard'), { detail: { height, at, duration } }));
  const resize = (next: number) => { win.innerHeight = next; win.dispatchEvent(new Event('resize')); };
  return { win: win as unknown as Window, doc: doc as unknown as Document, properties, attributes, flush, frames: pending, keyboard, resize };
}

describe('mobile available viewport', () => {
  it('fits visual-only keyboard occlusion and clamps the top into visible bounds', () => {
    expect(appViewport({ width: 390, height: 844, coarse: true, visibleHeight: 500, offsetTop: 24, scale: 1 })).toEqual({ height: 500, top: 24, keyboard: true });
    expect(appViewport({ width: 390, height: 844, coarse: true, visibleHeight: 500, offsetTop: 900, scale: 1 })?.top).toBe(344);
  });
  it('does not subtract twice when native resize already reduced the WebView', () => {
    expect(appViewport({ width: 390, height: 500, coarse: true, visibleHeight: 500, nativeKeyboard: true })).toEqual({ height: 500, top: 0, keyboard: true });
  });
  it('uses iOS overlay keyboard height immediately, without waiting for WebView resize', () => {
    const full = { width: 430, height: 932, coarse: true, visibleHeight: 932, scale: 1 };
    expect(appViewport({ ...full, nativeKeyboard: true, nativeKeyboardHeight: 350 })).toEqual({ height: 582, top: 0, keyboard: true });
    // Some WebKit versions also shrink visualViewport; take the intersection.
    expect(appViewport({ ...full, visibleHeight: 582, offsetTop: 50, nativeKeyboard: true, nativeKeyboardHeight: 350 })).toEqual({ height: 582, top: 0, keyboard: true });
    expect(appViewport({ ...full, nativeKeyboardHeight: 0 })).toEqual({ height: 932, top: 0, keyboard: false });
    expect(appViewport({ ...full, nativeKeyboardHeight: NaN })).toEqual({ height: 932, top: 0, keyboard: false });
  });
  it('preserves zoom, normal desktop layout and invalid geometry', () => {
    expect(appViewport({ width: 390, height: 844, coarse: true, visibleHeight: 422, scale: 2 })).toBeUndefined();
    expect(appViewport({ width: 1360, height: 500, coarse: false, visibleHeight: 500 })).toBeUndefined();
    expect(appViewport({ width: 390, height: NaN, coarse: true })).toBeUndefined();
    expect(appViewport({ width: 390, height: 844, coarse: true, visibleHeight: NaN, offsetTop: -30 })).toEqual({ height: 844, top: 0, keyboard: false });
  });
  it('supports wide touch screens without interpreting browser toolbar changes as a keyboard', () => {
    expect(appViewport({ width: 844, height: 390, coarse: true, visibleHeight: 340 })).toEqual({ height: 340, top: 0, keyboard: false });
    expect(appViewport({ width: 844, height: 260, coarse: true, nativeKeyboard: true })?.keyboard).toBe(true);
  });
  it('removes late native listeners and prevents events after teardown from restoring layout state', async () => {
    const properties = new Map<string, string>(), attributes = new Map<string, string>();
    const root = { style: { getPropertyValue: (key: string) => properties.get(key) ?? '', setProperty: (key: string, value: string) => properties.set(key, value), removeProperty: (key: string) => properties.delete(key) }, getAttribute: (key: string) => attributes.get(key) ?? null, setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key) };
    const media = Object.assign(new EventTarget(), { matches: true });
    const win = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 844, visualViewport: null, matchMedia: () => media, requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() }) as unknown as Window;
    const controller = installAppViewport(win, { documentElement: root } as unknown as Document);
    expect(properties.get('--app-height')).toBe('844px');
    let release!: (handle: { remove(): Promise<void> }) => void, callback!: () => void;
    const remove = vi.fn(async () => undefined);
    const keyboard: KeyboardEvents = { addListener: vi.fn<KeyboardEvents['addListener']>(async (_event, listener) => { callback = listener; return new Promise(resolve => { release = resolve; }); }) };
    const pending = controller.attachKeyboard(keyboard); controller.dispose(); release({ remove }); await pending;
    callback(); win.dispatchEvent(new Event('resize'));
    expect(remove).toHaveBeenCalledOnce(); expect(keyboard.addListener).toHaveBeenCalledOnce();
    expect(properties.size).toBe(0); expect(attributes.size).toBe(0); expect(win.requestAnimationFrame).not.toHaveBeenCalled();
  });
});

describe('native overlay keyboard motion', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('follows the Android IME end state with its timing, compensating bridge latency', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const view = fakeViewport();
    const controller = installAppViewport(view.win, view.doc, nativeKeyboardMotion.android);
    expect(view.attributes.get('data-keyboard-resize')).toBe('overlay');
    view.keyboard(312, 10_000 - 24); view.flush();
    expect(view.properties.get('--app-height')).toBe('527px');
    expect(view.attributes.get('data-keyboard-open')).toBe('true');
    expect(view.attributes.has('data-keyboard-motion')).toBe(true);
    expect(view.properties.get('--keyboard-motion')).toBe('285ms cubic-bezier(.2,0,0,1) -24ms');
    // The motion window ends after the remaining duration; later changes are instant.
    vi.advanceTimersByTime(285 - 24 + 99); expect(view.attributes.has('data-keyboard-motion')).toBe(true);
    vi.advanceTimersByTime(1); expect(view.attributes.has('data-keyboard-motion')).toBe(false);
    view.keyboard(0, Date.now() - 2); view.flush();
    expect(view.properties.get('--app-height')).toBe('839px');
    expect(view.attributes.get('data-keyboard-open')).toBe('false');
    expect(view.properties.get('--keyboard-motion')).toBe('285ms cubic-bezier(.2,0,0,1) -2ms');
    controller.dispose();
    expect(view.attributes.size).toBe(0); expect(view.properties.size).toBe(0);
  });

  it('applies stale, repeated and restored reports without replaying motion', () => {
    vi.useFakeTimers(); vi.setSystemTime(50_000);
    const view = fakeViewport();
    // The page already holds the IME state (React remount, reload): no motion.
    (view.win as Window & { __tarobotKeyboard?: unknown }).__tarobotKeyboard = { height: 300, at: 40_000 };
    const controller = installAppViewport(view.win, view.doc, nativeKeyboardMotion.android);
    expect(view.properties.get('--app-height')).toBe('539px');
    expect(view.attributes.has('data-keyboard-motion')).toBe(false);
    // A report older than the OS animation (blocked JS, resume) lands at once.
    view.keyboard(0, 50_000 - 5_000); view.flush();
    expect(view.properties.get('--app-height')).toBe('839px');
    expect(view.attributes.has('data-keyboard-motion')).toBe(false);
    // A late but current report starts that far into the transition, unclamped.
    view.keyboard(300, 50_000 - 200); view.flush();
    expect(view.properties.get('--keyboard-motion')).toBe('285ms cubic-bezier(.2,0,0,1) -200ms');
    vi.advanceTimersByTime(1_000); view.flush();
    // The same height again (did-show, focus moved) schedules nothing.
    view.keyboard(300, Date.now()); expect(view.frames()).toBe(0);
    expect(view.attributes.has('data-keyboard-motion')).toBe(false);
    controller.dispose();
  });

  it('ends a running keyboard transition when the window itself changes', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const view = fakeViewport(932);
    const controller = installAppViewport(view.win, view.doc, nativeKeyboardMotion.android);
    view.keyboard(300, 10_000); view.flush();
    expect(view.attributes.has('data-keyboard-motion')).toBe(true);
    // Rotation or split view inside the 285 ms window: no borrowed transition.
    view.resize(600); view.flush();
    expect(view.properties.get('--app-height')).toBe('300px');
    expect(view.attributes.has('data-keyboard-motion')).toBe(false);
    // A keyboard change coalesced with a window change also applies at once.
    view.resize(932); view.keyboard(0, Date.now()); view.flush();
    expect(view.properties.get('--app-height')).toBe('932px');
    expect(view.attributes.has('data-keyboard-motion')).toBe(false);
    controller.dispose();
  });

  it('animates a visual-viewport correction that trails the keyboard event', async () => {
    vi.useFakeTimers();
    // If WebKit also shrank its visual viewport, the hide applies only when
    // that viewport grows back; it must still ease rather than jump.
    const visual = Object.assign(new EventTarget(), { height: 582, offsetTop: 0, scale: 1 });
    const view = fakeViewport(932, visual);
    const controller = installAppViewport(view.win, view.doc, true);
    const callbacks = new Map<string, (info?: { keyboardHeight: number }) => void>();
    await controller.attachKeyboard({ addListener: async (event, callback) => { callbacks.set(event, callback); return { remove: async () => undefined }; } });
    callbacks.get('keyboardWillShow')!({ keyboardHeight: 350 }); view.flush();
    vi.advanceTimersByTime(400); expect(view.attributes.has('data-keyboard-motion')).toBe(false);
    callbacks.get('keyboardWillHide')!(); view.flush();
    expect(view.properties.get('--app-height')).toBe('582px');
    expect(view.attributes.has('data-keyboard-motion')).toBe(true);
    visual.height = 932; visual.dispatchEvent(new Event('resize')); view.flush();
    expect(view.properties.get('--app-height')).toBe('932px');
    expect(view.attributes.has('data-keyboard-motion')).toBe(true);
    controller.dispose();
  });

  it('keeps the iOS Capacitor path and its default timing', async () => {
    const view = fakeViewport(932);
    const controller = installAppViewport(view.win, view.doc, true);
    const callbacks = new Map<string, (info?: { keyboardHeight: number }) => void>();
    await controller.attachKeyboard({ addListener: async (event, callback) => { callbacks.set(event, callback); return { remove: async () => undefined }; } });
    callbacks.get('keyboardWillShow')!({ keyboardHeight: 350 }); view.flush();
    expect(view.properties.get('--app-height')).toBe('582px');
    expect(view.properties.get('--keyboard-motion')).toBe('250ms ease-out 0ms');
    callbacks.get('keyboardWillHide')!(); view.flush();
    expect(view.properties.get('--app-height')).toBe('932px');
    controller.dispose();
  });
});


describe('window-relative iOS keyboard reports', () => {
  afterEach(() => vi.useRealTimers());
  it('uses a brisker native iOS ramp while preserving OS duration, bridge delay and end states', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const v = fakeViewport(932);
    Object.assign(v.win, { tarobotKeyboardInsets: { supported: () => true } });
    const c = installAppViewport(v.win, v.doc, nativeKeyboardMotion.ios);
    v.keyboard(350, 9_980, 383); v.flush();
    expect(v.properties.get('--app-height')).toBe('582px');
    expect(v.properties.get('--keyboard-motion')).toBe('383ms cubic-bezier(.2,.35,.45,1) -20ms');
    vi.advanceTimersByTime(383 - 20 + 100);
    expect(v.attributes.has('data-keyboard-motion')).toBe(false);
    v.keyboard(0, Date.now(), 383); v.flush();
    expect(v.properties.get('--app-height')).toBe('932px');
    expect(v.properties.get('--keyboard-motion')).toBe('383ms cubic-bezier(.2,.35,.45,1) 0ms');
    // Guide corrections still apply immediately, rather than borrowing motion.
    v.keyboard(280, Date.now(), 0); v.flush();
    expect(v.properties.get('--app-height')).toBe('652px');
    expect(v.attributes.has('data-keyboard-motion')).toBe(false);
    c.dispose();
  });
  it('requires explicit new-shell capability and leaves old or malformed shells on fallback', () => {
    for (const capability of [undefined, {}, { supported: () => false }, { supported: () => { throw Error('missing'); } }]) {
      expect(hasWindowKeyboardInsets({ tarobotKeyboardInsets: capability } as unknown as Window)).toBe(false);
    }
    expect(hasWindowKeyboardInsets({ tarobotKeyboardInsets: { supported: () => true } } as unknown as Window)).toBe(true);
  });
  it('uses OS timing once and applies guide/display corrections without lagging behind UIKit', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const v = fakeViewport(669);
    const c = installAppViewport(v.win,v.doc,nativeKeyboardMotion.ios);
    v.keyboard(280,9_980,180);v.flush();
    expect(v.properties.get('--app-height')).toBe('389px');
    expect(v.properties.get('--keyboard-motion')).toBe('180ms ease-out -20ms');
    expect(v.attributes.has('data-keyboard-motion')).toBe(true);
    v.keyboard(281,10_000,0);v.flush();
    expect(v.properties.get('--app-height')).toBe('388px');
    expect(v.attributes.has('data-keyboard-motion')).toBe(false);
    v.keyboard(0,10_000,0);v.flush();
    expect(v.properties.get('--app-height')).toBe('669px');
    c.dispose();
  });
  it('retains native keyboard avoidance on a wide window with a connected pointer', () => {
    const v = fakeViewport(669);
    Object.assign(v.win,{ innerWidth:951, tarobotKeyboardInsets:{supported:()=>true}, matchMedia:()=>Object.assign(new EventTarget(),{matches:false}) });
    const c = installAppViewport(v.win,v.doc,nativeKeyboardMotion.ios);
    v.keyboard(260,Date.now(),0);v.flush();
    expect(v.properties.get('--app-height')).toBe('409px');
    c.dispose();
  });
  it('does not change the existing wide fine-pointer Android path', () => {
    const v = fakeViewport(669);
    Object.assign(v.win,{ innerWidth:951, matchMedia:()=>Object.assign(new EventTarget(),{matches:false}) });
    const c = installAppViewport(v.win,v.doc,nativeKeyboardMotion.android);
    v.keyboard(260,Date.now(),0);v.flush();
    expect(v.properties.has('--app-height')).toBe(false);
    expect(v.attributes.get('data-keyboard-open')).toBe('false');
    c.dispose();
  });
});
