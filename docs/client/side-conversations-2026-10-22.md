# Temporary desktop side conversations

The side panel answers related questions using the current direct conversation's
native model context. It is separate from the main message queue and transcript.
The desktop header button, `Cmd/Ctrl+Shift+K`, and local `/side [question]` command
open it. A question supplied after `/side` becomes an editable draft; opening the
panel does not send it. Phone, tablet, ADHD panes, groups, topics, archived chats,
read-only host views and engines without the required native capability have no
side entry.

The panel supports follow-up questions, Markdown, code, tables, copy, explicit
insertion into the main draft, its own Stop action, attachment upload, and restart
with fresh parent context. Inserting a response never sends the main message. Closing clears the
panel and disposes its engine handle. Switching conversations preserves each
conversation's open panel, draft text, attachment draft, scroll position and ongoing
answer in memory. Returning restores that conversation's panel. Hidden panels
keep their lease alive at a low polling rate; explicit Close, reload, entering ADHD, host removal,
archive or a model/runtime change ends them. Opening conversation details or search temporarily
hides it. The header button or shortcut reveals it without clearing its history or draft; closing search restores focus to the search control. Returning to a conversation with an open side panel dismisses another conversation's details so that its own panel is visible again.
Narrowing a desktop window hides the panel below 761 px; it can reappear when
widened. Above that breakpoint the conversation directory stays visible and
clickable alongside the main and side chats. The side width is adjustable up to
600 px; its usual 320 px minimum contracts to 280 px in compact windows, while
reserving at least 200 px for navigation and 280 px for the main chat. Both
splitters follow these shared limits. Compact main headers and composer controls
wrap into rows so the title, model/effort controls and Send remain usable.
Returning to a conversation does not replay its earlier request to focus the
side input. Explicitly opening or revealing the panel still focuses it. A
disconnected panel reports retained content without promising that an expired
native session can resume.

The navigation/layout correction is client presentation only: it changes no
Host capability, native session contract or CLI behavior. Browser regressions use
an isolated real Hub/Gateway with a fixture model adapter, including 1196 px
A/B navigation, independent drafts, attachment bytes, background-answer leases,
scroll restoration, explicit close and widths down to 761 px. This evidence is
separate from installed native App or real-model acceptance.

## Engine support

The following native CLI versions were inspected and exercised on 2026-10-22.
Capabilities are adapter-specific; the model name alone does not enable the panel.

| Engine runtime | Native path | Opening while the parent is working | Temporary state |
| --- | --- | --- | --- |
| Codex app-server 0.163.0 | Ephemeral `thread/fork`, ending before the active parent turn | Supported | No side rollout; released with `thread/unsubscribe` |
| Claude Code stream-json 2.1.307 | Native `side_question` control request, equivalent to `/btw`; isolated unpersisted resume/fork when no live worker exists | Supported; live worker context includes the current turn | Side exchanges stay outside the parent transcript |
| Kimi ACP 2.3.0 | Native `session/fork` | Wait for the parent to become idle before opening; the parent can continue after opening | Fork is closed and deleted on disposal |
| DeepSeek Harness 0.2.1-rc.2 | Fork exists, but the inspected control API provides archive without delete | Not exposed | Cannot meet the temporary-cleanup contract |
| Antigravity 1.4.5 | Interactive `/btw` exists; no equivalent usable headless fork/side API was found | Not exposed | No transcript-based substitute |

The legacy Codex process runtime and one-shot Claude adapter also report no
side capability. Existing TaroBot `/btw` routing is unchanged.

Claude calls the interactive feature a
[side question with `/btw`](https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw).
Its headless process flags are documented in the
[CLI reference](https://code.claude.com/docs/en/cli-reference).
The Kimi session distinction is described in its
[session guide](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html);
Antigravity documents its interface in the
[CLI reference](https://antigravity.google/docs/cli-reference).

## Side attachments

The paperclip accepts files, while paste and drag-and-drop can add files directly
to the side composer. Mixed paste retains the accompanying text. A file-only
question is valid. Attachment drafts remain with their parent conversation when
switching; upload/ask receipts cannot clear a newer draft or a different chat.
Closing clears the draft, history and private engine copies. Side exchanges do
not create main-chat messages or entries in the conversation file list.

Codex accepts images as native image inputs and other files through its
file tools. Kimi uses native ACP images and text resources when supported by its
runtime. Its restricted native fork cannot decode binary documents, so it accepts
images and UTF-8 text; text tools may read the full copy. Claude's native
`side_question` accepts a string without file tools, so its side attachments are
UTF-8 text only; the UI states this limitation and rejects images. Binary files
are rejected by the host after content inspection for text-only engines.

Each question accepts up to 8 files, 64 MiB per file, 20 MiB per native image and
128 MiB total, subject to the Hub's smaller configured upload limit. A side
handle may accumulate 256 MiB of private copies. Inline text has a shared
100,000-character bound; text-only engines explicitly report partial content.
Engines with file tools can read the complete private copy. Attachment capability
is requested with `attachments=1`; old clients keep their strict reply shape,
and old hosts do not falsely advertise attachment support.

The Hub accepts only completed, unretired uploads owned by the authenticated user
in this conversation. The Gateway downloads through Bot authentication and
verifies bytes against the Hub's size and SHA-256 before exposing private copies
to the engine. Native handle disposal precedes removal of these copies. Closing
does not delete shared Hub uploads, which may be deduplicated with main-chat
attachments; the existing orphan-upload retention policy remains in effect.

## Architecture and privacy

`client/src/use-side-conversation.ts` owns memory-only UI state. Nothing is written
to IndexedDB, localStorage, the main Hub message/event tables, or the Bot's session
binding. The optional native adapter contract is in `src/codex/adapter.ts`.

The shared path is:

```
App side panel / headless side command
  -> authenticated /api/conversations/:id/side HTTP API
  -> HubSideSessions: membership, direct-chat and device ownership checks
  -> Gateway side.* RPC
  -> CoreSideSessions: lifecycle, idempotency, leases and bounded responses
  -> Bridge.openSideSession: existing parent binding + shared turn pool
  -> engine-native temporary context
```

`conversations.side.v1` advertises the host API. A separate live worker capability
check controls the entry point. The Hub checks the current device session,
conversation membership and Bot membership both before and after asynchronous
worker operations. Every handle belongs to one user, device, conversation and
Bot. Another device of the same user cannot read, stop or close it. Revocation,
archive or membership removal disposes the handle. The Gateway rechecks model,
effort, permissions and workspace configuration and retires old handles when that
configuration changes.
The App also closes the old panel and refreshes the capability when a live Bot
status announces a different engine, model or reasoning effort.

The lease is 90 seconds, refreshed by authenticated polling. A crashed, reloaded
or disconnected client therefore abandons a handle only until lease expiry;
normal explicit Close aborts it immediately and waits for native cleanup. A fresh open replaces an abandoned handle owned by the same user/device/conversation, waiting for that handle and any late native open to finish cleanup first. A Hub restart does not turn an unknown close into a fabricated cleanup receipt; it forwards the authenticated close to the worker. Worker state has a two-hour hard
maximum, eight concurrent handles, 200 accepted question IDs per handle, and
bounded idempotency tombstones (at most 1,024 open receipts; at that bound the
oldest receipts of closed handles are discarded instead of refusing new opens).
Questions are limited to 16,000 characters,
displayed answers to 96,000 characters and displayed history to 40 exchanges or
200,000 characters. Earlier rendered exchanges are omitted explicitly. Native
engine context limits continue to apply.
Normal worker shutdown drains late native opens and cancelled-turn accounting
after aborting the handles, so a fork that finishes during shutdown is disposed.

The native context is reference material. Current Codex side panels negotiate
inherited tool access: network and live web search are available, and enabled
MCP, browser, apps and plugins retain their native configuration. A question
uses research by default; an explicit operation in the side can edit files or
use configured connected services. This is not a read-only
sandbox. The side shares files and external state with its parent, so instructions
require preserving unrelated work and avoiding conflicting edits. It cannot
continue inherited tasks, spawn native subagents or autonomous goals. Closing a
side removes its temporary transcript, not side effects the user requested.

The side does not borrow the main turn's approval/question callbacks or App
message-delivery tools. Tools requiring a new interactive approval or login can
still be unavailable; already configured native tools are not blanket-disabled.
The configured Bot sandbox continues to apply (workspace writes in normal mode,
full access in bypass mode); workspace network access is enabled on the fork,
including when the main turn's workspace network setting is disabled. The fork
uses `approvalPolicy: "never"`: it cannot ask the main conversation to approve an
escalation. Thus file sandbox selection follows the Bot, while network access
and interactive approval behavior are explicit side-mode overrides, not exact
inheritance of every main-turn permission. This openness is the requested side
behavior; it does not change the parent thread's configuration or approval flow.
Without a Bot configuration, the native runtime sandbox is inherited. Local
filesystem access is not a sandbox for remote MCP/browser side effects.

`GET .../side?tools=1` opts into the new `tools: "inherited"` capability. A caller
sends `tools: "inherited"` on open only after that response; the negotiated mode
belongs to that handle for its lifetime. Older callers keep the previous enforced
read-only Codex fork and strict reply shape. New clients fall back on old
Hub/Gateway versions without sending an unsupported open field. Native Claude
side questions remain tool-free and Kimi retains its native restricted fork;
their runtimes do not advertise inherited tools. No fresh-session transcript
imitation is advertised as native side context.

Budget checks, turn admission, usage and timeline audit use the existing shared
helpers. Only command outcome and usage metadata enter the audit; side question
and answer text do not. An engine that does not return token/cost data produces an
explicit unmetered turn through `recordBridgeTurnUsage`, not a fabricated zero
cost. Claude side questions do not report usage; the capability response and panel explicitly disclose that these calls cannot count toward the Bot budget, although provider charges still apply. Provider-side retention and billing remain subject to the engine/provider.

## Headless entry point

Supported Codex sides can now deliver images/files directly to their temporary
panel, without an extra approval or a message in the main conversation. This is
separately negotiated from incoming attachments; old clients and engines retain
their previous behavior. See [side image delivery](side-image-delivery-2026-10-26.md)
for the receiver, output schema, capacity and acceptance evidence.

```
tarobot side status CONVERSATION --bot BOT --json
tarobot side ask CONVERSATION --bot BOT --text 'Explain the previous answer' --json
tarobot side ask CONVERSATION --bot BOT --text-file question.txt --timeout 180 --json
tarobot side ask CONVERSATION --bot BOT --file reference.txt --file diagram.png --json
```

The CLI automatically negotiates the same tool access as the current App.
These commands use the enrolled local controller and the same Hub/Gateway/Core
path as the App. `ask` opens a temporary native handle, submits one question,
waits for the answer and closes in `finally`, including on cancellation or error.
Successful JSON contains `text` and `closeConfirmed`, plus `truncated: true` when the answer was bounded and `usageAvailable: false` when the runtime cannot report usage. It does not create a main
conversation message. `--request-id` enables caller-supplied deduplication; a
closed handle is never silently reopened by replaying its old request ID.

## Acceptance

Lifecycle tests cover follow-ups, uncertain-send deduplication, device isolation,
stop/reuse, close during preparation, expiry, truncation, budget rejection and
sanitized failures. Bridge tests assert that temporary handles never create,
replace or bind a parent session. Hub tests cover revocation during an in-flight
open and current membership/group/archive restrictions. The headless integration
test uses a real enrolled controller, HTTP, Gateway and shared Core lifecycle.

`client/e2e/side-conversation.spec.ts` uses the production client and real Hub and
Gateway with a deterministic model fixture. It covers both Chromium and WebKit,
draft preservation, follow-ups, concurrent main sends, side-only cancellation,
close/reopen, a response arriving after new input, local slash routing,
phone/group/ADHD gating, keyboard focus, resizing, actual light/dark preferences,
long code and tables. Screenshots are actual application renders, separate from
real-model native acceptance. It also covers engine changes while the panel is
open, late opening responses after Close, fast Stop before ask acknowledgement,
and preserving a newly typed draft when an earlier send receipt arrives.

The opt-in `TAROBOT_LIVE_SIDE=1` browser test in
`client/e2e/live-side-conversation.spec.ts` runs an isolated real Codex parent
through the production App, Hub, Gateway, Bridge and session store. It verifies
parent-context recall, side follow-up, a random marker read from an uploaded text
file, a color recognized from an uploaded image, private-copy cleanup, unchanged
parent binding and Hub history,
an engine restart before opening, closing during a streamed side answer, and the
parent's subsequent ability to answer without recalling a marker shared only in
the side conversation. A second native test installs a harmless MCP fixture only
in its own child process. Legacy read-only sides cannot invoke it; an opted-in side must invoke it after
an explicit request. In both cases the parent retains access. The full App test
also verifies a real HTTP response, an explicitly requested workspace file write,
attachment cleanup, side-only cancellation and unchanged parent history. Every
real-engine test checks native deletion of its synthetic parent.

Source validation does not update an installed App or standalone CLI package.
Release and installation require the normal release checklist.

## Review fixes and deliberate limits

Opus 5.5 xhigh independently reviewed the adapters, shared lifecycle and rendered UI.
The review led to fixes for hidden-panel reopening and focus, stale owner handles,
cleanup acknowledgment timeouts and failed-close receipt replay, narrow layout bounds and small low-contrast text.
Ended sessions now show a visible restart action. Partial answers may still be
copied or explicitly inserted into the main draft; neither action sends a message.
The two-hour bounded replay tombstones and 200-question handle limit are intentional;
closing a handle does not erase the tombstone and allow its old open ID to replay. Body-free close receipts also remain available for two hours, so retrying a failed native cleanup cannot falsely report success.

Native adapter review additionally fixed a Codex cold-resume race: an old
`thread/tokenUsage/updated` event must not assign a turn ID while a new
`turn/start` response is pending. The original read-only mode disables inherited
MCP servers, Apps, plugins, browser/computer tools, sub-agents and web search on
the fork only. Since 2026-10-24, current App/CLI clients negotiate inherited tools
as described above; the parent remains unchanged. An old runtime returning a persisted fork is rejected
and that exact generated fork is deleted. Cleanup never targets a returned parent ID.
Kimi disposal retries deletion through a fresh scoped control process after a
child crash or failed delete, and reports failure if cleanup cannot be confirmed.
A new Kimi question waits for a stopped native prompt to settle, discarding late
chunks from the old turn. Claude cleanup also reports residual-file failures.

## Recorded acceptance at the source checkpoint

| Check | Result | Boundary |
| --- | --- | --- |
| Shared Core/Bridge/Hub/headless side suites | 22 passed | Authenticated API, ownership, budgets, late cleanup, failed-close retries |
| Side browser suite | 9 Chromium + 9 WebKit passed | Real Hub/Gateway/client; deterministic engine fixture |
| Search, steering, snapshot and cross-device suites | 13 Chromium + 13 WebKit passed | Includes message/file transfer and nonblocking incremental catch-up |
| Opt-in real Codex acceptance | 2 passed | Cold engine, parent recall, side follow-up, streamed close, unchanged parent history/binding, MCP isolation, exact synthetic-parent cleanup |
| Claude native probes | Passed | Live native side question and isolated fallback; parent-context recall and follow-up, main-turn concurrency, no side transcript body retained |
| Kimi native probes | Passed | Idle-parent fork, context/follow-up, read allowed and write denied, close-midturn cleanup, stop then ask, main resume |
| Opus final visual review | No blocking findings | Seven actual light/dark/narrow and paper/tty/cli compact screenshots; read-only review |

The actual browser preference controls generated the screenshots. They are separate
from real-model acceptance and from installed macOS WKWebView interaction. Native
IME, drag and macOS shortcut behavior in the installed application has not been
manually accepted in this source-only change. No installer or CLI package was
published, and no production host was restarted.

The final code checkpoint `2192e19` passed `scripts/pre-complete-hook.sh` in
an independent detached worktree with two Vitest workers: **436 test files,
5,928 tests passed and 5 existing skips**, standalone host and client builds,
and **77 native tests**. The native gate includes real pinned TLS/WebSocket
rotation and large-stream integration. The failed-close receipt regression was
reproduced before the fix, passed after it, and independently reviewed by Opus.
The installed application and standalone CLI package were not updated.

## Attachment and navigation checkpoint — 2026-10-23

The reported A → B → A loss was reproduced against the previous client, then
fixed by keeping a controller for each parent conversation. Tests verify the
answer, open state, unsent text and files, continued background answering, lease
renewal, and independent Close. A delayed upload/ask receipt cannot clear another
conversation or a newer draft. Upload cancellation also prevents the browser's
button-to-submit default action from accidentally resubmitting the draft.
The attachment tray and textarea respect short desktop windows, including the
App's 480 px minimum height with a long caption.

The CLI has repeatable `--file`, file-only questions, de-duplicated paths and
upload IDs, and `partialAttachments` in the result when only a text prefix was
available. An old Gateway that rejects the capability opt-in is retried without
that flag, retaining text side questions; authentication is checked again after
the fallback. Private attachment writes handle short writes and verify both the
incoming stream and the final on-disk bytes against the Hub's size and SHA-256.

Recorded validation for this change:

- The full pre-complete gate passed: 452 test files, 6,169 tests passed and 5
  existing skips, host/client builds, and all 77 native tests.
- All 17 side browser tests passed in Chromium and WebKit. The added short-window
  regression was reproduced before the CSS fix and passed afterward in both.
  The 10 existing attachment-composer tests also passed in WebKit.
- The real Codex App → Hub → Gateway → Bridge journey read a random marker from
  an uploaded text file and recognized an uploaded red image. Parent history
  and binding stayed unchanged, and Close removed the private attachment copies.
- Opus 5.5 xhigh implemented and reviewed the backend. Its isolated native probes
  verified Codex text/image/gzip reading, Kimi text/image reading, and Claude text
  reading, with parent recall and exact synthetic-session cleanup. The failed
  Kimi binary probe established the explicit text-and-image capability limit.
  Its final review passed 197 focused backend/CLI tests.

The local build mapping is App 1.0.101 / Host and CLI 0.1.448, protocol 1 and
supported Hub schema range 1–21. Source validation, signed package validation,
local activation and installed WebView acceptance are separate receipts; this
checkpoint does not assert that a public release or local activation occurred.


## Tool access checkpoint — 2026-10-24

Codex 0.164.0 real-engine acceptance verified the current App → Hub → Gateway →
Bridge path: inherited parent context, side follow-up, image/text attachments,
a random marker returned by an HTTP server, an explicitly requested workspace
file write, a public website read, side-only cancellation and parent continuation
without the private side marker. Two separate native MCP cases verified that
modern sides can call the synthetic tool, legacy sides cannot, and the parent
retains that tool in either case. All synthetic parent threads were deleted.

Focused adapter/Core/Bridge/Hub/CLI suites passed 97 tests. Five browser cases
passed in both Chromium and WebKit, covering attachments, per-conversation state,
independent stopping, engine changes and old-host negotiation. The initial live
App run stopped at an overly exact header-text locator; after correcting it,
the complete real-model run passed. Standalone host and client builds passed.
This checkpoint does not install a new App or CLI and does not establish manual
acceptance of every external browser/plugin provider.

The final project-wide checks passed 468 Vitest files (6,369 tests; 5 existing
skips), standalone/client builds and 77 native tests, including real pinned
TLS/WebSocket rotation and large streams. The first native build stopped because
the fresh worktree lacked its ignored `host` resource directory. After running
`prepare-desktop-host.mjs`, the native gate passed; the already-passed unrelated
JavaScript suites were not rerun. No production host was restarted.
