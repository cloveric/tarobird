# Native question experience

The client now gives engine-originated `AskUserQuestion` requests a dedicated
question UI. Codex's native `item/tool/requestUserInput` and standard MCP forms
already enter this path through their schema normalizers; answers still return
through the existing authenticated Hub/Gateway action and native request IDs.

## Interaction

- Visible radio/checkbox option rows keep each option's explanation beside it.
  Native keyboard selection, touch targets, light/dark themes and multiline
  custom answers share one renderer.
- Multiple questions have progress, direct navigation and previous/next buttons.
  Moving between questions, changing conversations and reloading preserve local
  edits and the current question. No option is preselected by this UI.
- Local required/minimum/maximum checks precede submission. Single-choice custom
  text clears an earlier selection; selecting an option clears custom text.
  Multiple-choice custom answers count toward selection limits.
- Submit queues one durable action and locks repeated taps. The UI distinguishes
  waiting for confirmation from success. A failed action uses the existing
  outbox retry/removal controls; submitted values are recovered after reload.
- The shared final/cancelled/expired card replaces the controls on all connected
  devices. Answering a question does not grant tool or session permissions.

The shared constructor adds optional versioned metadata only under the Gateway
channel profile. It retains ordinary form elements and the original callback for
older clients. Feishu's rendering and engine response formats are unchanged.
Kimi questions remain limited to the options its native protocol accepts.

## Scope

This is a focused UI improvement, not a claim of full Codex desktop parity.
Unsubmitted drafts persist in this device's IndexedDB; they are not synchronized
to another device and never auto-submit. Already queued answers are recovered
from the durable outbox before controls unlock, preventing a second submission.
Both devices receive the authoritative submitted/resolved card as before.
Legacy asynchronous `request_user_input_async` choice cards remain a separate
path. Native secret questions and URL/authentication elicitation keep the
existing unsupported behavior; this UI does not collect credentials.

The opt-in real-Codex fixture enables `default_mode_request_user_input` only for
its own CLI process. This change does not enable that feature globally. Browser
tests and a real local CLI run do not substitute for signed iOS/Android container
acceptance or real phone-network testing.

## Verification entry points

- `tests/gateway-cards.test.ts`, `tests/gateway-card-states.test.ts` retain complete
  constructor/callback and retry/retirement fixtures.
- `client/e2e/questions.spec.ts` exercises actual shared question handling,
  custom-answer precedence, min/max limits, navigation, keyboard selection,
  a deliberately failed submission, reload/retry and two-device resolution.
- `client/e2e/cards.spec.ts` and `cross-device.spec.ts` cover Claude/Kimi choices,
  Codex MCP typed responses and existing cross-device behavior.
- `client/e2e/live-codex-input.spec.ts` provides opt-in real CLI evidence for
  questions, MCP confirmation/forms, stop and exact file delivery.

Run the client build before browser tests; run the root build before the real
managed-worker fixture.

## Acceptance, 2026-10-02

- Mandatory root gate: **3,421 passed, 1 skipped across 219 files**, followed by
  a successful root build (`/tmp/t/tarocub-native-questions-complete.log`).
- Final client translation, TypeScript and Vite build passed
  (`/tmp/t/tarocub-native-questions-client-build-final.log`).
- Chromium: **10 passed**, covering cards, cross-device sync, questions, recovery
  and stop. The question flow passed again after the final UI corrections
  (`/tmp/t/tarocub-native-questions-chromium-final.log` and
  `/tmp/t/tarocub-native-questions-chromium-verified.log`).
- WebKit: **10 passed** after the final corrections
  (`/tmp/t/tarocub-native-questions-webkit.log`).
- Real **Codex CLI 0.160.0**: the native input/MCP flow passed in **1.2 minutes**
  (`/tmp/t/tarocub-native-questions-live-codex.log`). The phone's answer reached
  the model; stopping retired controls on both paired browser clients; a new
  turn completed. Native MCP confirmation and two-question input produced the
  exact nonce-bearing file, downloaded and checked on both devices. Cancelling
  the next MCP form produced no additional file write.
  Machine-readable receipt（本地材料：`evidence/native-question-live-codex-2026-10-02.json`）.

Review found and fixed a transient mismatch between the previous question's
Markdown and the next question's choices. Queue status now distinguishes saving
locally from a successfully persisted submission. A failed submission followed
by reload and retry resolves exactly once; both clients retire the controls.
The initial Chromium failure was an incorrect MCP header selector, corrected
before the successful run. No root source changed after the mandatory gate;
the later client fixes were rebuilt and verified in both browser engines.

## Local draft recovery, 2026-10-03

A browser regression reproduced the loss of unsent answers/current-question
position when changing conversations. Drafts now use message ID, native request
ID and a hash of the question schema. Changed questions, option order, selection
limits and a replacement request therefore cannot reuse stale choices. Notice
updates alone preserve the draft. Native retry-form defaults still initialize
forms without a local draft.

Draft writes are ordered; a remounted form waits for the last scheduled write.
The cache checks its current Hub/device identity and whether the matching form
still exists inside the same IndexedDB write transaction. Message updates and
atomic snapshot replacement remove drafts for resolved, deleted, disabled or
replaced forms. A late component save cannot recreate them. Local reset continues
to fence old pages and clears drafts with other private state. Ordinary config
cards do not inherit question drafts.

Storage failure is displayed without inventing a successful save. A failure to
read pending answers keeps controls disabled and offers a reload action. The
local save path sends no Hub action, creates no model session and changes no
engine/native answer schema.

Both Chromium and WebKit passed 17 focused cases: native questions and failed
submission retry, per-form draft isolation/cleanup, cross-device interactions,
local reset, snapshot recovery, streaming, long messages and topic navigation.
See validation and build receipt（本地材料：`evidence/question-drafts-2026-10-03.json`）.

The mandatory root gate passed with 3,542 tests and one skipped across 227 files,
followed by the root build. Its first run had one Tingwu SIGTERM timeout; that
three-test file passed in isolation and the complete gate passed on rerun without
code changes. The cause of the initial timeout is not established. The client
build also passed, and all 95 frontend files match both mobile shells' copied
assets. These are asset copies, not Android/iOS native compilation.

Draft-recovery captures: desktop（本地材料：`screenshots/question-drafts/native-question-desktop.png`）,
phone（本地材料：`screenshots/question-drafts/native-question-phone.png`）,
dark phone（本地材料：`screenshots/question-drafts/native-question-phone-dark.png`）.

Earlier inspected captures: desktop（本地材料：`screenshots/native-questions/native-question-desktop.png`）,
phone（本地材料：`screenshots/native-questions/native-question-phone.png`）,
dark phone（本地材料：`screenshots/native-questions/native-question-phone-dark.png`） and
real Codex question（本地材料：`screenshots/native-questions/codex-question-phone.png`）.
The real MCP form（本地材料：`screenshots/native-questions/codex-mcp-form-phone.png`） and
stop result（本地材料：`screenshots/native-questions/codex-question-stop-desktop.png`）
are also retained. These are browser viewport captures, not native phone
container acceptance.

## 2026-10-04 phone focus follow-up

A real Codex MCP form exposed delayed RAF focus stealing typed input after Next.
The final UI uses an incrementing focus state and a layout effect, so repeated
same-step navigation/validation commits focus immediately without waiting for
later typing or cache work. A ref-only intermediate repair failed the quiet
connection / delayed storage fixture. Initial load and draft restoration do not
focus the heading. Opus 5.5 xhigh reviewed both the intermediate and final fix;
the final code passed two-browser regression and real Codex native forms. See
[the phone/CLI audit](live-mobile-2026-10-04.md) for failures, successful receipts
and physical-device limitations.
