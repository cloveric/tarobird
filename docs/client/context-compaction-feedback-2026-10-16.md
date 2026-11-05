# Context compaction progress feedback

A long-lived Codex conversation showed “正在思考” and a no-progress warning
while the host was actually compacting its context before submitting the next
user request. The maintenance RPC ran before the adapter created a PendingTurn,
so its native notifications had no foreground progress sink.

Read-only incident evidence from 2026-10-16 (Asia/Shanghai):

- 00:20:46: the Telegram-cache request reached the host.
- 00:20:48–00:22:47: the engine recorded a ContextCompaction operation lasting
  118.531 seconds.
- 00:22:47: the actual user turn started.
- 00:23:33: the engine and host recorded a successful final reply.

The request completed; the reported defect was missing maintenance feedback.
No user session was rebound, cancelled or restarted during the investigation.

The adapter now emits correlated context-compaction start, completion and
failure events through the waiting request's callback. Publication failure
cannot alter compaction or its existing recovery behavior. The native run
journal records the operation as maintenance, with zero additional tool actions
and no summary text. Its current activity says “正在整理对话上下文”; the next
user turn remains active after compaction completes. Failed/stopped receipts
cannot be reopened by a delayed start or completion. Quiet-time notices still
reflect the last actual event rather than a synthetic heartbeat.

Desktop and headless hosts use the same adapter and run-record path. No separate
CLI command, new run phase or schema version is needed; the existing strict v1
summary and journal remain valid. Older clients can read the maintenance entry
as a generic narrative activity until their presentation code is updated.
Fallback card footers and conversation previews also carry the explicit
maintenance label, without adding it to the assistant answer.

Verification artifacts are under
`/Volumes/gdrive/taro-tmp/tarobot-compaction-feedback-20261016`.
The two new capture regressions failed before the fix. Focused adapter, run
capture/presentation and Gateway card/writer suites pass (206 tests), and both
standalone-host and production-client builds pass. The five-engine desktop/phone browser matrix passes all 10 scenarios, including
visible compaction, quiet-time feedback, journal receipts and continuing with the
next user turn. Rendered desktop/phone screenshots were inspected. The final
footer/preview refinement is checked with the two Codex scenarios again.

This is a source fix. The installed Mac app, active host and published Android
1.0.72 artifact have not been replaced. A future host-affecting release must
package the matching standalone CLI according to the release checklist.
