# Brave/Tavily Search MCP

TaroBot packages this server and a credential-free launcher at
`scripts/search-mcp.mjs`. It reads private `~/.tarobot/integrations.env` settings;
see [portable integrations](integrations.md) for setup without secrets in MCP
registration commands. Both the launcher and `tarobot search-mcp` load the same private settings.

TaroBot includes a local stdio MCP server for live web search:

```bash
node ./dist/src/index.js search-mcp
```

It exposes four tools:

- `web_search` - routed live search through Brave and/or Tavily.
- `web_extract` - Tavily-powered clean URL extraction.
- `provider_status` - local configuration status for Brave/Tavily without exposing API keys.
- `health_check` - optional live provider probes for auth, quota, rate limit, and timeout diagnostics.

## Default behavior and configuration

- No search API configured: use the engine's existing search/fetch behavior.
  TaroBot does not require optional Brave/Tavily keys to start a Bot.
- Configured API and exposed Search MCP: prefer its `web_search` / `web_extract`.
  If MCP fails, use available native tools and disclose the failed route.
  No route can promise verification without actual search results.
- Existing user MCPs, disabled registrations and native plugins remain user-owned.
  TaroBot never disables native search or changes global MCP files on startup.
- An empty `BRAVE_API_KEY` or `BRAVE_SEARCH_API_KEY` blocks legacy Brave fallback;
  an empty `TAVILY_API_KEY` blocks Tavily fallback. A nonempty explicit Brave alias
  still enables Brave. An absent provider can reuse keys from enabled Codex MCP
  registrations. Keys from disabled servers are ignored by managed routing.
- Credential resolution happens before managed MCP creation. Only the resolved
  child environment crosses that boundary. Kimi receives fallback keys only in
  its MCP environment; managed Claude/Codex and DeepSeek may need them in the
  engine environment to forward them to MCP (so engine subprocesses can inherit
  them). Antigravity keeps its native credential loading. No API values are put in arguments,
  repository files or diagnostics. Legacy standalone plugin versions retain their
  own behavior and are not automatically replaced by a Host source change.

## Provider Routing

The MCP server gives agents one stable entrypoint instead of making them choose vendors directly.

| Mode | Provider order | Use case |
|---|---|---|
| `quick` | Brave -> Tavily | Broad discovery, latest facts, docs, pricing, news |
| `deep` | Tavily -> Brave | Research tasks, source reading, extraction-oriented answers |
| `verify` | Brave + Tavily | Important claims that should be cross-checked |

Fallback is reliability-focused:

- If Brave fails, `quick` falls back to Tavily.
- If Tavily fails, `deep` falls back to Brave.
- If one provider fails during `verify`, the result includes the working provider and a fallback note.
- If neither provider is configured, the tool returns an actionable error and does not crash the MCP server.
- If a provider fallback happens, the result includes `fallbacks` and a short `notice`.
- If both Brave and Tavily fail, agents should use native runtime search only as fallback and explicitly tell the user that Brave/Tavily Search MCP failed.

## Source Metadata

Search results include source metadata:

- `rank`
- `domain`
- `provider`
- `accessedAt`
- `sourceLog`

Extracted pages include:

- `domain`
- `provider`
- `status`
- `extractedAt`
- `contentHash`
- `sourceLog`

Use `sourceLog` when writing source packs, audit notes, or structured research artifacts.

## Environment

Set either or both keys:

```bash
export BRAVE_API_KEY="..."
export TAVILY_API_KEY="..."
```

`BRAVE_SEARCH_API_KEY` is also accepted as an alias for `BRAVE_API_KEY`.

## Native CLI registration versus managed Bots

TaroBot-managed Claude and Codex Bots add Search MCP for configured APIs when
no existing usable or explicitly disabled search registration takes precedence.
Claude adds a credential-free `--mcp-config`; Codex uses thread-scoped overrides
(or `-c` for exec), forwarding key names through `env_vars`. No global native
configuration is rewritten. A missing old absolute script can be supplemented
by a working managed server, while its original registration remains user-owned.

The following commands are for native CLI use outside TaroBot, and for
Antigravity, which still needs explicit native registration.

## Register With Codex

Build first:

```bash
cd /path/to/tarobot
npm run build
```

Then register the stdio MCP server:

```bash
codex mcp add web-search -- node "$PWD/scripts/search-mcp.mjs"
```

Check:

```bash
codex mcp list
```

## Register With Claude Code

```bash
claude mcp add -s user web-search -- node "$PWD/scripts/search-mcp.mjs"
```

Check:

```bash
claude mcp list
```

## Kimi Code Runtime

With a configured Brave or Tavily key, Kimi instances need no manual registration for TaroBot search. Without keys, the adapter preserves native default search and injects no managed MCP. The bridge
passes this stdio Search MCP in ACP `session/new` and `session/load`, while Kimi
continues to load its own user/project MCP files and plugins normally. Provider
keys are never copied into Kimi config. Explicit `BRAVE_API_KEY` /
`TAVILY_API_KEY` process values take precedence; when they are absent, the MCP
server can reuse those same keys from an existing local Codex
`[mcp_servers.<name>.env]` configuration without logging them.

The current compatibility baseline is Kimi Code 2.1.1. ACP new/list/load and a
resumed turn were re-verified on 2.1.1, together with a real
`mcp__cctb_search__provider_status` call. The public ACP server and MCP
registration surface remain unchanged; the real bridge-injected server stayed
discoverable and callable across the 2.1.x internal session, tool-policy, and
watcher changes. TaroBot does not silently retry
without explicitly configured stdio MCPs: an ACP initialization failure is surfaced so a rejected server is not mistaken for a healthy session. A missing bundled search entrypoint is diagnosed before injection and leaves native search available. Kimi 0.43 supports deferred MCP tool
definitions, but TaroBot deliberately keeps `cctb_search` inline so the model
can discover current-fact search without an additional tool-loading decision.

## Register With Antigravity

Antigravity reads its own native MCP configuration. TaroBot does not inject
Codex or Claude MCP state into `agy`, so registration is explicit:

```bash
cd /path/to/tarobot
npm run build
agy mcp add cctb_search node "$PWD/scripts/search-mcp.mjs"
agy mcp list
```

The active native file is `~/.gemini/config/mcp_config.json` (the earlier `~/.gemini/antigravity/mcp_config.json` is legacy). Current agy has no supported per-process MCP override, so TaroBot does not silently rewrite that global registration.

The server loads private integration settings and inherits exported Brave/Tavily keys. When those variables are not
present, it may reuse only the recognized search keys from an existing local
Codex MCP environment section; it does not copy or print them. Restart affected
Antigravity bot instances after changing native MCP configuration.

## Bot Runtime

After registering native MCP servers, restart affected bot instances so new Codex/Claude/Antigravity turns inherit the tool configuration. Kimi receives TaroBot Search MCP automatically when credentials are configured and its next ACP worker starts; no Kimi-side registration is required.

Codex-backed instances use Codex MCP registration. Claude-backed instances use Claude Code MCP registration. Kimi-backed instances receive TaroBot Search MCP through ACP and retain native Kimi MCP/plugins. DeepSeek should install `github:cloveric/deepseek-harness-web-search-plugin` in its `web` profile. Managed DeepSeek Hosts validate that plugin's capability marker, package-local entrypoint, and Harness patch registration: a valid plugin owns the client; an absent, capability-incomplete, or damaged plugin selects TaroBot's private bridge fallback only when search credentials are configured. Without keys, TaroBot does not inject an MCP client or require its tools; Harness native search remains available. User-installed plugins remain user-owned. The former `tarocub-deepseek-harness-plugin` package name is still recognized when it carries a valid Search MCP capability. `TAROCUB_SEARCH_MCP_OWNER` disables one side so exactly one client is active. Plain Harness has no bridge fallback and therefore needs the plugin or an equivalent native profile configuration. Antigravity-backed instances use the MCP/plugin configuration loaded natively by `agy`; TaroBot's structured headless transport does not replace it.

Keep the native plugin systems separate. Do not import Claude or Codex native plugins into Antigravity as part of the default bridge setup. Shared bridge skills should live as reusable skill files/docs or engine-neutral MCP/tool guidance. Instance `agent.md` files may reference or absorb those skills, but the `agent.md` files themselves remain per-instance, not shared state.

For standalone native CLI use, register a stable installed path, not a checkout
that may be moved or deleted. On macOS, install the App in `/Applications`
before registering its bundled Host. Test `provider_status` after a path change;
launch requests and configuration entries alone do not establish connectivity.
Existing engine processes may cache their MCP list until a new worker starts.


## Agent Guidance

Recommended usage policy:

- Do not search for purely local repo/log/debug questions.
- Only pass `http://` or `https://` URLs to `web_extract`; non-web schemes are rejected before a provider call.
- Use `web_search` with `mode: "quick"` for latest facts, docs, pricing, and broad discovery.
- Use `web_search` with `mode: "deep"` for research answers that need page content.
- Use `web_search` with `mode: "verify"` for important or uncertain claims.
- If the user provides exact URL(s), use `web_extract` or a direct browser read first; use `web_search` only to discover URLs, add background context, or recover from direct-read failure.
- Use `provider_status` when diagnosing whether Brave/Tavily is configured before a research task.
- Use `health_check` only when explicitly diagnosing provider health; it performs live API requests, may consume quota, and accepts an optional `query` probe term.
- `web_extract` accepts `maxChars` to bound returned source text; default is 20,000 characters and small budgets are valid.
- Prefer `sourceLog`, `domain`, `provider`, and `contentHash` fields when writing structured research outputs.
- If a `web_search` result includes `notice` or non-empty `fallbacks`, mention the fallback briefly in the answer.
- If `web_search` errors due to timeout, quota, rate limit, or provider outage and native search is used instead, disclose that native-search fallback clearly.
- Prefer cited answers when search tools are used.
