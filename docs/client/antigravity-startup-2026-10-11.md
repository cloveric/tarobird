# Antigravity startup and model-effort compatibility — 2026-10-11

## Root cause and native recovery

The installed Antigravity CLI (1.3.3) rejected the existing Bot before init:
`gemini-3.8-flash has no "xhigh" effort (available: low, medium, high)`.
The App offered the union of CLI effort flags for every model and converted
this configuration error into a misleading instruction to restart the engine.

The installed native desktop App saved `high` for the affected Bot through its
normal settings UI. In the original conversation, a real App → Hub → Gateway →
Antigravity → App turn completed with `连接正常`. Existing sessions, workspace,
memory, pairing and unrelated Bot services were not reset or restarted.

## Changes

- Query `agy models` on the host, parse concrete provider variants, and share
  their effort choices between new-Bot creation and the Bot effort picker.
- Discovery has an 8-second timeout, 128 KiB output bound, 16-entry cache and
  five-minute success TTL. Concurrent requests coalesce. Failures retry after
  three seconds. Only settings/catalog reads perform discovery; chat streaming
  and engine startup never wait for it.
- Unknown/default model capabilities offer only default effort. The UI explains
  selecting a specific model or reloading. Existing saved values are not
  silently rewritten, and an unverified value remains visible for review.
- Creation rejects an incompatible explicit effort before creating a worker;
  saving effort rechecks the catalog and the existing revision fence.
- Recognized provider model-effort errors have a non-retryable `engine-settings`
  category. Chinese/English messages show only the model, invalid effort and
  advertised choices, without exposing raw stderr or prescribing a restart.
- The native adapter still passes explicit user CLI commands through. This
  change does not globally disable advanced levels or rewrite legacy services.

## Verification

- 136 focused tests passed: catalog parser/discovery, creation guard, saved
  effort/revision behavior, error classification, audit and adapter regressions.
- Six Chromium journeys passed (the effort journey was rerun after correcting
  an obsolete fixture expectation): Codex/Claude/Antigravity creation,
  desktop-phone effort synchronization with rejected xhigh writes, and both
  languages of actionable errors followed by a successful next message.
- Fresh-browser startup passed the existing 700,000-byte script gate
  (699,723 bytes); this is not native cold-start timing.
- Real `agy models` returned 18 variants. The production parser returned
  low/medium/high for Gemini 3.8 Flash and low/high for Gemini 3.1 Pro. An initial
  4-second timeout was too short for a live discovery call, so it was increased
  to eight seconds, below the Hub's ten-second RPC deadline, then verified live.
- The shipping macOS App 1.0.4 bundled runtime discovered all 18 real CLI
  variants. With disposable state and system-only PATH, it passed start, local
  pairing, LAN TLS health, restart and stable-port checks. Its production
  manifest contains no Feishu SDK dependency.
- Real native desktop recovery is described above. Browser workers and their
  model catalogs are isolated fixtures and are not real engine acceptance.

New native installation and physical Android/iOS device behavior are not
retested by this change. The existing installed App was used for native chat
recovery; the new packages carry the catalog and error-feedback prevention.
