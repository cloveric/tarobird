# Revocation during an HTTP request

Device trust must still hold when an authenticated request finishes reading its
body, enters a queued write, or releases private data. Authentication at the
start of a slow request is insufficient.

## Reproduced defects

Two real HTTP regression cases first failed with HTTP 200 after the requesting
device had been revoked: approving a new device and writing an upload chunk.
Each request passed initial authentication, sent only its first body byte,
waited for revocation, then sent the remaining bytes. The expected result was
HTTP 401 with no enrollment or chunk write.

## Current boundaries

- Authenticated JSON and binary bodies revalidate device trust and expiry after
  the last byte arrives. Owner-only routes also recheck the owner role.
- Direct route database operations revalidate inside their queue entry. Pairing
  approval and device revocation validate the actor inside the same database
  transaction as the change. The local CLI owner path remains available.
- Upload creation checks trust inside its transaction. Chunk writes and upload
  completion check it after entering their per-upload queue.
- Authenticated JSON and avatar responses revalidate before sending private
  data. A successful self-revocation returns only its committed acknowledgment;
  subsequent requests are refused.
- Attachment downloads validate before headers and track an abort controller.
  An in-process revocation aborts matching streams. The existing 500 ms identity
  sweep also checks active downloads, covering expiry and a separate CLI's
  database revocation. The timer is a polling interval, not a hard latency SLA.
  Shutdown aborts tracked downloads before closing HTTP listeners.
- Authentication failures retain their original error and enter the rejection
  audit. A push request's expired session is not relabeled as invalid provider
  configuration.

The raw session validator is used only while already holding the database queue
or transaction. Calling the queued validator recursively would deadlock the
non-reentrant queue.

## Evidence and limits

`tests/hub-request-revocation.test.ts` includes ten isolated integration cases:
slow approval, slow chunk upload, queued chunk admission, body-boundary expiry,
owner downgrade during a read, delayed approval commit, private-result release,
self-revocation, and active-download cancellation for both local and external
revocation. The download cases backpressure a 16 MiB real attachment, verify the
revoked response is incomplete, and verify a second trusted device still obtains
the complete file with matching SHA-256. No paid model sessions are created.

This does not recall bytes already received, roll back previously admitted tool
side effects, or establish a universal transactional actor check for every
WebSocket/service operation. Other delayed service operations and the complete
security/chaos matrix remain separate acceptance work. Production deployment and
native-device testing are also separate.

The subsequent [realtime revocation change](socket-revocation.md) adds transaction
guards to network-originated chat/card/conversation writes and checks private
socket output. It also covers shared HTTP creation and steering admission.

Validation details and source hashes: sanitized receipt（本地材料：`evidence/http-revocation-2026-10-03.json`）.
