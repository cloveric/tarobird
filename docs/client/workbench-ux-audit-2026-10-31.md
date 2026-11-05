# Workbench usability and persistence audit — 2026-10-31

Second audit based on `2b72cea7d2b09349a3845d4ba69d25151bceef02`, following the earlier stability audit. Findings were independently reproduced and cross-reviewed with Claude Opus 5.5 (`claude-opus-5-5[1m]`, xhigh). No release, installed App change, live Host restart or production website-data reset is part of this work.

## Findings and changes

| Flow | Reproduced behavior | Change |
| --- | --- | --- |
| Keyboard menus | Escape did not dismiss a workbench menu or return focus to its opener | Focus the first enabled action; Arrow Up/Down, Home/End navigate; Escape returns focus; leaving the menu with Tab dismisses it |
| Editor resource failure | A failed local Vditor resource offered save/reload actions that never reloaded the editor | Explicit retry reloads editor resources with the same note; Markdown export remains available. An export failure does not remove the editor retry entry |
| Narrow screen | Phone single-page menus offered split actions with no visible effect; one-tab move commands were useless | Hide unavailable split actions on phones and both move rows for a single tab; desktop split remains available |
| Closed local content | Deleting closed notes/boards required reopening them | An explicit delete button in the closed-content list uses the existing destructive confirmation, preserving chat history |
| Website-data dialog | A native clearing failure was shown outside the modal, under its backdrop | Show the error inside the current dialog and keep retry available; disclose possible partial cleanup |
| Multiple windows | A stale layout continued conflicting on every following write | Adopt the newer stored layout after a CAS conflict without replaying the stale action; flush outgoing local editors before adopting |
| Browser metadata | A page changing its title 30 times caused 30 layout writes | Coalesce title-only writes (up to 5 s), URL bursts (250 ms), and flush on hiding/disposal; live native state continues immediately |
| New/imported boards | Bytes could be saved before the layout rejected the new tab | Board and layout commit atomically, including revision and tab-limit rejection; request replay reopens the same board |
| Bot browser typing | Append could report success when unchanged target already ended in requested text, while input went to another field | Require expected length growth; when input misses target after focus loss, report unknown and avoid a second DOM insertion |
| Board autosave | Every stroke parsed all scenes and undo history twice | Keep full validation at storage, with a cheaper preflight for files, structure and byte budgets; preserve edits on validation failure |
| Local Host removal | Pairing/cache removal did not clear its separate workbench website sessions | App-only, explicitly Host-scoped cleanup before key/cache removal; retain the removal record on failure and protect replacement pairings |

Common operational errors now explain the failed action and a usable next step instead of exposing only an internal error code. Editor recovery buttons wrap on narrow English screens without horizontal overflow.

## Website cleanup boundaries

The trusted App command `workbench_browser_reset` requires `{host, scopes}`. It is absent from Bot browser actions and capabilities. Scope hosts must match. Known partitions come from this cache's exact layout keys, live same-Host pages collected across every window, and a main-process partition-to-Host registry. A process-wide fence blocks same-Host actions and newly created windows during cleanup; other Hosts remain usable. Notes-only scopes with no existing browser partition do not create empty sessions or folders.

Cleanup covers website storage, HTTP cache, authentication cache and resolver cache. Chromium partition directories and some network bookkeeping can remain. Pre-registry partitions whose layout keys are no longer in the cache cannot be attributed safely and are retained. There is no implicit global reset or guessed deletion. Replaced cache ownership skips old-pairing website cleanup to preserve the replacement. A failure stops removal before key/cache deletion and permits a retry; other Hosts remain usable.

Registry reads wait for pending writes. A corrupt/unreadable registry remains untouched and fails every cleanup attempt until repaired; it is never discarded just to make a retry appear successful. A page that fails to close within 10 seconds also produces a failed receipt.

The real two-window Electron probe kept writing a cookie every 20 ms in a second window. Reset closed both Host A pages and emptied both partitions, kept Host B's cookie/page, and refused a new Host A window opened during cleanup. A separate notes-only scope did not create a partition directory.

## Validation

Evidence root: `/Volumes/gdrive/taro-tmp.noindex/workbench-ux-audit-20261031`. Counts below describe distinct suites; overlapping unit suites and targeted reruns are not added into a single total.

| Validation | Result and evidence |
| --- | --- |
| Root Host/CLI/reset/shared-model unit suite | 99/99, 10 files (`root-logic-final.log`) |
| Opus controller/board/browser/reset unit suite | 87/87, 10 files; independently reviewed in `opus-final-receipt.json`. The stronger in-flight refused-write test then passed 6/6 in `board-flush-entered-check.log` |
| Electron main unit suite | 165/165, including 32 browser tests; Opus final receipt |
| Workbench Chromium | 40 cases covered: full initial run 38 passed + one locator collision, corrected case passed; the new actual IndexedDB abort test also passed. `chromium-final.log`, `chromium-followup.log` |
| Workbench WebKit | 39 passed after targeted corrections; one Chromium/CDP resource case intentionally skipped. Initial run also covered all 16 Host-concurrency tests. `webkit-final.log`, `webkit-followup.log` |
| Host concurrency, Chromium | 16/16 (`ui-and-removal.log`; its 5 UI cases are counted with workbench coverage above) |
| Local reset, multiple Hosts and network cache | 42/42 after repairing two obsolete fixtures (missing migration IPC / renamed UI entry); 40 passed initially, both corrected cases passed in followup. `removal-regression-current.log`, `chromium-followup.log` |
| Updated recovery wording/English 320px | 2/2 WebKit (`recovery-copy-final.log`); export failure retains editor retry, successful export preserves bytes |
| Real Electron browser smoke | 26/26 (`native-browser-smoke.log`): scoped cookies, typed input, uploads/downloads, navigation, crash/recovery, cancellation, permissions and lifecycle |
| Targeted real Electron | N1 before/after input receipts, C2 one-window and two-window cookie cleanup (`n1-electron.noindex`, `c2-electron.noindex`, `c2-windows.noindex`) |
| Builds | Client TypeScript/Vite and standalone Host passed (`client-build-last.log`, `host-build.log`). Existing large-chunk / ineffective dynamic-import warnings remain |

The first browser runs exposed a WebKit-specific Tab exit (focus moved out of the document without `focusin`); explicit Tab dismissal fixed it. A pre-existing reopen test needed exact button matching once closed boards gained a distinct delete button. No product checks were skipped to hide these failures. The actual IndexedDB creation test injects a transaction abort between board and layout writes and verifies that neither half commits.

The whiteboard CPU comparison uses the same process, baseline and patched sessions in alternating groups, 500 shapes, 12 undo steps, and 24 strokes per variant. Median local-edit-through-save work was 109.7 → 78.7 ms without images and 136.8 → 104.5 ms with 4 × 2 MiB image strings. The persistence stand-in performs the real full schema validation plus structured clone; these numbers **exclude actual IndexedDB/disk latency** and are not phone, screen-frame, or installed-App speed claims. Source probe: `opus-repro/vitest/board-flush-e2e-ab.test.ts`.

Opus independently reviewed the root UI/reset integration with no blocking findings. Root rejected two unsafe cleanup drafts (per-window-only reset and discarding a corrupt registry), reproduced and fixed hide→dispose metadata loss, and strengthened the autosave mid-write test. The remaining common user-action error codes identified in final review now have Chinese/English guidance.

New UI regressions failed against the baseline before fixes. Tests use an isolated real App, real Hub and browser IndexedDB. The website-dialog UI scenario simulates the native boundary; independent Electron probes verify real WebContentsView, typing and cookie boundaries. CUA was unavailable during this audit, so these are not installed-App manual acceptance claims. No physical iPhone/Android, Windows runtime or long-duration soak was performed.

## CLI and compatibility

Browser typing and shared controller/storage fixes also apply to Bot operations through the existing `app_workbench` and `tarobot workbench run` Host contract. No new schema/protocol or reduced CLI implementation is introduced. Keyboard menus and layout presentation are App-only. Local website-data reset is an explicit trusted-device action; it must not become a Bot action or a remote Host CLI command. Existing report/widget display and Vditor/Excalidraw formats remain compatible.

## Remaining improvements and limits

If Vditor's main module chunk fails, a browser may cache that failure; the recovery text advises reopening the App if retrying helper resources does not recover it.

Background website audio has no consolidated mute/playing indicator yet; a future user-only control needs a design covering hidden conversations and multiple Hosts. This audit does not claim zero possible bugs, installed-release acceptance, or physical-device acceptance.
