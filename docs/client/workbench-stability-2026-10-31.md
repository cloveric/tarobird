# Workbench stability and efficiency audit — 2026-10-31

This audit starts from `2f0d591c8fdb84713f8f8b343c5391f585e89011` and was reviewed with Claude Opus 5.5. It covers the conversation controller, multi-tab/split lifecycle, Excalidraw and Vditor persistence, embedded charts, Electron pages, and the shared App/CLI/agent command path. It does not publish a release or update an installed App.

## Confirmed findings and repairs

| Trigger | Previous behavior | Repair and regression boundary |
| --- | --- | --- |
| A conversation revision revalidates an open chart, including global revisions caused by updates to another conversation | `ChartPane` first removed its message, unmounting the interactive widget and restarting its worker even though the source was unchanged; interaction state and runtime error counts were lost | Keep the validated content while rechecking the same controller/source identity. A different source hides old content immediately; deleted/inaccessible sources still retire it. A real browser regression preserves both the iframe node and a live counter across incoming chat, then confirms source deletion removes them. |
| Native initialization fails, or the conversation unmounts while initialization awaits the bridge | Event listeners remained; restoration could open pages after disposal; rejected promise continuations could escape | Failed owners dispose, late subscriptions unsubscribe, each restoration await rechecks ownership, and the React owner registry disposes initializing controllers immediately. Browser tests exercise failure/retry and leaving ADHD during initialization. |
| A note finishes loading after the workbench is hidden | The hidden note retained its single-writer lock | Late loads run the normal flush/release path, preserving dirty recovery and active Bot users. Reopening can reacquire the note. |
| Initialization loads a saved board but the workbench never becomes visible | The first hidden notification did not retire the board cache | Initial hidden cleanup releases saved board data; reopening reloads it. Existing dirty-board save/retry behavior remains. |
| Several wake/open/reveal requests overlap | One tab could acquire two WebContentsViews; different tabs could exceed the live-page limit | One installation per tab; pending installations reserve capacity; simultaneous eviction skips pages already closing. |
| An automatic sleep receives a late close response | The page's tab could disappear as though the person had closed it | The late response retains a sleeping tab. Repeated refused or timed-out closes also release their temporary event listeners. |
| A Bot input times out while a page operation is still pending | A later Bot input could interleave; a late text fallback could still modify the page | Input operations wait for prior unsettled input and recheck cancellation before later side effects. Reads/navigation remain available for recovery. |
| Bot open is cancelled while waiting for a free page slot | The open was absent from the cancellation index and could still create/navigate a page | Pending opens are cancellable and check the active App document. A page created before cancellation remains recoverable without changing the selected tab. A `closed` native receipt never restores a tab. |
| Native page and local tab metadata diverge, or a page has a long title | A stale tab could not be closed; a long title could prevent saving the new tab | An explicit native `tab_not_found` permits local close; other refusals remain errors. Titles are bounded without splitting a surrogate pair. |
| The live-page limit prevents automatic wake | Identical layouts could repeatedly retry wake and emit more state events | A failed automatic wake stops until an explicit wake; the sleeping-page button remains available. |
| Unrelated chat/editor DOM changes while a browser pane is mounted | Identical layout IPC and native bounds work repeated every frame | Deduplicate by views, visibility and device pixel ratio. Real geometry/overlay changes still dispatch; only the latest failed dispatch invalidates the cache. |
| A successful Bot close updates tab registration before its receipt arrives | Host could replace success with `unknown/workbench_target_closed` | After admission, the authenticated App receipt owns the outcome. Pre-admission target checks, membership/device/source checks, disconnect cancellation and deadlines still apply. |
| DeepSeek installs the current native App tool set | The whitelist omitted `app_workbench` and capped installation at four definitions | Permit the five-tool contract, including workbench, and the four-tool variant with widgets disabled. Logged user-call provenance and the rejection of unknown tools remain tested. |

## Efficiency evidence

- The layout regression reproduces **60 extra identical IPC calls for 60 unrelated DOM updates** on the baseline; the repair sends none after the initial layout. The real App browser test similarly exercises 30 unrelated mutations, then resize/hide/reopen behavior.
- A repeated-close probe reproduced `destroyed` listener growth from **1 to 21** after 20 refused closes; the repaired count remains **1**.
- Concurrent wake probes reproduce an orphan view and a live-page count above the configured limit on the baseline; repaired views and tracked pages agree and respect the limit.
- A bounded whiteboard probe (500 shapes, 8 MiB image data, 60 `BoardSession.local` calls on this Mac) measured median **2.28 ms**, p95 **3.74 ms**, maximum **9.47 ms** before any whiteboard copying changes. This measures only the session update, not full editor painting or phone performance. No speculative scene/file cache rewrite was introduced.
- The isolated real-Electron fixture measured **419 MiB RSS** with no browser pages, **892 MiB** with four animated 1,500-paragraph fixture pages, and **391 MiB** after sleeping all four. Hidden live pages remained resident (about **844 MiB**); hiding is not equivalent to freeing them. Page frame rates fell from about 60 to 2 fps when hidden. These are one development-runtime sample under concurrent regression load, not release-package or real-chat benchmarks.
- Repeated close/reopen and sleep/wake cycles returned to one App webContents, zero child views/routes/live pages/pending tasks, and the same window/App listener counts. RSS drift was 4 MiB in that bounded run, not a long-term leak guarantee.

## Verification

Validation uses isolated data and temporary output below `.noindex`; no installed profile, real conversation, or production Host is restarted. The test evidence directory is `taro-tmp.noindex/workbench-stability-20261031`.

- Baseline: 112 focused logic tests, 20 Electron unit tests, 30 Chromium workbench tests passed.
- Final focused logic: **216 tests in 14 files passed**, covering Host admission/receipts, CLI/native tools, controller, layout, boards, notes, persistence and DeepSeek tool installation.
- Electron unit suite: **160 passed**, including **27** browser lifecycle/cancellation cases. Real Electron browser operations: **26/26**; real resource/interaction/cycle checks: **4/4**.
- Chromium workbench suite: **33/33** before the final chart-refresh repair; afterward, the affected workbench file passes **7/7**, including its new lifetime regression (`chart-fixed-chromium.log`). The lifecycle/ADHD cases also pass after the controller/layout changes.
- WebKit's initial run had 29 passes, two failures and one CDP-only skip. After diagnosing the geometry and widget lifecycle failures below, the affected workbench file passes **7/7** (`chart-fixed-webkit.log`). The widget-retry and lifetime/source-deletion cases then each pass **three consecutive runs**, **6/6** total (`chart-fixed-repeat.log`), without test retries or a relaxed runtime-error threshold. The WebKit matcher now includes `workbench-local-journey`, previously omitted by its single-suffix pattern; that journey passes **1/1** separately. These are full-suite plus affected-case receipts, not a claim that the whole suite was rerun after the final repair.
- Client typecheck/build and standalone Host build pass. The standalone graph contains 471 modules.
- The Electron harness exercises real preload/NativeOwner/WebContentsView operations with fixture pages and an isolated helper. It is separate from the full App's browser tests, whose native bridge is simulated.
- A WebKit geometry assertion exposed a 0.000122 px rounding difference; its tolerance now allows half a CSS pixel. The intermittent widget retry failure led to the confirmed chart-refresh lifetime bug above. The fixture also checks the actual busy-attribute contract before interacting; a temporary test expectation of the literal `false` was corrected because the ready attribute is absent.

## Preserved limits and follow-up boundaries

- Host command deadlines remain about **25 seconds**. A navigation may finish after that deadline, so `unknown` is not a failure guarantee or permission to replay the action. Keep the uncertain action's request ID (resending it returns the recorded outcome) and reconcile with fresh `list`/`observe` reads; never replay the action under a new ID. CLI, native tools and App use this same Host result contract.
- Electron cannot withdraw an already-issued `close({waitForBeforeUnload:true})`. A hung page's late response now preserves its tab, but this does not promise recovery of an unsent third-party web form. The existing unsaved-change protections and user confirmation remain.
- A stuck page can block later Bot input until its own deadline; reload/navigation can recover it. User takeover and target ownership are still enforced.
- Windows physical execution, physical iPhone/Android behavior, long-running soak, signed-package upgrades and a new real-model round trip are not established by these tests. Windows remains pending as previously agreed.
- Root-wide `tsc --noEmit` still reports the existing 138 diagnostics; the audited baseline has the same unrelated diagnostics. The standalone build and client typecheck/build are the executable build gates; this audit does not claim a clean root-wide typecheck.

No release or local installation is part of this change.
