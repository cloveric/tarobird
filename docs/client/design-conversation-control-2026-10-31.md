# Design control from separate conversations (2026-10-31)

Scope: follow-up to the owner's clarification that the audit concerns Bot control
of baoyu Design from different conversations, not only manual canvas editing.
Base: `e321706df6a19516478cfa1c790676e11754c4e1`. Source-only; no release or App replacement.

## Ownership and actual behavior

GG1 checks the actual App, IndexedDB, DesignSession and multi-page browser command
path. Claude Opus 5.5 independently audits the Host/Gateway/CLI authorization and
target selection; its probes and review are in the evidence directory below.
GG1 owns production fixes and browser/socket regressions; Opus owns the two Host
routing regression files. Findings and ownership were exchanged before edits.

A design belongs to a device-local `[host public key, user, conversation]` scope.
Even the same Bot in two conversations gets separate projects and receipts.
An authenticated Bot command gets its conversation and human author from its
currently dispatched user turn. Tool arguments cannot substitute a different
conversation or user. A device/window/tab must belong to that same user's
registered target in that conversation; choosing among those valid targets is
supported. Different Bot engines use the same Host boundary; this audit does not
run actual model requests.

The intended conversation's Workbench must be open/visible and support Design.
Hidden or unavailable targets are refused; requests are not redirected to another
open conversation. Multiple eligible windows require a specific window. A window
reload, closed tab or replaced registration invalidates stale targets. Designs
are not synced between devices; an explicit remote target selects the device that
actually holds the content.

## Confirmed bugs and fixes

### C1: a missing tab could overwrite the newly active design

The Host filled a missing `tabId` from the live active tab. Two new designs both
start at revision zero, so their revision checks do not establish identity.
Opus reproduced dispatch to B after reading A; GG1 independently reproduced an
actual Chromium editor accepting and saving A's content into B, even though the
turn had frozen A (`target-red.log` and its trace).

- `design.publish` now requires a full explicit `deviceId/windowId/tabId`.
- `design.read` requires that target, or can use the exact complete target frozen
  with the user turn when the request target is entirely omitted.
- A partial explicit target cannot borrow fields from context. Neither operation
  guesses the live active tab. Missing identity returns `workbench_target_required`
  before command dispatch, with a readable App error.
- Creating a new design still targets a window; the Bot must retain the returned
  `result.tabId` for the next read/write. An older frozen context cannot silently
  select an earlier design for a new publication.
- Other content types' target contracts are unchanged in this focused fix.

### C2: a create retry lost the design's identity

Create replay dropped `result.tabId`, preventing safe follow-up targeting. Opus
reproduced this on the base with the request shape used by actual Bot entry points;
the authenticated socket regression also covers retaining this ID on a retry.

A saved Design-create receipt now retains only its validated, bounded
`tabId`, never arbitrary files, text or result bodies. Older receipts that never
stored a tab ID are not filled with a guessed identity.

An initial direct-broker probe also replayed a previous turn's success. Final
review narrowed that finding: actual Gateway/CLI Bot requests already include
`contextMessageId` in the fingerprint, so those entry points already refuse
cross-turn ID reuse. It is not a reproduced normal Bot-path failure. Comparing
the authenticated actor's `sourceMessageId` in both flights and journals is
additional broker protection, not a claim that the normal Bot path was vulnerable.
The journal key and fingerprint algorithm stay unchanged for legacy retries.

The shared App/CLI guide states that example IDs are placeholders: every new
action needs a fresh ID; a retry keeps its original ID and arguments within the
same turn. For an uncertain result from a prior turn, inspect targets/content
first rather than reusing its ID as a new action or blindly retrying a write.

### Follow-up caught during review: a refused target was reported as unknown

The new early missing-target rejection threw before dispatch, but the App tool
classified channel exceptions as an uncertain outcome. A focused negative test
confirmed `unknown` instead of `not_executed`. The tool now recognizes this exact
Host rejection and explains how to choose a complete target. A connection failure
still reports `unknown`; the fix does not turn uncertain writes into safe retries.

## Regression evidence

- Final focused regression: 7 files / **109 tests passed**, including Host
  targeting, authenticated sockets, CLI tools, bounded history and App controllers.
- **Chromium 12/12 passed** across Design integration, prior audit and new routing
  suites; **WebKit 4/4 passed** for the new multi-conversation/target routing suite.
- Host/standalone CLI build and client build both passed.
- Opus independently ran the 16 routing cases plus 18 existing Host cases:
  **34/34 passed** on the candidate; the base commit failed 9 of those cases.
  Those 34 are a subset of the 109 above, not an additional total.
- Browser negative reproduction used actual upstream editor and IndexedDB;
  it returned `applied`, `saved:true` for the wrong tab before the fix.
- Browser matrix covers the same Bot in two conversations using identical request
  and tab IDs, concurrent saves, persistence after reload, foreign-target refusal,
  frozen selection, hiding before admission, duplicate windows, concurrent revision
  conflicts, closed-window refusal and partial-target rejection.
- The signed-socket case uses an authenticated test Bot connection and user turn,
  then verifies foreign conversation/target refusal, exact publish/admission/receipt,
  and refusal after the turn ends. It uses a simulated App peer, not a model.

Browser automation uses real Hub/App/editor/storage, while the browser fixture
calls the broker with a test actor. Signed-socket tests separately verify actual
authentication. Do not combine these into a claim of physical multi-device or
real-model acceptance. No production designs, conversations or permissions are
modified. Real phone/desktop cross-device operation and Host process-crash
recovery mid-command remain outside this run.

Markdown still supports live active-tab fallback. This Design-focused change
does not alter that separate compatibility contract or claim to have resolved
its analogous target-selection risk. The App storage/isolation evidence above
comes from GG1's browser runs; Opus independently reviewed the Host boundaries.

CLI impact: the existing `tarobot workbench run` and native `app_workbench` use the
same Host checks and shared guidance; no new command or permission is introduced.
These Host fixes require a future Host update; changing source does not change
the currently installed App/Host.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/design-conversation-control-20261031/`.
