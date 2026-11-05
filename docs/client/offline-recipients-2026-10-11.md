# Offline group recipients and queue recovery — 2026-10-11

Two cold-start defects were reproduced in the ordinary macOS preview and fixed:

- Group recipient checkboxes and the `@` chooser used only the live Bot directory.
  After starting offline, cached history/names remained visible but these controls
  had no options. All three composer surfaces now use the cached display directory,
  filtered by the current conversation's member IDs. Live runtime settings and
  capabilities still require the live directory. The cached list conveys no presence.
- Connection startup initialized the queued count to zero until a send/flush occurred.
  Existing queued rows survived, but the offline banner omitted their count. Startup
  now reads the durable outbox with the other cached startup state, behind the same
  identity/lifecycle checks.

## Verification

An isolated real Hub had two group members, a third nonmember, and an independent
subtopic. Its Gateway callbacks returned static test receipts; no provider CLI
sessions or production bots were created. The second host was accessed from the
existing preview's origin and from the ordinary Tauri preview.

Manual CUA checks:

- Before the fix: native and browser cold starts displayed an empty recipient menu.
- After the fix: desktop, phone-width browser, and native menus offered only the two
  group members. Offline `@` selection retained the chosen recipient and removed the
  chooser token, matching the existing composer behavior.
- Selecting no recipient blocked send with a useful error and retained the draft.
- Group recipient selection and text survived reload; a separate topic retained its
  own text/default recipient through group sends and reconnection.
- Phone-width browser and native desktop each queued three messages while offline.
  Both cold starts retained their queues. Restoring the same Hub delivered each
  client's three messages in FIFO order, targeting only the selected second Bot.
- A second outage checked the banner count after cold starts in both clients. These
  two additional messages also delivered once. Final Hub read-back contained eight
  unique user message IDs and eight controlled Gateway callbacks, all for Bot beta.
- Both clients displayed the shared delivered history. The temporary host was then
  removed from both clients after the removal UI reported zero drafts/queued items.

The first native recovery was slow: its authentication receipt was about 136 seconds
behind the browser during a run that also included the full root test suite. The
cause is not established. A second sample, after the suite ended, authenticated both
clients about 4.0 and 4.5 seconds after restarting the Hub. This is a limited local
sample, not a passing failover/performance gate; background/load-dependent recovery
still needs a dedicated repeatable audit.

Build/check receipts:

- Client translations, TypeScript and Vite build passed.
- Ordinary macOS debug preview rebuilt and passed strict ad-hoc signature verification.
- Required root pre-completion hook passed: 239 suites, 3,832 tests passed, 1 skipped.
- Added `client/e2e/offline-recipients.spec.ts` for desktop/phone cold start, membership,
  independent drafts, empty recipients, queue count, FIFO and duplicate checks. Its
  syntax was checked; the automated browser suite was not executed in this turn.
  The UI evidence above comes from actual CUA browser/native interactions.

Local-only receipts and screenshots are under the temporary
`tarobot-offline-groups-20261011` evidence directory. Pairing codes, device keys,
raw fixture IDs and local identity/config files are excluded from this document.

## Limits

Phone-width browser verification is not physical iOS/Android acceptance. This did
not exercise real CLI inference, push delivery, a remote VPS, long attachments, or
production multi-device failover. The original full product goal remains open.
