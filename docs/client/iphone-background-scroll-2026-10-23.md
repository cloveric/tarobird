# iPhone history reading during background output

The report was stuttering and vertical jumps while reading conversation A as
conversation B produced output. Several mechanisms were reproduced separately;
background traffic alone did not move an already measured, idle viewport.

- Newly mounted history rows differ from their estimated heights. The old iOS
  path changed their virtual positions immediately, then replayed a native
  correction after the gesture. An isolated 65-message fixture moved its visible
  anchor by **830 CSS pixels** during that correction. This is browser evidence.
- A background turn failure inserted a global error banner above the reading
  viewport: its top moved from 56 to 109px and its height shrank by 53px.
  Connection and sync notices used the same in-flow layout.
- Unrelated cache events invalidated the host pool, Workspace, and mounted
  run/question subscriptions. References constructed outside a memo boundary
  rebuilt unchanged message content. For 16 background updates, the settled
  reader rendered Workspace 48 times.

## Changes

`reading-scroll.ts` uses public offset observation, size-change and scroll APIs.
During iOS touch/momentum it accounts for measured height changes in a logical
offset and list origin, preserving the visible anchor without writing the native
offset. Mounted row positions and their origin are painted together: the first
candidate otherwise exposed a 300px single-frame mismatch before React committed.
Restoring the origin and native offset happens together after settling.
An idle timer must also pass two stationary animation frames before a native
write, so queued scroll events after a blocked main thread can cancel it.
End/cancel listeners retain the original target even if virtualization removes
it. Elastic edge overscroll is allowed to finish. Hidden geometry never replaces
the retained logical position; switching to the inbox and back is covered.
No dependency-private fields, patched node_modules, fixed message heights or
disabled measurement are used. Desktop retains its existing scroll path.

Transient connection, sync and error notices use an overlay below the conversation
header, keeping the viewport geometry fixed when they appear or are dismissed.

The host pool no longer republishes when only a cache revision changes. Directory
and per-conversation readers still receive events; connection, identity,
capability, presence, route and permission changes still propagate. Run cards
retain stop failure/reconnect receipts; question cards retain outbox revisions.
`ConversationMessageContent` builds references inside its memo boundary while
retaining live source changes and navigation.

The settled fixture now renders Workspace **32 times** for 16 updates; completed
run cards and quoted content do not render again. Opening B verifies its final
output, so dropping delivery cannot satisfy the assertion. These are render
counts, not physical-device frame rates or a universal percentage speedup.

CLI applicability: presentation only. The headless CLI, Hub protocol, database,
message delivery, authorization and queue behavior are unchanged.

## Verification and limits

The fixture uses an isolated real Hub and real client storage, renderer and
Markdown workers. Expanded regression passed 45 Chromium and 44 WebKit cases
(one trusted Chromium touch case is skipped by WebKit). After isolating quoted
content, the 47-case content/attachment/reading suite passed in each engine.
Final lifecycle checks passed 5 Chromium and 14 WebKit cases: newly measured
history, settled reading, held touches, cancellation, inbox return, current-chat
growth/shrinkage and conversation entry. Client translations, TypeScript and
production build, and the standalone Host build passed.

The final review expanded the focused suite to 13 cases in each engine (including
error-banner geometry and ResizeObserver end-of-frame sampling). One assertion
was updated to wait for the intentional idle handoff, while checking the anchor
both before and after it; that case passed on focused rerun in both engines.
Six additional probes against a production build covered idle/touch height
changes, cancellation, simulated momentum, and synthesized fling with/without a
250ms main-thread block. Height/momentum probes measured zero unexplained
start/end-of-frame displacement. The blocked-fling correction occurred after
inertia, followed only by the scroll event caused by its own offset write.
These isolated probe sources and JSON results are retained in the evidence folder.

Local evidence: `/Volumes/gdrive/taro-tmp/iphone-scroll-20261023`. Opus 5.5 xhigh
independently reproduced the baseline in a separate worktree and isolated Hub,
including touch cancellation, detached targets, delayed inertia corrections,
background error banners and the candidate's one-frame coordinate mismatch.
Those concrete findings were incorporated into this revision. Browser
simulation and development render counts do not certify physical iOS inertia,
ProMotion pacing or native keyboard/lock-screen transitions.

The physical iPhone 15 Pro Max / iOS 27.0.1 remains paired and connected, but the
computer-use native pipe failed during this run. No new successful physical
scrolling acceptance is claimed. Device verification build **1.0.105 (3)** was installed with `devicectl` and
read back from the physical device's installed-app inventory. This was an update
of the same bundle, without uninstalling or resetting App data. Its native input
binary is unchanged from the earlier candidate; the bundled frontend is rebuilt
from this revision and the bundle is re-signed. Owner scrolling feedback is pending.
This verification build is separate from published TestFlight 1.0.105 (1) and
any later formal release; the installed production Mac/Host was not changed.
