# Settings trigger focus on return

The Mac sidebar settings gear could retain a large outline on returning to the
window. Preferences deliberately restores focus to its entry button when it
closes; WebKit's `:focus-visible` heuristic can also mark programmatically
focused buttons as keyboard targets. The earlier persona heading fix only
changed the initial target inside `CreationDialog` and did not address this
shared input-modality behavior.

`focus-intent.ts` now records pointer and keyboard input before component
handlers run. Pointer-focused buttons do not paint a keyboard outline even
when WebKit considers them `:focus-visible`. Focus restoration itself remains
intact. Tab, WebKit's macOS Option+Tab, Enter and Escape retain the normal
keyboard outline. Modifier-only and OS app-switch shortcuts do not change the
input method, and window activation preserves it. Text-field focus styling and
pixel-theme decorative borders are unchanged. The listeners are removed on
development hot disposal.

## Verification

The new settings browser journey covers mouse opening/closing, retained focus
after a second-page foreground round trip, keyboard traversal back to the
gear, Enter/Escape, and switching back from keyboard to pointer use. It runs
for mono, CLI and pixel palettes. Before the fix, WebKit reproducibly painted
a solid outline on the pointer-opened preferences close button. The browser
round trip does not reproduce the exact native Dock/tray reactivation and is
not evidence of acceptance in the user's installed Mac App.

Related settings draft/navigation, persona editor, Bot context menu and phone
attachment-menu regressions protect their existing focus and action behavior.
The selected journeys passed in both Chromium (38) and WebKit (38). Root and
client production builds passed. The new test also confirms that keyboard
focus still has a solid 2px outline in every checked palette, while mouse
return has no outline. The WebKit pixel screenshot preserves the theme's
decorative borders while the settings gear remains unframed.

Mac client 1.0.57 was packaged as an Apple Silicon DMG. Its read-only mounted
App passed strict ad-hoc signature, version, icon and executable checks; all
378 bundled client files match the validated production build. The Downloads
copy matches SHA-256
`9a4c0f29f5b3f20d868a97565da49ea45020a2252016c8b9e90f5c81961da36f`.
The installed App and running host were not replaced. Native Dock/tray
reactivation in the user's installed App remains to be confirmed after update.
