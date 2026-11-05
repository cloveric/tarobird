import { randomBytes, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { HubAuth, type AuthSession } from "../src/hub/auth.js";
import { MAX_DEAD_RECORDS, PairingInviteRegistry } from "../src/hub/pairing-invites.js";
import { pairingSchema } from "../src/client-protocol/index.js";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import { MAX_PAIRING_INVITES, MAX_PAIRING_INVITES_PER_CREATOR, PAIRING_INVITE_TTL_MS, pairRequestSchema, pairingInviteIssuedSchema, pairingInviteListSchema } from "../src/client-protocol/pairing-invites.js";
import { deviceFields, enrollTrusted, invitedPairing, issueInvite, loginFor, pairingRequestId, sessionFor, testDevice, type TestDevice } from "./helpers/pairing-invite.js";

const MINUTE = 60_000;
let root: string, store: HubStore, auth: HubAuth, wall: number, mono: number;
let owner: TestDevice, session: AuthSession;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-pairing-invites-"));
  wall = 1_790_000_000_000; mono = 10_000;
  store = await HubStore.open(root);
  auth = await HubAuth.open(store, root, () => wall, () => mono);
  owner = testDevice("owner_phone"); session = await enrollTrusted(auth, owner);
});
afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
const advance = (wallMs: number, monoMs = wallMs) => { wall += wallMs; mono += monoMs; };
const pending = (deviceId: string) => store.db.all<{ code_hash: string; expires_at: number }>("SELECT code_hash,expires_at FROM pairing_requests WHERE device_id=? AND status='pending'", [deviceId]);
const enrolled = async (deviceId: string) => !!await store.db.get("SELECT 1 FROM devices WHERE id=?", [deviceId]);
const rejects = (work: Promise<unknown>, code: string, status: number) => expect(work).rejects.toMatchObject({ code, status });
/** Serializes Maps so private registry state can be searched for secrets. */
const dump = (value: unknown) => JSON.stringify(value, (_key, item) => item instanceof Map ? [...item.entries()] : item instanceof Promise ? "promise" : item);

describe("issuance", () => {
  it("returns a 256-bit token once to an owner session and retains only its hash", async () => {
    const issued = pairingInviteIssuedSchema.parse(await issueInvite(auth, session));
    expect(issued.expiresAt).toBe(wall + PAIRING_INVITE_TTL_MS);
    expect(issued.serverTime).toBe(wall);
    expect(dump((auth as unknown as { invites: unknown }).invites)).not.toContain(issued.invite);
    await store.flushAudit();
    expect(JSON.stringify(await store.db.all("SELECT * FROM audit_log"))).not.toContain(issued.invite);
    expect(JSON.stringify(await store.db.all("SELECT * FROM meta"))).not.toContain(issued.invite);
    const list = pairingInviteListSchema.parse(await auth.listPairingInvites(session));
    expect(list.invites).toEqual([{ id: issued.id, state: "available", createdAt: wall, expiresAt: issued.expiresAt }]);
    expect(JSON.stringify(list)).not.toContain(issued.invite);
  });

  it("refuses members, revoked devices and expired sessions", async () => {
    await store.db.run("INSERT INTO users VALUES ('member','Member','member')");
    const member = await enrollTrusted(auth, testDevice("member_phone"), "member");
    await rejects(issueInvite(auth, member), "owner_required", 403);
    const other = testDevice("old_tablet"), otherSession = await enrollTrusted(auth, other);
    await auth.revoke(other.deviceId, "local-owner");
    await rejects(issueInvite(auth, otherSession), "device_revoked", 401);
    await rejects(auth.listPairingInvites(otherSession), "device_revoked", 401);
    advance(16 * MINUTE);
    await rejects(issueInvite(auth, session), "session_expired", 401);
  });

  it("never changes the Hub identity or enrolled devices", async () => {
    const before = [auth.publicKey, await readFile(path.join(root, "identity.json"), "utf8"), await store.db.all("SELECT * FROM devices ORDER BY id")];
    const first = await issueInvite(auth, session), second = await issueInvite(auth, session, { replaces: first.id });
    await auth.revokePairingInvite(session, { id: second.id }); await auth.listPairingInvites(session);
    await auth.pairInvited(invitedPairing(testDevice("new_phone"), (await issueInvite(auth, session)).invite, pairingRequestId()), "relay:r:203.0.113.5");
    expect([auth.publicKey, await readFile(path.join(root, "identity.json"), "utf8"), await store.db.all("SELECT * FROM devices ORDER BY id")]).toEqual(before);
  });

  it("bounds each creator and never evicts another creator's live invite", async () => {
    const mine = [];
    for (let i = 0; i < MAX_PAIRING_INVITES_PER_CREATOR; i++) mine.push(await issueInvite(auth, session));
    await rejects(issueInvite(auth, session), "pairing_invites_full", 429);
    const second = await enrollTrusted(auth, testDevice("owner_laptop"));
    await issueInvite(auth, second);
    expect((await auth.listPairingInvites(session)).invites.map(invite => invite.state)).toEqual(Array(MAX_PAIRING_INVITES_PER_CREATOR).fill("available"));
    // A claimed invite keeps its slot while its request awaits approval, and
    // closing it frees nothing: claiming cannot be used to exceed the limit.
    const { code } = await auth.pairInvited(invitedPairing(testDevice("new_phone"), mine[0]!.invite, pairingRequestId()), "relay:r:203.0.113.5");
    await rejects(issueInvite(auth, session), "pairing_invites_full", 429);
    await rejects(issueInvite(auth, session, { replaces: mine[0]!.id }), "pairing_invites_full", 429);
    await auth.approve(code, "local-owner");
    await issueInvite(auth, session);
    await rejects(issueInvite(auth, session), "pairing_invites_full", 429);
  });

  it("frees a claimed slot when its request expires", async () => {
    for (let i = 0; i < MAX_PAIRING_INVITES_PER_CREATOR; i++) {
      const invite = (await issueInvite(auth, session)).invite;
      await auth.pairInvited(invitedPairing(testDevice(`phone_${i}`), invite, pairingRequestId()), "203.0.113.5");
    }
    await rejects(issueInvite(auth, session), "pairing_invites_full", 429);
    advance(5 * MINUTE);
    await issueInvite(auth, session);
  });

  it("bounds all creators together without closing anything", () => {
    let wallNow = 1_000, monoNow = 1;
    const registry = new PairingInviteRegistry(() => wallNow, () => monoNow);
    const creators = Array.from({ length: MAX_PAIRING_INVITES / MAX_PAIRING_INVITES_PER_CREATOR + 1 }, (_, i) => ({ deviceId: `creator_${i}`, publicKey: `key_${i}` }));
    for (const creator of creators.slice(0, -1)) for (let i = 0; i < MAX_PAIRING_INVITES_PER_CREATOR; i++) registry.issue(creator, pairingRequestId());
    expect(() => registry.issue(creators.at(-1)!, pairingRequestId())).toThrow("pairing_invites_full");
    expect(creators.slice(0, -1).flatMap(creator => registry.list(creator.deviceId)).every(record => registry.status(record).state === "available")).toBe(true);
    wallNow += PAIRING_INVITE_TTL_MS; monoNow += PAIRING_INVITE_TTL_MS;
    expect(() => registry.issue(creators.at(-1)!, pairingRequestId())).not.toThrow();
  });

  it("lets a retried issuance replace only the unclaimed invite from the same request", async () => {
    const requestId = pairingRequestId();
    const lost = await issueInvite(auth, session, { requestId });
    for (let i = 0; i < MAX_PAIRING_INVITES_PER_CREATOR + 2; i++) await issueInvite(auth, session, { requestId });
    const current = await issueInvite(auth, session, { requestId });
    await rejects(auth.pairInvited(invitedPairing(testDevice("late_phone"), lost.invite, pairingRequestId()), "203.0.113.5"), "pairing_invite_invalid", 403);
    await expect(auth.pairInvited(invitedPairing(testDevice("new_phone"), current.invite, pairingRequestId()), "203.0.113.5")).resolves.toMatchObject({ hubPublicKey: auth.publicKey });
  });

  it("replaces only the caller's own invite, and nothing if issuance fails", async () => {
    const second = await enrollTrusted(auth, testDevice("owner_laptop"));
    const theirs = await issueInvite(auth, second);
    await rejects(issueInvite(auth, session, { replaces: theirs.id }), "pairing_invite_not_found", 404);
    await rejects(auth.revokePairingInvite(session, { id: theirs.id }), "pairing_invite_not_found", 404);
    expect((await auth.listPairingInvites(second)).invites[0]!.state).toBe("available");
    expect((await auth.listPairingInvites(session)).invites).toEqual([]);

    const mine = [];
    for (let i = 0; i < MAX_PAIRING_INVITES_PER_CREATOR; i++) mine.push(await issueInvite(auth, session));
    await auth.revokePairingInvite(session, { id: mine[0]!.id });
    const refill = await issueInvite(auth, session);
    // Replacing an already closed invite frees nothing: the request fails whole.
    await rejects(issueInvite(auth, session, { replaces: mine[0]!.id }), "pairing_invites_full", 429);
    const states = new Map((await auth.listPairingInvites(session)).invites.map(invite => [invite.id, invite.state]));
    expect([...mine.slice(1), refill].every(invite => states.get(invite.id) === "available")).toBe(true);
    const replacement = await issueInvite(auth, session, { replaces: mine[1]!.id });
    expect(new Map((await auth.listPairingInvites(session)).invites.map(invite => [invite.id, invite.state])).get(mine[1]!.id)).toBe("closed");
    await rejects(auth.pairInvited(invitedPairing(testDevice("a"), mine[1]!.invite, pairingRequestId()), "203.0.113.5"), "pairing_invite_invalid", 403);
    await auth.pairInvited(invitedPairing(testDevice("b"), replacement.invite, pairingRequestId()), "203.0.113.5");
  });
});

describe("admission", () => {
  it("requires an invite and request id from every source, with no loopback, relay or proxy exemption", async () => {
    const device = testDevice("new_phone"), invite = (await issueInvite(auth, session)).invite;
    for (const source of ["127.0.0.1", "::1", "relay:r:203.0.113.9", "relay:r:legacy", "unknown"]) {
      await rejects(auth.pairInvited(deviceFields(device), source), "pairing_invite_required", 403);
      await rejects(auth.pairInvited({ ...deviceFields(device), requestId: pairingRequestId() }, source), "pairing_invite_required", 403);
      await rejects(auth.pairInvited({ ...deviceFields(device), invite }, source), "pairing_request_id_required", 400);
      await rejects(auth.pairInvited(invitedPairing(device, randomBytes(32).toString("base64url"), pairingRequestId()), source), "pairing_invite_invalid", 403);
    }
    await expect(auth.pairInvited({ ...invitedPairing(device, invite, pairingRequestId()), extra: true }, "127.0.0.1")).rejects.toThrow();
    expect(await pending(device.deviceId)).toEqual([]);
  });

  it("binds the first committed request and returns the identical code to identical retries", async () => {
    const device = testDevice("new_phone"), body = invitedPairing(device, (await issueInvite(auth, session)).invite, pairingRequestId());
    const first = await auth.pairInvited(body, "relay:r:203.0.113.5");
    expect(first).toEqual({ code: expect.stringMatching(/^\d{8}$/), expiresAt: wall + 5 * MINUTE, hubPublicKey: auth.publicKey });
    advance(MINUTE);
    expect(await auth.pairInvited(structuredClone(body), "relay:r:198.51.100.7")).toEqual(first);
    expect(await pending(device.deviceId)).toHaveLength(1);
    expect(await enrolled(device.deviceId)).toBe(false);
    const status = (await auth.listPairingInvites(session)).invites[0]!;
    expect(status).toMatchObject({ state: "claimed", requestExpiresAt: first.expiresAt, device: { deviceId: device.deviceId, name: device.name, platform: device.platform } });
  });

  it("returns the same code to the same device fields and requestId without the token, admitting nothing", async () => {
    const device = testDevice("new_phone"), requestId = pairingRequestId();
    const first = await auth.pairInvited(invitedPairing(device, (await issueInvite(auth, session)).invite, requestId), "203.0.113.5");
    // The App was killed before the receipt: it kept identity and requestId only.
    expect(await auth.pairInvited({ ...deviceFields(device), requestId }, "198.51.100.7")).toEqual(first);
    // Scanning a fresh code meanwhile retrieves the same request and leaves the fresh invite unused.
    const fresh = await issueInvite(auth, session);
    expect(await auth.pairInvited(invitedPairing(device, fresh.invite, requestId), "203.0.113.5")).toEqual(first);
    expect((await auth.listPairingInvites(session)).invites.find(invite => invite.id === fresh.id)!.state).toBe("available");
    for (const altered of [{ ...deviceFields(device), name: "Renamed", requestId }, { ...deviceFields(testDevice("new_phone")), requestId }, { ...deviceFields(device), requestId: pairingRequestId() }])
      await rejects(auth.pairInvited(altered, "203.0.113.5"), "pairing_invite_required", 403);
    expect(await pending(device.deviceId)).toHaveLength(1);
  });

  it("refuses another device and any altered field of the bound request", async () => {
    const device = testDevice("new_phone"), requestId = pairingRequestId(), invite = (await issueInvite(auth, session)).invite;
    const body = invitedPairing(device, invite, requestId), first = await auth.pairInvited(body, "203.0.113.5");
    const variants = [invitedPairing(testDevice("stranger"), invite, requestId), { ...body, name: "Renamed" }, { ...body, platform: "android" },
      { ...body, requestId: pairingRequestId() }, { ...body, publicKey: testDevice("new_phone").publicKey }];
    for (const variant of variants) await rejects(auth.pairInvited(variant, "203.0.113.5"), "pairing_invite_used", 409);
    expect(await auth.pairInvited(body, "203.0.113.5")).toEqual(first);
    expect(await pending("stranger")).toEqual([]);
  });

  it("admits exactly one concurrent claimant and gives concurrent retries one result", async () => {
    const invite = (await issueInvite(auth, session)).invite, a = invitedPairing(testDevice("phone_a"), invite, pairingRequestId());
    const b = invitedPairing(testDevice("phone_b"), invite, pairingRequestId());
    const results = await Promise.allSettled([a, b, a, b, a].map(body => auth.pairInvited(body, "203.0.113.5")));
    const fulfilled = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const rejected = results.flatMap(result => result.status === "rejected" ? [result.reason as { code: string }] : []);
    expect(fulfilled).toHaveLength(3);
    expect(new Set(fulfilled.map(value => value.code)).size).toBe(1);
    expect(rejected.map(error => error.code)).toEqual(["pairing_invite_used", "pairing_invite_used"]);
    expect([(await pending("phone_a")).length, (await pending("phone_b")).length]).toEqual([1, 0]);
  });

  it("does not consume the invite when admission fails or rolls back", async () => {
    const invite = (await issueInvite(auth, session)).invite;
    await rejects(auth.pairInvited(invitedPairing(owner, invite, pairingRequestId()), "203.0.113.5"), "device_already_registered", 409);
    const original = store.db.run.bind(store.db); let fail = true;
    store.db.run = (async (sql: string, params?: never[]) => {
      if (fail && sql.startsWith("INSERT INTO pairing_requests")) { fail = false; throw new Error("disk_io_error"); }
      return original(sql, params);
    }) as typeof store.db.run;
    const device = testDevice("new_phone"), body = invitedPairing(device, invite, pairingRequestId());
    try { await expect(auth.pairInvited(body, "203.0.113.5")).rejects.toThrow("disk_io_error"); }
    finally { store.db.run = original; }
    expect(await pending(device.deviceId)).toEqual([]);
    expect((await auth.listPairingInvites(session)).invites[0]!.state).toBe("available");
    await expect(auth.pairInvited(body, "203.0.113.5")).resolves.toMatchObject({ code: expect.stringMatching(/^\d{8}$/) });
  });

  it("never enrolls a device: approval still needs the owner's signed device action", async () => {
    const device = testDevice("new_phone"), body = invitedPairing(device, (await issueInvite(auth, session)).invite, pairingRequestId());
    const { code } = await auth.pairInvited(body, "203.0.113.5");
    expect(await enrolled(device.deviceId)).toBe(false);
    await rejects(auth.approve(code, session.userId, "owner", session), "device_action_proof_required", 403);
    const { token, session: live } = await loginFor(auth, owner);
    const statement = await auth.prepareDeviceAction({ operation: "approve", target: code }, token, live);
    const proof = { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64") };
    expect(await auth.approve(code, live.userId, "owner", live, proof)).toBe(device.deviceId);
    await rejects(auth.pairInvited(body, "203.0.113.5"), "device_already_registered", 409);
  });

  it("keeps an admitted request through invite expiry, revocation and replacement", async () => {
    const issued = await issueInvite(auth, session), device = testDevice("new_phone");
    advance(4 * MINUTE);
    const body = invitedPairing(device, issued.invite, pairingRequestId()), first = await auth.pairInvited(body, "203.0.113.5");
    advance(2 * MINUTE); // the invite itself is now past its five minutes
    expect(await auth.pairInvited(body, "203.0.113.5")).toEqual(first);
    await auth.revokePairingInvite(session, { id: issued.id });
    await issueInvite(auth, session, { replaces: issued.id });
    expect(await auth.pairInvited(body, "203.0.113.5")).toEqual(first);
    expect(await auth.approve(first.code, "local-owner")).toBe(device.deviceId);
  });

  it("keeps an admitted request across a Hub restart but forgets every invite", async () => {
    const device = testDevice("new_phone"), body = invitedPairing(device, (await issueInvite(auth, session)).invite, pairingRequestId());
    const { code } = await auth.pairInvited(body, "203.0.113.5");
    const restarted = await HubAuth.open(store, root, () => wall, () => mono);
    await rejects(restarted.pairInvited(body, "203.0.113.5"), "pairing_invite_invalid", 403);
    await rejects(restarted.pairInvited({ ...deviceFields(device), requestId: body.requestId }, "203.0.113.5"), "pairing_invite_required", 403);
    // A fresh invite cannot replace a live request of the same device.
    const fresh = await issueInvite(restarted, await sessionFor(restarted, owner));
    await rejects(restarted.pairInvited(invitedPairing(device, fresh.invite, pairingRequestId()), "203.0.113.5"), "pairing_already_pending", 409);
    expect(await restarted.approve(code, "local-owner")).toBe(device.deviceId);
  });

  it("expires an unclaimed invite by either clock", async () => {
    const byWall = await issueInvite(auth, session);
    advance(PAIRING_INVITE_TTL_MS, 0);
    await rejects(auth.pairInvited(invitedPairing(testDevice("a"), byWall.invite, pairingRequestId()), "203.0.113.5"), "pairing_invite_expired", 403);
    const byMonotonic = await issueInvite(auth, session);
    advance(-60 * MINUTE, PAIRING_INVITE_TTL_MS); // wall clock stepped back, real time passed
    await rejects(auth.pairInvited(invitedPairing(testDevice("b"), byMonotonic.invite, pairingRequestId()), "203.0.113.5"), "pairing_invite_expired", 403);
    expect((await auth.listPairingInvites(session)).invites.map(invite => invite.state)).toEqual(["expired", "expired"]);
  });

  it("ends an admitted request after its own window; renewal needs a fresh invite", async () => {
    const device = testDevice("new_phone"), body = invitedPairing(device, (await issueInvite(auth, session)).invite, pairingRequestId());
    const first = await auth.pairInvited(body, "203.0.113.5");
    advance(5 * MINUTE);
    await rejects(auth.pairInvited(body, "203.0.113.5"), "pairing_invite_expired", 403);
    await rejects(auth.pairInvited({ ...deviceFields(device), requestId: body.requestId }, "203.0.113.5"), "pairing_invite_expired", 403);
    await rejects(auth.pairInvited(deviceFields(device), "203.0.113.5"), "pairing_invite_required", 403);
    const renewed = await auth.pairInvited(invitedPairing(device, (await issueInvite(auth, session)).invite, pairingRequestId()), "203.0.113.5");
    expect(renewed.expiresAt).toBe(wall + 5 * MINUTE);
    const rows = await pending(device.deviceId);
    expect(rows).toHaveLength(1);
    await rejects(auth.approve(first.code === renewed.code ? "00000000" : first.code, "local-owner"), "pairing_expired_or_invalid", 403);
    expect(await auth.approve(renewed.code, "local-owner")).toBe(device.deviceId);
  });

  it("stops admissions when the creator is revoked or its key no longer matches", async () => {
    const laptop = testDevice("owner_laptop"), laptopSession = await enrollTrusted(auth, laptop);
    const revoked = await issueInvite(auth, laptopSession);
    await auth.revoke(laptop.deviceId, "local-owner");
    await rejects(auth.pairInvited(invitedPairing(testDevice("a"), revoked.invite, pairingRequestId()), "203.0.113.5"), "pairing_invite_invalid", 403);
    const changed = await issueInvite(auth, session);
    await store.db.run("UPDATE devices SET public_key=? WHERE id=?", [testDevice("other").publicKey, owner.deviceId]);
    await rejects(auth.pairInvited(invitedPairing(testDevice("b"), changed.invite, pairingRequestId()), "203.0.113.5"), "pairing_invite_invalid", 403);
    expect([...await pending("a"), ...await pending("b")]).toEqual([]);
  });
});

describe("limits and secrets", () => {
  it("does not let invalid or missing invites occupy the shared per-source buckets", async () => {
    const forged = randomBytes(32).toString("base64url"), device = deviceFields(testDevice("flood"));
    for (let i = 0; i < 4100; i++) {
      const source = `relay:r:2001:db8::${i.toString(16)}`;
      await rejects(auth.pairInvited({ ...device, invite: forged, requestId: pairingRequestId() }, source), "pairing_invite_invalid", 403);
      await rejects(auth.pairInvited(device, source), "pairing_invite_required", 403);
    }
    expect(() => auth.tlsIdentity(randomBytes(32).toString("base64url"), Buffer.from("leaf"), "relay:r:2001:db8::beef")).not.toThrow();
  });

  it("limits failed claims per invite, but mismatched bodies cannot starve the bound device", async () => {
    const crowded = (await issueInvite(auth, session)).invite;
    for (let i = 0; i < 16; i++) await rejects(auth.pairInvited(invitedPairing(owner, crowded, pairingRequestId()), "203.0.113.5"), "device_already_registered", 409);
    await rejects(auth.pairInvited(invitedPairing(testDevice("late"), crowded, pairingRequestId()), "203.0.113.5"), "rate_limited", 429);
    const invite = (await issueInvite(auth, session)).invite, body = invitedPairing(testDevice("new_phone"), invite, pairingRequestId());
    const first = await auth.pairInvited(body, "203.0.113.5");
    for (let i = 0; i < 50; i++) await rejects(auth.pairInvited(invitedPairing(testDevice(`stranger_${i}`), invite, pairingRequestId()), `203.0.113.${i}`), "pairing_invite_used", 409);
    expect(await auth.pairInvited(body, "203.0.113.5")).toEqual(first);
  });

  it("keeps a hard bound under issue, claim and approval churn, and the owner list still parses", () => {
    let wallNow = 1_000, monoNow = 1;
    const registry = new PairingInviteRegistry(() => wallNow, () => monoNow), creator = { deviceId: "owner_phone", publicKey: "key" };
    const maps = registry as unknown as { byId: Map<string, unknown>; byHash: Map<string, unknown>; byRequest: Map<string, unknown> };
    const bound = MAX_PAIRING_INVITES + MAX_DEAD_RECORDS, sizes = () => Math.max(maps.byId.size, maps.byHash.size, maps.byRequest.size);
    const list = () => pairingInviteListSchema.parse({ invites: registry.list(creator.deviceId).map(record => registry.status(record)), serverTime: wallNow });
    // Everything happens well inside the retention window: only the hard cap applies.
    for (let i = 0; i < 300; i++) {
      const { record } = registry.issue(creator, pairingRequestId());
      registry.bind(record, { fingerprint: `request_${i}`, deviceId: `device_${i}`, name: "Phone", platform: "ios", code: "12345678" }, 5 * MINUTE);
      registry.approved(`device_${i}`);
      wallNow += 10; monoNow += 10;
      expect(sizes()).toBeLessThanOrEqual(bound);
    }
    expect(list().invites.length).toBeLessThanOrEqual(bound);
    for (let i = 0; i < 300; i++) registry.close(creator.deviceId, registry.issue(creator, pairingRequestId()).record.id);
    // Unapproved claims count as open, so issuance stops at the open cap instead of growing.
    for (let i = 0; i < 300; i++) {
      try { registry.bind(registry.issue(creator, pairingRequestId()).record, { fingerprint: `pending_${i}`, deviceId: `pending_${i}`, name: "Phone", platform: "ios", code: "12345678" }, 5 * MINUTE); }
      catch (error) { expect(error).toMatchObject({ code: "pairing_invites_full" }); }
    }
    expect(sizes()).toBeLessThanOrEqual(bound);
    expect(list().invites.length).toBeLessThanOrEqual(bound);
  });

  it("never drops a record with an operation in flight, but counts it against the bound", async () => {
    let wallNow = 1_000;
    const registry = new PairingInviteRegistry(() => wallNow, () => wallNow), creator = { deviceId: "owner_phone", publicKey: "key" };
    const maps = registry as unknown as { byId: Map<string, unknown> };
    const held = registry.issue(creator, pairingRequestId()).record;
    registry.close(creator.deviceId, held.id);
    let release!: () => void;
    const operation = registry.locked(held, () => new Promise<void>(resolve => { release = resolve; }));
    for (let i = 0; i < 200; i++) { registry.close(creator.deviceId, registry.issue(creator, pairingRequestId()).record.id); wallNow += 1; }
    expect(maps.byId.has(held.id)).toBe(true);
    expect(maps.byId.size).toBeLessThanOrEqual(MAX_DEAD_RECORDS + 1);
    await new Promise(resolve => setTimeout(resolve, 0)); // the locked work starts on a later tick
    release(); await operation;
    for (let i = 0; i < MAX_DEAD_RECORDS; i++) { registry.close(creator.deviceId, registry.issue(creator, pairingRequestId()).record.id); wallNow += 1; }
    expect(maps.byId.has(held.id)).toBe(false);
    expect(maps.byId.size).toBeLessThanOrEqual(MAX_DEAD_RECORDS + 1);
  });

  it("keeps plaintext codes and tokens out of the database and audit log", async () => {
    const issued = await issueInvite(auth, session), device = testDevice("new_phone");
    const { code } = await auth.pairInvited(invitedPairing(device, issued.invite, pairingRequestId()), "203.0.113.5");
    await store.flushAudit();
    const persisted = JSON.stringify([await store.db.all("SELECT * FROM pairing_requests"), await store.db.all("SELECT * FROM audit_log"), await store.db.all("SELECT * FROM meta")]);
    expect(persisted).not.toContain(issued.invite);
    // Searches every escaping level (audit detail is JSON inside JSON).
    expect(persisted).not.toContain(code);
    expect(persisted).toContain(issued.id);
  });

  it("retires pending requests from before invites exactly once", async () => {
    const legacy = testDevice("legacy_phone");
    await auth.pair(deviceFields(legacy), "127.0.0.1");
    expect(await auth.retireLegacyPendingPairings()).toBe(1);
    expect(await pending(legacy.deviceId)).toEqual([]);
    const later = testDevice("later_phone");
    await auth.pairInvited(invitedPairing(later, (await issueInvite(auth, session)).invite, pairingRequestId()), "203.0.113.5");
    expect(await (await HubAuth.open(store, root, () => wall, () => mono)).retireLegacyPendingPairings()).toBe(0);
    expect(await pending(later.deviceId)).toHaveLength(1);
  });

  it("accepts exactly the device fields of the enrollment schema", () => {
    const valid = deviceFields(testDevice("phone"));
    const samples: unknown[] = [valid, { ...valid, deviceId: "" }, { ...valid, deviceId: "a".repeat(129) }, { ...valid, deviceId: "bad id" }, { ...valid, name: "" },
      { ...valid, name: "n".repeat(101) }, { ...valid, platform: "linux" }, { ...valid, publicKey: "short" }, { ...valid, publicKey: "k".repeat(257) }, { ...valid, extra: 1 }];
    for (const sample of samples) expect(pairRequestSchema.safeParse(sample).success).toBe(pairingSchema.safeParse(sample).success);
    expect(Object.keys(pairRequestSchema.shape).filter(key => !(key in pairingSchema.shape)).sort()).toEqual(["invite", "requestId"]);
  });
});
