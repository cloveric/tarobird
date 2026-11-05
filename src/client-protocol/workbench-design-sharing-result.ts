import { DESIGN_SHARE_LIMITS, designShareResultPartSchema, type DesignShareResultPart } from "./workbench-design-sharing.js";

/** Shared by the browser and Host; raw memory is reserved before allocation. */
export type DesignShareResultBuffer = { size: number; offset: number; bytes: Uint8Array };
export function appendDesignShareResult(previous: DesignShareResultBuffer | undefined, input: DesignShareResultPart, available: number) {
  const parsed = designShareResultPartSchema.safeParse(input);
  if (!parsed.success) throw new Error("design_share_bad_chunk");
  const part = parsed.data;
  if (part.offset !== (previous?.offset ?? 0) || previous && previous.size !== part.size) throw new Error("design_share_bad_chunk");
  if (!previous && part.size > available) throw new Error("design_share_reply_busy");
  let binary: string;
  try { binary = atob(part.base64); } catch { throw new Error("design_share_bad_chunk"); }
  if (!binary.length || binary.length > DESIGN_SHARE_LIMITS.chunkBytes || part.offset + binary.length > part.size) throw new Error("design_share_bad_chunk");
  const buffer = previous ?? { size: part.size, offset: 0, bytes: new Uint8Array(part.size) };
  for (let i = 0; i < binary.length; i++) buffer.bytes[buffer.offset + i] = binary.charCodeAt(i);
  buffer.offset += binary.length;
  if (buffer.offset !== buffer.size) return { buffer, complete: false as const };
  try { return { buffer, complete: true as const, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.bytes)) as unknown }; }
  catch { throw new Error("design_share_bad_chunk"); }
}

export function encodeDesignShareResult(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value ?? null));
  if (bytes.length > DESIGN_SHARE_LIMITS.resultBytes) throw new Error("design_share_reply_too_large");
  return bytes;
}
export function* splitDesignShareResult(bytes: Uint8Array): Generator<DesignShareResultPart> {
  for (let offset = 0; offset < bytes.length; offset += DESIGN_SHARE_LIMITS.chunkBytes) {
    const chunk = bytes.subarray(offset, offset + DESIGN_SHARE_LIMITS.chunkBytes);
    let binary = "";
    for (let i = 0; i < chunk.length; i += 32768) binary += String.fromCharCode(...chunk.subarray(i, i + 32768));
    yield { offset, size: bytes.length, base64: btoa(binary) };
  }
}

/** A source call has returned a definite refusal before a successful write result. */
export function isDesignShareRefusal(result: unknown): boolean {
  const status = (result as { status?: unknown } | null)?.status;
  return Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599;
}
