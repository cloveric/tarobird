# Search MCP routing repair — 2026-10-28

## Problem and requested behavior

A Claude Bot reported `Connection closed` from its Search MCP. Its native
registration pointed to a deleted historical checkout. Codex and Antigravity
had the same stale entrypoint. The desired behavior is to keep engine-native
search when no optional API is configured, and prefer Brave/Tavily Search MCP
when configured, with native fallback after a disclosed MCP failure.

The stale personal path is not written by the repository and is not inherited
by GitHub installations. Source review did find independent product bugs:
Kimi and DeepSeek injected the optional MCP without credentials, DeepSeek's
instructions required that unavailable route, and the direct CLI entry did not
load the private integration file used by the script launcher.

## Source changes

- `runtime/search-routing.ts` resolves merged worker credentials once. Missing
  providers can fall back to enabled native Codex registrations; explicit blanks
  prevent fallback. The resolved child environment suppresses a second legacy
  fallback inside the MCP. API values never enter MCP arguments or diagnostics.
- Kimi injects its managed ACP server only with credentials, passing keys in the
  ACP environment. Missing packaged entrypoints leave native search available.
  User-supplied MCP initialization errors still surface; their servers are not
  silently discarded.
- DeepSeek injects its private bridge client only with credentials. Its search
  guidance then prefers MCP and permits native fallback. Existing Harness
  plugins remain user-owned and are not overwritten or upgraded.
- Claude and Codex use additive per-process/thread MCP configuration when needed.
  Native search stays enabled, existing usable search registrations win, and
  disabled registrations are not bypassed with another server name. Restricted
  Codex side conversations keep managed MCP disabled.
- `tarobot search-mcp` and `scripts/search-mcp.mjs` share private credential
  loading. The read-only integration check and managed capability catalog use
  the same routing policy. App and headless CLI use the same Host implementation.

Antigravity 1.4.9 has no supported CLI per-process MCP configuration interface.
It continues to use its native registration in
`~/.gemini/config/mcp_config.json`; TaroBot does not silently rewrite global
native configuration or change OAuth homes. Setup documentation specifies this
boundary and a stable credential-free launcher.

## Installed-machine verification

The owner's native Claude, Codex and active Antigravity command/args were repaired
to the installed App's bundled Node and `dist/src/index.js search-mcp`. Other
settings and credential values were preserved, with private pre-change backups.
No global repair code or private configuration was committed.

- All three actual registered invocations completed MCP initialization,
  `tools/list` and `provider_status`.
- A real Brave request returned two results without provider fallback.
- A new actual Opus 5.5 Bot conversation independently discovered and invoked
  `mcp__web-search__provider_status` and `mcp__web-search__web_search`. It returned
  two results from `modelcontextprotocol.io` and `github.com`, with no native
  WebSearch, shell protocol substitute, or fallback.
- This establishes repair of the installed registration and real Claude MCP use.
  It does not establish that every already-running worker refreshed its cached
  MCP list. Active user work was not interrupted; native workers must reload
  before changed registrations take effect.

Local redacted receipts reside in the task's `web-search-routing-20261028`
evidence directory: `local-config-repair.json`, `local-mcp-verification.json`,
`antigravity-active-repair.json`, `antigravity-active-mcp-verification.json`, and
`opus-native-mcp-verification.json`. Private configuration backups are excluded
from the repository and deliveries.

## Validation and review

Validation is recorded after the final source review below. Installed
configuration repair is separate from building/releasing the new Host routing
code; this task does not claim a new App installation or public package release.

Opus 5.5 reviewed credential/default routing independently (no P0/P1 findings).
Its P2 findings led to removal of inherited MCP-only flags at both worker-load
and engine boundaries, narrower credential propagation (Kimi MCP-only;
Antigravity native loading), and isolation of older test fixtures from actual
native credentials. Codex resumed conversations now check the requested
workspace's MCP policy rather than only the adapter's default workspace.

Opus also verified the new native configuration using real Codex 0.164.0 and
Claude Code 2.1.311 with isolated homes and synthetic credentials: the real
Search MCP connected and exposed its tools; Codex `env_vars` forwarded only
listed variables, `provider_status` saw the synthetic key, and an explicitly
disabled server exposed no tools. Claude expanded environment references into
MCP children. These probes made no model or provider requests. Compatibility
with older native CLI versions was not established by these probes.

Final search verification: 17 focused suites / 724 tests passed; after the
review fixes, 7 affected suites / 325 tests passed. Full Host build passed
(462 standalone modules). These counts overlap and are not added together.

The user's follow-up also identified the repository's stale Scrapling Skill.
It now targets reviewed Scrapling 0.5 APIs, has parseable YAML metadata, and
removes owner-specific installation assumptions. The optional installer upgrades
an existing venv to pinned 0.5, reports browser setup failure, and respects native
Skill homes. The public Skill and installer are included in standalone package
assets; Python/Chromium remain optional installations, not bundled runtimes.
Three focused suites / 8 tests passed for installer success/failure and packaged
assets/entrypoints. The actual installed 0.5 CLI fetched a local HTTP fixture,
selected only the requested CSS element and returned UTF-8 Markdown; Python
imports of Fetcher/StealthyFetcher passed. This check did not launch a browser
or verify anti-bot behavior on public sites. Migration reference:
[Scrapling v0.5](https://scrapling.readthedocs.io/en/latest/migrating-to-v0.5.html).

Opus 5.5 separately reviewed the Scrapling Skill, installer and asset list
against the actual 0.5 CLI/Python interfaces and reran the 8 focused checks;
no blocking or functional defect was found. Fixed-version installation is
intentional: adopting a future Scrapling release requires a compatibility review.
