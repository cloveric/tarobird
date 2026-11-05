# TaroCub client implementation and acceptance evidence

The operator requested the v1.0 product plan on 2026-10-01, then clarified:
**complete the program first; deployment is deferred**. VPS provisioning, live
Apple/Google authorization, production push, signing/notarizing, TestFlight,
release publication and fleet restarts are deferred. No live fleet configuration
has been changed. This ledger is not a v1.0 completion claim.

The [remaining acceptance review after r38](remaining-acceptance-2026-10-11.md)
records native/device/account dependencies and the order for resuming verification.
The user has now unlocked the Mac. [Ordinary r38 native acceptance](native-r38-2026-10-11.md)
verified pairing, restart identity/draft recovery, combined text/files, actual Save As,
quotes and revocation against an isolated HTTP Hub and synthetic engine. OS logs confirm
a background notification was presented as a banner; its click route is still unverified.
Summed native RSS was 311–323 MiB, above the 200 MB budget. The notification authorization
timeout now gives recovery guidance instead of misreporting a settings-read failure;
Chromium/WebKit each passed 38 notification cases and the client build passed.
Historical lock-screen statements below describe earlier rounds, not the current Mac state.

Latest verified desktop artifact: r40（本地材料：`evidence/macos-r40-2026-10-11.json`）, containing
[conditional Markdown dependencies and bounded module recovery](markdown-dependencies-2026-10-11.md).
Chromium and WebKit each passed 46 related cases; final pre-complete passed 239 files,
3,832 tests and one skip, followed by the root build. All 232 source inputs remained
unchanged during packaging; 306 frontend files match each phone shell. Dual architecture,
strict ad-hoc signatures, DMG integrity, read-only bundle comparison and delivery copy
passed. Native follow-up and RSS limits are recorded separately in that report.
It was not installed, notarized or published; phone SDK/device gates remain open.

Previous verified desktop artifact: r39（本地材料：`evidence/macos-r39-2026-10-11.json`）, containing
the notification request-timeout guidance. Both architectures, strict ad-hoc signatures,
DMG integrity, read-only full-bundle comparison and Downloads copy passed. All 230 source
inputs were unchanged; 303 frontend assets match each phone shell. It was not installed,
notarized or published. The preceding manual native evidence belongs to r38, not r39;
phone resources are not mobile SDK builds.
Final pre-complete passed 239 files/3,832 tests, one skipped, then the root build.
An initial archive-size-test timeout and its passing isolated check remain recorded
in the verification receipt（本地材料：`evidence/native-r38-20261011/verification.json`）; no test
threshold or assertion was changed to obtain the later pass.

Earlier source follow-up, 2026-10-11: [notification readiness and recovery](notification-readiness-2026-10-11.md)
separates notification intent from fresh receiving evidence, adds read-only Android
app/channel checks and provider-preserving recovery, and closes stale-query and
cross-host action races. Chromium/WebKit each passed 76 related cases; 239 root
suites/3,832 tests and both builds passed. Phone frontend assets match by hash;
SDK builds and real-device delivery are still open. Astra's findings were fixed;
the actual Opus 5.5 xhigh request timed out without a verdict.

The earlier verified desktop artifact r38（本地材料：`evidence/macos-r38-2026-10-11.json`）
includes system push token maintenance and receiving diagnostics. Both
architectures, strict ad-hoc signatures, DMG integrity, read-only mounted bundle
equality, the Downloads copy and 303 frontend resources in each phone shell
passed. Current-round Chromium/WebKit each passed 51 related cases; root
checks passed 239 suites/3,832 tests. It was not installed, notarized or published.
At its packaging checkpoint the Mac was locked; the later r38 manual test is recorded
above. iOS SDK and configured Android SDK were unavailable, and physical-device gates
remain open.

Earlier source follow-up, 2026-10-11: [bounded Markdown recovery](markdown-recovery-2026-10-11.md)
preserves the waiting queue after an isolated Worker failure. Repeated failing owners are isolated; constructor/independent-owner failure
opens a shared circuit. A translated per-message action restores formatting
locally and resumes other circuit-blocked history without resending. Latest text and focus remain stable during recovery;
Astra's stale-tree finding is fixed and covered by held-result tests. Related
Chromium/WebKit runs each passed 67 cases; actual built-App recovery and store
read-back passed on both layouts/engines, with separate heap/streaming checks.
Native SDK/device, RSS/cold-start and deployment gates remain open.

The earlier verified r33 development bundle（本地材料：`evidence/macos-r33-2026-10-11.json`）
contains these review corrections and all r32 features. Optimized arm64/x86_64,
strict ad-hoc seals, DMG integrity, read-only full-bundle equality, detach and
Downloads copy/hash passed. All 303 frontend resources match both phone shells.
It was not installed, notarized or published; no new ordinary native/device
execution was performed. Matching Hub and remaining acceptance gates still apply.

Previous source follow-up, 2026-10-11: Markdown now releases serialized transport
JSON after parsing and retains only parsed trees plus output fingerprints.
Bounded asynchronous native hashing has a per-chunk fallback; owner/revision,
timeout and reply-error recovery remain covered. A Chromium stress fixture
released 1,854,524 bytes of retained JSON; this is not a native-RSS claim.
Actual Opus 5.5 xhigh and Astra reviewed the production source and prompted
stronger revision/rejection tests. Chromium/WebKit each passed 52 distinct
related cases, with separate Chromium heap and built-App streaming checks;
both builds passed. [Measurements and limitations](markdown-memory-2026-10-11.md).

The earlier verified r32 development bundle（本地材料：`evidence/macos-r32-2026-10-11.json`）
contains this optimization and all r31 corrections. Both optimized architectures,
strict ad-hoc seals, DMG integrity, read-only full-bundle comparison and the
Downloads copy passed. Tested production sources stayed unchanged; all 303
frontend files match both mobile resource copies. It was not installed or
published; mobile SDK/device and native RSS/cold-start gates remain open.

Previous source follow-up, 2026-10-11: streaming no longer starves pending queue
reads; passive shared-IDB views preserve a neutral syncing placeholder until
fresh history reconciles a removed item. Per-conversation observations cover
switching away and returning before a new read completes. Actual Opus 5.5
review led to reproduced hidden-receipt accumulation and stale retry fixes;
Astra also caught the empty-queue/delayed-ACK interaction. Pending-row height
participates in desktop/phone scrolling. A controlled real Markdown Worker
reproduction additionally fixed visible-anchor drift while reading history,
with offscreen growth/shrink, visible-row growth and simulated iOS touch
deferral coverage. Final Chromium and WebKit runs each passed 100 related cases,
including all 18 new cases; both builds passed. Earlier failures and their
dispositions remain recorded. [Changes and exact verification scope](outbox-refresh-2026-10-11.md).

The earlier verified r31 development bundle（本地材料：`evidence/macos-r31-2026-10-11.json`）
contains all of those corrections. Both optimized architectures, strict ad-hoc
seals, DMG integrity, read-only full-bundle comparison and the Downloads copy
passed. The tested source remained unchanged, and all 303 frontend files match
both mobile resource copies. It was not installed or published; mobile SDK,
physical-device, ordinary native UI and performance acceptance remain open.

The earlier verified r30 development bundle（本地材料：`evidence/macos-r30-2026-10-11.json`）
contains the initial outbox changes plus the storage, history-refresh and send-
continuity follow-ups below. It predates the final reviewer/Markdown corrections.
Both optimized architectures, ad-hoc seals, read-only bundle
comparison and the Downloads copy passed. All 303 frontend resources match
both mobile shells. No installed App or live Hub changed. The Mac was locked;
new native UI/performance, phone SDK/device and release acceptance remain open.
Statements below about source-only changes describe their earlier checkpoints.

Earlier send-continuity follow-up, 2026-10-11: an actual Hub/IDB regression
reproduced messages disappearing between ACK and slow history rendering in
both desktop and phone layouts. Committed ACK receipts now keep `Sent` feedback
until history catches up, including hidden-chat returns. Fast new-send feedback,
retry/discard, cards, forwards, identity fences and host isolation are covered;
Chromium/WebKit each passed 72 distinct related cases and both builds passed.
Actual Opus 5.5 xhigh review also led to reproduced fixes for removed-item retry
resurrection and ACKs following failed event commits; Astra reviewed the fixes.
This source batch is newer than r29. The passive-window handoff identified at
that time is addressed in the newer follow-up above; instant notification of
every local-only cross-window write remains outside its scope.
[Evidence](message-send-continuity-2026-10-11.md).

Earlier conversation follow-up, 2026-10-11: automatic history refreshes coalesce
streaming revisions and reuse in-flight slots across rapid navigation. Failed
reads retain displayed content with a retry action. Chromium and WebKit each
passed 36 related cases, including drafts, background uploads, search and long
reply recovery; both builds passed. The suspected cross-host preview leak did
not reproduce on the previous code. This is source-only, newer than r29, with
native performance budgets still open. [Evidence](message-refresh-performance-2026-10-11.md).

Earlier storage follow-up, 2026-10-11: schema 8 recovers pending/streaming IDs
without loading complete history, and attachment drafts retain encoded bytes
only while the read is pending. Chromium/WebKit each passed 32 related cases;
root and client builds passed. These source changes are newer than r29. The Mac
was locked again during this follow-up, so native RSS and cold-start budgets
remain open. [Evidence and next performance work](storage-performance-2026-10-11.md).

Earlier native/input follow-up, 2026-10-11: the Mac became accessible. Ordinary
universal r28 UI was exercised for manual loopback pairing, Keychain reconnect,
attachment/text draft recovery, file dialogs, exact saved bytes, quotes and
revocation across relaunch. Its measured summed RSS was 270–277 MiB, above the
200 MB budget. Subsequent fixes preserve finished voice encoding across
navigation, persist identity-scoped system-share reviews with conflict/expiry
protection, and keep optional shortcut and logging failures nonfatal. Actual
Opus 5.5 xhigh and Astra reviewed this batch. Focused Chromium/WebKit, Rust and
Node tests plus 237 root suites and build passed; an isolated actual Tauri TLS
audit again verified proxy rejection and the 512 MiB hash. These scopes and the
unresolved phone, native performance and release gates are recorded in
[the current acceptance report](native-product-2026-10-11.md). Older statements
below that the Mac is locked describe their dated runs; UI access can change.

Encryption scope decision, 2026-10-05: the operator explicitly deferred adding
application-layer end-to-end encryption. TLS, pairing and Hub identity checks
remain required; native desktop/mobile implementation continues. The browser is
a preview/debug surface, and no browser scope answer is required to continue
native work. This decision is not security acceptance or authorization to add
plaintext relay storage. [Security scope](security.md).

Native development delivery and connection feedback, 2026-10-05: r26 now
packages the native desktop TLS identity binding and per-route verification
messages. Actual Opus 5.5 reviewed the feedback; key paste truncation, context-
specific recovery guidance and non-200 proof wording were corrected. Independent
native WebView checks covered active-proxy rejection, authenticated HTTP/WS,
8 MiB upload and a 512 MiB download hash. Both optimized architectures, strict
ad-hoc seals, read-only full-bundle comparison and the Downloads copy were
verified; 303 frontend resources match both phone copies. No App was installed
and no Hub or fleet deployed. Complete native UI, phone SDK/device and performance
acceptance remain open. [Work and validation](connection-feedback-2026-10-05.md)
and r26 package receipt（本地材料：`evidence/macos-r26-2026-10-05.json`）.

Mobile connection recovery follow-up, 2026-10-05: rejected native listener
registration no longer poisons all subsequent reconnects. Concurrent hosts share
registration, current failed requests still reject, and native-only transport
and iOS page scoping remain unchanged. Actual Opus 5.5 review prompted inactive
callback fencing for partial registrations. Chromium and WebKit each passed 42
transport cases; the frontend build and 303 resources in both phone copies were
verified. This source change is later than r26, which was not replaced. Mac is
still locked and phone SDK/license prerequisites remain unavailable; this is
not device acceptance. [Reproduction and scope](mobile-bridge-recovery-2026-10-05.md).

iOS native transport follow-up, 2026-10-05: URLSession/Security leaf binding,
Capacitor source registration and the shared iOS driver are now implemented.
Real Apple Foundation tests on Mac covered TLS attacks, pairing/authentication,
512 MiB streaming hash, cancellation, quotas and document fencing. A reproduced
unbounded delegate-buffer approach was replaced by demand reading; a reproduced
local-close callback without a peer reply no longer claims clean confirmation.
This is not an iOS SDK build or iPhone acceptance; installed clients and r25 are
unchanged. [Implementation and limits](ios-native-transport-2026-10-05.md).

Android native transport follow-up, 2026-10-05: Android source now routes Hub
HTTP/WS through a Capacitor plugin with normal PKI plus Hub-signed TLS leaf
binding, no WebView fallback, bounded HTTP streams and document cancellation.
The production Java core passed isolated JVM tests against a real temporary Hub,
including pairing/authentication, active-proxy rejection, 8 MiB upload, 512 MiB
streaming hash, blocked IO cancellation and certificate rotation. This is not an
APK or Android-device test. SDK approval and native device acceptance
remain open; the later iOS source integration has separate limited evidence; no package or service was replaced. A subsequent [bounded WebSocket follow-up](android-socket-bounds-2026-10-05.md) moves frame rejection before allocation and adds fragmentation, handshake, queue and aggregate upload limits, plus cancellation of a stalled writer. These source/JVM results do not establish Android-device memory or lifecycle acceptance.
[Implementation and evidence](android-native-transport-2026-10-05.md).

Native desktop follow-up, 2026-10-05: an opt-in isolated macOS WebView now exercises
the actual frontend adapter, Tauri IPC, pinned Rust transport and a real temporary
Hub. Pairing, authenticated HTTP/WS, rejection of an active proxy before credentials,
8 MiB upload and 512 MiB streaming hash checks passed. A hidden-window suspension
issue was reproduced and the desktop background policy now disables suspension on
supported macOS versions. Opus follow-up identified a late document-lease claim;
the entry module now claims eagerly, with native rotation and cancellation.
This is not installed-app, Windows or mobile acceptance; no app or service was
replaced. [Scope and receipts](desktop-native-transport-2026-10-05.md).

Desktop native transport, 2026-10-05: Rust now binds the actual TLS leaf to the
trusted Hub identity and pins both HTTP and WS; the frontend routes all desktop
Hub requests through IPC with no browser fallback. Remote pairing requires an
independent Hub key. Opus caught and parent fixed an IPC argument mismatch and
close/quota races. Isolated Rust TLS, frontend contract and browser regressions
are recorded separately from native-container acceptance. Mobile, installed r25
and the original-plan security release gate remain open. No package or service
was replaced. [Implementation and boundaries](desktop-native-transport-2026-10-05.md).

Active-relay security audit, 2026-10-05: isolated strict-TLS Node and actual
Chromium-client probes reproduced handshake forwarding through another trusted
same-host certificate, plaintext token observation and accepted message changes.
Actual Opus 5.5 xhigh confirmed the missing channel binding. Added a Hub TLS-leaf
identity proof and shared verifier with adversarial TLS tests. The later desktop
source integration above does not retroactively protect installed clients.
This is an open release blocker; r25, mobile and browser transport remain affected
under that threat model.
[Reproduction, implemented foundation and required integration](tls-identity-2026-10-05.md).

Development delivery refresh, 2026-10-05: r25 now packages the accepted phone
attachment menu and hold-to-act/direct-file-preview changes below. Optimized
Apple Silicon and Intel builds, strict ad-hoc signatures, DMG verification,
read-only full-bundle comparison and the exclusive Downloads copy all passed.
All 303 frontend resources match the browser-accepted build and both mobile
shell copies. The final root gate passed 236 files / 3,796 tests / one skipped
plus build. No app was installed, service deployed or release published;
phone compilation/installation and native runtime/performance remain open.
Package receipt（本地材料：`evidence/macos-r25-2026-10-05.json`） and
[remaining original-plan gates](acceptance-gates.md).

Phone hold-to-act and direct file preview, 2026-10-05: touch-holding a
message/image/file opens quote, copy, text selection and forwarding; a phone file's
icon/name directly opens preview, with a separate save control and no visible
"Open" label. Actual Opus 5.5 xhigh reviewed the implementation; parent fixed
stream-follow interference, selection access and lifecycle details. Final affected
Chromium/WebKit regressions each passed 20 cases. All five real CLIs read quoted
PNG/PDF contents in the paired-browser journey; final Codex also passed WebKit.
Root gate passed 236 files / 3,796 tests / 1 skipped plus build.
All 303 resources match both mobile copies; phone compilation/installation and
physical gestures/haptics remain open. [Behavior, review and evidence](message-hold-2026-10-05.md).

Live VPS privacy acceptance, 2026-10-05: current bundle ran in a transient
isolated service on the authorized Ubuntu VPS. Two paired protocol clients
exchanged messages and downloaded one1MiB upload with matching SHA-256. VPS
capture contained5410 complete packets;44 reassembled directional streams parsed
913 TLS records, with no application markers and a recovered plaintext control.
Configured files stayed unchanged, private temp directories stayed empty, and
no writable regular file descriptors or payload markers in the service journal
were found. Cleanup restored no debug listeners, stopped/disabled original relay,
and unchanged Nginx PID. This supplements plan12.14; physical phones and native
certificate rejection remain open. [Evidence and scope](relay-privacy-2026-10-05.md).

Phone attachment menu, 2026-10-05: external Plus opens Camera / Photos / Files;
all choices reuse mixed captions, uploads and previews. Actual Opus5.5 xhigh
provided design and a conditional review; parent corrected rotation invalidation
while preserving cross-host/chat ABA fences, removed a non-draggable handle and
fixed keyboard/composer viewport following. Initial browser22/22, final affected
15/15 (overlapping), root236 files /3796 passed /1 skipped plus build. All
303 frontend resources match iOS/Android copies. Physical camera/permission,
native lifecycle and phone compilation/installation remain open. At that feature
checkpoint r24 remained the previous package; r25 now includes these resources.
[Implementation, rendered result and evidence](attachment-menu-2026-10-05.md).

Studio design follow-up, 2026-10-05: actual Opus5.5 xhigh supplied24 concrete
edits from fresh screenshots;23 were integrated, with compact phone message
spacing and a4% bubble sheen after a dark-theme contrast correction. Its completed
rendered review requested3 corrections. Parent verification resolved solid unread
counters, true44px message actions with a2px row gap, and explicit colour-only
inbox transitions. Main browser checks24/23 and final affected11/11 passed
(overlapping); the final root gate passed236 files /3796 tests /1 skipped plus
build. The r24 universal development package and303 frontend/mobile resource
copies are verified. No unconditional Opus sign-off is claimed; physical/native
acceptance stays open. [Design, before/after and evidence](premium-qa-2026-10-05.md).

Upstream parity follow-up, 2026-10-05: a fresh inspection found the original
repository at `a6577ab`, with five commits since the client base `2941619`.
Provider content-policy classification from `428d5b2` was missing in this client
worktree. Its error guidance and non-retryable Bus result are now ported, with a
further fix preserving that category in audit summaries. The existing client's
fresh-session allocation already covers the upstream reset behavior while
preserving legacy native IDs; no prefix remap was applied. Root regression:
236 files, 3,796 passed, one skipped and build. This is a shared-runtime change;
the r21 frontend stays unchanged. The original repository and live fleet were
not modified. [Evidence, Opus review and limits](upstream-parity-2026-10-05.md).

File download memory/lifecycle follow-up, 2026-10-05: explicit larger file-card
downloads now use owned temporary-file sources, a 256 MiB aggregate resume budget
and a one-use streaming browser export. Startup also clears orphan scratch before
pairing, while Web Locks preserve another window's active bytes. Actual Opus 5.5
xhigh completed three implementation reviews; the resulting checkpoint, quota,
handoff, filename and worker-lifecycle corrections passed browser acceptance.
Main suites: Chromium 65 / WebKit 54; final affected suites: 16 / 16 (overlapping).
Both engines saved 512 MiB twice after a separate 256 MiB journal, with exact hashes,
Chinese filenames and zero scratch after each. Browser RSS measurements are
reported with their mixed results and do not certify native resident memory.
[Measurements, behavior and limits](download-memory-2026-10-05.md).
The r21 universal development DMG includes this milestone and the accepted r19
design. Its ad-hoc package and copied mobile resources are verified; native app
runtime and physical-device acceptance remain open.
Package receipt（本地材料：`evidence/macos-r21-2026-10-05.json`）.

Opus design refinement, 2026-10-05: actual Opus5.5 xhigh supplied exact CSS
changes from fresh desktop and phone captures and reviewed the rendered result.
Sidebar/toolbar hierarchy, phone filters, grouped settings surfaces and press
feedback were refined. The parent retained real44px filter targets, destructive
action styling and reduced motion; final review feedback aligned creation
actions and removed button-like fills from explanatory labels. Chromium31 /
WebKit30 main tests passed, followed by8 /8 affected-case checks after the last
two CSS edits. Root gate:236 files /3,792 passed /1 skipped and build.
[Rendered comparison, evidence and limits](refinement-qa-2026-10-05.md).
The r19 universal development DMG contains this accepted frontend; both
architectures, ad-hoc signatures, mounted bundle and delivery SHA checks passed.
All303 frontend resources match the mobile shell copies (not compiled).
Package receipt（本地材料：`evidence/macos-r19-2026-10-05.json`）.

Durable download follow-up, 2026-10-05: completed ranges now survive browser
reload and page closure in a pairing-scoped IndexedDB journal. Real 120 MiB
downloads resume from 8 MiB and produce exact SHA-256 matches on desktop reload,
phone reopen and two concurrent tabs, in Chromium and WebKit. The last chunk is
never persisted; fresh authorization and whole-file verification precede export.
Origin quota headroom, bounded retention, startup cleanup, revocation/reset
fencing, additive cache migration and explicit retained-progress cancellation
status were verified. Actual Opus 5.5 xhigh reviewed the implementation; parent
applied its resource and interaction corrections, including immediate cancel
feedback and stale-callback fencing. Chromium core 48 and WebKit
36 cases passed; root gate passed 236 files / 3,792 tests with one skip and build.
Native app termination, physical-device lifecycle and bounded-memory acceptance
remain open. [Scope, file receipts and limits](durable-downloads-2026-10-05.md).
The r18 universal development DMG includes this milestone and the preceding UI
refinement. Both architectures, strict ad-hoc signatures, mounted bundle and
delivery hashes pass; all 303 accepted frontend resources match the iOS/Android
resource copies. No installed app or service was replaced.
Package receipt（本地材料：`evidence/macos-r18-2026-10-05.json`）.

Product design follow-up, 2026-10-05: actual Opus 5.5 xhigh implemented a
coherent visual refinement and reviewed the rendered result. Parent fixed real
phone touch bounds and narrow filenames, applied the visual review's quieter
buttons and word wrapping, and stabilized a WebKit test baseline around virtual
row measurement. Chromium 33 / WebKit 32 scenarios passed, including all four
palettes in both modes; the 5,000-line streaming check retained 5ms input,
16.8ms frame P95 and zero measured long tasks. Root gate passed 236 files /
3,792 tests with one skip and a build, using four workers after a default-pool
archive fixture timeout. Native and physical-device visual acceptance remains
open. [Actual screenshots, design review and limits](premium-design-qa-2026-10-05.md).
The r17 universal development DMG passed both-architecture signature and
mounted-bundle checks; all 303 accepted frontend resources match both mobile
copies. It is delivered to Downloads without replacing the installed app.
Package receipt（本地材料：`evidence/macos-r17-2026-10-05.json`）.

Phone input follow-up, 2026-10-05: actual Opus 5.5 xhigh delivered the
viewport layout. Parent integrated Capacitor Keyboard, fixed pairing scrolling,
creation focus timing and stretched Bot avatars, then validated 30 browser
flows each in Chromium and WebKit. The root gate passed 236 files / 3,792 tests
with one skip and a successful build. Visual-viewport signals are controlled
simulations, not physical keyboard acceptance. [Report and screenshots](keyboard-qa-2026-10-05.md). The verified r16 universal
development DMG and matching 303-file mobile resource copies are recorded in the
package receipt（本地材料：`evidence/macos-r16-2026-10-05.json`）; no installed app or production
service was changed.

Quoted/forwarded media follow-up, 2026-10-05: all five real CLIs passed the
Chromium paired desktop/phone journey; Codex additionally passed WebKit.
The target Bot cannot access source-conversation files, silent forwarding does
not dispatch, quoted inputs contain no new uploads, two independent native
sessions read PNG/PDF codes, and only the selected Bot receives the forward.
Actual Opus 5.5 xhigh found attachment-ID reuse after recall and unbounded
Gateway message caching; parent reproduced and repaired both. Schema 11 retires
unreferenced recalled IDs before GC while preserving active references and
forwarded copies. Legacy migration, restart and full backup/restore are tested;
parent also fixed metadata-field confusion in the migration. This is Hub/Gateway
work, so the r15 frontend bundle is unchanged and production services remain
untouched. [Scope, screenshots, reports and receipts](quoted-media-2026-10-05.md).

PDF reading follow-up, 2026-10-05: actual Opus 5.5 xhigh implemented the local
reader after a real Chrome screenshot and four failing regressions exposed the
blocked sandbox iframe and drag-selection dismissal. Parent added lazy loading,
bundled support resources, Hub MIME types, backdrop pointer ownership and an
explicit same-bundle Worker with bounded cleanup and retryable startup errors.
Final Chromium/WebKit each pass 20 core flows, including painted page pixels,
CJK text, original download bytes, password handling, small dark English UI,
worker failure/cleanup and offline reading after the Hub stops. Root gate:
235 files / 3,782 passes / one skip; root/client builds passed. Native custom
schemes, physical gestures, older WebViews and uncommon scan formats remain
unaccepted. [Screenshots, scope and evidence](pdf-preview-qa-2026-10-05.md).
The r15 universal development DMG（本地材料：`evidence/macos-r15-2026-10-05.json`） now
contains the accepted reader: both architectures, strict ad-hoc seals, DMG
integrity, mounted-bundle comparison and Downloads copy passed. All 302 frontend
files match browser acceptance and both mobile resource copies. It supersedes
r14 without installing, publishing, notarizing or updating the deployed Hub.

File-action design follow-up, 2026-10-05: actual Opus 5.5 xhigh implemented
accurate export phases, neutral cancellation/handoff, active-preview errors and
retry. Parent rendering acceptance added native HTML modal focus, corrected
status overflow, made preview Retry 44px and separated filename/actions on small
phones after finding a 320px vertical filename. Chromium 30 cases and WebKit
eight passed; after final CSS corrections, all five file-action cases passed in
each again. Root gate: 234 files / 3,781 passes / one skip; build passed.
[Rendered before/after and limits](file-actions-qa-2026-10-05.md).
The r14 universal development DMG（本地材料：`evidence/macos-r14-2026-10-05.json`） includes
the final opener-focus correction. Both architectures, strict ad-hoc seals, DMG
integrity, mounted bundle and delivered copy passed; all 99 frontend files
match the accepted build and both mobile resource copies. r13 is superseded.
Native save/share dialogs and physical devices remain unaccepted. Retained phone
share cache is swept on a later export after 24h, not by a timed deletion job.

Desktop export follow-up, 2026-10-04: actual Opus 5.5 xhigh reviewed a reproduced
native short-write bug. Export now advances only by confirmed bytes, rejects
invalid counts, closes handles and explains native string failures. Unicode
filenames stay within character and UTF-8 limits. SDK/IPC fault injection with
real temporary files plus safety/download validation passed 22 cases; this is
not native save-dialog acceptance. Final root gate: 234 files / 3,781 passes /
one skip and build passed. [Reproduction, review and limits](desktop-export-2026-10-04.md).
The r12 universal development DMG（本地材料：`evidence/macos-r12-2026-10-04.json`） includes
the fixes, with both architectures, seals, mounted-bundle comparison and delivery
copy verified. All 99 frontend resources match both mobile shells. The Mac was
locked; installed App, Hub and production services remain unchanged.

Mobile settings and startup follow-up, 2026-10-04: actual Opus 5.5 xhigh
implemented phone page hierarchy, titles and touch targets. Parent added the
visible collaboration label, fixed immediate Back dirty-state timing, rotation
focus and 320px English slider wrapping, and split pairing from the chat module.
Final Chromium/WebKit each pass 11 core flows, including offline reading and
chunk-error recovery; initial JS is 614,387 B (31.7% below the prior 899,834 B).
Root gate: 234 files / 3,781 passes / one skip and build passed.
[Failures, rendered screenshots and scope](settings-nav-qa-2026-10-04.md).
The r11 universal development DMG packages these frontend changes and the prior
message sheet. Both architectures, strict seals, mounted bundle, DMG integrity
and Downloads copy passed; 99 resources match both mobile shells. No installed
app or Hub/fleet was changed. Receipt（本地材料：`evidence/macos-r11-2026-10-04.json`）.
Native-container and full-plan gates remain open.

Native goal follow-up, 2026-10-04: real Codex and DeepSeek exposed goal-clear
without active-turn cancellation and terminal status arriving before final text.
Both paths now retain final output through the owned native turn; Codex uses
exact turn interruption and fences retired/unknown IDs, while DeepSeek fences
new foreground admission and conservatively avoids session-wide cancellation
when ordinary work is already admitted. Actual Opus 5.5 xhigh read-only review
identified additional event-buffer and timeout races; focused reproductions and
fixes followed. Final Chromium/WebKit stop and completion matrix: eight passes,
16 rendered screenshots, all owned native workers exited and Codex fixture
threads archived. Root gate: 233 files / 3,688 passes / one skip, build passed.
[Evidence, initial failures and native concurrency limits](native-goal-2026-10-04.md).
This is a backend/runtime change; no package, installed app or production service
was updated. DeepSeek queued-stop/usage/steering combinations remain separate gates.

DeepSeek steering follow-up, 2026-10-04: ordinary queued inputs cannot steer an
active autonomous goal. The native private pipe verifies source RPC, current
turn and cancellation signal, injects without wakeup, and removes unclaimed
instructions at abort/end. Queued/stale/unsupported outcomes are explicit and
preserve the draft. Real Chromium/WebKit active and queued-goal flows plus a
native cancellation boundary passed. Root: 233 files / 3,736 passes / one skip;
client and root builds passed. One empty native completion is retained as a
failed acceptance attempt. [Evidence and limits](deepseek-steering-2026-10-04.md).
The r10 development installer has not been rebuilt for these runtime fixes.

DeepSeek ordinary queued-stop follow-up: the managed native host now removes
the exact inbox request or checks the current native origin before cancellation,
without an intervening await. Claimed-input events cover pre-assembly gaps.
Real Chromium/WebKit paired-device flows cover goal-preserving withdrawal,
active ordinary cancellation and same-session continuation. Missing receipts
are shown as unconfirmed in App/Lark/Telegram, with no automatic replay or
session-wide fallback. [Evidence and remaining concurrency limits](deepseek-message-stop-2026-10-04.md).
Opus 5.5 xhigh's actual 58-turn review drove exact output ownership, armed-goal
refusal, carried-context handling and late-admission checks. Final paired-browser
Chromium/WebKit scenarios and a separate real native goal guard passed; all three
owned native processes exited. Root: 233 files / 3,714 passes / one skip, build
passed; final routing follow-up: 78 passes. The usage/steering combinations and
physical devices remain open. No package or production service was updated.

Real ASR / native Bot follow-up, 2026-10-04: phone-recorded synthetic Chinese
speech passed the real MediaRecorder → Hub → Qwen HTTP → Kimi → two-client
playback path on Chromium and WebKit. A real 905-second sparse synthetic M4A
also passed automatic Tingwu routing on WebKit, preserving facts near both ends;
no duration or routing threshold was faked. A fresh SDK read confirmed deletion
of this job's temporary OSS media object. This does not audit provider result
retention or continuous-meeting accuracy. One initial test failed before ASR on
an asynchronous microphone-stop assertion; the final three ASR/CLI flows passed.
All owned processes/fixtures and private Kimi histories were removed. Default
opt-ins remain off; root 233 files / 3,676 passes / one skip and build passed.
[Evidence and physical-device limits](live-voice-2026-10-04.md). No production
source, package, deployed Bot or global configuration changed.

Kimi / Antigravity media follow-up, 2026-10-04: the shared opt-in media
journey now covers both engines' real ten-image/PDF input, titled compatibility
gallery and exact paired-client attachment/download bytes. Kimi and AGY each
have complete Chromium and WebKit passes; Claude's shared-test regression also
passed. Seven real runs include two retained failures: an AGY observer-format
mistake and an actual two-image recognition error. Later success does not erase
that model error. Recognition soft assertions still fail the test while allowing
transport checks to finish. Six default-off checks skip before live work; the
required gate passed 233 files / 3,676 tests / one skip and build. All owned
processes and temporary fixtures were removed; AGY native history remains.
[Results, exact scope and failures](compat-media-2026-10-04.md). No production
source, frontend package, installed app or global MCP configuration changed.

DeepSeek native media acceptance, 2026-10-04: the real Harness now passes the
phone-composed ten-image/PDF workflow on Chromium and WebKit, including reading
all hidden fixture codes, one titled gallery publication and exact paired-client
image/PDF/report bytes. A focused regression reproduced missing original image
paths in the native prompt; the adapter retains these paths alongside unchanged
inline pixels. One provider/native invalid-JSON tool-input failure was retained
as failed, followed by a separate successful recheck; no automatic replay was
added. Temporary native workers were verified stopped and private histories
removed. Focused 104 cases and the full 233-file / 3,676-pass / one-skip gate plus
build passed. [Evidence and limits](deepseek-media-2026-10-04.md). The frontend
and r10 package are unchanged; deployment/native-container gates remain open.

Opus-led visual refinement and packaging, 2026-10-04: actual Claude Opus 5.5
xhigh directly implemented the updated surface/type hierarchy, identity hues,
phone composer and bottom-sheet motion. Parent QA corrected gradient avatar
contrast and verified desktop/phone renders, four palettes, reduced motion and
focus return. Chromium/WebKit each passed 20 targeted interaction cases; the
required gate passed 233 files / 3,676 tests / one skip and build after the final
source correction. See [design and motion](atelier-opus55-2026-10-04.md),
[rendered QA](../../design-qa.md), and evidence（本地材料：`evidence/atelier-20261004.json`）.

The `20261004-r10` universal Mac development DMG now contains that exact accepted
frontend. Both optimized architectures compiled, standalone/read-only mounted
apps passed strict ad-hoc signature checks, DMG integrity and Downloads copy
hashes matched. All 97 frontend files match both copied phone-shell resources.
Packaging receipt（本地材料：`evidence/macos-r10-2026-10-04.json`）. The guide now reflects
phone icon actions, palette-dependent bubbles and keyboard/touch Bot controls.
Native apps remain inaccessible while the Mac is locked; no installed app,
production service, APK/IPA, signing account or release was changed. Physical
phone and remaining original-plan gates are still open.

Native session / phone follow-up, 2026-10-04: Opus 5.5 xhigh identified a weak
detach assertion; adding the group's own context marker exposed a real DeepSeek
reset bug. Unbound session IDs now include a UUID while existing native bindings
remain unchanged. Codex/Kimi/DeepSeek/Antigravity completed the strengthened
session journey; Claude completed empty-destination binding/detach. Further
Opus review drove early background-goal binding, pinned native cleanup, orderly
goal replacement, consistent command locks, topic-aware fan/verify and queued
cancellation guards. Final root gate: 233 files / 3,676 passes / one skip and
build. Native goal concurrency is covered by controlled protocol/runtime tests;
it is not claimed as full real-model or physical-phone goal acceptance.
[Reproduction, review, failures and receipts](native-session-mobile-2026-10-04.md).
These are Hub/shared-runtime changes; existing production services were not
restarted, and no new frontend package was needed.

Phone IM / real-CLI debugging with Opus 5.5 xhigh, 2026-10-04: Opus migrated
8 opt-in test files and reviewed the question-focus repair twice; the primary
agent migrated 7 more files and ran the checks. A real Codex MCP form exposed
delayed focus stealing typed input. A quiet-state fixture then reproduced the
ref-only repair's same-step bailout; the final revision-based layout effect
passes Chromium/WebKit (14 cases each) and real Codex forms. Five CLI stop/continue
cases per browser, Kimi question/approval, DeepSeek App tools and Claude 10-image
plus PDF delivery passed (14 final successful real-CLI flows). All 21 opt-in
tests still skip by default on both browsers. Root default-policy gate: 232
files, 3,656 passes, one skip and build. An inherited unrestricted Lark file-path
environment caused six expected default-policy assertions to fail in an earlier
run; the process override was removed, not the checks. Failures and model reports
are retained in [the audit and receipts](live-mobile-2026-10-04.md). This is
browser/mobile-layout acceptance; physical mobile keyboards and lifecycle remain
open, as does the full five-engine feature matrix.

The `20261004-r9` universal macOS development DMG packages this final question
focus fix. Both optimized architectures, strict ad-hoc seals on standalone and
read-only mounted apps, every bundle file, the Applications link, DMG integrity
and exclusive Downloads copy hash passed. All 97 frontend files match the final
browser acceptance input and iOS/Android resource copies. r9 receipt（本地材料：`evidence/macos-r9-2026-10-04.json`）.
This supersedes r8 for the frontend; it is not a mobile binary or native runtime
acceptance. No installed app or production service was changed.

Antigravity effort follow-up, 2026-10-04: installed agy 1.2.16 advertises xhigh,
which the old App/config and adapter allowlists rejected or silently dropped.
The shared list now reaches both process paths; ultra remains rejected. Phone
group selection, desktop synchronization, per-Bot isolation and invalid-write
preservation passed Chromium/WebKit. Actual Opus 5.5 xhigh completed a read-only
review; its stronger process-argument and API rejection checks also passed.
Root required gate: 232 files / 3,656 passes / one skip and build. No frontend
change, new package, native device/model claim or production runtime restart.
[Fix, review and receipts](antigravity-effort-2026-10-04.md).

Packaging and user-guide alignment, 2026-10-04: the `20261004-r8` universal
macOS development DMG contains the final full-regression frontend, including
per-host/offline Bot names, lazy phone home and WebKit virtual-list measurement
fixes. Both optimized architectures, strict ad-hoc signatures, read-only mounted
bundle comparison, image integrity and exclusive Downloads copy hashes passed.
All 97 rebuilt frontend files match the browser acceptance and both phone shells.
Root required gate passed 3,648 tests / one existing skip and build. The phone
navigation, per-host removal, search, notification sync and Skills/MCP user guide
now follows the current UI. r8 receipt（本地材料：`evidence/macos-r8-2026-10-04.json`）.
Native runtime/performance still require the Mac to be unlocked; the installed
app was not replaced. Android SDK license confirmation is pending, and full
Xcode/iOS Simulator is absent. This is not a signed production release or a mobile
binary. The overall plan remains open.

Full mobile/browser regression, 2026-10-04: actual Opus 5.5 xhigh updated four
phone journeys and independently reviewed per-host Bot-name previews. Fixed
offline inbox names, tilde prose, the startup script budget and WebKit virtual-list
measurement re-entry. Root gate: 232 files / 3,648 passed / one existing skip;
both builds passed. Full Chromium: 183 passed / 21 opt-in skips. Full WebKit:
163 passed / 11 skips / one development-cache conflict; after isolating Vite
caches and atomic gallery generation, all 63 affected cases passed concurrently
on each browser. Both phone shells now contain 97 hash-matched web files.
[Audit, exact results and boundaries](mobile-full-regression-2026-10-04.md).
The r7 DMG predates these additional fixes; r8 packages them. Native phone acceptance remains open.

Packaging update, 2026-10-04: the `20261004-r7` universal macOS development DMG
includes the then-current multi-host UI, phone IM, settings and Opus-reviewed mobile
fixes. Both architectures compiled; strict local ad-hoc seals, DMG integrity,
read-only mounted bundle comparison and Downloads copy hashes passed. All 95
frontend files matched its browser-accepted inputs and both phone shells at packaging.
See r7 receipt（本地材料：`evidence/macos-r7-2026-10-04.json`）. The existing running native
debug app was not replaced or restarted. Current native UI inspection was
blocked by the locked Mac; iOS Simulator tooling and Android SDK tools remain
unavailable. This is a new build artifact, not native runtime, signing-provider,
notarization, mobile installation or production-release acceptance.

Phone IM and mobile debugging, 2026-10-04: actual Opus 5.5 xhigh reviewed and
re-reviewed the dedicated phone interface. The primary agent reproduced and
fixed long-conversation tail-following, shared cross-host search/filter/scroll
state, and history-search return/context separation. Final Chromium and WebKit
runs passed 23 cases each, including mixed attachments, recorded voice, steering,
topics, search and long-message recovery. [Audit and boundaries](mobile-debug-opus55-2026-10-04.md).
The layout remains distinct from the desktop sidebar. Physical keyboard/IME,
OS permissions and native mobile lifecycle gates remain open.

Android multi-host UnifiedPush source milestone, 2026-10-04: persisted per-host
registrations use generation-specific connector IDs, scoped queues and retryable
removal. Native callbacks cannot revive removed registrations or route to another
Hub. FCM switching fences old endpoints before its server write, preserves other
hosts' shared token, and keeps notification preferences in operation order.
Actual Opus 5.5 xhigh reviews, JVM state-machine tests and browser bridge tests
are recorded in [Android push review](unifiedpush-multiple-hosts.md). Java registry:
8 passed; Chromium and WebKit: 35 each; root gate: 232 files / 3,647 passed / one
existing skip, both builds passed. Native bridge/HTTP substitutes are not OS push
receipts. Full Android compilation, SDK license consent, APK and real-device
delivery remain open; installed packages were not updated.

Normal multi-host App UI, 2026-10-04: `HostApp` now owns parallel Hub connections,
unified Bot/group navigation, host selection/pairing/rename/removal and source
labels in settings, file, capability and creation panels. Switching keeps uploads
on the original Hub, ends hidden recording, preserves drafts and routes scoped
notifications. Opus 5.5 xhigh reviewed the changing source; primary-agent fixes and
normal-App browser tests cover duplicate IDs, offline and interrupted removal,
share ownership and Web Push scope isolation. Root gate: 232 files / 3,647 passed /
one existing skip; Chromium broad 70 and WebKit broad 69 passed, then overlapping
focused final passes. See review and boundaries（本地材料：`evidence/multiple-hosts-ui-2026-10-04.md`）
and receipts（本地材料：`evidence/multiple-hosts-ui-2026-10-04.json`）. Native multi-host push,
physical-device acceptance and updated installers remain open.

Dual self-review, 2026-10-04: the primary agent and actual Claude Opus 5.5 xhigh
reviewed the program, reproduced connection/sync/queue failures and applied
scoped corrections. Changes cover planned token renewal and foreground HTTP
continuity, Stop during snapshot catch-up, per-conversation Gateway admission,
expired-token outbox recovery, nonblocking command completion, cross-device mute,
late creation receipts, malformed Bot config, native-share target/recipient
pinning and idle cache reads. Root tests passed 232 files / 3,646 cases / one
existing skip; a test-only TypeScript annotation was then corrected and the root
build rerun. Browser and Swift receipts, exact limitations and remaining
performance hypotheses are in the [review disposition](self-review-2026-10-04.md)
and machine evidence（本地材料：`evidence/self-review-2026-10-04.json`）. This is a source and
local-regression result; installed clients and production deployments were not
updated, and native/mobile gates remain open.

Added requirement, 2026-10-03: a computer may run local Bots and simultaneously
control another runtime host; phones may control multiple runtime hosts. The
current r6 client still stores one identity and connection. Actual Opus 5.5 xhigh
review supports independent per-host Hubs with unified Bot/group navigation and
host filtering; it also identified push/deep-link scoping, single-host removal,
idempotent old-cache migration and background lifecycle constraints. The
[design and eight acceptance cases](multiple-runtime-hosts.md) are recorded.
The first program milestone is now implemented (2026-10-04): fixed per-host
cache injection, a persistent host registry and a connection pool. Actual Opus
5.5 xhigh source review exposed concurrency/recovery issues; four were reproduced
against the exact reviewed source before correction. Migration, independent
queues/streams, one-host revocation/removal and same-Hub snapshot staging were
then checked on Chromium and WebKit. The normal App was subsequently switched
to this directory/pool, as recorded above. Native device delivery and cleanup,
updated installers and two-computer/mobile acceptance remain open. Existing
multi-VPS route results do not satisfy this new requirement.

See the review disposition（本地材料：`evidence/multiple-runtime-hosts-foundation-opus55-2026-10-04.md`）
and foundation evidence（本地材料：`evidence/multiple-runtime-hosts-foundation-2026-10-04.json`）.

Stop/continue continuity and stable Send targets (2026-10-03): the real-CLI
matrix now covers two queued follow-ups and an immediate post-stop follow-up,
for five engines on Chromium and WebKit (**20 passed / 50 native prompt
submissions**). Different response prefixes verify the queued inputs were not
swapped or repeated. All cases preserve the native session, exact story title,
stopped card and reload-without-replay behavior. Native cancellation/exit took
**10–796 ms**, visible interruption **21–70 ms**, and immediate follow-up Hub
acceptance **54–91 ms** in these local samples.

The matrix exposed a real WebKit click race: the Send button shrank from Queue
to its idle state while the click was in progress, leaving the draft unsent.
The fixed button preserves its hit target; narrow phone controls fit at 320 px.
Controlled regressions reproduce the original failure and verify a single
submission when either paired device stops the other. Effort, steering and
group/topic checks passed too; one combined WebKit run emitted a `/health`
browser diagnostic during reload, and its focused steering recheck passed.
This diagnostic is retained, not hidden by a test filter or claimed as a
connection-code fix. The root gate passed 231 files / 3,629 tests / one existing
skip and build. Continuity evidence（本地材料：`evidence/native-stop-continuity-2026-10-03.json`）,
click-race reproduction（本地材料：`evidence/native-stop-click-2026-10-03.json`）.

The r6 universal development DMG（本地材料：`evidence/macos-r6-2026-10-03.json`） includes the
fix. Both architectures, strict ad-hoc seals, read-only mounted contents, image
integrity and Downloads copy were verified; all 95 web files match browser
inputs and both mobile resource copies. This requires matching Hub code and
does not bundle/deploy it. Native Mac interaction remains blocked by the locked
screen; phone, signing, publication and other original acceptance gates remain
open.

Real CLI stop latency (2026-10-03): a measured Claude exit of 1,523 ms exposed
the gap between the interrupted card and native process cleanup. Explicit App
stops now give Claude and both Antigravity paths a 650 ms SIGTERM grace before
the existing identity-checked escalation; other cancellation policies stay at
their existing defaults. Final normal-writing acceptance passed **7 Chromium +
7 WebKit cases**, including five real CLIs per browser, paired-device effort
scope/conflicts, and group stop/queue/topic isolation. Native cancellation
receipts or CLI exits took **11–710 ms**; visible interruption took **18–41 ms**.
All ten native samples resumed the same session and recalled the exact story
title. The test-only observer does not inject native results. Earlier
thinking-marker ambiguity and a Kimi counting-prompt refusal are retained as
fixture limitations, not relabeled as production fixes. Focused tests passed
162 cases; the required hook passed **231 files / 3,629 passed / 1 skipped** and
the root build. No native-device, provider billing-stop or public-route claim.
[Contract and measurement boundaries](native-stop.md),
receipts, source hashes and screenshots（本地材料：`evidence/native-stop-2026-10-03.json`）.

Offline device revocation (2026-10-03): a device revoked while disconnected now
receives a nonce-bound, Hub-signed denial on reconnect. The client verifies the
paired key/device and dedicated signing domain before stopping transport and
persisting the recovery reason. Cached history remains readable; pending outbox
messages stay unsent; other trusted devices continue working. Forged notices,
old nonces and authentication-domain signatures cannot persist revocation. A
failed receipt still closes authentication, and rejected handshakes no longer
process queued authentication frames. Actual Opus 5.5 xhigh review led to further
hardening: even a post-ready ordinary notice must reconnect for signed proof,
and closing during handshake cache writes cannot reactivate transport. Its
plaintext-proxy assumption is distinguished from the TLS passthrough design in
the review disposition（本地材料：`evidence/offline-revocation-opus55-2026-10-03.md`）.

Focused tests passed 79 cases. Chromium and WebKit each passed 19 real temporary
Hub browser cases, including Bot effort synchronization, offline revocation,
six invalid-denial variants, a post-ready forged notice, close-during-ready,
pairing, local reset, route switching and resumable downloads. Screenshots were inspected.
The required gate passed **230 files / 3,620 passed / 1 skipped**, followed by the
root build; the client production build also passed. This needs matching updated
Hub/client code and is not native/physical-device or public-route acceptance.
[Contract and limits](offline-revocation.md),
evidence and source hashes（本地材料：`evidence/offline-revocation-2026-10-03.json`）.

Download recovery (2026-10-03): authenticated HTTP ranges and SHA-256 verification
now preserve completed download chunks across reconnect and backup-route changes.
File cards show progress/recovery and permit independent cancellation. Explicit
downloads started while reconnecting wait for the route. Opus 5.5 xhigh reviewed
the implementation; invalid legacy response validators and reconnect-start
handling were tightened, and token/session expiry plus aborted-body regressions
were added. Kimi/Antigravity native extension constraints were documented without
weakening call-origin authorization or changing their working compatibility path.

Chromium and WebKit passed 120 MiB fault-injected downloads with active PWA service
workers, separate desktop/phone contexts, phone offline-start/cancel/retry, idle
switchback, actual file saves and two SHA-256 matches per engine. Download bytes
are held only in the running operation; cancellation, refresh or app termination
discards partial data. This is not public-route or physical/native-device
acceptance. [Contract and limits](resumable-downloads.md), final receipt and
source hashes (local evidence: `evidence/resumable-downloads-2026-10-03.json`), review disposition（本地材料：`evidence/resumable-downloads-opus55-2026-10-03.md`）.
Final required gate passed: 230 files, 3,614 passed / 1 skipped, and build passed
with test worker concurrency capped at four. Focused regressions passed 92 tests;
Chromium passed 17 and WebKit passed five. This does not change the open v1 gates.

Native DeepSeek App tools (2026-10-03): agent-scoped `app_send_file`,
`app_send_batch` and `app_capability` now use dedicated process pipes and exact
native prompt/step/call grants. Known policy/context notices are excluded from
task-origin selection; subagents, goals, stale calls and changed arguments remain
denied. Installation failure can fall back only before the model prompt.

DSH 0.2.0-rc.2 / engine-default model / low passed real UI creation, two captioned
file versions, native worker restart and context continuity, capability lookup,
and an atomic two-file batch. Chromium and WebKit each passed this case plus
Bot-wide effort synchronization/isolation. Eight actual downloads per browser
matched bytes, and three durable receipts were verified. Test processes exited;
the isolated Hub and native history were removed. No physical phone, all-media,
Windows, Linux or public-route acceptance is implied. One earlier concurrent
Chromium run failed after restart before App installation; its detailed cause was
not retained. The final sequential run passed; no speculative cause is asserted.

Actual Opus 5.5 xhigh reviewed the source. Pipe closure, oversized-request
isolation, install rollback, teardown and cancellation fixes are covered by
focused tests. **Required gate: 229 files / 3,605 passed / 1 skipped; build
passed.** [Contract and limits](deepseek-native-app-tools.md),
receipt, screenshots and hashes（本地材料：`evidence/deepseek-native-app-tools-2026-10-03.json`）.

Native Claude App tools (2026-10-03): the existing streaming CLI now hosts
`app_send_file`, `app_send_batch` and `app_capability` over its private SDK MCP
control channel. Foreground identity/arguments and turn lifetime guard delivery;
subagents and detached notifications cannot borrow another conversation's grant.
Existing native sessions resume without context reset or global MCP replacement.
Pre-prompt setup failures can fall back once, scoped to that worker; no automatic
replay after model work. Only actual upload responses refresh inactivity.

Real Claude Code 2.1.287 / sonnet / low passed ten-image/PDF batch reads and atomic
native delivery, exact downloads from independent desktop/phone browser contexts,
worker restart with the same session/context, same-path updated bytes and native
capability lookup. Chromium and WebKit each passed both real cases plus Bot-wide
effort synchronization/isolation. Owned test sessions/processes were cleaned up
and read back. These are not physical-phone, Windows or public-route assertions.

Actual Opus 5.5 xhigh reviewed twice; findings and bounded risks are documented.
Protocol negotiation, phantom approvals, replay, stale channel guidance, setup
fallback scope and inline-file compatibility were addressed. **Final required
gate: 228 files / 3,584 passed / 1 skipped, root build passed.** The first full
run had nine unchanged service test failures; isolated and final full runs passed.
No frontend assets changed for this native integration; matching Hub/Gateway code
is required. [Contract](claude-native-app-tools.md),
receipt and source hashes（本地材料：`evidence/claude-native-app-tools-2026-10-03.json`）,
Opus review disposition（本地材料：`evidence/claude-native-opus55-review-2026-10-03.md`）.

Native Codex batches (2026-10-03): new native threads register `app_send_batch`.
Ten titled images, the original PDF and a readback report can publish atomically
in one message with captions. All paths are checked before upload; interrupted
uploads publish no partial gallery. Batch/member receipts share duplicate and
uncertain-delivery protection with native single-file calls. Known v1 native
threads retain their exact two tools, guidance and context; unknown registrations
use the documented compatibility fallback.

Real Codex CLI 0.160.0 / gpt-6-astra selected the native tool without a tool name
in the user prompt, read every random image/PDF code correctly and delivered
matching bytes to both desktop and phone browser contexts. Chromium and WebKit
passed; the existing real file/restart/capability case also passed. Temporary
sessions were natively archived with read-back. These are browser/native-engine
checks, not physical phone or public-route acceptance. Client assets did not
change; the Hub/Gateway needs the updated code.

Opus 5.5 xhigh reviewed the implementation and a bounded follow-up. Its key finding
was reproduced: batch members collapsed under one message ID during recovery,
causing duplicate delivery or false repair failure. Tracking message/path/hash
fixes both; partial-repair, upload-index and empty-file cases are covered. **642
focused tests passed; final required gate: 227 files / 3,565 passed / 1 skipped,
root build passed.** An intermediate gate had three unchanged AGY/Kimi wait
timeouts; isolated and full reruns passed without production timeout changes.
[Contract and evidence](native-batch-delivery.md),
receipt（本地材料：`evidence/native-batch-2026-10-03.json`）.

Real ten-image/PDF batch (2026-10-03): Claude Code 2.1.287 / sonnet / low received
one captioned message containing ten PNGs and a PDF, read all eleven random codes
correctly, and returned one titled image grid plus the unchanged PDF and a JSON
report. Chromium and WebKit each verified both paired browser contexts: all
twenty cached image hashes, actual PDF/report downloads, titles and responsive
layout. Viewport captures were inspected. This uses compatibility `send.batch`,
not native structured batch tools; physical phones and all-engine coverage remain
open. Native Claude session persistence is disabled for the fixture, and no owned
observer processes remain. [Details](media-batch-acceptance.md),
receipt（本地材料：`evidence/live-media-batch-2026-10-03.json`）.

Validation: Chromium **30.1 s**, WebKit **33.0 s**; opt-out run **1 skipped** with
no model call; card-state lifecycle **9 passed**; required root gate **227 files /
3,552 passed / 1 skipped** and build passed. Early browser failures were verification
method/deadline issues and were repaired without production behavior or CSP changes.
The first root run had a card-state cleanup race and an unrelated five-second
delivery test timeout; queue teardown was repaired, the targeted tests and complete
rerun passed. No new native package or deployment was needed for test-only changes.

Real native App tools (2026-10-03): Codex CLI 0.160.0 / gpt-6-astra autonomously
selected `app_send_file` from ordinary user requests, without naming tools or
legacy markers in the prompts. A real managed-worker restart preserved the
native session, remembered context and persisted tool registration. Two versions
of the same path delivered with captions; both paired browser contexts downloaded
both versions with exact bytes/SHA-256. Native success results, two persisted
receipts and two accepted timeline events agree; no duplicate attachments.
`app_capability(files)` also executed successfully. Scoped native archive and
read-back left no visible test sessions. No production behavior changed for this
acceptance. This does not establish physical-device, other-model/media-type or
other-engine native-tool coverage. Receipt（本地材料：`evidence/native-app-tools-2026-10-03.json`）,
[current plan gate audit](acceptance-gates.md).

Validation: the opt-in live case passed in 48.6 seconds, the ordinary run skipped
without model calls, seven scoped-cleanup tests passed, and the mandatory gate
passed **227 files / 3,552 tests / 1 skipped**, followed by the root build. The
first live attempt failed only in the fixture's asynchronous restart wait after
successful initial delivery; its owned session was also archived and verified.

Paged history search (2026-10-03): search no longer stops at the latest 100
matches. The client reads 50 bounded excerpts per page, supports previous/next
navigation and opens the original message. Timestamp/ID cursors are scoped to
the applied query, filters and user; every page checks current membership and
device trust. Failed pages preserve results, unapplied filters are identified,
and late responses cannot overwrite a new query or reopen a closed panel.

Validation: **54 focused root tests; 9 Chromium and 9 WebKit cases; 227 root
files / 3,551 passed / 1 skipped; root and client builds passed**. Desktop/phone
fixtures traverse 125 matches, retry a failed page and navigate to old messages.
On 30,000 synthetic local records, broad first/second/third pages took 97.7–99.4 ms
and each response was 24,979 bytes. A separate 125-long-answer fixture returned
an 18,697-byte first page in 78.5 ms, with a concurrent write completing in 0.7 ms.
These measurements do not prove public-route or native-device performance.
The new paged endpoint requires an updated Hub; the legacy full-message endpoint
remains available for old clients. No live Hub or Bot fleet was restarted.
[Behavior and limits](history-search.md),
receipt（本地材料：`evidence/search-pages-2026-10-03.json`）.

The `20261003-r4` universal macOS development DMG contains the new client.
Both architectures, strict ad-hoc signature verification, read-only mounted
file comparison, DMG verification and the Downloads copy hash passed. All 95
frontend files match the Android/iOS asset copies. The desktop shell does not
bundle the Hub; deploy matching Hub code when deployment resumes. Native runtime
and production distribution remain unverified.

Unsubmitted native-question drafts (2026-10-03): switching conversations or
reloading now restores choices, custom text and the current question. Drafts
remain local to each device and never submit themselves. The cache orders
writes, checks the Hub/device identity and matching form, and prunes obsolete
drafts on message changes and atomic snapshots. Pending outbox answers are read
before unlocking controls so recovery cannot create a second submission.

Validation: **17 Chromium and 17 WebKit cases passed; 227 root files / 3,542
passed / 1 skipped; root and client builds passed**. The first full root run had
one Tingwu SIGTERM timeout; all three Tingwu cases passed in isolation and the
full gate then passed without source changes. The timeout's cause was not
established. The browser fixtures use real Hub/Gateway handlers and IndexedDB,
without paid model sessions. Both mobile shells' 95 copied frontend files match
the rebuilt web assets; this does not certify native mobile builds or runtime.
See [behavior and boundaries](native-question-experience.md) and
evidence（本地材料：`evidence/question-drafts-2026-10-03.json`）.

The `20261003-r3` universal macOS development DMG includes these frontend
changes. Both architectures compiled; standalone and read-only mounted apps
passed strict signature verification and matched file-for-file. DMG verification
and the Downloads copy hash also passed. This is an ad-hoc sealed development
bundle, not a notarized release. Native launch/performance acceptance remains
pending manual Mac unlock; no live fleet was restarted.

Management admission after waits (2026-10-03): nine initial HTTP regressions
reproduced side effects after revocation despite an eventual error response.
Bot creation, managed restart, file scan/label/reveal and Google export now
validate after their queue, preparation, receipt, root-reading or OAuth waits.
Rejected restart attempts retain usable retry keys. Inert Bot preparation files
are bound to their original specification without deleting workspaces. Previously
admitted Bot launches/document exports preserve their durable completion records.

Validation: **18 new cases; 9 focused files / 76 passed; 8 Chromium and 8 WebKit
browser cases passed; 227 root files / 3,542 passed / 1 skipped; TypeScript and
relay build passed**. Browser coverage includes independent desktop/phone
contexts, Bot creation, effort isolation/sync, collaboration, file labels and
managed restart recovery. Real transport/fixture workers are used without paid
model sessions, actual Finder dispatch or Google API requests. Frontend/native
assets are unchanged and the live fleet was not restarted. This is progress on
the security gate, not completion of the full plan or all authorization matrices.
See [scope](control-revocation.md) and
evidence（本地材料：`evidence/control-revocation-2026-10-03.json`）.

Realtime device revocation (2026-10-03): three real-transport regressions exposed
a queued chat write, a queued card approval, and a delayed private Bot result
surviving device revocation. Network-originated conversation/message/action writes
now validate the actor inside their write transaction, and private socket output
rechecks trust before enqueueing data. Stop retains its independent path while
rechecking its target before dispatch. Known revocation fences pending sends;
another trusted device's accepted work and idempotent delivery remain intact.

Validation: **18 new transport cases; 5 focused files / 60 passed; 96 Chromium
passed / 10 opt-in skipped; 86 WebKit passed / 1 opt-in skipped; 226 root files /
3,524 passed / 1 skipped; TypeScript and relay build passed**. No paid native
engine sessions were invoked. On synthetic local fixtures, stopping while a
5,000-task dashboard refreshed took 83 ms in Chromium and 81 ms in WebKit.
The 5,000-line Chromium render and both browsers' stream/snapshot recovery passed.

The broad WebKit upload recovery case took 25.4 s versus 12.9 s in the previous
milestone, so phase timing was added to its fixture. A focused rerun passed in
13.2 s: injected failure to fallback-visible was 2.052 s, and the fixture held
the recovered upload deliberately for 6.5 s. The earlier longer total has no
phase trace, so its cause is not established; do not interpret either total as
raw file throughput or a public-route/native-device guarantee. Source and detailed
receipts: [realtime boundary](socket-revocation.md),
evidence（本地材料：`evidence/socket-revocation-2026-10-03.json`）.
The frontend/native shells are unchanged; no live fleet deployment or restart
was performed. Existing committed work and already queued network bytes are not
recalled. Other service waiting windows and full role/grant-change acceptance
remain separate work.

HTTP revocation during active requests (2026-10-03): two integration cases first
reproduced a revoked device successfully approving another device and writing an
upload chunk after initial header authentication. Requests now recheck trust at
body receipt, guarded queue entries, pairing/revocation transactions and private
response release. Attachment streams abort on revocation, including changes from
a separate CLI detected by the identity sweep. Self-revocation still returns its
successful acknowledgment; another trusted device can download intact bytes.

Validation: **10 new integration cases; 8 focused files / 73 passed; 96 Chromium
passed / 10 opt-in skipped; 86 WebKit passed / 1 opt-in skipped; 225 root files /
3,506 passed / 1 skipped; TypeScript and relay build passed**. Browser regression
includes effort scope, independent desktop/phone settings synchronization,
conflict protection and other-Bot isolation. No paid model sessions were invoked.
The frontend/native shells are unchanged in this milestone, so the existing r2
Mac development bundle remains current for the client; this Hub change has not
been deployed to the live fleet. Already received data and previously admitted
side effects are not rolled back. [Scope](http-revocation.md),
receipt（本地材料：`evidence/http-revocation-2026-10-03.json`）.

Large-state dashboard and file inventory (2026-10-03): 5,000 scheduled tasks
previously blocked the Gateway event loop for 787 ms. Batched validation and
per-read schedule reuse reduce the measured maximum gap to 11 ms (818 → 232 ms
total read). The task view searches the full result, pages 25 visible records and
mounts history only on expansion. Paired Chromium/WebKit clients can stop a task
while refreshing that large overview in 79 / 66 ms, then continue chatting with
no duplicate engine calls. File cancellation now also stops root enumeration and
closes its directory handle; an isolated 10,000-file / 2,000-unit inventory scan
completed in 166 ms with an 11 ms maximum event-loop gap.

Validation: **4 Chromium + 4 WebKit focused cases; 224 root files / 3,496 passed /
1 skipped; root/client builds passed**. Android/iOS copied frontend files match
`client/dist`. These synthetic local measurements do not certify public-route or
native-device performance. [Details and scope](dashboard-scale.md),
receipt（本地材料：`evidence/dashboard-scale-2026-10-03.json`）.

The universal Mac development DMG was then rebuilt with these UI changes.
Both architectures passed strict signature verification; the read-only mounted
bundle and the Downloads `20261003-r2` copy match the verified files. It is still
locally ad-hoc sealed and not notarized or published. Updated bundle receipt（本地材料：`evidence/macos-dashboard-scale-2026-10-03.json`）.

Universal Mac development bundle (2026-10-03): both Apple Silicon and Intel
optimized targets compiled successfully with the locked Rust dependencies.
The combined executable contains `arm64` and `x86_64`; both target macOS 13.0.
The app and DMG have a local ad-hoc integrity signature, without Developer ID,
notarization or an update feed. Strict signature verification for every
architecture, DMG verification, a read-only mount and full embedded-bundle hash
comparison passed. The development DMG is copied to Downloads. Root regression
again passed **224 files / 3,493 tests / 1 skipped**, with the root/client builds.

The computer is locked and the UI controller cannot unlock it, so this bundle
has not undergone a new native launch/interaction check. Native cold-start and
whole-app memory budgets, Intel hardware behavior and signed distribution remain
open. The local signature is not a notarization or production release claim.
[Build procedure](macos-build.md), exact bundle receipt（本地材料：`evidence/macos-universal-2026-10-03.json`）.

Android Back navigation follow-up (2026-10-03): a native Capacitor listener now
uses the actual UI hierarchy instead of WebView history. Nested dialogs/previews
close first; settings and file/operation details return to their parent; chat
returns to the list before backgrounding. Busy effort/file saves and unsaved
settings retain their protection. Closing the share inbox now preserves unsent
text/recipient edits and active transfers. Recording Back creates an unsent audio
draft, and pending permission cancellation releases late microphone access.

Validation: **18 Chromium + 18 WebKit focused cases passed**, including Bot-wide
effort synchronization and isolation; **224 root files / 3,493 passed / 1 skipped**,
root/client builds passed. Android/iOS assets were synced after validation.
Physical Android Back/gesture/IME and native lifecycle acceptance remain open;
SDK license consent is still pending. No SDK license acceptance, deployment or
paid model sessions occurred. [Behavior and boundaries](native-back-navigation.md),
sanitized receipt（本地材料：`evidence/native-back-2026-10-03.json`）.

Program regression and recovery (2026-10-03): the chat-header effort picker uses
the original Bot-wide setting; same-Bot conversations/devices share it, other
Bots remain independent, and concurrent edits cannot silently overwrite each
other. Native level names are filtered by engine/model rather than mapped to a
universal scale. See [effort settings](effort-settings.md).

Full browser regression found and fixed two connection issues. A single recovered
Hub was unnecessarily excluded by its five-second route cooldown; reconnect can
now retry a health/key-verified cooldown route when no healthy alternative exists,
while normal preference switchback retains its cooldown and idle guards. A socket
close could also reconnect before a queued authenticated revocation finished
behind local cache writes. Close now drains received frames first. A 200 ms slow
storage fixture fails before that fix and passes after it, preserving history,
the revocation reason and the no-reconnect rule after reload.

Final gates: **224 root test files, 3,493 passed / 1 skipped; root/client builds;
92 Chromium passed / 10 opt-in skipped; 82 WebKit passed / 1 opt-in skipped**.
Single-route post-restart recovery measured **292 ms / 405 ms** in Chromium/WebKit.
Local blackhole/multi-route failovers remained below 3 seconds (1,293–2,298 ms
Chromium; 1,319–1,805 ms WebKit). These browser flows use synthetic engine replies;
they do not re-certify paid native CLIs or public mobile/VPS latency. The arm64
macOS development `.app` and DMG were rebuilt, and Android/iOS assets synced.
New native-container execution was not performed in this audit.

Android build preparation now has a checksum-verified portable JDK 21 and working
Gradle project/dependency preflight on an external disk. SDK license consent is
pending, so Android compilation and APK/device acceptance remain open.
Sanitized receipt（本地材料：`evidence/program-regression-2026-10-03.json`）,
[Android build guide](android-build.md).

Native Mac and handshake follow-up (2026-10-02): previous system-key cleanup
completed, and the actual macOS arm64 debug app paired to the isolated demo Hub.
Native Open/Save panels, caption plus file in one message, both sync directions
and immediate remote revocation were exercised. The saved file and both server
blobs match exactly (96 bytes, SHA-256 recorded). Native restart exposed a lost
revocation reason; a separate regression also reproduced accepting forged `ready`
before a signed challenge. The client now enforces handshake order and persists
only authenticated, identity-bound revocation, preserving history and preventing
reconnect on reload. **8 Chromium + 8 WebKit** cases pass, including forged
notices, reset fencing, pairing and route failover. The full gate passes with
**3,469 passed, 1 skipped, 222 files**; root/client builds pass. The fixed arm64 debug bundle
builds and has now passed actual native re-pairing, remote revocation, complete
process exit and relaunch. The revocation reason and latest cached test message
remain visible after restart. Native startup/memory budgets and other platform
containers remain open. The native
smoke used a demo engine; genuine CLI evidence is separate.
Receipt and exact boundaries（本地材料：`evidence/native-macos-and-handshake-2026-10-02.json`）,
native attachment（本地材料：`screenshots/native-macos/attachment-sync.png`）,
native reverse sync（本地材料：`screenshots/native-macos/reverse-sync.png`）.

Mixed-engine Crew (2026-10-02): five real native CLIs—Codex coordinator, Claude
researcher, Kimi analyst, DeepSeek writer and Antigravity reviewer—completed one
configured group workflow. Reciprocal permissions, role mapping, group creation
and recipient selection went through the App UI. A paired phone browser stopped
a running research stage; the next run completed all five stages with a passing
review and the same report on both clients. Each specialist has a successful
native Bus audit receipt, with no group chat session binding created for the
peer task. The opt-in scenario passed in 1.2 minutes and used scoped native
Codex-history cleanup. This covers one constrained synthetic workflow, not every
revision, model permutation, external peer or native mobile container.
Receipt（本地材料：`evidence/live-mixed-crew-2026-10-02.json`）,
desktop（本地材料：`screenshots/live-crew/crew-desktop.png`）,
phone browser（本地材料：`screenshots/live-crew/crew-phone.png`）.

Acceptance history cleanup (2026-10-02): 62 ended real-Codex fixture sessions
were found in shared native history and archived through the Codex app API.
The six live fixtures now archive only their own temporary workspace sessions
after workers stop, using native protocol operations and a read-back check.
Focused safety tests and a real CLI cleanup probe passed without a new model
turn; all six updated browser fixtures are discoverable. Full gate: **3,427
passed, 1 skipped, 220 files**, root build passed. This is post-test archival;
an active test can still be visible, and forced runner termination can skip
teardown. [Cause, guardrails and verification](acceptance-session-cleanup.md).

Native question UI (2026-10-02): engine `AskUserQuestion`, Codex native input and
standard MCP forms now share visible option rows, descriptions, single/multiple
selection, custom answers and multi-question navigation. Required/min/max checks,
duplicate-submit locking, truthful queue states and failed-answer reload/retry
use the existing authenticated callback and durable outbox. Answer/stop resolves
the controls across devices. Unsubmitted drafts remain page-local; legacy async
choice cards are a separate path. Root gate: **3,421 passed, 1 skipped, 219 files**;
root/client builds passed. Browser checks: **10 Chromium + 10 WebKit**, with a
final Chromium question rerun after UI corrections. Real **Codex CLI 0.160.0**
passed native questions, MCP forms, two-device exact downloads and cancellation
in **1.2 minutes**. [Details, screenshots and boundaries](native-question-experience.md),
real CLI receipt（本地材料：`evidence/native-question-live-codex-2026-10-02.json`）.

Settings reliability follow-up (2026-10-02): local disconnect now persists a
reset marker and cache generation before restarting into isolated cleanup.
Failures retain the identity/key reference for retry; final purge is atomic and
old-page/delayed writes are fenced after re-pairing. Native push/key cleanup now
checks results, and WebKit notification capability/focus boundaries are handled.
Final validation: **3,414 passed, 1 skipped, 218 files**, root/client builds;
**17 Chromium + 17 WebKit** settings, reset, routing, offline, topic, snapshot and
stream cases. Native plugin/device acceptance remains open, including Android
compilation (no Java runtime on this host). [Report, screenshots and evidence](settings-reset-recovery.md).

Settings UI review (2026-10-02): two actual Claude Opus 5.5 xhigh rounds,
four settings categories, desktop two-column dialog, full-screen phone category
navigation, simplified pairing, saved-route vs draft editing, and separate device
security controls. Draft preservation, cancel/save, repeated Escape, nested scanner
close and English/mobile rendering were exercised in the Codex in-app browser.
Final root gate: 3409 passed, 1 skipped across 217 files; root/client builds pass.
The adapted browser regression scripts passed syntax checks, but Chromium/WebKit
automation was not rerun in this UI review. Native camera, Android back and
native cleanup fault injection remain pending. [Review and screenshots](settings-ui-review.md),
model receipts and validation（本地材料：`evidence/settings-opus55-review.json`）.

Runtime host placement and VPS direct access (2026-10-02): pairing and connection
settings distinguish a computer host, VPS host with direct HTTPS, and VPS host
behind separate relays. Each choice explains where Bots, workspaces, memory and
history live, shows a connection path, and makes Tailscale optional. The choice
is a device-local description of an existing deployment, not a provisioning or
migration action. Connection QR codes carry the choice; legacy codes remain
readable without guessing runtime placement from a VPS address. Bot creation
now explicitly requests a path and CLI installation on the runtime host.

The Hub supports per-listener opt-in `exposure: "public"` with mandatory TLS.
Default private bind restrictions remain. Public listeners cannot access worker
HTTP/WebSocket APIs even when the peer is loopback; trusted-device approval,
signed challenges, owner checks, short-lived tokens and revocation are unchanged.
Generic `Direct` routes coexist with legacy Tailscale names and ordered VPS
fallbacks. A second runtime Hub is not a route backup. No data migration, runtime
replication, offline relay file cache or actual VPS deployment is included.
[Role explanation, Ubuntu examples and operational limits](host-deployment.md).

Verification: focused backend 38/38, full root gate **3409 passed / 1 skipped in
217 files** plus root production build. Client translation/type/Vite build passed.
Chromium and WebKit each passed six distinct deployment/routing/QR cases, plus
two Bot/group creation cases. The deployment case uses real HTTPS and separate
mTLS relay sockets: desktop direct + phone relay share one authenticated Hub,
one Bot invocation and the same reply. It verifies QR transfer, reload persistence,
missing-address rejection, clearing a deployment description, English labels,
unknown HTTP access denial and TLS worker API isolation. Root tests separately
verify no implicit public/plaintext bind, per-listener opt-in and worker WebSocket
rejection. Both JSON deployment examples pass the actual Hub config schema and
relay-target validation. Screenshots were inspected on desktop and 390px phone.

Initial Chromium reload raced the IndexedDB save; the test now waits for the
visible saved receipt. Production UI now displays Saving during persistence.
The initial root build found a WebSocket test-options excess-property typing
issue; an inferred options variable preserves verified SNI behavior and the
complete gate was rerun successfully. After that gate, only Bot creation wording
and its translations changed; its client build and both browser creation suites
passed. Evidence/log paths: `evidence/host-deployment.json`.

These are local TLS/network/browser checks with a synthetic engine reply, not
Ubuntu cloud, native shell, provider login, public certificate or network-SLA
acceptance. Deployment continues to be deferred.

Multiple VPS primary/backup routes (2026-10-02): clients support one optional
Direct/Tailscale origin and an ordered list of up to eight VPS origins. Pairing
and Settings include names, add/remove/reorder controls, current route and recent
health/identity status. Pairing probes available routes and can start on a backup;
QR codes retain the complete ordered list. Route preferences are device-local,
so already-paired devices must each add their backups. No server-wide automatic
route distribution is claimed.

Each endpoint has an independent socket-failure cooldown. Reconnection verifies
the same pinned Hub key and reuses durable event/message/upload receipts. Three
healthy preference probes and an idle boundary guard switchback; active turns,
outbox work and uploads hold off optional return. Saving a list that still contains
the healthy current route does not forcibly disconnect it. Invalid origins,
duplicate addresses and wrong Hub identities are rejected with visible feedback.

Mac Hub `relays` starts independent warm mTLS tunnels, retains compatibility with
singular `relay`, validates every loopback TLS target and exposes per-server plus
aggregate status. Every VPS uses its own existing Debian/Ubuntu deployment file,
credentials and receipt. Route monitoring distinguishes same-kind VPS outages.
Full backup now reports relative certificate dependencies for every tunnel, as
well as its existing absolute-path inventory. [Configuration and scope](relay-deployment.md#multiple-primary-and-backup-vps-relays).

Final full completion hook passed **3,406 tests, 1 skipped, 217 files**, plus root
production build (`/tmp/t/tarocub-multi-vps-complete-root-final.log`). Client
translation/type/production build passed
(`/tmp/t/tarocub-multi-vps-client-build.log`). Focused transport/config/monitor
checks passed 21 tests; full-state backup passed 16, including the new relative
backup-certificate inventory. Two real local TLS relay listeners stayed connected
to one Hub; shutting down and restarting the primary left the backup working.

Browser acceptance passed **6 Chromium + 6 WebKit distinct cases**
(`/tmp/t/tarocub-multi-vps-{chromium,webkit}.log`). The final invalid-URL guard and
save-status change were rechecked in 2/2 cases on each engine
(`tarocub-multi-vps-validation-{chromium,webkit}.log` in `/tmp/t`). Tests cover:
three VPS paths with two successive WebSocket blackholes on desktop and phone;
one native bridge turn and no duplicated final reply; stable idle return; legacy
direct/VPS failover; pairing while the primary is unavailable; wrong-Hub rejection;
route editing/reordering/reload; complete named-route QR scanning; and an actual
120 MiB file losing a chunk receipt on the primary VPS, resuming on the backup
without resending stored chunks, matching its full hash, and delaying switchback
until upload completion. Initial fixture failures were an unallowed CORS origin
on the wrong-Hub server and comparing JSON property order; both were fixed before
final acceptance. The new invalid-URL regression also avoids an uncaught URL
constructor error. Desktop and phone screenshots were inspected; the retained
phone settings capture（本地材料：`screenshots/multi-vps-phone-settings-webkit.png`） shows
reordering a named former backup into the primary position.

These are local network/TLS/browser acceptance results, not an Internet failover
SLA, native-container acceptance or a deployed cloud service. Mac mini/Hub/home
network availability remains a common dependency. No VPS was deployed and no live
fleet was restarted. `src/telegram/` and the original checkout remain unchanged;
`git diff --check` passes.

Shared avatars (2026-10-02): personal avatars are editable in Settings; Bot
avatars in conversation quick settings or the instance status panel; root-group
avatars in conversation settings. Topics inherit their parent group's avatar.
The shared editor supports choosing an image, drag/slider crop preview, replacing,
removing and cancelling, with explicit conflict recovery for concurrent devices.
Sidebar, conversation title, personal settings and message pictures use the same
revisioned Hub data. Offline cached avatars survive reload. Read/write permissions
follow device trust and user/Bot/group access; original photo metadata is stripped.
SQLite schema 10 includes avatar bytes in database and full-state backups.

Avatar transport/storage/security/backup checks and the full completion hook
passed **3,402 tests, 1 skipped, 216 files**, plus the root production build
(`/tmp/t/tarocub-avatars-complete-root.log`). Client translation/type/production
build passed (`/tmp/t/tarocub-avatars-client-build.log`). Avatar, creation, topic and
operations regressions passed **7 Chromium + 7 WebKit cases**
(`/tmp/t/tarocub-avatars-{chromium,webkit}.log`). The avatar cases cover both
message/sidebar/title rendering and actual decoded 256px images, cropped pixels,
all three avatar kinds in both directions, cancellation, rejection of SVG,
concurrent edits, replacement/removal, inherited topics, stopped-Hub offline
reload, restart/reconnect and nested editor Escape handling.

Desktop（本地材料：`screenshots/avatars-desktop-chromium.png`）,
phone（本地材料：`screenshots/avatars-phone-chromium.png`） and
phone crop editor（本地材料：`screenshots/avatar-crop-phone-webkit.png`） were visually
inspected. The first test pass exposed duplicate accessible labels and a test
calling a nonexistent topic helper; these were corrected. Canvas interpolation
is compared with a one-channel-unit tolerance across engines. WebKit's synthetic
offline flag again produced a harness navigation error, so final offline acceptance
stops and restarts the real Hub, matching the existing offline-worker acceptance.
These results cover browser engines and phone-sized layouts, not signed native
containers or production deployment. No deployment or live fleet restart occurred;
`src/telegram/` is unchanged, the original checkout remains clean, and
`git diff --check` passes.

Opus 5.5 xhigh review and optimization (2026-10-02): four read-only Claude
CLI review/discussion rounds returned `claude-opus-5-5`; all requests explicitly
used `--effort xhigh`. The primary agent verified and implemented the findings,
then the fourth round found no additional confirmed P1/P2 side effects in scope.
The [review and decisions](opus55-review.md) and model receipt（本地材料：`evidence/opus55-review.json`）
distinguish confirmed defects, rejected unsafe alternatives and remaining limits.

Fixes cover failed-binding recovery with owner/CAS clear and one truthful error
reply, Claude detach from an initially empty destination, the incorrect /new
button, stale hidden session selections, missing/truncated attachment errors,
bounded durable outbox retries and the active-turn steering bypass. Failed card
actions are visible and removable too, so they cannot invisibly block a conversation.
Multi-Bot controls target one named Bot and align the composer recipient; sidebar
status updates retain order, and group presence reflects any online member.

Final root completion hook: **3,398 passed, 1 skipped, 215 files**, plus production
build, in `/tmp/t/tarocub-opus55-review-k0t59dgi/complete-root.log`. Client translation,
type and production build passed (`client-build-outbox-final.log` in that directory).
Creation, native commands, cross-device behavior and recovery/outbox acceptance
passed **10 Chromium + 10 WebKit distinct cases**; the final strengthened recovery
suite passed 3/3 in each (`outbox-{chromium,webkit}-final.log`).

Real-model UI acceptance passed **2/2 in 1.7 minutes** (`live-final.log`): Claude
empty-destination binding/detach/reload/context isolation (22 seconds), and Codex
workspace/persona/explicit memory/group isolation/resume/detach/reset/two-device
continuity (1.3 minutes). Claude receipt（本地材料：`evidence/live-claude-binding.json`）,
Codex receipt（本地材料：`evidence/opus55-live-session-model.json`）. The subsequent code change
only separated corrupt-receipt errors from temporary I/O errors; its fault-injection
regression and the final full gate passed. This is browser plus native-model
acceptance, not signed desktop/mobile-container or production deployment acceptance.

Initial review test runs exposed a wrong error-helper import and a fixture missing
its Bot grant; those were corrected before final verification. A longer multi-turn
socket/session test exceeded its default five-second budget under concurrent load,
so it has a bounded 20-second budget. An exact-label browser locator required an
explicit accessible name. All affected cases passed subsequently. The final
captures were inspected, `git diff --check` passed, the original repository is
clean, and `src/telegram/` is unchanged. No fleet restart or deployment occurred.

Bot/group identity and native session alignment (2026-10-02): the sidebar now
shows Bots as primary entries with their private conversations beneath them,
and groups with their topics. Clicking a Bot reopens its existing private
conversation; its plus button explicitly creates another. The separate bottom
instance list was removed. New groups continue to select existing Bots without
repeating model/effort setup. The [session and memory model](session-model.md)
distinguishes a Bot instance from each conversation's native CLI session,
persistent workspace files from automatic memory loading, and new managed Bots
from attaching an existing configured instance. There is no dedicated App editor
for agent.md or memory files yet.

The audit reproduced a binding replay defect: previously a saved UI selection
could overwrite the effect of /detach, /reset or a later /resume on subsequent
messages. Hub schema 9 gives each explicit selection a new binding ID. The
Gateway applies it once within the ordinary authorized conversation queue,
persists a receipt, and preserves the destination's own suspended session.
Tests cover reconnect, explicit reselection, native resume, detach, reset,
selection during an active turn, corrupt/interrupted receipts and conservative
legacy handling. The panel adds a detach action and labels the stored selection
as the most recently selected binding rather than claiming it is live state.

The root completion hook passed **3,388 tests, 1 skipped, 215 files** and build
(`/tmp/t/tarocub-session-model-complete-root.log`). Client translations, types and
production build passed (`/tmp/t/tarocub-session-model-client-build.log`).
Creation, group/topic navigation, native command parity and cross-device browser
regressions passed **9 Chromium + 9 WebKit cases**
(`/tmp/t/tarocub-session-model-{chromium,webkit}.log`). These browser contexts
are not native desktop/mobile container acceptance.

An isolated real Codex run then passed in **1.1 minutes**
(`/tmp/t/tarocub-live-session-model-final.log`). Through the App UI and two
paired browser contexts it verified: an instance agent.md persona, explicit
MEMORY.md reads in the configured workspace, fresh group context excluding a
private-session nonce, UI binding recovering that nonce, phone detach restoring
the group's prior session, reload without rebinding, native /resume recovery,
/reset creating fresh context, unchanged memory-file contents and the same final
message on both devices. This proves explicit file reuse, not automatic memory
injection across all engines. Receipt（本地材料：`evidence/live-session-model.json`）,
desktop（本地材料：`screenshots/session-model-desktop.png`）,
phone sidebar（本地材料：`screenshots/session-model-phone.png`）,
phone conversation（本地材料：`screenshots/session-model-phone-chat.png`）.

The first live attempt timed out because its script typed before the newly
created group became selected; waiting for the selected conversation heading
fixed that test race. The unchanged session implementation then passed in
54.9 seconds. Capture inspection additionally found a stale slash-command menu
after sending. Suggestions now render only for the current slash-prefix draft.
The final client translation/type/build and focused command regression passed
on Chromium and WebKit, including empty-draft menu dismissal on both viewports
(`/tmp/t/tarocub-session-model-client-final.log`,
`/tmp/t/tarocub-session-model-command-final-{chromium,webkit}.log`). The final
real run above includes this presentation fix; all three retained captures were
visually inspected. `git diff --check` passed. The original repository is clean
and this branch has no changes under `src/telegram/`.

Readable collaboration operations (2026-10-02): the composer now opens a shared
desktop/phone form for ask, parallel questions, ordered stages and verification.
Users choose the initiating Bot and target by name; duplicate names receive
stable ID suffixes. The operation still sends the original native command through
the ordinary outbox, mentioning only the selected initiating Bot. Managed targets
are checked against the saved ACL, reciprocal permission and reachable listener;
refreshing revoked permission disables sending without losing the task draft.
The same dialog links directly to that Bot's collaboration settings.

Known managed Bot IDs in prose and ordinary message previews have readable
labels. Code blocks, inline code, links, paths, math and stored/copied/forwarded
source are preserved. An identity-checked local name cache supports offline
reading and is cleared when forgetting the Hub. This is presentation metadata,
not a change to native routing or authorization. Three focused unit tests and
the client translation/type/production build passed. The 11-case Chromium
regression passed, covering creation, collaboration, Markdown and startup
(`/tmp/t/tarocub-bot-names-chromium.log`). WebKit passed the other ten cases;
its new offline case initially hit the known synthetic-offline navigation error.
That case now stops the real Hub and reloads the cached App on both engines.
The first revised WebKit run exceeded the existing five-second completion poll
during a busy-host run; an unchanged rerun passed in 5.8 seconds, and Chromium
passed in 4.3 seconds. No timeout was relaxed. Final focused logs are
`/tmp/t/tarocub-delegation-offline-{webkit-retry,chromium}.log`.
The inspected desktop picker（本地材料：`screenshots/delegation-picker-desktop.png`）,
phone picker（本地材料：`screenshots/delegation-picker-phone.png`） and
offline phone（本地材料：`screenshots/delegation-phone-offline.png`） captures are retained.
Browser clipboard interception verifies exact copied text, not OS clipboard
integration; browser viewports do not replace native-container acceptance.
The final root completion hook passed **3,383 tests, 1 skipped, 214 files** and
build (`/tmp/t/tarocub-bot-names-complete-root.log`). The original repository is
clean and the client branch has no changes under `src/telegram/`.

The real three-Codex case passed in **1.3 minutes**
(`/tmp/t/tarocub-live-bus-friendly.log`). Both peer configuration and all workflow
launches used the App UI. It verified dual-device results, only the selected
initiator publishing answers, native peer execution with no bound chat session,
streaming before phone cancellation, an interrupted peer timeline and a successful
subsequent delegation. Receipt（本地材料：`evidence/live-bus-friendly.json`）,
desktop（本地材料：`screenshots/live-bus-friendly-desktop.png`）,
phone（本地材料：`screenshots/live-bus-friendly-phone.png`）. Inspection of those captures
identified a remaining raw ID in the sidebar excerpt; the subsequent presentation
fix applies the same conservative name preview there. Previews containing code
markers retain their literal source rather than relabeling code. The captures
above precede that sidebar-only follow-up. Full multi-engine Crew and native
containers remain unverified by this case.
The final client translation/type/production build and the sidebar follow-up's
creation/delegation regression passed **3 Chromium + 3 WebKit cases**
(`/tmp/t/tarocub-bot-names-client-final.log`,
`/tmp/t/tarocub-bot-names-final-{chromium,webkit}.log`). Those include actual
Hub shutdown, cached reload, identity clearing and both sidebars' readable
collaboration excerpts. `git diff --check` passed.

Managed collaboration UI (2026-10-02): Operations → collaboration settings now
edits native Bus ACLs, parallel targets, ordered chain stages, verifier and the
five distinct research-crew roles. It shows reciprocal permission and listener
reachability, explains the automatic plain-text Crew trigger, and provides the
existing idle-restart operation. Saving does not restart a busy worker. Listener
reachability is explicitly not proof that every newly saved setting is effective.
Only Hub-owned Bots are edited; external fleet configuration remains outside this
editor. Native config writes share the existing mutex, preserve unrelated fields
and secrets, reject unreadable settings, and use revisions to prevent stale-device
writes and ABA conflicts. Owner role and device trust are checked again at commit.
No Bus secret reaches either client. Dirty-state navigation and conflict recovery
are exercised on paired desktop/phone browser contexts.

The root completion hook passed **3,380 tests, 1 skipped, 213 files** and build
(`/tmp/t/tarocub-collaboration-complete-root.log`). Seven new configuration tests
include HTTP owner/device enforcement, revocation, unknown-field preservation,
concurrent native model edits and corrupted-config refusal. Client translations,
types and production build passed. Final collaboration + managed-restart browser
regression passed **2 Chromium + 2 WebKit cases**
(`/tmp/t/tarocub-collaboration-final-{chromium,webkit}.log`). These start real
isolated Gateway processes and native Bus listeners without model calls. The
inspected desktop（本地材料：`screenshots/collaboration-desktop.png`） and
phone（本地材料：`screenshots/collaboration-phone.png`） captures are retained.

The updated opt-in **real Codex Bus** case also passed in **1.1 minutes**
(`/tmp/t/tarocub-live-bus-ui.log`). All three peer ACLs and the coordinator's
fan/chain/verifier settings were configured through the App; it then verified
ask/fan/chain/verify, dual-device results, ephemeral peer sessions, native streaming
before phone cancellation, the peer's interrupted timeline and a successful new
delegation. Receipt（本地材料：`evidence/live-bus-ui.json`）,
desktop（本地材料：`screenshots/live-bus-ui-desktop.png`）,
phone（本地材料：`screenshots/live-bus-ui-phone.png`）. Workflow role selection is verified;
a full real multi-engine Crew run, external-instance configuration and
native-container acceptance remain open. The readable operation entry and names
were subsequently added as described above.

Local conversation restoration correction (2026-10-02): the WebKit stop regression
found its cancellation receipt in the sidebar after reload while the main pane
opened a different topic. Messages were intact; startup had selected the last
random ID in IndexedDB, with no saved device selection. The client now persists
its local conversation, validates it against cached conversations, and falls back
to the newest unarchived conversation when absent. A functional state update
prevents a late initial read from overwriting a user/deep-link choice. Local
identity reset clears this selection together with the Hub cache. The new paired
browser case checks independent desktop/phone pages and drafts, new-message
isolation, navigation override, reload and forgetting one device. It waits for
the asynchronous local write to commit before testing reload durability.
Client translation/type checks and production build passed. The final creation,
topics and stop regression passed **5 Chromium + 5 WebKit cases**
(`/tmp/t/tarocub-selection-final-{chromium,webkit}.log`), including the formerly
failing reload path. Controlled-engine local stop latency was **68.3 / 79.6 ms**
respectively; these are browser → Hub → Gateway signal measurements, not physical
phone or remote engine latency. All five live-engine specs skipped without opt-in
(`/tmp/t/tarocub-bus-live-opt-in-guard.log`). `git diff --check` passed and the
original repository remained clean. Native containers still require acceptance.

Cross-Bot cancellation correction (2026-10-02): an originating `/ask` stop used
to abort only its HTTP wait while the peer's engine continued without a signal.
An unfinished response connection closing now cancels that request's shared
Bridge turn. The signal is local server context, not client JSON. Normal request
body completion, normal response close and other concurrent requests do not
cancel one another. Gateway remains busy until execution settles; reported usage
survives a completion/cancellation race, with interrupted timeline status. Caller
abort is distinguished from timeout, and neither is automatically retryable.
**68 focused tests** and build passed
(`/tmp/t/tarocub-bus-cancel-{focused,build}.log`), including real authenticated
HTTP calls, two concurrent requests, normal completion, timeout and already
cancelled inputs. Cancellation does not roll back tools that already ran.

The real three-worker Codex acceptance passed in **1.2 minutes**
(`/tmp/t/tarocub-live-bus-verified.log`): group `/ask`, three-result `/fan`, two-stage
`/chain` with the first result entering the second prompt, and `/verify` all reached
both paired clients. Peer audits confirmed the expected native turns, with no
persisted peer chat binding. A later delegation emitted real native text before
the phone stopped it; the peer then recorded an interrupted turn and accepted a
fresh delegation. Group stop also generates the other Bots' normal no-local-run
acknowledgments; those are not duplicate model answers. The initial acceptance
assertion incorrectly excluded these expected acknowledgments and was corrected;
no production change was needed for that assertion. The receipt（本地材料：`evidence/live-bus.json`）
and inspected desktop（本地材料：`screenshots/live-bus-desktop.png`） / phone（本地材料：`screenshots/live-bus-phone.png`）
captures are retained. The new root hook passed **3,373 tests, 1 skipped, 212 files**
and build (`/tmp/t/tarocub-bus-cancel-complete-root.log`).

This case uses preconfigured temporary native Bus allowlists and three real
Codex workers; it does not close multi-engine crew or remote-service acceptance.
At that stage the UI exposed generated instance IDs in delegation output and
had no Bus configuration editor. The subsequent configuration and readable
operation work addresses those operator-experience gaps separately.

Native extra-permission acceptance (2026-10-02): installed Codex **0.159.3**
passed a real managed-worker flow with paired desktop/phone browsers in **52.2
seconds** (`/tmp/t/tarocub-live-codex-permissions-verified.log`). Phone whole-turn
approval allowed an exact nonce file outside the worker workspace; phone denial
and stop left their target files absent. Both clients retired cancelled controls,
a subsequent turn completed, and the granted request's process row no longer
remained pending. The receipt（本地材料：`evidence/live-codex-permissions.json`） and inspected
phone approval（本地材料：`screenshots/live-codex-permission-phone.png`） / desktop stop（本地材料：`screenshots/live-codex-permission-desktop.png`）
captures are retained. This proves the native request/response and real local
file effects, not physical-phone or every native permission-profile acceptance.

`item/permissions/requestApproval` now validates the full filesystem/network
profile without stripping constraints. Unsupported/over-budget requests return
no grant; callback mutation cannot widen the original profile. Cards show literal
JSON and accurate turn/session choices. Request ownership, stop, completion,
child replacement and native resolution all invalidate late answers. The adapter
closes the correlated permission row after sending its decision because this
CLI does not emit an ordinary tool completion for it; later shell actions retain
separate rows. A progress-renderer failure cannot invalidate a sent decision.
**227 focused tests** and build passed
(`/tmp/t/tarocub-codex-permissions-final-{focused,build}.log`). Four approval golden
snapshots changed only to fence the literal JSON details. The test explicitly
enables native `request_permissions_tool` for its temporary CLI process, uses
`/yolo off`, and never edits global engine configuration or existing fleet state.

The root completion hook subsequently passed **3,369 tests, 1 skipped, 212 files**
and build (`/tmp/t/tarocub-permissions-complete-root.log`). Chromium and WebKit each
passed the four cross-device cases after the literal-detail change
(`/tmp/t/tarocub-permissions-cross-device-{chromium,webkit}.log`). All four explicit
live-engine specs skipped without their opt-in flags. `git diff --check` passed;
the original repository remained clean. This successful root gate supersedes the
host-contention failures recorded below without changing their test deadlines.

Native approval-scope correction (2026-10-02): the shared UI previously described
every legacy `session` decision as "this turn", despite persistent Codex/Claude
workers and Harness retaining session grants. Adapters now declare the actual
lifetime and available choices. Lark/Gateway cards, text fallbacks and resolved
receipts distinguish one request, the whole turn, the session and ACP's persistent
option. One-shot Codex/Antigravity grants are visibly whole-turn and have no
unsupported session button. Kimi advertises only its real options, and one-time
consent can no longer fall back to `allow_always` when `allow_once` is absent.
An unavailable scope submitted through a stale/forged callback or text command
is rejected while the genuine request remains pending. Existing approval policy
and grants are not reset or widened.

Focused scope/Kimi/Harness regression passed **167 cases**
(`/tmp/t/tarocub-approval-scope-focused.log`). Cross-device acceptance passed
**4 Chromium + 4 WebKit cases**, covering scope labels, hidden unsupported choices,
phone decisions and accurate retired receipts on both clients, plus the existing
form/file/sync scenarios (`/tmp/t/tarocub-approval-scopes-{chromium,webkit}.log`).
The phone capture（本地材料：`screenshots/approval-session-scope-phone.png`） was inspected.
These are real Hub/Gateway/browser flows with a controlled bridge; the scope
mapping itself is additionally exercised in the native adapter tests. They are
not a claim that every CLI's persistent grant lifetime was tested against a real
model. The first full-root rerun was stopped after three unrelated file/process tests
hit the unchanged 5-second timeout while another local render saturated the host
(`/tmp/t/tarocub-approval-scopes-root.log`). The aborted run is not a passing gate.
A serial rerun passed 281 cases but still timed out in the unchanged 5-second
archive-expansion and five-conversation setup cases while the external render
remained CPU-saturated (`/tmp/t/tarocub-approval-scopes-serial.log`). Native scope
assertions and the background-process case passed in that rerun. This is not
a complete regression pass. No test deadline or performance budget was relaxed;
rerun the unchanged root hook once host contention clears.
The standalone root build passed afterward
(`/tmp/t/tarocub-approval-scopes-final-build.log`), and `git diff --check` passed.

Real Codex interaction acceptance (2026-10-02): installed **0.159.3** passed
native `request_user_input`, standard MCP tool confirmation/form, exact file
downloads and phone stop in **1.2 minutes**
(`/tmp/t/tarocub-live-codex-mcp-confirmation.log`). Phone answers reached the real
model; both clients downloaded the actual nonce-bearing result file. Stopping a
second native question and a second MCP form retired both devices' controls;
subsequent turns completed, with exactly one MCP write overall.
Receipt（本地材料：`evidence/live-codex-input.json`） and inspected
question（本地材料：`screenshots/live-codex-question-phone.png`）,
MCP form（本地材料：`screenshots/live-codex-mcp-form-phone.png`）, and
stop（本地材料：`screenshots/live-codex-question-stop-desktop.png`） captures are retained.

The native adapter previously rejected both request types as unsupported.
Dedicated schema normalizers now retain native IDs, constraints and typed
answers; the shared Lark/Gateway card supports text-only fields and finite
choices without Other. The adapter scopes callbacks to native thread/turn and
child generation, retires them on stop/completion/exit/resolution, and ignores
late answers. Real normal-mode acceptance also exposed Codex's empty-schema MCP
tool confirmation before the server's own form; it now asks for explicit
one-time consent instead of cancelling or automatically granting access.
**119 focused tests** and root build passed
(`/tmp/t/tarocub-codex-input-confirmation-focused.log`); shared card/service/Gateway
regression had already passed **418 cases**.

The final root completion hook passed **3,340 tests, 1 skipped, 210 files** and
build (`/tmp/t/tarocub-codex-input-complete-root.log`). Cross-device browser
regression passed **3 Chromium + 3 WebKit cases**, including a Codex MCP form
with a finite choice and text-only field, phone submission, typed response and
both-device retirement (`/tmp/t/tarocub-codex-form-{chromium,webkit}.log`). These
browser cases use a controlled bridge; the real CLI flow is the separately
identified acceptance above. Ordinary collection skips all three live-engine
specs without their explicit opt-in flags
(`/tmp/t/tarocub-live-opt-in-guard.log`). `git diff --check` passed and the original
TaroCub repository remained clean. No production fleet was restarted.

Native `request_user_input` in Default mode requires the installed CLI's
`default_mode_request_user_input` feature; only the temporary acceptance process
enables it. Questions were tested in TaroCub's unchanged default bypass mode;
MCP confirmation/forms in that test Bot's explicit `/yolo off` mode. Native CLI
policy may decline server forms before forwarding in bypass. Secret questions,
URL/authentication, OpenAI-specific forms and ambiguous Goal-owned requests are
not claimed supported. Additional permissions are covered by the later acceptance
above. The schemas were
generated by the installed CLI; the pinned [upstream elicitation implementation](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/codex-mcp/src/elicitation.rs)
was also checked. Browser contexts and a fixed-path local MCP fixture do not
constitute native-container, remote MCP or all-approval-policy acceptance.

Real Kimi tool acceptance (2026-10-02): installed Kimi Code **2.1.1** passed the
same native-question, two-device MCP allow/deny and exact-file flow in **24.5
seconds** (`/tmp/t/tarocub-live-tools-kimi-isolated.log`). Desktop approved the
read and phone approved the write; both downloaded the actual nonce-bearing
file. A later phone denial left exactly one write receipt. The receipt（本地材料：`evidence/live-tools-kimi.json`）
and inspected question（本地材料：`screenshots/live-kimi-question-phone.png`）,
approval（本地材料：`screenshots/live-kimi-approval-phone.png`） and
denial（本地材料：`screenshots/live-kimi-tools-desktop.png`） screenshots are retained.

The first real runs correctly found no project MCP tools in an untrusted
workspace. Installed 2.1.1 does not implement the newer
`KIMI_CODE_TRUST_WORKSPACE` environment variable. The passing test uses native
`.kimi-code/mcp.json` and a native-format trust record for only its test-authored
workspace, in a disposable `KIMI_CODE_HOME`. Existing login/configuration are
referenced by symlink, without reading or copying credential values. The original
home's trust records are untouched, and the temporary home is removed afterward.
This validates a trusted workspace's MCP integration, not an App workspace-trust
onboarding flow; users of 2.1.1 must first trust their workspace in native Kimi.
No production trust policy was relaxed. The latest unpinned documentation must
not be assumed to describe this installed version.

Latest real tool interaction acceptance (2026-10-02): real Claude Sonnet now
passes native AskUserQuestion, explicit normal-mode MCP approval/rejection and
file delivery through independently paired desktop/phone browsers. The phone
answers the native question; desktop approves the synthetic read, phone approves
the write. A random nonce obtained only from the actual local MCP result appears
in the generated file, and both clients download byte-identical content. A later
phone rejection prevents another write; the fixture records exactly one write.
The real model/CLI and production managed worker are used; only the fixed-path,
network-free stdio MCP endpoint is synthetic. Session-only CLI flags restrict
Claude to this fixture and native questions without editing shared credentials.
The test switches its Bot with `/yolo off`; it does not change TaroCub's default
approval mode or claim that bypass mode waits for approval.

This exposed duplicate tool progress rows: a native call and its approval event
were both counted, leaving an extra permanently pending step. Claude, Codex,
Kimi and Harness adapters now retain the native call ID on permission events;
the shared Lark/Gateway renderer correlates either arrival order, preserves
separate concurrent IDs and never revives a completed call. Native start metadata
replaces generic approval labels when the start arrives later. The decision card
and approval scope remain separate and unchanged.

**395 focused cases passed** across four native adapters and the shared renderer
(`/tmp/t/tarocub-approval-identity-focused-final.log`), then the root build. The
real Claude browser test passed in **17.7 seconds** and verifies two actual tools
are displayed as two completed steps with no phantom spinner
(`/tmp/t/tarocub-live-tools-verified.log`). The question（本地材料：`screenshots/live-claude-question-phone.png`）,
approval（本地材料：`screenshots/live-claude-approval-phone.png`） and
rejection（本地材料：`screenshots/live-claude-tools-desktop.png`） captures were inspected.
Receipt（本地材料：`evidence/live-tools-claude.json`） contains no native session or device IDs.
This is local-browser acceptance, not native OS file saving or an arbitrary
external MCP service/credential matrix. The final root hook passed **3,297 tests,
1 skipped, 208 files** plus build (`/tmp/t/tarocub-live-tools-full-root.log`).

Latest real-engine parity work (2026-10-02): the opt-in worker acceptance now
supports `TAROCUB_LIVE_ENGINE` and pairs independent desktop/phone browser
contexts. It waits for actual native answer text before SIGKILL, verifies the
interrupted state on both devices, one recovery notice, a new answer and the same
persisted native session. An initial run card alone no longer satisfies streaming
acceptance. Real **Codex, Claude, Kimi and DeepSeek** passes are retained in
evidence/live-worker-codex.json（本地材料：`evidence/live-worker-codex.json`）,
evidence/live-worker-claude.json（本地材料：`evidence/live-worker-claude.json`）,
evidence/live-worker-kimi.json（本地材料：`evidence/live-worker-kimi.json`） and
evidence/live-worker-deepseek.json（本地材料：`evidence/live-worker-deepseek.json`）. The final
runs used installed CLIs: Codex 47.1, Claude 25.2, Kimi 37.9, DeepSeek 23.0 seconds.
DeepSeek uses the production child-lifetime guard described below.
The Claude phone（本地材料：`screenshots/live-worker-claude-phone.png`） and
Kimi desktop（本地材料：`screenshots/live-worker-kimi-desktop.png`） captures were inspected.
These remain local browser contexts, not physical-phone/native-container checks.

This exposed two shared integration gaps: Claude subscribed only to completed
assistant blocks, and Bridge did not persist native IDs equal to its provisional
ID (as Harness uses). Claude now subscribes to partial messages, streams text and
thinking, withholds split internal control frames, and reconciles complete
blocks without repeating their prefixes. Existing subagent/background routing
and fenced literal examples remain intact. Bridge persists both equal and
changed confirmed IDs, deduplicates session events/results, and leaves temporary
overrides unbound. Focused Claude/renderer/Bridge regression passed 197 cases;
the pre-Harness full gate passed 3,285 tests, 1 skipped, 206 files and build
(`/tmp/t/tarocub-native-engines-full-root.log`).

DeepSeek 0.2.0-rc.2 moved live chunks into an opt-in cursorless follow stream.
The new schema-validated fold reconstructs reconnect prefixes, ignores replay,
stops concatenation across gaps and reconciles against the durable final answer.
Foreground and Goal claims stay distinct. Its first real streaming/crash run
reached the kill barrier and both-device interruption, then exposed an orphaned
DSH writer process blocking the next message. A child-only parent-lifetime
preload now terminates that Host if the bridge disappears; it removes its marker
before tools can inherit it and bounds a SIGTERM-ignoring orphan to a hard kill.
The 120-case focused Harness suite passed, including real parent SIGKILL tests.
The corrected real Harness run passed in 23.0 seconds, including a new answer
in the original persisted session after the kill. The phone（本地材料：`screenshots/live-worker-deepseek-phone.png`）
and desktop（本地材料：`screenshots/live-worker-deepseek-desktop.png`） interruption captures
were inspected. The failure was not waived or satisfied by an empty run card.
The temporary orphan identified during diagnosis was terminated after its cwd
was verified to belong to this isolated test; no existing fleet was restarted.

The final required hook passed **3,295 tests, 1 skipped, 208 files**, followed by
the root build (`/tmp/t/tarocub-native-parity-final-root.log`). The four live logs
are `/tmp/t/tarocub-live-{codex,claude,kimi,deepseek}-verified.log`.
`git diff --check` passed. The original checkout remains clean at `2941619`.
No deployment, release or intentional external account configuration was changed.
Installed native CLIs reuse their existing login and can maintain their own
normal caches/profile metadata; the test does not promise a read-only CLI home.

Native acceptance remains blocked locally by the locked desktop, Command Line
Tools without full Xcode, and no Java runtime. The earlier catalog reported
Antigravity unavailable; the current `agy` executable and catalog fix are verified
in the later cross-engine App acceptance（本地材料：`evidence/cross-engine-app-acceptance.md`）.
These environment observations do not substitute for actual native-device checks;
physical microphone, native file saving and OS background behavior remain open.

Latest history-search acceptance (2026-10-02): fixed the always-escaped LIKE
predicate that disabled trigram acceleration. A separate readonly WAL search
queue now leaves mutation/authentication work independent, including short-term
scan fallback. Literal Chinese, emoji, `%`, `_`, backslashes, quotes and apparent
FTS/SQL operators retain substring behavior; message updates/deletes refresh the
index. Membership, conversation Bot, inclusive date and block-attachment filters
remain combined. HTTP input is bounded and rejects invalid/reversed dates;
revocation during a pending search is rechecked before results are returned.

The desktop/phone search panel now shows loading, no-match and invalid-date
states, accepts a new keyword directly in the results view and closes the mobile
sidebar after submission. The message composer is hidden while searching.
Superseded/closed searches are aborted and guarded against stale completion;
results navigate to the original message, including group topics. The panel
explicitly identifies the existing latest-100-results limit.

**46 focused tests passed**, including 15 new store/schema cases and one new
real HTTP revocation/input case (`/tmp/t/tarocub-search-focused.log`). Root and
client translation/type/production builds passed (`/tmp/t/tarocub-search-build.log`,
`/tmp/t/tarocub-search-client-build.log`). Browser `search` passed on Chromium
and WebKit with independently paired desktop and phone contexts, real Hub data,
Bot/date/file filters, literal percentage text, topic navigation and real held
HTTP responses released after replacement/closing. Chromium also passed the
existing `hub` offline-outbox/search/revocation flow
(`/tmp/t/tarocub-search-{chromium,chromium-final,webkit}.log`). Visually inspected
phone（本地材料：`screenshots/search-phone.png`） and desktop（本地材料：`screenshots/search-desktop.png`）
layouts have no horizontal overflow; these remain browser-size checks, not
native-container or physical-phone acceptance.

The synthetic benchmark seeds **30,000 messages, 1,350 base characters each**, with
one selective match. Before: search plus a queued audit write took **34.72 ms**,
and the write completed after **34.71 ms**. After: **1.32 ms** combined, write at
**0.29 ms**. Query plans show `L2` for indexed candidate reads. This is one local,
warmed-data comparison, not a remote latency or all-history workload guarantee.
Raw comparison（本地材料：`evidence/search-performance.json`） is retained; rerun with
`npm run build` then `TMPDIR=/tmp/t node scripts/benchmark-hub-search.mjs`.
One/two-character terms may still scan; full-message result payloads and
pagination for many huge matches remain unmeasured/unimplemented respectively.

The required full hook passed **3,281 tests, 1 skipped, 206 files**, then the root
build (`/tmp/t/tarocub-search-full-root.log`). `git diff --check` passed. Original
checkout remains clean at `2941619`; no fleet, deployment or account changes.

Latest stop-control parity (2026-10-02): the App composer now uses the same
cancellation and acknowledgment helpers as `/stop` and the existing run card.
It cancels an accepted attachment burst during its merge window, closes every
cancelled input's timeline record, retains subsequent FIFO turns and does not
touch other conversations/topics. Hub sends group stops concurrently even when
the first member is offline or unresponsive. Authenticated stops bypass unrelated
stalled command RPCs, while retaining fresh session and membership/Bot checks.
Malformed/failed member responses produce a readable incomplete-stop warning.
Stops remain ephemeral, without reconnect replay. Error banners can now dismiss
connection-originated errors as well as local errors.

Focused checks passed: the initial 56 cases covered Gateway/Hub transport,
attachment-burst and steer contracts (`/tmp/t/tarocub-stop-focused.log`); 417
shared Lark/card-security/voice/workflow cases passed
(`/tmp/t/tarocub-stop-contracts.log`). The final 26 Gateway/Hub cases also cover
priority dispatch behind a held RPC, denied Bot/conversation access and session
expiry (`/tmp/t/tarocub-stop-priority.log`). Root build and client translation,
type and production build passed (`/tmp/t/tarocub-stop-{build,client-build}.log`).

The new browser `stop` flow passed on **Chromium and WebKit**
(`/tmp/t/tarocub-stop-{chromium,webkit}.log`): independently paired phone and
desktop, first group member offline, active reply, queued next turn and another
active topic. Phone click to the controlled engine's AbortSignal took **50.4 ms**
and **32.3 ms**, respectively. Both clients observe the interrupted card, next
queued answer exactly once and attachment cancellation; the other topic keeps
running until separately stopped. The cancelled image never reaches the engine,
including after its original merge window; the cancellation remains after reload.
The test explicitly selects the online Bot for input and scopes acknowledgments
to the message body, avoiding the same text in sidebar previews. Saved
phone（本地材料：`screenshots/stop-phone.png`） and desktop（本地材料：`screenshots/stop-desktop.png`）
captures were visually inspected. These are local browser/Hub/Gateway checks
with a controlled engine, not physical-phone, remote-network or arbitrary-tool
termination latency measurements.

The required full hook passed **3,265 tests, 1 skipped, 205 files**, then the
TypeScript/relay build (`/tmp/t/tarocub-stop-full-root.log`). `git diff --check`
passed; the original checkout remains clean at `2941619`. No fleet service,
deployment, release or external account configuration was changed.

Latest managed-worker supervision (2026-10-02): Hub crash retry accounting now
uses a rolling ten-minute window instead of a lifetime count. It retains a live
child after IPC errors until actual exit, and does not launch a replacement for a
disconnected child. An idle restart is reported as queued only after validated
IPC confirmation matching the request ID and child PID. Offline starts confirm
process spawn separately from online readiness. Managed HTTP restart operations
now use the client's durable receipt ID; duplicate requests, Hub-manager restore
and full-state backup restore retain the original result without another restart.
Uncertain or interrupted operations never silently repeat. Operations clears stale
success text before showing a later failure, with readable Chinese/English errors.
Planned exit 75 remains informational in audit; crashes and live IPC errors are
separate incidents. The supervisor window is in memory; the worker's persisted
recovery guard remains a separate protection.

**34 focused tests passed** (`/tmp/t/tarocub-supervisor-focused-final.log`),
including real child crashes spaced inside/outside the retry window, live IPC
errors, failed spawn, missing/wrong confirmation, concurrent duplicate requests,
interrupted/corrupt receipts and backup restoration. Root build and client
translation/type/production build passed after correcting a test mock's overloaded
Node callback type (`/tmp/t/tarocub-supervisor-{build,client-build}.log`).

**5 Chromium + 5 WebKit cases passed**
(`/tmp/t/tarocub-supervisor-{chromium,webkit}.log`), covering Bot/session/group/topic
creation, usage presentation, two-device recovery-guard operation and a real
production worker's UI restart. The latter waits for a new online PID, replays
the exact authenticated HTTP request and verifies that PID remains unchanged past
the idle/restart interval. Its final timeout response is deliberately injected
to verify truthful UI errors and removal of the old success. A subsequent run on
both engines also checks a 390 px phone viewport and no horizontal overflow
(`/tmp/t/tarocub-supervisor-phone-{chromium,webkit}.log`). Saved
desktop（本地材料：`screenshots/managed-restart-uncertain-desktop.png`） and
phone（本地材料：`screenshots/managed-restart-uncertain-phone.png`） captures were visually
inspected. This uses isolated temporary state and no paid model turn or live fleet.

The required full hook passed **3,261 tests, 1 skipped, 205 files**, then the
TypeScript/relay build (`/tmp/t/tarocub-supervisor-full-root.log`).
`git diff --check` passed and the original checkout remained clean. No production
service or deployment was changed. Native-container acceptance remains separate.

Latest standalone recovery protection (2026-10-02): App-created Gateway workers
now use TaroCub's existing persisted restart-loop guard. Stale locks count hard
kills; caught startup and cleanup failures count before lock release. On the
third unclean ending in the original ten-minute window, that boot skips
file-workflow/turn recovery and final-delivery sweep. Committed transport journal
replay and fresh input remain enabled. A successful complete shutdown or idle
restart clears the window; cleanup errors retain it. Invalid configuration,
storage failures and arbitrary runtime faults are not repaired by this guard.

**410 focused tests passed** (`/tmp/t/tarocub-worker-loop-focused-final.log`),
including original Lark service/guard/lifecycle tests. New real child-process
cases inject three consecutive SIGKILLs or startup exceptions. The next worker
starts despite the still-armed fault, replays the committed publication once,
retains the untouched pending answer, handles `/help`, then cleanly restarts and
delivers the owed answer once. A cleanup exception is separately verified to
retain the crash window while releasing the lock and closing the channel. These
use the production bootstrap in isolated state with local commands, not a paid
model or live fleet. Root TypeScript/relay build passed.

**1 Chromium + 1 WebKit case passed**
(`/tmp/t/tarocub-worker-loop-{chromium,webkit}.log`): separately paired desktop and
phone inspect the real guard audit, then a phone `/help` reaches both devices.
The phone（本地材料：`screenshots/restart-guard-phone.png`） and
desktop（本地材料：`screenshots/restart-guard-desktop.png`） captures were visually inspected.
An initial test click targeted the mobile drawer's covered backdrop center; the
final test selects the conversation to return to chat and also guarantees child
cleanup even if a browser context has already closed. This is browser acceptance,
not native-container or real model-turn acceptance.

The required full hook passed **3,253 tests, 1 skipped, 204 files**, then the
TypeScript/relay build (`/tmp/t/tarocub-worker-loop-full-root.log`).
`git diff --check` passed, no restart-loop fixture process remained, and the
original checkout remained clean. Production services and deployment are untouched.

Latest browser startup implementation (2026-10-02): short and long Markdown now
share the existing off-thread parser, safe URL/raw-HTML policy and readable-text
fallback. The first pairing view no longer evaluates the parser/math/highlighter.
Production entry JavaScript fell from 1,425,861 to 663,696 bytes; the worker remains
in the offline shell cache. This is first-view load reduction, not a reduction of
the entire offline app download. Details and timing boundaries are below.

Client translation/type checks and production build passed
(`/tmp/t/tarocub-markdown-client-build.log`). The complete Chromium suite passed
**61 tests, 2 opt-in real-engine tests skipped**
(`/tmp/t/tarocub-markdown-full-browser.log`). New coverage includes short/long
formatting and safe failure, startup byte budgets and a fresh offline page's
tables/formulas/highlighting. The old visual fixture now supplies the connection
state/subscription required by the attachment renderer, and gallery captures wait
for pending Markdown to finish. The local phone question form（本地材料：`screenshots/markdown-worker-ask-phone.png`）
and dark completed card（本地材料：`screenshots/markdown-worker-completed-dark.png`） were
visually inspected; these are generated samples, not Feishu reference screenshots.

The WebKit suite passed **46 cases initially**; its single File Center failure
was a bypassed test save barrier after service-worker activation. Disabling the
service worker for that fault-injection case and checking that the request is
actually held made the case pass on both engines
(`/tmp/t/tarocub-markdown-file-center-{chromium,webkit}.log`). Offline rendering
has its own new cross-engine case: stop the real Hub, reload the cached app and
verify a fresh worker renders bold text, table, formula and highlighted code.
Both engines pass (`/tmp/t/tarocub-offline-parser-{chromium,webkit}.log`); this
tests an unavailable Hub. WebKit's synthetic offline flag caused an internal
navigation error, so the final case uses the stopped server for the network fault.
The root hook passed **3,250 tests, 1 skipped, 203 files** plus build
(`/tmp/t/tarocub-markdown-full-root.log`). The original checkout remains clean.

Latest long-final recovery implementation (2026-10-02): Gateway final replies
and background-task notifications above 200,000 UTF-8 bytes now persist an exact
JSON-string body separately from the small delivery-obligation index. The index
holds a hash/size reference; the existing Feishu/default inline cap is unchanged.
Creation is atomic under the ledger mutex, with synced private body files before
the reference commit. Recovery reads one body at a time, verifies type/length/hash
and JSON-string shape, then uses the unchanged guarded artifact replay path.
Missing/corrupt bodies fail recovery without an empty-success replacement.
Referenced bodies survive cleanup; only old unreferenced recognized body/temp
files are collected. Full Hub backup/restore now verifies these bodies too.

Real child-process fault injection covers both ordinary final responses and
background notifications. At the barrier, a >1 MiB body and its obligation exist,
while neither the Hub nor Gateway publication journal has the final text. SIGKILL
terminates that exact process. A new production Gateway recovers the full body,
settles the input without rerunning the deterministic engine, and a subsequent
observed boot barrier produces no second recovered copy. This tests the specified
window, not every process failure or a real paid engine response.

**54 focused tests passed** (`/tmp/t/tarocub-long-body-focused-final.log`), including
private permissions, exact Unicode/unpaired-surrogate persistence, content sharing,
corrupt/missing/symlink/invalid references, expired-orphan cleanup, default-platform
cap preservation, existing delivery and shared-handler regression, real SIGKILL
and full backup/restore. Root TypeScript/relay build passed.
**1 Chromium + 1 WebKit case passed**
(`/tmp/t/tarocub-final-recovery-{chromium,webkit}.log`): paired desktop/phone receive
the same complete recovered >1 MiB publication, hashes match their persisted
caches, all 10 tables and the final marker render, original shared heading/math
normalization is retained, and another worker boot neither reruns input nor adds a
second recovered copy. Screenshot evidence is `screenshots/final-recovery-desktop.png`
and `screenshots/final-recovery-phone.png`; these are browser fixtures, not native
or external-device acceptance.

The required root hook passed: **3,250 tests, 1 skipped, 203 files**, followed
by TypeScript and relay build (`/tmp/t/tarocub-long-body-full-root.log`).
`git diff --check` passed and the original `cc-telegram-bridge` checkout remained
clean. The complete v1.0/native/deployment goal is still not fully verified.

Remaining boundaries: ledger off/storage failure/crash before its commit, existing
3-attempt/24-hour/200-row bounds and ambiguous post-send failures remain. The latter
still use the visible recovered marker and at-least-once semantics. No deployment,
release or managed production fleet change was made.

Latest Bot dashboard implementation (2026-10-02): Operations → Bot dashboard
now separates live activity, scheduled tasks, saved crew workflow and UTC usage.
Gateway samples active conversations/start times, queued messages, approvals,
choices and pending batches from its shared App/Feishu runtime. Stale persisted
running flags never become live counts. Saved configuration and bound-session
count are separate; failed refresh clears live activity while retaining history.
Managed offline Bots retain saved records; external Bots require their Gateway.

Cron normalization (including old one-time notification defaults and instance
timezone) and next-run projection are shared with the existing store/CLI dashboard.
The App shows enabled/disabled and one-time/recurring jobs, settings, last success,
errors, failure threshold and up to 10 run receipts. Crew shows only the latest
persisted workflow/stages, review verdict and revision count, explicitly without
claiming liveness. Timeline navigation provides the detailed execution record.

Daily/monthly/all-time usage keeps original UTC buckets, all recorded periods,
input/output/cache, metered/unmetered turns, average and cache share. Missing
periods and unreported costs remain unknown; prior engines' records remain visible.
Both ordinary Operations and the dashboard now read the ledger without repairs;
validated last-good fallback is visibly older saved data. Original schemas,
16 MiB regular-file bounds, schema-version checks, redaction and allowlisted
response fields protect the read surface. No new task, schedule or ledger is
created by viewing it.

**41 focused tests passed** (`/tmp/t/tarocub-dashboard-focused.log`), including
original CLI dashboard/CronStore regression, stale runtime/session flags, timezone
and old reminder defaults, usage backup/corruption, crew stages, symlinks, oversize
and newer state versions, owner/device/Bot authorization and managed offline reads.
**2 Chromium + 2 WebKit tests passed** (`/tmp/t/tarocub-dashboard-{chromium,webkit}.log`),
covering real fixture Hub/Gateway with paired desktop/phone contexts, refresh,
cron history, crew status, UTC buckets, unknown costs, read-only fallback even
through the ordinary overview, offline clearing, timeline navigation, English,
light/dark themes, no page errors and no horizontal overflow. Client build passed
with the existing main-chunk size advisory. These are browser fixtures, not signed
native-device or large-state performance acceptance.

The required root completion hook passed: **3,244 tests, 1 skipped, 202 files**,
followed by TypeScript and relay build (`/tmp/t/tarocub-dashboard-full-root.log`).
`git diff --check` passed; the original `cc-telegram-bridge` checkout remained clean.
This is a software milestone, not overall v1.0, native or deployment completion.

Screenshots: `screenshots/dashboard-desktop-light.png`,
`screenshots/dashboard-desktop-dark.png`, `screenshots/dashboard-phone.png`.

Latest diagnostic-history implementation (2026-10-02): Operations now exposes
separate Bot timeline/audit and Hub audit readers. Owner-authenticated devices can
filter source, event type, outcome, App/Feishu/Bus/Telegram channel, conversation
key or numeric chat ID, keywords and time bounds; expand redacted details; and
load older records. Shared timeline schemas and summary functions keep incident
counts aligned with TaroCub. Hub-owned Bot logs remain readable while stopped;
external Bots require their authenticated Gateway to be online. Mobile initially
collapses advanced filters and statistics so records remain readily visible.

The reader walks current plus retained rotated files through fixed file handles,
64 KiB chunks and a 256 KiB maximum record size, keeping only the requested page.
It reports unreadable, invalid, oversized and unfinished records. File identity,
offset and content keep cursors stable across append/rename rotation; removed
anchors visibly expire. Counts describe retained readable records, not lifetime
totals. Secret redaction precedes search and display shortening. Hub audit reads
fix an upper row ID and release the database queue between batches. Unknown Hub
event outcomes remain informational rather than assumed successes. This adds no
new ledger and does not modify original log bodies or event channel semantics.

**22 focused checks passed** (`/tmp/t/tarocub-diagnostics-focused-final.log`),
covering retained rotations, append/rename cursor continuity, cursor expiry,
source/date/outcome/conversation filtering, shared counters, corrupt/symlink/long
records, complete redacted-text search and adversarial Unicode response limits.
Real Hub/Gateway checks reject unauthenticated, member, revoked and unregistered
access; verify offline managed-Bot reads; and exercise Hub audit pagination.
**2 Chromium + 2 WebKit cases passed**
(`/tmp/t/tarocub-diagnostics-{chromium,webkit}-final.log`), covering independent
paired desktop/phone readers, multiple pages, numeric chat filtering, audit/source
switches, new records visible after refresh on both devices, Hub audit filters,
English controls and the existing usage/operations regression. Inspected captures:
`screenshots/diagnostics-desktop-{light,dark}.png` and
`screenshots/diagnostics-phone.png`. Client translations, TypeScript and Vite build
passed (`/tmp/t/tarocub-diagnostics-client-build.log`, existing large-chunk advisory).
The final complete hook passed **3,239 tests, 1 skipped, 201 files**, followed by
the TypeScript/relay build (`/tmp/t/tarocub-diagnostics-full-root-final.log`,
60.53-second test run). `git diff --check` passed; the original repository remains
clean at the same `2941619` baseline. No release or live service restart occurred.
These are browser checks with fixture services, not native device acceptance.

A local synthetic retained-log read covered **240,000 records / about 53 MiB**
across six files in **1,983 ms**, with sampled peak RSS increase **16 MiB** and a
**16,383-byte** 50-row response (`/tmp/t/tarocub-diagnostics-benchmark.log`). All
records contributed to counts and no read warning occurred. This measures the
reader alone on this host; it does not satisfy the complete product performance
or concurrent-load budgets. The subsequent Bot dashboard integration is documented above.

Latest File Center implementation (2026-10-02): the App now exposes the original
inventory/classification logic through an owner-only Hub API. Only registered Bot
workspaces, inboxes and ASR directories participate; identical canonical workspace
roots count once. Desktop/phone support search, category/status/Bot filters, size
and source details, notes, important markers and manual categories. One shared
cancellable scan retains its previous snapshot after cancellation/failure; lightweight
revision polling shares updates without repeatedly sending unchanged inventories.
Label revisions reject stale writes and preserve the device's unsaved draft.
Saving locks the editor until its response, and navigation asks before discarding
unsaved edits. Original Console annotations import once for indexed units only;
Hub labels then remain authoritative for the App, including after clearing them.
The original Console metadata and inventoried file contents remain unchanged.
Labels use private, validated atomic storage and survive full backup/restore.
Finder reveal accepts only a known unit ID and rechecks current registered roots;
the phone button explicitly targets the Hub computer.

**38 focused checks passed** (`/tmp/t/tarocub-files-focused.log`). The complete root
hook passed: **3,234 tests, 1 skipped, 200 files**, followed by a successful
TypeScript/relay build (`/tmp/t/tarocub-files-full-root.log`, 60.53-second test run).
Client translations, TypeScript and Vite also passed
(`/tmp/t/tarocub-files-client-build.log`), retaining the existing large-chunk advisory.
**2 Chromium + 2 WebKit cases passed**
(`/tmp/t/tarocub-files-{chromium,webkit}-final.log`): the new File Center flow plus
the existing operations flow. Independent paired desktop/phone contexts exercise
bidirectional labels, stale-write rejection with draft retention, discard guards,
delayed-save editing protection, shared-root deduplication, filtering and English
UI switching. Page-error checks passed; fixture file contents remained unchanged.
Inspected captures are `screenshots/file-center-desktop-{light,dark}.png`,
`screenshots/file-center-phone-list.png` and `screenshots/file-center-phone-light.png`.
These use real test Hub/Gateway services, not native containers or real Finder.
Large-directory scan performance and final physical-device behavior remain open.

Latest functional-parity review: [the source-backed audit](functional-parity-audit.md)
accounts for all **42 canonical commands**, hidden aliases, engine differences and
the non-command feature families. A registry guard now rejects uncategorized new
commands. App help/status/config cards and engine restart guidance use native
client operations; the menu reads saved engine configuration. Group reply modes
reuse one handler for text and cards, remain isolated by Bot and conversation/topic,
and use a separately validated `gateway-group-mode.json`. Explicit mention-only
mode overrides an instance's all-message default and survives Feishu group resets;
App actions neither mutate Feishu access nor query Feishu scopes. Shared final-response
recovery filters each destination before claiming a ledger row. Gateway now sweeps
after old publications and before interrupted input receipts; reconnect cannot
start a second in-flight sweep. This preserves artifact preflight, strips unsafe
replayed actions and retains the original bounded, visibly at-least-once semantics.
Operations now distinguishes unknown token/cost measurements from recorded totals,
retains earlier-engine history and explains unavailable cost/budget enforcement.
The audit originally recorded the 200,000-byte ledger ceiling and remaining App
dashboard gaps; the subsequent Gateway body-store implementation is documented above. File Center, structured audit/timeline history and the Bot dashboard
were subsequently implemented above; native/large-directory acceptance remains open rather than
claiming full parity.

**52 focused checks passed** (`/tmp/t/tarocub-parity-focused-final.log`). The final
root hook passed on 2026-10-02: **3,228 tests, 1 skipped, 199 files**, followed by a successful
TypeScript/relay build (`/tmp/t/tarocub-parity-full-root-final.log`). This includes
the previous backup/relay/Lark timing cases and supersedes their failed gate below.
**4 Chromium + 4 WebKit cases passed** (`/tmp/t/tarocub-parity-{chromium,webkit}-final.log`).
Browser validation exercises actual translated config-card actions across paired
desktop/phone pages, native group scopes, question forms, Kimi choices, interrupted
cards and cached images across a real test-Hub stop/restart. Operations reads real
Hub/Gateway usage stores for four engine configurations, including unmetered Kimi,
token-only DeepSeek, recorded Claude cost and prior-engine history. Captures inspected:
`screenshots/command-parity-{desktop,phone}.png` and
`screenshots/operations-{desktop,phone}.png`. The client translation check,
TypeScript check and Vite build also passed (`/tmp/t/tarocub-parity-client-build.log`),
with the existing large-chunk advisory. These are browser viewport checks,
not native-container or real-engine acceptance.

Two full reruns under concurrent video-rendering load are retained as failed evidence:
31 failed / 3,197 passed / 1 skipped plus one cleanup rejection in
`/tmp/t/tarocub-parity-full-root-busy.log`, then 5 failed / 3,223 passed / 1 skipped
in `/tmp/t/tarocub-parity-full-root-serial.log`. After that external load subsided,
the final complete hook above passed in 62.52 seconds without relaxing those
assertions or changing their production paths. This is functional evidence,
not performance or resource-contention acceptance.

Latest offline-backup acceptance: **21 focused checks passed** for full backup,
restore, existing maintenance and managed Bot lifecycle
(`/tmp/t/tarocub-backup-focused-latest.log`). Tests preserve identity and device
trust, Bot keys/config/session, workspace executable bits, completed delivery
receipts and unfinished upload chunks; they restore a 101 MiB file intact and
reject malformed manifests, missing referenced blobs/chunks, tampering, active
instance locks, overlapping paths and existing destinations. A failed restore
is moved aside under its owned lock before cleanup; interrupted restores cannot
start as a Hub. External dependencies and non-followed workspace links are explicit.
An opt-in **real Codex browser case passed** (`/tmp/t/tarocub-backup-live.log`):
stop, back up, move the original state aside, restore to the original path and
restart. The same device reconnects without pairing, history matches, and the
same native engine session remembers the previous turn. The existing machine's
engine login/history remains external. Capture: `screenshots/worker-backup-restored.png`.
The current root TypeScript/relay build passed (`/tmp/t/tarocub-backup-build-final.log`).

**Previous backup gate failures, now resolved by the later full hook above.** The first
hook completed with 3,219 passed, 3 failed and 1 skipped under concurrent video
rendering load (`/tmp/t/tarocub-backup-full-root.log`). A slower single-worker
attempt also hit timing failures and was deliberately stopped after confirmed
failures (`/tmp/t/tarocub-backup-full-root-final.log`); it is not a passing receipt.
The Kimi late-review test now waits for delivered events instead of fixed sleeps
and passes in isolation (`/tmp/t/tarocub-backup-kimi-recheck.log`). Multi-connection
and large-journal Hub fixtures now have 30-second outer budgets while retaining
5-second per-frame waits; both pass in the focused integration recheck. The relay
test has room for its four installer runs, each still bounded at 30 seconds, but
its child process also timed out under this load. The new restore lifecycle case
has an explicit 30-second budget including its real child-process startup and
passes in the latest focused run. No production Kimi/Lark/relay behavior was changed
for these test adjustments. The later full hook also rechecked the existing Lark
attachment-reference case that failed during the interrupted run. Do not infer
performance acceptance from either focused checks or a passing functional suite.

Previous worker-lifecycle acceptance: root hook **3,206 passed, 1 skipped** across
196 files plus build (`/tmp/t/tarocub-worker-full-root-final.log`). **9 focused
checks** passed for Gateway bootstrap, recovery and Bot process management
(`/tmp/t/tarocub-worker-focused-final.log`). The opt-in real Codex browser case
passed (`/tmp/t/tarocub-worker-live-browser-final.log`): UI Bot creation,
first reply, remembered context after process restart, SIGKILL during streaming,
one durable interruption event/notice and a fresh reply in the same native session.
**3 Chromium + 3 WebKit** cases passed for creation and cross-device interruption
UI (`/tmp/t/tarocub-worker-{chromium,webkit}.log`). Both devices retain the readonly
partial result after reload, with disabled old actions and an expandable history.
Visually reviewed captures: `screenshots/worker-recovery-{desktop,phone}.png`;
the real-engine capture is `screenshots/worker-crash-recovery.png`.
The initial full hook exposed the recurring Lark health-test fake-clock/filesystem
race. That test now waits for real reconnect and timeline writes; its focused run
and the final full hook passed. Production health-monitor behavior is unchanged.
An unrelated archive-service timeout passed in isolation and in the final hook.
No native-container, other-engine or deployment acceptance is claimed by this run.

Previous long-reply acceptance: root hook **3,204 passed, 1 skipped** across
196 files plus build (`/tmp/t/tarocub-long-full-root-final.log`); **29 focused
checks** passed (`/tmp/t/tarocub-long-focused.log`). **9 Chromium + 9 WebKit**
browser cases passed for oversized delivery, streaming, snapshots, cross-device
history/read state and quote/forward behavior
(`/tmp/t/tarocub-long-{chromium,webkit}-regression.log`). The new large-card case
verifies a reply over 1 MiB, a partial delivery followed by a real Hub restart,
matching complete block hashes on two devices, a forced snapshot and forwarding.
Both TypeScript checks and the macOS arm64 debug app build (44.16 MiB) passed;
iOS/Android assets synchronized successfully (`/tmp/t/tarocub-long-mobile.log`).
Visually reviewed captures: `screenshots/long-card-{desktop,phone}.png`.
The first full suite had a Lark health-monitor timing failure under concurrent
browser load; its isolated rerun and the final full hook passed. Browser test
repairs target message-body selectors, wait for the app before opening the mobile
drawer, and wait for shared read receipts before asserting a fresh unread count.
No unrelated production behavior was changed for these test repairs.

Previous upload-policy acceptance: root hook **3,199 passed, 1 skipped** across
195 files plus build (`/tmp/t/tarocub-upload-limit-full-root.log`). Focused tests
cover configuration validation, device/Bot HTTP limits, intact receipts after
lowering a limit, and continued access to completed attachments. Chromium and
WebKit each completed a real **513 MiB** upload at a configured **1 GiB** limit
through the production composer with full SHA-256 verification, and retained the
existing **120 MiB** dropped-receipt/route-switch resumption check. Twelve relevant
cases passed per engine, including over-limit draft retention in desktop/phone
layouts, attachment composition and system-share controller behavior (logs:
`/tmp/t/tarocub-upload-limits-chromium.log`, `-chromium-compose.log`, `-webkit.log`).
The Swift native share store's limit persistence/reset/copy checks passed locally;
Android/iOS bridge compilation and actual share-sheet callbacks still await native
device acceptance. Root type-check, macOS debug app build (44.16 MiB), and mobile
asset synchronization passed. Production Hub configuration was not changed.

Previous title/card preview acceptance: root hook **3,196 passed, 1 skipped** across
194 files plus build (`/tmp/t/tarocub-feishu-full-root.log`); 30 focused protocol,
preview, forwarding, transport and maintenance checks passed. Final browser checks
**7 Chromium + 7 WebKit passed** for link previews, quoting/forwarding and combined
attachment captions (`/tmp/t/tarocub-feishu-{chromium,webkit}-acceptance.log`).
macOS debug bundle rebuilt (44.16 MiB), iOS/Android assets synchronized, and root
type-check passed. Visually inspected browser captures are saved at
`screenshots/link-styles-{desktop,phone}.png`; the cover is a synthetic PNG fixture.
This is not native phone installation or hardware acceptance.

Previous link-preview acceptance: root hook **3,182 passed, 1 skipped** across
191 files plus build (`/tmp/t/tarocub-links-full-root-final.log`); final relevant
browser runs **11 Chromium + 11 WebKit passed**, including cover decoding after
cached/uncached reload (`/tmp/t/tarocub-links-{chromium,webkit}-acceptance.log`).
macOS debug bundle rebuilt (44.16 MiB); Capacitor iOS/Android assets synchronized.
Screenshots: `screenshots/link-{draft,bubbles}-{desktop,phone}.png`. These are browser
layout and shared-code checks; mobile native compilation/signing/hardware acceptance
remain deferred. The last PNG fixture repair was rechecked with the six focused
Hub preview tests; it does not change production code.

## Verified software paths (2026-10-01)

- Negotiated `fragments.v1` carries complete long replies, full snapshots and local
  Gateway RPC bodies as ordered SHA-256-verified physical frames. Fragment data
  stays within 200 KiB and each envelope within 1 MiB. SQLite, IndexedDB, search,
  quote/forward content and exports retain the full canonical message. Only
  authenticated local instances can submit fragmented input; ordinary client
  sends keep their 200 KiB UTF-8 limit. Old peers receive an upgrade requirement,
  while Gateway retains oversized pending publications for a compatible Hub.
  Partial/corrupt input cannot commit, and disconnect drops transient fragments.
  Unit and socket checks cover UTF-8 boundaries, corruption/order/timeout, input
  authorization, legacy clients and a large queued journal across Hub restart.
  Browser acceptance interrupts a real Hub after one physical fragment has
  reached the desktop, verifies unchanged prior history, then compares complete
  block hashes on independently paired desktop and phone after reconnect. It
  also forces a full snapshot and forwards the long card, checking its table,
  formula and final paragraph in Chromium and WebKit. Complete logical JSON still
  requires memory proportional to content; this is lossless framing, not a claim
  of unlimited hardware capacity or native-device performance acceptance.
- Reference: [Feishu's official link-preview guide](https://open.feishu.cn/document/development-link-preview/link-preview-development-guide),
  inspected 2026-10-01 (page updated 2025-08-28), documents icon/title and structured
  card forms for custom app previews. The client adapts that distinction with
  send-time title/card selection; this does not claim every Feishu chat has the
  same switch or provide private Feishu document authorization. The choice is
  shared across devices, reload and forwarding; local reading folds do not edit
  history or redispatch to Bots. Schema 8 adds nullable `preview_style` and leaves
  schema 7 messages/events intact, with old messages continuing as cards. Runtime
  schemas reject malformed styles at both transport and persisted read boundaries.
- Inline link previews preserve original URLs and show page title, hostname/site,
  description and available cover in the same message bubble. Drafts debounce
  reads, choose among up to five URLs and allow preview removal/restoration.
  Sending never awaits metadata; the Hub journals a later versioned update with
  conversation-scoped cover bytes. Schema 7 introduced metadata columns; schema 8
  retains that additive migration for versions 1–7.
  Forwarding retains metadata with its own cover reference, including reuse of a
  forwarded cover for later messages. The public-only fetcher pins DNS, checks
  every redirect, rejects credentials/private addresses, bounds encoded/decoded
  bodies, and handles declared charsets without running scripts or using cookies.
  Focused tests cover authorization before reads, selection validation, durable
  restart, cover scope, forwarding and compressed-size limits. A real read of
  `https://ogp.me/` returned title, description and a 12,379-byte cover.
  Metadata-only user updates preserve the newer conversation-list preview in both
  live replay and snapshots; cover-only messages are excluded from file search.
  Separate browser devices verify draft selection/removal, reciprocal sync, mixed
  caption/image/link sends, delayed and inaccessible pages, stale draft isolation
  and snapshot recovery. A WebKit Blob-clone failure found during reload acceptance
  led to a portable byte-array cache format (legacy Blob records remain readable).
  Image/audio hooks retry after authentication returns. Blocking attachment HTTP
  during reload proves cached covers still decode; clearing the cache then reloading
  proves covers and user images automatically recover with the connection.
- Desktop and phone composition sends text, multiple pictures and other files in
  one existing `message.send` frame. Attachment drafts now show thumbnail/name/size,
  removal, add-more and caption guidance; selecting files never sends immediately.
  The mixed clipboard handler preserves plain text at the current caret/selection
  instead of dropping it when a clipboard image is present. Uploading locks that
  message's text and attachment edits; cancel/failure retains the draft. Browser
  coverage proves caption-first and files-first entry on two separate devices,
  exactly one message and one Bot delivery per send, intact downloaded bytes,
  mixed paste plus drag, and a second-file failure without publishing partial
  text/images. Gateway coverage checks the caption and all eleven attachments
  arrive together at the engine boundary. System-share controller coverage also
  checks that text and file references travel in the same frame.
- Quoted replies expose author/excerpt/attachment context and clickable navigation
  to the original message, with a clear unavailable-source state. Forwarding uses
  a searchable direct/group/topic picker with parent paths and visible touch labels.
  It snapshots server-owned provenance, text/cards/media, creates destination-scoped
  attachment IDs and independent blob links, disables card actions, and defaults to
  no Bot delivery. Explicitly selected destination Bots can continue the discussion;
  forwarded slash text stays reference material. Replay is idempotent and uses the
  durable outbox; schema 6 migrates old databases additively. Tests cover authority,
  cross-scope attachments, nested media, immutable copies after source deletion/GC,
  restart/retry, rollback, forged interaction denial and actual Gateway input.
  Independent browser devices exercise reciprocal quote/forward flows, exact file
  downloads and reload. A cut TCP proxy proves offline enqueue survives UI reload
  and sends once after reconnection. The UI bundle remains available during this
  test, as it would in a native shell; this is not a browser-shell offline cache test.
- Group/topic navigation now expresses “group → topic → messages” explicitly:
  collapsible sidebar branches, unread counts when collapsed, a parent breadcrumb
  on both screen sizes, stable quick-switch tabs and a searchable topic directory
  with active/archived views. Opening an archived topic retains its history and
  offers restoration while hiding the composer; an archived parent also disables
  child-topic composition. The `topics` browser scenario seeds eight distinct
  topics, creates a ninth through the UI, verifies separate messages/drafts,
  searches by name, restores an archived topic, and returns to the parent's
  default discussion. No new Bot/model selection is required for a topic.
- Independent desktop (1360×900) and phone (390×844) browser profiles pair as
  different devices of the same Hub user. Cross-device acceptance covers group
  creation on desktop, topic creation on phone, reciprocal messages and Bot
  replies, both attachment directions with exact downloaded byte content, and
  closing/reopening each client while the other continues. Both separate
  IndexedDB message stores are compared with the Hub's complete canonical history.
  Phone form submission completes the shared request once and retires both
  clients' forms; streaming changes, final content and read-state propagation
  are checked. Remote rename updates an already-open panel while preserving an
  unsaved local edit. Replay exposed a scroll bug: after a large batch, the old
  distance check treated new history as a deliberate scroll away from the bottom.
  The UI now follows the tail on open/reconnect and through measured content
  growth, preserves deliberate history reading, and offers “Jump to latest”.
  This is browser/viewport evidence, not signed mobile or native device acceptance.
- Ed25519 device challenge authentication, pinned Hub identity, owner approval,
  expiring one-use pairing codes, challenge replay rejection, 15-minute HTTP
  sessions, immediate revocation and credential-free audit records.
- QR pairing using two independent browser device profiles: scan a trusted Hub
  invitation, scan the new device's approval QR, explicitly approve, then connect.
  Scanning alone does not authorize the new device. QR payloads contain no private
  keys or session tokens. Image decoding is exercised; live camera hardware is not.
- Repeated pairing acceptance exposed a QR perspective-detection failure for
  some clean generated images. QR output now uses integer module pixels and a
  four-module quiet zone; image scanning retries direct module sampling after
  perspective detection. A deterministic synthetic payload covers all eight
  QR masks and rejects a non-pairing URL. Five repeats of that test and the real
  two-device approval flow pass; camera hardware still needs acceptance.
- SQLite WAL event sequencing, concurrent idempotent sends, permissions, restart
  replay, scoped search, message/attachment/bot authorization and schema migration.
- Real Gateway and shared message/card handlers, with Feishu SDK/CLI guards:
  50,000-character output and ten tables, shared active-run stop under one second,
  binding to an existing instance session, ten PNGs plus one PDF and quoted files.
  Real Bridge/session-manager contracts serialize simultaneous Feishu/Gateway
  messages against the same native session. Gateway has an authenticated surface
  facade; its inner authorization no longer accidentally re-applies the Feishu
  allowlist, and the original Feishu policy remains unchanged.
- Stored group mentions survive Hub restart; only the selected bot receives an
  explicitly addressed message. Unmentioned messages obey each instance's existing
  require-mention policy. Actual `/fan`, `/ask` and `/verify` handlers invoke the shared
  Agent Bus delegate and return through Gateway; no real peer process is contacted.
- Card 2.0 behavior callbacks and legacy values are normalized. The AST inventory
  covers all 27 whole-card constructors with 48 translation golden snapshots,
  including timeout, interruption, approval decisions, retries and archive states.
  Late native delivery receipts cannot resurrect cancelled approval/question forms.
  See [card coverage](card-coverage.md).
- Browser end-to-end tests exercise actual AskUserQuestion min/max limits and
  custom answers, Kimi option-only forms, config locale callbacks, and titled
  `send.batch` images rendered as a grid with a full-size preview.
- Durable Gateway receipts and pending actions survive disconnection/restart and
  avoid repeating completed side effects when acknowledgements are lost.
- An independent Hub process is killed with **SIGKILL during streamed output**.
  After restart the browser reconnects in under two seconds, all 30 paragraphs are
  present, the final answer appears once, and the fake engine is invoked once.
- `message.stream` now carries versioned text, block and nested-card operations
  to clients advertising `streaming.v1`. A 50,000-character card plus 12 updates
  sends **3,626 bytes of incremental events**, compared with over 1.8 MB if the
  full base were repeated each time. Chromium and WebKit preserve exact final
  content through reload; duplicates/stale versions are ignored, and sequence or
  base-version gaps roll back without advancing the IndexedDB cursor. Real
  Gateway output emits deltas, including the SIGKILL recovery acceptance above.
  Older clients receive full snapshots; terminal snapshots remain authoritative.
- Gaps over 1000 events now use negotiated conversation snapshots from a stable
  SQLite WAL read transaction. Message frames stay below 1 MiB, with at most eight
  unacknowledged frames in flight. IndexedDB stages partial data separately and
  atomically replaces messages, activity and cursor only after complete receipt.
  Chromium and WebKit tests interrupt a snapshot exceeding 1 MiB, reload midway,
  retain the old cache/cursor and queued send, then recover concurrent new replies
  and send the queued message exactly once. Root transport tests also cover
  completion/read-state metadata, streaming deltas after the snapshot, legacy
  replay, authorization, stale cursors, near-limit frames, invalid receipts and
  heartbeats while waiting for staging acknowledgements. Oversized messages and
  events are rejected before commit so they cannot break subsequent replay.
- A 120 MiB upload resumes after Hub restart with the original SHA-256. Snapshot
  export, backups, attachment orphan GC and future-schema refusal are tested.
- Chromium and WebKit upload a 120 MiB file through two local HTTP routes. After
  the Hub accepts a chunk, its receipt is dropped and the preferred WebSocket is
  blackholed. The client automatically reconnects through the fallback route,
  reconciles stored receipts and sends each of the 15 chunks once. The final
  SHA-256 matches and exactly one user message exists. A restored preferred route
  does not interrupt the active transfer; it is selected again after completion.
  Cancellation retains the selected file for an explicit retry; revocation,
  permission and hash failures stop without retry. This is local fault-injection
  evidence, not deployed Tailscale/VPS or native-device acceptance.
- Offline browser reload and three ordered queued sends, rendering, search,
  revocation and explicit local reset are exercised. Reset clears local drafts,
  cache, cursors and outbox before re-pairing while retaining appearance preferences.
- Blackholed preferred route switches within three seconds during a streamed
  answer; the client returns to Tailscale only when idle. Sequence replay is checked.
- Separate TLS/instance listeners reject relay access to instance endpoints.
  Multiple SNI certificates and native origins are supported. The outbound mTLS
  relay passes the Hub's TLS stream without plaintext, rejects wrong SNI, missing
  credentials and a second CA-valid but unpinned client certificate, and reconnects.
- Persistent push outbox tests cover three independent reminders, restart, retries,
  expired registrations, revocation, quiet hours, mute, foreground/read suppression
  and destination restrictions. FCM service-account signing, token coalescing and
  non-collapsible data messages are checked with an injected HTTP transport.
- APNs, FCM, encrypted Web Push and allowlisted UnifiedPush sender implementations
  exist. No live provider delivery has been claimed. Android includes a native
  FCM notification service; Android UnifiedPush distributor selection/registration and encrypted delivery
  are implemented. Three notifications are independently decrypted in a transport
  test; native distributor callbacks still require Android build/device acceptance.
- Actual cron execution produces three independent reminder messages and three
  push records. Long scheduled replies keep the Gateway instructions. Missing
  Gateway channels cannot route cron execution/failure notices into Feishu.
- Native `/goal` progress/status/clear, translated choice buttons with duplicate
  tap protection, board Ready buttons and group mini-bus registration/removal
  pass through the shared handlers. Native message handles now close cancelled
  approval/question cards in place without CardKit.
- Operations/session/device APIs and UI are present. A fake CLI contract verifies
  that restart always delegates to the existing `lark service restart --defer`
  protection. No production instance has been restarted.
- Google OAuth/PKCE/state, refresh coalescing, revision-safe updates, content
  read-back and export receipts pass with injected Google transport. No real Google
  document was created. The CLI and engine skill are included.

## Native and visual evidence

- A local macOS Tauri debug `.app` was built and opened. Pairing, real OS Keychain
  device signing, Hub login, a real Gateway/fake-engine round trip, streamed thinking,
  a table and KaTeX were verified in the actual app window.
- Tray, unread badge, global shortcut, autostart, deep links, close-to-tray and device
  key deletion are implemented. The refreshed macOS debug build was opened and
  checked in Chinese and English. File selection, upload, escaped text preview and
  the system Save As dialog work; the saved 61-byte fixture is byte-identical.
  A draft-read race and a file-picker FileList reset race were fixed. KaTeX inline
  fonts now have the required CSP allowance.
- Desktop update discovery and explicit installation use the Tauri updater. Release
  builds pin the signing public key, require an HTTPS feed and signed version, and
  prohibit downgrades. Controller failure paths are tested; no real update package
  has been installed. Unsigned development builds clearly disable the update feed.
- Mobile app lock integrates system biometric/device-credential authentication, a
  secure local preference and native app-switcher privacy protection. Controller
  tests cover cancellation, background lock, failed storage and foreground checks.
  Hardware prompts and mobile snapshot protection remain unverified locally.
- Mobile inbound sharing uses an Android intent receiver and an iOS Share Extension
  with a private App Group inbox. The user explicitly selects a recipient before
  sending. First-attempt routing is persisted, retries use an idempotent message ID,
  and failures retain the draft. Native chunk reads are bounded; copied inputs expire
  after 24 hours. Four browser/controller tests and compiled Swift filesystem checks
  cover retry, identity isolation, size/path/chunk boundaries and inbox cleanup.
  Actual mobile OS share menus still require the mobile toolchains/devices.
- Capacitor Android/iOS projects, permissions, signing configuration placeholders,
  secure-storage adapter and APNs/FCM hooks are present. This host has macOS command
  line tools but no full Xcode or Android SDK. Simulators and signed builds have not
  been verified. Native CI definitions are present, but have not run remotely.
- Real-constructor fixtures now export 33 cases. Fourteen desktop cases have
  light/dark captures, and five have mobile captures. Tests verify weighted columns,
  card spacing, notation text, disclosure state, explicit paragraph line breaks
  and horizontal overflow. `client/visual-baseline/` tracks missing references.
  Client light/dark/mobile/form screenshots are test artifacts. **They are not real
  Feishu screenshot baselines and do not establish the required visual parity.**

## Bot, group and topic interaction (2026-10-01)

The operator clarified that a Bot is a persistent TaroCub instance, while a new
conversation is a quick independent session. Explicit sidebar New Bot/New Group,
header New Chat and in-group New Topic controls implement this distinction.
Only New Bot asks for engine, model and effort. It uses the existing engine
selection/compatibility helpers and starts an isolated Gateway-only worker with
the shared Bridge, session manager, queue, cards and cron executor. Ordinary
sessions and topics reuse that configuration. An existing Feishu Bot is not
reconfigured or restarted by these controls.

A one-Bot group is supported. Topics inherit their parent group's Bots and
members but keep independent messages/session keys; a bound parent session is
not copied. Creation waits for a durable Hub response and selects the new chat.
Uncertain retries keep the same receipt ID. Dialogs support keyboard focus,
Enter/Escape, empty/disabled/error states, and narrow screens. Group replies use
Bot-name recipient chips, avoiding manually typed technical instance IDs.

Focused checks cover owner authorization, model/effort compatibility, workspace
validation, concurrent Bot creation retries, private keys, startup and restore
without overwriting edited configuration, parent permissions/archive behavior,
HTTP receipts and other-device topic synchronization. A real Bridge test verifies
four different native session IDs for two direct chats, a group and its topic,
and continuation of the same topic session. Opt-in browser acceptance also creates
a production Gateway worker through the UI and uses the real authenticated Codex
CLI for replies, remembered context after restart and continuation after SIGKILL.
The interrupted turn receives one recovery notice and one interrupted timeline
terminal event, while the native session ID remains unchanged. Ordinary browser
acceptance keeps the transport fixture; a separate real Gateway/shared-handler
fixture replies in group/topic UI. Lost HTTP creation receipts, retry, reload,
focus and 390px mobile layouts are exercised.

## Regression evidence

Own-message bubbles now use pale blue in the light theme and muted blue in the
dark theme (including system theme and queued messages), while agent replies
retain neutral surfaces. The existing paired-Hub browser flow passes after the
CSS change; its desktop light/dark and mobile dark screenshots were inspected.
Body text contrast is 14.10:1 in light mode and 9.08:1 in dark mode. The macOS
debug app was rebuilt and Capacitor assets were synced with these colors.

The earlier caption repository hook passed **3175 tests, 1 skipped** across 190 files
with its TypeScript build, using at most four workers. That receipt is
`/tmp/t/tarocub-caption-full-root.log`. The preceding **38 Chromium browser/controller checks**
passed in `/tmp/t/tarocub-topics-full-chromium.log`, including topic management,
cross-device workflows, real-constructor card geometry, light/dark/mobile captures,
stream/snapshot recovery, uploads, QR decoding and the Markdown worker.

The **19 WebKit 26.6 checks** are verified across the full run and a focused
rerun. The full run passed 18 and exposed focus returning to the composer after
closing the topic directory. The directory now explicitly returns focus to its
opener, including WebKit where clicking a button does not focus it. All five
affected creation/cross-device/topic flows pass in both engines after that fix;
receipts are `/tmp/t/tarocub-topics-webkit-final.log` and
`/tmp/t/tarocub-topics-chromium-final.log`, alongside
`/tmp/t/tarocub-topics-full-webkit.log`. These tests exercise Escape, focus return,
archive restoration, separate topic drafts/history and the parent breadcrumb at
390 px. The unchanged earlier upload loss-injection uses an actual HTTP proxy;
creation loss-injection blocks service workers to intercept the page request.

The combined caption/attachment change passes **11 Chromium checks** and
**7 WebKit checks**, covering the two new composer scenarios, both cross-device
flows, cancellation/retry, the 120 MiB route-switch/resume scenario and Chromium's
four existing share controller/UI scenarios. Receipts are
`/tmp/t/tarocub-caption-chromium-final.log` and
`/tmp/t/tarocub-caption-webkit-final.log`. The root hook and strengthened Gateway
caption/file assertions also pass. Desktop composition（本地材料：`screenshots/attachment-composer-desktop.png`）
and phone composition（本地材料：`screenshots/attachment-composer-phone.png`） show the built
UI with synthetic attachment fixtures; this is browser viewport evidence.
The debug desktop bundle was rebuilt and iOS/Android resources synced again:
`/tmp/t/tarocub-caption-desktop.log`, `/tmp/t/tarocub-caption-mobile.log`.

For the quote/forward change, all **17 affected browser checks per engine** are
verified across the updated runs and focused reruns. Chromium initially passed 16;
creation's old text locator also matched the new quoted excerpt, so it now scopes
message-content assertions to `.message-blocks`. Both creation flows pass after
that test adjustment. WebKit initially passed 13; its card fixture generator raced
against the Chromium generator, and creation had the same locator issue. Running
one generator at a time verifies all three card checks and both creation flows.
Receipts: `/tmp/t/tarocub-forward-chromium-final.log`,
`/tmp/t/tarocub-forward-chromium-creation.log`,
`/tmp/t/tarocub-forward-webkit-final.log`,
`/tmp/t/tarocub-forward-webkit-recheck.log`. Quote/forward UI, both download
directions and offline-reload recovery pass in both updated runs. The test's
pairing helper waits for QR layout and uses keyboard activation of the confirmation
button to avoid clicking it while the asynchronously rendered QR moves the button.

The phone forward picker（本地材料：`screenshots/forward-picker-phone.png`） and
forwarded phone message（本地材料：`screenshots/forwarded-phone.png`） were visually inspected.
The current debug app and mobile-resource receipts are
`/tmp/t/tarocub-forward-desktop.log` and `/tmp/t/tarocub-forward-mobile.log`.

The desktop topic tree（本地材料：`screenshots/group-topics-desktop.png`） and
phone topic directory（本地材料：`screenshots/group-topics-phone.png`） are captured from the
built client with test data and were visually inspected. The macOS debug app
builds successfully (44.16 MiB); Capacitor sync completes for Android and iOS.
Sync is not a native compile. This historical checkpoint preceded the later
Mac pairing/files/sync smoke receipt at the top of this ledger. Other platform
builds, signing and real mobile-device checks remain separate acceptance work.

The latest isolated 5000-line, ten-table, ten-formula browser run recorded
**5 ms input response, 16.7 ms p95 frame interval, 33.3 ms maximum frame interval
and zero long tasks** (`/tmp/t/tarocub-markdown-chromium.log`; long tasks mean more
than 50 ms). Markdown of every length now parses in one shared worker,
coalesces obsolete streaming updates and reuses unchanged render chunks. Full
reference links, tables, math, code and HTML/URL safety checks pass. Worker failure
falls back to escaped readable text. This is local Chromium evidence, not a
native/mobile performance claim. Removing the eager short-message parser reduced
the production entry JavaScript from **1,425,861 to 663,696 bytes** (53.5%; gzip
446.02 to 213.24 kB), eliminating the previous 1.2 MB advisory. Offline precaching
still includes the parser worker; an offline page reload verifies table, KaTeX
and highlighted-code rendering, rather than accepting plain-text fallback.
Five fresh Chromium contexts measured a median first pairing view of 121.9 ms
before and 104.9 ms after; WebKit after measured 73 ms. These local samples have
empty HTTP caches and disable service workers to separate the first view from
background precaching. They are informational browser timings, not native cold
start or real-network budgets. `startup.spec.ts` enforces a 900 kB entry-script
ceiling. Native cold start and memory budgets remain unmeasured; the latest Mac
UI attempt again reported the screen locked (2026-10-02).
The only existing Telegram test adjustment injects the identity response in a
listing-only test to eliminate an external-network timeout. Telegram production
code is untouched.

## Voice, MCP and capability audit (2026-10-01)

The [capability map](capability-map.md) now traces the README feature families,
commands, media routing and engine/MCP integration to their owners and acceptance.
This is an inventory of current evidence, not a claim that every external service
or native device has been exercised.

- The recorder now has permission-pending state, elapsed time, cancel/finish,
  local audio audition and combined voice/text sending. Conversation changes,
  archive/unmount, errors and visibility changes release the microphone. A
  background visibility event finishes an active recording into an unsent draft;
  mobile OS suspension without an event still needs hardware acceptance.
- Gateway audio uses the shared Qwen/Tingwu/chunking/cancellation pipeline, with
  per-message transcription status and a 2000-character preview. Empty genuine
  voice transcripts now take the existing failure path. Partial transcripts keep
  their missing-segment markers. Bot audio uses the filename's actual MIME type
  instead of labeling every recording as OGG.
- Dedicated workers load shared MCP credential extras and scoped instance ASR
  settings through the existing environment helper. Native engine homes remain
  intact. Tests use fake credentials; no live key was copied into client data.
- Configured workers start the shared authenticated Agent Bus, retain accounting
  and audit, wait for active delegation before an idle restart, and unregister on
  shutdown. File workflows interrupted by a worker restart are marked for recovery;
  engine transports are closed at shutdown. No live fleet was changed.

Acceptance: **3194 root tests passed, 1 existing test skipped, 194 files**, followed
by the required root build (`/tmp/t/tarocub-voice-full.log`). Chromium and WebKit
both passed **8 browser scenarios** for voice, attachment composition, creation
and cross-device interaction. Voice scenarios use a synthetic microphone with
real browser MediaRecorder encoding and audio playback, independent desktop/phone
pairing, real Hub/Gateway transport, fake ASR text, and fake engine output. Tests
also cover denied and pending permissions, cancellation, conversation switching,
recorder errors and background visibility cleanup. Exported recordings were
independently probed with ffprobe for codec, duration and audio streams. Chromium
produced Opus-in-MP4 and WebKit produced AAC-in-MP4. Each recording was also
played in the other engine (time advanced, no decoder error); receipts are in
`/tmp/t/tarocub-voice-cross-codec.json`. The recorder retains browser-native MP4
codec selection: an explicit AAC experiment was rejected because this Chromium
build advertises it as supported but raises an asynchronous encoding error.

A separate local smoke test used macOS Tingting speech synthesis and the real
running Qwen HTTP service through `createDefaultTranscribeVoice`. It returned
“这是语音功能测试，请把会议安排在明天下午三点。” exactly. Inputs and transcript are
in `/tmp/t/tarocub-voice-live/`. This was synthetic speech, not access to the
user's microphone. Long/cloud routing tests use a fake Tingwu executable; no new
paid cloud job or real third-party MCP query was invoked.

Both TypeScript checks, the macOS debug `.app` build (44.16 MiB) and Capacitor
asset sync passed. Phone native compilation/signing, actual microphone permission
prompts, interruptions and background behavior still require device acceptance.
Screenshots: `screenshots/voice-{recording,preview}-{desktop,phone}.png`.

## Remaining program work and acceptance

- Client-created standalone workers now pass opt-in real Codex, Claude, Kimi and DeepSeek browser flows:
  UI creation with model/effort, first answer, remembered context after a managed
  process restart, and a SIGKILL during an accepted streaming turn followed by a
  readable interruption state and a successful new turn in the same native
  session. These use the existing authenticated native CLIs.
  DeepSeek uses its validated 0.2 transient stream and private Host lifetime
  guard. Antigravity now also passes the real worker flow after correcting the
  catalog's executable lookup to `agy`. The later App prompt cross-engine
  acceptance (local evidence: `evidence/cross-engine-app-acceptance.md`) covers current Claude,
  DeepSeek, Kimi and Antigravity captioned file delivery, two-device byte checks,
  native streaming and phone stop/resume. DeepSeek native questions also passed.
  Claude/Kimi native questions, local MCP allow/deny and exact two-device file
  downloads have real-model evidence. Codex native questions, normal-mode MCP
  confirmation/forms, exact downloads and phone cancellation also pass. Native-container acceptance and the remaining
  real-engine feature matrix stay open.
  Configured Agent Bus workers
  now register the shared authenticated Bus service and pass real local HTTP
  delegation, audit/usage and shutdown checks. Three real Codex workers additionally
  pass paired-browser ask/fan/chain/verify, native streaming cancellation and a
  subsequent delegation. Managed peer configuration has an App editor, and
  readable Bot selection starts the same native workflows with stable IDs.
  The five-engine Crew now passes one full workflow and phone cancellation
  (see the receipt above). External-instance configuration, complex revision loops
  and broader model permutations remain open. Their ordinary
  shared-handler/session behavior and production process startup are verified;
  the new process bootstrap now recovers interrupted file workflows and timeline
  turns, closes engine transports, and writes Gateway-specific Kimi startup
  instructions. Failed input receipts atomically retire their Bot's unfinished
  cards after journal replay without re-executing input or changing another Bot.
  Gateway now runs the boot-time final-response obligation sweep with channel
  isolation and an input barrier. Above-ceiling final/background responses now use
  checked out-of-line bodies and pass real pre-publication SIGKILL recovery.
  Standalone startup/cleanup now shares the original crash-loop breaker and has
  real consecutive-kill/exception, retained-delivery and fresh-command evidence.
  Supervisor failure-window accounting, live IPC errors, failed spawn and durable
  confirmed restart receipts now have dedicated child-process coverage. Full
  fault-injection combinations remain open.
  Offline `hub backup --full`
  and `hub restore` now include Hub-owned Bot directories, identity, credentials,
  default workspaces and attachment/upload state. Same-machine real Codex restore
  preserves device trust, history, native session ID and remembered context.
  Externally configured workspaces, global engine login/history and shared
  environment credentials still require separate backup; this is not cross-machine
  migration acceptance. Daily database backups and content exports remain separate.

- Relay deploy/status now includes optional pinned ntfy and Tailscale peer-relay
  archives, authenticated ntfy subscriptions, SNI routing on TCP 443, a separate
  UDP peer-relay rule and redacted sibling-service status. Generated Bash is run in
  an isolated filesystem with mocked system commands to verify install/idempotency,
  credential modes and rollback of real files/service settings, including a
  restarted Tailscale daemon whose preferences API is initially unavailable. Signed relay-only
  updates preserve the sibling binaries/configuration. Actual Linux/systemd and
  fresh-VPS acceptance, real ntfy delivery and tailnet grant/traffic remain pending.
  Those external deployment checks remain deferred.
- Android Back navigation is implemented and browser/bridge tested; physical
  keys, gestures, keyboard interception and native lifecycle remain unverified.
- UnifiedPush, mobile app lock and inbound/outbound sharing await Android/iOS
  compile and device/distributor acceptance. Verify the signed desktop updater
  with release artifacts when signing and toolchains are available.
- Desktop/mobile packaging projects and build jobs are present. The macOS
  arm64 debug app and optimized universal macOS development bundles are compiled
  locally. The universal bundle has verified architecture/signature/image contents,
  but still needs native runtime acceptance. Windows x64/arm64 and iOS/Android
  builds remain unverified. This host lacks full Xcode and the
  Android SDK. A checksum-verified portable JDK 21 is now available on an external
  disk; Gradle project/dependency preflight passed on 2026-10-03, but SDK license
  consent and actual compilation remain pending. See [Android build](android-build.md).
  After regenerable Rust build caches were cleared, the host had
  roughly 11 GiB of free disk space; the built debug application was retained.
- The rebuilt handshake/revocation fix passes actual native reset, fresh pairing,
  remote revocation and complete quit/relaunch with the correct recovery message
  and cached history. Native file dialogs and two-way sync passed on the preceding
  debug bundle. Native startup/memory and broader feature acceptance remain open. UI language switching/persistence, bounded
  offline attachment caching and explicit message resend are now implemented.
- App parity beyond the original chat-client scope: structured audit/timeline
  history, filters, pagination and incident counts are implemented. The Bot dashboard
  now exposes sampled activity, cron/crew details and UTC daily/monthly usage.
  Task event detail remains in the timeline. Synthetic 5,000-job dashboard and
  10,000-file inventory measurements are recorded above, including concurrent
  phone stop; native containers, real Finder and actual user-workspace performance
  remain unverified.
  Ordinary operations expose health, cumulative usage, readonly logs and idle
  restart. Existing CLI access is not equivalent App UI acceptance.
- Full security/chaos/performance budgets, 12+ real Feishu screenshot comparisons
  in both themes and final regression. The user guide and deployment/operations
  guides are written; update them with the eventual live acceptance receipts.
- Production acceptance: real route/certificate/DNS setup, live Google Docs and
  push, signed distribution, TestFlight and release. These remain deferred by the
  operator and are not substitutes for the outstanding software work above.

## Reproduce

```sh
TMPDIR=/tmp/t npm test -- tests/client-protocol.test.ts tests/hub-foundation.test.ts tests/hub-server.test.ts tests/gateway-cards.test.ts tests/gateway-service.test.ts tests/gateway-operations.test.ts tests/gateway-recovery.test.ts tests/hub-push.test.ts tests/relay.test.ts
npm run build
npm run build --prefix client
TMPDIR=/tmp/t npm run test:e2e --prefix client
TMPDIR=/tmp/t npm run test:webkit --prefix client
cargo check --manifest-path client/src-tauri/Cargo.toml
TMPDIR=/tmp/t bash scripts/pre-complete-hook.sh
```

Ordinary fixtures generate keys, devices, pairing codes and storage under
temporary directories. They do not contact production bots or external messaging
services. Real-engine acceptance is skipped unless explicitly enabled. After
building the root and client, run from `client/`:

```sh
TMPDIR=/tmp/t TAROCUB_LIVE_WORKER=1 TAROCUB_LIVE_ENGINE=codex npx playwright test e2e/live-worker.spec.ts --trace off
```

This opt-in case makes real model calls using an already-authenticated native CLI.
`TAROCUB_LIVE_ENGINE` accepts `codex` (default), `claude`, `kimi`, `deepseek`, or
`antigravity`; unsupported/unavailable local engines are not silently substituted.
It creates a temporary isolated Bot, restarts and terminates only that managed
worker, then removes the temporary Hub state. It does not change CLI login or
restart any existing fleet service.

Real question/MCP/file acceptance is also opt-in, run from `client/` after builds:

```sh
TMPDIR=/tmp/t TAROCUB_LIVE_TOOLS=1 TAROCUB_LIVE_ENGINE=claude npx playwright test e2e/live-tools.spec.ts --trace off
```

`TAROCUB_LIVE_ENGINE` is `claude` (default) or `kimi` for this case. Kimi uses an
isolated native home with references to existing login/configuration and a trust
record for the test-authored workspace only.

Only the fixture MCP may create the fixed acceptance file under the temporary
workspace. The test verifies real tool receipts and download bytes, not merely
a model's claim that it called a tool.


Real Codex native questions and MCP forms use a separate opt-in case:

```sh
TMPDIR=/tmp/t TAROCUB_LIVE_CODEX_INPUT=1 npx playwright test e2e/live-codex-input.spec.ts --trace off
```

The wrapper's native question feature and MCP configuration apply only to this
process. It never edits global Codex settings; native executable defaults to
`codex` and can be selected with `CODEX_EXECUTABLE`.

Native extra permissions have their own opt-in acceptance:

```sh
TMPDIR=/tmp/t TAROCUB_LIVE_CODEX_PERMISSIONS=1 npx playwright test e2e/live-codex-permissions.spec.ts --trace off
```

The wrapper enables `request_permissions_tool` and constrains the test sandbox
only in that process. It verifies three real native requests: grant then exact
file write, denial with no file, and stop with no file followed by a fresh turn.
The target is a temporary sibling of the test workspace; no user file is changed.

Configured multi-Bot Bus acceptance is separately opt-in:

```sh
TMPDIR=/tmp/t TAROCUB_LIVE_BUS=1 npx playwright test e2e/live-bus.spec.ts --trace off
```

This case creates three temporary managed Codex workers, configures their native
Bus peer allowlists and workflows through the App collaboration editor, restarts
their idle workers, and uses paired browsers for group `/ask`, `/fan`, `/chain`,
`/verify` and phone stop. Creating a group does not authorize peer access.
Only native event method names are observed to prove streaming before stop;
no prompt, credential or native session ID is included in that event trace.

## 2026-10-02: Opus-led brand and warm-palette milestone

Claude Opus 5.5 with requested xhigh effort directly implemented the brand UI,
then revised all action/selection/focus colors and user bubbles after the user's
warm-background feedback. Actual model receipts, final screenshots, browser
checks and limits are in [brand-upgrade-acceptance.md](brand-upgrade-acceptance.md).
Both builds passed; the complete root suite passed 3,427 tests with one skipped
using 20-second test/hook timeouts after default 5-second runs hit variable
timeouts under host load. No assertions or backend code were changed.

The browser checks cover pairing appearance, real fixture Bot/topic creation,
custom avatar precedence, draft preservation, phone question submission,
streaming state, dark/English layouts, reduced motion and offline brand assets.
This milestone does not certify new iOS/Android/Tauri packages, real-model speed,
or all remaining native acceptance requirements; the overall plan stays open.

## 2026-10-04 — Skills / MCP inventory

Added the read-only sidebar page and owner-only Bot capability endpoint. Five-engine local configuration discovery, scope filters/search, source details, pagination and explicit runtime-unverified/partial coverage are implemented. See [the capability inventory contract](skills-mcp.md). This is not proof of full native plugin catalogs, live MCP connectivity, multi-host UI, or updated native-package delivery.


## 2026-10-04 — DeepSeek goal budget isolation

[Native goal usage and pause isolation](deepseek-goal-budget-2026-10-04.md) replaces
session-wide delta accounting with a native durable goal-turn projection. Budget
pause checks the native goal CAS and current turn origin, so an ordinary message
which has already taken over completes normally. The UI discloses that ordinary,
background and child tasks are excluded. Five native boundary/restart/fault flows and
Chromium/WebKit goal-completion regression have passed. Two read-only Opus reviews
informed the fixes; the parent validated the final source. Physical devices and new
packages remain separate acceptance work.


## 2026-10-04 — Opus-led phone interaction refinement

Actual Claude Opus 5.5 with xhigh effort refined the chat action menu and then
replaced repeated phone message toolbars with a single entry and labeled sheet.
The parent validated rendered 390px / 320px / desktop states, close/focus,
conversation/host isolation, translations, reduced motion, and shared export
state across layout changes. See [chat-menu QA](interaction-polish-qa-2026-10-04.md)
and [message-action QA](message-actions-qa-2026-10-04.md). The latter includes
Chromium/WebKit checks and the final 3,781-pass root gate. Native packages and
physical-device acceptance remain open; r10 predates these follow-ups.

The separate [automatic Lark steering receipt fix](lark-steer-receipts-2026-10-04.md)
prevents an uncertain native admission from being replayed through the ordinary
queue. Target identity is rechecked around asynchronous lookups; this is
source/test evidence, not a deployed fleet receipt.
