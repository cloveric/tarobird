# Conversation context actions — 2026-10-12

The sidebar conversation menu now provides **Pin / Unpin**, **Rename** (F2),
and **Delete conversation**. Right-click and Shift+F10 use the existing
viewport-clamped menu rather than the WebView's Reload/Share menu.

## Semantics

- Pins retain the existing per-device, per-host scope. A single-pin update uses
  an IndexedDB transaction, works offline, refreshes the directory and details,
  and returns keyboard focus to the row after it moves. It does not switch the
  active conversation or discard its draft.
- Delete is the existing **recoverable archive** operation, not a destructive
  session reset. A confirmation explains recovery via Workbench > Archived
  conversations, or All topics > Archived for a topic. Cancel has initial focus.
- The dialog waits for durable Hub state before removing the row. Disconnects,
  permission failures and acknowledgement timeouts remain visible. Rename and
  deletion require an online connection and the conversation's creator,
  matching server authorization. Pinning remains available locally.
- Group removal hides child topics without archiving or deleting the topics;
  restoring the group reveals them. Messages, Bot memory, workspace, session IDs
  and bindings remain intact. Running jobs are not stopped by archiving.
- Archiving synchronizes to other paired devices. Pin preferences retain their
  previous local semantics. A row always uses its own host connection, including
  duplicate conversation IDs on separate Hubs.
- Removing the current chat chooses another available chat or the welcome view.
  Reopening the App does not resurrect a last archived chat or a hidden topic.
  Explicit access from the archived-conversation page remains supported.

## Startup boundary

Sidebar management, legacy reset UI and QR display/scanning load when needed.
Chat-only welcome/empty states are separate from pairing branding. Native update
checks retain their schedule but their module loads only in Tauri. Offline
service-worker precaching still includes all modules. The existing first-view
script budget remains unchanged at 700,000 decoded bytes.

## Verification

Focused browser checks exercise durable pin/unpin, keyboard focus, cancel and
confirmed deletion, delayed Hub acknowledgement, restoration, retained messages
and session bindings, cross-device archive propagation, two-Hub isolation,
group/topic recovery, offline permissions and last-chat restart.

The root standalone build and 203 Vitest files passed (2,736 passed, one skipped).
Client TypeScript/Vite build passed. Broader Chromium regression included
conversation details, renaming and the Bot menu; WebKit included topics and
multi-host scope. Local-reset assertions were updated for the current TaroBot
name and desktop first-run screen, retaining their cleanup/recovery assertions.

The QR decoder test file currently fails to collect because it imports the React
scanner and its CSS into the Node test process. Scanner layout/open/close is
covered separately in both languages at phone sizes; this is not camera or
physical-device decoding acceptance.

Final WebKit run: 11 checks passed (context actions, startup, reset recovery,
and pairing layout). Final Chromium run: seven checks passed (context actions,
rename and Bot menus). Cold first-view scripts totaled 698,202 decoded bytes
across five clean browser contexts (median 102 ms, max 113 ms); these timings
are browser evidence, not native startup measurements.

## Native acceptance

A separately identified Tauri preview used a disposable local Hub and a newly
paired native device. Actual right-click displayed all three actions; pinning
moved the row and retained focus, the selected chat and its draft. Cancel kept
the conversation. Confirmed removal hid it only after the Hub receipt; Workbench
> Archived conversations > Restore returned the pinned conversation and its
original message. Direct SQLite read-back before/after restoration confirmed
one retained message, `fixture-session`, the same binding, and archive 1 -> 0.
No engine was invoked and no real user conversation was modified.

A preview identity created before rebuilding/re-signing did not reconnect:
process sampling showed device-sign requests blocked in macOS Keychain reads.
A fresh isolated pairing succeeded. Existing-identity upgrade/reconnect across
ad-hoc signatures therefore remains **unverified**; this change does not claim
to fix that native security-store issue or require resetting user data. The
installed 1.0.14 App and its services were not restarted or replaced.

## Prerelease packaging

`v0.1.391-test.1`: macOS Apple Silicon 1.0.18; Android 0.1.391-test.1,
versionCode 2026101206. APK signature, version and unchanged private test signer
were verified. The DMG mounted read-only; its App passed deep signature
verification, contained host 0.1.391, and embedded the final entry script.
All 328 client files matched the final build in the desktop host bundle and
both independently installed standalone packages (directory and npm archive).
APK assets matched too, with its intentionally stricter mobile CSP verified.
Both standalone installs started a Hub and served assets without a Feishu SDK,
credentials or CLI. SHA256SUMS accompanies both installers.

macOS remains ad-hoc signed, not notarized. No physical Android acceptance or
real engine/file/voice/relay journey was rerun for this sidebar change. The QR
collection limitation and old-preview Keychain behavior above are not passed
checks. Native screenshots and raw build/test logs were retained locally.

