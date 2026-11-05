# Model families and reasoning effort

Antigravity advertises concrete IDs such as `gemini-3.8-flash-high` with labels
such as `Gemini 3.8 Flash (High)`. The old creation/settings form listed every
variant while also offering an effort override, presenting one setting twice.

The desktop and phone forms now share `client/src/model-selection.ts`. Verified
variants appear once as a model family; reasoning effort has its own selector.
Choosing an effort maps to an exact ID returned by that host's catalog. Only
levels actually advertised for that family are offered. A family with Low/High
does not inherit Medium from another family, and a single Medium variant does
not gain other choices. No fabricated base ID or unsupported level is sent.

Grouping requires matching ID suffixes, matching display-label suffixes and
host-reported capability. Unknown/custom IDs, conflicting labels and incomplete
families retain their original presentation. Other engines retain their own
host-provided capabilities; their menus are not assigned Antigravity levels.

On model changes, a supported effort is retained. Otherwise the new family's
first advertised variant is selected and an adjustment notice is shown; ordinary
models retain their existing follow-default fallback. New Antigravity Bots still
start with the host's preferred Argon Medium variant when it is available.

Opening an existing Bot does not rewrite its model or effort. When an explicit
override is absent, a recognized variant's preset is displayed. Existing invalid
effort remains visible for correction, with saving disabled. Changing a grouped
model or effort explicitly saves the concrete variant and effort together.
The separate effort-only control retains its override API and labels its default
as “Use model preset (high)” when the preset is known; its model description no
longer repeats that suffix. Unknown presets are not inferred as compatible.

Existing server-side capability validation, permissions, revision conflicts,
session preservation and no automatic save retry remain in force. CLI impact:
presentation only; `tarobot bots model` and effort operations continue using the
same catalog, APIs and concrete IDs. No host schema or native adapter changes.

Validation uses isolated Hub/Gateway/browser fixtures, including differing
capability sets, fixed effort, unsupported legacy settings, stale saves, default
model, custom IDs and no session/chat side effects. The native model providers
are not invoked by these tests. This change does not publish or install an App.

Verification on 2026-10-19:

- Focused unit/integration regression: 53 passed across `client-model-selection`,
  `antigravity-models`, `effort-settings`, `model-settings`, `hub-bot-manager`
  and `host-cli-model`. Unsupported AGY combinations are rejected by the server
  without modifying the stored configuration.
- Chromium: 15 passed; WebKit: 15 passed across `creation`, `model-settings`,
  `effort`, `settings-lifecycle` and `mobile-settings`. Phone and desktop journeys
  verify exact saved IDs, per-family levels, stale-save conflicts and unchanged
  sessions. Rendered phone creation/settings screenshots were inspected locally.
- Client translation validation, TypeScript checking and production build passed.
- These are isolated browser/Hub checks, not physical Android/iOS or native model
  execution acceptance. The full project suite and a release build were not run
  for this client presentation change.
