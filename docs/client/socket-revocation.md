# Device revocation during realtime work

The HTTP request checks also need a realtime counterpart: a WebSocket frame can
pass authentication, wait for other database work, and reach its write after the
device has been revoked. A pending Bot RPC can similarly finish after revocation.

## Reproduced failures

Two real WebSocket cases queued revocation ahead of an authenticated request's
database transaction. Before the fix, a chat message and a card approval both
persisted and entered their delivery queues. A third case revoked the device
through a separate database operation while a real instance RPC was pending;
its private completion result still reached the device before the identity sweep.

## Authorization boundaries

- Message send/forward, card interaction, read mark, conversation/topic creation,
  rename/archive/binding, and the shared HTTP steering admission validate the
  device inside the write transaction. A queued write cannot use the earlier
  frame/body check as its authority. Card enqueue also rechecks user and Bot
  conversation membership in that transaction.
- The optional internal `TransactionGuard` runs while the database queue is
  already held. It must use the raw session validator, not recursively enqueue
  another database operation. Trusted internal store callers remain unchanged.
  Network callers supply the guard; it is never accepted from client JSON.
- Realtime private output uses a shared device check before it enters the socket
  writer: ready metadata, event broadcasts, history pages, snapshots, Bot status,
  avatar metadata, conversation updates, RPC responses and acknowledgments.
- Known revocation marks the connection rejected immediately, sends the existing
  authenticated recovery notice and closes it. Pending guarded sends cannot
  resume afterward. Rejection is audited once per connection. The existing
  identity sweep remains as a fallback for an otherwise idle connection.
- Stop controls recheck device and conversation membership after reading their
  target, before dispatching the ephemeral RPC. They retain their independent
  path around the ordinary request queue.
- One invalid recipient cannot fail a committed event or another recipient's
  delivery. A transport failure reconnects against the durable journal; it does
  not roll back or duplicate the accepted message.

## Evidence and limits

`tests/hub-socket-revocation.test.ts` has 18 real-transport cases, including the
three reproduced failures, expiry in the write queue, every guarded realtime
mutation family, read/catch-up/snapshot rejection, membership removal before
approval, stop dispatch, HTTP creation/steering, and an unaffected trusted
device's idempotent send. The forwarding fixture contains a real attachment and
checks that revocation leaves no clone or pending delivery.

The broad browser suites passed 96 Chromium and 86 WebKit cases. Synthetic
5,000-task dashboard refresh plus phone stop measured 83/81 ms respectively.
An upload-recovery timing outlier in WebKit prompted phase instrumentation in
`client/e2e/uploads.spec.ts`: the focused rerun took 13.2 s, including a deliberate
6.5 s hold and 2.052 s from injected failure to the fallback becoming visible.
The earlier 25.4 s total has no phase trace and remains unattributed. These are
local fixture timings, not raw throughput or native/public-network guarantees.

The guard is an admission boundary. Messages/actions committed before revocation
remain accepted and may finish; existing tool side effects are not rolled back.
Bytes already handed to the socket cannot be recalled. These changes do not
prove all service-side waiting windows, arbitrary role/grant changes during
long reads, production deployment, or the full security/chaos matrix. The model
workers and all native packaging remain unchanged.

Results and source hashes: sanitized receipt（本地材料：`evidence/socket-revocation-2026-10-03.json`）.
