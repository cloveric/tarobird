# Design opens from an explicit user task

In a single-chat view, the Bot can open the Workbench in the App conversation that originated its task,
select an already open Design (current first, otherwise the last Design tab), or
create one if none is open. The user no longer has to expand the panel first.
Ordinary chat and merely discussing Design do not automatically open the editor;
the Bot calls `design.open` only for an explicit request to use/open Design.

ADHD mode is manual-only, including an already expanded ADHD card: it advertises
no automatic opener, so Bot requests cannot expand a card or replace the board
layout. Switching from a single chat to ADHD retires the old opener; delayed
requests cannot follow the user into the board. Users can still manually open
Design there, and Bots can read/edit that visible, conversation-bound content.

## Scope and execution

`workbench.design.open.v1` negotiates a lightweight chat endpoint separately from
the content controller. A foreground, selected, writable single-chat view advertises
an opener-only registration (`design.open.v1`, no tabs). Normal chat loads no
Workbench controller, Design runtime, board, note or native browser page.
Registration is confirmed once in the background per authenticated connection
epoch, because native input uses HTTP while registration uses WebSocket.

Messages freeze `openTarget: {deviceId, windowId}`. With the panel closed this is
also `target`, with no selection, document or content. With an existing panel,
its previous document context is retained. The Host validates the opener belongs
to the sending device and the same user/conversation; ordinary Workbench commands
ignore opener endpoints. A Bot cannot replace this target with another window or
device. A headless owner must explicitly choose an opener from
`tarobot workbench targets CONVERSATION --json`.

The optional opener can retire between capturing a message and delivering it.
That must not fail ordinary chat: its exact locator and retry digest stay frozen,
even if its own registration has just disappeared. Foreign-device locators,
contradictory registrations and forged content context remain rejected. Actual
`design.open` still requires the exact live, visible, same-user/conversation
registration at dispatch and admission. A retired locator therefore sends the
message normally but cannot open a different or replacement window. Existing
real content-target validation is unchanged.

`design.open` has an empty payload. It uses the existing dispatch/admission/deadline
and cancellation flow. Only after selection/creation, local persistence, and the
actual panel/tab mount does the App register the real content target on the same
ordered socket and return `applied`, `saved:true`, `revision`, and
`result: {target: {deviceId, windowId, tabId}, created}`. Subsequent read/publish
uses that full returned target. This receipt does not assert that every frame of
the embedded editor has finished loading or that the model has designed anything.

Navigation, hidden App pages, closing the panel, leaving the selected host, or
identity changes retire the opener. A cancelled/stale request cannot reopen a
panel later or move to another chat. Cancellation also releases a stalled
initializer's dispatch queue. Replaying the same request ID returns the journaled
receipt; it neither opens the panel again nor creates another document. An
admitted but unconfirmed action stays `unknown`, not a claimed successful open.
A new explicit user turn can reopen the retained design after closing.

The existing design data, editor isolation, CAS revision checks, save/quit locks,
permissions and content deletion rules are unchanged. This does not provide
remote desktop access, synchronize device-local designs, or launch a closed App.

## Compatibility

Tool schema v10 adds `design.open`; persisted v1–v9 schemas/digests remain stable.
Older Hosts receive neither the new context field nor opener registrations.
Older Gateways receive the previous content context, or no context for a closed
panel, so their strict schemas still parse ordinary chat. Existing native
sessions use the bundled CLI fallback when their frozen tool enum lacks the new
operation; no conversation/session reset is needed.

The client keeps ordinary native input and explicit steering semantics separate
from optional opener metadata. A lost-ACK retry retains its original request ID,
text, mode and frozen context even after another window is selected.

For supplemental inputs during a live run, accepting or queuing a message is
not proof that the model read it. The Host waits for that exact input's native
`received` receipt or steering `applied`/`absorbed` outcome before using its
opener. An uncertain input blocks automatic opening instead of silently using
the previous device. Engines that cannot prove adoption can continue chatting,
but automatic opening from that supplemental input remains unavailable. The
user can open the Design panel manually, or send a new ordinary turn.
One successful automatic open serves one explicit adopted user request. A later
adopted input explicitly requesting Design can open it again; an old request
must not reopen the panel after the user closed it.

A native foreground turn admitted from a Claude background review has no
ordinary delivery row. Its Workbench authority is a temporary lease on the
authenticated Gateway connection, issued only for the exact in-flight input and
revoked at turn end or disconnect. Historical native input records do not grant
new authority. A failed optional Workbench handshake must not discard the chat
message or route it through a different send mode.

## Validation and release boundary

Source validation and collaboration evidence is in
`/Volumes/gdrive/taro-tmp.noindex/design-auto-open-20261101/`.

Browser journeys exercise a real isolated Hub, signed App pairing, actual
message-context persistence, dispatch/admit/receipt, IndexedDB, and the upstream
Design editor. They verify desktop/phone opening, read/publish, reuse/replay,
manual close, fresh reopen, navigation during admission and multiple windows.
These fixtures supply a Bot actor to the broker; signed Gateway tests separately
cover the Bot protocol. They are not physical iPhone/Android or installed Electron
acceptance and do not claim a real model followed the new guidance.

An additional journey uses the actual Hub, Gateway, Core and App with a scripted
Claude engine. It verifies the background-review native input opens its sending
chat without creating an ordinary delivery row, and a callback retaining the
old async context is refused after turn end. This caught a missing wire-schema
entry for the lease RPCs; the socket originally disconnected before granting
the lease. The exact RPC methods are now accepted, and this journey passed.
Independent channel regressions also caught and fixed malformed lease metadata
escaping cleanup: a failed optional handshake now preserves ordinary chat and
releases admission. Lease calls are live-only and are never replayed from the
Gateway outbox after reconnect.

Focused Host/Gateway/protocol/CLI regressions: 43 files, 532 tests passed
(`opus-focused.log`). After the final optional-opener send fix, Opus reran the
directly affected 30 files / 351 tests successfully; these overlap, not add to,
the earlier count. Client opener/native-attempt tests: 14 tests passed
(`new-client-tests.log`; other client regression runs overlap this count).
Four new Chromium opening/routing/settings scenarios passed across the final
opening and isolated routing runs. A fifth uses a WebSocket proxy to let opener
retirement overtake the frozen message and verifies exactly one ordinary message
still reaches the Host. Both actual Gateway/native-review journeys passed:
successful automatic opening, and retired-opener capture preserving native chat
without opening any other window (`native-review-final.log`).
Three opening/routing scenarios also passed in WebKit. The desktop and phone
journeys exercise actual editor rendering and read/publish, while the separate
multi-window routing case asserts the saved content and selected panel.

Legacy regression runs also exercise conversation isolation, frozen targets,
annotation restoration, reconnection and ADHD browser panels. The existing
multi-window Design preview test can time out waiting for its inner preview:
the same timeout was reproduced on unchanged base
`4ce0b448053ec7729ed3bad036cbcec120edb3a5`. This is an unresolved validation
limitation; the full browser suite is not reported as passing.
An early broad Vitest sweep also had 49 failing files, mostly timeouts; not all
were independently classified. It is not a whole-repository pass claim. Final
validation is the focused feature/affected regression coverage above.

This change does not publish a release or replace the installed App. Both the
originating App and Host need the new capability before automatic opening works.

## ADHD opt-out — 2026-11-01

The owner requested no automatic Design opening in ADHD. The App now excludes
all ADHD panes from opener registration, even when a card is manually expanded.
The existing manual Workbench entry and content controller are unchanged. Shared
Bot guidance explains using an already bound visible Design or asking for manual
opening; it must not retry an opener to rearrange the ADHD board.

CLI impact: the existing commands and content operations are unchanged. ADHD
advertises no opener to either the native tool or CLI, and both use the same
manual-opening guidance. Single-chat desktop and mobile automatic opening remains
available for explicit Design requests. This source revision is not a release
or an installed-App update.

Focused validation: 17 Gateway/opener unit cases passed. Chromium passed the new
ADHD lifecycle case and the existing desktop/phone open-read-publish-reuse flows
(3 cases); WebKit passed the ADHD lifecycle case (1 case). The new case uses a
real isolated Hub and App to verify no opener in either ADHD card, rejection of
an old single-chat request and a fresh ADHD request, unchanged board layout,
manual Design opening/readback, and restored automatic opening only after
returning to a single chat with a new request. Client and standalone Host builds
passed. These are browser checks, not installed native or physical-device
acceptance. Evidence:
`/Volumes/gdrive/taro-tmp.noindex/design-no-auto-open-adhd-20261101/`.
