# Existing Bot model settings — 2026-10-16

The Android report showed a read-only `模型 gpt-5.6-sol` field in Bot settings.
The existing page only exposed effort, permissions and persona editing. Creating
a Bot with a model or using `/model` did not provide an edit control here.

The model row now opens a selector on both phone and desktop. The host supplies
the same catalog as Bot creation. A saved custom model remains selectable, and
custom IDs are accepted for engines with provider-specific configurations.
Listing a preset does not establish account access; the native engine still
validates availability when it executes a task.

The form displays model-specific reasoning effort. If changing the model makes
the selected effort incompatible, the form selects Follow default with a visible
explanation before saving; the user can choose another supported level. The
server validates and commits both fields atomically. CLI callers that omit
effort preserve it and receive a conflict for an incompatible combination.

Settings are Bot-wide, owner-only and scoped to its host connection. Existing
messages, session bindings, workspace, secrets and unrelated configuration stay
intact. Concurrent changes from another device, the effort picker or commands
invalidate the revision. New tasks read settings at the native adapter's safe
boundary; executing work is not interrupted. Busy persistent workers can defer
application until idle, just as with the existing effort setting.

An older Hub without this route displays a host-update instruction instead of
pretending the change was saved. Offline and unconfirmed save errors are explicit;
no automatic save retry is performed. Reads can be dismissed.

CLI impact: implemented, not presentation-only. `tarobot bots model ID` queries
the same API; `--model M --revision REV [--effort E]` updates it. `default`/`off`
CLI aliases clear the respective override. No schema migration or engine switch.

Validation and release boundary: source change; not yet included in a new App
installer or standalone CLI artifact. Browser tests use isolated local Hub and
Gateway instances; they do not prove Android hardware or native provider calls.

Verification completed:

- Host standalone build and client translation/type/Vite build passed.
- Full host suite: 4,097 passed, one existing skip, across 309 files with two
  workers. Includes model compatibility for all five engines, config/session
  preservation, concurrent settings, owner authorization and real CLI HTTP calls.
- Chromium and WebKit: seven scenarios each passed (`model-settings`, `effort`,
  `settings-lifecycle`, `mobile-settings`). The expanded 320px cross-host model
  scenario was also rerun on Chromium after adding model assertions.
- Screenshots reviewed at phone width. Model settings also work before a first
  conversation and do not confuse matching Bot IDs on different hosts.
- The Codex adapter regression confirms a model change is deferred while busy
  and included when its idle worker restarts; it uses a fake child process, not
  a paid provider call.

Evidence logs and screenshots are under
`/Volumes/gdrive/taro-tmp/tarobot-model-settings-20261016` on the owner's Mac.
