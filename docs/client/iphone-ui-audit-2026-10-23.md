# iPhone UI and performance audit — 2026-10-23

Status: the source audit and selected repairs are complete. This record separates
source/browser evidence from native device acceptance and lists remaining work.

## Scope

Codex and Claude Opus 5.5 (xhigh) reviewed the iPhone entry flows, inbox and Bot
directory, conversations and drafts, Markdown and attachments, readers, groups
and topics, run details, questions, queues, collaboration, schedules, settings,
pairing/network/device management, notifications, sharing and the iOS shell.
The independent review indexed 356 of 385 client source files; the remaining
files were classified as desktop/Android or support code. Some reads were
partial. This is not a claim of line-by-line coverage or physical acceptance
of every feature.

The prior homepage/composer changes are recorded in
[phone inbox and composer](phone-inbox-composer-2026-10-23.md).

## Repairs

| Area | Result |
| --- | --- |
| iOS keyboard | The WebView retains its native size; the app consumes the keyboard's will-show height and animates its visible shell. This removes the initial downward movement followed by a late native resize. The document itself no longer scrolls behind inner panes. Lower form fields are revealed by scrolling their inner container after native keyboard events, preserving the document position and input selection. |
| Safe areas | Diff and collaboration panels use the visible shell. Top-level errors avoid the Dynamic Island. Existing Android inset ownership remains separate. |
| Native navigation | A left-edge pan sends the existing modal-aware back event. It closes the top sheet first, then the current page, and dismisses the keyboard when leaving chat. |
| Native appearance | The launch screen uses the existing TaroBot mark. Keyboard light/dark appearance follows the App theme. Full-screen image readers request light status icons over their dark canvas and restore the App style on close. |
| Attachments | A single draft image stays compact and loads immediately. Oversized-image feedback remains visible. |
| Inbox and typing | Hidden mobile inbox rendering is frozen; the desktop sidebar is not mounted on a phone. Composer measurement reuses its measurement node. Chinese search composition stays local until committed; Enter during composition does not dismiss the keyboard. |
| Draft persistence | The first edit writes immediately; continued typing is coalesced in 250 ms windows and flushed on conversation change, hiding and sending. Draft preview notifications are scoped to the changed row. |
| Message reads | Unchanged messages retain object identity. Repeated history reads are bounded by at least 80 ms or the previous read duration. Outbox and conversation-sync updates invalidate their own conversation instead of every conversation. |
| Directory and background work | Workspace reuses the shell's directory result. Repeated identical network views do not publish again. Share-inbox polling runs only for the visible workspace and throttles pruning. Collapsed integration suggestions do not poll ASR. |
| Rendering | Avatar object URLs are shared and reference counted. Completed Markdown parses have a bounded cache for virtualized remounts. |
| Offline recipients | Unknown capabilities at an offline cold start no longer imply a legacy first-Bot selection. Explicit group/topic selections persist across reload, offline queueing and reconnect. |
| Group and creation flows | Collapsed folders retain their state across tabs/restarts. Group sheet headers/actions respect the phone padding. The diff reader opens once after its module is ready. Bot catalog errors distinguish permission, unsupported endpoint and retryable failures. Schedule forms keep results through a reconnect and disable autocorrection for Cron/time-zone input. |
| Group compatibility | Group settings use the existing abort-signal compatibility helper. Chinese prose next to ASCII Bot mentions is recognized without treating email addresses as mentions. |
| Settings polish | Undefined secondary/error colors now use theme tokens, including dark run/grant states. Small secondary touch targets are enlarged. VPS entry uses URL input settings. |
| Native dates and buttons | The physical iPhone reproduced overlapping date values; phone start/end date controls now use separate rows. Primary file-action buttons retain their primary fill instead of white text on a secondary fill. |
| Download decode | Native chunks use an indexed byte copy rather than a per-character iterator/callback. Existing malformed/oversized-chunk checks remain. |

## Evidence gathered so far

- Physical device: iPhone 15 Pro Max, iOS 27.0.1. Ad-hoc signed
  `com.tarocub.client` 1.0.100 builds 2 through 8 installed over the existing App.
  No uninstall was performed. Existing pairing and conversations were observed
  after installation and cold launch.
- Physical interactions passed: homepage and chat safe areas; repeated Chinese
  keyboard opening; keyboard dismissal on edge-back; nested attachment-sheet
  dismissal; settings navigation and long-page scrolling; separate native date
  fields, including a working system picker and a bounded right edge; a visible
  primary filter button; dark keyboard while the system remains light; image-reader
  status-bar contrast/restoration; folder collapse through tab switching; lower
  New Bot workspace input revealed above the Chinese keyboard in build 8
  (reproduced hidden in build 7). Temporary draft text
  was cleared and the original theme/palette were restored.
- Simulator native checks additionally covered multiline input, a photo draft,
  emoji keyboard, and repeated keyboard transitions. The delivered comparison
  video is simulator evidence: the old transition first sank approximately
  26 pt then jumped about 0.58 s later; the revised sampled transition moved
  monotonically in approximately 0.23 s. These are geometry observations, not
  a claim of sustained 60 fps on the phone.
- The hidden-inbox probe used 202 conversations: typing/background updates
  changed hidden Home function renders from 180 to 0, with current data and
  draft intact when returning. The history probe reduced 31 rapid updates
  from 33 reads to 8. A 26-character typing probe used 5 writes/previews in
  858 ms instead of 26/26 after the final immediate-first-write correction.
- A Node v24.19.0 microbenchmark of 256 KiB native decoding measured about
  9.25 ms versus 0.26 ms per chunk, preserving every byte. This is not a
  physical-iPhone performance measurement.
- Root focused WebKit: 25 keyboard/safe-area/panel/media/inbox checks passed;
  27 settings checks passed; 11 native-network bridge checks passed; the
  later complete draft/ASR/mobile-home run passed all 28 checks. Image/file
  reader checks passed 9/9; diagnostics passed after waiting for the CSS hover
  transition; process-detail refresh/cancellation/scroll checks passed 6/6. Both
  Chromium offline-recipient journeys passed after the capability fix.
- Opus's isolated Chromium second pass: 268/270 passed. Its two remaining
  failures assumed the obsolete first-member group default; the corrected
  explicit-recipient fixtures subsequently passed in the root WebKit run.
  Earlier and independent sweep failures are retained for attribution rather
  than being counted as a clean full-suite result.

- Final focused unit pass: 37 files, 263 checks passed; root standalone build
  and client translation/typecheck/Vite build passed.

- Opus final follow-up: 35/35 Chromium and 35/35 WebKit passed, including
  corrected new UI fixtures, group mentions, offline recipients and drafts.
  The root independently passed the four new UI journeys in WebKit.
- The final native lower-form-focus fix passed 4/4 panel checks (including the
  new inner-scroll/caret regression), all 9 existing keyboard checks, the six
  viewport unit checks, client build and the iOS Release build.

## Acceptance boundaries

The physical device does not expose CoreDevice's screen-recording capability.
Instruments explicitly rejected the distribution-signed build because it lacks
`get-task-allow`. No physical CPU, memory or frame-rate profile is claimed.
The simulator comparison and browser probes must not be described as those
measurements.

App-lock/Face ID prompts, permission-denial recovery, APNs delivery, photo-library
write permissions, large HEIC/video exports, extreme attachment memory pressure,
real cellular/Tailscale handoff and VoiceOver/Dynamic Type need separate native
acceptance. Fast native history flings can briefly outrun the virtualized rows;
the observed view recovered after scrolling stopped, but the duration was not
measured. Landscape currently crosses the desktop layout breakpoint; changing
that layout contract requires a separate coordinated layout pass.

Known follow-up work remains: app-lock timing around temporary inactive states
and Face ID return needs an on-device reproduction before altering lock policy;
very fast history scrolling needs a debuggable-build trace; landscape and
VoiceOver/Dynamic Type need dedicated journeys. The startup script-budget check
already exceeds 700 kB on clean base `8e31175` (about 1.045 MB); this audit does not
claim that budget now passes. Browser suites run in multiple overlapping batches,
so their counts are not added into a fictitious full-suite pass.

The audit's candidate reports also contain design choices and conditional risks.
For example, the proposed missing KaTeX overflow rule was a false positive:
the existing rule and 320/430 px browser checks already handle it. Incremental
message patching, aggressive polling changes, and retention-policy changes
were not introduced without their separate ordering/recovery requirements.

## CLI and release impact

These changes concern App rendering, native shell behavior and client-local
cache/persistence cadence. They do not change Host API, protocol/schema,
permissions or CLI capabilities. Group text mention parsing is a client draft
operation; the CLI uses explicit recipients. CLI feature work is therefore not
applicable. Root and client builds are still required to catch shared imports.

This is a local owner-device test installation, not an App Store/TestFlight
release. The main repair checkpoint is `b0d18727f7273fe9ecfeae71cef58c6f3a3dcb7b`
(pushed to `main`). The subsequent lower-form-focus repair and this record are
tracked by the following commit. The final owner-device installation is 1.0.100
build 8; install/launch receipts and checksums are retained with the audit artifacts.

## Remaining audit findings

These findings were retained rather than labelled fixed:

| Area | Remaining work |
| --- | --- |
| Lists and low-frequency panels | Rename/delete polling, unrelated connection errors in delete confirmation, repeated search/network-panel reads, and inbox virtualization. |
| Large histories and files | Incremental message updates, large-diff virtualization, image cache limits, hashing off the main thread, chunk-memory peaks and actual fast-scroll frame timing. |
| Native transitions | App-lock/Face ID lifecycle; root pinch handling after the keyboard plugin replaces the scroll delegate; edge-back versus inner horizontal gestures. These require targeted native reproduction, not inference alone. |
| Product/accessibility | Landscape contract, Dynamic Type/VoiceOver, unread-count semantics, some system-confirmation styling and lower-frequency copy/visual consistency. |
| Permissions and delivery | Photo/HEIC/video export, permission denial, APNs and cellular/Tailscale handoffs remain separate native acceptance journeys. |

The complete independent review includes candidate IDs, source pointers,
withdrawn findings and proposed follow-ups. Its intermediate status labels must
be read together with the root's final physical evidence above. This audit does
not certify that every candidate defect or performance limit has been eliminated.
