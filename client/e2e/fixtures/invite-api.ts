import { PAIRING_INVITES_PATH, PAIRING_INVITE_REVOKE_PATH, pairingInviteCreateSchema, pairingInviteRevokeSchema, type PairingInviteStatus } from "../../../src/client-protocol/pairing-invites.js";
import { randomNonce } from "../../src/identity.js";

/** Component fixture only: mirror the owner HTTP contract, including lifecycle
 * and schema validation. Real authentication/admission is tested with real Hubs. */
export function inviteApiFixture() {
  const calls: { path: string; method: string }[] = [];
  const records = new Map<string, PairingInviteStatus>();
  const requests = new Map<string, string>();
  const close = (id: string) => { const record = records.get(id); if (!record) throw Error("pairing_invite_not_found"); record.state = "closed"; return { ...record }; };
  return {
    calls,
    async http(path: string, init: RequestInit = {}) {
      const method = (init.method ?? "GET").toUpperCase(); calls.push({ path, method });
      if (path === PAIRING_INVITE_REVOKE_PATH && method === "POST") return close(pairingInviteRevokeSchema.parse(JSON.parse(String(init.body))).id);
      if (path !== PAIRING_INVITES_PATH) throw Error("unexpected_invitation_endpoint");
      const serverTime = Date.now();
      if (method === "GET") return { invites: [...records.values()].map(record => ({ ...record, state: record.expiresAt <= serverTime ? "expired" : record.state })), serverTime };
      if (method !== "POST") throw Error("unexpected_invitation_method");
      const body = pairingInviteCreateSchema.parse(JSON.parse(String(init.body)));
      if (body.replaces) close(body.replaces);
      const previous = requests.get(body.requestId); if (previous) close(previous);
      const id = randomNonce().slice(0, 22), invite = randomNonce(), expiresAt = serverTime + 300_000;
      records.set(id, { id, createdAt: serverTime, expiresAt, state: "available" }); requests.set(body.requestId, id);
      return { id, invite, serverTime, expiresAt };
    },
  };
}
