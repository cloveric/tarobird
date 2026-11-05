# Bot model brand marks

Phone and desktop use the same small, monochrome model marks in a separate
slot to the **right** of Bot names, outside their name labels: 12 px beside
compact conversation/header labels and 14 px in Bot directories and pickers,
with a 6 px gap. The mascot or custom avatar stays separate. Marks inherit text color
in light, dark, Monochrome, Terminal CLI and Pixel styles.

## Meaning and updates

- **Settings → General → Appearance → Show model icons** is enabled by default.
  Turn it off to hide the marks and collapse their slots. It applies to all
  hosts on this device, persists across startup and does not change another
  device's choice. Older saved preferences default to showing the marks.
- Recognized configured models take priority over the runtime engine. An
  Antigravity Bot configured with Claude displays Claude, and switching it to
  GPT displays OpenAI. OpenAI, Claude, Gemini, DeepSeek and Kimi are supported.
  Fable aliases (`fable`, `Fable5`, `fable-5`, `Fable 5`) use the same bundled
  Claude mark as Opus, including provider prefixes and context-size suffixes.
  OpenAI's full GPT model IDs and exact short names `astra`, `sol`, `terra`,
  `luna` share the OpenAI mark. Similar unrelated names such as `solar` or
  `sol-alias` remain unrecognized. These are display rules, not an expansion
  of the model IDs or aliases accepted by an engine.
- An unspecified/default model may show its known engine's default brand; its
  description explicitly says the concrete model is unspecified. An explicit
  unrecognized alias has no mark. Bot names are never used to infer a model.
- These marks describe current configuration. Groups and historical message
  author names have no provider mark, so a model switch does not misattribute
  old replies. Long labels ellipsize while the mark keeps its size.
- Bot metadata is cached under the owning Hub identity. Cold offline startup
  uses that host's last synchronized metadata, not another host's same Bot ID.
- Gateway reports public engine/model/effort fields after message handling,
  settings calls and every 30 seconds. Reconnection re-reads configuration.
  The Hub authenticates the socket, ignores superseded sockets, and broadcasts
  only changes. Invalid configuration preserves the last valid metadata.

Live model switching requires the updated **client, Hub and Gateway**. The
optional heartbeat fields are compatible with older peers, but an older Hub
does not broadcast these new metadata updates. Updating client assets alone
does not upgrade an already running host or an installed phone package.

## Design and assets

Claude Opus 5.5 was consulted through the installed Claude CLI with `xhigh`
effort. Its advice informed the transparent monochrome marks, 12/14 px sizes,
model-first mapping and exclusion of historical-message badges. Placement to
the right, separate from the name label, follows the owner's final direction.
The consultation was advisory; implementation and verification were separate.

The five SVGs are locally bundled from [LobeHub icons](https://github.com/lobehub/lobe-icons),
pinned at `bcdb7c82792a854c2967f7328e11a30205ea584d`, under its MIT license.
Source URLs and SHA-256 digests are in
`client/src/assets/model-brands/provenance.json`; the license is also shipped
in `client/public/licenses/model-brand-icons.txt`. Marks identify their
respective products and do not imply endorsement. No runtime image service is
needed.

## Verification

- Standalone build and gate: 225 files, 2,892 tests passed, one existing skip.
- Client translation checks, TypeScript and production build passed.
- Chromium and WebKit passed the final focused journeys for right-side
  positioning, the visibility switch, language settings and same-ID Bots on
  different hosts. Palette checks passed in both engines. Forwarding, group
  settings, the phone inbox and host-cache regressions also passed.
- Isolated Hub/Gateway/browser checks exercise model changes on desktop and
  phone, explicit unknown aliases, long names, eight narrow-screen theme
  combinations, settings persistence, device-local visibility and cold offline
  reload. The command handler in this fixture
  writes Bot configuration; it does not call a live model provider.
- Inspected rendered captures: phone inbox (historical image omitted from this clean snapshot),
  desktop (historical image omitted from this clean snapshot),
  chat header (historical image omitted from this clean snapshot),
  visibility setting (historical image omitted from this clean snapshot),
  Terminal dark (historical image omitted from this clean snapshot),
  and Pixel light (historical image omitted from this clean snapshot).
  [Sanitized verification receipt](evidence/model-brand-icons-2026-10-12/verification.json).
- The language-settings test's old broad “Message” selector also matched
  “Message notifications”; it now targets the main navigation explicitly.

Browser rendering is separate from native installation and physical-device
acceptance. This change does not restart running hosts, relays or legacy
services and does not by itself publish a new installer.

## Fable follow-up (2026-10-19)

The model resolver omitted Fable while the model catalog already offered it.
Added Fable recognition with name boundaries, preserving the existing unknown
alias behavior and shared marks on desktop, phone and ADHD panes. Bot names
alone still cannot select a model brand. This is client presentation only;
headless CLI commands, model selection and Hub/Gateway behavior are unchanged.

Verification: 22 model-brand unit cases passed after reproducing six missing
Fable matches. The client translation/type/production build passed. The existing
Hub/Gateway model-brand journey passed in Chromium and WebKit with Fable added:
desktop/phone lists, live model switching, device-local visibility and offline
reload. No new installer was published or local App replaced by this repair.

The subsequent model-family pass confirmed that full Sol/Luna/Terra/Astra GPT
IDs and Sonnet/Haiku already matched. Added exact OpenAI short-name recognition
and regression coverage of every current Codex/Claude catalog entry. All 43
unit cases, client build, and the Chromium/WebKit desktop/phone journeys passed,
including live switches through Sol, Luna, Sonnet and Haiku. This follow-up is
also presentation only and does not change the headless CLI or installed Apps.
