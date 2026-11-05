# Saved-file action alignment — 2026-10-27

Desktop attachment cards now right-align the saved-file action group beneath
Preview / Save. Show in folder uses the same icon-column width as Save.
Only desktop fine-pointer cards with a confirmed local save receipt are affected;
phone receipt layouts, file-preview dialogs, downloads and native grants retain
their existing behavior.

## Verification

- Existing `file-actions` saved-footer layout case passed in Chromium and WebKit:
  11 combinations each, including narrow desktop panes, English, light/dark and
  320/390 phone widths. Existing open/reveal calls, failure recovery, no-overflow
  and phone touch-target assertions passed.
- Black-and-white desktop inspected with the production porcelain styling.
- Host and client builds passed. Existing Capacitor keyboard dynamic-import
  warning remains; no new dependencies or Host changes.
- CLI: not applicable; this is CSS-only presentation of existing App actions.
- Browser native-save IPC is simulated. This change has not been released or
  installed; it is separate from the already-frozen 1.0.116 release.
