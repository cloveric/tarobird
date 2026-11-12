import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { hasWindowKeyboardInsets, installAppViewport, nativeKeyboardMotion } from './viewport.js';
import { installIosKeyboardDismiss } from './ios-keyboard-dismiss.js';
import { expandedIphoneWindow } from './ios-window.js';
import { installExpandedIphoneKeyboardBar, loadNativeKeyboardAccessory } from './ios-keyboard-accessory.js';

export function MobileViewport() {
  useEffect(() => {
    // Both native shells overlay the keyboard instead of resizing the WebView.
    // New iOS shells report their window-relative overlap; old ones fall back
    // to Capacitor Keyboard. Android reports through NativeInsets,
    // whose height excludes the navigation bar the Activity already reserves.
    const platform = Capacitor.getPlatform();
    const dismiss = platform === 'ios' ? installIosKeyboardDismiss(document,
      () => expandedIphoneWindow(platform, navigator.userAgent, innerWidth, innerHeight)) : undefined;
    const accessory = platform === 'ios' ? installExpandedIphoneKeyboardBar(window, loadNativeKeyboardAccessory) : undefined;
    const viewport = installAppViewport(window, document, platform === 'ios' || platform === 'android' ? nativeKeyboardMotion[platform] : false);
    if (platform === 'ios' && !hasWindowKeyboardInsets(window)) void import('@capacitor/keyboard')
      .then(({ Keyboard }) => viewport.attachKeyboard(Keyboard))
      .catch(() => console.warn('native_keyboard_events_unavailable'));
    return () => { accessory?.(); dismiss?.(); viewport.dispose(); };
  }, []);
  return null;
}
