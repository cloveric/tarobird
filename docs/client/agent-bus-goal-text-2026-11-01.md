# Agent Bus goals are task text — 2026-11-01

Issue #103 finding F-03, independently reported by Claude Opus 5.5 after the owner reassigned the unavailable Kimi reviewer.

A saved Bus goal beginning with `/compact`, `/stop` or `/review` reached an engine as a leading slash command when no slot instruction was configured. Kimi's adapter takes that native-command branch and omits its normal Bridge prompt; DeepSeek recognizes `/compact` as a harness command. This was verified at adapter/source boundaries, not by a paid Kimi turn or a production session. Claude's engine-specific outcome was not established.

The trusted Bus prompt boundary now labels slash-prefixed goals as task text before handing them to either a member or the coordinator. The exact original goal follows the label. Normal goals remain byte-for-byte unchanged; existing per-slot instructions already provide an unambiguous prefix. Ordinary user slash commands and approval replies remain commands. Shared Gateway handling covers all five engines and `tarobot bus run`; no new permissions or CLI syntax.

Verification: three new member/coordinator regressions fail on the original and pass with the fix. Gateway approval tests prove a Bus goal cannot approve a pending request, while the same ordinary user message still can. Final instruction/Gateway suites: 67 passed. The initial run had an expected raw-prompt assertion and a Crew-stage assertion failure under concurrent load; the approval assertion now checks preservation of the goal, and both isolated and final-suite Crew checks passed. `npm run build` passed (481 modules). Independent diff review is retained in the final audit index. No release or installation.
