import type { AdapterUsage } from "./adapter.js";
import { classifyFailure } from "../runtime/error-classification.js";

export type EngineRetryReason = "capacity" | "connection" | "rate-limit";
export interface EngineRetryReceipt {
  /** Native session containing this request; never an inferred or replacement session. */
  sessionId: string;
  /** input: rejected before execution; continue: terminal failure with retained native context. */
  mode: "input" | "continue";
  reason: EngineRetryReason;
  /** Foreground ended, but native child work is not confirmed terminal. The
   * host records usage/context and withholds continuation for this receipt. */
  unfinishedWork?: true;
  /** Read-only, same-turn reconciliation of observed tools. Only the adapter
   * can publish terminal tool events; this never authorizes replay or input. */
  reconcileTools?: (toolUseIds: readonly string[], signal?: AbortSignal, locale?: "en" | "zh") => Promise<void>;
  /** Release the adapter's recovery lease even when the bridge rejects it. */
  releaseTools?: () => void;
  retryAfterMs?: number;
  usage?: AdapterUsage;
}
/** Only adapters with proof that the foreground turn ended or was never admitted
 * may construct this error. A dead socket, timeout or matching log line alone
 * does not prove that remote work stopped. */
export class EngineRetryableError extends Error {
  constructor(message: string, readonly retry: EngineRetryReceipt, options?: ErrorOptions) {
    super(message, options); this.name = "EngineRetryableError";
  }
}
/** Classify only the provider failure, excluding historic subprocess diagnostics.
 * The caller still supplies the native admission/termination proof. */
export function engineRetryReason(error: unknown): EngineRetryReason | undefined {
  const text = (error instanceof Error ? error.message : String(error)).split("\n\n[engine diagnostics]")[0]!;
  const category = classifyFailure(new Error(text));
  if (category === "engine-rate-limit") return "rate-limit";
  if (category === "engine-backend") return /capacity|overload|529/i.test(text) ? "capacity" : "connection";
  if (!["unknown", "engine-cli"].includes(category)) return;
  if (/\b(?:502|503|504)\b|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)\b|stream disconnected before completion|connection reset|network (?:error|unavailable)|fetch failed|error (?:sending|decoding) (?:request|response)/i.test(text)) return "connection";
}
/** Attach recovery only at a verified native boundary, preserving the raw cause. */
export function withEngineRetryReceipt(error: Error, receipt: Omit<EngineRetryReceipt, "reason">): Error {
  const reason = engineRetryReason(error);
  return reason && receipt.sessionId ? new EngineRetryableError(error.message, { ...receipt, reason }, { cause: error }) : error;
}
