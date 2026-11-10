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

## Upgrading an existing Mac

Use **Settings → General → App updates** for an existing installation. The
updater replaces the contents at the current App location, even when its bundle
is still named `TaroBot.app`. Existing login items continue to point there.

For a manual DMG upgrade, first let active tasks finish and quit the existing
App. Keep its current location and filename: copy the new bundle into a temporary
folder, give the copy the same filename as the existing bundle, then replace
that bundle in Applications. Do not launch both copies or keep a second App with
the same identity beside it. Renaming the outer bundle does not rename user data,
Bot workspaces or credentials. Relaunch the retained App location and verify its
version and Host connection. New installations use `TaroBird.app` directly.

### Installed-copy and login-item check

After an authorized Mac installation, run the read-only check against the exact
App being accepted:

```sh
python3 scripts/check-macos-installation.py --app /Applications/TaroBird.app
```

It checks immediate App children in the selected App's directory, `/Applications`
and `~/Applications`; add `--root /another/install/folder` for other known
locations. It reports other bundles with the same identity even if renamed,
an enabled `TaroBot.plist` pointing elsewhere, and LaunchAgent references to
duplicate bundles. Aliases of the same physical bundle are not duplicates. A
single updated App retaining the old filename is valid. Findings return a
nonzero exit code; they are not automatically repaired or waived. Output can
contain private local paths and must remain outside Git.

Check the running process, Dock/default application and loaded login job
separately: this tool reads files only. A new package's correct icon does not
prove an old copy cannot still launch. An old Electron package can also emit
the already-fixed pre-ready shortcut error when another instance is running.
Repair an existing enabled login entry to the verified current executable;
preserve the user's enabled/disabled choice. Do not launch the old App as a
test, clear global icon caches, or delete it while a service uses its Node.
Retained dependencies and untested next-login behavior remain explicit
acceptance limitations. No Host/CLI runtime or App identity changes are needed.

The primary production Mac instance also attempts a bounded login-item repair
after Electron is ready. It only retargets an enabled, single-command managed
entry for an existing older bundle with the same identity, and only when the
current App is directly installed in `/Applications` or `~/Applications`.
Versions are compared numerically. Other plist fields are preserved; unknown,
same/newer, missing, disabled and foreign configurations remain untouched.
Repair and the user's setting writes are serialized so disabling wins over an
earlier repair. Failure is logged without opening a dialog or delaying startup.
This only updates the file for a subsequent login; it never invokes launchctl,
starts another App or retires the old copy. Custom installation locations still
need explicit review. This is desktop login behavior; headless Host/CLI, Windows
and mobile startup are unaffected.

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
