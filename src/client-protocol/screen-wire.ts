/** Video only: fixed binary header plus an unmodified WebCodecs chunk. Pure
 * module, usable by Electron main, sandboxed capture and viewer, and the Hub. */
export const SCREEN_HEADER_BYTES = 32;
export const SCREEN_PACKET_LIMIT = 1024 * 1024;
export type ScreenFrameHeader = { key: boolean; codec: "h264" | "vp8"; sequence: number; geometryRevision: number; streamGeneration: number; captureMs: number; width: number; height: number };
export function readScreenFrame(bytes: Uint8Array): ScreenFrameHeader {
  if (bytes.byteLength <= SCREEN_HEADER_BYTES || bytes.byteLength > SCREEN_PACKET_LIMIT) throw new Error("screen_frame_size");
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (d.getUint8(0) !== 1 || d.getUint8(1) > 1 || ![1, 2].includes(d.getUint16(2, true)) || d.getUint32(28, true) !== bytes.byteLength - SCREEN_HEADER_BYTES) throw new Error("screen_frame_header");
  const frame: ScreenFrameHeader = { key: d.getUint8(1) === 1, codec: d.getUint16(2, true) === 1 ? "h264" : "vp8", sequence: d.getUint32(4, true), geometryRevision: d.getUint32(8, true), streamGeneration: d.getUint32(12, true), captureMs: d.getFloat64(16, true), width: d.getUint16(24, true), height: d.getUint16(26, true) };
  if (!frame.sequence || !frame.geometryRevision || !frame.streamGeneration || !Number.isSafeInteger(frame.captureMs) || frame.captureMs < 0 || !frame.width || !frame.height || frame.width > 4096 || frame.height > 4096 || frame.width * frame.height > 8294400) throw new Error("screen_frame_geometry");
  return frame;
}
export function writeScreenFrame(frame: ScreenFrameHeader, payload: Uint8Array): Uint8Array {
  if (!payload.byteLength || payload.byteLength + SCREEN_HEADER_BYTES > SCREEN_PACKET_LIMIT) throw new Error("screen_frame_size");
  for (const n of [frame.sequence, frame.geometryRevision, frame.streamGeneration]) if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new Error("screen_frame_sequence");
  if (!["h264", "vp8"].includes(frame.codec) || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 4096 || frame.height > 4096) throw new Error("screen_frame_geometry");
  const bytes = new Uint8Array(SCREEN_HEADER_BYTES + payload.byteLength), d = new DataView(bytes.buffer);
  d.setUint8(0, 1); d.setUint8(1, frame.key ? 1 : 0); d.setUint16(2, frame.codec === "h264" ? 1 : 2, true);
  d.setUint32(4, frame.sequence, true); d.setUint32(8, frame.geometryRevision, true); d.setUint32(12, frame.streamGeneration, true); d.setFloat64(16, frame.captureMs, true);
  d.setUint16(24, frame.width, true); d.setUint16(26, frame.height, true); d.setUint32(28, payload.byteLength, true); bytes.set(payload, SCREEN_HEADER_BYTES);
  readScreenFrame(bytes); return bytes;
}
