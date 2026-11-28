import { createHmac, timingSafeEqual } from "node:crypto";

const MAGIC = 0x2112a442;
export const STUN = {
  binding: 0x0001, allocate: 0x0003, refresh: 0x0004, permission: 0x0008, channelBind: 0x0009,
  send: 0x0016, dataIndication: 0x0017,
  channel: 0x000c, lifetime: 0x000d, peer: 0x0012, data: 0x0013, realm: 0x0014, nonce: 0x0015,
  relayed: 0x0016, transport: 0x0019, mapped: 0x0020,
  username: 0x0006, integrity: 0x0008, error: 0x0009,
} as const;

export type StunAddress = { address: string; port: number };
export type StunMessage = { type: number; transaction: Buffer; attributes: Map<number, Buffer>; authenticated: (key: Buffer) => boolean };

export function decodeStun(packet: Buffer): StunMessage | undefined {
  if (packet.length < 20 || packet[0] & 0xc0 || packet.readUInt32BE(4) !== MAGIC
    || packet.readUInt16BE(2) !== packet.length - 20 || packet.length % 4) return;
  const attributes = new Map<number, Buffer>();
  let integrityAt = 0;
  for (let at = 20; at < packet.length;) {
    const type = packet.readUInt16BE(at), size = packet.readUInt16BE(at + 2);
    const end = at + 4 + size, next = (end + 3) & ~3;
    if (next > packet.length) return;
    // Attributes following MESSAGE-INTEGRITY are outside its authentication.
    if (!integrityAt) {
      if (attributes.has(type)) return;
      attributes.set(type, packet.subarray(at + 4, end));
      if (type === STUN.integrity) {
        if (size !== 20) return;
        integrityAt = at;
      }
    }
    at = next;
  }
  return { type: packet.readUInt16BE(0), transaction: packet.subarray(8, 20), attributes, authenticated: key => {
    if (!integrityAt) return false;
    const header = Buffer.from(packet.subarray(0, 20));
    header.writeUInt16BE(integrityAt + 4, 2);
    const digest = createHmac("sha1", key).update(header).update(packet.subarray(20, integrityAt)).digest();
    return timingSafeEqual(digest, attributes.get(STUN.integrity)!);
  } };
}

export function encodeStun(type: number, transaction: Buffer, attributes: readonly (readonly [number, Buffer])[], key?: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type);
  header.writeUInt32BE(MAGIC, 4);
  transaction.copy(header, 8);
  const tlvs = attributes.map(([tag, value]) => {
    const tlv = Buffer.alloc(4 + ((value.length + 3) & ~3));
    tlv.writeUInt16BE(tag);
    tlv.writeUInt16BE(value.length, 2);
    value.copy(tlv, 4);
    return tlv;
  });
  header.writeUInt16BE(tlvs.reduce((sum, value) => sum + value.length, key ? 24 : 0), 2);
  const wire = Buffer.concat([header, ...tlvs]);
  if (!key) return wire;
  const signature = Buffer.alloc(24);
  signature.writeUInt16BE(STUN.integrity);
  signature.writeUInt16BE(20, 2);
  createHmac("sha1", key).update(wire).digest().copy(signature, 4);
  return Buffer.concat([wire, signature]);
}

export function stunNumber(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

export function encodeStunAddress({ address, port }: StunAddress): Buffer {
  const bytes = Buffer.alloc(8);
  bytes[1] = 1;
  bytes.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const ip = Buffer.from(address.split(".").map(Number));
  for (let i = 0; i < 4; i++) bytes[4 + i] = ip[i] ^ (MAGIC >>> (8 * (3 - i)) & 255);
  return bytes;
}

export function decodeStunAddress(bytes: Buffer | undefined): StunAddress | undefined {
  if (bytes?.length !== 8 || bytes.readUInt16BE(0) !== 1) return;
  const port = bytes.readUInt16BE(2) ^ (MAGIC >>> 16);
  const address = [...bytes.subarray(4)].map((octet, i) => octet ^ (MAGIC >>> (8 * (3 - i)) & 255)).join(".");
  if (port) return { address, port };
}
