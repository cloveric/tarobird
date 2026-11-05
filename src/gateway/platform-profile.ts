import { withChannelProfile as withCoreProfile, type ChannelProfile } from "../core/channel-profile.js";
import { withPlatformPolicy, type PlatformPolicy } from "../core/platform-policy.js";
import { appAgentInstructions } from "./agent-instructions.js";
import { applyGatewayGroupMode, gatewayNativeCommandHelp, renderGatewayHelp } from "./commands.js";
import { gatewayRequiresMention } from "./group-mode.js";
const policy: PlatformPolicy = { instructions: appAgentInstructions, groupMode: applyGatewayGroupMode, requiresMention: gatewayRequiresMention, nativeCommandHelp: gatewayNativeCommandHelp, help: renderGatewayHelp };
export function withChannelProfile<T>(profile: ChannelProfile, work: () => T): T { return withCoreProfile(profile, () => withPlatformPolicy(policy, work)); }
export { channelProfile, isGatewayChannel } from "../core/channel-profile.js";
