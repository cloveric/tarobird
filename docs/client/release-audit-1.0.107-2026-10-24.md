# October 24 App/CLI release audit

This audit covers the unreleased changes after App 1.0.106 / Host 0.1.453
(`4a88efc`), including Claude native input, grouped background tasks, discussion
recovery, pending queues, side conversations and message reading. The initial
reviewed integration was `3f75c3e`. The release target is App **1.0.107** and
Host/standalone CLI **0.1.454**, with wire protocol 1 and Hub schema 21 retained.

Codex performed the integration review and actual Claude Opus 5.5
(`claude-opus-5-5[1m]`, xhigh) independently reviewed engine behavior and rendered
phone/desktop interfaces. Findings below distinguish reproduced failures from
unmeasured risks. Artifact publication and installed-runtime verification are
separate gates; this source audit does not itself establish either.

## Confirmed corrections

- **Task-list navigation:** a retained opening request reopened a closed task
  dialog when the conversation remounted after switching chats or leaving
  search. The request is now consumed once, with a matching-ID clear so a newer
  request cannot be erased by an older callback. Desktop and phone Chromium and
  WebKit journeys cover slash/menu opening, A/B return, search return and fresh
  deliberate reopening.
- **Desktop user tables:** inline-size containment removed the intrinsic width
  of tables inside shrink-to-fit user bubbles. A normal small table collapsed
  to a roughly 28px scroller. Keep the desktop density settings, but exclude
  user-bubble descendants from that containment. Tests include user messages,
  quoted tables, narrower windows and ADHD panes, alongside existing Bot tables.
  Native phone type sizes are unchanged.
- **Markdown heading emphasis:** a heading at weight 600 containing `**bold**`
  inherited the browser's `bolder` mapping and rendered that fragment at 900.
  Emphasis within h1–h6 now inherits the heading weight. Heading sizes, body
  emphasis, saved reading-size preferences and platform geometry are retained.
- **Graceful updates and Claude background work:** Core foreground idle did not
  imply native background idle. The Gateway now includes the adapter's existing
  task, review, continuation, stop-confirmation and delivery lifecycle in its
  existing worker blocker. It uses a read-only predicate, not a second registry
  or native polling. An additional review reproduced final scoped-card delivery
  still pending after the CLI exited; that existing close aggregate now remains
  counted after the retired worker leaves the session map. Rejection and success
  both release the counter. Other adapters default to no extra blocker, and the
  wire enum remains compatible. See [the drain regression](native-background-drain-2026-10-24.md).
- **Delayed background starts:** independent review then reproduced a gap between
  the foreground result and a later `task_started`. Existing explicit launch
  owners now retain a bounded start grace, anchored to their own foreground
  result or first launch acknowledgement. A follow-up probe also covers launches
  made while reviewing a completed background task; only that review may anchor
  them. Replayed acknowledgements, other turns/reviews and repeated idle checks
  do not extend the window; collected tasks do not revive.
- **Discussion recovery:** continuing a paused discussion refreshes only its
  undispatched held inputs, preserving their IDs and attempts and updating
  context/resources in the same transaction. Already dispatched inputs stay
  immutable. The paused summary names the actual held speaker. A failed
  independent answer also reaches paused immediately when the remaining inputs
  are unclaimed, without waiting for an event that can never arrive.
- **Forwarded group messages:** forwards and ordinary sends share the same
  discussion-addressing guard, so a forward cannot start parallel replies beside
  scheduled speakers. Duplicate receipts still win before the guard; no-reply
  sharing remains available. Explicit internal stance fence variants stay out
  of visible replies without stripping ordinary code. New folders remain before
  a visibly trailing Unfiled section even when another folder is pinned.
- **Claude native input:** native ordinary/send-now handling is scoped to direct
  chats; groups retain their group-send and explicit steering behavior. Worker
  replacement retires stale queued/dequeued receipts to unknown/engine-exit,
  using the worker's stable attach time rather than socket reconnect time.
  Terminal model receipts stay terminal, and journal replay cannot resurrect an
  old queued state. A control never written to the CLI is a definite rejection;
  a written but unanswered control remains uncertain and is not repeated.
- **Receipt presentation:** controls appear only for inputs still held by the
  CLI. Rejected native admission and engine exit have distinct explanations;
  editing a draft during preflight reports that it was not sent and keeps it.
  CLI control hints now use the actual message/request identifiers.
- **Background status:** collecting a failed subagent through `TaskOutput` now
  reports failure consistently with native task notifications, rather than
  leaving the task in an unknown state. Public process records remain separate.
  A finished group deliberately expanded by the user also preserves that
  disclosure when virtualization remounts it. The bounded per-Host/group view
  cache does not override a later transition from running to finished.

## Retained behavior

The owner explicitly requested open temporary side conversations. Codex side
network access remains enabled, with the configured file sandbox and no borrowed
main-turn approval UI. Documentation describes these overrides precisely instead
of claiming every permission is inherited. No extra approval flow or read-only
default is introduced in this audit.

Older Claude CLIs without model-consumption evidence continue to say that receipt
cannot be confirmed. A native CLI acknowledgement is not promoted to model
consumption. Older Hosts without atomic discussion-recovery support retain safe
refusals for operations whose supplement/new-topic meaning cannot be preserved;
the draft stays intact instead of silently changing the requested operation.

## Acceptance scope

Browser evidence uses rendered mobile-width and desktop layouts; it is not a
physical iPhone, Android or Windows installation receipt. Existing native-input
acceptance also exercises actual local Claude Code 2.1.309 with isolated paired
clients: ordinary input does not interrupt the active tool, withdrawal uses the
native unconsumed-message operation, send-now uses native control, ordered model
receipts remain distinct from CLI acceptance and the background agent survives.
These checks do not remove the documented differences between the terminal's
keyboard UI and its stream-json protocol.

Two baseline browser failures were traced to test readiness: a group test sent
before the saved discussion mode reached its composer, and a quote test chose
the preceding reply before the new reply rendered. They now await the intended
UI state. A separate WebKit reload probe also observed a 40–100ms initial
layout-restoration window in which an early wheel can be overridden. The
background-card recovery check waits for that restoration to settle; this does
not claim to repair or rule out the early-input window. It reproduced before
this audit's disclosure change and is recorded as a retained first-render limit.

The mounted-but-offscreen task-dock browser fixture now first establishes
enough scroll extent and enters history-reading mode. This avoids mistaking a
still-visible card or browser-clamped scroll offset for an observer failure. The
final fixture passed four consecutive Chromium and four WebKit runs, including
dock appearance, navigation back to the card and dock disappearance.

The installed 0.1.453 Host predates this audit. Any update from it must account
for native work before starting its old drain path; the new package cannot
retroactively change the running old worker. No force stop is authorized as an
update shortcut. Final release verification must record publication, canonical
CLI clean install/upgrade, package checks and local activation separately.

Read-only installation inspection also found that the shell's `tarobot` launcher
still selected a separate versioned **0.1.430** installation while the App used
Host **0.1.453**. Updating the App does not update that independent symlink.
The local update must therefore verify and switch the terminal installation to
the published canonical 0.1.454 package as a separate step, retaining its Node,
launcher and previous version. It must not install a second Host service or
change the App's selected state directory.
