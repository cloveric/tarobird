# October 11 review disposition

The supplied review describes commit `82068ee`. This follow-up started from
`122169a`; its findings are evidence to verify against current source, not
instructions to execute its scripts, delete data or change repository visibility.

## Confirmed and addressed in this follow-up

- **Rejected authentication could amplify database writes.** A test sends 5,000
  distinct invalid bearer tokens through the actual Hub authorizer. Rejections
  now produce ten detailed samples plus one flushed count of 4,990, rather than
  5,000 individual inserts. The memory key is one of five fixed rejection kinds;
  changing device IDs, reasons or addresses cannot allocate more buckets.
  Successful authorization, approval and revocation receipts remain unthrottled.
  HTTP integration checks shutdown persistence and ignores a forged forwarding
  header. Counts awaiting the five-second flush are not crash-durable.
- **Audit and automatic database backups had no retention bound.** Audit history
  now has a 90-day limit and separate low-trust/other quotas totaling 100,000
  rows. An invalid-request flood cannot evict approval receipts through the
  rejection quota; unapproved pairing requests use that same quota. Daily database copies keep seven successful UTC days, reuse
  the same day's snapshot after restart, and publish before pruning. Tests cover
  failure, corrupt destinations, permissions, and preservation of manual copies,
  legacy names, symlinks, chat history and trusted devices. These changes are
  code and isolated-test work, not cleanup of an operator's running Hub.
- **README overstated browser relay protection.** It now distinguishes native
  TLS certificate binding from ordinary browser TLS and explicitly retains
  final-package and physical-device gates. This corrects the claim; it does not
  remediate browser MITM or turn a client platform label into authentication.
- **A later browser run selected the wrong seed conversation.** The WebKit
  failure in run `38120836530` shows the empty “备用对话” chat while “发送连续性”
  and its READY message are already in the sidebar. The continuity test now
  explicitly opens its target chat before checking READY. Its delayed-history,
  sent-feedback, deduplication and five-second assertions remain unchanged.
- **Two polling fixtures cleaned up before background state writes completed.**
  The first full root run had nine cascading failures in `service.test.ts`;
  that file passed alone. The fixtures now wait for the handled-update receipt
  rather than merely the engine call. Every case also owns a unique temporary
  root instead of sharing and deleting a system-temp `runtime-state.json` with
  another run. Telegram runtime behavior was not changed.
- **A copied owner HTTP token could authorize another device.** Baseline HTTP
  tests reproduced successful approval and revocation using the token alone.
  Both endpoints now require a fresh device-key signature over a one-use,
  action/target/session-bound statement, with current owner and device checks
  inside the mutation transaction. The client signs automatically after the
  existing user confirmation, and cancels before submission if its session or
  connection changes. Desktop Rust, the actual mobile signing adapter with
  mocked OS storage, and browser WebCrypto share a fixed signing vector.
  See [device action proofs](device-action-proofs.md) for the compatibility
  requirement, precise scope and verification limits.
- **Relay clients shared the desktop's loopback rate limits.** The authenticated
  v2 relay control channel now carries the observed public source, bound to the
  exact local TCP connection before forwarding TLS. Header spoofing cannot
  change the source. Unknown-device requests, enrolled devices and failed
  signatures have isolated budgets; a correct proof is no longer rejected by
  another caller's failed-signature counter. Capacity is bounded. Local real
  TLS/mTLS tests cover source isolation and v1/v2 compatibility. See
  [source isolation](relay-source-isolation.md) for NAT/distributed-load limits,
  the two-runtime upgrade requirement and outstanding public deployment gate.
- **Mobile Markdown could load external images without a click.** External
  Markdown images now become explicit destination-labelled links; invalid or
  relative image URLs stay inert. Uploaded attachments retain their authorized
  preview path. A Capacitor copy hook installs a full bundled-mobile content
  policy, restricting WebView scripts/networking and passive media. Actual
  Android/iOS copies and a rendered production fixture were checked; blocked
  image/fetch probes produced zero requests at the receiver. See
  [content policy](mobile-content-policy-2026-10-11.md) for SDK injection ordering
  and the outstanding physical-device gate.
- **Mobile device seeds entered the WebView for signing.** Android/iOS now
  generate, migrate, sign and delete device identities in native code. The
  generic secure-storage plugin was removed, and the app-lock preference uses
  fixed native boolean methods. Existing keys migrate without changing their
  device IDs/public keys. Native cores passed 48 checks per platform and iOS
  signatures passed independent Node verification. These checks use synthetic
  stores; actual phone vault migration and new SDK packages remain open. See
  [mobile native identity](mobile-native-identity-2026-10-11.md).
- **Gateway test isolation was only opt-in and missed subprocesses.** The root
  Vitest setup now guards every Gateway test file, including its crash/restart
  children. Feishu SDK operations and unapproved process launches throw and
  produce private receipts that fail the suite even if errors are caught.
  CommonJS/ESM and nested-Vitest negative canaries prove rejection and automatic
  activation. The voice fixture's caught shell-spawn fallback was repaired
  without changing production ASR. See [Gateway isolation](gateway-test-isolation-2026-10-11.md).

## Confirmed open security work

1. **Browser against an active TLS-terminating relay:** its nonce-only handshake
   can be relayed, and first pairing may trust `/health`. Native certificate
   binding is a separate implemented path; browser preview remains for trusted
   development environments. There is no cryptographic browser/native distinction
   merely from a request's platform name or Origin.

## Findings whose evidence or scope has changed

- The report's test totals and navigation failures are an older snapshot. See
  [browser CI](browser-ci-2026-10-11.md) for later failures, fixes and run receipts.
  Focused passes do not constitute a complete matrix pass.
- “No native SDK build” is outdated: Android APK/unit/lint, iOS simulator SDK
  and desktop build receipts are in [acceptance gates](acceptance-gates.md).
  Real phones, provider push, final signing, Windows installation and complete
  remote TLS acceptance remain open. Native memory/cold-start performance also
  retains its existing failed or unmeasured status.
- Public HTTPS Hub hosting is an explicitly requested deployment mode. It is
  not a defect merely because the earliest plan preferred local hosting. Default
  public binding and worker API exposure still need their existing safeguards.
- Moving source/dependencies to the mounted drive is complete. The old dirty
  checkout, production application, user data and public upstream repository
  were not deleted, restarted or archived in response to this report.

## Still to validate before changing behavior

The UI ordering/empty-response, Markdown list/preview/table, onboarding/copy,
card-gallery and localization observations need current rendered reproduction.
Update-path translator warnings, the cited DeepSeek upstream fix,
certificate automation and evidence portability remain review work. Google
Docs and physical push acceptance require their own live receipts. No blanket
“all findings fixed” or release-readiness claim follows from this document.

## Verification receipt

Audit/retention implementation commit: `9e7a215`. Its pre-completion hook passed the root
build and **242 files / 3,853 tests**, with one explicitly skipped test. The
client production build also passed. Earlier root failures and their fixture
repairs are described above rather than counted as passing runs.

The [continuity follow-up](https://github.com/cloveric/tarobot/actions/runs/38122013999)
was dispatched against that same commit for Chromium and macOS WebKit, but
hosting-account restrictions prevented all six runners from starting. No step
or test executed; this is neither a passing receipt nor an assertion failure.
The previous complete matrix remains 576 Chromium passes and 539 WebKit passes
with one WebKit failure, plus 41 skips per engine. The fixture fix still needs
an actual browser run when the runner restriction is resolved.
No running production Hub was restarted, and no existing user audit/history or
backup files were deleted by this work.

The subsequent signed-device-action implementation, based on `c3f702c`, passed
the pre-completion root build and **246 files / 3,893 tests**, with one explicit
skip. Its focused protocol/HTTP/client suites passed **57 tests**; desktop Rust
passed both signing-vector/validation tests, and the client production build
including translation checks passed. Mobile adapter tests mock SDK secure
storage and are not physical-device acceptance. Browser CI and final packaged
native UI verification retain their open gates; no production service was
restarted to activate this protocol change.

The relay-source follow-up, based on `5b947a5`, passed the root/standalone-relay
build and full pre-completion suite: **248 files / 3,904 tests**, with one explicit
skip. All 18 relay tests ran in that suite, including opaque TLS forwarding,
multi-relay reconnection, slow-stream draining, source isolation and compatibility.
The initial three auth-isolation reproductions failed before the repair; the
final suite includes their passing regressions. No live VPS rollout or physical
phone result is inferred from these local transport checks.

The content-policy follow-up, based on `6d96613`, passed the root/relay build and
full pre-completion suite: **250 files / 3,914 tests**, with one explicit skip.
Ten focused tests, fourteen parser parity cases, the client production build
and both native copy hooks passed. The production fixture's rendered policy
check is a browser receipt, not a phone or hosted browser-matrix receipt.

The native-mobile identity follow-up, based on `df7077c`, passed root/relay build
and **250 files / 3,915 tests**, with one explicit skip. Its native Java/CryptoKit
checks, adapter regression, client build and Capacitor sync receipts are scoped
in the linked document. The new plugin's SDK/device acceptance is still required.

The Gateway-isolation follow-up, based on `d625e73`, passed the root/relay build
and **251 files / 3,918 tests**, with one explicit skip. The focused suite passed
155 tests, including the automatic-activation negative canary. This verifies
test isolation, not live fleet or physical-device acceptance.
