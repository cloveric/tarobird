import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { listenForAndroidBack } from "./back-navigation.js";

/** Mounted outside the lock and pairing UI so Back also works before login. */
export function NativeBackNavigation() {
  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    let disposed = false;
    let remove: (() => void) | undefined;
    void import("@capacitor/app").then(({ App }) => {
      if (!disposed) remove = listenForAndroidBack(App);
    }).catch(() => console.warn("native_back_unavailable"));
    return () => { disposed = true; remove?.(); };
  }, []);
  return null;
}
