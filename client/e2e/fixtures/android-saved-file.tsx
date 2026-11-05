import { createRoot } from "react-dom/client";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { AttachmentFile } from "../../src/Content.js";
import type { HubConnection } from "../../src/connection.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-shell.css";

const previous = JSON.parse(localStorage.getItem("saved-fixture-counts") ?? "{}");
const state = { downloads: previous.downloads ?? 0, saves: previous.saves ?? 0, opened: [] as string[], fail: "", cancel: false, legacy: false, delayRestore: false, releaseRestore: undefined as (() => void) | undefined, release: undefined as (() => void) | undefined };
const counts = () => localStorage.setItem("saved-fixture-counts", JSON.stringify({ downloads: state.downloads, saves: state.saves }));
Object.assign(window, { savedFixture: state });
Capacitor.isNativePlatform = () => true;
Capacitor.getPlatform = () => "android";
registerPlugin("Filesystem", { web: async () => ({ readdir: async () => ({ files: [] }), rmdir: async () => {}, mkdir: async () => {}, writeFile: async () => {}, appendFile: async () => {}, getUri: async () => ({ uri: "file:///cache/tarocub-exports/123-abc/update.apk" }) }) });
registerPlugin("TaroBotAttachmentSaver", { web: async () => ({
  save: async ({ key }: { key?: string }) => {
    state.saves++; counts();
    const receipt = { saved: !state.cancel, location: "Download/TaroBot/" + "very-long-file-name-".repeat(20) + ".apk", uri: state.legacy ? undefined : `content://media/external/downloads/${122 + state.saves}` };
    if (key && receipt.saved && receipt.uri) localStorage.setItem(`native-receipt:${key}`, JSON.stringify(receipt));
    return receipt;
  },
  getSaved: async ({ key }: { key: string }) => {
    const receipt = JSON.parse(localStorage.getItem(`native-receipt:${key}`) ?? '{"saved":false}');
    if (state.delayRestore) await new Promise<void>(resolve => { state.releaseRestore = resolve; });
    return receipt;
  },
  openSaved: async ({ uri }: { uri: string }) => { state.opened.push(uri); if (state.fail) throw new Error(state.fail); await new Promise<void>(resolve => { state.release = resolve; }); },
}) });
const source = { blob: new Blob(["apk bytes"]), retain() { return this; }, async dispose() {} };
const name = new URLSearchParams(location.search).get("name") ?? "update.apk";
const root = createRoot(document.getElementById("root")!);
let host = "host-a", device = "device-a";
const render = () => {
  const connection = { identity: { hubPublicKey: host, deviceId: device }, file: async () => { state.downloads++; counts(); return source; } } as unknown as HubConnection;
  root.render(<AttachmentFile connection={connection} block={{ type: "file", attachmentId: "file", name, size: 9, mime: "application/octet-stream" }}/>);
};
Object.assign(state, { hide: () => root.render(null), show: render, host: (value: string) => { host = value; render(); }, device: (value: string) => { device = value; render(); }, removeLocal: () => {
  Object.keys(localStorage).filter(key => key.startsWith("native-receipt:")).forEach(key => localStorage.removeItem(key));
  document.dispatchEvent(new Event("visibilitychange"));
} });
render();
