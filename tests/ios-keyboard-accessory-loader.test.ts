import { expect, it, vi } from 'vitest';
import { loadNativeKeyboardAccessory } from '../client/src/ios-keyboard-accessory.js';

const native = vi.hoisted(() => ({ setAccessoryBarVisible: vi.fn(async () => {}), then: vi.fn() }));
vi.mock('../client/node_modules/@capacitor/keyboard', () => ({
  // Capacitor synthesizes a method for any property, including `then`.
  Keyboard: new Proxy({}, { get(_target, key) {
    if (key === 'then') return (resolve: (value: unknown) => void) => {
      native.then();
      // Settle deterministically so a broken loader fails without hanging.
      resolve({ setAccessoryBarVisible: native.setAccessoryBarVisible });
    };
    if (key === 'setAccessoryBarVisible') return native.setAccessoryBarVisible;
    return undefined;
  } }),
}));

it('loads a native accessory handle without assimilating the plugin proxy as a Promise', async () => {
  const keyboard = await loadNativeKeyboardAccessory();
  expect(native.then).not.toHaveBeenCalled();
  await keyboard.setAccessoryBarVisible({ isVisible: true });
  expect(native.setAccessoryBarVisible).toHaveBeenCalledExactlyOnceWith({ isVisible: true });
});
