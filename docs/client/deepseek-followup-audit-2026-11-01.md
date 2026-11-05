# DeepSeek follow-up audit — 2026-11-01

## Scope and review method

The owner requested a new DeepSeek audit of changes since its previous audit, with independent review by the implementing agent and **Claude Opus 5.5** before adopting findings. This is a source repair checkpoint, not a release or installed-App acceptance.

- Previous audit checkpoint: `5c2ff906fa01cb1fa0dc174052387d83883e4a30` (following fix `a46c269b71d22520d0f555c2b67d446d7ed02cdf`).
- Frozen reviewed head: `71e134b5aedbc89eb0b2b215c8bb2a423cb6d0bd`.
- Range: **112 commits / 620 changed files**, including vendored code, translations, tests and documentation. This is a diff-led audit with targeted reproductions; it is not a claim that every line or platform path was executed.
- Reviewed areas: Workbench routing/storage/editors/Design, browser lifecycle/extensions/network boundaries, remote screen/permissions/leases, native window geometry, queue/Agent Bus/CLI, Google Docs OAuth, updater/recovery, release cleanup and vendored-file integrity.
- DeepSeek supplied 12 candidate findings, 5 observations and rejected hypotheses. Opus independently adjudicated all 12 and contributed additional reproductions. Recommendations were not applied automatically.
- Exact evidence is retained under `/Volumes/gdrive/taro-tmp.noindex/deepseek-followup-audit-20261101/`: immutable `deepseek/report.md`, `findings.json`, `ownership-erratum.md`; `opus/adjudication.md`, `adjudication.json`, `independent.md`, `coverage.md`; root probes and test logs.

During read-only review DeepSeek incorrectly restored two OAuth files owned by the implementer. The exact latest candidate bytes were recovered from its saved copies and independently reviewed by Opus. Its erratum records the mistake. No installed App, real credentials or owner data were changed. Ownership was then restricted explicitly; Opus implementation was limited to the assigned extension and Workbench files.

## Findings and dispositions

| ID | Confirmed behaviour / review decision | Repair or retained boundary |
| --- | --- | --- |
| DS2-01 | A timed-out compatibility-policy load could finish during a retry and unload the retry’s active policy. | Track an activation in progress; before removing the default request filter, verify the policy is still loaded. Failure keeps the filter. |
| DS2-02 | Reload during a still-pending native extension load could clear its error and appear clean. | Keep the timeout visible and allow only one load of that extension ID. A late result reconciles with current ownership. Forgetting pending loads blindly was rejected. |
| DS2-03 / O2-03 | A control-grant withdrawal or missing Accessibility permission could terminate an otherwise authorized viewing session. | Release control and report a recoverable refusal while keeping video. Input flooding and invalid protocol remain fatal. Locked-target handling is not weakened. |
| DS2-04 | The Control button used the original HTTP grant after a live downgrade. | Use the live session’s `controlAllowed`; granting again does not automatically request control. |
| DS2-05 | Failed final Design persistence keeps a hidden editor/lease alive. | Reject unconditional destruction: it can discard the only unsaved copy. Recovery usability is evaluated separately from data-preserving retention. |
| DS2-06 | Concurrent initial layout creation, or a saved layout referring to missing Design content, could prevent Workbench initialization. | Adopt the winning initial layout after a CAS conflict. A missing/unreadable visible Design or note now reports its own error while the rest of Workbench opens; a revoked scope still stops initialization. |
| DS2-07 | The UI treated every immovable queue item as a reorder barrier, although the Host allows an owned prompt to cross an Agent Bus goal. | Add an explicit optional `reorderBarrier` from the Host; share client position logic across arrows, front/end and drag. Real control commands remain barriers. Old Hosts retain conservative behaviour. |
| DS2-08 | Cancelling quit after a verified installation can leave restart pending. | Rejected as a forced-quit fix: the existing restart fence and user’s unsaved-input cancellation must remain. Windows installer handoff after a cancelled quit remains unverified. |
| DS2-09 | An update with an unknown bundle state offers no automatic restart. | Rejected: launching an uncertain bundle is unsafe. Recovery/restore fencing remains. |
| DS2-10 | Deep equality over a 1 MiB byte array dominated a base64 test. | Use exact `Buffer.equals`; production encoding and byte coverage are unchanged. This improves test efficiency, not App runtime speed. |
| DS2-11 | The Keychain failure copy said “read” even for write/remove failures. | Use neutral “access” wording; preserve error code and recovery path. |
| DS2-12 / P-03 | An accepted `nothing_waiting` CLI control is a successful no-op, not proof of model receipt. | Keep exit 0 and JSON unchanged; print an explicit stderr notice. Never resend or retry automatically. Clarify CLI documentation. |
| O2-01 | Reusing an example Workbench request ID across turns conflicts with the durable prior receipt. | Require a fresh ID for each new action and the same ID/content for retries. Preserve conservative unknown-result handling; never advise a blind new-ID retry of a possibly executed action. |
| O2-02 | Viewing expires with its original HTTP authentication token (normally up to 15 minutes). | Retain expiry/security checks; show an explicit reconnect reason. Seamless reauthorization is a separate protocol enhancement, not implemented here. |
| O2-04 | The native sharing indicator changed its URL hash but did not redraw participant/control text. | Render on `hashchange`, retain one clock timer and text-only insertion. Verified in an isolated actual Electron window. |
| O2-05 | Hiding a viewer before media attachment sent pause before start and could fail the stream. | Start capture only when both channels are attached and the viewer is visible. Hidden attached sessions wait without capture; the original auth expiry still applies. |
| O2-06 | Sixteen unauthenticated viewer sockets could temporarily starve local target registration. | Reserve a separate bounded target pool (4) and viewer pool (16). Instance listener, one-use tickets and all authorization checks remain mandatory. |
| O2-07 | A failed whiteboard save followed by remount could display Saved and make subsequent saves conflict. | Track the actual stored revision, retain unsaved scenes and wait for the previous editor’s final write before remounting. Root review additionally reproduced closed-tab reopen draft loss; Opus also reproduced the replayed-create variant. The follow-up keeps the draft and its original CAS revision rather than replacing it with old stored bytes. Newer external saves and deletion still block stale writes. |
| O2-08 | Tab deletion ignored another window’s active editor lock and did not notify it. | Check the exclusive deletion lease without waiting; pause and restore this window’s own Design lease if refused. Notify other windows only after the storage commit. Full App two-page refusal/retry/deletion and reload passed in Chromium and WebKit. |
| O2-09 | Popup/extension-created pages bypassed live-tab limits and evicted other conversations’ pages. | Reserve pending page slots; refuse excess automatic opens without sleeping another page. Direct user-controlled lifecycle retains its existing rules. |
| O2-10 | A late wake after Host removal could recreate its partition registry and reattach extensions. | Recheck scope/task ownership after asynchronous capacity and zoom reads, before session/partition creation. |
| O2-11 | Maximize/fullscreen resize was remembered as a manual side-panel drag. | Read native mode before changing saved width; coalesce reads and reject stale replies. Normal outer-edge resizing and internal splitters retain their behaviour. |
| O2-12 / OBS-04 | Case aliases on macOS could duplicate a cleanup candidate or bypass active-path/latest-backup guards; an exception immediately after rename could strand quarantine. | Deduplicate by filesystem identity, compare kept backup identity, conservatively preserve case-alias active paths, resolve physical case, reject installed-path aliases (including a symlink into `/Applications` or `/System`), catch post-rename exceptions and restore. Only synthetic fixtures were used. |
| P-01 | With `backgroundThrottling:false`, a hidden Electron window still reports page visibility as visible. | Confirmed in actual isolated Electron. Gate automatic Design opening on native visible/not-minimized state; hide immediately retires the old endpoint. A stale initial read or broken event bridge cannot reopen it. Browser/mobile behaviour remains document-based. |
| P-02 | Clearing website data might also affect extension storage in that session. | Confirmed narrowly with an actual Electron extension worker: clearing retains `chrome.storage.local` and the loaded extension, but deletes its IndexedDB. Clarify the checkbox and explanation to include some extension data; installation/access grants stay. No change to clearing semantics. The earlier extension-page harness failed `ERR_FAILED`; it is not counted as evidence. |

The five DeepSeek observations were separately reviewed. Single-use ticket replay remains rejected; malformed/contract-violating receipts remain unknown until deadline; updater control fences remain; unknown source-less journal entries retain their bounded deduplication history. The post-rename cleanup exception boundary was hardened with a real failing fixture. Neither arbitrary journal eviction nor removal of update/auth checks was accepted.

Additional root finding **R2-01** is a preexisting OAuth lifecycle defect adjacent to the changed Google Docs configuration: cancellation/timeout during token exchange could still persist a late token. The repair aborts/fences the exchange. Once the vault write has begun, it reports the actual commit result rather than pretending to undo it. Closing the callback browser cannot strand a completed write. All credential tests use an in-memory vault and loopback callbacks, not real Google or Keychain state.

Root rejected two additional hypotheses: Design upload already counts the incoming file in its aggregate precheck and validates again before storage; a disposed Markdown writer is removed from its controller and no reused-instance resurrection path was demonstrated.

## Validation and evidence boundaries

These are separate, sometimes overlapping suites; counts must not be summed as distinct coverage.

| Area | Observed result | Evidence |
| --- | --- | --- |
| OAuth + gateway guidance/rejection | 42 passed; 3 targeted review cases passed (overlap) | `logs/root-guidance-auth-final.log`, `root-auth-review-regressions.log` |
| Queue/Bus/position helper | 100 passed | `logs/root-queue-order-green.log` |
| CLI no-op notice | 15 passed | `logs/root-cli-notice.log` |
| Hub screen authority + actual loopback WebSockets | 45 passed | `logs/root-screen-lifecycle-green.log` |
| Screen UI | Chromium 14 passed | `logs/root-screen-ui-green.log` |
| Sharing indicator + capture lifecycle doubles | 24 passed; isolated Electron indicator red → green | `logs/root-screen-indicator-tests.log`, `root/indicator-smoke.noindex/{red,green}.json` |
| Browser lifecycle | 37 passed; final extra fence 2 targeted passed | `logs/root-browser-followup-green.log`, `root-browser-followup-final.log` |
| Window resize hook/native IPC fixture | Chromium 28 passed again on committed `f0395cb` after Opus flagged the prior log/file timing | `logs/root-side-mode-postcommit.log`, `root/window-postcommit-source.json`; earlier logs retained |
| Native visibility read/events | 6 passed | `logs/root-desktop-visibility.log` |
| Actual Design hook + native bridge fixture | Chromium 4 passed; WebKit 4 passed | `logs/root-design-visibility-hook.log`, `root-design-visibility-webkit.log` |
| Workbench CAS/base64 prior root candidate | 51 passed / 1 unsupported-native-base64 skip | `logs/root-workbench-base64.log`; fallback still tested |
| Cleanup / artifact paths | Python 28 passed + Node 8 passed | `logs/root-cleanup-final.log`, `root-artifact-installed-alias-green.log` |
| Independent Opus review of root repairs | 152 Vitest + 79 Electron module tests + 51 Bus tests, 28 Python + 8 path tests passed (overlapping suites) | `opus/final-review.md`, `opus/logs/root-review-*` |
| Opus extension integration | 101 passed by Opus; root independently reviewed diff and 4/4 new regressions | `opus/logs/ds2-0102-green-repo.log` |
| Extension storage scope | Isolated Electron 45.1.0 worker: storage.local retained, IndexedDB cleared, extension remains loaded | `root/extension-storage-worker.noindex/result.json`, `logs/root-extension-storage-worker-active.log` |
| Workbench logic and final independent review | Opus 162 passed; root 30 passed plus original closed-tab probe red → green | `opus/logs/wb-reopen-green.log`, `logs/root-workbench-final-independent.log`, `root-board-closed-reopen-{red,green}.log` |
| Workbench full App persistence/deletion | Chromium 5 existing/new flows + 1 two-page delete + 1 writer-ownership/reopen flow; WebKit 2 new flows passed. Closed-tab retention, retry, external-CAS conflict and replayed create additionally verified at controller level. | `logs/root-workbench-integration-chromium.log`, `root-design-delete-two-windows.log`, `root-whiteboard-writer-final.log`, `root-workbench-integration-webkit.log` |
| Root + final integrated client build | Both passed; client source hashes unchanged after final build. Known large-chunk / mixed static-dynamic import warnings remain. | `logs/root-build-final.log`, `root-client-build-final.log`, `root/final-client-build-source.json` |
| Queue / clearing / ADHD browser regression | Chromium 12 passed; WebKit 2 targeted passed | `logs/root-ui-followup.log`, `root-ui-followup-webkit.log` |

Remaining boundaries: a failed final Design save can retain a hidden editor and block deletion; it is kept to avoid losing the only unsaved copy. An expired screen authentication token still requires reconnection. Pre-authentication viewer sockets can temporarily occupy the bounded viewer pool, and popup attempts have capacity checks but no new per-opener event rate limit. These were not presented as fixed or as demonstrated runtime regressions. Windows installer handoff after cancelling quit remains unverified on Windows.

No installed App was replaced or restarted. No real screen capture/remote input, foreign network, TCC grant, Google login, production credential, actual installer, real cleanup/trash or physical mobile/Windows acceptance was performed. Mock tests are not native acceptance. Actual Electron runs used isolated profiles and fixture content under `.noindex`; they establish only the behaviours explicitly recorded above.

CLI impact: queue barriers, OAuth lifecycle and Workbench request guidance share the same Host/protocol as the App. The control no-op notice is CLI-specific; JSON/exit semantics remain compatible. Native visibility, sharing text and panel geometry are presentation/native-window concerns and introduce no separate headless implementation. No versions were bumped and no release/install is authorized by this audit.
