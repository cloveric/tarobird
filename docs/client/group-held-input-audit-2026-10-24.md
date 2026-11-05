# Group discussion and folder audit

The Opus audit reproduced five presentation and scheduling gaps. The fixes use
the existing Hub state and transaction boundaries; App and standalone CLI callers
receive the same behavior, with no new command or protocol capability.

- A paused discussion could hold a queued input whose frozen context predated a
  correction. Resume/retry now refreshes that input's bounded context, note IDs
  and borrowed note resources in the same transaction. Turn/message IDs, attempt
  and queue position stay unchanged. Inputs already claimed (`dispatched=1`) are
  immutable, including when the run is still pausing. Independent first-round
  inputs still withhold other members' answers and quoted Bot resources.
- A paused run's next-speaker hint now names the held input that Continue releases,
  rather than looking beyond it to the following slot.
- A first-round failure with only unclaimed inputs left now reaches `paused` in
  the same settlement. Previously it could remain `pausing` with no future worker
  event to advance it. Already claimed answers still finish before Retry appears.
- Human forwards requesting replies use the same discussion-addressing guard as
  ordinary sends, before copying attachments. A single directed reply remains
  available outside a run; several recipients require a discussion; active runs
  reject out-of-order replies. Forwarding without recipients still shares the
  message without executing it. Previously confirmed retries return the original
  receipt even if a discussion started since then.
- Creating a folder respects the visible trailing Unfiled row even when a pinned
  folder retains a hidden ordinary-order slot behind it. Unpin restoration and
  deliberate non-trailing Unfiled placement remain unchanged.
- Explicit internal fences `json group_stance` and `group-stance` (including case
  variants) are hidden while streaming and in final output. Only canonical
  `group_stance` passes stance validation. Untagged JSON, program source fences,
  similar identifiers and nested documentation samples remain visible.

Regression coverage includes note/retry idempotency, independent held turns,
already claimed inputs, attachments and sealed references, injected transactional
write failure and retry, forward sharing and old receipts, folder legacy/reopen
behavior, and every split point of the stance marker. The independent-round
waiting test now actually claims its remaining inputs before asserting it must
wait for them.

The initial focused regressions failed in ten cases before changes. The adjacent
pause issue was independently reproduced without a synthetic follow-up settlement.
Hub/Gateway/CLI/queue suites and desktop/phone browser journeys cover the changed
paths. Browser fixtures use the real Hub and Gateway with scripted model replies;
they do not establish live-model or physical-device acceptance.

The authorized side-conversation networking policy and old-Host safety refusal
remain outside these corrections. No database migration, new note ownership
registry or replacement scheduler was introduced.
