import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { jsonSchema, type Json } from "../client-protocol/index.js";
import { JsonStore } from "../state/json-store.js";

const resultSchema = z.object({ ok: z.boolean(), result: jsonSchema.optional(), error: z.enum(["operation_failed", "operation_interrupted"]).optional() });
const receiptSchema = z.object({ state: z.enum(["running", "complete"]), result: resultSchema.optional(), retryUntil: z.number().optional() });
export type ReceiptResult = z.infer<typeof resultSchema>;
/** One fsynced receipt per operation avoids loading an unbounded history into
 * memory. An interrupted side effect needs an explicit user retry: replaying it
 * automatically could repeat an approval, a shell command, or a payment. */
export class GatewayReceipts {
  private active = new Map<string, Promise<ReceiptResult>>();
  constructor(private readonly directory: string) {}
  run(key: string, operation: () => Promise<Json>, idempotentRetryMs = 0, authorize?: () => Promise<void>): Promise<ReceiptResult> {
    // Each caller must still be authorized before joining someone else's work.
    if (authorize) return authorize().then(() => this.runAuthorized(key, operation, idempotentRetryMs, authorize));
    return this.runAuthorized(key, operation, idempotentRetryMs);
  }
  private runAuthorized(key: string, operation: () => Promise<Json>, idempotentRetryMs: number, authorize?: () => Promise<void>): Promise<ReceiptResult> {
    const existing = this.active.get(key); if (existing) return existing;
    const task = this.perform(key, operation, idempotentRetryMs, authorize); this.active.set(key, task);
    void task.finally(() => this.active.delete(key)).catch(() => undefined);
    return task;
  }
  private async perform(key: string, operation: () => Promise<Json>, idempotentRetryMs: number, authorize?: () => Promise<void>): Promise<ReceiptResult> {
    const id = createHash("sha256").update(key).digest("hex");
    const file = new JsonStore(path.join(this.directory, "gateway-receipts", `${id}.json`), (value) => receiptSchema.nullable().parse(value));
    const old = await file.read(null);
    await authorize?.();
    // Only provider-idempotent notifications opt in. Command/approval receipts
    // retain their default at-most-once behavior even after an uncertain failure.
    const retryUntil = old?.retryUntil ?? (!old && idempotentRetryMs > 0 ? Date.now() + idempotentRetryMs : undefined);
    const retry = idempotentRetryMs > 0 && retryUntil !== undefined && retryUntil > Date.now();
    if (old?.state === "complete" && old.result && (old.result.ok || !retry)) return old.result;
    if (old && !retry) {
      const result: ReceiptResult = { ok: false, error: "operation_interrupted" };
      await file.write({ state: "complete", result }); return result;
    }
    await file.write({ state: "running", retryUntil });
    try { await authorize?.(); }
    catch (error) {
      // No side effect has started. Preserve the prior retry state rather than
      // turning an authorization rejection into a consumed/failed operation.
      await file.write(old); throw error;
    }
    let result: ReceiptResult;
    try { result = { ok: true, result: await operation() }; }
    catch { result = { ok: false, error: "operation_failed" }; }
    await file.write({ state: "complete", result, retryUntil }); return result;
  }
}
