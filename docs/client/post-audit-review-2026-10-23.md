# Follow-up review of the iPhone, network and conversation changes

Review baseline: `361fa7e`, after the preceding audit and local App 1.0.104 /
Host 0.1.451 updates. Release target: App 1.0.105 / Host and CLI 0.1.452.
Claude Opus 5.5 (`claude-opus-5-5[1m]`, xhigh) reviewed the preceding change
range independently. Findings were reproduced before repair, then reviewed and
integrated with focused regressions. This document records source disposition;
artifact publication and native installation require separate release receipts.

## Confirmed repairs

| Area | Trigger and resulting behavior |
| --- | --- |
| Invitation focus | WebKit pointer clicks did not focus Add device. Closing its invitation returned to an older connection control. The actual trigger now receives focus before opening. |
| Route status | An add-only estimate mistook deliberately removed routes for capacity failures. Status now comes from the actual provenance-aware merge, with independent Host/network results and a retry after route edits. Late results cannot reinstate a diagnosis from an obsolete target network. |
| Historical catch-up | An unrelated rejected request could close a healthy socket while another conversation synchronized. A request error is no longer automatically fatal for independent background catch-up; authentication revocation remains fatal. |
| Large historical frames | One large snapshot frame plus an ordinary live event could trip the backlog limit and cause repeated reconnects. The bounded queue accounts for its single largest frame separately, whether sending or waiting, while limiting the remaining backlog. |
| Side attachment names | Truncation could split a Unicode surrogate pair, causing the real Codex app-server to reject the JSON-RPC line. Filename limits now respect whole code points and UTF-8 filesystem limits. |
| Side attachment allowance | Failed preparation, refusal or cancellation before engine invocation consumed the handle's allowance. Such requests now return their bytes and remove only their unused private copies. Copies already given to the engine remain available. |
| Kimi side conversations | Opening a side conversation could kill a parent worker claimed by a main turn before `pendingTurn` was installed. Turn reservations cover that interval, and accepted relay events settle before idle release. |
| Codex side boundary | A native fork admitted during the parent turn/start receipt gap could include unfinished parent input. Side opening now refuses that unidentified interval; a known active turn still uses the native before-turn boundary and an idle parent forks normally. Cancellation and goal-start reservations use the same guard. |
| Backup maintenance | A malformed or newer-format backup policy prevented all maintenance. Daily record pruning and orphan collection now proceed independently while the failed backup remains due for retry. |
| Recovery diagnostics | Stopping recovery for an inconsistent receipt or unfinished work discarded the original provider error. The stop condition now retains that cause without changing retry or accounting policy. |
| Official restore | A restored database could reuse old sequence numbers and later pass a client's cursor, causing an incomplete merge. A restore lineage binds each committed cache cursor to its history; a mismatch replaces the conversation atomically. See [restore synchronization](restore-sync-lineage-2026-10-23.md). |
| Widget runtime | Predictable heartbeat values and prototype serialization allowed a non-yielding loop to evade the stop monitor. Runtime messages now use captured serialization primitives and unpredictable ping nonces. Unneeded GPU/media/font APIs are removed from the guest Worker. |
| Widget compatibility | HTML handler detection could start an empty Worker, and initial element/annotation limits could quarantine valid content. Detection now agrees with the parsed document, static validated content remains visible, and unsupported initial snapshots do not create a CPU quarantine. |
| Widget visibility | An element touching the viewport with zero visible area received no later observation when entering. A second observer threshold starts the report once it becomes visible. |

A separate Codex 0.163.0 process reproduced the side boundary defect using
new isolated threads: a fork without a before-turn boundary included the
unfinished parent input. Native history inspection supplied the boundary control.
One attempted model control was refused by the provider and is not counted as
a passing result; it was not retried. No production thread was modified.

The maintenance and recovery regressions failed before repair and passed after
it. The restore regression uses the official backup/restore functions with
isolated state, and browser coverage uses real IndexedDB. Race controls include
late socket events, late snapshot starts and competing snapshots after restore.
The widget suites passed 57 Chromium cases (two skipped) and 56 WebKit cases
(three skipped); the report guidance now explicitly defines count as displayed
row count, preserving the published aggregation semantics.

## Findings that did not justify a product change

The original signed Mac App rendered panels and virtualized message rows
correctly when opened normally in the foreground through Finder. The apparent
missing panels and stale rows occurred in automation's background presentation.
An experimental animation workaround was withdrawn after that control; it is
not counted as a product bug fix. [UI review details](post-audit-ui-2026-10-23.md).

An existing keyboard-focus regression also passed before any additional
viewport change. The preceding iPhone safe-area/layout repairs remain; this
follow-up did not add a speculative keyboard workaround.

## Product and acceptance boundaries

Automatic database backups contain more than chat records. Their new default
retention is one UTC calendar day, with zero available to disable them. Changing
retention prunes only named automatic snapshots; manual/full exports and
unrelated files are outside that policy. Existing seven-day automatic history
is reduced according to the selected setting on the next maintenance pass.

Retained side conversations remain subject to the engine's capabilities and
the per-Bot handle limit/lease. Browser tests and synthetic engine fixtures do
not establish every provider's live behavior or physical-device performance.

Tailscale issues [53](https://github.com/cloveric/tarobot/issues/53) and
[59](https://github.com/cloveric/tarobot/issues/59) track the outstanding physical
network matrix. The current Mac reports Tailscale NeedsLogin. Already paired
devices use their trusted reachable routes without another scan; tailnet
membership alone does not grant TaroBot membership. Cellular handover,
P2P/DERP, sleep/reconnect and multi-host results remain explicit acceptance
items, rather than inferred from browser tests.

Shared Host repairs also apply to the standalone CLI. Restore and backup
management retain their existing headless entry points and authorization.
Presentation-only fixes add no separate CLI command. Hub schema remains 21 and
protocol remains 1; new restore fields are capability-negotiated.

Final package, publication and installation evidence is recorded in the
[1.0.105 release verification](../releases/1.0.105-verification.md).
