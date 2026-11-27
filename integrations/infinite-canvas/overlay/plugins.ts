import type { PluginAdapter } from "@infinite-canvas/shared/plugins";
import { initializePlugins } from "@workbench/services/plugins/runtime";

function denied(): never { throw Error("REMOTE_PLUGINS_DISABLED"); }
const unavailable = async () => denied();

export function initializeEmbeddedPlugins() {
    const adapter: PluginAdapter = {
        list: async () => [],
        config: async () => ({ registry: "", skipThirdPartyPlugins: true }),
        index: unavailable, configure: unavailable, install: unavailable, inspectPackage: unavailable,
        installPackage: unavailable, remove: unavailable, enable: unavailable, source: unavailable, asset: unavailable,
    };
    initializePlugins(adapter);
}

export async function activateBundledPlugins() {
    const { activatePlugin } = await import("@workbench/lib/plugins/runtime");
    const [{ default: panorama }, { default: renderer }, { default: note }, { default: isolated }] = await Promise.all([
        import("../../../../plugins/panorama/src/plugin"),
        import("../../../../plugins/multi-format-renderer/src/plugin"),
        import("../../../../plugins/template/src/plugin"),
        import("./node-addons"),
    ]);
    for (const [id, definition] of [["panorama", panorama], ["multi-format-renderer", renderer], ["template", note], ["third-party-nodes", isolated]] as const) {
        await activatePlugin({ name: `canvas-plugin-${id}`, version: "1.0.0", infiniteCanvas: { id, name: id, client: "dist/client.js" } }, undefined, undefined, definition);
    }
}
