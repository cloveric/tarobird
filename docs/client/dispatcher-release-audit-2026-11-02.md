# Chancellor 1.0.127 release audit

Root and an independent Claude Opus 5.5 reviewer audited main `6d35512` and the worker-assistance changes. Opus worked in an isolated clone; root reproduced the failures before applying the reviewed patches.

## Fixed defects and clarifications

- A pause arriving after a help-requesting parent completed its turn could publish its checkpoint as `needs_review`. Settlement now recognizes any assistance request from that attempt, including one cancelled by pause. The ticket remains queued/paused and the checkpoint is not a final result. A completed native-run card is essential to the regression; a plain terminal message missed this race.
- Pausing a completed helper before settlement, or cancelling an undelivered parent continuation, previously left an opaque ledger. Owner/dispatcher `tickets assists` now includes helper outcome and bounded settled reply tails for the newest eight entries (800 characters each), plus continuation Hub delivery state. The existing 64-row history limit and ticket authorization remain. Missing bounded attempt history is explicitly unavailable. Accepted delivery does not prove the parent read or used the answer. Paused/cancelled tasks are never automatically resumed by readback.
- Parent continuation now states the actual remaining assistance allowance. Exhausted requests no longer suggest another helper. Explicit max/ultra assistance requests remain rejected; an omitted effort uses the engine default and is not a cost cap.
- Routing help reflects the GPT/Opus/DeepSeek observations without asserting universal same-family bias or forcing provider rotation. Different task/model samples and completed execution do not establish answer quality.

## Verification

Root independently observed the pause regression fail, then pass. The five readback regressions also failed before the readback patch and passed afterward. Root's combined focused run passed 36 tests across six files; the allowance/context follow-up passed 19 tests across three files. These overlapping runs are not additive coverage totals. Opus separately reported 124 passing cases on its initial fixed audit and performed independent readback regressions. Opus's final read-only review approved the integrated state/allowance/copy changes. Final-source full checks are recorded with the release receipts.

The DeepSeek comparison's non-associative synchronization proposal was generated test output, not TaroBot's production synchronization implementation. Its counterexample invalidates that answer; no flawed proposal was imported, and this release does not claim to eliminate model review errors.

## Remaining boundaries

Manual pause can prevent an already computed helper result from reaching the parent automatically; its bounded result is now inspectable. An archived parent session blocks safe continuation. Persistent unknown worker-start errors still require owner pause/cancel; helper count is not a monetary budget. Natural-language model preferences are coordinator instructions, not hard provider routing enforcement. Real model samples, stub lifecycle tests, installed GUI and physical-device acceptance are separate evidence.

CLI parity: new readback fields use the shared authenticated Host ticket API; no UI-only or alternative routing implementation was added. Schema 24 backup support and existing schema-23 upgrade are separately checked with the release CLI.
