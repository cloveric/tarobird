# Runtime host chooser alignment

The creation chooser inherited centered button content, so a short host name
and a long host name placed their computer icons at different horizontal positions.

`client/src/hosts.css` now left-aligns the creation chooser rows, keeps the icon
at its original size and gives the name/status column the remaining width.
Long names wrap inside the row. The rules are scoped to the creation dialog;
the first-run host-role cards retain their existing layout.

This is presentation-only. CLI commands, host identity, network membership,
Bot ownership and engine behavior are unchanged; CLI changes are not applicable.

Validation:

- Standalone host and client production builds passed.
- Existing `host-workspace` and `pairing-design` browser suites passed:
  7 Chromium and 7 WebKit cases.
- The real App was paired to two disposable local Hubs named `Eric MBP` and
  `example-desktop.local`. Both rows had identical icon and text left edges.
- At 390 px and 320 px widths, a 72-character unbroken host name wrapped without
  horizontal overflow or shrinking the 20 px icon. The dialog stayed on screen.
- Selecting Eric MBP opened the Bot creation dialog labelled `运行于 Eric MBP`.
  No actual Bot was created for this visual check.

No installer was built or installed in this change. Browser layout checks are
separate from a packaged desktop or physical-phone upgrade.
