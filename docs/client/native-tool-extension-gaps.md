# Remaining native App tool extension gaps

2026-10-03 read-only investigation. This is a current implementation constraint,
not a claim that either engine can never support native App file tools. Installed
Kimi Code was 2.1.1; Antigravity was 1.2.14. Their already-verified compatibility
file delivery remains in place while a safe native integration is investigated.

## Kimi

The existing ACP session creation/loading interface accepts private MCP server
declarations. However, the inspected v2 MCP stdio client forwards tool name,
arguments and cancellation options, without the native turn/tool-call identity.
Source: [client-stdio.ts at the inspected revision](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/mcpCore/client-stdio.ts).

Matching an MCP request to an ACP event only by arguments cannot distinguish an
identical foreground and background call. A model-visible turn token is not proof
of native origin. The App sender therefore must not silently grant whichever turn
is currently foreground.

[Native hooks](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/docs/en/customization/hooks.md)
provide observation and denial, but PreToolUse runs before permission checks and
PostToolUse is observation-only. Executing file delivery inside a pre-hook could
publish before a later permission denial. The inspected hook contract does not
provide a supported argument rewrite or replacement successful tool result to
solve this. [Plugin documentation](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/docs/en/customization/plugins.md)
also says unsupported runtime fields such as tools/apps/inject/configFile are
ignored; actual tools use MCP.

Next integration needs a supported exact native call identity at the side-effect
boundary, or another demonstrably isolated native execution channel. Do not
weaken the shared App grant checks to mark the migration complete.

## Antigravity

Installed `agy --help` exposes persistent stream-json input/output and native
conversation resumption. `agy mcp add --help` exposes named stdio/HTTP servers and
environment/header flags; no per-process MCP configuration flag appeared in the
inspected help. This observation is not an exhaustive claim about every version
or undocumented environment setting.

A private per-worker injection/lifecycle interface has not yet been established.
Do not modify the user's global MCP list as an adapter startup side effect. The
current stream-json adapter, native sessions and existing compatibility delivery
remain unchanged by this investigation.

2026-10-04 refresh: Kimi remains 2.1.1; installed Antigravity is now 1.2.16.
Its `--help` still does not expose a per-process MCP configuration flag, and
`mcp add --help` still describes named stdio/HTTP server configuration. No global
MCP entry was changed and no new native App tool integration is claimed. The new
CLI does advertise `xhigh`; the separate [effort compatibility fix](antigravity-effort-2026-10-04.md)
aligns configuration and worker arguments with that observed interface.

2026-10-11 refresh: installed Kimi remains 2.1.1; Antigravity is 1.3.3.
The captured `--help`（本地材料：`evidence/native-events-20261011/agy-help.txt`）,
`mcp add --help`（本地材料：`evidence/native-events-20261011/agy-mcp-help.txt`） and
`plugin --help`（本地材料：`evidence/native-events-20261011/agy-plugin-help.txt`） still do not
establish a private per-process injection plus exact native call identity at the
App side-effect boundary. Plugin installation support alone does not prove this
authorization contract. No global MCP/plugin configuration was modified. Existing
compatibility delivery remains; no new native App tool acceptance is claimed.
