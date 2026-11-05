import { Capacitor, registerPlugin } from "@capacitor/core";
import { AndroidUpdateController, type AndroidUpdateBridge } from "./android-update-controller.js";
export const isAndroidUpdater = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
export const androidUpdater = new AndroidUpdateController(registerPlugin<AndroidUpdateBridge>("TaroBotAndroidUpdater"));
let users = 0;
let stop: (() => void) | undefined;
export function startAndroidUpdateChecks() {
  if (!isAndroidUpdater()) return () => undefined;
  if (++users === 1) {
    let live = true;
    const listener = androidUpdater.bridge.addListener("state", state => { if (live) androidUpdater.receive(state); }).catch(() => undefined);
    void androidUpdater.refresh().then(() => { const state = androidUpdater.snapshot(); if (live && state.configured && state.authenticated && !state.downloaded) void androidUpdater.check(); });
    const timer = setInterval(() => { if (!["downloading", "verifying", "install-pending"].includes(androidUpdater.snapshot().phase)) void androidUpdater.check(); }, 86_400_000);
    stop = () => { live = false; clearInterval(timer); void listener.then(value => value?.remove()).catch(() => undefined); };
  }
  let closed = false;
  return () => { if (!closed) { closed = true; if (--users === 0) { stop?.(); stop = undefined; } } };
}
