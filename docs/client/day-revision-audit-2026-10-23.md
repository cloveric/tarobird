# October 23 revision audit

The reviewed range is `b78df401809ab7703ac31435ac6f63f4aa2eee17` through
`9a46482cac7f90b0061e71a18e83b44c9fdea83d`: 27 commits touching 131 files,
after the 1.0.105 audit. It includes mobile scrolling, keyboard and motion,
image viewing, temporary side conversations, platform-specific sizing,
network presentation, stream ordering, group discussion input and ADHD exit
selection.

The independent reviewer was CC1 using `claude-opus-5-5[1m]` with `xhigh`
effort. Review and reproduction ran in separate worktrees. All changes here
are source changes; no installed App or production Host was replaced or
restarted during this audit.

## Confirmed corrections

### Group input and discussion resources

- Discussion retries now belong to the retained draft, rather than matching
  only its text, attachment IDs and quote. Editing or clearing and retyping
  creates a new send intent, so a later identical note cannot replay an old
  discussion start. An unchanged draft retains its original request ID across
  reloads, including when the original discussion has since ended.
- The draft remembers which discussion it was intended to supplement. If that
  discussion ends while the user is writing or recording, the input is kept
  and requires an explicit choice of destination; pressing Send again does not
  silently launch another round of Bot work.
  Recovery labels follow the current destination: a running discussion, a new
  discussion, or the current ordinary reply mode. They do not promise a new
  discussion when the group has already returned to ordinary messaging.
- As a narrow interaction refinement, changing an existing draft between
  ordinary replies and automatic discussion also requires an explicit rebind.
  This avoids treating a group-settings change made on another device as a
  decision to turn a one-Bot question into a scheduled group discussion, or the
  reverse. Changes within the same reply category do not add a confirmation;
  unchanged uncertain requests still replay before this check.
- Local cleanup failures after a confirmed Host response are reported as local
  cleanup failures, not as failed sends. Corrupted local send state has an
  explicit review-and-retry exit rather than a refresh loop or automatic replay.
  Temporary local-write failures can be retried; local attachment-cache capacity
  limits do not prevent uploading an otherwise valid attachment from memory.
- The combined-code review found a further cleanup race: clearing a sent draft
  could overlap a new edit, making that edit conflict with the same window's
  own clear operation. A same-text replacement could also lose its unsaved
  warning and disappear after reload. Cleanup and subsequent writes now share
  one ordered queue, and unsaved-state cleanup compares the draft identity.
  The returned local clear revision is adopted without bypassing a genuine
  other-window conflict.
- Ordinary offline group sends use a Host-scoped cache of the last confirmed
  reply mode. A new optional `groups.reply-guard.v1` contract checks the mode,
  settings revision and absence of an active discussion inside the Host send
  transaction. A changed mode or membership retains a failed outbox item without
  inserting a message or scheduling Bot work. An already-accepted request is
  replayed before this check so retrying it does not duplicate delivery.
- A mode or active-discussion change during attachment upload could leave the
  send using an earlier recipient decision. The composer checks the latest
  observed context after asynchronous work and retains the draft when it has
  changed. An unchanged pending request still retries its original request ID.
- CLI `groups note` incorrectly required a text file even for an attachment-only
  note. It now accepts text, attachments, or both, uses the same Hub endpoint and
  validation, and still rejects empty input.
- Scheduler inputs retain the file references needed by later speakers, but
  those internal references no longer appear as repeated user shares in the
  conversation file list or either history-search API. The original message
  remains the visible source. Personal deletion affects that reader's listing;
  it does not revoke resources already shared with participants. An explicit
  later resend remains a separate visible share.
- Group settings explain that an active discussion retains its original policy;
  changes apply after it ends. Switching to parallel replies requires ending
  the discussion first. The hint is conditional and does not imply that an
  inactive group must wait for a discussion to finish.

Offline compatibility is explicit. Cached ordinary sends to a modern Host keep
their guard on retries and require a capable handshake before replay. Truly
legacy Hosts retain ordinary offline sending with a local marker removed only
after confirming a legacy handshake; upgrading the Host cannot silently discard
that marker. A discussion-capable Host without the new revision guard retains
online compatibility, but offline sending keeps the draft with an update hint.
Unknown or automatic discussion modes retain the offline draft instead of
guessing recipients. Internal mode caches and pending-send records are excluded
from user draft counts and previews.

### Mobile forms

- An already-open native keyboard could keep the same reported height while
  the window became shorter. The focused New Bot workspace field then fell
  below the visible area. Window resizing now rechecks the focused form field
  in that case. The conversation composer is excluded from this form-reveal
  path, and an already-visible field is not unnecessarily scrolled.
- The New Bot creation form now uses the existing fixed-header/scrolling-body
  dialog layout, keeping its title and close action reachable in a long form.
  The post-creation stage retains its existing layout.

Neither correction changes the accepted Android or desktop sizing, nor the
separate iPhone sizing policy in `AGENTS.md`.

### Test harness corrections

These are not counted as product failures:

- The native image-viewer unit fixture lacked the browser motion globals added
  by the motion preference integration. The fixture now supplies them and
  checks both normal bar transitions and reduced-motion/no-animation behavior.
- A side-conversation navigation test asserted the preparation count before
  asynchronous preparation had completed. It now waits for the exact count,
  while retaining the per-conversation draft, answer, disposal and duplicate
  preparation assertions.

## Review decisions

The initial independent report is a set of findings to verify, not a release
acceptance receipt. Two suggested fallbacks were intentionally not adopted:

- Side audio transcription failure remains an explicit failure before a model
  turn. A fake engine accepting an arbitrary path does not demonstrate native
  audio understanding. Codex's side `files:any` handling passes non-image files
  as paths; Claude and Kimi advertise text-file support. The ordinary main audio
  path also stops on transcription failure. The separate document-media
  fallback has upload and cloud-policy constraints and is not a safe implicit
  fallback for a temporary side conversation. This does not establish physical
  microphone or production ASR acceptance.
- An older Host without `groups.discussion.composer.v1` keeps the update hint
  for exact-run notes. Falling back to an unaddressed ordinary message would
  lose the binding to the discussion the user intended to supplement.

The ADHD exit-selection and stream-fragment-order changes were reviewed without
a confirmed additional defect. Settings taking effect after an active discussion
are intentional and are now explained in the UI.

The independent closure review reached product revision
`3244cebbbc630cb7419023f331b16f2343f0e4ca` and reported no remaining blocking
finding in its reviewed scope. Its final Chromium run passed 13 focused cases,
including its own original repros, Host rejection of an unobserved mode change,
the draft-cleanup race and reply-category changes. It retained the two fallback
decisions above. A possible immediate post-send edit inheriting the previous
target remains a conservative interaction boundary: the user may need to choose
the new destination, rather than the input being silently delivered elsewhere.

## Validation boundaries

The first integrated full Host suite passed 458 files: 6,246 tests passed and
5 skipped, after building the Host. After merging the Host send guard, the full
suite passed **459 files: 6,253 passed, 5 skipped** on `8770ba9`; subsequent
corrections affect App draft handling and labels, not Host behavior. Focused
coverage included the CLI, discussion scheduler, attachment visibility and both
search APIs. Native Rust
tests passed 77 tests after preparing the bundled Host resources; the initial
attempt without those resources failed and is not counted as acceptance.

Browser coverage used Chromium and WebKit, including group discussions, ADHD
focus handoff, network settings, side input and navigation, image viewing,
mobile creation/keyboard behavior, reading stability, density and motion.
Browser keyboard geometry uses simulated native events. Test Hub/Gateway
instances and scripted engines verify routing and delivered file bytes, not
production model quality.

The integrated ten-spec group/settings/offline/draft/voice run on `6feb3e6`
passed **104 Chromium cases** and **102 WebKit cases**. The two WebKit skips
require Chromium's trusted-touch injection protocol; neither is a skipped
product failure. On final product revision `3244ceb`, the focused upload/retry,
ended-note, cleanup-race and reply-category run passed **10 cases in each
engine**, with the final client build also passing. This records the later
changes separately rather than claiming the entire earlier suite ran on a later
revision.

Earlier focused checks in the same audit included:

| Area | Result |
| --- | --- |
| Mobile keyboard, creation and Bot catalog | 20 passed in each engine |
| Mobile reading stability | 24 passed in WebKit |
| ADHD focused-conversation handoff | 7 passed in each engine |
| Network manager and target handling | 48 passed in each engine |
| Images and temporary side input/navigation | Chromium 40 passed, 1 engine-specific skip; WebKit 34 passed, 7 engine-specific skips |
| Image/side focused unit tests | 55 passed across 8 files |
| Host/CLI discussion and runtime focus | 120 passed across 7 files |

These are separate focused runs, not additional unique-test totals to add to
the full Host or final browser suites. Host/client builds, translation checking,
commit-identity checks and secret scanning also passed. The client build retains
the existing nonfatal Capacitor keyboard static/dynamic-import warning.

There was no new physical iPhone/Android gesture or keyboard acceptance, no
installed macOS/Windows GUI acceptance, and no live production-model or ASR
acceptance in this source audit. Previously recorded release/device receipts
are not treated as acceptance of these new changes.

## CLI impact

Attachment-only discussion notes are a shared Host feature and have a CLI
correction and regression. Attachment listing/search corrections use the shared
Hub rules. The optional revision guard protects an App's cached send decision;
existing online CLI callers keep the same wire/API compatibility and do not gain
a separate offline queue implementation. Mobile form presentation, animation
fixtures and local input state do not require a separate headless UI command.
App and CLI releases must still
be built and published from the same final source under the release checklist;
this source audit does not publish either package.
