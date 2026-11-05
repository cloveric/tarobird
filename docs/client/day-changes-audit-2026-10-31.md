# October 31 change audit

Joint review of `48318df..1ff5650ad792a45b22810b70074acee602644405`: 16 commits,
167 changed files. The scope includes the workbench, remote Mac screen service,
HTML widget defaults and legacy reports, queue promotion, avatar/editor sizing,
action wrapping, resize dividers and side-window alignment. This is a source
repair and regression check; it does not publish or install an App.

The independent reviewer was the configured `claude-opus-5-5[1m]` Bot. Root
reviewed persistence, shared client flows and UI regressions. Opus independently
reviewed screen authorization/transport/target lifecycle, Electron browser
ownership/updater integration, widget contracts and the small UI changes.
Production-file ownership was separated before edits: Opus fixed the Electron
browser interrupt path; root integrated and reviewed the remaining fixes.

## Confirmed defects and repairs

| Area | Reproduction | Resulting behavior |
| --- | --- | --- |
| Whiteboard preservation | Fail the current board's IndexedDB save, then create/import another board or create a note. The old board could be unmounted without a successful save. | All paths flush editors leaving view before committing the new layout. Failure keeps the editor and layout available. Recovery saves the old content before switching. Board pruning stays inside the serialized layout change. |
| Screen encoder credits | Three decoder ACKs arrive more than 2 seconds after capture. The Hub discarded them, permanently consuming all three outstanding encoder credits. | A recorded, current-generation ACK returns its credit once even when late. Target confirmation and input freshness checks remain unchanged; stale video cannot acquire control. Failed ACK delivery explicitly ends the session rather than leaving a frozen stream. |
| Viewing after rejected input | Send stale-frame, expired-lease, expired-renewal or stale-sequence/geometry input through actual viewer WebSockets. The authority released control, but the socket wrapper then closed viewing too. | Those four control refusals retain the authorized viewing session after releasing control and notifying the viewer. New video continues; control requires a new explicit acquisition. Malformed protocol, unauthorized access and transport failures still close the session. |
| Policy after unpairing/rekeying | Grant a device, revoke it or replace its key, then carry the current policy forward to Disable. The obsolete grant caused `screen_device_changed`, blocking even Disable. | A signed configuration discards unchanged obsolete grants from the current policy. New or changed invalid grants still fail. An old grant never transfers to a replacement key; once removed, reintroducing it is rejected. Revision and signed-receipt replay rules remain intact. |
| Browser task interruption | A slow Bot `open` overlaps a later Bot step on the same tab, then hide, retire, quit or cancel runs. The interrupt path called a nonexistent `resolve` on the running open task. | Directly running tasks are marked cancelled and settled by their own runner. Queued tasks retain their existing resolver path. A navigation already dispatched is not falsely reported as undone. |
| Group/message alignment | Expand side chat or workbench from 1200 to 1600 px while the main conversation width stays fixed. Group navigation moved 8 px and the message list lost its 20 px top inset. | Group and message insets remain stable across the viewport breakpoint, including closing the extra panel. This complements the earlier conversation-title fix. |
| CLI widget guidance | `workbench publish` help still recommended `{title,summary,html\|report}` despite the shared HTML-default policy. | Help recommends HTML and mentions report only for an explicit user request. Existing report messages, schemas and compatibility contracts remain readable. |

The broader browser run also exposed six obsolete typography tests that manually
selected the removed TTY/Paper/Agent/Pixel themes. These were test-matrix failures,
not evidence to restore deleted themes or change the product fonts. The matrix
now uses the actual nine-theme catalog plus the independent ADHD reading size.

## Compatibility and unchanged boundaries

- Host screen repairs apply to desktop/mobile viewers and the headless CLI through
  the same policy and socket authority. No new permission, ticket, protocol version
  or input capability is granted. Frames/input do not enter message history.
- Workbench UI, Bot requests and CLI workbench requests share the repaired
  controller. No alternate CLI persistence implementation was introduced.
- Alignment and typography-matrix changes are presentation-only; standalone CLI
  rendering is not applicable. CLI help itself was checked separately.
- Existing report rendering and persisted v5-v7 tool contracts remain covered;
  current HTML-default guidance and v8 hashes remain covered. Queue promotion,
  avatar settings, narrow action wrapping and panel dividers received review and
  browser regression coverage without speculative product changes.
- CLI theme Bot-avatar sizing remains consistent across devices as requested;
  it was not silently restricted to desktop. Divider styling retains the owner's
  normal thin accent line and the existing larger drag hit area.

## Verification

Evidence: `/Volumes/gdrive/taro-tmp.noindex/day-changes-audit-20261031`.

- Initial focused logic baseline: 29 files / 297 tests passed.
- Initial complete Electron suite: 223 tests passed.
- Save-before-switch negative reproduction: create/import failed before the fix;
  the controller/persistence regression then passed 28 tests, including creation
  of a note while leaving a dirty board.
- Real browser quota-failure journeys draw a rectangle, reject the old board's
  IndexedDB write, verify the same editable board remains visible, then recover
  storage and read back the saved rectangle after switching.
- Screen authority negatives: three tests failed before correction (late ACK,
  revoked grant, rekeyed grant); four actual WebSocket refusal cases also failed.
  Five affected logic files passed 77 tests after correction. The additional
  ACK-send-failure case failed before correction; the final authority file passed
  32 tests including that case.
- Group-navigation/message-inset reproduction: two Chromium failures before the
  CSS change, then two Chromium and two WebKit cases passed.
- Widget format-policy/help: five tests passed. Opus independently ran 81 widget,
  report, format-policy and DeepSeek-tool tests.
- Complete Electron suite after the frozen browser fix: **224/224 passed**.
  Root verified both Opus-owned file hashes before this run. Opus additionally
  ran 74 browser/service/owner/updater cases and stabilized the slow-load race
  with explicit deferred gates, rather than sleeps.
- Broad WebKit run: **114 passed, six obsolete-theme failures, one skipped**.
  The corrected current-theme matrix passed all six affected cases on rerun.
  The skipped multi-board memory/counter case requires Chromium CDP.
- Broad Chromium run: **133 passed, one setup failure**. That failure occurred
  during a concurrent client rebuild: its trace records a 404 for the old hashed
  `assets/connection-C7haCi9I.js` before pairing completed. Once build output was
  stable, the same menu/focus case passed on targeted rerun. No application
  pairing code was changed to hide this test-environment failure. Together the
  broad run and rerun cover all 134 selected Chromium cases.
- Both quota-failure editor journeys passed in Chromium and WebKit. The four
  focused group-inset checks above are additional to the broad runs.
- Final client production build (including translations/TypeScript) and standalone
  Host build passed. The compiled CLI help was executed and its HTML-default
  wording checked. No claim of a package installation is made.

## Remaining acceptance boundaries

These checks do not prove real remote-desktop acceptance. Actual screen capture,
TCC permissions, native event-tap behavior and input posting, static/hidden and
multiple displays, cross-machine/relay behavior and physical Windows viewing
remain pending the owner's selected VM or dedicated-window environment. No real
screen capture, event tap, native input posting, production restart or update was
performed during this audit.

Read-only review also identified hypotheses requiring separate reproduction:
static capture may not produce a new frame inside the control freshness window;
the native monitor uses a filtering tap despite pass-through intent; resets may
leave old-generation frames briefly in transit; pre-authentication screen sockets
share a small global cap. Review also noted the interval between screen stop and
final App quit, update states after replacement but before restart, and whether
an unload-blocked popup can survive a Host-local website reset. Their harmful
outcomes were not reproduced in this pass. These hypotheses remain recorded for
separate controlled acceptance, not presented as fixed by this patch. The existing
repository-wide TypeScript baseline is also not represented as clean by a
successful standalone build.
