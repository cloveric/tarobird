# Offline device revocation recovery

A paired device may be offline when its owner revokes it. Previously it missed
the live revocation notice and retried an unsigned authentication error on every
reconnect. It stayed unable to authenticate, but did not retain a clear recovery
reason after reload.

Clients now advertise `auth-status.v1`. After a rate-checked authentication
failure, the Hub checks whether the device is known and revoked. Only then can it
send `auth.denied` signed with the persistent Hub key, binding the device ID and
the current client nonce to a dedicated signing domain. It closes the socket
without creating a session. Unknown devices and rate-limit failures keep the
ordinary error path. A receipt failure cannot prevent rejection and closure;
queued authentication frames cannot continue after handshake rejection.

The client requires the pinned Hub key, exact current device/nonce, strict
schema and valid signature before accepting the denial. A forged signature,
another Hub key, another device, old nonce, changed code or an authentication
challenge signature cannot persist revocation. Even after `ready`, an unsigned
`device_revoked` notice only stops sending and reconnects for a signed denial;
it cannot write the durable marker. The public health key alone is never enough.
See [wire contract](protocol.md#revocation-while-offline).

After verification, transport stops, pending outbox messages stay unsent and the
existing identity-bound revocation marker is saved. Reload shows the recovery
reason without reconnecting; cached history remains readable. Other trusted
devices keep working. Pairing reset uses the existing cache/identity generation
fences, so an old page cannot mark a new identity revoked.
Closing a socket during handshake cache writes cannot later reactivate its
token, online state, heartbeat, route probe or renewal timer.

## Limits

- This revokes future access; it does not erase already downloaded history.
- Older Hubs still refuse revoked devices but cannot provide the signed recovery
  reason. Matching updated Hub and client code is needed for this behavior.
- A relay can suppress traffic or deny connectivity. It cannot fabricate a
  persistent revocation marker without the pinned Hub key.
- Cache writes remain best effort. If local storage fails, the current
  connection still stops; a later reconnect can receive a fresh signed denial.
- Browser viewport checks do not establish fresh-Mac QR, native vault, physical
  phone or public relay acceptance. No live fleet was restarted or deployed.

## Verification

The pre-change browser regression reproduced repeated reconnects without the
revoked-device recovery message. A separate failing regression reproduced
pipelined authentication after a rate-limited hello; the final handler fences it.

Focused Hub tests cover signature domains, nonce/device scoping, revocation
before hello and between challenge/auth, unknown devices, legacy clients, rate
limits, receipt failure and absence of an authenticated session. Chromium and
WebKit use a real temporary Hub with independent desktop/phone contexts to
verify offline revocation, retained history, unsent outbox, reload, trusted-device
continuity, six forged/stale denial variants and a forged post-ready notice.
A controlled delayed `ready` cache write verifies that closing the socket does
not recreate transport timers or HTTP requests. Existing pairing, local reset,
Bot effort synchronization, route switching and resumable downloads are included.

Final counts, review disposition, screenshots and source hashes are recorded in
the evidence receipt（本地材料：`evidence/offline-revocation-2026-10-03.json`）.
