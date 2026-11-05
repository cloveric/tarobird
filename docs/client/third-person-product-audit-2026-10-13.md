# Independent product acceptance audit — 2026-10-13

Baseline: `f0428053a71c77571ad757bad3949037af1904c7`. This pass treats TaroBot
as a new user's product: visible behavior, recovery, focus, reading and sending
come before implementation claims. It follows the earlier
[source/runtime audit](joint-opus-audit-2026-10-13.md) and does not re-label that
earlier work as new findings.

## Method

- Operated the installed Mac app and an isolated, paired Hub through native
  accessibility/browser controls. The isolated host used synthetic conversations
  and inactive Bots; no audit message was sent to a user's real Bot.
- Walked through pairing, both desktop navigation arrangements, creating/moving/
  renaming folders, current-conversation search and jump, drafts across navigation,
  light/dark/CLI themes, phone text sizing, image selection/send/preview/close,
  attachment guidance and disconnected states.
- Checked 1280-pixel desktop and 390-pixel phone layouts manually. Automated
  journeys add narrower widths, different engines and delayed/failing operations.
- Switched the phone settings to English and back: the page, selected 15-pixel
  text size and theme remained intact; interface labels translated while the
  synthetic host name retained its original text.
- Reproduced failures before changing code; inspected a browser performance trace
  for the long-reply pause. Kept private installed-profile screenshots and logs
  outside Git. Browser engine tests, real native transport and physical-device
  acceptance are separate evidence categories below.

These captures contain only the isolated audit fixture:

<p>
  <img src="images/product-audit-2026-10-13/mobile-chat.png" width="300" alt="Phone chat with compact image thumbnail and explicit offline Bot state">
  <img src="images/product-audit-2026-10-13/english-settings.png" width="300" alt="English phone settings with the retained text-size slider and padded controls">
</p>

## Confirmed defects fixed

| Priority | User-visible problem and trigger | Repair |
| --- | --- | --- |
| P1 | The installed Mac app repeatedly reconnects while macOS waits for access to its paired device key. Reconnects issue more blocking keychain reads until every asynchronous network worker is occupied. | Move OS credential operations to a blocking worker, allow only one pending operation without queuing more prompts, and wait for the existing signature before reconnecting. Never reuse a signature for an expired challenge. A regression holds the signer through timeout, releases it and verifies a fresh authenticated connection. |
| P1 | A notification switches to another host while a PDF/image/draft preview is open, or while an old file preview is still downloading. A portal from the hidden host can cover the new host or reappear after returning. | Propagate active-host visibility to previews; close hidden dialogs, release sources/workers, abort opening downloads, reject stale asynchronous preview results and avoid focusing hidden thumbnails. Saving an already-started file keeps its own lifecycle. |
| P1 | An audio-only message has no intrinsic bubble width. Its player collapses to zero on desktop, or to the width of action labels on a phone. | Give the audio wrapper a 300-pixel preferred width capped by available space. Test the actual recorded/uploaded/downloaded player width and playback. |
| P1 | Right-clicking a message near the conversation tail opens a menu which disappears as delayed follow-to-latest scrolling moves its anchor. | Hold reading position while the menu is open; replace pending virtualizer follow work with the current offset. The desktop “回到最新消息” button also occupied normal layout flow and reduced the reading viewport by 38 pixels when it appeared. Float it above the composer on desktop as on mobile. Assert unchanged viewport geometry; deliberate scrolling still dismisses the menu. |
| P1 | A complete 5,000-line answer causes a roughly 138–142 ms pause despite Markdown parsing running in a worker. | A trace identified Chromium's paint-chunk layerization. Isolate paragraph paint groups without dropping text, estimating heights or removing virtual-row positioning. Three isolated final runs preserved all lines, ten tables and ten equations: input 8–9 ms, frame p95 16.7–16.8 ms, zero measured long tasks. These are local fixture measurements, not a universal device guarantee. |
| P2 | Native transport errors lose their diagnostic value, and automatic retries erase the last failure, leaving an unexplained connecting state. | Carry native error codes to the UI boundary, translate known recovery cases, retain the failure during retry and clear it after successful authentication/cache preparation. Add an explicit reconnect action. |
| P2 | Cancelling a nested folder rename removes the focused input/button and leaves keyboard focus outside the still-open management dialog. | On dialog-step changes, focus the visible heading when the previous control was removed. Preserve normal focus when it remains inside. |
| P2 | Search/navigation excerpts show Markdown headings, fences, quote prefixes and table separator syntax. | Strip framing in short presentation excerpts while preserving code contents and URLs. Full message rendering, stored content and copy/export stay original. |
| P2 | The Hub is connected but the selected Bot is offline; the chat gives no immediate explanation for the lack of a reply. | Show a quiet, static “Bot 离线” status for the direct Bot. Real active reply status takes precedence. |
| P2 | Attachment limits are enforced only when a file fails, without a nearby size cue while composing. | Show the host's actual per-file limit alongside the attachment count. |
| P2 | Startup, lock, capability and notification surfaces still present the old product name. | Use TaroBot in user-facing copy and OS notification titles. Keep legacy storage identifiers, registrations, deep links and validated wire titles compatible. |
| P2 | The translation check ignores single-quoted keys, while obsolete translations increase the startup payload. | Parse literal translation calls with the pinned compiler API, including nested source files and different quote styles. Remove unused keys after checking source literals; preserve runtime-selected keys. Startup transfer returns below its existing budget. |

## Regression maintenance

Some existing tests described superseded controls rather than defects: the
icon-only send button, renamed app copy, the additional folder menu action,
duplicate title headings, and a phone recovery flow that remained in details.
They now follow the visible interaction. A selected-text context-menu check
right-clicks the selected text instead of the padded cell centre, which natively
clears the selection. No production behavior was changed merely to satisfy
those stale assertions.

## Verification

- Root build passed. Root tests: **230 files, 2,936 tests passed; one skipped**.
- Client translation check, TypeScript and production build passed.
- Native Rust tests: **28 passed**, including keychain blocking/concurrency and OS-backed save provenance checks.
- Android Java compilation, unit tests and lint passed. No physical Android
  device was connected; this is not keyboard/system-bar/device acceptance.
- An isolated **real Tauri macOS WebView** authenticated HTTP and WebSocket
  requests against a real local Hub, rejected an active proxy/redirect and
  completed an 8 MiB upload plus a **512 MiB hash-verified download**. The largest
  delivered download chunk was 256 KiB. A second real-native run also exercised
  SQLite cache preparation before the handshake and passed. These fixtures do
  not establish the health of an existing user's paired profile.
- Broad Chromium run: **761 passed, 44 explicitly skipped, five failed**. Two
  failures were stale copy/image-readiness assertions; three occurred in tight
  timing checks under concurrent native compilation. After fixing the stale
  assertions, all five passed within a **65-test focused Chromium run**, with
  existing performance thresholds retained. The entire 810-case run was not
  repeated; this report does not label it an all-green full run.
- WebKit run: **124 passed, three skipped, two failed**. The failures exposed
  stale notification copy and the desktop viewport/menu issue above. The final
  **49-test WebKit follow-up passed**, including the complete rich-message
  quote/forward/selection flow and chat reading/entry geometry.
- Final connection/handshake/local-reset regression: **46 Chromium tests
  passed**; native-transport regression: **31 WebKit tests passed**. These
  include holding the native signer past handshake timeout, then authenticating
  on a fresh challenge after release.
- Final production startup/offline-worker/recovery checks: **three passed**;
  startup script transfer **693,460 bytes**, within the unchanged 700,000-byte
  budget. Local cold-browser pairing readiness median 104.5 ms, maximum 109.8 ms.
  This is not a native cold-launch measurement.

## Installed Mac result and remaining gate

The existing Mac installation was backed up and replaced with the local
**1.0.62** audit build. The clean installed bundle passed strict code-signature
verification. It is an ad-hoc development build, not an Apple-notarized release;
no public release was created for this audit.

The real paired profile still waits inside macOS's credential service. Before
the fix, a process sample showed all network executor workers blocked on
keychain access. After the fix, only the dedicated blocking operation waits;
network executor workers remain free, cached conversations stay available and
the UI names the system identity wait instead of blaming the host. There is no
claim that this profile has reconnected yet. The computer-control tool refuses
access to SecurityAgent, so the user was asked to complete any OS keychain
prompt locally. Pairing, drafts and the original Hub/Bot processes are retained.

Android system-bar/keyboard behavior and Windows native acceptance still need
those actual devices. This source and browser audit does not substitute for
that evidence.

## Acceptance boundaries

This audit does not claim the absence of all bugs. Windows native interactions,
Android hardware, iOS, real provider model calls and external push delivery are
not established by desktop browser fixtures. Previously opted-in live engine
journeys keep their environment guards; ordinary regression runs do not invoke
them or send user messages. No legacy Lark/Telegram service is restarted for
this App audit.
