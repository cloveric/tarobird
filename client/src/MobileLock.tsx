import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { LockKeyhole, LoaderCircle } from "lucide-react";
import { LockController } from "./lock-controller.js";
import { t, useLocale, setLocale } from "./i18n.js";
import { HostRegistry } from "./host-registry.js";
import { nativeDevice } from "./native-device.js";
import { deviceStorageErrorMessage } from "./connection-verification.js";

const lockError = (error: string) => deviceStorageErrorMessage(error) ?? t("无法完成设备安全验证，请解锁设备后重试。应用数据仍受保护。");

const lock = new LockController({
  load: async () => (await nativeDevice().getLock()).enabled,
  save: async (enabled) => { await nativeDevice().setLock({ enabled }); },
  available: async () => { const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth"); const result = await BiometricAuth.checkBiometry(); return result.strongBiometryIsAvailable || result.deviceIsSecure; },
  authenticate: async () => { const { BiometricAuth, AndroidBiometryStrength } = await import("@aparajita/capacitor-biometric-auth"); await BiometricAuth.checkBiometry(); await BiometricAuth.authenticate({ reason: t("验证身份以打开 TaroBird"), cancelTitle: t("取消"), allowDeviceCredential: true, androidTitle: "TaroBird", androidBiometryStrength: AndroidBiometryStrength.strong }); },
  active: async () => (await (await import("@capacitor/app")).App.getState()).isActive,
  privacy: async (enabled) => { const { PrivacyScreen } = await import("@capacitor/privacy-screen"); const result = enabled ? await PrivacyScreen.enable({ android: { dimBackground: false, privacyModeOnActivityHidden: "none" }, ios: { blurEffect: "none" } }) : await PrivacyScreen.disable(); if (!result.success) throw new Error(t("无法设置后台隐私遮罩")); },
});
export function MobileLock({ children }: { children: ReactNode }) {
  useLocale(); const native = Capacitor.isNativePlatform(); const state = useSyncExternalStore(lock.subscribe, lock.snapshot); const opened = useRef(false);
  const hidden = native && (!state.ready || state.locked); if (!hidden) opened.current = true;
  useEffect(() => { if (!native) return; let disposed = false; let remove: (() => void) | undefined;
    const registry = new HostRegistry();
    void registry.preferences().then((preferences) => { if (!disposed) setLocale(preferences.locale); }).catch(() => undefined).finally(() => registry.close());
    void lock.initialize();
    void import("@capacitor/app").then(async ({ App }) => { const listener = await App.addListener("appStateChange", ({ isActive }) => { if (!isActive) lock.background(); }); if (disposed) await listener.remove(); else remove = () => { void listener.remove(); }; });
    return () => { disposed = true; remove?.(); };
  }, [native]);
  useLayoutEffect(() => { document.documentElement.dataset.mobileLocked = hidden ? "true" : "false"; return () => { delete document.documentElement.dataset.mobileLocked; }; }, [hidden]);
  if (!native) return children;
  return <><div className="mobile-lock-content" hidden={hidden} inert={hidden} aria-hidden={hidden}>{opened.current ? children : null}</div>{hidden && <main className="app-lock-screen"><LockKeyhole size={36}/><h1>TaroBird</h1><p>{state.ready ? t("解锁后查看你的对话") : t("正在检查应用锁…")}</p><button className="primary" disabled={state.busy} onClick={() => { void (state.ready ? lock.unlock() : lock.initialize()); }}>{state.busy ? <LoaderCircle className="spin" size={18}/> : state.ready ? t("解锁") : t("重试")}</button>{state.error && <p role="alert" className="error-text">{lockError(state.error)}</p>}</main>}</>;
}
export function MobileLockSettings() {
  useLocale(); const state = useSyncExternalStore(lock.subscribe, lock.snapshot);
  if (!Capacitor.isNativePlatform()) return null;
  return <section><h3>{t("应用锁")}</h3><label className="settings-row"><span>{t("使用系统验证解锁")}</span><input type="checkbox" checked={state.enabled} disabled={state.busy || !state.ready || !state.enabled && !state.available} onChange={(event) => { void lock.setEnabled(event.target.checked); }}/></label><p className="muted">{t("离开应用后重新锁定，支持指纹、面容或设备密码。后台预览会被隐藏；安卓开启后也会阻止截屏。")}</p>{!state.available && <p className="muted">{t("请先在系统设置中启用设备密码或生物识别。")}</p>}{state.enabled && <button onClick={() => lock.lock()}>{t("立即锁定")}</button>}{state.error && <p role="alert" className="error-text">{lockError(state.error)}</p>}</section>;
}
