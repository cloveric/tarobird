# Personal message deletion — 2026-10-16

App 1.0.80, host/standalone CLI 0.1.430, Android 2026101610. The user selected
personal history deletion synchronized to their own devices; other members keep
their records.

Phone: hold a message and choose Delete or Select messages. Desktop: right-click
or Shift+F10 opens the same actions. Selection has checkboxes, count, cancel and
batch delete (up to 100 messages); Escape/native Back leaves selection. A styled
confirmation explains the scope. The composer stays mounted, preserving text and
attachments. Successful deletion returns keyboard focus to the message viewport;
failed requests keep the selection and support an idempotent retry. Selection and
pending UI state belong to the exact host and conversation.

Schema 16 adds `message_deletions(user_id,message_id,deleted_at)`. The authenticated
DELETE endpoint validates the whole batch and membership inside one transaction.
It never overwrites shared message rows, recalls deliveries, stops tasks or removes
shared files. Queued prompts remain in the task queue: deleting history is not
cancelling work. The same API powers `tarobot messages delete`; bounded `messages
list` provides IDs and pagination without the desktop.

Durable personal-deletion events are projected to ordinary deleted-message
updates for that user; other users only advance the shared journal cursor. This
works with existing protocol-v1 caches. Later stream edits, replay and full
snapshots remain tombstones. Search, conversation files, stale quote/forward
sources, pending notifications and future pushes respect personal deletion. Client
cache transactions clear unread/attention/preview and removed quote metadata,
while retaining typed text/files. Stale draft writers cannot recreate the quote.
Already-deleted stream updates avoid rescanning the conversation.

The new capability is `messages.delete.v1`. Older hosts show an update-required
explanation. Schema 16 is deliberately outside old hosts' supported range: an old
runtime must not reopen it and resurrect personal history. Full backup/restore
supports schema 16. Restoring a pre-upgrade backup restores its older history as
well; it cannot preserve deletions performed after that backup.

Verification records are retained on the external release disk:

- Full pre-complete gate: 304 files, 4006 passed, one intentional skip. Client
  production install/build and translation/type checks passed.
- 34 scoped Chromium and 34 WebKit journeys passed across message deletion,
  actions/hold/context menu, snapshot recovery, persistent drafts, files and
  search. The WebKit fault-injection test initially bypassed interception through
  a service worker; explicitly blocking it made the intended failed-request case
  deterministic. Final changed UI cases were rerun in both engines.
- Independent Opus read-only review and follow-up: no remaining blockers. It did
  not execute tests. Focus return, native Back/Escape, stale quote writes and
  repeated tombstone performance have explicit fixes/coverage.
- Standalone clean production install and packed-archive install passed with no
  Feishu SDK. A real 0.1.429 → 0.1.430 host upgrade retained identity, controller
  and workspace; the packaged personal-deletion API retained deletion through
  restart while the Bot still read the canonical message.
- Isolated compiled Hub/Gateway with real Codex: text/two-device sync, file
  roundtrip, local ASR, native question submission and stream/stop/resume passed.
  This is protocol acceptance, not physical App or all-provider live acceptance.
- Final ad-hoc-sealed Mac DMG verified: embedded frontend, Node 24.14.0,
  application icon and 741 host/CLI files matched. The mounted package's own
  Node passed authenticated pairing, fixture reply and host restoration. This
  private prerelease is not Apple-notarized.
- Android original signer retained; all 390 packaged frontend assets matched,
  30 JVM tests passed, lint had zero errors and 22 warnings. Emulator upgrade
  1.0.79 → 1.0.80 retained installation identity and cold-started without crashes.
  No physical Android or native Windows acceptance is claimed.

The local Mac updater waits for the authorized current host to drain, backs up
its quiescent database before migrating schema 15 → 16, swaps the verified App,
and checks identity, Bots, relay and host/device name. Its receipt distinguishes
staged/waiting from verified. Standalone CLI installation is separately updated;
App replacement alone does not update an independently installed `tarobot`.
