import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { MAX_FRAME_BYTES, MAX_TEXT_BYTES } from "./index.js";
import { FrameReader, FRAGMENT_BYTES, MAX_LOGICAL_FRAME_BYTES } from "./fragments.js";

export function nodeFrameReader(): FrameReader {
  // Avoid a JS callback for every byte of large local Gateway/Hub replies.
  // FrameReader still validates the envelope, padding, length and full digest.
  return new FrameReader(() => { const hash = createHash("sha256"); return { update: (bytes) => hash.update(bytes), hex: () => hash.digest("hex") }; }, Date.now, data => Buffer.from(data, "base64"));
}
export function* frameParts(raw: string): Generator<string> {
  if (Buffer.byteLength(raw) > MAX_LOGICAL_FRAME_BYTES) throw new Error("logical_frame_too_large");
  if (Buffer.byteLength(raw) <= MAX_TEXT_BYTES) { yield raw; return; }
  const bytes = Buffer.from(raw), sha256 = createHash("sha256").update(bytes).digest("hex"), id = randomUUID();
  for (let start = 0; start < bytes.length; start += FRAGMENT_BYTES) yield JSON.stringify({ v: 1, type: "frame.fragment", id, index: start / FRAGMENT_BYTES, bytes: bytes.length, sha256, data: bytes.subarray(start, start + FRAGMENT_BYTES).toString("base64") });
}
/** `largest`: queued entries in FIFO order with decreasing sizes (its head is
 * the largest frame still queued or being written). */
type Queue = { tail: Promise<void>; pending: number; bytes: number; largest: { bytes: number }[] };
const queues = new WeakMap<WebSocket, Queue>();
function write(ws: WebSocket, raw: string): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("socket_disconnected"));
  return new Promise((resolve, reject) => ws.send(raw, (error) => error ? reject(error) : resolve()));
}
/** Serialize logical frames, await each physical write, and let heartbeats pass
 * between fragments. A slow live consumer reconnects to the durable journal. */
export function writeFrame(ws: WebSocket, value: unknown, fragments = true): Promise<void> {
  const raw = JSON.stringify(value), bytes = Buffer.byteLength(raw);
  if (bytes > MAX_LOGICAL_FRAME_BYTES) return Promise.reject(new Error("logical_frame_too_large"));
  const type = typeof value === "object" && value ? (value as { type?: string }).type : undefined;
  if (["ping", "pong", "notice", "error"].includes(type ?? "") && bytes <= MAX_TEXT_BYTES) return write(ws, raw);
  if (!fragments && bytes > MAX_FRAME_BYTES) return Promise.reject(new Error("client_update_required"));
  const queue = queues.get(ws) ?? { tail: Promise.resolve(), pending: 0, bytes: 0, largest: [] }; queues.set(ws, queue);
  // One large (fragmented) frame, such as a long history message, may exceed
  // the budget while live frames queue around it; everything else must fit.
  if (queue.pending && queue.bytes + bytes - Math.max(queue.largest[0]?.bytes ?? 0, bytes) > 4 * MAX_FRAME_BYTES) return Promise.reject(new Error("resync_required"));
  queue.pending++; queue.bytes += bytes;
  const entry = { bytes };
  while (queue.largest.length && queue.largest.at(-1)!.bytes <= bytes) queue.largest.pop();
  queue.largest.push(entry);
  const work = queue.tail.then(async () => { for (const part of fragments ? frameParts(raw) : [raw]) await write(ws, part); });
  queue.tail = work.catch(() => undefined);
  void work.finally(() => { queue.pending--; queue.bytes -= bytes; if (queue.largest[0] === entry) queue.largest.shift(); if (!queue.pending) queues.delete(ws); }).catch(() => undefined);
  return work;
}
