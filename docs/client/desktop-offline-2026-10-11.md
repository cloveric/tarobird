# Desktop offline names and multi-host acceptance

2026-10-11. Follow-up to the [desktop simplification](desktop-simplification-2026-10-11.md),
using two isolated local Hubs, the compiled browser client and the ordinary macOS
preview App. No production services, model sessions or user conversations were
modified.

## Reproduced defect and correction

After a cold start while its Hub was unavailable, the active desktop sidebar
showed the internal Bot ID (`studio`) even though the message author and the
persistent name cache still contained `设计助手`. The same defect appeared in
both the browser and native preview before the fix.

`Workspace` passed only live `state.bots` to desktop navigation. In a multi-host
shell that current-host directory replaces the background observer's cached
one, so its empty live array discarded the usable display names. Phone navigation
already had an offline fallback.

All navigation surfaces now receive the same directory, including cached names
before the first successful connection. These cached entries use `online: 0` and
empty engine/model/effort fields; the UI does not invent fresh presence or model
settings. Online behavior, identity boundaries, message routing and storage are
unchanged. `startup.spec.ts` now asserts the display name survives stopping the
Hub and reloading, and that it is not shown as online.

## Verification

- Two Hubs shared an identical Bot ID and private conversation ID/title.
  Their message bodies and independently typed drafts stayed separate in the
  browser and native App. Native drafts also survived App exit/reopen.
- With both hosts visible, New conversation opened the host chooser. Filtering
  to the second host opened its creation form directly. Switching hosts closed
  the previous desktop menu. No new model sessions were created.
- Before the fix, the browser sidebar showed `Sstudio` after an offline reload;
  after rebuilding it showed `设设计助手`. The rebuilt native App also showed the
  correct name on offline cold start and the original saved draft.
- The temporary second host was removed from both clients using the normal
  host manager. Its zero drafts/outbox counts were checked first. Both clients
  retained the original host, and the single-host view removed the extra filter.
  The temporary Hub process was stopped; its fixture directory remains available
  locally for investigation. No production host was removed.

## Long-message evidence and limits

The second Hub held a deterministic 186,214-byte Markdown message: 5,000 numbered
paragraphs with 50,000 Chinese body characters, 10 tables and 20 formulas.
The full source contains 85,870 characters including numbering and Markdown.

The browser's rendered message contained all 5,000 numbered paragraphs, 10 table
nodes, 20 KaTeX nodes and both boundary markers after the Hub was stopped.
The native App visually rendered the end marker, paragraph 5000, table 10 and
formulas. After quitting and reopening offline it rendered the beginning marker
and numbered paragraphs from its cache. The native accessibility tool did not
return a complete tree for this large message, so browser counts are not claimed
as native node counts. Clipboard verification was unavailable through the tool's
isolated clipboard and is not counted as a pass.

This adds ordinary native long-text and offline-rendering evidence; it does not
close the complete native long-text, performance or release gate. It measures
neither 5,000-line live streaming frame times nor RSS, cold-start latency, true
mobile rendering, public TLS routes or every intermediate native paragraph.

## Checks and deliverable

- Root pre-completion hook: 239 suites, 3,832 passed, one skipped; build passed.
- Client translation check, TypeScript and Vite passed inside the macOS build.
- Debug native App rebuilt and strict ad-hoc signature verification passed.
- Updated startup regression spec parsed; the automated browser suite was not
  executed in this iteration. Interactive before/after checks used the real UI.
- The existing `TaroBot-Desktop-Preview-20261011.app` development preview was
  updated and reopened. This is not a notarized release or a production install.

Local screenshots, logs and scope receipt are in ignored
`docs/client/evidence/desktop-offline-2026-10-11/`. No temporary pairing codes,
private keys or model-session data are committed.
