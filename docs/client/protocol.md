# Protocol v1

Wire schemas live in `src/client-protocol/`. All frames carry `v: 1` and `type`.
The WebSocket cap is 1 MiB per physical frame; user `message.send.text` is
capped at 200 KiB in UTF-8 bytes. Complete Bot replies may span physical frames.
Unknown future frame types are ignored with a warning; malformed known types
and unsupported versions are rejected.

## Authentication and sync

1. A trusted owner first issues a five-minute, one-device invitation using
   `POST /api/devices/invites` with a random 32-byte base64url `requestId` and
   optional `replaces` ID. QR v1 keeps its route JSON in `data`, and carries
   the 43-character token in the separate `invite` query parameter.
   Pair with `POST /api/pair`: device ID, platform, display name, Ed25519 SPKI
   public key, invitation and a separate random 32-byte base64url `requestId`.
   The response includes an eight-digit, five-minute approval code and Hub
   public identity. Approval on a trusted owner device/local CLI remains
   mandatory. An identical admitted body can retrieve the same receipt with
   its request ID (no fresh admission); changing any identity field or the
   request ID cannot reuse the invitation. `GET /api/devices/invites` lists
   only the calling owner's invitations without tokens; `POST` to
   `/api/devices/invites/revoke` with `{id}` closes new admission only.
   Missing/invalid invitations are rejected on every public route, including
   loopback and relays. Existing enrolled-device authentication is unchanged.
2. Open `/ws`, send `hello` with device ID, random nonce, protocol versions,
   capabilities and per-conversation cursors.
3. Verify the Hub signature on
   `tarocub/server/v1\0<deviceId>\0<serverNonce>\0<clientNonce>` using the paired
   identity. Sign the analogous `tarocub/device/v1` proof with the device key.
4. `ready` supplies a 15-minute HTTP token and authorized bots/conversations.
   Events replay from each cursor, or large gaps use negotiated snapshots,
   followed by `sync.complete`.

The token is memory-only and used as `Authorization: Bearer ...`. A reconnect
requires a fresh challenge signature. Never log these tokens or instance keys.

Remote device approval and revocation additionally require an action-specific,
one-use device signature obtained through `/api/devices/challenge`. Tokens alone
cannot authorize these trust changes. The statement binds the Hub, actor, current
token, action, target record and a maximum 30-second expiry. Hub and client must
be upgraded together; there is no unsigned compatibility fallback. See
[signed device actions](device-action-proofs.md) for the exact signing bytes,
transaction checks, local CLI recovery and validation boundaries.

### Revocation while offline

Clients advertise `auth-status.v1` to receive a verified recovery reason when a
device was revoked while disconnected. After a rate-checked handshake fails, a
Hub may send `auth.denied` with `code: "device_revoked"`, `deviceId`,
`clientNonce`, `publicKey` and `signature`, then close the socket. The Ed25519
signature covers the UTF-8 bytes of
`tarocub/auth-denied/device-revoked/v1\0<deviceId>\0<clientNonce>`.
The receipt carries no token, profile or conversation data; it grants no session.

Before persisting revocation, the client checks the strict frame schema, its
paired Hub public key, its device ID, the current socket's fresh nonce and the
signature. Authentication-challenge signatures use a separate signing domain.
Only this verified receipt can persist revocation; ordinary unsigned errors and
notices cannot, even after `ready`. A live `device_revoked` notice stops sending
and reconnects to obtain a fresh signed denial. The client keeps
cached history readable. The identity-bound marker survives reload; resetting
the pairing removes it under the existing local-reset fences.

Unknown devices, rate-limit failures and clients without the capability keep
the existing generic error path. Failure to produce the recovery receipt also
falls back to rejection and socket closure. Older Hubs remain compatible but
cannot supply this durable offline-revocation reason.

Closing a socket while handshake cache writes are pending does not reactivate
its token, timers or online state when those writes finish. Reconnect follows
the existing ordered-drain path.

## Long replies and physical fragments

Clients advertise `fragments.v1` in `hello`; local Gateway instances negotiate
the same capability in `instance.hello` / `instance.ready`. When negotiated,
logical JSON envelopes over 200 KiB are serialized into ordered
`frame.fragment { id, index, bytes, sha256, data }` frames. `bytes` is the full
UTF-8 byte count and `sha256` hashes those original bytes. Each `data` contains
at most 200 KiB of base64 (150 KiB of original bytes); its full envelope stays
below the 1 MiB physical limit. Small envelopes retain their original format.

One transfer is active per socket. Heartbeats and error/revocation notices may
pass between fragments; other logical messages are serialized. The receiver
validates order, chunk sizes, full length, UTF-8 and SHA-256 before passing a
complete object to the normal schema and storage path. Partial content never
advances message history or a snapshot acknowledgement. Socket closure discards
it; reconnect replays from the durable cursor. Gateway journals the complete
publication before sending and replays pending publications sequentially.

The complete message remains one canonical row in SQLite and IndexedDB; quotes,
forwards, search, Markdown rendering and exports use its full blocks. There is
no protocol truncation or document-overflow conversion. Actual available memory
and storage still bound a complete reply: the reader retains received text and
parses the complete logical JSON. It never preallocates the advertised total,
and rejects a partial transfer idle for over 30 seconds on its next frame.
Only authenticated local instances may send fragmented input to the Hub;
ordinary client commands retain their existing limits. A busy socket whose
queued logical bytes exceed 4 MiB reconnects for durable catch-up; individual
large replies and paced catch-up writes are allowed.

Peers without this capability retain ordinary frames up to 1 MiB. A larger
reply produces `client_update_required` instead of silently dropping content.
A Gateway connected to an older Hub retains oversized publications in its
journal and reports `hub_update_required` until a compatible Hub is available.

## Instance interruption recovery

Gateway stores a private receipt before handing an input to the shared handler.
When a restarted instance sees an unfinished receipt, it does not rerun that
input. It first replays its persisted outbound publications in order, then sends
`instance.request` method `delivery.fail { messageId, reason }`, where reason is
`interrupted` or `failed`. The Hub authorizes the exact Bot delivery and settles
it in one transaction: retain partial content, turn its streaming/pending replies
into errors, close actionable cards, append one Bot-scoped recovery notice and
mark the delivery failed. Already completed ordinary output and other Bots'
messages are preserved. Old card contents remain available in a read-only fold.

Retries do not append duplicate notices or raise message versions again. A later
ack cannot erase failure, and late publications cannot resurrect the old turn.
Explicit resend uses a new input ID and can run normally. Socket interruption by
itself does not fail a turn; Hub reconnection while the worker remains alive still
continues the original task. The standalone worker also runs the shared bounded
startup timeline recovery so interrupted input has a terminal lifecycle record.

## Large catch-up snapshots

Clients advertise `snapshot.v1`. When the gap exceeds 1000 events, a cursor is
ahead of the journal, or the journal prefix no longer covers it, the Hub sends:

1. `snapshot.begin { id, conversation, seq, after, readSeq }` establishes the
   snapshot revision, the client's expected previous cursor and the user's read
   position. A dedicated SQLite WAL read transaction holds this revision stable.
2. `snapshot.message { id, index, message, contentSeq, unreadSeq }` carries one
   current message per logical frame. Indexes start at zero and must be contiguous.
   `unreadSeq` is the last transition into a completed/error bot response;
   subsequent edits to an already completed reply do not make it unread again.
   After staging each message, the client sends `snapshot.ack { id, count }`.
   At most eight unacknowledged message frames may be in flight; the final frame
   also waits for receipts. Wrong snapshot IDs or impossible counts disconnect.
3. `snapshot.end { id, count }` commits the staged messages, activity and cursor
   atomically. Old message rows absent from the snapshot are removed. Drafts,
   queued sends and appearance settings are preserved.

All physical frames remain within 1 MiB; large message envelopes use the
fragment mechanism above. Non-message events still enforce the 1 MiB bound
before persistence. The Hub reads message bodies in small pages and awaits
socket writes and staging receipts. It records only conversation IDs
for concurrent changes and catches up from the journal after the snapshot.
Heartbeats remain available during catch-up. Clients without `snapshot.v1` keep
event replay.

Partial snapshots live in separate IndexedDB stores. A missing frame, duplicate
message, count/cursor mismatch or cross-conversation row cannot advance the
visible cursor. Reconnect discards partial staging and retries from the last
committed cursor; `sync.complete` releases the ordered outbox only after catch-up.

## Commands

`message.forward` carries `{clientMsgId, conversationId, sourceMessageId, mentions?}`.
The Hub reads the authorized source itself; clients cannot set forwarding provenance
or copied blocks. Both source and target membership are required on a new request,
and the target and its parent must be active. Only complete/error source messages
can be forwarded. An omitted or empty `mentions` array does not dispatch any Bot;
explicit entries must be Bot members of the destination. The response uses the
same durable `message.ack` and event journal as a normal send. A retry with a
conflicting target, source or recipients is rejected. Reusing a forwarding request
ID as a normal send is also rejected.

The new user-authored message contains `forwardedFrom` with the immediate source
message/conversation IDs, readable conversation path, author name and original
timestamp. Blocks are snapshotted, interactive card controls disabled and their
action IDs/values removed; run state becomes static text. Forwarded messages never
carry the source's `replyTo`. Attachment IDs are recreated in the destination scope;
immutable blobs receive independent hard links (copy fallback where unsupported).
The database transaction includes the message, aliases, delivery queue and event;
on rollback new files are removed. Source cleanup cannot remove the destination's
bytes. Normal attachment authorization and export continue to use `<id>.blob`.
SQLite schema 6 adds nullable `messages.forwarded_json`; versions 1–5 migrate
additively. Offline forwarding uses the existing client outbox and stable ID.
A target member without source access can read the copy and its attachments but
cannot navigate into the source. Opted-in Bot input marks forwarded text as reference
material so a copied slash command is not executed as a fresh command.

`message.send` uses a stable `clientMsgId`; `interaction.submit` and
`conversation.create` use a stable `clientActionId`. Device retries keep that
same ID. The Hub's acknowledgement means the durable queue accepted the work.
It does not claim that an engine completed it.

Conversation rename/archive/bind, read cursors, stop, typing and command
completion have explicit schema variants. Card callbacks carry only the action
ID and form values; the Hub resolves callback code from the stored card. An
error may include `requestId` and `retryable`; permanent errors remain visible
in the client outbox with retry/remove actions, including failed card submissions.
A failed or delayed item pauses later items in its own conversation; independent
conversations can proceed. Retryable request failures keep the WebSocket alive
and use durable per-item exponential backoff (1/2/4 seconds initially, capped at
15 seconds). After at least four failures and five elapsed seconds the item
requires explicit retry or removal. Reload does not reset this budget. Manual
retry preserves the ID and original position; a transactional monotonic order key
preserves insertion order even for simultaneous enqueues. Removing a failed item
only removes that local pending operation, not existing Hub messages.

After authentication catch-up, `turn.stop` is an ephemeral priority control:
it revalidates the device session and conversation membership but does not wait
behind a stalled command-completion RPC. Its optional `botId` must belong to the
conversation; omitting it dispatches concurrently to every member Bot. Each
response must contain a boolean `stopped`. Offline, timed-out or invalid responses
produce `stop_incomplete` without preventing other Bots from receiving the stop.
This does not assert that all external tool side effects were undone. Stops are
never stored in the offline outbox or replayed when a Bot reconnects. Gateway
reuses `/stop` semantics for active work and pending attachment bursts, retaining
already queued turns. Run-card updates or an ordinary Bot acknowledgment sync to
both devices; no new durable stop-intent format is introduced.

## Link previews

`message.send.previewUrl` is optional: omitted selects the first extracted URL,
`null` explicitly disables a preview, and a string selects one of the first five
unique HTTP(S) links in the text. The Hub canonicalizes and checks that selection;
clients cannot submit preview titles or cover references. Code and inline Markdown
image URLs are skipped. The draft UI calls authenticated `POST /api/link-preview`
with `{conversationId, url}`; membership is checked before outbound access. This
request does not create a message or Bot delivery.

Messages store optional `previewUrl`, `previewStyle` (`card` or `inline`) and `linkPreview` (`url`, `status`, `title`,
`siteName`, optional `description` and `imageAttachmentId`). A background worker
fills pending user messages via a versioned `message.updated` event. The initial
acknowledgement and Bot delivery do not wait for network reads. Unavailable pages
produce a terminal fallback preview. Pending work survives a Hub restart; stored
metadata and cover attachments survive replay, snapshots and offline caching.
Metadata-only user updates do not change conversation-list activity ordering;
file-only search checks message blocks, excluding cover-only references. The client
stores small attachment bytes with MIME type in IndexedDB, reads old Blob records,
and retries image/audio reads when authentication recovers. This avoids Blob-clone
aborts observed in WebKit while preserving the existing 16 MiB/file, 128 MiB budget.
Covers use the same conversation membership checks and GC references as ordinary
attachments, but are outside message blocks and never become engine input files.
Forwarding snapshots existing metadata and creates destination-scoped cover copies.

`message.send.previewStyle` chooses the initial presentation on every receiving
device; omitted values retain the original card behavior. It is validated at the
protocol and durable read boundaries, kept through outbox retry/replay, snapshots,
metadata enrichment and forwarding, and discarded for messages without a selected
preview URL. Expanding/collapsing a received preview is local reading state, like
opening message details, and does not edit the message or trigger a Bot turn.

SQLite schema 7 added nullable `preview_url` and `link_preview_json`; schema 8
adds nullable `preview_style` to versions 1–7 without rewriting historical
messages or events. A NULL style defaults to a card in the renderer.
In storage only, empty `preview_url` represents explicit disable; SQL NULL
means no candidate or an older message. Historical messages are not bulk fetched.
Draft metadata caches expire after 1 hour (failed pages: 1 minute), with at most
64 cached URLs and 4 active fetches. The combined page/cover deadline is 8 seconds.
HTML and raster covers each have a 512 KiB encoded/decoded size limit. Credentials,
nonstandard ports, private/reserved IPs and mixed public/private DNS are denied.
Each of at most 3 redirects repeats resolution and address validation; the HTTP
connection is pinned to a checked answer and preserves the TLS hostname. No page
JavaScript, cookies or authorization headers are used. Browser pixels are fetched
through the authenticated attachment route rather than external image URLs.

## Session binding selections

SQLite schema 9 adds nullable `conversations.binding_id`. Every explicit
`conversation.bind` selection receives a new Hub-generated ID, including a
second selection of the same native session. `Conversation.bindingId` identifies
that operation; `sessionId` is the last selected target, not a continuously
enforced provider-session override. The current native binding belongs to the
Bot's SessionStore. Gateway reads the latest authorized conversation inside its
turn queue and applies each selection once, with a durable private receipt and
the destination's own previous-session snapshot. Reset, detach and later resume
are therefore not overwritten by an old selection. A legacy selection without
an operation identity never revives a removed native binding. Uncertain writes
require explicit reselection; corrupt receipts are preserved and fail closed.
`sessionId: null` explicitly clears the selection and binding ID. Clearing
requires `expectedBindingId` (null for legacy metadata); the comparison and update
are atomic. New clients also send this revision for binding to reject stale edits.
The Hub requires its owner plus conversation ownership, revalidates the device,
skips Bot RPC on clear (so an offline Bot cannot trap the owner), audits
`conversation.binding_cleared`, and broadcasts the cleared conversation.

Clearing does not undo any native switch that already happened. After an
interrupted operation, detach or reset before ordinary input. Corrupt receipts
are preserved; clearing unblocks native commands but UI binding needs receipt
repair. Binding failures produce one error reply and a terminal timeline event,
settle queued cards and do not invoke the model. Gateway steering is permitted
only with no selection or a confirmed applied receipt for the current selection;
otherwise the follow-up queues for the same binding validation.

Full-state backup accepts schema 8, 9, 10 and 11, with normal migration on Hub open.

## Bots, quick conversations and topics

`GET /api/bots/catalog` and `POST /api/bots` require an authenticated owner and
an enabled local Bot manager. Creation supplies a stable `requestId`, display
`name`, `engine`, `model`, `effort` and optional existing absolute `workspace`.
The catalog comes from the existing TaroCub model/effort rules and local engine
executable availability. Creation returns durable Bot metadata; `online` is set
only by the worker's authenticated instance handshake, not by successful fork.
A Bot may be created before it is online. Model login/provider availability is
not implied by that handshake. Secrets are never returned.

`conversation.create` accepts optional `conversationType: "direct" | "group"`;
a group may contain one Bot. Legacy clients retain count-based inference when
the explicit type is absent. `topic.create { groupId, title, clientActionId }`
requires membership in a nonarchived root group and inherits its Bots/members.
A returned topic has `parentId` and its own ID, messages, cursors and session key.
Parent session bindings are never copied. Topics cannot contain nested topics.

Both creation frame types are also accepted at `POST /api/conversations`, using
the authenticated HTTP token. The UI waits for this durable response, retains
the action ID after an uncertain failure and enters the returned conversation.
`conversation.updated` also broadcasts the new conversation to other relevant
connected devices. Group UI recipient selection becomes explicit `mentions`.

## Streaming

Clients advertising `streaming.v1` receive `message.stream` events between full
message snapshots. The payload is `{ messageId, baseVersion, version, ops }`.
Operations append text (`appendText`), replace a block (`replaceBlock`) or replace
a card element (`replaceElement`). `block` selects a zero-based message block;
an optional `path` selects nested card elements using numeric array indexes only.
An absent path on `appendText` addresses a text block. Schemas reject arbitrary
property paths, negative/fractional indexes and more than 256 operations.

Peers additionally advertising `streaming.card-extra.v1` can receive
`{ op: "replaceCardExtra", block, value }`. `value` replaces the card's JSON
`extra` object; `null` removes it. This permits changing `nativeRun` summaries
alongside appended Markdown without replacing the entire card. It cannot
address any other message property. The Hub only emits this operation for
explicitly capable peers; `streaming.v1` alone retains the original operations
or falls back to a snapshot. Neither durable events nor the Hub schema changes.

The client applies a delta only against the exact `baseVersion`. Repeated event
sequences and older message versions are ignored. A missing base, sequence gap
or invalid operation aborts the IndexedDB transaction without advancing its
cursor, then reconnects for replay. Message content, conversation activity and
cursor changes commit together. Final completion/error/deletion is always a
full message snapshot and remains authoritative.

The Hub's event journal retains full snapshots and derives deltas per connection.
The first replayed update establishes a complete base even if the cursor begins
mid-stream. Deltas are used only when smaller than a full snapshot; structural
changes can use full snapshots. Clients without `streaming.v1` receive complete
messages, and `cards.v1` downgrade happens before delta calculation.

Native live publications are acknowledged durably before their optional process
journal is scheduled. A worker keeps one journal RPC in flight and coalesces
pending entries by conversation/message/run/sequence, retaining the latest
revision. Batches contain at most four entries, targeting 256 KiB (a larger single
entry travels alone). Duplicate body-text detail revisions may coalesce for
200 ms after the body is published; public thoughts, tools, terminal flushes and
shutdown bypass this delay. Each terminal publication first flushes its run; a rejected
write marks details unavailable without discarding the final answer. Explicit
worker stop hands unsent batches to the durable outbox before transport shutdown;
this includes captured details held behind a not-yet-acknowledged body publication.
Reconnection replays them idempotently. Terminal batches have scheduling priority.
As with other not-yet-submitted engine events, a hard crash can lose pending
in-memory detail revisions, never an acknowledged publication.
The open process panel rechecks active runs once per second with at most one
HTTP read in flight, so details arriving after their summary become visible even
without another CLI event. Closed panels do not poll. The 100 ms live-body
cadence, final snapshots and client rendering components are unchanged.

## Attachments

1. `POST /api/uploads` registers name, MIME, size, SHA-256 and conversation.
2. `GET /api/uploads/:id` lists accepted chunk indexes.
3. `PUT /api/uploads/:id/:index` sends each 8 MiB chunk (last chunk may be smaller).
4. `POST /api/uploads/:id/complete` verifies the final hash.
5. Include the registered ID in `message.send.attachments`.

Files default to a 512 MiB limit. `maxFileBytes` in Hub configuration accepts a
positive safe integer byte count; it is a Hub policy, separate from the fixed
8 MiB chunk size. The authenticated `ready.uploadLimits` contains `maxFileBytes`
and `chunkBytes`; older Hubs without this field use the default. Both device and
Gateway upload-init enforce the policy, and incomplete chunk/completion requests
are checked again after a policy change. Over-limit requests return HTTP 413
`file_too_large`. Existing completed files remain readable and forwardable;
incomplete receipts survive and can resume after the limit is raised again.
Clients check the authenticated limit before hashing and retain an oversized
draft without submitting a message. Native share staging caches the same public
limit after a handshake (no credentials); each share's aggregate staging budget
is that limit, the total inbox budget is twice it, and reset removes the hint.
The Hub always rechecks uploads regardless of the cached native policy.
Filenames reject traversal and control characters.
Downloads require membership and use `/api/attachments/:id`; no client path is
accepted. A repeated upload-init can recover its existing chunk receipts.

## Instance transport

`/instance` and `/api/instance/*` require a per-instance key and loopback source.
`instance.hello` identifies the bot and engine. Hub delivery uses
`instance.message`; bidirectional RPCs use request/result IDs. Durable action
calls carry an additional receipt ID independent of their transport request ID.
Production TLS/relay listeners are separated from the local instance listener;
instance endpoints are not available through TLS relay listeners.

## History search

Authenticated `GET /api/search?q=...&botId=...&from=...&to=...&hasFile=true`
returns the latest 100 matching complete `Message` records, ordered by descending
creation time and then ID. `q` is a literal substring (empty searches all visible
history), at most 256 UTF-16 code units with no NUL. `%`, `_`, backslashes and
quotes are literal characters. Bot filtering selects conversations containing
that Bot, including their user messages. `from`/`to` are inclusive safe integral
epoch milliseconds; reversed bounds are rejected. `hasFile` accepts `true` or
`false`; only message-block attachments count. Unknown/malformed parameters
return 400. The request rechecks the device session before returning. Client
searches are cancelled/superseded on a new query, closing or leaving the search.
This complete-message endpoint is retained for older clients.

The current client uses `GET /api/search/page` with the same filters and an
optional `cursor`. It returns `{ items: SearchHit[], nextCursor: string | null }`,
at most 50 hits. Each hit has `id`, `conversationId`, `createdAt` and `excerpt`;
the excerpt is at most 320 Unicode code points around the first literal match,
plus optional leading/trailing ellipses. No message blocks, tool output or full
long-answer bodies are included in this response. Opening a hit uses the normal
conversation/message navigation and access checks.

Cursors contain the descending creation-time/ID position and a digest of the
query, filters and user. They are positions, not authorization credentials: every
page reapplies membership and session validation. Invalid cursors or reuse with a
different query/filter/user return 400. The client retains page-start positions
for previous/next navigation and keeps the applied filters separate from unsubmitted
edits. Failed page requests preserve the current page. New queries and closing the
panel cancel/supersede old page requests. Pages are fresh reads, not one frozen
cross-page snapshot; refresh the search to include newly inserted/edited matches
above a visited cursor. No total-hit count is claimed.


### Shared avatars (schema 10)

`ready.avatars` contains authorized `{kind: "user"|"bot"|"group", id, revision,
hasImage}` entries. `avatar.updated` broadcasts the same metadata to authorized
connected clients. Reconnect replaces the metadata list; clients ignore stale
revisions. Images are fetched with the current paired-device bearer token at
`GET /api/avatars/:kind/:id/:revision` and are never public URLs.
`GET /api/avatars` refreshes visible metadata. `PUT /api/avatars/:kind/:id` accepts
`{expectedRevision, dataUrl}`; null removes the image. Revision zero means no
prior setting. Stale updates return 409; removal retains a revision tombstone.

Users edit their own avatar. Hub owners edit Bot avatars, including offline and
external Bots. Group creators or Hub owners can edit a root group they belong
to; topics inherit that group avatar and have no separate setting. Reads require
self/shared-conversation access for user avatars, owner/grant/shared-conversation
access for Bots, and group membership for groups. Device trust is rechecked inside
the serialized read/write operation; image responses are private/no-store.

Clients accept PNG/JPEG/WebP/GIF files up to 10 MiB, crop with drag and accessible
zoom/position sliders, and re-encode a static 256px PNG. The Hub accepts square
8-bit RGB/RGBA PNGs up to 256px and 300 KiB, checks CRC, bounded raster inflation,
filter modes and static structure, and strips ancillary metadata. No remote URLs,
SVG or animated PNGs are accepted. SQLite stores bytes with metadata, independently
of chat attachment expiry. Client images share the bounded IndexedDB attachment
cache, with Hub/device/revision-scoped keys. Settings, sidebar, title and message
avatars update from the same metadata; already-cached pictures survive offline
reload. Editing requires a live authenticated connection. Simultaneous edits need
explicit confirmation before using the latest revision; unconfirmed crops remain
local and cancelling does not change server state.


### Ordered multiple VPS routes

The client identity/pairing `routes` list accepts one optional `Direct` or legacy `Tailscale` route
and up to eight `VPS` entries. Each entry is `{name,url,label?}`. Names remain the
transport kind for compatibility; the optional human label is at most 40
characters. URLs are unique normalized HTTPS origins; loopback HTTP remains
available for the local app/tests. Paths, credentials, query strings, fragments,
duplicates and duplicate direct routes are rejected. Legacy one/two-route
identities and QR codes are compatible. QR generation reports an actionable
error if the complete list is too long for a QR rather than dropping routes.

Connection probes run in parallel, but selection uses direct-first and then VPS
list order. An endpoint with a mismatched Hub public key is never selected; the
selected socket still performs the signed mutual challenge. Each failed socket
has an independent 5–60 second cooldown. Changing the current endpoint requires
new authentication, then normal durable replay and upload receipt reconciliation.
Recovery preference needs three consecutive healthy probes and no active turn,
outbox send, file upload or recent content traffic. Each device stores its own
route order; sharing a pairing QR includes the entire list. No wire message,
attachment ID, native session or Hub identity changes during relay failover.

## Host deployment description and generic direct routes

Route names accept `Direct`, legacy `Tailscale`, and `VPS`. There is at most one
direct/Tailscale entry in total and up to eight VPS entries. The direct entry has
priority. This classifies client paths, not runtime location. Every selected path
still verifies the same pinned Hub identity.

Connect QR payloads may include `deployment`: `computer`, `vps-direct`, or
`vps-relay`. It is a device-local description of an existing deployment, not a
server mutation. Old codes without it remain valid and do not infer host location
from route names. `vps-direct` requires a direct entry; `vps-relay` contains only
relay entries. Older clients unaware of `Direct` or `deployment` need an update
before importing these new codes.
