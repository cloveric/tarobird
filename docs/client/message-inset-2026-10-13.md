# Desktop message alignment

Mac 1.0.52 removes the centred 760px timeline column from the desktop layout.
Bot avatars now sit at a fixed 28px inset from the conversation pane, including
wide windows. The composer follows the same left and right insets. Bot and
system message rows retain the 760px maximum reading width and shrink in
narrower panes; normal user bubbles remain right aligned. CLI user rows retain
the same bounded, left-aligned terminal layout. Phone layout is unchanged.

The previous centred column moved Bot messages farther from the sidebar as the
window grew. At the 1360px screenshot size, the avatar column moves left by
about 136px. The existing compact vertical spacing, text size and bubble
padding remain unchanged.

Verification uses isolated Hubs and the existing compact-message, streaming
card-width and sidebar-resize scenarios, with normal, CLI and pixel themes.
Before/after screenshots cover 1360px and 800px windows. The compact regression
continues to check actual toolbar hit targets, quoting the correct message and
unchanged row positions on hover/focus. A Chromium run caught its baseline
being recorded before react-virtual had applied the new theme/window's row
heights. The fixture now waits for contiguous measured row positions before
recording that baseline; its hover/focus assertions remain strict.

The root standalone build and client translation/type/build checks passed.
WebKit passed compact messages, sidebar resizing and all three streaming
card-width cases. Chromium passed the three streaming-width cases; the compact
case passed after the baseline synchronization above, as did its WebKit rerun.

No installed App, live host or real phone is modified by these checks. The
update is delivered as a local Apple Silicon installer, not a public release.

The Apple Silicon 1.0.52 DMG passed checksum verification, strict ad-hoc
signature, arm64/version/icon checks and byte equality for the executable and
all 378 bundled client files. The Downloads copy matches SHA-256
`aa9e933ec89e1c96d131e6c6f83454b0522963300e99c156a621db886f3200c3`.
