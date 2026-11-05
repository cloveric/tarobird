import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { AppPlatformTools } from "./adapter.js";
import { NativeAppPipe } from "./native-app-pipe.js";

export type DeepSeekAppToolBinding = { sessionId: string; sourceRpcId: string; tools: AppPlatformTools; signal: AbortSignal; onActivity?: () => void };
export const deepseekPromptStopSchema = z.object({ outcome: z.enum(["removed", "cancelled", "settled", "missing", "unsupported", "goal-active", "merged"]) }).strict();
export type DeepSeekPromptStop = z.infer<typeof deepseekPromptStopSchema>;
export const deepseekPromptSteerSchema = z.object({ outcome: z.enum(["accepted", "queued", "stale", "not_ready", "unsupported"]) }).strict();
export type DeepSeekPromptSteer = z.infer<typeof deepseekPromptSteerSchema>;
export type DeepSeekSteerInput = { sessionId: string; sourceRpcId: string; expectedTurn: number; requestId: string; text: string; clientTimeZone: string };
export const deepseekBudgetPauseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("paused"), ref: z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict() }).strict(),
  z.object({ outcome: z.enum(["stale", "unsupported"]) }).strict(),
]);
export type DeepSeekBudgetPause = z.infer<typeof deepseekBudgetPauseSchema>;
export type DeepSeekBudgetPauseInput = { sessionId: string; ref: { id: string; revision: number } };
const callSchema = z.object({ sessionId: z.string().min(1), sourceRpcId: z.string().uuid(), callId: z.string().min(1).max(256), rootCallId: z.string().min(1).max(256), name: z.string(), arguments: z.unknown() }).strict();
const denied = { text: "No matching active App turn; nothing was sent. Follow this turn's channel instructions and never claim delivery without a receipt.", isError: true };
type Binding = DeepSeekAppToolBinding & { executions: Map<string, { key: string; promise: ReturnType<AppPlatformTools["call"]> }> };
export class DeepSeekAppTools {
  private readonly bindings = new Map<string, Binding>();
  private readonly pipe: NativeAppPipe;
  constructor(input: Readable, output: Writable) {
    this.pipe = new NativeAppPipe(input, output, async (method, payload, signal) => {
      if (method !== "call") return denied;
      const parsed = callSchema.safeParse(payload); if (!parsed.success) return denied;
      const call = parsed.data, binding = this.bindings.get(call.sourceRpcId);
      if (!binding || binding.signal.aborted || binding.sessionId !== call.sessionId || !binding.tools.definitions.some((tool) => tool.name === call.name)) return denied;
      const key = JSON.stringify([call.name, call.arguments, call.rootCallId]);
      const existing = binding.executions.get(call.callId); if (existing) return existing.key === key ? existing.promise : denied;
      const execution = Promise.resolve().then(() => {
        const abortSignal = AbortSignal.any([signal, binding.signal]); abortSignal.throwIfAborted();
        return binding.tools.call({ ...call, abortSignal, onActivity: () => { if (!abortSignal.aborted) binding.onActivity?.(); } });
      });
      binding.executions.set(call.callId, { key, promise: execution }); return execution;
    });
  }
  async install(input: DeepSeekAppToolBinding): Promise<boolean> {
    if (input.signal.aborted) return false;
    const result = await this.pipe.request("install", { sessionId: input.sessionId, definitions: input.tools.definitions }, input.signal, 30_000);
    if (input.signal.aborted || !z.object({ installed: z.literal(true) }).safeParse(result).success) return false;
    if (this.bindings.has(input.sourceRpcId)) throw new Error("App turn binding already exists");
    const binding: Binding = { ...input, executions: new Map() }; this.bindings.set(input.sourceRpcId, binding);
    input.signal.addEventListener("abort", () => { this.bindings.delete(input.sourceRpcId); }, { once: true });
    return true;
  }
  async cancelPrompt(sessionId: string, sourceRpcId: string): Promise<DeepSeekPromptStop> {
    return deepseekPromptStopSchema.parse(await this.pipe.request("cancel-prompt", { sessionId, sourceRpcId }, undefined, 30_000));
  }
  async steerPrompt(input: DeepSeekSteerInput): Promise<DeepSeekPromptSteer> {
    if (!this.pipe.available) return { outcome: "unsupported" };
    return deepseekPromptSteerSchema.parse(await this.pipe.request("steer-prompt", input, undefined, 30_000));
  }
  async pauseGoalForBudget(input: DeepSeekBudgetPauseInput): Promise<DeepSeekBudgetPause> {
    if (!this.pipe.available) return { outcome: "unsupported" };
    return deepseekBudgetPauseSchema.parse(await this.pipe.request("pause-goal-budget", input, undefined, 30_000));
  }
  close(): void { this.pipe.close(); this.bindings.clear(); }
}
