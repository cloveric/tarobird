# Async questions and answer delivery

Codex `request_user_input_async` was routed through a legacy choice-card path.
It displayed only the first question, repeated a title-only prompt as the card
heading and body, and produced no controls for a free-text question. Real
Codex 0.162.1 emits `options: null` when no choices are supplied.

The App now uses its existing native question form for all questions in the
request, including optional/missing/null options and free-text answers. Native
request IDs deduplicate repeated events. Repeated prompt text remains distinct
in the answer map. Delivery waits only for presentation; it does not block the
engine until the user responds. Historical single-paragraph cards whose title
exactly repeats their body display that text once; no historical request is
reconstructed or submitted automatically.

## Lifecycle and queue behavior

- A live origin receives the answer through steering, ahead of ordinary queued
  messages. The answer never queues behind its own still-running origin.
- After normal origin completion, one follow-up joins the existing conversation
  queue. Follow-ups now handle additional async question events as well.
- Questions retain their originating turn when it runs alongside a background
  goal. Answers still steer that turn after the goal ends and promotes it; after
  the originating turn ends, answers queue without entering a newer turn or the
  goal itself. The question's cancellation signal belongs to its originating
  turn, so a normally completed origin leaves the form available.
- Duplicate submissions and taps on replaced forms cannot dispatch again.
  A definite rejection produces a fresh form with the entered answers retained.
  An uncertain transport result closes the form with an explicit uncertainty
  notice and the answers; it does not automatically retry or enqueue a duplicate.
- Stop, timeout and Gateway disconnect close pending async forms, including those
  whose origin already completed. Cancellation during a binding read or submit
  cannot be acknowledged as successful. Session identity/binding is rechecked
  before delivery and before a queued follow-up starts.
- The timeout message no longer claims a default was chosen. No default answer
  is fabricated. Blocking native questions continue to use their existing
  approval-response path.

Pending engine questions are process-scoped. This change does not reconstruct
pending questions after a host crash, and does not claim transactional delivery
across a process crash. A late answer cannot revive a stopped origin; users can
send a normal message to continue. The existing durable client outbox and
at-most-once Gateway interaction receipts remain in use.

## Verification

- Full standalone build and 222 core test files: 2,871 passed, one opt-in test
  skipped; both the release hook and bounded worker run passed.
- Nine focused async regressions cover free text/null options, multiple and
  repeated questions, event deduplication, concurrent submission, queued
  ordinary messages, completed origins, nested questions, definite rejection,
  uncertain delivery, stop races, changed bindings and disconnect cleanup.
- 30 relevant legacy question/choice tests passed without restarting services.
- Chromium: question drafts, validation, cross-device submission, card layouts,
  steering and stop regression journeys; the async offline test explicitly
  waits for IndexedDB persistence before reload. WebKit: the same question
  journeys, including offline reload and exactly one answer after reconnect.
- Real Codex CLI 0.162.1 / gpt-6-astra: paired desktop and phone-sized browser,
  native async free-text request, normal origin completion, phone form answer,
  resumed same-conversation reply containing that answer, card closed on both
  devices. Only isolated temporary Bots and workspaces were used and cleaned.
- Physical Android installation, keyboard behavior and cellular reconnect are
  not claimed by browser or installer checks.
- The 2026-10-13 source regression adds six isolated Hub/Gateway cases covering
  completed message/card origins alongside a surviving goal, a newer attached
  task, and live-origin steering before and after actual goal completion.
  Stopping only a pending completed-origin form also returns `stopped: true`
  and records a successful command with the cancelled question count.

Phone form (historical image omitted from this clean snapshot) ·
Submitted answers (historical image omitted from this clean snapshot) ·
Real Codex form (historical image omitted from this clean snapshot) ·
Real Codex reply (historical image omitted from this clean snapshot) ·
[Engine receipt](../evidence/async-questions-2026-10-12/real-codex-receipt.json)

## Installers

Prerelease `v0.1.408-test.1`: Android version code `2026101223` keeps the
existing signing certificate; macOS App `1.0.35` embeds host `0.1.408`.
The signed APK matches all 372 prepared web assets. The sealed App mounted
from the final DMG matches all 664 prepared host/client files and includes
the freshly compiled frontend. Launcher icons were verified from both final
installers. The standalone tarball was installed and checked outside the
repository. These checks establish package contents, not physical-phone
acceptance.

[Package receipt](../evidence/async-questions-2026-10-12/package-receipt.json).
