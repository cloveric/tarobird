# Skills and MCP inventory

The sidebar **Skills 与 MCP / Skills & MCP** entry opens a configuration inventory bound to
its `HubConnection`. The selected Bot determines the Gateway and host being read.
The page never scans the viewing phone/secondary computer. Bot selection, Skills
and MCP tabs, name/description/source search, source filters, pagination, refresh,
Chinese/English, and theme tokens are shared by desktop and narrow-screen clients.

## Meaning of the states

- **Discovered**: a bounded, valid SKILL.md metadata header was found. This does not
  assert that a running session has loaded, selected or executed the skill.
- **Configured**: a server declaration or known native TaroCub injection was found.
  This does not assert successful startup, authentication or a live connection.
- **Disabled in configuration**: an explicit disabled flag was found in a supported
  source. The page is not an effective-policy resolver across all scopes.

Every snapshot is `coverage: partial`, `runtime: unverified`. Scope, read time,
read/missing/unreadable sources and limits are visible. Refresh retains rows while pending, clears them on failure, and shows the saved read time;
late responses cannot replace a different Bot's inventory. Same-named declarations
from different files remain individually inspectable; symlinked skills deduplicate
by canonical file path. No direct install, enable/disable or credential edits are exposed.

## Configuration conversation handoff (2026-10-06)

The page now filters by configuration status as well as source and search. Each
row expands to show its source, transport, verification boundary and next step.
Unreadable sources remain visible without expanding the details. On phones the
near-full-height sheet keeps the Bot selector and tabs fixed while the inventory
scrolls; status filters and actions have at least 44 px touch targets.

**Add Skills/MCP** and **Ask Bot to check** open an editable configuration-message
preview. Its host and Bot are explicit. Confirming this preview creates one fresh
direct conversation and saves the text as a local draft; it does not send the
message, start a CLI, install anything or grant credentials. The user sends the
draft through the normal conversation flow. Existing conversation drafts remain
intact. An ambiguous creation receipt retains the same clientActionId on every
retry; a confirmed conversation is reused if saving its draft fails. A dismissed
dialog may finish saving its original draft, but cannot close or navigate a newer
dialog or another host. This is not a universal OAuth or tool-installation backend.

## Compact capability view (2026-10-16)

The introductory paragraphs, optional voice/search recommendations, configuration
caveats and source details are grouped under **说明与建议 / About & setup**. It is
collapsed initially, while **部分清单 · 未验证 / Partial · unverified** and any
additional warning count remain visible in its summary. Unreadable/limited source
counts, offline fallback, unknown workspace and configuration failures remain
inline outside the disclosure. No verified-runtime claim or inventory API changed.

The redundant total-count paragraph is removed. Compact filter labels retain their
counts and configuration semantics; their visible fills are 28 px tall while
phone touch targets remain at least 44 px. Keyboard focus uses an inset outline.
Search, source selection, refresh, pagination and editable setup drafts are
unchanged. Back/Escape closes the focused capability before unrelated explanations,
and ignores open child disclosures hidden by a closed parent.

Android 1.0.82 (2026101612) ships this presentation update. Host/CLI 0.1.430,
protocol 1 and schema 16 are unchanged. CLI applicability: presentation only,
with no new host operation, permission, data model or engine-specific behavior.
This release distributes Android only; the installed Mac App remains 1.0.80.
The shared renderer includes the compact layout for future desktop builds.
Browser fixtures cover 320/390 px portrait, touch landscape, short/normal desktop,
Chinese/English, light/dark, Back/focus, filters and configuration draft handoff.
Browser viewport evidence does not imply physical-phone acceptance.

The final compact-view browser runs passed all 15 journeys in Chromium and all
15 in WebKit. Independent read-only Opus review identified Back-order, warning
visibility, focus-outline and empty-copy issues; those were corrected. The
WebKit run additionally reproduced unfocused-button Back behavior, now covered
by the same interaction test. Android passed 30 unit tests and lint with zero
errors (22 existing warnings). All 390 frontend files in the signed APK match
the production build. The external-drive emulator upgraded 1.0.81 to 1.0.82
without changing its installation timestamp, then cold-started with no crash.

The first full standalone gate found an existing intermittent host failure in
`file-mutex`: six concurrent writers encountered `ENOENT` while creating the
shared lock directory (`src/state/file-mutex.ts:175`); 4005 tests passed, one
failed and one was skipped. The unchanged 22-test file-mutex suite passed in
isolation. This host race is recorded, not claimed fixed by this Android UI
release; neither the mutex implementation nor its test was modified.
A subsequent full standalone gate passed: 304 files, 4006 tests and one
intentional skip. The first failure remains a known intermittent host issue.

## Phone toolbar density follow-up (2026-10-17)

The inventory's selector and search inherited the general phone form font floor,
and tab text could grow with the chat font. Combined with the stacked Bot label
and full-height primary fill, this kept the toolbar visually oversized after
the explanatory text had been folded away.

The phone layout now places the Bot label beside its selector, uses compact
picker/tab/count text, fixes the search field at 44 px and gives Add Skills/MCP
a lighter 32 px fill inside its 44 px touch target. The refresh action loses its
large outlined box. Search input text retains 16 px to avoid iOS focus zoom;
its placeholder is smaller, and iOS selectors retain the same 16 px floor.
Android selectors use 13 px. Main conversation typography and desktop controls
are unchanged. This is presentation-only, so the CLI/API need no change.

Existing layout checks now also raise the chat font to 20 px, verify the first
entry remains near the top, check 320/390 px overflow and preserve 44 px targets.
The original layout fails the compact-control assertion. The final frontend
translation/type/production build passes, and `capabilities` plus
`capability-help` pass ten journeys each in Chromium and WebKit. Screenshots
were inspected at 320/390 px. Evidence is under
`/Volumes/gdrive/taro-tmp/tarobot-capability-density-20261017`. These are browser
and isolated Hub/Gateway checks; no new APK or physical-phone acceptance was
performed for this change.

## Read sources

| Engine | Implemented metadata sources | Remaining scope limits |
| --- | --- | --- |
| Codex | Host CODEX_HOME config.toml and skills; user .agents/skills; default workspace .codex/config.toml and .agents/skills; skills.config disabled paths | Plugin/cloud catalogs, ancestor/repo/admin policy and per-session catalogs are not resolved |
| Claude Code | Shared .claude.json user and exact-workspace MCP; workspace .mcp.json; user/workspace Skills; installed plugin conventional skills/.mcp.json and inline manifest MCP; supported disable settings | Custom plugin path declarations, cloud/managed MCP and runtime startup state are not resolved |
| Kimi | KIMI_CODE_HOME mcp.json/skills; user .agents/skills; workspace .kimi-code and .agents skills, workspace .kimi-code/mcp.json; TaroCub cctb_search injection | Dynamic plugin/agent catalogs and connection state are not resolved |
| Antigravity | User .gemini/config/mcp_config.json, .gemini/antigravity-cli/skills; workspace .agents/mcp_config.json and skills | Plugin runtime and managed policy are not resolved |
| DeepSeek Harness | Bot's private dsh-home/skills (Bot-private scope), workspace .dsh/skills; TaroCub search integration | Dynamic profiles/patches may contain executable tags; the reader deliberately does not evaluate these. MCP completeness is explicitly unavailable |

Source contracts were checked against the existing engine factory in `src/service.ts`,
Kimi ACP injection and DeepSeek private-home preparation, plus primary documentation:
[Codex Skills](https://developers.openai.com/codex/skills),
[Codex configuration](https://developers.openai.com/codex/config-reference),
[Claude MCP scopes](https://code.claude.com/docs/en/mcp),
[Kimi MCP](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/mcp.md),
[Antigravity configuration migration](https://www.antigravity.google/docs/cli/gcli-migration/).

## Ownership and read boundaries

`GET /api/bots/:id/capabilities` is owner-only, paired-device authenticated, rejects
all query parameters, checks Bot visibility and uses the existing response-time
revocation guard. Online reads execute in that Bot's Gateway environment. If a
Hub-managed worker is unavailable, fallback only inspects its registered Bot state
and workspace; the Hub does not substitute its own CLI home for the missing worker's.
An unavailable unmanaged worker produces an explicit error.

Responses contain metadata only, never file bodies, MCP commands/arguments,
environment values, URLs, headers or credentials. TOML and YAML are parsed as data;
no CLI, model session, MCP server or YAML script is launched. Reads bound regular
files, row/file/directory counts, and reject special files. Intentional filesystem
symlinks are supported for shared Skills. Configuration is never repaired or written.

## Acceptance boundary

`bot-capabilities` tests cover five engines, TOML/YAML metadata, symlink deduplication,
disabled entries, secrets, project isolation, damaged/oversized files, owner access,
fixed paths, revocation and offline fallback. Browser `capabilities` drives paired
Hub/Gateway transports with synthetic Bot workspaces on desktop and phone viewport
sizes; these tests do not spend model turns.

A separate read-only scan of one existing local Bot per engine is recorded in
`evidence/skills-mcp-local-inventory-2026-10-04.json`; counts describe discovered
configuration, not active tools. Physical phone and native package acceptance are
not established by browser viewport tests. The multi-host directory selects the
current host explicitly; this page uses that host's connection and Bot directory.

Actual Opus 5.5 xhigh review and dispositions: `evidence/skills-mcp-opus55-2026-10-04.md`. Critical source failures are visible without expansion; unknown catalogs show an unknown count. Old-host and incompatible-schema errors are distinguished from offline state. Host identity uses the shared SHA-256 runtimeHostId and supports touch expansion. Header/tabs stay visible when scrolling, and pagination returns to the top of the list.

Search focus belongs to the complete field, including its search icon. The inner
input must not inherit the generic text field's shadow ring: that produced a
second inset rectangle when typing on phones. `brand-theme.css` now applies the
same composite-field exemption used by sidebar search. The wrapper still changes
border color for pointer and keyboard focus. Focused `capabilities` and `safe-area`
journeys cover touch/Tab navigation, light/dark themes, phone portrait/landscape,
desktop windows and the resized keyboard viewport. Ten Chromium/WebKit journeys
and both builds passed on 2026-10-13; new native installers were not published.

## Same-name Skill groups (2026-11-12)

The App groups Skills by their exact displayed name. Case, whitespace and plugin
namespaces are not normalized. A group is a presentation shortcut, not a claim
that its sources have identical instructions or that any source wins at runtime.
Names can be grouped across user, workspace and plugin scopes; source ownership
is preserved. MCP rows remain separate. The Host metadata response, scanners, installed files,
engine loading and CLI behavior are unchanged.

Expand a group to see each source's configuration status, description and source
label. Each **Ask Bot to check** action retains that original source in the
reviewable message draft; the list never chooses a source or sends automatically.
Mixed discovered/disabled sources show **Some sources disabled**, and differing
descriptions are kept separately instead of selecting a representative version.
Identical descriptions appear once, and source-specific accessible descriptions
identify each check button to screen readers.

Search, scope and status must all match the same source. Filtering hides other
sources and shows the visible/total source count. The group status, description
comparison and ordering still consider all its sources, so filtering never
relabels a partially disabled Skill as wholly disabled or wholly discovered.
Skill tab totals, filter counts
and pagination count groups; a mixed group can appear in both state filters,
which the page explains. Sources stay together on a page. Refresh collapses the
previous disclosure and returns to page one so removed sources cannot leave a
stale expanded action. Bot selection and request ownership guards remain intact.

Focused validation covers exact-name boundaries, per-source matching and drafts,
mixed states, grouping before pagination, refresh, desktop/phone layouts and
English/dark appearance. Browser evidence does not establish installed-App or
physical-device acceptance. No release or skill installation is part of this
presentation change.
