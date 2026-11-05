/** Isolated process fixture for SIGKILL recovery tests; never loads fleet config. */
import { HubServer } from "../../src/hub/server.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { bootstrapTrusted, deviceFields, issueInvite, sessionFor, testDevice } from "../../tests/helpers/pairing-invite.js";
import { pairingLink } from "../src/pairing-link.js";
const input = z.object({ stateDir: z.string(), clientDir: z.string(), port: z.number().int().nonnegative() }).parse(JSON.parse(process.env.TAROCUB_TEST_HUB ?? "{}"));
const hub = await HubServer.start(input);
// One test-only issuer per child process. Repeated RPCs reuse it; a restarted
// child must not pretend it still holds the previous process's private key.
const invitationOwner = testDevice(`crash_fixture_owner_${randomBytes(8).toString("hex")}`, "Crash fixture issuer");
let invitationOwnerReady: Promise<string> | undefined;
process.send?.({ type: "ready", url: hub.url });
process.on("message", (raw) => {
  void (async () => {
    const message = z.object({ id: z.string(), method: z.enum(["approve", "snapshot", "invite"]), code: z.string().optional(), conversationId: z.string().optional() }).parse(raw);
    try {
      const value = message.method === "approve" ? await hub.auth.approve(message.code ?? "", "local-owner") : message.method === "invite" ? await (async () => {
        invitationOwnerReady ??= bootstrapTrusted(hub.auth, deviceFields(invitationOwner));
        await invitationOwnerReady;
        const invitation = await issueInvite(hub.auth, await sessionFor(hub.auth, invitationOwner));
        return pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, routes: [{ name: "Direct", url: hub.url }], invite: invitation.invite });
      })() : await hub.store.snapshot("owner", message.conversationId ?? "");
      process.send?.({ id: message.id, value });
    } catch { process.send?.({ id: message.id, error: "fixture_request_failed" }); }
  })().catch(() => process.exit(1));
});
process.once("SIGTERM", () => { void hub.close().finally(() => process.exit(0)); });
