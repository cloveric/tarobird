# October 23 release audit: 1.0.106

This review covers the unreleased changes after the 1.0.105 source `b78df40`,
initially through `6d5da29`, plus the subsequent host-address clarification and
integration fixes. The independent reviewer was CC1, Claude Opus 5.5 with xhigh
effort. All edits use isolated worktrees; existing production identity, history,
network membership and active tasks are not audit fixtures.

## Confirmed corrections

- Host connection settings now display complete LAN/Tailscale URLs and ports,
  offer copying, and give read-only refresh completion/failure feedback.
  An enabled but temporarily disconnected Tailscale route also offers read-only
  refresh; checking recovery does not require preparing or restarting the host.
  The address panel uses the existing surface color token.
  Route forms identify this host, explain first-time pairing versus an already
  paired device changing routes, and use “添加此主机的其他地址”. See
  [connection clarity](tailscale-connection-clarity-2026-10-23.md).
- Video cover decoding could receive its one-shot frame callback before
  `loadeddata`, fail to capture, and occupy the shared queue until timeout.
  The decoder now remembers the presented frame and captures when data is ready.
- Video size attributes were independently clamped by CSS, creating a tall
  player box with controls far below the picture on a phone. The reader now
  fits both dimensions together into its available space.
- Escape in an otherwise empty side panel could discard an active recording.
  An unfinished recording now counts as content. A completed recording is also
  retained when the attachment count is full; the user can remove an attachment
  before sending, and send-time validation still applies.
- The stable App instruction contract exceeded its existing length assertion
  after native task guidance was added. The guidance was compressed, its budget
  explicitly adjusted once, and the behavioral instruction covered by tests.
- DOMPurify was updated from 3.4.16 to 3.4.17. Both the host production-dependency
  audit and the client audit report zero known advisories after this update.
  This is dependency hardening; the reviewed call sites do not use the affected
  SAFE_FOR_TEMPLATES/IN_PLACE/XHTML combinations. See the
  [upstream patch](https://github.com/cure53/DOMPurify/releases/tag/3.4.17).
- Android release lint rejected restoring the saved display-cutout mode from an
  untyped integer with a negative sentinel. The mode is now saved in the
  framework's typed layout field and absence represented by null. Restoration
  keeps the same behavior without suppressing lint or resetting other window
  attributes. The isolated release assembly, unit tests and release lint pass;
  the final platform pipeline repeats these checks from the new freeze.

The Android release build code is advanced to 2026102302 in both the source
default and the release freeze. Reusing the preceding build code would prevent
in-app upgrades, and overriding only Gradle would disagree with the final icon
verification script. App version 1.0.106 and Host/CLI 0.1.453 are aligned.

## Review boundaries and retained behavior

The group draft, discussion mode, offline recovery, ADHD selection handoff,
platform density, scrolling and motion slices were independently reviewed.
No further product defect was confirmed in those slices. iPhone adjustments
remain scoped separately from Android/desktop and their settings previews.
Temporary side conversations retain their existing purpose.

Claude Code 2.1.307 probes confirmed that two idle queued inputs are separate
turns, and that interrupt acknowledgement, result and terminal lifecycle arrive
in the order handled by the stop fence. The App's explicit pending queue is
separate from native supplementary input. Task controls, recovery token scope
and adoption receipts use shared Hub authorization. Current CLI foreground
interrupt can also stop its background subagents; this native limitation is
explained, not represented as independent preservation of every background job.

Low-probability hypotheses without a reproduction remain hypotheses: a future
CLI reversing its result/lifecycle order, an old group draft racing another
window during migration, and a connection-object swap bypassing its expected
Workspace remount. Existing group revision guards intentionally reject an
outdated queued send rather than silently rebinding it to changed settings.

## Validation

The integrated Host source and version bump passed the full pre-complete gate:
465 files, 6,318 passing tests, 5 skips; 77 native Rust tests; standalone graph
validation (437 modules), client type/build/translation checks, author checks
and secret scan. The subsequent product edits are client-only video and side
recording fixes. Their added decoder test and the instruction contract pass
23 focused unit cases. Integrated video, recording and queue browser cases
passed 13 in Chromium and 11 in WebKit. The integrated image export/long-image
checks passed another 5 Chromium cases. These are not added to the full-suite
count as though that full suite had been rerun after integration.

Root connection coverage: Chromium 21 cases, then the final address/copy
variant 12 cases; the disconnected-refresh follow-up passed 12 cases in each
engine; WebKit settings/multipath/widget/document coverage 43 cases.
Chromium widget/document/settings/native-back coverage passed 32 cases. Two
WebKit QR-repair reloads failed under concurrent load, then both passed in
isolation. Independent repetition also found this intermittent failure at the
released 1.0.105 source: after reloading with unreachable saved routes, settings
may not become visible within 20 seconds in WebKit. It is not attributed to the
new host-address UI; possible physical-iPhone startup latency remains open.

Independent mobile coverage passed 42 cases in each of Chromium and WebKit,
plus 11 viewport unit cases. Group Host/API/CLI coverage passed 105 focused
cases; WebKit offline/reply-cache/recipient cases passed 13. The review retained
initial load-related failures and recorded their isolated reruns instead of
claiming the initial runs passed. Independent final media/image coverage passed
69 Chromium cases (2 skips) and 62 WebKit cases (9 skips); side/attachment
coverage passed 34 cases in each engine. The queue-fence journey now has a test
timeout long enough for its own 6-second polling allowance; both integrated
cases pass without changing runtime behavior.

Several old test expectations were corrected without changing product policy:
loopback addresses are not shareable invitations; a new direct route does not
force a name-based switch from a healthy relay; pending-message lists exclude
the claimed message; phone host connection uses the direct current entry; image viewers initially
focus their passive title, with Tab retaining access to the close control.
Two-device pairing/history and the two-host equal-conversation-ID action target
journeys pass with the current UI and authorization policy.

Final packaging, published artifact checksums, actual engine round trips and
local installation receipts are recorded in the
[1.0.106 release verification](../releases/1.0.106-verification.md).
GitHub-hosted CI did not start because of the account billing/spending limit;
it is not reported as a passing cloud check. Browser keyboard/motion and phone
contexts do not establish physical iPhone/Android acceptance. During this audit,
the connected production host reported LAN listening and Tailscale enabled but
not listening; no real tailnet/cellular/P2P/DERP result is inferred.

## CLI impact

Host features in the accumulated release (group notes/guards, Claude task and
steer controls, queue protection) retain shared App/CLI APIs and regression
coverage. This audit's media, side draft, host-address labels and refresh
presentation add no separate headless behavior. `network local --tailscale
--json` already reads the same host status. Publish CLI 0.1.453 from the same
frozen source as App 1.0.106, verify clean install and existing-host upgrade,
and preserve the current host's identity/history during local activation.
