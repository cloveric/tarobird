# DeepSeek writer handoff recovery — 2026-10-12

The reported 16:55 App exchange was correlated read-only against the installed
host's message store and turn timeline. The first turn started at 08:55:23.985Z
and failed at 08:55:26.377Z with `SessionAlreadyOwnedError`'s message: the session
was already owned by an active write handle. The repeated user message started
at 08:55:33.608Z and completed at 08:55:41.225Z. The same ownership error was
recorded twice elsewhere that day. Private session/message identities and chat
content are intentionally omitted here.

The installed DeepSeek Harness 0.2.0-rc.2 controller maps this persistence
failure to `session/writer-held` with the session identity in `details`. For
`session/prompt`, agent resolution precedes inbox admission. The bridge formerly
surfaced that known refusal immediately as a generic execution failure. The
logs establish the refusal and successful next request; they do not identify
the exact upstream owner or explain why its lifecycle was still draining.

## Behavior

- Only `session.create` and ordinary `session.prompt` retry a typed
  `DeepSeekHarnessRpcError` whose code is `session/writer-held` and whose
  `details.sessionId` matches the request. Delays are 250, 500, 1,000 and
  2,000ms: at most five attempts with 3.75 seconds of total backoff.
- A retry preserves the session ID, prompt request ID, content and workspace.
  It does not recreate the conversation, steal a writer, delete lock files,
  cancel another turn, or restart the native host. The local foreground claim
  stays held until this message settles, so another send cannot overtake it.
- Stop aborts a wait. Once a prompt has been dispatched, its receipt remains
  observable and the existing exact-source cancellation still handles late
  admission. A refused-and-stopped prompt preserves its typed rejection.
- Transport timeouts, unknown responses, other error codes and mismatched
  sessions never trigger replay. Sustained writer contention produces a
  readable DeepSeek busy message instead of the generic execution failure.
  Classification requires the structured code, not a matching error string.

## Validation and limits

The focused baseline reproduced the missing recovery before the fix. Adapter
regressions cover create and prompt handoffs, fixed request identities, bounded
exhaustion, local claim ownership, Stop during both cold attach and prompt
waiting, and ambiguous/different-session/other-code results. Existing late
admission, cancellation, host recovery and native App-tool cases remain covered.
The six focused suites passed all 261 tests; the standalone production build
also passed.

The opt-in `client/e2e/live-deepseek-writer-recovery.spec.ts` ran against the
installed native Harness with two isolated private hosts. It first persisted a
random marker, then restarted that fixture host and injected one persistence
writer refusal through a temporary fixture-only plugin. The real controller
returned the structured error. The adapter attached on its second identical
attempt; the real model recalled the marker; one prompt RPC and exactly one
durable user-message event were verified. The test passed in 6.5 seconds.
This is controlled native fault injection, not a claim to have reproduced the
unobserved upstream timing that originally held the writer.

Both fixture hosts were closed and their temporary state removed. Production
App/Hub/Bot processes and their histories were not changed. The repaired source
must be included in the installed desktop host before it changes live behavior.
