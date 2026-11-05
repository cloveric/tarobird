import { AsyncLocalStorage } from "node:async_hooks";
import type { LarkAgentInstructionOptions } from "./agent-instructions.js";
import type { Locale } from "../runtime/locale.js";
import type { CoreChannelLike, CoreSendOptions } from "./types.js";
export interface PlatformPolicy {
 instructions?: (options: LarkAgentInstructionOptions) => string;
 groupMode?: (stateDir: string, chatId: string | undefined, group: boolean, action: string, locale: Locale, defaultMention?: boolean) => Promise<string>;
 requiresMention?: (stateDir: string, chatId: string, defaultMention?: boolean) => Promise<boolean>;
 nativeCommandHelp?: (command: string, locale: Locale) => string | undefined;
 help?: (engine: string, locale: Locale) => string;
 checkGroupScope?: (input: { appId?: string; appSecret?: string; domain?: string; timeoutMs?: number }) => Promise<"ok" | "missing" | "unknown">;
 groupScopeWarning?: (locale: Locale, appId?: string, domain?: string, instanceName?: string) => string;
 scopeAuth?: (input: { channel: CoreChannelLike; chatId: string; appId?: string; domain?: string; options?: CoreSendOptions; locale: Locale }, error: unknown) => Promise<boolean>;
}
const current = new AsyncLocalStorage<PlatformPolicy>();
const empty: PlatformPolicy = Object.freeze({});
export const platformPolicy = (): PlatformPolicy => current.getStore() ?? empty;
export function withPlatformPolicy<T>(policy: PlatformPolicy, work: () => T): T { return current.run(policy, work); }
export const applyGatewayGroupMode: NonNullable<PlatformPolicy["groupMode"]> = (...args) => platformPolicy().groupMode?.(...args) ?? Promise.reject(new Error("platform_group_policy_unavailable"));
export const gatewayRequiresMention: NonNullable<PlatformPolicy["requiresMention"]> = (...args) => platformPolicy().requiresMention?.(...args) ?? Promise.resolve(args[2] !== false);
export const gatewayNativeCommandHelp: NonNullable<PlatformPolicy["nativeCommandHelp"]> = (...args) => platformPolicy().nativeCommandHelp?.(...args);
export const renderGatewayHelp: NonNullable<PlatformPolicy["help"]> = (...args) => platformPolicy().help?.(...args) ?? "";
