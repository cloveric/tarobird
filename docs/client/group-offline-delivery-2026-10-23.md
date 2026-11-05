# Ordinary group offline delivery

The discussion-composer routing change required a live group view before every
send. That prevented an ordinary `mentions` or `parallel` group from queuing
messages after an offline reload or after visiting another conversation.

The App now caches authenticated group views and Host capability facts under its
identity-owned settings cache. This metadata has a separate `groupReply:` prefix:
it is not a user draft, does not increase draft counts/previews and does not
notify draft subscribers. A missing or damaged view preserves the user's draft
with an explicit offline explanation. Automatic discussions still require an
online connection. Direct conversations do not require group metadata.

An ordinary-group outbox entry records its observed mode and settings revision
in the optional `message.send.groupReplyGuard` field. The additive
`groups.reply-guard.v1` capability is advertised in `hello`/`ready`; clients must
not assume an older Host will preserve an unknown field. The protocol remains
version 1 and the Hub database remains schema 21; no database migration is needed.

Inside the existing send transaction, the Host first returns an already accepted
idempotency receipt, then checks the guard against the current root-group view
and any active discussion before creating a new message or delivery. The revision
covers title, members, policy, speaking order and round limit. Topic sends use the
root revision. A settings/run change rejects the send with
`group_reply_mode_changed`; the App keeps the original failed outbox entry.
Explicit retry keeps the original frame, recipients, idempotency key and guard.
It cannot convert the message into a new discussion or use the newer policy to
fan out to different Bots.

Compatibility is deliberately bounded:

- A Host with the new guard supports guarded offline ordinary-group queues.
- A discussion-capable Host without the guard retains existing online ordinary
  sending. Offline input stays in the draft with an update/review explanation;
  the client cannot safely ask that Host to enforce an unknown field.
- A pre-discussion Host retains its legacy ordinary-group offline queue. A local
  marker is removed only after a fresh authenticated handshake still identifies
  that same Host as pre-discussion. The marker is never sent on the wire. If the
  Host has upgraded, the entry is retained for review instead of guessing a mode.
- A guarded entry is retained if the reconnected Host no longer advertises the
  guard. It is never silently stripped and resent unguarded.

CLI impact: this repairs the Apps' persistent offline outbox, which the one-shot
headless CLI does not implement. Existing `groups show/update/start/note` and
control commands continue to use the same authenticated Hub APIs and their
existing revision/request-ID checks; no separate command or reduced Host logic
is introduced. The optional send guard is enforced by shared Hub store code for
any protocol caller that supplies it. Older callers' online behavior is retained.
Historical messages' separate “send again” action is unchanged by this repair.

Coverage lives in `hub-group-reply-guard`, existing parallel/settings/discussion
and CLI suites, and browser `group-offline-mode`, `group-reply-cache` and
`offline-recipients`. Browser journeys use the real Hub, stop/restart it and
reload the service-worker App; they inspect both wire frames and persisted Hub
messages/deliveries. They cover cold starts, conversation switching, ordinary
parallel default recipients, missing/damaged metadata, mode/member changes,
explicit retry, legacy upgrade, capability downgrade and draft-count isolation.
These checks establish browser/Host behavior, not physical-phone or live-model
acceptance. No installed App/Host is replaced by this source repair.

Focused validation on this repair: 47 Host/protocol/CLI cases passed; Chromium
and WebKit each passed 13 browser cases (zero failures or skips in the final
runs). Both standalone Host and client builds passed. Initial browser failures
were fixture assumptions: disconnected Bots were hidden, and initial automatic
selection had already cached a supposedly unknown group's mode. The final
missing/damaged-cache journeys explicitly establish their cold-start state.
