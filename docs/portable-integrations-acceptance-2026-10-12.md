# Portable integration acceptance — 2026-10-12

## Change

Search MCP and Tingwu source already existed, but standalone packaging omitted
the integration installers/assets. The local Qwen service lived outside the
project, and local ASR settings were captured before Gateway loaded Bot env.

- Package 17 explicitly listed public integration files in the standalone archive
  and the desktop Host packaging path. No recursive integration-directory copy.
- Maintain Qwen HTTP/CLI source, pinned Python requirements, installer and setup
  instructions in the project; weights and Python environments remain separate.
- Read private shared `~/.tarobot/integrations.env` with existing per-Bot and
  explicit-process overrides. Preserve legacy config without copying it.
- Resolve local ASR configuration after Worker setup. Keep long-media Tingwu
  routing, cancellation and fallback behavior. Extend credential-directory
  diagnostics/installer protection to standalone `bots/<id>/workspace` paths.
- Supply a search launcher with no credentials in CLI arguments and a redacted,
  read-only integration prerequisite checker.

## Evidence

- Required pre-complete hook: standalone TypeScript build, 284-module dependency
  graph with no Feishu SDK; 211 test files, **2,760 passed / 1 skipped**.
- Client translation/type/production build passed.
- Focused regression coverage: post-import ASR configuration, per-Bot precedence,
  rejected process controls, local HTTP/CLI isolation, public-file allowlist,
  private-file exclusion, installer preservation, MCP handshake/tools/status,
  diagnostics redaction, Python HTTP input limits, concurrent health checks,
  duration validation, and standalone workspace credential boundaries.
- Real Qwen inference: new synthetic speech, existing local 0.6B weights in
  offline mode, new project CLI. Exact transcript: “The weather is sunny today.
  Please send the meeting notes tomorrow.” Exit 0, approximately 16 seconds.
  No user audio used; existing ASR service remained running.
- `npm pack` archive extracted outside the checkout, installed with production
  dependencies and isolated HOME. Hub startup and client serving passed. Package
  MCP initialize, tools/list and provider_status passed with fixture private
  configuration; no credential value appeared in output. Diagnostics passed.
  643 archive entries, including 17 public integration assets; no credential
  files, models, virtual environments, outputs or Python caches.
- Gitleaks redacted scan of the standalone payload found no secrets. The staged
  source scan also found no secrets.

The first package check used an overly long temporary state path; Hub correctly
rejected the control-socket path. The verifier previously waited for an already
emitted exit event and hid that error. It now preserves early-exit diagnostics,
bounds termination and removes its temporary state. The isolated package check
was repeated with a short temporary root and passed.

## Boundaries

No search-provider request or real Tingwu cloud job was sent in this run. Local
config presence and fixture protocol tests do not prove provider authentication.
Existing cloud routing/adapter regression tests passed. Model download and a
fresh Python/GPU installation on another OS were not tested. No desktop/Android
installer was published or installed, no personal native MCP config was changed,
and no production Bot/Hub/ASR/fleet service was restarted.
