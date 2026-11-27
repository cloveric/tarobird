import { fetchChannelModels } from "@infinite-canvas/model-runtime/channels";
import { channelsSchema, type ModelChannel } from "@infinite-canvas/shared/channels";
import type { ChannelAdapter } from "@workbench/services/channels/runtime";
import { hostBridge } from "./host-bridge";
import { makeCollection } from "./collection";

function keyFor(channel: ModelChannel, groupId: string) {
    return `channel:${channel.id}:${groupId}`;
}

export function createEmbeddedChannels(): ChannelAdapter {
    const collection = makeCollection("channels");
    return {
        async load() {
            const data = await collection.getItem<unknown>("config");
            if (data === null) return null;
            return Promise.all(channelsSchema.parse(data).map(async channel => ({
                ...channel,
                groups: await Promise.all(channel.groups.map(async group => {
                    const apiKey = await hostBridge.credentialsGet(keyFor(channel, group.id)) ?? "";
                    return { ...group, apiKey, hasApiKey: Boolean(apiKey) };
                })),
            })));
        },
        async save(data) {
            const channels = channelsSchema.parse(data);
            const old = await collection.getItem<ModelChannel[]>("config") ?? [];
            const retained = new Set<string>();
            for (const channel of channels) {
                for (const group of channel.groups) {
                    const key = keyFor(channel, group.id);
                    retained.add(key);
                    if (group.apiKey) await hostBridge.credentialsSet(key, group.apiKey);
                    else if (!group.hasApiKey) await hostBridge.credentialsRemove(key);
                }
            }
            await collection.setItem("config", channels.map(channel => ({
                ...channel,
                groups: channel.groups.map(group => ({ ...group, apiKey: "", hasApiKey: !!(group.apiKey || group.hasApiKey) })),
            })));
            for (const channel of old) {
                for (const group of channel.groups) {
                    const key = keyFor(channel, group.id);
                    if (!retained.has(key)) await hostBridge.credentialsRemove(key);
                }
            }
            return channels;
        },
        listModels: (channel, group, format, signal) => fetchChannelModels(channel.baseUrl, group.apiKey, format, url => url, signal),
    };
}
