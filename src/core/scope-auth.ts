import { platformPolicy, type PlatformPolicy } from "./platform-policy.js";
export const maybeSendLarkScopeAuthCard: NonNullable<PlatformPolicy["scopeAuth"]> = (...args) => platformPolicy().scopeAuth?.(...args) ?? Promise.resolve(false);
