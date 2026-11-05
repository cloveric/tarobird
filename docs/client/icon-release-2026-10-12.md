# Selected icon reaches the installers

The selected violet mascot was merged after `v0.1.395-test.1` was packaged.
That release and the installed Mac 1.0.22 still contained the blue T icon;
this was a stale release artifact, not a launcher-cache diagnosis.

`v0.1.396-test.1` packages current main with Mac 1.0.23 and Android version
code 2026101211. It retains the application identifiers and Android test signer
so the APK supports an in-place update without resetting paired hosts or data.

The release checklist now runs `scripts/verify-release-icons.py` against the
App mounted from the final DMG and the signed APK. The actual 0.1.395 APK and
installed Mac 1.0.22 both fail with a stale-icon error; the new artifacts pass.
The checker decodes all 15 Android launcher PNGs, verifies the compiled
manifest and adaptive foreground/background references, and checks the sealed
Mac icon and release versions. The selected original artwork is unchanged.

## Evidence

- Final DMG mounted read-only; strict deep code-signature verification passes.
  Packaged ICNS matches source SHA-256
  `57b1c4efd0ffaf37f5497997e0d17696e1e4a9ca0223538580f32aa0908fb3a9`.
- Extracted APK launcher and DMG icon visually inspected: both show the violet
  mascot. Android v2/v3 signature verifies and its signing certificate matches
  0.1.395: `9e3ed24a0b9b90f765d2a21d4107c6f3e124fa652f6bf9cfc2fb04155c0c1b30`.
- All 396 bundled Mac host/client files and 398 Android public files match
  their production inputs. Mac bundles host 0.1.396 with no Feishu SDK.
- Standalone build and 219 test files pass: 2,851 tests pass, one existing skip.
- Android release build/lint and 20 JVM tests pass. Pairing/palette browser
  journeys pass: three Chromium and three WebKit cases.
- Standalone directory and npm archive independently install and start a Hub
  outside the checkout, without Feishu dependencies or credentials.

No physical Android device was attached. Artifact inspection and browser/JVM
checks are not physical launcher or provider acceptance. Mac remains ad-hoc
signed without Apple notarization; updating its signature can require macOS
keychain approval for an existing device key. No VPS or legacy fleet is changed
by packaging this release.
