import { Capacitor } from "@capacitor/core";
import { isDesktop, isElectron } from "./desktop-bridge.js";
import { nativeInvoke } from "./native-network.js";
import { allocateNativeScreen } from "./transport.js";
import { createMobileScreenViewerTransport } from "./screen-mobile-transport.js";
import { SCREEN_FLIGHT_MAX, SCREEN_FLIGHT_MIN } from "../../src/client-protocol/screen-quality.js";

export const isMobileScreenApp = () => !isDesktop() && ["ios", "android"].includes(Capacitor.getPlatform());
export const hasScreenViewer = () => isElectron() || isMobileScreenApp();
/** The most packets the native layer holds for this page at once. Undefined for
 * a native layer that cannot say (the call is missing or fails): it holds three
 * and accepts only the receipt it always did. Asked once. */
let mobileRtc: Promise<boolean> | undefined;
export const screenViewerRtcAvailable = () => isElectron() ? Promise.resolve(true)
  : isMobileScreenApp() ? mobileRtc ??= nativeInvoke<unknown>("net_screen_rtc").then(value => value === true, () => false)
  : Promise.resolve(false);
let nativeWindow: Promise<number | undefined> | undefined;
const mobileScreenWindow = () => nativeWindow ??= nativeInvoke<unknown>("net_screen_window").then(
  value => typeof value === "number" && Number.isInteger(value) && value >= SCREEN_FLIGHT_MIN ? Math.min(value, SCREEN_FLIGHT_MAX) : undefined, () => undefined);
/** How many frames this App can hold unacknowledged: what a viewer names on
 * `screenOpen({ flight })`, or undefined to name nothing. The Electron viewer
 * relays through its own main process, which takes the maximum. */
export const screenViewerFlight = (): Promise<number | undefined> => isMobileScreenApp() ? mobileScreenWindow() : Promise.resolve(SCREEN_FLIGHT_MAX);
export const mobileScreenViewerTransport = createMobileScreenViewerTransport({ window: mobileScreenWindow, allocate: async () => {
  try { return await allocateNativeScreen(); }
  catch (error) { if ((error instanceof Error ? error.message : String(error)) === "invalid_native_kind") throw new Error("screen_mobile_update_required"); throw error; }
}, invoke: nativeInvoke });
