import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { REVIEW_ACCESS_CAPABILITY, REVIEW_ACCESS_DISABLE_PATH, REVIEW_ACCESS_PATH, reviewAccessIssuedSchema } from "../src/client-protocol/pairing-invites.js";
import { CAPABILITIES } from "../src/client-protocol/index.js";
import { deviceFields, enrollTrusted, loginFor, pairingRequestId, postPairing, testDevice } from "./helpers/pairing-invite.js";

let directory: string, hub: HubServer;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "hub-review-http-")); hub = await HubServer.start({ stateDir: directory }); });
afterEach(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });

it("enables review access only for a local owner and enrolls its devices without approval", async () => {
  expect(CAPABILITIES).toContain(REVIEW_ACCESS_CAPABILITY);
  const owner = testDevice("owner_phone"); await enrollTrusted(hub.auth, owner);
  const headers = { Authorization: `Bearer ${(await loginFor(hub.auth, owner)).token}` };
  const enable = () => fetch(`${hub.url}${REVIEW_ACCESS_PATH}`, { method: "POST", headers, body: JSON.stringify({ days: 14, maxDevices: 2 }) });
  expect((await fetch(`${hub.url}${REVIEW_ACCESS_PATH}`, { method: "POST", body: JSON.stringify({ days: 14, maxDevices: 2 }) })).status).toBe(401);
  // A relayed or network caller is refused even with an owner session.
  const sources = (hub as unknown as { relaySources: { source: (socket: unknown) => string } }).relaySources;
  const original = sources.source.bind(sources);
  sources.source = () => "relay:r:203.0.113.5";
  try {
    for (const response of [await enable(), await fetch(`${hub.url}${REVIEW_ACCESS_PATH}`, { headers }), await fetch(`${hub.url}${REVIEW_ACCESS_DISABLE_PATH}`, { method: "POST", headers, body: "{}" })])
      expect([response.status, await response.json()]).toEqual([403, { error: "local_controller_required" }]);
  } finally { sources.source = original; }
  const created = await enable(); expect(created.status).toBe(201);
  const issued = reviewAccessIssuedSchema.parse(await created.json());
  const phone = testDevice("review_phone");
  expect(await postPairing(hub.url, { ...deviceFields(phone), invite: issued.invite, requestId: pairingRequestId() }))
    .toEqual({ status: 201, body: { code: expect.stringMatching(/^\d{8}$/), expiresAt: expect.any(Number), hubPublicKey: hub.auth.publicKey } });
  // No approval step: the device authenticates straight away.
  await expect(loginFor(hub.auth, phone, "relay:r:203.0.113.5")).resolves.toMatchObject({ session: { deviceId: phone.deviceId, userId: "owner" } });
  const status = await (await fetch(`${hub.url}${REVIEW_ACCESS_PATH}`, { headers })).json();
  expect(status).toMatchObject({ enabled: true, approvedDevices: 1, maxDevices: 2 });
  expect(JSON.stringify(status)).not.toContain(issued.invite);
  expect(await (await fetch(`${hub.url}${REVIEW_ACCESS_DISABLE_PATH}`, { method: "POST", headers, body: "{}" })).json()).toMatchObject({ enabled: false });
  expect(await postPairing(hub.url, { ...deviceFields(testDevice("late_phone")), invite: issued.invite, requestId: pairingRequestId() }))
    .toEqual({ status: 403, body: { error: "pairing_invite_invalid" } });
});
