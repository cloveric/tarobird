# Visible Claude send modes

The previous “Send as next turn” action lived in the chat-header menu. On a
phone this made it easy to send an instruction into Claude's short native
pending window when the user intended to wait for the entire current task.

The composer exposes **补充当前 / 排到下一轮** immediately above its input.
On phones the visible and accessible button names are shortened to **补充 / 排队**
at the owner's request. Full explanations stay in the help dialog and button
titles. Desktop labels, touch-target sizes and both send routes are unchanged.
This wording-only follow-up is CLI-not-applicable.
The two options are visible together on phone and desktop, aligned with the
send side. They do not reduce the phone field's typing width or change the
accepted composer height, font sizes or platform density. The extra choice row
is only present for an online, writable direct Claude conversation with an
advertised native-input capability and a live target. Commands, recording,
archived conversations, unsupported CLIs and other engines keep their entries.

Selecting an option does not send. Send and ordinary Enter share the chosen
route: ordinary native admission or the existing durable `send(true)` path.
The latter changes the send icon, title and empty-input placeholder. Its queued
message continues to use the existing pending-list editor, reordering and
cancellation. Ctrl+Enter and the explicit menu actions keep their previous
meanings; native cancellation remains available only before the CLI consumes
the message. This change does not introduce a guaranteed undo interval or
restart/stop a worker to change delivery modes.

Choice is an in-memory value per HubConnection, conversation and Bot, scoped
to the live target. A next-turn choice stays selected for consecutive sends in
the same task. Another conversation has its own value. A new target or a
confirmed idle state clears it when the draft is empty; an unfinished draft
retains its chosen intent. Offline/unknown status does not erase it. Reload
returns to the default. Attachments and quotes visibly require the next-turn
route without rewriting the saved pure-text choice. The help button explains
these boundaries. Mouse/touch selection retains an already-focused composer;
keyboard users get radio semantics, arrow navigation and a visible focus ring.

## Confirmed defects fixed with the entry

- The old menu's `send(true)` skipped native-attempt lookup. The same text left
  behind after an uncertain original send could be delivered again as a durable
  message. Both the new selector and old menu now reject that route until the
  original message status is checked. The draft is retained; the explanation also
  covers terminal messages that can no longer be withdrawn, and asks for edited
  text when a separate new instruction is intended.
- Refreshing a live native status no longer clears the previous successful
  status before the read finishes. This avoids removing/reinserting the row on
  ordinary activity changes. A new authoritative idle/unsupported result still
  controls visibility; an HTTP failure is not classified as idle.
- Send-now's transient receipt is rendered only while still queued. A model
  receipt arriving before or after the control reply cannot leave a stale
  “waiting for model receipt” sentence beside “model received”. Cancellation
  errors remain actionable rather than being indiscriminately hidden. Unknown
  control/check notices also disappear after an authoritative terminal receipt,
  without hiding a concrete failed-withdrawal explanation.

- WebKit can suppress `click` after a prevented touch `pointerdown`. A focused
  composer now accepts a genuine tap on `pointerup`, preserves focus, ignores
  moved/cancelled gestures and suppresses a duplicate pointer click. Independent
  Opus touch tests reproduced the old wrong route and verified this repair;
  automated `hasTouch`/`tap()` coverage runs in both browser engines.

- The new selector initially shared a React sibling key with `PromptQueue`.
  Navigating between running conversations could retain obsolete queue
  components and polling subscriptions. A dedicated `send-choice:` prefix
  separates their identities. The added navigation test failed with three queue
  strips before the fix, and checks one current strip, per-conversation choices
  and the decreasing count after a queued turn starts.

## Ownership and verification

The original native-input protocol, origin/provenance, persisted message and
control identities, queue claim fencing, attachments/references, worker and
background-agent lifetime are unchanged. No Host or CLI command is added:
this is an App entry and recovery guard over existing shared APIs. Headless
`steer send --mode message`, `steer send-now|cancel` and queue commands remain
applicable. CLI packaging/release is not required for this source change alone.

Opus 5.5 xhigh independently reviewed the design and implementation and used a
separate browser session against an isolated synthetic Host. Acceptance output
is in `/Volumes/gdrive/taro-tmp/claude-send-choice-20261024`. Tests use mock
native events with a real isolated Hub/Gateway and durable queue; they do not
claim a new live-model protocol validation. A separate nonpersistent macOS
WKWebView shell checks rendering and queue UI without replacing the installed
TaroBot App. Responsive and WebKit tests are not physical iPhone/Android
keyboard or touch acceptance.

Validation: 44 focused unit tests passed; 55 related existing browser journeys
passed (attachments, IME, desktop/Android/iOS density, queue edits/claims,
steering and recovery). The final candidate passed 20 journeys in Chromium and
20 in WebKit, including the ten new send-choice scenarios. Root standalone
and client translation/type/Vite builds passed. The existing Capacitor keyboard
mixed static/dynamic-import warning remains unchanged. Native macOS WKWebView
verified both themes, selection, sending into the durable queue and sticky
choice; its receipt is `native-ui-receipt.json`. No physical phone, installed-App
replacement, release or new live-model protocol acceptance is claimed.


Independent review dispositions: touch handling, obsolete receipt notices and
the settled-message duplicate warning were corrected. The phone row retains its
44px touch area; the compact visual follow-up below keeps that target. Commands/recording intentionally
hide the choice, and task-boundary hide/show is not replaced with an artificial
delay. A late navigation audit found and fixed the duplicate-key queue-strip regression.
A separate duplicate-reply observation contained two distinct admitted user
messages, each with one reply, rather than a single queue item dispatched twice.

## Compact segmented appearance

The two labels now share a recessed track with a thin border. The selected
segment uses the theme's soft accent fill, accent outline and existing check;
the unselected label remains inside the same track. The help icon stays outside
the group. This makes the control read as one choice between two modes.
It does not perform a send when selected.

Only `claude-send-choice.css` changes. Phone buttons still occupy their full
44px touch rectangles while the track is visually 32px high. Desktop retains
the longer labels and 32px row. Text weight, composer geometry, radio semantics,
focus retention, tap/pan handling, scope keys and delivery paths are unchanged.
Pseudo-elements ignore pointer events. Hover paints only the inner segment;
the global button hover fill must not paint the full-height touch rectangle.
Keyboard focus follows the inner segment, and forced-color selection retains
a system-color border. No new animation or fixed palette colors are added.

This CSS-only follow-up is CLI-not-applicable. It was discussed with Opus 5.5
xhigh, whose independent Chromium review found no blockers across 320/390 phone,
desktop, light/dark, monochrome, CLI and pixel themes, attachment lock and
keyboard focus. The suggested pixel corner override was unnecessary: the actual
DOM and screenshot already use zero-radius theme tokens. Reserved check space
and the existing hover/outer-border tokens remain intentional.
Final client build and the existing ten send-choice journeys in each of
Chromium and WebKit passed, including actual touch-context taps, narrow iOS and
Android branches, attachments, scope changes and queue edits/cancellation.
Eight phone visual states (320/390, light/dark, both choices) retained the
previous input and row geometry with no page overflow. Browser screenshots
are in the `segmented-ui` subdirectory of the evidence root above. These are
browser simulations, not a physical phone or installed-App acceptance. No App
replacement or release is part of this follow-up. The optional standalone Cocoa
probe did not return a UI receipt and was stopped; native computer-use was also
unavailable, so this follow-up does not claim a new native macOS validation.
