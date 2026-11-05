# Default Warm Gray accent — 2026-11-04

The default Monochrome accent is now Warm Gray (浅暖灰, `warm-gray`,
`#e7e2dc`), as requested by the owner. The base palette remains Monochrome and
the initial theme remains light. The existing Warm Gray text, control and data
colours are reused; this change does not introduce a new colour scheme.

`DEFAULT_MONO_ACCENT` is shared by the first-run preferences, synchronous
appearance mirror and current/legacy preference readers. The settings radio
fallback now uses that constant too; the HTML startup attributes match it.
Missing or invalid accent values use Warm Gray. Every valid saved choice,
including `none` (不使用), remains authoritative. Existing stored `none` values
cannot be distinguished from the old default, so this change does not overwrite
them or reset other appearance preferences.

This is device-local App presentation. No headless CLI command, Host API,
permission, protocol or model configuration changes are needed.

## Verification

Evidence: `/Volumes/gdrive/taro-tmp.noindex/default-warm-accent-20261104`.
- Host build: passed (`host-build.log`).
- Final client translation check, TypeScript and production build: passed
  (`client-build-final.log`); existing chunk-size/dynamic-import warnings remain.
- Final Chromium and WebKit runs: five cases passed in each engine, ten
  engine/case combinations total (`chromium-final.log`, `webkit-final.log`).
  Coverage includes unknown-accent fallback, Warm Gray first-run selection,
  explicit opt-out across reload, colour switching, light/dark/system modes,
  contrast/forced colours and global/legacy saved-setting hydration.
- The generated desktop Warm Gray settings screenshot was visually inspected.
- Initial runs passed the three accent cases in each engine, but the retired
  palette fixture still expected a local `client/dist`. Those runs were stopped
  and retained as incomplete evidence. A temporary symlink to the frozen final
  build fixed the fixture path; the final runs above completed. The symlink was
  removed after verification.

No release or local App installation is part of this change. Browser checks
remain distinct from native-device acceptance.
