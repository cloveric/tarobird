# Expired card action feedback and outbox recovery

## Confirmed problem

A phone showed `action_unavailable` in the host-wide red banner after other
operations had succeeded. The Hub emits this non-retryable rejection when the
referenced Bot card action is absent or disabled. The screenshot alone does not
identify which earlier button triggered it.

The client previously copied the raw code into both its connection banner and
failed outbox item. Discard/ACK did not clear that banner. Generic FIFO handling
also let the obsolete request hold later messages, and offered a retry that
could not restore the action. A read-only baseline execution reproduced the
sticky banner, persistence after discard, and blocked subsequent message.

## Behavior

- A definitive `action_unavailable` reply for a card request is kept as a local
  failed item with “此卡片操作已失效，请查看最新卡片。” It no longer sets a host
  connection-error banner.
- The expired item remains removable, preserving its submitted values until the
  user removes it. It is not reported as delivered. No answer is submitted again,
  no question approval is inferred, and no message/history is deleted.
- This exact expired action does not block later queued operations. Its retry
  button is absent and the atomic cache retry also rejects stale retry calls.
- Other failed requests, permission failures, uncertain sends, backoff and FIFO
  retain existing behavior. Matching the raw code on a message send is not enough
  to exempt it: classification also requires `interaction.submit`.
- Existing failed card items using this stable code are recognized without an
  IndexedDB migration. Queue reconciliation (including discard, ACK or reconnect)
  clears only the legacy `action_unavailable` banner. Unrelated network,
  credential, revocation and storage errors are retained.
- The shared client covers phone, desktop, browser and ADHD conversation panes.
  No layout CSS or Host authorization rule changes. CLI impact: none; the Hub
  rejection/protocol remains unchanged and this only repairs client outbox UX.

## Source and verification

Prepared against main `d6aabc5022c4be0c2271e0623bb679dc57ffb59f` using a small
GitHub source snapshot while external-volume project/build access is blocked.
The installed App and live Hub have not been modified or restarted.

Completed checks:
- Baseline execution of the existing connection class reproduced all three issues.
- 23 isolated checks run the changed connection/cache methods and the real
  outbox view projection. They cover terminal/late rejections, legacy errors,
  FIFO/backoff, read/write failure, preservation of submitted values and other
  errors, discard/ACK, no false acceptance, and atomic retry guards.
  These use fixture storage/transport and skip React effects; they are not full
  IndexedDB, browser or native acceptance.
- Three repository classifier tests cover action type, exact rejection matching,
  other errors and unfailed operations. Executed with Node's test runner mapping
  the Vitest `it` import; the repository-wide Vitest suite remains pending.
- Changed TS/TSX syntax, the added translation key and patch application checked;
  privacy scan results are recorded in the PR.

Added real-client Playwright coverage in `review-recovery.spec.ts` for desktop
and phone viewports: local expired feedback, no retry/banner, sending after an
expired action, reload without resend, explicit removal, preserved history and
no horizontal overflow. These new browser cases have not run in the snapshot.

Before merge/release, run root and client builds, complete translation checks,
Chromium and WebKit `review-recovery`, `message-send-continuity`, `outbox-refresh`,
`questions` and `cross-device`; verify phone and native Mac/ADHD behavior. Keep
this PR draft until those checks are complete. GitHub Actions additionally has
the existing billing restriction; unrun checks are not passing checks.
