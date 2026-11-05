import { deflateSync } from "node:zlib";
export function pngChunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(body.length + 12); out.writeUInt32BE(body.length); out.write(type, 4); body.copy(out, 8);
  let crc = 0xffffffff; for (const byte of out.subarray(4, out.length - 4)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
export function avatarFixture(width = 256, height = width, color = 80, metadata = false): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 4 + 1) + 1 + x * 4; rows[at] = color; rows[at + 1] = x % 256; rows[at + 2] = y % 256; rows[at + 3] = 255; }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), ...(metadata ? [pngChunk("tEXt", Buffer.from("location\0private"))] : []), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}
export const avatarDataUrl = (bytes = avatarFixture()) => `data:image/png;base64,${bytes.toString("base64")}`;
