# Electron functional verification — 2026-10-30

Follow-up: [DeepSeek audit, Codex/Opus adjudication and fixes](electron-deepseek-audit-2026-10-30.md). The pending 1.0.120 activation was held before replacement; these newer fixes require a new release and installed acceptance.

This continues the [migration audit](electron-migration-audit-2026-10-30.md)
with actual native operations and independent Opus 5.5 verification. It is
not installed production acceptance or a claim of no bugs.

Source: `f1f61429cb8da40b438c1e5019c073975eb95444`, App 1.0.120,
Host/CLI 0.1.465. The Mac and CLI release has been
[published](https://github.com/cloveric/tarobot/releases/tag/macos-tarobot-v1.0.120)
and all six downloaded assets verified. At this checkpoint the installed Mac
remains 1.0.119 / Host 0.1.464: guarded activation is waiting for active work.
The terminal CLI has independently been updated to 0.1.465.

The functional package was built from that clean frozen source, Developer ID
signed, and explicitly configured for isolated development state. Native core,
updater and addon bytes match production after signature removal from disposable
comparison copies. Development does not exercise production paths, protocol
registration, global shortcuts or update credentials. These tests did not alter
production conversations, credentials or settings.

## Actual native UI and real Host

CUA operated the native App and macOS dialogs. The App connected to its real
isolated bundled Host and a disposable DeepSeek Bot using the installed CLI.
These are not browser mocks or simulated model replies.

| Operation | Observed result |
| --- | --- |
| Start App, configure local Host, pair | Connected workspace and real Bot visible |
| New conversation and real reply | `ELECTRON_UI_REAL_OK`, completed in 4 seconds |
| Native multi-file picker | Markdown and PNG added to unsent draft |
| Markdown preview | Heading, Chinese text and fixture marker rendered |
| Native Save As | Exact original bytes; quarantine attribute retained |
| PNG preview, zoom, fullscreen | Image rendered, 100% to 300%; first Esc exits fullscreen, second returns to chat |
| Chinese to English | Interface changes; original Chinese content and two-file draft retained |
| Send both attachments | Uploaded blobs match original hashes/sizes; real model returns `ELECTRON_FILES_OK`, completed in 1 second |
| File → Close Window and reopen | Window hidden, not destroyed; Host still running; draft and messages retained |
| ADHD selection and return | Same messages, draft and attachments retained |
| Finder multi-file copy/paste into ADHD | Both selected files enter draft; no automatic send |
| Conversation search | Exact marker returns two matching messages; navigation preserves draft |
| Conversation files | Both uploaded files listed; source-message navigation preserves draft |
| Screenshot without OS permission | Explicit System Settings path, reopen instruction and system-screenshot alternative; denied-permission path only |

The saved Markdown SHA-256 is
`0950c4ba1699e87d8f7409560df257d1d39e9116c5158d9b40894d7153f8129d`;
the PNG SHA-256 is
`e64231803c65008fb2db879afacf575f5bb4d361ce1648b17df3de06b9626d09`.
Read-only SQLite/blob checks independently confirm completed uploads on the
same user message and persisted completed model replies.

## Independent Opus 5.5 native runs

Opus used a separate development profile while CUA was paused. It did not alter
the running UI test, production Host, OS settings, signing configuration or source.

| Native operation | Actual result |
| --- | --- |
| Signed updater launched by unrelated Node | Refused, exit 77, about 25 ms |
| Signed updater launched by signed Electron main | Hello in 399 ms, including full bundle verification |
| Development updater info/check | Unconfigured provider explicit; `github_update_configuration` |
| Updater stdin EOF | Exit 0; process reaped |
| Real core with synthetic local HTTP server | HTTP 200 and exact body |
| Connection refused / body cut at 4 KiB of declared 1 MiB | `native_request_failed` / `native_response_failed`; no indefinite wait |
| WebSocket open, echo, acknowledgement | Expected events and exact echo |
| Server closes socket / restarts | Code 4001 retained; new slot reconnects and echoes |
| Cancel request / kill helper during request | Request terminates; fresh helper serves HTTP again |
| Native notification permission query | `prompt`, without permission dialog |
| Notification without permission | `native_notification_permission_denied`; no banner claimed |
| Notification context, peek, acknowledgement | Valid context; empty queue; oversized target rejected |
| Saved-file quarantine | Set before writing; survives rename; bad and missing paths rejected |

The server is synthetic, but the signed App, native binaries, OS addon and IPC
are real. Helper recreation in the transport test is explicit in the harness;
it does not alone prove automatic UI reconnection. Earlier renderer/helper crash
and persistent-outbox tests remain separate evidence in the migration audit.

No confirmed product bug was found. Quarantine's optional agent-name field is
empty, as in the shared Tauri implementation; its protective attribute and event
UUID remain present. This is not a migration regression. Published bytes remain
unchanged.

## Incomplete boundaries

- Finder-to-App drag-and-drop is **incomplete** in this native run: CUA attempts
  delivered no drag events to the instrumented App. This is neither a pass nor
  product-defect evidence. Multi-file picker and native paste passed separately.
- Installed data migration, native window, original Host connection, runtime
  and real model read-back await guarded activation.
- Real notification delivery/click, successful screen capture, physical microphone
  and camera need the installed identity and applicable permissions/hardware.
- Production protocol links, tray/badge, global shortcut and autostart need their
  installed production UI checks. Development intentionally avoids protocol and
  shortcut registration and must not change the production login item.
- Production Electron-to-Electron updating needs a newer signed release; prior
  real synthetic updater/install/rollback tests do not waive that boundary.
- Windows runtime is explicitly deferred by the owner, not passed. Mobile remains
  Capacitor; this Mac release does not publish mobile binaries.
- GitHub billing-blocked CI is not counted as executed testing.

## Evidence

Local root: `/Volumes/gdrive/taro-tmp.noindex/electron-migration-20261030/`.

- `phase8-functional.noindex/gui-functional.json`: 14 individual UI cases,
  limitations and automation notes.
- `phase8-functional.noindex/upload-and-response-readback.json`: uploaded-file
  hashes and completed real responses.
- `phase8-functional.noindex/results/002-window-readback.mjs.json`: hidden
  window and still-running isolated Host.
- `phase8-opus-functional.md`, `phase8-functional-coverage.md`, and
  `phase8-opus-functional.noindex/electron-run.json`: independent native results.
- `phase8-functional.noindex/cleanup.json`: test Bot retired, isolated Host and
  App stopped, owned helper processes gone, and the unique test Keychain service
  absent. No renderer exceptions were captured during the UI run.

Invalid harness attempts are retained but not counted as App failures: a
nonexistent management method, a retired Electron clipboard diagnostic API,
and Opus's initially invalid transport paths/notification ID. Corrected cases
passed. Native copy/paste was verified in one CUA operation with a settled
Finder selection; earlier empty-clipboard/single-file attempts are not counted
as multi-file success.

The original idle management session expired before cleanup. A fresh CLI
connection to only the isolated test Host retired the exact named test Bot and
stopped that Host normally. This also exercised the real CLI start/delete/stop
path; it did not restart the production Host. Evidence and fixture files remain
under `.noindex` for review.

This checkpoint changes documentation only. The shared headless Host/CLI and
desktop behavior remain the frozen, published source above; this document does
not replace the release or claim that the installed App is already updated.
