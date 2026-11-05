import type { CoreChannelLike } from "./types.js";
export function shouldResolveLarkMentions(env: NodeJS.ProcessEnv): boolean { return /^(?:1|true|yes|on)$/i.test((env.CCTB_LARK_RESOLVE_MENTIONS ?? env.LARK_RESOLVE_MENTIONS ?? "").trim()); }
export async function resolveLarkMentionsInText(input: { enabled: boolean; channel: CoreChannelLike; chatId: string; text: string }): Promise<string> { return input.enabled ? input.channel.resolveMentions?.(input.chatId, input.text) ?? input.text : input.text; }
