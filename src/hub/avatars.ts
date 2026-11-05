import { inflateSync } from "node:zlib";
import { AVATAR_EDGE, MAX_AVATAR_BYTES, avatarPatchSchema, avatarTargetSchema, type AvatarTarget, type ProfileAvatar } from "../client-protocol/avatars.js";
import { HubError, type HubStore } from "./store.js";
import type { AuthSession } from "./auth.js";

type Row = { kind: AvatarTarget["kind"]; target_id: string; revision: number; png: Buffer | null };
const metadata = (row: Row): ProfileAvatar => ({ kind: row.kind, id: row.target_id, revision: row.revision, hasImage: row.png !== null });
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes: Buffer): number { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
/** Only bounded static raster PNGs; no external URLs, SVG, animation or metadata.
 * The client decodes/crops/re-encodes before upload. Validate decompression too. */
export function avatarPng(dataUrl: string): Buffer {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new HubError("avatar_invalid_image", 422);
  const encoded = dataUrl.slice(22), bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_AVATAR_BYTES) throw new HubError("avatar_too_large", 413);
  if (bytes.toString("base64") !== encoded || bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new HubError("avatar_invalid_image", 422);
  const kept = [bytes.subarray(0, 8)], compressed: Buffer[] = [];
  let at = 8, width = 0, height = 0, channels = 0, ended = false;
  while (at + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(at), end = at + size + 12;
    if (end > bytes.length || size > MAX_AVATAR_BYTES) throw new HubError("avatar_invalid_image", 422);
    const type = bytes.toString("ascii", at + 4, at + 8), body = bytes.subarray(at + 8, end - 4);
    if (crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new HubError("avatar_invalid_image", 422);
    if (at === 8) {
      if (type !== "IHDR" || size !== 13) throw new HubError("avatar_invalid_image", 422);
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (!width || width !== height || width > AVATAR_EDGE || body[8] !== 8 || !channels || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) throw new HubError("avatar_invalid_image", 422);
      kept.push(bytes.subarray(at, end));
    } else if (type === "IDAT") { compressed.push(body); kept.push(bytes.subarray(at, end)); }
    else if (type === "IEND" && size === 0 && compressed.length && end === bytes.length) { kept.push(bytes.subarray(at, end)); ended = true; break; }
    else if (type === "acTL" || type === "IHDR" || /^[A-Z]/.test(type)) throw new HubError("avatar_invalid_image", 422);
    // Discard ancillary chunks, including EXIF/text/location metadata.
    at = end;
  }
  if (!ended) throw new HubError("avatar_invalid_image", 422);
  const stride = width * channels + 1, expected = stride * height;
  try { const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }); if (decoded.length !== expected || Array.from({ length: height }, (_, y) => decoded[y * stride]!).some((filter) => filter > 4)) throw new Error("invalid raster"); }
  catch { throw new HubError("avatar_invalid_image", 422); }
  return Buffer.concat(kept);
}
export class HubAvatars {
  constructor(readonly store: HubStore) {}
  private async allowed(userId: string, target: AvatarTarget, write = false): Promise<boolean> {
    const db = this.store.db, owner = !!await db.get("SELECT 1 FROM users WHERE id=? AND role='owner'", [userId]);
    if (target.kind === "user") {
      if (!await db.get("SELECT 1 FROM users WHERE id=?", [target.id])) return false;
      return target.id === userId || !write && !!await db.get("SELECT 1 FROM conversation_members a JOIN conversation_members b ON a.conversation_id=b.conversation_id WHERE a.member_type='user' AND a.member_id=? AND b.member_type='user' AND b.member_id=?", [userId, target.id]);
    }
    if (target.kind === "bot") {
      if (!await db.get("SELECT 1 FROM bots WHERE id=?", [target.id])) return false;
      return owner || !write && (!!await db.get("SELECT 1 FROM bot_grants WHERE user_id=? AND bot_id=?", [userId, target.id]) || !!await db.get("SELECT 1 FROM conversation_members a JOIN conversation_members b ON a.conversation_id=b.conversation_id WHERE a.member_type='user' AND a.member_id=? AND b.member_type='bot' AND b.member_id=?", [userId, target.id]));
    }
    // `group` is the existing wire/storage namespace for conversation pictures.
    // Reusing it keeps older clients able to parse ready/avatar.updated frames.
    const conversation = await db.get<{ owner_id: string; type: string }>("SELECT owner_id,type FROM conversations WHERE id=? AND parent_id IS NULL", [target.id]);
    return !!conversation && !!await db.get("SELECT 1 FROM conversation_members WHERE conversation_id=? AND member_type='user' AND member_id=?", [target.id, userId]) && (!write || conversation.owner_id === userId || conversation.type === "group" && owner);
  }
  private async validateSession(userId: string, session?: AuthSession): Promise<void> {
    if (session && (session.userId !== userId || session.expiresAt <= Date.now() || !await this.store.db.get("SELECT 1 FROM devices WHERE id=? AND user_id=? AND revoked=0", [session.deviceId, userId]))) throw new HubError("device_revoked", 401);
  }
  canRead(userId: string, target: AvatarTarget): Promise<boolean> { return this.store.db.serial(() => this.allowed(userId, target)); }
  list(userId: string, session?: AuthSession): Promise<ProfileAvatar[]> {
    return this.store.db.serial(async () => {
      await this.validateSession(userId, session);
      const rows = await this.store.db.all<Row>("SELECT kind,target_id,revision,CASE WHEN png IS NULL THEN NULL ELSE 1 END AS png FROM profile_avatars");
      const result: ProfileAvatar[] = []; for (const row of rows) if (await this.allowed(userId, { kind: row.kind, id: row.target_id })) result.push(metadata(row)); return result;
    });
  }
  async set(userId: string, rawTarget: AvatarTarget, rawPatch: unknown, session?: AuthSession): Promise<ProfileAvatar> {
    const target = avatarTargetSchema.parse(rawTarget), patch = avatarPatchSchema.parse(rawPatch);
    const png = patch.dataUrl === null ? null : avatarPng(patch.dataUrl);
    return this.store.db.transaction(async () => {
      await this.validateSession(userId, session);
      if (!await this.allowed(userId, target, true)) throw new HubError("avatar_forbidden", 403);
      const old = await this.store.db.get<Row>("SELECT * FROM profile_avatars WHERE kind=? AND target_id=?", [target.kind, target.id]);
      if ((old?.revision ?? 0) !== patch.expectedRevision) throw new HubError("avatar_conflict", 409);
      const revision = (old?.revision ?? 0) + 1;
      await this.store.db.run("INSERT INTO profile_avatars(kind,target_id,revision,png) VALUES(?,?,?,?) ON CONFLICT(kind,target_id) DO UPDATE SET revision=excluded.revision,png=excluded.png", [target.kind, target.id, revision, png]);
      await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), userId, "avatar.updated", JSON.stringify({ ...target, revision, hasImage: !!png })]);
      return { ...target, revision, hasImage: !!png };
    });
  }
  image(userId: string, target: AvatarTarget, revision: number, session?: AuthSession): Promise<Buffer> {
    return this.store.db.serial(async () => {
      await this.validateSession(userId, session);
      if (!await this.allowed(userId, target)) throw new HubError("avatar_forbidden", 403);
      const row = await this.store.db.get<Row>("SELECT * FROM profile_avatars WHERE kind=? AND target_id=?", [target.kind, target.id]);
      if (!row?.png || row.revision !== revision) throw new HubError("avatar_not_found", 404); return row.png;
    });
  }
}
