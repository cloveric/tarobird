# Desktop Codex composer presentation

The desktop Codex pending-message entry and send-mode selector share one row
above the typing field. The row follows the accepted phone treatment: a light
queue capsule, a raised selected mode, and existing theme accents for the count
and live stop control. The queue preview yields before the controls; constrained
chat panes can wrap the row. Send keeps its existing size and interaction.

The `is-codex-direct` marker on `composer-accessories` is presentation-only.
Desktop/browser rules explicitly exclude native iOS and Android platform hints
and `conversation-pane` shells. Native phone, expanded iPhone/Duo, Claude, other
engines and ADHD panes retain their existing rules. A simple desktop Codex task
entry can share the row; background progress keeps its separate arrangement.
The queue preview is capped on wide windows and withdraws when its own slot is
narrow. Paused/offline status and the help control retain their space. The CLI
visual theme keeps square corners.

The existing `PromptQueue` and `ClaudeSendChoice` remain mounted in the same
parent and order. Queue remains Codex's default; supplement, stop, draft, focus,
receipt identity, attachments and keyboard handlers are unchanged. This work
does not change a dependency, protocol or native bridge.

CLI impact: not applicable. This is App presentation only; the Host queue and
steering APIs and the corresponding CLI commands are unchanged. No release or
installed-App update is included.

## Verification

The new desktop browser regression failed on the original layout: the pending
queue and mode-selector vertical centers differed by 37 CSS pixels. It covers
long previews, Chinese/English, desktop resizing, a narrowed chat beside the
Workbench, queue/help access, and draft/default-route retention.

Validation uses a real isolated Hub/Gateway with deterministic engine fixtures.
Browser platform hints do not establish installed macOS/Windows or physical
mobile acceptance.

FABLE5 designed and rendered the capsule row in an isolated source checkout.
The implementer kept its CSS in a separate desktop stylesheet to make the scope
explicit, with the same declarations and one presentation marker in `App.tsx`.
The empty queue keeps the existing explanation in the toolbar; no extra hint is
introduced above the field, and Stop/model/Send keep their right-side alignment.

The implementer ran 43 focused Chromium cases covering Codex/Claude send choices,
native phone rows, Duo folding, model controls, queue pause/resume and a stop/send
race. One case was interrupted during trace cleanup by overlapping private
harness output directories; after separating the directories it passed unchanged.
After the queue-width/theme refinement, eight affected cases passed again,
including the new desktop Workbench/resize journey and native phone boundaries.
Translations, TypeScript, client production build, Host build and version
consistency checks passed. Complete Chinese/English, narrow-window and dark-theme
source previews were visually inspected. The Host and deterministic fixtures
remain separate from live-model or installed-App acceptance.

The final help-focus and background-progress spacing adjustments were followed
by another passing desktop resize/Workbench/help journey and client build.
FABLE5 separately rendered three synthetic state journeys (ordinary, native
task entry and background-group dock); the implementer reviewed the resulting
layout evidence without treating it as installed-App acceptance.
