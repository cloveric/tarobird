# Post-1.0.122 revision audit (2026-10-31)

Status: fixes and affected regression checks passed; independently reviewed with Claude Opus 5.5 (`opus-final-review.md`, `opus-native-final-review.md`, `opus-permit-cancel-review.md` in the evidence directory). No release or installed-App change.

## Scope and ownership

The installed/released baseline is App 1.0.122 / Host 0.1.467 at `2aee119c15deec1917113ccff16db048a4d6bb65`. This audit freezes the following 36 commits through `40cb54c52e36c1bc5b9350f0d5a3a39b9a0c72f9`. It reviews the post-release delta, not an assertion that every pre-existing feature is bug-free.

GG1 owns Workbench/Design/storage/protocol, queue and avatar/mobile presentation. CC1 (Claude Opus 5.5) independently reviews browser tools/personal profile isolation, screen service/permission/readiness, native window geometry, and dialog dragging. Edits are partitioned; the final integration is reviewed together.

| Area | Review/verification boundary |
| --- | --- |
| Workbench / Design / notes / boards | Scope and saved content isolation; revision/CAS, import/export/reset/migration, split selection, iframe lifecycle and actual upstream editing |
| Browser / ADHD personal browsing | Host/conversation/profile isolation, user-only actions, history/settings, page targeting, native geometry and stale receipts |
| Remote screen | Registration/recovery, permission request dispatch and state, selected-host routing, entry visibility and service lifecycle |
| Window / side panels | Open/close/right-edge geometry, draft retention, native drag regions and draggable dialogs |
| Phone / avatars / queues | Compact header, activity projections, answered requests, reorder barriers and pending-operation cancellation |
| Host / CLI / release infrastructure | Shared Design capability/schema/tool routes, v1–v8 compatibility, migration round trip and upstream-update release instructions |

## Reproduced defects

1. **P2 — Design text read splits a Unicode pair.** A `design.read` starting at UTF-16 offset 1 in `😀A😀中` with limit 1 returned `A` plus an isolated high surrogate. The end boundary was calculated before the start was advanced. Calculate the end after normalizing the start; add mid-pair offset cases alongside ordinary pagination. Saved file bytes are unaffected. This is shared by App tools and the headless CLI Workbench bridge; no separate CLI implementation is needed.
2. **P2 — Design loses its resize observer after a Bot publish.** Reload destroyed the observer, while the React placeholder stayed mounted; a subsequent internal surface resize left the iframe 169 px wider than its surface in the reproduction. Re-establish observation whenever the frame opens.
3. **P2 — An open Design editor ignores appearance changes.** Theme was only sent at initialization. Observe App appearance and system color-scheme changes; deliver a parent-only theme message to the existing opaque-origin editor. Keep the live editor and human edits intact.
4. **P2 — Connection dialog cannot be dragged after screen view closes.** Independently reproduced by Opus in the browser fixture. The header is replaced while the drag hook keeps its old binding. Disable the drag binding while the viewer is shown and attach it to the returning header; the viewer also returns to its normal centered position. The regression checks movement after the replacement.
5. **P2 — Modal controls overlap a native drag region.** Opus compared release and current renderer CSS. Report/widget controls overlapping the shell title row lost their no-drag protection, while the underlying header stayed draggable. Renderer regression is reproduced; no native OS hit-testing result is claimed. Suspend underlying shell drag regions for modal dialogs while preserving image/file-preview handles inside the active modal. Nested-modal regression now also suspends an underlying lightbox handle; a lone image/file lightbox retains its own handle. Portal-menu overlap was not reproduced at normal geometry and remains a stated risk for unusually short windows.
6. **P3 — Browser settings can remain cached after Host purge.** `purgeHost` invalidates memory before deleting disk files through the serialized writer. A new read in that interval can cache the old file indefinitely. Opus and GG1 independently reproduced old in-memory `baidu / 2 / false` versus default settings from a fresh store after deletion. Per-Host removal barriers now delay new reads until deletion completes. The original removal still rejects on failure; other Hosts remain isolated. GG1 independently reran the same probe: racing read, cached result and fresh disk read now all agree on defaults.

7. **P1 — Quitting with unsettled Design text loses the latest edit.** Typing visibly changed the live `h1`; closing the App window before blur/Escape produced no confirmation, and reopening showed the original text. The opaque editor's beforeunload cannot protect the parent, and live rich text is not yet in the save queue. The final fix uses an explicit native pre-quit handshake: a fixed main-to-renderer script asks every mounted Design editor to lock input, settle upstream editing and await persistence. A failed save, thrown preparation or timeout cancels the quit; cancel invalidates the permit and restores editing. Generation/epoch checks reject late save results after cancellation or reload. Bot publish is refused with `design_closing` while locked. Direct browser/reload paths retain a conservative parent beforeunload guard; no sandbox modal privileges or extra native commands are exposed.

   App installation awaits the same Design preparation before replacing files, with concurrent update commands fenced and cancellation still available. A confirmed replacement retains its locks even if the subsequent Host restart reports failure. The actual quit always checks current renderer instances: only an individual editor that is still saved and locked may reuse its preparation, without re-flushing the replaced bundle. Cancelling a browser page's quit, editing again or opening another Design cannot reuse a stale main-process boolean. The previous boolean shortcut was reproduced in a negative regression and removed before submission. Browser pages still run their current unsaved-work checks at actual quit.

   The original dirty-notification/focus-based candidates were discarded: messages could arrive after close and early green runs did not establish the complete boundary. The final integration adds no new upstream vendor patch; `design-runtime.js` only adds theme propagation. Durable browser reopen and actual isolated Electron close are separate acceptance evidence below.

## Validation

Baseline: 560 Vitest files, **7,525 passed / 6 skipped**; **268/268 Electron unit tests**; Host and client builds passed. These results precede the fixes and are not presented as final regression results.

The 160-case changed-area Chromium run ended with **157 passed / 3 obsolete assertions failed**. The initial root-directory launch used the wrong fixture `dist` path and is excluded; the valid run starts in `client/`. The browser split test assumes automatic selection; the Workbench keyboard test assumes whiteboard is still first; the delete confirmation assertion predates the added Design content type. These test mismatches are distinct from product failures. The latter two were updated and passed on both Chromium and WebKit; Opus updated the browser split test; its original zoom/device-preview assertions now pass after explicitly choosing both tabs.

Final affected checks:

| Check | Result and boundary |
| --- | --- |
| Design file/session regression | 12/12; includes the reproduced mid-surrogate offset |
| Design Chromium | 8/8; actual editor, save/reopen/import/export, split targeting, theme/resize, real beforeunload and failed-write recovery |
| Design WebKit | 8/8; same editor scenarios; exit checks dispatch the renderer guard because WebKit automation does not run beforeunload on page close |
| Isolated Electron Design | 15/15 checks on the final per-editor permit implementation. Production CSP/preload, real editor/assets, theme/resize, actual window close, save/cancel/retry/late-ACK behavior. The fixture uses an in-memory persistence callback; durable IndexedDB reopen is independently covered by the browser tests. |
| Browser/screen/window Chromium | 30/30, independently rerun by GG1 against rebuilt assets; remote/native commands in these fixtures are mocked |
| Browser metadata store | 21/21, independently rerun after the final Opus test seam; overlapping purge barriers, failure propagation and POSIX reset retry |
| Electron unit suite | 280/280 on the final source, including lifecycle exceptions, update preflight/concurrency/cancel and stale-permit regression; distinct from real Electron smoke |
| TypeScript, translation validation, production client and Electron main bundle | Passed; upstream vendor hashes and exact adapter patches checked during the client build |

The two stale Workbench usability assertions also passed on Chromium and WebKit. Repeated runs of the same cases are not added together as unique coverage. The final native receipt is `native-design-Vdo5l2/verification.json`. After the final permit refinement, the two quit/save cases were rerun and passed on both Chromium and WebKit (2/2 per engine); the preceding complete Design suites were 8/8 per engine. The native run used a separate profile and no production Host. The saved failing traces establish the original Unicode/theme/resize/quit defects; an early unload probe that did not await actual page closure is excluded.

CLI impact: Unicode pagination is shared by `app_workbench` and `tarobot workbench run`; its protocol and authority remain unchanged. A Bot publish attempted during Design quit/update preparation receives `design_closing` through the same bridge, with bilingual App guidance. The remaining fixes concern App-local editors, browser metadata or window presentation, so no new CLI command is required.

## Reviewed improvements without speculative behavior changes

Theme tracking no longer observes unrelated root `style` mutations, avoiding synchronous appearance reads on every pane drag.

The personal browser and conversation workbenches share per-window limits of 64 tabs and six live pages. The personal-browser guide now states these limits explicitly; this audit does not increase resource use by creating separate pools. Opus also noted possible future cache eviction, authentication-path redaction and permission-prompt UX refinements. These are not reproduced regressions and are not presented as fixed bugs. They do not justify silently changing browsing or permission policy in this patch.

## Limits

Direct browser/reload paths can ask for confirmation whenever a Design is open, including a clean design. The native handshake avoids that prompt on normal successful quit. A live but unresponsive renderer that cannot confirm within 11 seconds conservatively cancels quit; no automatic discard or force-quit bypass was added. Actual hung-renderer behavior is not a native acceptance result. Forced process termination cannot guarantee unsaved content survives.

No production Host restart, release, installation replacement, permission-grant change, screen capture or remote input is performed by this audit. Update preflight is verified through the production classes with test doubles; no real installer transaction is claimed. If a user cancels the required restart and then opens a Design after bundle replacement, the old process can encounter newly replaced editor assets. A subsequent save failure cancels restart rather than discarding data; this mixed-version recovery path is a remaining limitation, not a tested physical installation result. Browser phone layouts do not establish iPhone/Android device acceptance. Native screen permission UI, cross-network capture/control and Windows runtime acceptance remain separate from mock tests.

This is an audit, not a release: the pinned baoyu-design source and adapter hashes were verified, but no upstream upgrade was performed. The next release must still run the integrated-project update gate.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/post-1.0.122-audit-20261031/`. Physical `.noindex` roots are used for test artifacts and native runtimes.
