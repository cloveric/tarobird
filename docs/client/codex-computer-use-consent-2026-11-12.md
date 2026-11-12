# Codex Computer Use consent in the App

## Problem and behavior

Computer Use can ask for permission to access a particular native app. The
observed Codex 0.167.2 request is a standard empty MCP form, with
`codex_approval_kind: "mcp_tool_call"` and the offered persistence scopes in
`_meta`. TaroBird previously discarded that metadata and offered only a
one-time allowance or rejection. It could not return the session/always
choices available in the native CLI.

The host now presents the native message, target display fields and warnings
in the existing desktop/mobile question card. It includes **Allow once** and
**Decline**, plus **Allow for this session** and/or **Always allow** only when
the request explicitly offers those scopes. The user selects an option and
submits it. No option is selected automatically.

An explicit session/always choice returns `action: "accept"`, empty content,
and `_meta.persist: "session" | "always"`. One-time approval has no persistence
metadata. Rejection returns `decline`; stopping the owning turn returns
`cancel`. Codex/Computer Use owns storage and enforcement of lasting approval;
TaroBird does not introduce another permission store or modify global settings.
Malformed offered scopes are cancelled. Unknown answer labels and bare
`allow` decisions cannot create persistent consent.

## Boundaries

- This applies to requests actually delivered by Codex. In the observed native
  CLI, approval policy `never` automatically accepted the synthetic empty
  tool-consent form before sending a request to the host. The App's existing
  full-auto settings and native policy mapping remain unchanged. Adapter tests
  verify that a request reaching the host still needs an explicit answer in
  normal, bypass and full-auto modes.
- Ordinary MCP forms, URL/auth forms and other engines keep their existing
  handling. Retired requests and replacement processes cannot accept late
  persistent grants; the existing turn/child ownership guards remain in charge.
- Missing browser-host connection information is a separate failure. Native
  Computer Use access does not establish that browser-specific access works.
  The shared browser instructions and user-selected Chrome profile are unchanged.
- Desktop-bundled and headless Hosts use the same Codex adapter. A headless Host
  can present this card to its connected phone/browser client without launching
  a desktop App. No new CLI command or separate authorization implementation is
  needed; standalone Codex CLI keeps its own prompt interface.

## Verification on 2026-11-12

- The installed node-repl producer's actual `elicitation/create` envelope was
  captured using an isolated synthetic service and cancelled. No browser or OS
  permission was granted by that probe.
- Negative regression on the previous normalizer: six failures, including
  missing session/always choices and missing returned persistence metadata.
- 228 focused adapter, form, permission-scope and acceptance-cleanup tests pass, covering
  choice availability, response mapping, malformed input, input immutability,
  all three approval modes and abort/resolved/completed/child-exit races.
- Opt-in `client/e2e/live-codex-consent.spec.ts` uses real Codex 0.167.2 and an
  isolated synthetic MCP service. Two paired Chromium clients (desktop and
  narrow phone viewport) display the card; phone selections are checked against
  the actual response received by the MCP service for once/session/always,
  rejection and stopping; all five response paths pass, including fixture
  cleanup. The fixture cannot operate an app, and its synthetic
  persistence response does not authorize a real browser.
- Host and client builds pass. Root TypeScript diagnostics are compared with
  the unchanged baseline; existing unrelated errors are not a clean typecheck.

This is source and real-engine/browser evidence, not installed-App, physical
phone or fresh Computer Use permission-store acceptance. It publishes no
release and does not update an installed application.
