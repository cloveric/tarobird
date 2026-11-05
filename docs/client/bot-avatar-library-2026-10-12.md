# Bot animal avatar library — 2026-10-12

Historical v1 evidence. The owner requested replacement with transparent mascot
defaults in 0.1.401; see [the v2 behavior and validation](mascot-avatars-2026-10-12.md).
Saved PNG overrides remain intact. V1 source/crop reproduction uses
`assets/bot-avatar-sources/catalog-v1.json`.

## Behavior and compatibility

- 63 animal portraits from the seven sheets supplied by the project owner.
  Default Bot avatars replace initials everywhere the shared Avatar component is
  used: sidebar, inbox, chat header, messages, creation and Bot settings.
- A new Bot already receives an identifier derived from its random creation
  request. The v1 catalog maps this persisted id to a stable animal, giving new
  Bots a random-looking assignment without a client-local random choice on each
  render. Reloads, rename, restart and other devices preserve the same result.
  The catalog order/seed algorithm is frozen; future additions do not remap v1.
- Existing Bots without an image get the same deterministic default. Existing
  custom images retain precedence. No Bot/session/workspace/memory migration.
- Bot settings offer a library, explicit shuffle, custom upload/crop, save,
  cancel and restore system avatar. A selected animal uses the existing 256 px
  PNG API, revision conflict handling, permission checks, cache and broadcast.
  No new protocol fields or Hub upgrade requirement. Older clients display a
  chosen/saved image, but keep their old fallback for unmodified defaults.
- User/group avatar semantics remain unchanged. Bot portraits use rounded
  squares; keyboard navigation supports arrows, Home and End in the library.
- Editor code loads on demand. The seven JPEG originals are unmodified, with
  per-tile CSS viewports. Native bundles/offline shell include all seven files.
  A saved choice is a small raster avatar, not the full sheet.

## Verification

- Root build and test suite: 204 files, 2,738 tests passed, one existing skip.
  Client translation validation, TypeScript and production build passed.
- Chromium and WebKit covered stable defaults, all 63 portraits, selection,
  shuffle/cancel, upload, restoring defaults, two-device synchronization and
  concurrent revision conflicts. Final WebKit avatar/startup run: six passed;
  final Chromium library run: passed. Phone layouts include 390 px and 320 px.
  Startup JavaScript remains within its 700,000-byte budget (697,628 bytes).
- A separate macOS Tauri preview was paired to an isolated fixture Hub. Verified
  the library in the native window, selecting/saving a cat, identical portraits
  in the sidebar/header/messages, and automatic panda assignment when creating
  a Bot. Quitting and reopening preserved both the custom choice and default.
  Native testing caught overlapping WebKit grid rows; fixed-size grid tracks
  and non-interactive image layers resolved it, then native checks were repeated.
- Desktop 1.0.19 arm64 DMG: mounted read-only and its App signature verified.
  Android 0.1.392-test.1 (2026101207) APK: aligned and signed with the existing
  test certificate; signature and package metadata verified. Compared all 335
  client build files in the DMG, standalone directory, extracted npm tarball and
  APK (Android HTML differs only by the expected native CSP). All seven original
  JPEG sheets are packaged; their source bytes match the supplied files.
- Both an outside-checkout standalone installation and a separately extracted
  npm tarball passed fresh production dependency installation and the standalone
  verifier: no Feishu SDK, credentials or CLI, with Hub startup and asset serving.

## Acceptance limits

- No Android physical device was connected. Browser phone-size checks and a
  signed APK do not constitute physical-device acceptance.
- Native verification used a fresh, separately identified preview App and
  synthetic Bots/workers. The installed production App, real Hub/Bot services
  and user data were untouched. Installed-App upgrades and real provider CLI
  round trips were not repeated for this avatar-only change.
- Original sheets total 12.47 MiB. They are included unchanged; extracting and
  compressing individual source files is a possible later asset optimization.
