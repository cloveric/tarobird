# Bot collaboration: preparation, task selection and recovery

The task picker previously hid Bots that lacked reciprocal permissions, leaving
an empty selector and a disabled send button. Configuring a Bot left the task
dialog, while parallel, chain and review modes could only use saved workflows.

## User flow

- Show the current host's managed members even before authorization. Explain
  missing outgoing/reciprocal permission, unavailable members and offline
  listeners separately. With no peers, offer **New Bot** and retain the draft.
- Review and prepare only the chosen relationships. Grant the coordinator and
  each chosen member reciprocal access, retaining existing grants, default
  workflows and advanced settings. This is an explicit configuration action;
  it never sends the task. Unconnected services use the existing idle restart.
- Choose a delegate, parallel participants, ordered chain or reviewer for each
  task. These choices do not overwrite default workflows. Parallel mode includes
  the initiating Bot; chain steps receive the original prompt and previous result.
- Edit advanced settings inline and return to the same draft, mode and order.
  Unsaved settings retain their existing leave guard.
- Recheck readiness at send time. If another device revokes access, removes a
  member, or changes a legacy Hub's saved plan, retain the draft and require review.
- Keep the send action outside the scroll area. Phones use a full safe-area
  viewport and scroll the focused task field into view when the keyboard opens.

## Protocol and failure behavior

`CollaborationSnapshot.taskSelection` advertises explicit per-task plans.
`/fan`, `/chain` and `/verify` accept `--bots=id1,id2 -- <task>`; legacy commands
remain supported. The delimiter preserves multiline task text. IDs, duplicate
members, self-delegation, member count and coordinator permissions are validated
before local or delegated engine execution. The Bus still checks both sides of
authorization on the actual request.

Configuration uses the existing owner-only revision-checked API. All participants
are read and validated before any writes. A partial failure retains confirmed
writes and does not start services before all writes finish; it does not roll
back newer changes from other devices. Retry receipts prevent duplicate restart
requests. Unmounting aborts outstanding preparation and prevents later writes.
Uncertain message-enqueue retries reuse a stable ID for the exact same payload.

Parallel failures are reported as partial results and audited as errors rather
than success. A failed or stopped chain keeps completed stages and their actual
count. Review failure retains the original answer marked unverified. Cancellation
is checked before starting and between chain/review stages. Side questions now
also pass the abort signal to the engine.

## Acceptance and boundaries

- Focused Vitest: `collaboration-task`, `telegram-delegation-commands`,
  `hub-collaboration`, `gateway-bus` — 45 tests passed.
- Root standalone build and client type, translation and production build passed.
- Chromium and WebKit desktop/phone journeys: `collaboration-setup`, `delegation`
  — all three journeys passed on each browser after fixes.
  Setup uses a real isolated Hub, managed workers and actual idle restarts; it
  verifies minimal reciprocal grants, untouched unrelated Bots/defaults,
  retained drafts/order, safe insets, keyboard viewport and zero implicit sends.
  Delegation uses an actual local Bus with deterministic engine responses to
  verify all four modes, duplicate names, original source preservation, final
  permission checks, older-Hub plan changes and offline cache recovery.
- Existing advanced collaboration editor journey also passed in both browsers.

The shared Bus path is engine-independent (Codex, Claude, Antigravity, Kimi and
DeepSeek); these tests do not claim fresh live calls to all five CLIs. No real
user Bot configuration was changed. Android/Windows native-device acceptance
and installer publication are separate from these source/build/browser checks.

This implementation supports **same-host text collaboration**. Network membership
does not create cross-host Bus routing, and task selection does not silently
share conversation history or attachments. Delegated results still use the
existing result messages; this change does not introduce a native per-member
streaming timeline or resumable workflow engine. The existing five-role research
crew remains in advanced settings and is not converted into a new task mode.
