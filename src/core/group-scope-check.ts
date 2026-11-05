import { platformPolicy, type PlatformPolicy } from "./platform-policy.js";
export const checkGroupMsgScope: NonNullable<PlatformPolicy["checkGroupScope"]> = (...args) => platformPolicy().checkGroupScope?.(...args) ?? Promise.resolve("unknown");
export const renderGroupMsgScopeWarning: NonNullable<PlatformPolicy["groupScopeWarning"]> = (...args) => platformPolicy().groupScopeWarning?.(...args) ?? "";
