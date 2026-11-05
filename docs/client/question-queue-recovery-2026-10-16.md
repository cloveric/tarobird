# Queued answer feedback and restart recovery

Two reported failures were reproduced against the real disposable Hub/Gateway.

1. A Codex async question's origin could finish while another task started. Its
   submitted answer then waited in the shared conversation queue, but the receipt
   stayed at the generic Submitted message through execution and completion.
   The same native receipt now records queued, processing, reply generated,
   stopped, failed, blocked or skipped from the owning follow-up's actual events.
   A live-origin steering acknowledgment says delivered to the current task;
   it does not claim that the task has completed. Answers remain visible and
   repeated submissions do not execute another turn. No raw tool data is added.
2. During host shutdown, an interrupted handler could finish its durable input
   receipt before its terminal run card reached the Hub. On the replacement
   worker, the boot sweep skipped the still-pending input; replay then accepted
   its cached successful receipt, leaving the old run streaming forever.
   Successful cached-receipt replay now invokes the orphan sweep after the input
   acknowledgment. It uses the replacement worker's original attachment time,
   so socket reconnects cannot terminate work started by that worker. Recovered
   runs become interrupted, retain generated prose and never replay the input.
   A failed post-ack sweep emits a recovery warning without replaying a settled
   delivery or forcing the connection into delivery-failure backoff.

Admitted answer jobs also remain in drain accounting during the disk reads before
they claim a run slot. Optional `answerFollowup` card metadata identifies queued
or processing receipts for the same boot sweep, so an abrupt worker restart
closes them in place too. Forwarding removes that live metadata. Existing clients
render the ordinary receipt text; no client upgrade is needed to understand it.

The incident's read-only records confirmed the turn was interrupted at host
restart, while its durable receipt was complete and its stored reply remained
streaming. The later “no running task” replies accurately described the worker;
the old reply card had not been settled. The Mac was still running App 1.0.71 /
host 0.1.424, including the older client stop-button wait behavior. The source
already bounds uncertain stop waits to 15 seconds; the new recovery closes the
underlying orphan rather than treating a timer as proof of completion.

Both fixes are in the shared host used by the App and headless CLI. No new CLI
command, strict protocol change, database migration, permission or engine-specific fork is needed.
Claude background-answer observers keep their existing behavior. The async path
applies to engines emitting native async questions; it does not invent support
for engines without that capability. A source commit does not update an installed
App or running host; both bundled host and CLI must ship the same revision.

When receipt updates are unavailable or the initial update fails, a fallback
receipt preserves the answer without active lifecycle metadata: an untracked
fallback must not promise live progress or remain queued forever. Pending edits
finish before the abandoned question is recalled, so late updates cannot restore it.

Verification: regression fixtures first failed on the old code for all four
queued-answer outcomes and the cached-receipt restart. Final focused host checks
passed 46 tests, including budget limits and both fallback paths. The complete
standalone build and suite passed 302 files / 3993 tests (one skipped), with two
workers to avoid resource-sensitive supervision timeouts on this Mac. Chromium
desktop/phone journeys checked the same card's queued, processing and generated-
reply states, preserved answers/drafts and no duplicate prompt. The final browser
run passed 11 question/receipt checks; the earlier lost/failed/unfinished-stop
journey also passed. An independent read-only Opus review reported no blockers;
its fallback-progress concern was then fixed and covered by focused tests.
These are real Hub/Gateway and browser checks with controlled engines, not
physical-phone or native desktop installation acceptance.

Release target: App 1.0.77, bundled host and standalone CLI 0.1.427 from the same
source revision. Native package, publication and installed-version checks are
recorded separately in release receipts; these source checks alone do not assert
that an existing installation has been updated.

Final DMG acceptance also exposed `hub_control_closed` during the host stop
sequence. A deterministic socket fixture reproduced an acknowledged stop whose
next status connection is closed by shutdown. The detached service now retries
only that status-read closure, within the existing deadline, until it confirms
the endpoint is absent. A lost stop acknowledgment still fails as ambiguous;
the regression covers both cases. This affects desktop and headless hosts and
requires rebuilding both artifacts. An earlier passing diagnostic run did not
override subsequent failures of the unmodified packaged acceptance script.
The five focused stop/control suites passed 30 tests; Opus's subsequent read-only
review found no blockers. The rebuilt, sealed final DMG then passed the unmodified
bundled-Node host script: argument/pipe transport, authenticated pairing, Bot
creation, reply, stop and identity-preserving resume. Its 738 host/CLI files and
embedded renderer assets matched. Both rebuilt CLI installs and the upgrade from
0.1.426 passed; real Codex text/sync, file, ASR, question and stop/resume acceptance
also passed again against the extracted archive. Android's original signature,
30 unit tests, lint (zero errors, 22 warnings), packaged web bytes and emulator
upgrade/cold launch were verified. These do not substitute for a physical phone
or Windows acceptance, native Mac interaction, or the pending live Mac update.
