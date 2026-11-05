# Independent project audit — 2026-10-18

## Method and scope

The starting revision was `7a1a914be119d973b46d386bf79ce9063b3a5574`.
Three isolated, read-only DeepSeek sessions reviewed the client/native build,
Hub/CLI/security, and engine/queue/collaboration paths independently. Their
runtime receipts identify `deepseek-official / deepseek-flash` with reasoning
effort `max`. No daily Bot configuration or running Hub was changed.

Actual `claude-opus-5-5` sessions at `xhigh` then checked the reports against
source and tests. Model opinions were treated as hypotheses: the implementing
reviewers added failing reproductions before repairs and separated confirmed
defects, intentional behavior, improvements, and unverified platform risks.
The original model reviews were static; execution evidence below belongs to
the implementation and validation phase, not to the model reports themselves.
Reproduction tests were added concurrently after the baseline; the Opus reports'
warnings about newly modified tests refer to this deliberate audit work.

The pre-change baseline passed 4,318 host tests, with one Windows-specific test
skipped on macOS. Sixteen privacy/build-plan/native-audit script tests passed.
The standalone import graph contained 359 modules and no optional legacy
transport or Feishu SDK imports.

## Engine and queue decisions

| Finding | Decision and resulting behavior |
| --- | --- |
| Runtime timeout preference lost at card and command entry points | Confirmed and reproduced. Card continuations, engine commands, board/mini/delegation/crew paths carry the owning Bot's preference. Bus targets reload their own preference for each turn. Shared optional-transport dispatch uses the same policy. |
| Queued asynchronous answers have no scoped cancellation | Confirmed interaction gap. The submitted answer receipt offers cancellation only while queued, preserves the answer, and settles immediately. Repeated or stale taps do not stop current work; other queued inputs retain order. Restart recovery removes the obsolete action. |
| Bus request deadline remains after `/timeout off` | Intentional separate boundary, now disclosed in status/off text. Engine watchdog preferences do not disable request deadlines or explicit crew stage limits. |
| Unattributed Feishu background notices retain a reply anchor | Excluded. The anchor preserves Feishu topic routing; the App already omits a false reply relationship. Existing documentation and regression tests require this behavior. |
| Agent Bus depth never accumulates from command prompts | Excluded for current reachable paths. Incoming Bus prompts bypass the slash-command dispatcher; cross-host Bot messages have a separate authenticated hop limit. |

Gateway deliberately disables the optional transport's preempt mode. A
regression confirms that changing that optional configuration cannot make a new
App message displace a queued answer. This is distinct from user-triggered,
task-scoped cancellation.

These repairs use the shared host core for desktop, mobile and headless CLI.
No new CLI command or wire-schema migration is needed. The answer-receipt
button is presentation of an existing card action; CLI queue commands retain
their pre-dispatch meaning.

The final Opus engine patch review found no blocking defect. Its two follow-ups
were applied: a cancelled queued answer writes a task-scoped terminal timeline
event, and Bus configuration-load failure logging states accurately that runtime
timeouts remain enabled while no configured budget can be enforced.

## Host, CLI and network decisions

Numbers below refer to the independent Host report.

| Finding | Decision and resulting behavior |
| --- | --- |
| 1. Failed managed update loses enabled intent or claims recovery during drain | Confirmed for uncertain stop/closing-control paths. Recovery waits within a bound under the update lock, verifies unchanged runtime identity and selection, rejects draining status, and only reasserts enabled intent when service ownership is verified. It does not start a second Hub or restore database contents. |
| 2. Old signed enrollment snapshot discloses the current directory | Confirmed through an unauthenticated TLS fixture. Public enrollment returns the exact submitted signed membership receipt, not newly merged membership. Authenticated owner/peer synchronization retains current-directory access. |
| 3. Long history exceeds CLI response bounds | Confirmed. History uses a 6 MiB page target with one complete larger message allowed alone. The CLI history GET limit accommodates that logical message, and cursors preserve all records. Other response limits are unchanged. |
| 4. Database-first attachment GC leaves permanent file orphans | Confirmed. Existing retirement markers precede file deletion; failed unlink retains retryable database state and is audited. Exact, aged historical orphan filenames can be recovered. Upload final publication checks retirement under the database guard. |
| 5. Count-only replay pages materialize excessive content | A large-page reproduction confirmed unbounded aggregate page bytes, not an observed device OOM. Replay now loads by sequence and applies a 4 MiB page target; individual logical events remain complete and sequence-contiguous. |
| 6. systemd dollar escaping is doubled incorrectly | Excluded. JavaScript replacement syntax produces the correct `$$` unit output. Added an output regression without changing production escaping. |
| 7. Stale directories undo names/routes across three hosts | Confirmed. Authority reconciliation takes mutable descriptors from the newer signed directory, retaining local descriptors on equal-revision forks. Direct signed peer updates still propagate. The pure merge's revocation/conflict CRDT rules are unchanged. |
| 8. Expired pairing reservations block synchronization | Confirmed. Only live pending reservations count; actual device conflicts and active different-key reservations still fail closed. Native controller proof requirements remain intact. |
| 9. A revoked imported identity cannot be reused in a new network | Reproduced limitation, deliberately not relaxed. Silently skipping the old binding would let a subsequent local-revocation pass revoke the new coordinator's source member. A fresh-identity/rejected-slot protocol design is needed before changing this behavior. |
| 10. Interrupted update staging accumulates directories | Confirmed. A new staging operation reclaims only exact owned `.stage-UUID` directories while holding the update lock. Symlinks and unrelated names remain untouched. |
| 11. Reused PID prevents orphan-service cleanup | Confirmed conditional defect. The read-only owner check now considers boot/process epochs. Unknown evidence remains conservative; it never creates missing state or repairs a lock as a side effect. |
| 12. IPv4-mapped unspecified addresses bypass a route check | Confirmed guard gap, not a demonstrated remote exploit. Schema and transports share normalized loopback/unspecified checks while retaining TLS/identity validation and supported LAN routes. |
| 13. Download filename encoding is incomplete | Compatibility repair. `filename*` also encodes apostrophe, parentheses and asterisk, matching the existing Service Worker behavior. |

The CLI and App use the same repaired Host APIs. History clients must follow
`nextBefore`; replay continues from the last returned sequence while `more` is
true. The real HTTP fixture reconstructs 46 messages, including an intact 9 MiB
message. The sync fixture reconstructs 20 one-MiB messages across bounded pages.
Neither API truncates message text or changes message identity.

The final Opus Host patch review found two additional P3 defects. Both received
failing reproductions and repairs: export/backup validation excludes retired
attachments whose bytes were already removed before an interrupted collection,
while still requiring all active bytes; and read-only lock ownership checks
normalize and validate recorded and observed epochs before deciding a live PID
belongs to an old process. Malformed epoch evidence remains conservative. Older
backup snapshots without the retirement table still work without migration.
The four affected test files passed all 162 cases after these fixes.

## Client, native and build decisions

Numbers below refer to the independent client report and Opus additions.

| Finding | Decision and resulting behavior |
| --- | --- |
| 1. APNs envelope fails strict push parsing | Confirmed and reproduced. Native event handling projects only known wire fields before strict validation; provider metadata such as `aps` no longer suppresses navigation. Invalid identities remain rejected, and the legacy wire title is preserved. |
| 2. Android startup skips update discovery | Confirmed dead branch, smaller impact than the initial report implied. HostApp starts supported Android checks; opening settings shares the existing listener/check lifecycle. This adds discovery, not automatic installation or a new passive update banner. |
| 3. Slow progressing APK download hits a five-minute total timeout | Confirmed policy mismatch. Only the asset download removes total call timeout, deriving from the existing client to retain interceptors/TLS/read/connect limits. Cancellation, byte bounds, digest and package verification remain. |
| 4. Audio disappears during virtual scrolling; undecodable media has no recovery | Confirmed. Playing/saving audio retains its message row, pauses when its host becomes inactive, and releases retention after pause. Undecodable image/audio shows a recovery action that exports original bytes. Desktop, phone and ADHD layouts are covered. |
| 5. Long filenames lose extensions or exceed limits after a reserved-name prefix | Confirmed. Filename truncation reserves extension and prefix budgets before iterating Unicode code points. |
| 7. Identity-storage failures are described as network outages | Confirmed. Connection and lock UI render storage-specific recovery guidance, preserving data and pairing. Rust updater keychain-busy differentiation remains a separate follow-up. |
| 9. Preparation processes inherit updater signing secrets | Conditional supply-chain exposure, hardened. Both Mac and Windows preparation subprocesses strip signing variables. Every final Tauri build skips duplicate frontend work; unsigned final builds also strip those variables. Explicit signed final toolchains remain trusted. |
| 14. Private desktop downloads cannot be cancelled from UI | Confirmed interaction gap. GitHub downloads expose the already supported native cancellation before replacement starts. The public updater is not advertised as supporting download cancellation. |
| 16c. iOS share extension displays the old product name | Corrected visible labels only. Persisted/internal compatibility identifiers are unchanged. |

Client presentation, media lifecycle and native event handling have no headless
CLI interaction equivalent. Build preparation still packages the shared Host;
the Host/CLI behavior changes are listed separately above. Engine adapters are
not altered by the client repairs.

### Follow-ups and excluded claims

- iOS document-picker swipe dismissal, mobile cold-start navigation during
  pending pairing/preparation, PDF/large-media memory peaks, and native updater
  keychain-busy mapping need dedicated platform reproduction before repair.
- Optional hardening/improvements remain: broader executable-file warnings,
  notification-claim retention, visibility-aware idle panel polling, safe cleanup
  of a newly created empty file after quarantine failure, and caching large media.
  Existing quarantine/MOTW defenses and notification duplicate prevention were
  not weakened. Automatic retry after uncertain notification delivery was not added.
- Client browser/native gates are not all part of push CI. This run executes the
  affected browser suites explicitly; it does not claim a redesigned release CI.
- The desktop's progressing-download read timeout is intentional; absence of a
  short total deadline is not itself a defect. SystemUI public-version intent and
  speculative Agent Bus recursive depth claims were not treated as proven bugs.
- Optional Feishu preempt mode may skip a queued answer just like another queued
  task; Gateway's independently copied FIFO policy remains fixed. No optional
  transport fleet was restarted or exercised against live accounts.

## Validation

| Gate | Result |
| --- | --- |
| Final completion hook: history secret scan, standalone build and whole default test suite | Passed: 328 files, 4,385 tests passed; one existing Windows-specific test skipped on macOS. Standalone graph: 360 modules, no optional legacy transport/Feishu SDK imports. |
| Privacy guards, iOS release-plan and native-audit process Node tests | 16 passed. |
| Optional legacy TypeScript build | Passed. |
| Client translation, TypeScript and production Vite build | Passed. |
| Affected client Chromium suites | 132 distinct cases passed; one existing optional supplied-MP4 case skipped. |
| Affected client WebKit suites | 117 distinct cases passed; the same optional supplied-MP4 case skipped. |
| Network UI and real isolated TLS Hub browser journeys | 36 Chromium and 36 WebKit cases passed. Includes three-host discovery, candidate replacement and leaving-network continuity. |
| Android update policy JVM | 7 passed. |
| Updated iOS Simulator Release build | Main App and share extension compiled with Xcode/SDK 27.1. Both final bundles pass strict signature verification; final arm64 and x86_64 Mach-O simulated entitlements contain matching App Groups and application identifiers. |
| Actual installed Tauri CLI empty/nonempty build-hook control | Empty override skips the hook; nonempty control executes it. Both reach a stub runner that deliberately stops before compilation/signing. This is not signed packaging acceptance. |

Browser counts exclude overlapping reruns after assertion/fixture changes. Focused
Host, network, engine and client unit runs are not added again to the full-suite
count. Reproductions and runtime tests use disposable state on the mounted
development disk. Raw model transcripts, local paths, device state and credentials
are not committed.

Browser/JVM bridges are not physical iOS/Android validation. Real launchd,
systemd and Windows Task Scheduler lifecycle behavior was not exercised against
installed services. Native APNs clicks, a real slow APK transfer/installer,
and the iOS document-picker gesture remain outside this run's acceptance.
The updated iOS build was compiled and inspected, not launched again this round.
Simulator ad-hoc signing is not a distribution certificate or installable iPhone
IPA. The local signing doctor found zero valid signing identities; no account
membership, provisioning or TestFlight upload was inferred from compilation.

## Dependency advisory disposition

The production host dependency audit reported no advisories. The client audit
reported three chained moderate entries for one underlying
[sprintf-js precision-format advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
The installed path is Mammoth's command-line entry through argparse; the App's
DOCX worker imports Mammoth's library entry, which does not import argparse.
No patched sprintf-js version was available during this review. The audit's
suggested Mammoth downgrade was not applied. This is a documented transitive
dependency finding, not a claim that the advisory is fixed or that every
possible packaging/runtime path has been dynamically exercised.

## Delivery boundary

This audit does not itself publish a release, replace the installed App, restart
production services, or perform phone acceptance. A later host-affecting release
must ship the App bundle and standalone CLI from the same repaired revision.
