import { expect, type Page } from "@playwright/test";
import type { HubServer } from "../../../src/hub/server.js";
import { enrollTrusted, issueInvite, sessionFor, pairingRequestId, testDevice, type TestDevice } from "../../../tests/helpers/pairing-invite.js";
import { pairingLink, type PairingPayload } from "../../src/pairing-link.js";

const issuers = new WeakMap<HubServer, Promise<{ device: TestDevice; requestId: string }>>();
/** A real, explicitly trusted fixture owner issues the same bounded invitation
 * as production. Test setup does not weaken public /api/pair or mutate requests. */
export async function fixtureInvitation(hub: HubServer) {
  let owner = issuers.get(hub);
  if (!owner) { const device = testDevice("pairing_fixture_owner", "Fixture invitation issuer"); owner = enrollTrusted(hub.auth, device).then(() => ({ device, requestId: pairingRequestId() })); issuers.set(hub, owner); }
  const issuer = await owner;
  return issueInvite(hub.auth, await sessionFor(hub.auth, issuer.device), { requestId: issuer.requestId });
}
/** Import through the visible paste flow, retaining any device name already
 * entered by the test. Approval remains the caller's separate explicit step. */
export async function preparePairing(page: Page, hub: HubServer, routes?: Extract<PairingPayload, { kind: "connect" }>["routes"]) {
  const invitation = await fixtureInvitation(hub);
  const address = page.getByLabel("Hub 地址", { exact: true });
  const url = await address.isVisible() ? (await address.inputValue()) || hub.url : hub.url;
  const certificate = Array.isArray(hub.options.tls?.cert) ? hub.options.tls.cert[0] : hub.options.tls?.cert;
  const certificateAuthority = typeof certificate === "string" || Buffer.isBuffer(certificate) ? Buffer.from(certificate).toString("utf8").replace(/-----[^-]+-----/g, "").replace(/\s/g, "") : undefined;
  const payload: Extract<PairingPayload, { kind: "connect" }> = { v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite,
    routes: routes ?? [{ name: "Direct", url, ...(certificateAuthority ? { certificateAuthority } : {}) }] };
  await page.getByRole("button", { name: "粘贴连接信息", exact: true }).click();
  await page.getByLabel("配对信息", { exact: true }).fill(pairingLink(payload));
  await page.getByRole("button", { name: "使用配对信息", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "粘贴配对信息", exact: true })).toBeHidden();
  return invitation;
}
