# Bot permissions acceptance — 2026-10-12

## Implemented

Creation, Bot settings and conversation details expose engine-specific permissions,
including the actual default and an explanation of the selected behavior. The
owner-only Hub/Gateway API validates the selected engine, preserves unrelated
configuration and sessions, rejects stale revisions and active-turn saves, and
records a permission-only audit event. Saved configuration survives Hub restore.
The dashboard displays the effective permission label instead of an ambiguous
legacy value. No extra client or host dependencies were added.

Claude has distinct Manual, Auto, Accept edits and Bypass choices. Kimi preserves
its YOLO default and offers Default and explicitly selected Auto / Never Ask.
Codex and DeepSeek distinguish sandboxed automation from unrestricted execution.
Antigravity and the legacy Codex process adapter describe whole-turn approval
accurately. Existing approval cards retain native allow/deny scopes and receipts.

Normal Codex runs explicitly choose workspace-write, including thread resume and
turn/start, so a previous full-access session cannot silently retain its sandbox.
Normal Claude runs explicitly choose the requested native permission mode. Busy
Codex/Claude workers cannot launch a new task using a stale permission setting;
non-security settings can still be deferred without interrupting background work.
Configured process adapters require an approval callback in normal mode.

## Evidence

- Final `./scripts/pre-complete-hook.sh`: 212 suites passed; 2,776 tests passed,
  1 skipped. Staged Gitleaks scan: no leaks found.

- Focused adapter/settings tests cover native flags, Claude remaining approval
  requests and deny responses, Codex resumed-thread sandbox overrides, background
  permission changes, every engine's config round trip, incompatible modes,
  simultaneous saves, corrupt files, preservation of secrets and session state.
- Chromium and WebKit each pass the three creation journeys (Codex, Claude,
  Antigravity), the native-scope approval-card journey on two devices, and the new
  permissions journey. The last covers desktop and 390px phone UI, persisted
  Claude Auto and Kimi Never Ask acknowledgement, Antigravity whole-turn mode,
  cross-device conflict/read-back, offline feedback and owner authorization.
- Reviewed desktop and phone screenshots: permission descriptions, default note,
  current selection and save/read buttons remain legible and inside the viewport.
- Client translation/type/build checks pass. Host standalone graph remains free
  of legacy transport imports and Feishu SDK dependencies.
- Local installed CLI help was checked. Codex's generated app-server schema was
  also checked for sandbox fields on thread/start, thread/resume and turn/start.

## Boundaries

Browser tests use isolated, real Hub/Gateway instances with fixture engines;
adapter tests use protocol fixtures. This does not assert live model execution
for every cloud CLI, native desktop/mobile shell acceptance, or a new installer.
No production Bot service was restarted, and no credential/config export was
committed. CLI versions and older-CLI limits are documented in ../permissions.md.
