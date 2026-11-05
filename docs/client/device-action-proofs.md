# Signed device approvals and revocations

Remote approval and revocation require the owner's current HTTP session **and**
a fresh signature from that session's enrolled device key. A copied bearer token
alone cannot enroll a persistent attacker device or revoke an existing device.
Local CLI operations retain their explicit `local-owner` bootstrap/recovery path;
an HTTP session with that user name does not acquire the CLI bypass.

## Protocol and admission

1. After the user's existing approval/revocation confirmation, the client posts
   `{ operation: "approve" | "revoke", target }` to `/api/devices/challenge`.
   The target is the approval code or the device ID, respectively.
2. The owner-only endpoint returns a strict statement containing the Hub public
   key, signing device ID, SHA-256 of the bearer token, intended action, digest of
   the current target record, random nonce and expiry. It expires within 30 seconds
   and never outlives the session. Outstanding statements are capped at eight per
   device and 256 per Hub, with expired entries pruned on subsequent activity.
3. The client compares the statement to its own paired Hub identity, device,
   current token and intended action **before signing**. Ed25519 signs the UTF-8
   JSON array below, with exactly this field order and no whitespace:

   `["tarocub/device-action/v1", hubPublicKey, deviceId, sessionHash, operation, target, targetDigest, nonce, expiresAt]`

4. The original `/api/devices/approve` or `/api/devices/revoke` request includes
   `proof: { nonce, signature }`. The Hub rechecks current device trust and owner
   role inside the same database transaction as the mutation. It consumes the
   nonce once, including invalid signature/session/target attempts, then checks
   session binding, target digest, expiry and signature before admission.
   Concurrent replay cannot commit twice. Self-revocation returns a committed
   acknowledgment even though its token has just been invalidated.

Approval digests bind the pending device ID, public key and pairing expiry.
Revocation digests bind target ID, owner, public key, creation time and revocation
state. Successful audit records identify the acting device, without storing its
token, pairing code, nonce or signature. Statements are memory-only; Hub restart
invalidates them. Device settings do not automatically replay an uncertain write.

## Client behavior and upgrade

Tauri calls the `device_sign_action` Rust command; the seed stays in the native
process and only a signature returns to JavaScript. Capacitor uses the existing
secure-storage adapter and clears its decoded seed buffer after signing. This
does **not** remove the existing mobile JavaScript access to the seed. Browser
preview uses its non-extractable WebCrypto key.

If the session changes, the connection resets, the host closes, or the user
cancels while preparing/signing, the client does not submit the mutation. Signed
actions use a separate signing domain from login, TLS identity and revocation
notices. Missing native commands/keys fail closed.

Update Hub and client together. Old clients cannot remotely approve/revoke on
the new Hub without proof; a new client connecting to an old Hub reports that an
update is required. There is no unsigned fallback. The local CLI remains
available for initial pairing/recovery. Ordinary messaging is not changed by
this endpoint upgrade.

## Evidence and remaining boundaries

Baseline HTTP tests reproduced both token-only mutations before the repair.
Regression coverage exercises valid approval/self-revocation, target/operation/
session/signature substitution, cross-domain signatures, replay, concurrent
commit, expiry, changed target records, role removal, device revocation, bounded
outstanding challenges, unsigned-attempt quotas and queued-body/commit races.
Client boundary tests exercise signing failure, stale session/connection,
cancellation, substituted statements and old-Hub refusal. A synthetic fixed
seed checks byte-for-byte signature agreement between Node verification, Rust,
the actual mobile adapter with mocked SDK storage and browser WebCrypto.

These are code/build and isolated adapter receipts. They are not physical-phone
secure-storage acceptance or a final packaged-App UI receipt. The hosted browser
rerun is blocked before runner startup by the account restriction recorded in
[browser CI](browser-ci-2026-10-11.md).

A stolen token can still perform other authorized HTTP operations during its
lifetime. This repair does not fix browser MITM, XSS, a compromised signing
device or mobile seed exposure. Native TLS identity binding remains necessary;
there is no new application-layer end-to-end encryption.
