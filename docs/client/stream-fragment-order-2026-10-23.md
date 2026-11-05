# Preserve streamed text order

## Confirmed failure

The reported Android screenshot displayed `Op us认可` in a running response.
The corresponding native Codex transcript contained `Opus 认可`; the host's
persisted run journal already contained the misplaced space. This establishes
a host-side ordering fault before client rendering, rather than a font, line
wrapping or model spelling problem. Other spaces in the same sentence also
moved before their preceding text.

Bridge awaited recovery progress bookkeeping for nonblank assistant fragments,
tool starts and tool results. Whitespace-only fragments and other stream events
bypassed that await. Native adapters may publish several fragments without
awaiting their observers, so later whitespace could overtake earlier text even
when no recovery was in progress. A pending recovery-resumed observer could
also delay the first resumed fragment behind the rest of the output.

## Repair and scope

Bridge now starts recovery bookkeeping and event delivery together and awaits
both. Delivery starts synchronously for output events, preserving the native
fragment order without placing all observers behind a global queue. Session
events retain their existing persistence-before-forwarding behavior. A pending
question observer does not prevent independent output from reaching the UI.

No word substitutions, whitespace trimming, client CSS changes or protocol
changes are involved. Existing journal/history records are not rewritten.
The shared runtime serves desktop, Android, iPhone, headless CLI, scheduled work
and Agent Bus; no separate CLI command or provider-specific implementation is
needed. The repaired host must be installed to affect live output.

## Verification

Before the repair, four added Bridge regression cases failed: split `Opus`,
Chinese text around a number, code whitespace/newlines, and output while the
recovery-resumed observer remained pending. The first reproduced the exact
`Op` + space + `us` ordering from the screenshot.

After the repair, all six new regression cases passed, including interleaved
tool progress/results and nonblocking question observers. Tests check forwarded
fragments and the resulting run record, not just the adapter's final answer.
The nine focused Bridge, recovery, Core card and Gateway workflow suites passed
227 tests. Nine provider and journal suites passed another 650 tests, covering
Codex, Claude, Kimi, Antigravity and DeepSeek Harness adapters. The standalone
host build passed with 431 modules. These are local source checks; this does not
constitute a production host update or physical-device acceptance.
