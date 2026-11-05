import type { PairingProps } from "../../src/HostApp.js";
import { mockIPC as installMock } from "@tauri-apps/api/mocks";
Object.assign(globalThis, { isTauri: true });
installMock((command) => { if (command === "net_document") return "fixture-document"; throw new Error("unexpected_boot_request"); });
const [{ hubFetch, hubSocket }, { createElement, useState }, { createRoot }, { Pairing }, { HubConnection }, { RoutesEditor }, { setLocale }, { useDesktopLocalHost }] = await Promise.all([
  import("../../src/transport.js"), import("react"), import("react-dom/client"), import("../../src/Pairing.js"), import("../../src/connection.js"), import("../../src/RoutesEditor.js"), import("../../src/i18n.js"), import("../../src/useDesktopLocalHost.js"),
]);
const { cache } = await import("../../src/storage.js");
function PairingHarness({ props }: { props: Partial<PairingProps> }) {
  const [pendingConnection, setPending] = useState<InstanceType<typeof HubConnection>>();
  return createElement(Pairing, { connected: () => undefined, ...props, pendingConnection: props.pendingConnection ?? pendingConnection, save: async (identity, name) => {
    await props.save?.(identity, name); await cache.saveIdentity(identity);
    // The real HostApp saves first, then presents its pending connection. The
    // transport fixture exercises enrollment only; authenticated WS readiness
    // is covered by the real-Hub pairing suite.
    if (identity.pendingPairing) setPending(new HubConnection(identity, cache));
  } });
}
const renderPairing = (props: Partial<PairingProps> = {}) => createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(PairingHarness, { props }));
const renderRoutes = (connection: InstanceType<typeof HubConnection>) => createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(RoutesEditor, { connection }));
function ProtectedRoutes({ connection }: { connection: InstanceType<typeof HubConnection> }) { const state = useDesktopLocalHost(connection.identity.hubPublicKey); return createElement(RoutesEditor, { connection, localHost: state.localHost, identityPending: !state.resolved, retryIdentity: state.failed ? state.retry : undefined, configureLocal: () => {} }); }
const renderProtectedRoutes = (connection: InstanceType<typeof HubConnection>) => createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(ProtectedRoutes, { connection }));
const mockIPC: typeof installMock = (callback, options) => installMock((command, args) => command === "net_document" ? "fixture-document" : callback?.(command, args), options);
const runCallback = (id: number, data: unknown) => (window as unknown as { __TAURI_INTERNALS__: { runCallback(id: number, data: unknown): void } }).__TAURI_INTERNALS__.runCallback(id, data);
const { ConnectionPanel } = await import("../../src/ConnectionPanel.js");
const renderConnectionPanel = (connection: InstanceType<typeof HubConnection>) => createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(ConnectionPanel, { connection, close: () => {} }));
const { downloadAttachment } = await import("../../src/downloads.js");
Object.assign(window, { nativeTransportFixture: { renderConnectionPanel, downloadAttachment, mockIPC, runCallback, hubFetch, hubSocket, renderPairing, renderRoutes, renderProtectedRoutes, setLocale, HubConnection } });
