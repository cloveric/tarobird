import { callHost } from "./host-bridge";

export type NodeAddon = { id: string; title: string; sha256: string; url: string };
export type NodeAddonState = { enabled: boolean; plugins: NodeAddon[] };
export type NodeAddonOutput = { text: string; color?: string };
export const NODE_TEXT_LIMIT = 16_384;
export const NODE_TITLE_LIMIT = 160;

export function approvedNodeSource(input: string): string | null {
    if (input.length > 1024) return null;
    const normalized = input.trim();
    const match = /^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.js$/.exec(normalized);
    if (!match || normalized.split("/").some(segment => segment === "." || segment === "..")) return null;
    return normalized;
}

export const nodeAddonsApi = {
    list: () => callHost<NodeAddonState>("canvas.nodes.list"),
    enable: (enabled: boolean) => callHost<NodeAddonState>("canvas.nodes.enable", { enabled }),
    install: (url: string) => callHost<NodeAddonState>("canvas.nodes.install", { url }),
    remove: (pluginId: string) => callHost<NodeAddonState>("canvas.nodes.remove", { pluginId }),
    render: (pluginId: string, text: string, title: string) => callHost<NodeAddonOutput>("canvas.nodes.render", {
        pluginId,
        node: { text: text.slice(0, NODE_TEXT_LIMIT), title: title.slice(0, NODE_TITLE_LIMIT) },
    }),
};

export function safeNodeOutput(output: NodeAddonOutput): NodeAddonOutput {
    return {
        text: typeof output.text === "string" ? output.text.slice(0, NODE_TEXT_LIMIT) : "",
        color: typeof output.color === "string" && /^#[0-9a-f]{6}$/i.test(output.color) ? output.color : undefined,
    };
}
