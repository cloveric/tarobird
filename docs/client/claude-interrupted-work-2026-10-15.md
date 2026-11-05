# Claude interrupted filesystem work and misleading resume explanations

## Evidence

The reported conversation was checked against the host's public run journal,
Bot timeline and the native Claude transcript (CLI 2.1.296). These establish
different facts from the assistant's later explanation:

- Three foreground Bash calls really were issued to inspect the external
  volume. No tool result arrived before the user stopped each turn. The first
  waited about 22 minutes. The App marked these turns interrupted, not done.
- After resume, the native transcript contained zero-token assistant entries
  with `model: "<synthetic>"` and `No response requested.` for the interrupted
  work. Its persisted history omitted the unfinished Bash calls observed by
  the host. The subsequent real model reply incorrectly claimed nothing ran.
- A separate three-second read-only directory probe still timed out. This
  proves the read remained blocked, not why: disk availability and macOS access
  authorization were not resolved by this investigation.
- No additional user task or persona edit was found in this incident. The
  assistant's suggestion to add a permanent rule was not evidence of one being
  written. MCP status notices alone do not establish the cause of the stall.

No production conversation, native transcript, permissions, live process or
user-owned persona was changed during diagnosis. Private transcript contents,
paths and identities are deliberately omitted here.

## Changes

- The stream adapter retains bounded, private receipts of interrupted
  foreground work. They describe actual calls/results and unknown outcomes in
  the next request for the same native session and workspace, including after
  a graceful adapter restart. They explicitly forbid automatic replay and
  guessing an explanation from missing history. A successful turn clears them.
- Exact synthetic no-response padding is hidden. A terminal placeholder or
  empty terminal result following that padding rejects the foreground turn
  with an actionable incomplete-response error. It does not fail unrelated
  background work, enqueue another prompt or restart the worker. Genuine model
  text with the same words remains valid. Both Claude output adapters enforce
  this distinction.
- Incomplete replies are non-retryable in collaboration error semantics:
  earlier tools may have had effects. Existing App/CLI error reporting tells
  the user to inspect the run before continuing.
- File-discovery turn guidance asks for a small scoped probe with an explicit
  short timeout, accurate blocked-read reporting, no repeated stalled probe,
  and a cloud fallback only if already authorized. This is model guidance,
  not an OS-level deadline or a change to filesystem permissions.

Desktop hosting and headless CLI use the same factory, adapter and per-Bot
state directory. Mobile receives the same host result; no new client command,
Hub schema or network-membership behavior is introduced. Other engines keep
their existing adapters; App filesystem guidance applies to all engines.

## Verification and remaining boundaries

Focused regressions cover stop/restart recovery, session/workspace/Bot
isolation, child-result isolation, receipt corruption/write failures, bounded
retention, synthetic padding and real literal answers, lack of automatic replay,
localized errors and non-retryable collaboration semantics. See
`claude-turn-recovery`, `claude-stream-adapter`, `claude-adapter`,
`gateway-app-tools` and `error-classification` tests.

Validation for this checkpoint: 273 focused checks passed; standalone build
passed (336 modules, no legacy transport dependency); the default full suite
passed 279 files / 3,701 tests, with one skipped test.

The live external-volume read is still blocked. An abrupt host termination
before interruption receipt capture is not covered. Automated protocol tests
do not prove a future model will obey guidance or that a real device has the
updated host installed. This source checkpoint does not publish installers or
restart the running App/CLI.
