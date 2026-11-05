# Claude authentication failure: recovery and truthful failure presentation

## Observed failure

An Opus collaboration request failed before any implementation work. The native
Claude session recorded an assistant envelope with `error: authentication_failed`,
`isApiErrorMessage: true` and `message.model: <synthetic>`. Its only text was:
`Failed to authenticate: OAuth session expired and could not be refreshed`.
The App forwarded that diagnostic as answer text and then classified the failed
turn as partially completed. The generic authentication hint still mentioned Lark.

The same host's `claude auth status --json` reported `loggedIn: false`. No explicit
Bot authentication override was found. After the owner completed the official
Claude sign-in flow, the CLI reported `loggedIn: true`, `authMethod: claude.ai`.
The existing Opus 5.5 Bot then answered the isolated no-tool check with
`OPUS_AUTH_OK`. This verifies runtime authentication recovery, not an Electron
migration or release. The reason the previous refresh credential became invalid
was not established; no credential contents were read or copied.

## Change

- Recognize assistant envelopes explicitly marked as CLI/API errors. Keep the
  diagnostic for the failure result or process exit; do not publish it as model
  answer text. Detection uses envelope metadata, not keywords in ordinary prose.
- In streaming turns, retain actual answer text produced before a subsequent failure. Preserve native
  terminal error handling and retry decisions; authentication failures do not
  replay the request or reset its conversation.
- An unresolved API error followed by an empty or error-echo success result stays
  a failure. Later genuine assistant output clears that diagnostic. Empty-text
  authentication envelopes keep their auth category, and truncated JSON from a
  nonzero process exit is never returned as a successful plain-text answer.
  Error echoes use consistent whitespace normalization. A completed background
  task cannot settle a foreground turn with an unresolved API failure.
- Apply the same error-envelope rule to one-shot Claude output, including JSON
  arrays returned on nonzero exit.
- Preserve Claude error provenance so App hints identify the correct CLI and
  machine: run `claude auth login` on the host running the Bot, then retry.
  Generic engine and service authentication errors no longer mention Lark.

CLI impact: the headless Host and desktop-bundled Host share these adapters and
error semantics. No new command, account setting, protocol or schema is added.
The existing `claude auth login` flow is owned by Claude Code. Re-authentication
does not require a TaroBot reinstall or deletion of conversation/session data.

## Validation and release boundary

Focused and regression suites: **342 tests passed** in `claude-stream-adapter`,
`claude-adapter`, `error-classification`, `claude-stream-adapter-retry`,
`core-element-stream` and `core-card-renderer`. Cases include failure before any
answer, failure after a real answer, exit without a terminal result, one-shot
error frames/arrays, preserving error provenance alongside MCP warnings,
ordinary prose mentioning authentication, and bilingual
actionable hints. Standalone Host build passed (463 modules).

Opus 5.5 independently reviewed the error routing, retry boundaries and test
coverage. Its probes exposed contradictory-success and truncated-JSON paths;
both were repaired. A separate regression reproduced premature background
settlement before the guard (expected pending, received success) and passed after
the fix. The final settlement-marker change was checked again with the Claude
stream suite and Host build. Existing non-auth empty-error-code classification,
child/review diagnostic presentation and non-auth legacy wording remain separate
follow-up work; this repair does not claim to redesign all engine diagnostics.

Live authentication is restored. The presentation changes are source changes;
they are not installed in the current App until a release/update containing them.
Previously stored error cards are not rewritten. Electron migration remains a
separate workstream and has not been validated by this repair.
