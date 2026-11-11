import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { HubAuth } from "../src/hub/auth.js";
import { reviewAccessIssuedSchema, reviewAccessStatusSchema } from "../src/client-protocol/pairing-invites.js";
import { enrollTrusted, invitedPairing, issueInvite, loginFor, pairingRequestId, testDevice } from "./helpers/pairing-invite.js";

const DAY = 86_400_000;
let root: string, store: HubStore, auth: HubAuth, wall: number, mono: number;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-review-access-"));
  wall = 1_790_000_000_000; mono = 10_000;
  store = await HubStore.open(root);
  auth = await HubAuth.open(store, root, () => wall, () => mono);
  await enrollTrusted(auth, testDevice("owner_phone"));
});
afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
const rejects = (work: Promise<unknown>, code: string, status: number) => expect(work).rejects.toMatchObject({ code, status });
const enrolledTo = (deviceId: string) => store.db.get<{ user_id: string; revoked: number }>("SELECT user_id,revoked FROM devices WHERE id=?", [deviceId]);
const reviewer = (id: string) => testDevice(id);
const remote = "relay:r:203.0.113.5";

describe("review access", () => {
  it("is off until enabled and stores only the token's hash", async () => {
    expect(reviewAccessStatusSchema.parse(await auth.reviewAccessStatus())).toEqual({ enabled: false, approvedDevices: 0, serverTime: wall });
    const issued = reviewAccessIssuedSchema.parse(await auth.enableReviewAccess({ days: 14, maxDevices: 3 }));
    expect(issued.status).toEqual({ enabled: true, createdAt: wall, expiresAt: wall + 14 * DAY, maxDevices: 3, approvedDevices: 0, serverTime: wall });
    await store.flushAudit();
    expect(JSON.stringify(await store.db.all("SELECT * FROM meta"))).not.toContain(issued.invite);
    expect(JSON.stringify(await store.db.all("SELECT * FROM audit_log"))).not.toContain(issued.invite);
    expect(JSON.stringify(await auth.reviewAccessStatus())).not.toContain(issued.invite);
  });

  it("enrolls a device presenting the token without an approval step, from any source", async () => {
    const { invite } = await auth.enableReviewAccess({ days: 14, maxDevices: 3 });
    const phone = reviewer("review_phone");
    const result = await auth.pairInvited(invitedPairing(phone, invite, pairingRequestId()), remote);
    expect(result).toEqual({ code: expect.stringMatching(/^\d{8}$/), expiresAt: expect.any(Number), hubPublicKey: auth.publicKey });
    expect(await enrolledTo(phone.deviceId)).toEqual({ user_id: "owner", revoked: 0 });
    // It authenticates at once, like any approved network device.
    await expect(loginFor(auth, phone, remote)).resolves.toMatchObject({ session: { deviceId: phone.deviceId, userId: "owner" } });
    expect((await auth.reviewAccessStatus()).approvedDevices).toBe(1);
    // A lost receipt: the client's retry is told the device is already registered.
    await rejects(auth.pairInvited(invitedPairing(phone, invite, pairingRequestId()), remote), "device_already_registered", 409);
    expect((await auth.reviewAccessStatus()).approvedDevices).toBe(1);
  });

  it("stops at the device limit and at expiry", async () => {
    const { invite } = await auth.enableReviewAccess({ days: 2, maxDevices: 2 });
    await auth.pairInvited(invitedPairing(reviewer("a"), invite, pairingRequestId()), remote);
    await auth.pairInvited(invitedPairing(reviewer("b"), invite, pairingRequestId()), remote);
    await rejects(auth.pairInvited(invitedPairing(reviewer("c"), invite, pairingRequestId()), remote), "pairing_invites_full", 429);
    expect(await enrolledTo("c")).toBeUndefined();
    expect((await auth.reviewAccessStatus()).enabled).toBe(false);

    const again = await auth.enableReviewAccess({ days: 2, maxDevices: 5 });
    wall += 2 * DAY;
    await rejects(auth.pairInvited(invitedPairing(reviewer("d"), again.invite, pairingRequestId()), remote), "pairing_invite_expired", 403);
    expect(await enrolledTo("d")).toBeUndefined();
    expect((await auth.reviewAccessStatus()).enabled).toBe(false);
  });

  it("refuses wrong, replaced and disabled tokens like any unknown invite", async () => {
    const first = await auth.enableReviewAccess({ days: 14, maxDevices: 5 });
    await rejects(auth.pairInvited(invitedPairing(reviewer("a"), randomBytes(32).toString("base64url"), pairingRequestId()), remote), "pairing_invite_invalid", 403);
    const second = await auth.enableReviewAccess({ days: 14, maxDevices: 5 });
    await rejects(auth.pairInvited(invitedPairing(reviewer("b"), first.invite, pairingRequestId()), remote), "pairing_invite_invalid", 403);
    await auth.pairInvited(invitedPairing(reviewer("c"), second.invite, pairingRequestId()), remote);
    expect(await auth.disableReviewAccess()).toMatchObject({ enabled: false });
    await rejects(auth.pairInvited(invitedPairing(reviewer("d"), second.invite, pairingRequestId()), remote), "pairing_invite_invalid", 403);
    // Disabling stops new admissions only; the admitted device stays until revoked.
    expect(await enrolledTo("c")).toEqual({ user_id: "owner", revoked: 0 });
    for (const id of ["a", "b", "d"]) expect(await enrolledTo(id)).toBeUndefined();
  });

  it("survives a Hub restart", async () => {
    const { invite } = await auth.enableReviewAccess({ days: 14, maxDevices: 5 });
    const restarted = await HubAuth.open(store, root, () => wall, () => mono);
    await restarted.pairInvited(invitedPairing(reviewer("after_restart"), invite, pairingRequestId()), remote);
    expect(await enrolledTo("after_restart")).toEqual({ user_id: "owner", revoked: 0 });
  });

  it("leaves ordinary invites needing the owner's approval", async () => {
    await auth.enableReviewAccess({ days: 14, maxDevices: 5 });
    const owner = testDevice("owner_laptop"), session = await enrollTrusted(auth, owner);
    const { invite } = await issueInvite(auth, session);
    const phone = reviewer("ordinary_phone");
    await auth.pairInvited(invitedPairing(phone, invite, pairingRequestId()), remote);
    expect(await enrolledTo(phone.deviceId)).toBeUndefined();
    expect((await auth.reviewAccessStatus()).approvedDevices).toBe(0);
  });

  it("validates the limits", async () => {
    for (const input of [{ days: 0, maxDevices: 1 }, { days: 31, maxDevices: 1 }, { days: 1, maxDevices: 0 }, { days: 1, maxDevices: 21 }, { days: 1.5, maxDevices: 1 }, { days: 1, maxDevices: 1, extra: true }])
      await expect(auth.enableReviewAccess(input)).rejects.toThrow();
  });
});
