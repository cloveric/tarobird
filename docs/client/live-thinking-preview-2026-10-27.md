# Live public thinking preview

Claude already emits public thinking blocks through the stream adapter. They
reach the run journal, but the compact run summary deliberately omits their
text and the main bubble previously rendered only status and answer prose.
Consequently a tool-heavy turn could have useful public progress in its process
reader while the bubble showed only a running status and action count.

The Gateway now publishes at most 600 characters from the latest foreground
thinking entry as additive `nativeRunThinking` metadata. The App displays a
short literal excerpt while the run is active, including while tools execute.
New blocks replace the prior preview; it remains visible during answer streaming
and completion removes it from the bubble.
The full journal stays available in the process reader. Child scopes, tool
output and ordinary replies cannot become the thinking preview. No new model
call, generated summary or journal polling is introduced.

The metadata is bound to the run and revision, separate from the strict v1
summary. Older clients ignore it; older Hosts omit it. Forwarding removes the
live metadata. App and standalone CLI Hosts share the Gateway projection; no
new CLI command or persisted-state migration is needed.

Validation: 111 focused run/protocol/UI unit tests and two existing Claude
partial-event adapter tests passed. Host and client builds passed. Dedicated
Chromium and WebKit journeys passed at 390 and 1360 pixels, covering incremental
updates, tool execution, reload, a new thinking block, completion and full
history in the process reader. Screenshots were inspected. These are isolated
browser/protocol checks, not a native installation or real-model session.

The initial multi-engine browser runs failed at their earlier compaction
completion assertion. Joint review identified test clock pollution: installing
the simulated clock after navigation reset `performance.now()` underneath the
history read throttle. The real Hub already stored `phase: thinking`. Installing
the clock before navigation resolved the Codex desktop, Claude desktop/phone
and Antigravity desktop journeys; all four now pass. The initial failed runs
remain recorded in the original evidence directory.

Joint review also reproduced a frozen preview beyond one thought's 32768-character
capture cap. Thinking entries now retain a rolling tail at that cap, with the
existing explicit truncation flag. Other text/tool evidence retains its prefix.
Both Host capture and client excerpt boundaries avoid cutting an emoji into a
lone UTF-16 surrogate. Dedicated Chromium/WebKit phone and desktop journeys
cover long thoughts, new progress and terminal removal. Publication and
installation remain paused. See [joint review](followup-joint-review-2026-10-27.md).
