import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

const frameSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("request"), id: z.string().uuid(), method: z.string().max(64), payload: z.unknown() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("response"), id: z.string().uuid(), result: z.unknown().optional(), error: z.literal(true).optional() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("cancel"), id: z.string().uuid() }).strict(),
]);
const MAX_FRAME_BYTES = 1024 * 1024;
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };

/** Private inherited process pipes, separate from logs and model-controlled
 * stdio. Closing either side rejects requests and revokes every in-flight call. */
export class NativeAppPipe {
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Map<string, AbortController>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private closed = false;
  get available(): boolean { return !this.closed; }
  constructor(private readonly input: Readable, private readonly output: Writable, private readonly handler: (method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>, private readonly onClose?: () => void) {
    input.on("data", this.receive); input.once("error", this.close); input.once("end", this.close); input.once("close", this.close);
    output.once("error", this.close); output.once("close", this.close);
  }
  request(method: string, payload: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error("Native App pipe unavailable"));
    if (this.pending.size >= 128) return Promise.reject(new Error("Too many pending native App requests"));
    return new Promise((resolve, reject) => {
      const id = randomUUID(); let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        const request = this.pending.get(id); if (!request) return;
        this.pending.delete(id); request.cleanup(); request.reject(new Error("Native App request cancelled or timed out; delivery may have occurred. Check receipts before retrying."));
        this.write({ v: 1, type: "cancel", id });
      };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(abort, timeoutMs);
      if (!this.write({ v: 1, type: "request", id, method, payload })) {
        const pending = this.pending.get(id); this.pending.delete(id);
        pending?.cleanup(); pending?.reject(new Error("Native App request exceeds the pipe limit; this request was not dispatched"));
      }
    });
  }
  private write(frame: unknown): boolean {
    if (this.closed) return false;
    try {
      const line = JSON.stringify(frame) + "\n";
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return false;
      this.output.write(line, (error) => { if (error) this.close(); });
      return true;
    } catch { return false; }
  }
  private readonly receive = (chunk: Buffer | string) => {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { this.close(); return; }
      try { this.handle(frameSchema.parse(JSON.parse(line))); } catch { this.close(); return; }
      if (this.closed) return;
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) this.close();
  };
  private handle(frame: z.infer<typeof frameSchema>): void {
    if (frame.type === "response") {
      const pending = this.pending.get(frame.id); if (!pending) return;
      this.pending.delete(frame.id); pending.cleanup();
      if (frame.error) pending.reject(new Error("Native App result unavailable; delivery may have occurred. Check receipts before retrying.")); else pending.resolve(frame.result);
      return;
    }
    if (frame.type === "cancel") { this.active.get(frame.id)?.abort(); return; }
    if (this.active.has(frame.id)) { this.close(); return; }
    if (this.active.size >= 128) { this.write({ v: 1, type: "response", id: frame.id, error: true }); return; }
    const controller = new AbortController(); this.active.set(frame.id, controller);
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.handler(frame.method, frame.payload, controller.signal);
    }).then((result) => {
      if (!controller.signal.aborted && !this.write({ v: 1, type: "response", id: frame.id, result })) this.write({ v: 1, type: "response", id: frame.id, error: true });
    }).catch(() => {
      if (!controller.signal.aborted) this.write({ v: 1, type: "response", id: frame.id, error: true });
    }).finally(() => this.active.delete(frame.id));
  }
  readonly close = (): void => {
    if (this.closed) return;
    this.closed = true; this.buffer = "";
    this.input.off("data", this.receive);
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error("Native App pipe closed; delivery may have occurred. Check receipts before retrying.")); }
    this.pending.clear(); for (const active of this.active.values()) active.abort(); this.active.clear();
    // Retain error listeners: late stream errors during child teardown must not
    // become uncaught exceptions. These dedicated streams belong to this peer.
    this.input.destroy(); this.output.destroy();
    this.onClose?.();
  };
}
