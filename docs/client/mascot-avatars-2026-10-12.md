# Transparent mascot avatars — 0.1.401-test.1

## Behavior

The owner's four new sheets supply 36 mascot choices. Their colored square
backplates and oval ground shadows were removed with the built-in imagegen
editor, then split into centered 256px transparent WebP images by script.
Original inputs, edited sheets, exact prompt and crop receipts are retained;
see [asset provenance](../../client/src/assets/bot-mascots/README.md).

- Automatic default avatars now use this v2 collection everywhere the shared
  Avatar component appears: Bot directory, inbox, sidebar, chat header, messages
  and settings. The assignment is deterministic from the durable Bot ID and is
  stable across renames, reloads and updated clients.
- Selecting an avatar, shuffling, canceling, uploading a photo and restoring
  the default still use the existing editor and revision-checked Hub PNG API.
  Saved photos and explicitly saved older library images remain authoritative.
  No account, conversation, workspace or Hub migration is performed.
- Cutouts have no CSS backing plate. Automatic defaults retain their full
  silhouette, and their activity highlight follows the outline instead of
  drawing a rectangular frame. Uploaded photos keep the existing crop shape.
- The alpha channel survives canvas-to-PNG saving, Hub storage and cross-device
  synchronization. Older clients can display a saved mascot PNG; automatic
  defaults require the updated client. The 36 files total 1,176,680 bytes and
  ship in the offline/native asset bundle. Legacy animal sheets remain archived
  and reproducible, but are no longer imported into the current client.

## Verification

- Focused catalog/Hub tests passed. Full standalone gate: 220 test files,
  2,858 tests passed, one existing skip.
- Chromium and WebKit cover desktop/phone default identity, all 36 decoded
  images, 320px/390px layout, keyboard navigation, selection, shuffle/cancel,
  custom photo upload, restoring defaults, competing revisions, synchronization,
  offline cached avatars and optional-editor load failure recovery.
- Pixel checks prove transparent outer margins and visible opaque content for
  every packaged sprite, then recheck the saved/synced PNG on both clients. CSS
  background checks ensure the rendered avatar wrapper is also transparent.
  The first new pixel test waited on hidden lazy images and timed out; it now
  decodes those real source URLs independently. Both engine reruns passed.
- Inspected the actual phone picker (historical image omitted from this clean snapshot)
  and dark desktop picker (historical image omitted from this clean snapshot),
  including the cream characters, ears and disconnected planetary moons.
- Clean client installation, translations, TypeScript and production build passed.
- Android release assembly, JVM tests and release lint passed. Independent
  production-directory and npm-archive installs start an isolated Hub and serve
  the client without the Feishu SDK. The final signed APK retains the previous
  test certificate, version code 2026101216, and the chosen application icon.
  All 36 bundled mascots match the source WebP bytes and retain alpha; all public
  assets match the synchronized native client. The old animal assets are absent.

This prerelease delivers the Android client. Browser/package evidence is
separate from installation and acceptance on the user's physical phone. No
paired host, VPS, Telegram or Lark service is restarted by these checks.
