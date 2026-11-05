# Run feedback, remote liveness and Claude session IDs

## Behavior

- Run and tool durations use compact units: `517s` becomes `8m 37s`, then
  `1h 20m` or `1d 2h 3m`. An active connected run uses elapsed wall time,
  adjusted by the authenticated Hub clock. Completed and disconnected runs
  retain their last confirmed duration.
- The original one-minute reporting-gap notice was replaced on 2026-10-19:
  [progress feedback](run-progress-feedback-2026-10-19.md) now keeps the card
  compact and places the last reported event time in process details. Quiet
  intervals do not imply idle work. Approval and question waits keep their
  existing explicit states.
- Native reply blocks have paragraph spacing. Markdown soft newlines in
  narration/thinking remain visible; token deltas and code blocks are preserved.
  Complete App narration messages get paragraph boundaries, while the optional
  Feishu card format keeps its existing line separator.
- Native and remote/VPS links allow 15 seconds of silence, with 3-second
  heartbeat probes and a 6-second route health timeout. Local browser loopback
  retains fast failure detection. Already verified alternatives can win before
  an unreachable preferred route finishes probing. Identity verification,
  durable outbox replay and deduplication remain required.
- Claude accepts `/resume <full UUID>`, `/resume [UUID]`, and
  `/resume session <UUID>`, in addition to a recent scan plus numeric selection.
  Exact lookup is not limited to recently modified sessions. Binding preserves
  the previous conversation for `/detach`; Claude loads the session on the next
  message. A binding receipt does not claim the CLI has finished loading.

## Implementation

`RunPresentation.tsx` separates total time from event age and stops its timer
when the host pane is inactive, disconnected or the run is terminal.
`connection-timing.ts` defines local versus remote liveness budgets.

`session-scanner.ts` reads at most 256 KiB at each end of a matching transcript.
It takes the workspace from matching session metadata instead of synchronously
probing guessed paths on potentially unavailable disks. Non-files, transcript
symlinks, project-directory symlinks, invalid IDs and ambiguous duplicate IDs
cannot become a direct binding. Missing or unreadable metadata leaves the
conversation unchanged. A session without bounded readable cwd metadata must
first be opened in the host CLI; the scanner no longer guesses its workspace.

## Verification and limits

- 95 focused host/UI-helper tests pass, including old and sparse 1.2 GB
  sessions, unknown IDs, duplicate IDs, symlinks, preserved prior binding,
  delta spacing and command parity. Optional legacy renderer tests also pass.
- Chromium and WebKit each pass 28 distinct browser scenarios: five engines
  on desktop/phone, process details, elapsed/stale/offline states, paragraph
  layout, route failover and host lifecycle. The relay-silence fixture was
  corrected to install its socket interceptor before the client transport loads;
  its final targeted reruns pass on both engines.
- Standalone host and production client builds pass. A read-only lookup of the
  reported large local session resolved its metadata without loading its body.

No user conversation was rebound, no real Bot was stopped or restarted, and no
native installer was produced in this change. Browser emulation does not verify
physical-phone 5G reliability. The prior network interruption's exact cause
cannot be established from the available logs. OS access approval for a blocked
external disk and the CLI's actual loading of a large session remain separate
from these source-level fixes.
