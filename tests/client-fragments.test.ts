import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, MAX_TEXT_BYTES } from "../src/client-protocol/index.js";
import { FrameReader, MAX_LOGICAL_FRAME_BYTES } from "../src/client-protocol/fragments.js";
import { frameParts, nodeFrameReader, writeFrame } from "../src/client-protocol/fragments-node.js";
import { WebSocket } from "ws";

describe("lossless logical-message framing", () => {
  const value = { v: 1, type: "event", text: "界🙂\n\"\\".repeat(150_000) };
  const parts = () => [...frameParts(JSON.stringify(value))];
  it("bounds every physical payload, preserves UTF-8 and escaping, and commits only the verified complete frame", () => {
    const reader = nodeFrameReader(), frames = parts(); expect(frames.length).toBeGreaterThan(5);
    for (const [index, frame] of frames.entries()) {
      expect(Buffer.byteLength(frame)).toBeLessThan(MAX_FRAME_BYTES);
      expect(JSON.parse(frame).data.length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
      if (index < frames.length - 1) expect(reader.read(frame)).toBeUndefined();
      else expect(reader.read(frame)).toEqual(value);
      expect(reader.read('{"v":1,"type":"pong"}')).toEqual({ v: 1, type: "pong" });
      expect(reader.hasPendingTransfer()).toBe(index < frames.length - 1);
    }
    expect([...frameParts('{"v":1,"type":"pong"}')]).toEqual(['{"v":1,"type":"pong"}']);
  });
  it("rejects reordered, corrupt, interleaved and nested transfers; reconnect discards a partial one", () => {
    const frames = parts(), reader = nodeFrameReader();
    expect(() => reader.read(frames[1]!)).toThrow("fragment_start_invalid");
    reader.read(frames[0]!); expect(() => reader.read(frames[0]!)).toThrow("fragment_sequence_invalid");
    reader.read(frames[0]!); expect(() => reader.read('{"v":1,"type":"event"}')).toThrow("fragment_interleaved_frame");
    reader.read(frames[0]!); reader.clear(); expect(() => reader.read(frames[1]!)).toThrow("fragment_start_invalid");
    const altered = frames.map((frame) => JSON.stringify({ ...JSON.parse(frame), sha256: "0".repeat(64) }));
    for (const frame of altered.slice(0, -1)) reader.read(frame);
    expect(() => reader.read(altered.at(-1)!)).toThrow("fragment_hash_invalid");
    for (const frame of frames.slice(0, -1)) reader.read(frame); expect(reader.read(frames.at(-1)!)).toEqual(value);
    const nested = [...frameParts(JSON.stringify({ ...value, type: "frame.fragment" }))];
    for (const frame of nested.slice(0, -1)) reader.read(frame); expect(() => reader.read(nested.at(-1)!)).toThrow("nested_fragment_invalid");
  });
  it("expires stalled partial frames and does not preallocate a declared total", () => {
    let now = 0;
    const reader = new FrameReader(() => { const hash = createHash("sha256"); return { update: (bytes) => hash.update(bytes), hex: () => hash.digest("hex") }; }, () => now);
    const first = JSON.stringify({ ...JSON.parse(parts()[0]!), bytes: Number.MAX_SAFE_INTEGER });
    expect(() => reader.read(first)).toThrow("logical_frame_too_large");
    expect(reader.hasPendingTransfer()).toBe(false);
    expect(reader.read(parts()[0]!)).toBeUndefined(); now = 30_001;
    expect(() => reader.read('{"v":1,"type":"pong"}')).toThrow("fragment_timeout");
    expect(reader.read('{"v":1,"type":"pong"}')).toBeDefined();
    expect(() => reader.read("x".repeat(MAX_FRAME_BYTES + 1))).toThrow("frame_too_large");
  });
  it("enforces a cumulative transfer budget and can read again after rejection", () => {
    const frames = parts();
    const reader = new FrameReader(() => { const hash = createHash("sha256"); return { update: (bytes) => hash.update(bytes), hex: () => hash.digest("hex") }; }, Date.now, undefined, MAX_TEXT_BYTES * 2);
    expect(() => reader.read(frames[0]!)).toThrow("logical_frame_too_large");
    expect(reader.hasPendingTransfer()).toBe(false);
    expect(reader.read('{"v":1,"type":"pong"}')).toEqual({ v: 1, type: "pong" });
    expect(() => [...frameParts("x".repeat(MAX_LOGICAL_FRAME_BYTES + 1))]).toThrow("logical_frame_too_large");
  });
  it("keeps native and browser decoders equivalent for padded, unpadded and malformed base64", () => {
    const browserReader = () => new FrameReader(() => { const hash = createHash("sha256"); return { update: (bytes: Uint8Array) => hash.update(bytes), hex: () => hash.digest("hex") }; });
    for (const makeReader of [nodeFrameReader, browserReader]) {
      for (const suffix of ["", "x", "xy"]) {
        const source = { type: "event", text: "界🙂".repeat(40_000) + suffix };
        const frames = [...frameParts(JSON.stringify(source))];
        for (const unpadded of [false, true]) {
          const reader = makeReader(); let result: unknown;
          for (const raw of frames) {
            const frame = JSON.parse(raw);
            if (unpadded) frame.data = frame.data.replace(/=+$/, "");
            result = reader.read(JSON.stringify(frame));
          }
          expect(result).toEqual(source);
        }
        const last = JSON.parse(frames.at(-1)!);
        // These retain the same decoded bytes in permissive Buffer.from, so
        // digest verification alone would miss the invalid padding.
        for (const data of [last.data + "=", last.data.slice(0, -4) + "=AAA", last.data + " "]) {
          const reader = makeReader();
          for (const raw of frames.slice(0, -1)) reader.read(raw);
          expect(() => reader.read(JSON.stringify({ ...last, data }))).toThrow();
          expect(reader.read('{"v":1,"type":"pong"}')).toEqual({ v: 1, type: "pong" });
        }
      }
    }
  });
});

describe("live write backlog", () => {
  /** Physical writes complete only when released, like a slow link. */
  function slowSocket() {
    const callbacks: Array<() => void> = [];
    let open = false;
    const ws = { readyState: WebSocket.OPEN, send: (_raw: string, done: (error?: Error) => void) => { if (open) setImmediate(done); else callbacks.push(() => done()); } } as unknown as WebSocket;
    return { ws, drain: async () => { open = true; for (const done of callbacks.splice(0)) done(); } };
  }
  const frame = (bytes: number) => ({ v: 1, type: "event", text: "x".repeat(bytes) });
  it("lets one large history frame travel with live frames around it, but still bounds a slow consumer", async () => {
    for (const order of ["large-first", "live-first"] as const) {
      const link = slowSocket(), writes: Promise<void>[] = [];
      if (order === "live-first") writes.push(writeFrame(link.ws, frame(100)));
      writes.push(writeFrame(link.ws, frame(6 * MAX_FRAME_BYTES)));
      writes.push(writeFrame(link.ws, frame(100)), writeFrame(link.ws, frame(100)));
      await link.drain(); await expect(Promise.all(writes)).resolves.toBeDefined();
    }
    // Apart from that one frame, more than the 4 MiB backlog is still a slow consumer.
    const link = slowSocket(), accepted = [writeFrame(link.ws, frame(6 * MAX_FRAME_BYTES))];
    for (let i = 0; i < 3; i++) accepted.push(writeFrame(link.ws, frame(MAX_FRAME_BYTES - 1024)));
    await expect(writeFrame(link.ws, frame(2 * MAX_FRAME_BYTES))).rejects.toThrow("resync_required");
    await link.drain(); await Promise.all(accepted);
  }, 20_000);
});
