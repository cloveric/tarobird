import { decodeBase64 } from "./base64.js";
import { z } from "zod";
import { MAX_FRAME_BYTES, MAX_TEXT_BYTES, idSchema } from "./index.js";

export const MAX_LOGICAL_FRAME_BYTES = 32 * 1024 * 1024;
export const FRAGMENT_CAPABILITY = "fragments.v1";
// Base64 data stays within the 200 KiB text budget, including binary UTF-8
// boundaries. The complete envelope remains below the 1 MiB frame budget.
export const FRAGMENT_BYTES = Math.floor(MAX_TEXT_BYTES / 4) * 3;
const fragmentSchema = z.object({ v: z.literal(1), type: z.literal("frame.fragment"), id: idSchema,
  index: z.number().int().nonnegative().safe(), bytes: z.number().int().positive().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.string().min(4).max(MAX_TEXT_BYTES).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict();
export interface FrameHash { update(bytes: Uint8Array): unknown; hex(): string }
type Transfer = { id: string; bytes: number; sha256: string; next: number; received: number; hash: FrameHash; decoder: TextDecoder; text: string[]; last: number };

/** One ordered transfer per socket, with heartbeat/control frames between parts.
 * No allocation depends on a sender's claimed total size. Only received bytes
 * are retained. A partial transfer never reaches message history or an engine. */
export class FrameReader {
  private pending?: Transfer;
  constructor(private readonly hash: () => FrameHash, private readonly now = Date.now,
    private readonly decode: (data: string) => Uint8Array = decodeBase64,
    private readonly budget = MAX_LOGICAL_FRAME_BYTES) {}
  clear(): void { this.pending = undefined; }
  hasPendingTransfer(): boolean { return this.pending !== undefined; }
  read(raw: string): unknown | undefined {
    if (new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) { this.clear(); throw new Error("frame_too_large"); }
    if (this.pending && this.now() - this.pending.last > 30_000) { this.clear(); throw new Error("fragment_timeout"); }
    let value: unknown;
    try { value = JSON.parse(raw); } catch (error) { this.clear(); throw error; }
    if (!value || typeof value !== "object" || !("type" in value) || value.type !== "frame.fragment") {
      if (this.pending && (!value || typeof value !== "object" || !("type" in value) || !["ping", "pong", "error", "notice"].includes(String(value.type)))) { this.clear(); throw new Error("fragment_interleaved_frame"); }
      return value;
    }
    try {
      const part = fragmentSchema.parse(value);
      if (part.bytes > this.budget) throw new Error("logical_frame_too_large");
      if (!this.pending) {
        if (part.index !== 0 || part.bytes <= MAX_TEXT_BYTES) throw new Error("fragment_start_invalid");
        this.pending = { id: part.id, bytes: part.bytes, sha256: part.sha256, next: 0, received: 0, hash: this.hash(), decoder: new TextDecoder("utf-8", { fatal: true }), text: [], last: this.now() };
      }
      const current = this.pending;
      if (current.id !== part.id || current.next !== part.index || current.bytes !== part.bytes || current.sha256 !== part.sha256) throw new Error("fragment_sequence_invalid");
      // Buffer's native decoder is more permissive than atob. Keep the same
      // padding/length checks on both platforms before selecting a decoder.
      // The schema above already rejects whitespace and non-base64 characters.
      if (part.data.length % 4 === 1 || part.data.endsWith("=") && part.data.length % 4 !== 0) throw new Error("fragment_base64_invalid");
      const bytes = this.decode(part.data);
      if (bytes.length !== Math.min(FRAGMENT_BYTES, current.bytes - current.received)) throw new Error("fragment_size_invalid");
      if (current.received + bytes.length > this.budget) throw new Error("logical_frame_too_large");
      current.hash.update(bytes); current.received += bytes.length; current.next++; current.last = this.now();
      current.text.push(current.decoder.decode(bytes, { stream: current.received < current.bytes }));
      if (current.received < current.bytes) return;
      if (current.hash.hex() !== current.sha256) throw new Error("fragment_hash_invalid");
      const result: unknown = JSON.parse(current.text.join("")); this.clear();
      if (result && typeof result === "object" && "type" in result && result.type === "frame.fragment") throw new Error("nested_fragment_invalid");
      return result;
    } catch (error) { this.clear(); throw error; }
  }
}
