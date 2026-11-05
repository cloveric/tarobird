# DeepSeek Harness 0.2.1-rc.2 compatibility

Audit of the installed macOS `@deepseek-ai/dsh@0.2.1-rc.2` against TaroBot
1.0.88 / host CLI 0.1.436, followed by shared-adapter corrections. Verification
uses private hosts, synthetic conversations and external-disk workspaces.
Production conversations, credentials and DSH settings are unchanged.

## Confirmed compatibility bugs

### Resume must not create a used session

The 0.2.1 Session controller's `create` only reuses a named **blank** session.
For a named session that has already run a turn, it creates a new identity.
TaroBot previously used that call for both creation and restoration. A real
worker restart reproduced `DeepSeek Harness changed preallocated session id …`:
the first reply/file succeeded, then the second message failed after restart.
The old history remained intact; the identity check prevented silently continuing
with an empty replacement conversation.

The modern protocol now looks up the exact session identity before creation.
Existing sessions use their authenticated follow stream; subsequent commands
activate the original agent. Both the returned header identity and original cwd
must match. A failed/malformed lookup or mismatched identity/workspace fails
closed. Only an absent ID is created. The older legacy transport is unchanged.
This preserves the adapter's create-or-attach contract for ordinary replies,
native tools, Goal operations and restart recovery.

### Working-directory notices are context, not new work

DSH emits `source.kind = working-directory` when a session changes or recovers its
current directory. A notice before the real work input could make TaroBot reject
native App file delivery (`source-working-directory`) and omit Goal token usage.
Regression fixtures using the upstream event ordering failed before correction
and pass afterward. The private plugin and usage projection now skip this known
context source when determining ownership. Unknown sources, ordinary turns and
subagent work are still not inferred to belong to a Goal. Native usage projection
version 3 replays stored checkpoints with corrected accounting; the Hub database
schema and external protocol do not change.

## User-visible implications

- The [rc.2 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)
  adds DeepSeek-V4.1-Flash-1017 and DeepSeek Search/Fetch APIs. The authenticated
  local catalog returned `deepseek-official/deepseek-flash`, display name
  `DeepSeek-V4.1-Flash`, as the default, and `deepseek-v4-pro` as another route.
  The existing local TaroBot DSH Bot uses the engine default with `high` effort.
  Explicit per-Bot model selections are not rewritten by this audit.
- TaroBot's Brave/Tavily MCP configuration and search instructions stay intact.
  Native DeepSeek Search/Fetch is a separate provider choice; enabling it is not
  part of this check. Its external API was not tested.
- The [rc.1 changes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1)
  also change credential precedence, subagent completion and plugin contracts.
  TaroBot uses a private `dsh web` service: the new **headless** credential rule
  does not apply merely because the App hides DSH's window. Saved-auth startup,
  private App plugin loading and native subagent completion worked in real probes.
- Native DSH layout, fonts, scrolling and worktree UI do not update TaroBot's
  separate renderer or ADHD board. No new TaroBot UI capability is implied.
- The shared fixes apply equally to App-managed and standalone CLI-managed
  DeepSeek Bots. No new CLI command is needed. Other engines and Agent Bus
  routing are unchanged.

## Verification

| Check | Result and boundary |
| --- | --- |
| Initial focused adapter gate | 240 tests passed; this alone did not detect the upstream create change |
| Added coverage | 9 session-identity/lookup cases and 1 Goal context-notice case; existing native-tool notice case extended |
| Full source gate | 325 files, 4,310 tests passed; 1 Windows-only test skipped on macOS |
| Standalone build | Passed; 359 modules, no optional transport SDK dependency |
| Real private adapter | First reply, restart, same session ID and remembered token passed at both low and high effort |
| Real App file integration | Desktop/phone browser contexts: 2 file deliveries, atomic 2-file batch, exact bytes, captions, 3 durable receipts, no duplicates; worker restart retained context and tools |
| Real question and subagent | Native question answered and continued; one actual child launched and its result returned |
| Real stop boundary | Armed Goal remains active when an ordinary-message stop is refused; ordinary turn stops after explicit Goal clear |
| Real Goal budget | Provider usage counted, Goal turn stopped at budget, native projection and budget restored after restart; no extra turn |

The first two stop-boundary runs timed out waiting for initial story text; their
cause was not established. A later diagnostic-enabled run passed without changing
the assertion or extending the timeout. This does not prove the resume correction
fixed those initial-text timeouts. The fixture now retains underlying errors and
streamed text on failure instead of only reporting a poll timeout.

No physical Android/Windows execution, production DSH-session mutation, native
App-window interaction, historical 0.2.0-format migration, native Search/Fetch
round trip or full third-party-plugin matrix is claimed. See the
[sanitized receipt](evidence/deepseek-0.2.1-rc.2-2026-10-17.json); raw traces and
private fixtures remain on the external disk.

## Deployment status

These are source corrections after the published 1.0.88 / 0.1.436 artifacts.
They are not present in those installers or the local installed 1.0.88 App.
A subsequent matching App/host-CLI release is required to deploy them. This
audit does not replace a sealed installed App with development files.
