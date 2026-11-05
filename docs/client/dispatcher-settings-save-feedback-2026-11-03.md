# Chancellor settings: save feedback and unsaved edits

The owner reported that the dispatch mode and concurrency controls were unclear,
and that values appeared to reset after leaving and reopening settings.

## Diagnosis

`DispatcherDialog` previously passed its close callback directly to
`CreationDialog`. Changing a field only updated component state; closing destroyed
that state without warning. Reopening correctly fetched the last settings stored
on the Host, making an unsaved edit appear to have been reset. Reloading also
silently discarded the draft. A focused browser regression against the preceding
build (`ef4dae7`) failed because closing a dirty editor produced no warning.

This reproduces loss of **unsaved edits**, not loss of an acknowledged write on
the owner's phone. Existing `useBotSettingsRequest` uses a bounded request and
only reports saved after parsing a successful PUT response. The Host commits
settings with an expected revision. No production settings were changed in this
investigation; the Bot CLI's owner-only settings read was not bypassed.

## Change

- Label the choices “派工前询问我” / “自动派工”, with an adjacent explanation.
  These describe the existing ask/auto instructions, not a new approval mechanism.
- Show whether edits are unsaved, a save is pending, a save was acknowledged, or
  the page is showing settings read from the Host. Errors never show success.
- Confirm before a dirty editor closes or reloads, including the phone back
  button, Android back event, desktop close and Escape. Continuing keeps the
  draft; only an explicit discard removes it.
- Keep saving explicit. In particular, leaving the page does not silently change
  dispatch policy, engine authorization or concurrency limits.

New Bot uses the same clearer field labels. The Host/API/schema and headless CLI
settings contract are unchanged: this is App presentation and draft lifecycle,
so no additional CLI command is needed.

## Verification

- `client-dispatcher-settings` and `hub-dispatch`: **32/32** passed.
- `dispatcher-settings-allowlist`: **9 distinct browser scenarios** passed in
  batches: the four existing allowlist/catalog cases, desktop/phone draft
  close/reload cases, desktop/phone save/reopen/page-reload/conflict cases, and
  one lost-receipt reconciliation case. The first phone run used the desktop
  sidebar selector and timed out before entering settings; corrected to the
  phone Bot tab/settings entry, then all four lifecycle cases passed.
- Lost-receipt coverage commits a real PUT to the isolated Host and replaces
  its response with an error. The UI does not claim success or rollback;
  explicit reload restores the committed value with exactly one PUT.
- Client translations, TypeScript and production build passed. Standalone Host
  build passed. Existing client chunk-size/mixed-import warnings remain.
- `git diff --check` passed.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/dispatcher-settings-save-feedback-20261103/`.
Tests use the production App with an isolated Hub, not the owner's installed App
or physical Android device. No release, installation or live policy change.
