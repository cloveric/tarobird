import { AsyncLocalStorage } from "node:async_hooks";

export type ChannelProfile = "feishu" | "gateway";
const current = new AsyncLocalStorage<ChannelProfile>();
/** Per-dispatch context: simultaneous Feishu and Gateway turns cannot change
 * each other's rendering policy or require changes to shared engine state. */
export function channelProfile(): ChannelProfile { return current.getStore() ?? "feishu"; }
export function withChannelProfile<T>(profile: ChannelProfile, work: () => T): T { return current.run(profile, work); }
export function isGatewayChannel(channel: unknown): boolean { return typeof channel === "object" && channel !== null && "profile" in channel && channel.profile === "gateway"; }
