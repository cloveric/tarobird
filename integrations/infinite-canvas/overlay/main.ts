import axios from "axios";
import { defaultWorkspaceConfig } from "@infinite-canvas/shared/workspace-config";
import { initializeStorage } from "@workbench/services/storage/runtime";
import { initializeWorkspaceConfig } from "@workbench/services/workspace-config/runtime";
import { initializeNetwork } from "@workbench/services/network/runtime";
import { initializeChannels } from "@workbench/services/channels/runtime";
import { initializeModels } from "@workbench/services/api/models/runtime";
import { hostBridge, subscribeHostContextEvents } from "./host-bridge";
import { createEmbeddedStorage } from "./storage";
import { installPreferences } from "./preferences";
import { activateBundledPlugins, initializeEmbeddedPlugins } from "./plugins";
import { providerAxios, setAllowedDomains } from "./provider";
import { createEmbeddedChannels } from "./channels";

let startupPhase = "handshake";
const safeErrors = new Set([
    "CANVAS_HOST_REQUIRED", "capability_denied", "method_not_allowed", "host_timeout",
    "storage_unavailable", "storage_quota_exceeded", "credentials_unavailable",
    "WORKSPACE_UNAVAILABLE", "STORAGE_INVALID", "PLUGIN_LOAD_FAILED",
]);

async function start() {
    const host = await hostBridge.hello();
    if (host.pluginId !== "tarobird.infinite-canvas") throw Error("CANVAS_HOST_REQUIRED");
    startupPhase = "preferences";
    await installPreferences();
    startupPhase = "crypto";
    // An opaque frame does not always expose SecureContext-only randomUUID.
    if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
    } });
    startupPhase = "theme";
    const { useThemeStore } = await import("@workbench/stores/use-theme-store");
    useThemeStore.getState().setTheme(host.theme);
    setAllowedDomains(host);
    subscribeHostContextEvents(event => {
        if (event.theme) useThemeStore.getState().setTheme(event.theme);
        if (event.grantedDomains) setAllowedDomains(event);
    });
    startupPhase = "adapters";
    axios.defaults.adapter = providerAxios;
    const storage = createEmbeddedStorage();
    initializeStorage(storage);
    initializeWorkspaceConfig({
        load: async () => defaultWorkspaceConfig,
        save: async () => { throw Error("WORKSPACE_SYNC_DISABLED"); },
        update: async () => false,
    });
    initializeNetwork({ kind: "server", url: url => url });
    initializeChannels(createEmbeddedChannels());
    initializeEmbeddedPlugins();
    startupPhase = "channel_module";
    const { loadChannelConfig } = await import("@workbench/stores/use-config-store");
    startupPhase = "channels";
    await loadChannelConfig();
    startupPhase = "models";
    const { createBrowserModels } = await import("@workbench/services/api/models/browser");
    initializeModels(createBrowserModels());
    startupPhase = "bundled_nodes";
    await activateBundledPlugins();
    startupPhase = "native_pages";
    await import("../bootstrap");
}
void start().catch((failure: unknown) => {
    const name = failure instanceof Error || failure instanceof DOMException ? failure.name : "";
    const message = failure instanceof Error ? failure.message : "";
    const code = safeErrors.has(message) ? message
        : ["TypeError", "ReferenceError", "SecurityError", "SyntaxError", "NotSupportedError"].includes(name) ? name : "startup_failed";
    const root = document.getElementById("root");
    if (root) root.textContent = `无法打开无限画布。请重试。 (${startupPhase}/${code})`;
});
