import { z } from "zod";
// This protocol is imported by index.ts; keep it independent of protocols
// that import index.ts (device actions/private network) to avoid an init cycle.
function networkCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(networkCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${networkCanonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const BOT_MESSAGES_CAPABILITY = "bot-messages.v1";
export const BOT_PASSPORT_TTL_MS = 60_000;
// The local call encloses bounded route probes, pacing and one file exchange.
export const BOT_LOCAL_REQUEST_TIMEOUT_MS = 120_000;
// Independently administered physical hosts do not have identical wall clocks.
export const BOT_PASSPORT_CLOCK_SKEW_MS = 30_000;
export const botSourceSchema = z.object({
  hostId: id, hostName: z.string().max(256), botId: id, botName: z.string().max(256),
  requestId: id, hops: z.number().int().min(1).max(3),
}).strict();
export type BotSource = z.infer<typeof botSourceSchema>;
export const botPassportSchema = z.object({
  v: z.literal(1), sourceKey: z.string().max(128), targetKey: z.string().max(128),
  source: botSourceSchema, targetBot: z.string().min(1).max(256), conversation: z.string().max(256).optional(),
  method: z.enum(["GET", "POST", "PUT"]), path: z.string().max(512), digest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int(), nonce: id,
}).strict();
export type BotPassport = z.infer<typeof botPassportSchema>;
export const signedBotPassportSchema = z.object({ passport: botPassportSchema, signature: z.string().max(128) }).strict();
export type SignedBotPassport = z.infer<typeof signedBotPassportSchema>;
export const botPassportProof = (p: BotPassport) => `tarobot/bot-message/passport/v1\0${networkCanonical(p)}`;
export const botChallengeProof = (key: string, nonce: string) => `tarobot/bot-message/challenge/v1\0${key}\0${nonce}`;
export const botReplyProof = (nonce: string, result: unknown) => `tarobot/bot-message/reply/v1\0${nonce}\0${networkCanonical(result)}`;
export const botLocalRequestSchema = z.object({
  operation: z.enum(["list", "resolve", "send", "wait", "upload", "chunk", "complete", "download"]),
  host: z.string().min(1).max(256), bot: z.string().min(1).max(256), conversation: z.string().max(256).optional(),
  sourceBot: id.optional(), contextMessage: id.optional(), requestId: id,
  data: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type BotLocalRequest = z.infer<typeof botLocalRequestSchema>;
export const botMessageTargetSchema = z.object({
  hostId: id, hostName: z.string().max(512), botId: id, botName: z.string().max(512),
  conversationId: id, conversationName: z.string().max(512),
}).strict();
export type BotMessageTarget = z.infer<typeof botMessageTargetSchema>;
export function isBotControl(text: string): boolean { return /^\s*\/[a-z][\w.-]*(?:@[\w-]+)?(?=\s|$)/iu.test(text); }
/** IDs take precedence; a name never picks the first result. */
export class TargetResolutionError extends Error {}
export function resolveBotTarget<T extends { id: string; name: string }>(value: string, candidates: T[], kind: string): T {
  const byId = candidates.find(c => c.id === value);
  if (byId) return byId;
  const matches = candidates.filter(c => c.name === value);
  if (matches.length === 1) return matches[0]!;
  throw new TargetResolutionError(JSON.stringify({ code: matches.length ? "target_ambiguous" : "target_not_found", kind, value, candidates: (matches.length ? matches : candidates).map(({ id, name }) => ({ id, name })) }));
}
export function parseBotDestination(to: string): { host: string; bot: string; conversation?: string } {
  const parts = to.split("/").map(decodeURIComponent);
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !p || p.length > 256)) throw new Error("destination_requires_host_bot_optional_conversation");
  return { host: parts[0]!, bot: parts[1]!, ...(parts[2] ? { conversation: parts[2] } : {}) };
}
