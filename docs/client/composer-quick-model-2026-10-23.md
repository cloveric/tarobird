# Composer quick model and effort selection

The composer chips previously opened the complete Bot settings dialogs, requiring
another select and Save action. Each chip now opens an anchored list; choosing an
option saves immediately and returns focus to that chip. The full model dialog
and custom model IDs remain available through Bot settings.

Both quick lists read the owner-only model settings API when opened. Model and
effort are submitted together with the read revision. Compatible effort survives
a model change; unsupported effort follows the existing model selection helper's
advertised default/preset. Antigravity families map back to real discovered model
IDs. Opening a menu or selecting the checked item does not write a new override.
Choices are never inferred from another engine's effort list.

The scope remains Bot-wide and applies to subsequent tasks; running tasks,
conversation bindings and drafts remain intact. One explicitly targeted Bot is
required in groups. Phone and ADHD composer visibility is unchanged. Saves are
single-flight; failed or ambiguous results require rereading before another
choice. A menu cannot be dismissed or switched while saving. Changing the target
unmounts its controller, so an old response cannot update another conversation.

CLI impact: presentation only. Existing `tarobot bots model ID --model M --effort E`
and the model/effort CLI commands use the same unchanged API, validation, config
mutex and revision. No separate CLI capability or schema migration is needed.
App 1.0.103 / Host-CLI 0.1.450 package the same client assets for desktop and the
headless host's served web interface; protocol 1 and schema 1–21 remain unchanged.

## Verification

- Focused model/effort/CLI/selection tests: 49 passed.
- Chromium: 11 tests passed for quick selection, existing model dialogs and effort dialogs.
- WebKit: 8 tests passed, plus one final visual capture. Quick selection for Codex, Claude, Kimi, DeepSeek and Antigravity;
  model-specific choices, atomic incompatible-effort fallback, preset mapping,
  keyboard focus and dismissal, short-window bounds, themes, group targeting,
  read-only/offline access, draft/session preservation and reload persistence.
- Failure cases hold a pending save, drop its response, then force a revision
  conflict. Stale options cannot overwrite a newer revision; reread recovers.

- Full pre-complete hook passed: 453 files, 6176 tests, 5 existing skips;
  Host/client builds and 77 native desktop tests passed.

Browser tests use a real isolated Hub/Gateway and config files with a scripted
message handler; no model inference is needed for this presentation change.
Native installation and public release are separate acceptance steps.
