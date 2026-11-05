import { electronBridge, type DesktopEvent } from "./desktop-bridge.js";
import type { UpdateBackend, UpdateEvent, UpdateInfo } from "./update-controller.js";

/** Must match `UPDATE_EVENT` in electron/updater.mjs. */
export const ELECTRON_UPDATE_EVENT = "github-update-progress";
const events = new Set(["Started", "Progress", "Finished", "WaitingForHost", "Installing", "RestartingHost"]);

type Bridge = Pick<ReturnType<typeof electronBridge>, "invoke" | "on">;
interface Progress { offerId: string; event: UpdateEvent }
function progress(value: unknown): value is Progress {
  if (typeof value !== "object" || value === null) return false;
  const { offerId, event } = value as Partial<Progress>;
  return typeof offerId === "string" && typeof event === "object" && event !== null && events.has((event as { event?: string }).event ?? "");
}

/** Electron main relays a native updater that owns credentials, downloads and
 * bundle replacement. GitHub and public releases use the same commands; the
 * renderer only ever holds opaque offer IDs. */
export function createElectronUpdateBackend(bridge: () => Bridge = electronBridge): UpdateBackend {
  return {
    info: () => bridge().invoke<UpdateInfo>("github_update_info"),
    async check() {
      const offer = await bridge().invoke<{ offerId: string; version: string; body?: string } | null>("github_update_check");
      if (!offer) return null;
      return {
        version: offer.version, body: offer.body,
        close: async () => { await bridge().invoke("github_update_close", { offerId: offer.offerId }); },
        downloadAndInstall: async receive => {
          const native = bridge();
          const stop = native.on(ELECTRON_UPDATE_EVENT as DesktopEvent, payload => {
            if (progress(payload) && payload.offerId === offer.offerId) receive(payload.event);
          });
          try { await native.invoke("github_update_install", { offerId: offer.offerId }); }
          finally { stop(); }
        },
      };
    },
    restart: async () => { await bridge().invoke("restart_client"); },
  };
}
