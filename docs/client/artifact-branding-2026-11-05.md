# Installer and application branding

The owner requested TaroBird names for new downloads, applications and default
installation locations. Existing installations, data directories and Bot
workspaces are explicitly outside this change.

- macOS packages now contain `TaroBird.app` and use a TaroBird disk-image volume.
  The updater archive also contains that bundle name. Electron helper names and
  signing-role matching change together, preserving Chromium JIT and the capture
  helper's camera/microphone rights.
- Fresh Windows installations default to `TaroBird` and create `TaroBird.lnk`.
  The existing registry namespace still restores an installed/custom location;
  existing owned shortcuts remain in place. Notification registration and
  uninstall recognize both generations of shortcut names.
- `scripts/release-artifact-names.mjs` supplies the Mac/Windows installer names
  and byte-preserving APK/IPA/CLI staging. CI stages the CLI through it; the iOS
  export entrypoint stages the IPA. Android release instructions require the
  signed APK to use the same entrypoint before checksums and publication.
- Android update discovery prefers the exact TaroBird APK name and still accepts
  historical TaroBot packages. Duplicate candidates, invalid metadata and wrong
  versions remain errors; invalid canonical assets cannot fall back to legacy
  assets. Android/iOS launcher labels already say TaroBird.
- Temporary-App retention recognizes both TaroBird and legacy TaroBot backups.

| Artifact | New filename |
| --- | --- |
| Mac installer | `TaroBird_VERSION_aarch64.dmg` |
| Mac updater | `TaroBird.app.tar.gz` |
| Windows installer | `TaroBird_VERSION_x64-setup.exe` |
| Android installer | `TaroBird_VERSION_android.apk` |
| iOS export | `TaroBird_VERSION.ipa` |
| Standalone CLI | `tarobird-VERSION.tgz` |

Internal executable names, npm package identity, native App IDs, Keychain
services, deep links and update channel tags remain compatible. The CLI commands
and Host behavior are unchanged; only the distributed CLI archive filename
changes. Old published packages are immutable. These source changes require a
new authorized release before users receive newly named installers.

Already released Android clients through 1.1.1 only recognize the historical APK
filename. When the first TaroBird-only APK release is authorized, those clients
need a manual package download for that transition. Preserve the application ID
and signing key so the package can update the existing App. Test that install on
a physical device and explain it in English release notes; do not silently add
an old-brand asset or claim older clients support the new discovery policy.

## Verification boundary

Focused tests cover the renamed archive root, preserved bytes/permissions,
signature roles, overwrite refusal, NSIS compilation and payload inspection,
existing Windows registry/shortcut continuity, iOS planning and retained backups.
The initial rename probes failed before implementation; the final Electron and
platform suite passed 397 checks, and retention passed 29 tests. Earlier failed
runs were retained: one fixture still used the old archive root; the broad Node
test invocation omitted its TypeScript loader; the first artifact readback
invocation omitted Cargo from PATH. The fixture and invocations were corrected.

An actual isolated Mac development package passed the fresh-start gate, bundled
Host startup/local pairing, close/Dock restore, isolated Host shutdown and legacy
migration refusal checks. The generated TaroBird DMG was mounted and verified;
its archive passed the current Rust extractor and the legacy updater extraction
loop, including code-signature readback. These artifacts are ad-hoc acceptance
packages, not notarized release installers. The first launch probe used a state
path over the Host socket limit; the probe guard now checks `hub-control.sock`,
and the complete probe passed with a shorter isolated path.

Host and client builds passed. The final artifact/NSIS subset passed another ten
checks after the filename fixtures were aligned with the new brand.
The Android regression reproduced four filename-policy failures before the fix;
all 50 Android JVM tests passed after it. Initial Gradle setup lacked generated
Capacitor plugins; running the normal Capacitor sync restored them. Generated
machine-specific dependency paths were excluded from the source changes.

Local packaging uses an isolated development App, not a published or installed
production replacement. Native Windows installation/upgrade remains a separate
physical acceptance requirement. No data-directory migration, release upload or
production App/Host restart is part of this change.
