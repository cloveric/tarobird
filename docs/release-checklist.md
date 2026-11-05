# TaroBird release checklist

Publish only to `cloveric/tarobird`. Write GitHub Release titles and notes in
English. Do not import old releases; the first release here is the then-current
version, built from this repository's own source commit. No Release is part of
the source-only migration. For its first release, verify the new repository's
updater access and the one-time upgrade path from historical binaries, following
[repository migration](repository-migration.md).

Include the [iOS public TestFlight invitation](https://testflight.apple.com/join/ByFWEfFW)
in each release’s installation section, labelled **iOS TestFlight public beta**.
Verify that the invitation still opens TaroBird before publication. Keep the
English and Chinese README download and phone-setup links aligned with it;
TestFlight availability does not imply an App Store release.

Before packaging, run `npm run version:check` and follow [versioning](versioning.md).
All App/CLI artifacts share `release-version.json`'s product version/source.
Apply the [upload privacy gate](repository-privacy.md#every-main-and-pr-upload)
to release text, unpacked binaries, images, signing logs and final artifact bytes;
source-only Gitleaks is insufficient. Do not publish a developer home path embedded
in Rust/native objects. Use compiler path remapping and scan the resulting binaries.


TaroBot is an independent App, Hub, Gateway and optional relay. Retired Telegram/Lark adapters are not shipped. Do not restart old fleets or migrate their data as part of a release. See [retirement boundaries](adapter-retirement-2026-10-21.md).

Start publication or installed-App activation only after an explicit owner
release/update request. A completed audit, fix, commit or push is not that request.
An instruction to wait for a new release request supersedes an earlier queued
release/update: retain its artifacts and receipts, but do not publish or install.

## Scoped patch releases

Use this profile only when the owner explicitly authorizes a small patch release.
Record the last published source SHA, exact patch diff, affected entrypoints,
published platforms and evidence scope before freezing. A PATCH version alone
is not approval to reduce validation.

- Keep dependency and integrated-skill pins unchanged. Compare dependency
  resolution, vendor files and unaffected source blobs with the published
  baseline; record exact hashes and baseline receipt links. This profile does
  not require a fresh whole-project upstream upgrade cycle or unrelated
  model/editor/physical-device regression runs. Do not label inherited evidence
  as a new run. Any dependency, protocol/schema, authorization, updater or
  signing change requires its corresponding broader validation before release.
- Run failing-before/passing-after regressions for the fix, the affected existing
  suites, fresh builds and relevant real-runtime acceptance. Steps 1, 2 and 5
  below use this documented scope instead of unrelated full-suite/model runs.
  Use clean frozen source and verified dependency locks; unchanged development
  dependency installs may be reused only with their exact lock provenance.
- Rebuild every artifact that will be published from the new source/version.
  Always perform fresh package-content checks, signatures/notarization, unpacked
  privacy scans, exact final-upload inventory checks and downloaded-byte readback.
  Previous artifact approval never covers newly built bytes. Publication and
  installed-device acceptance remain separate, including unavailable Windows
  native tests; do not claim a missing test passed.
- Publish only affected platform channels. Unaffected mobile channels may keep
  their previous release; never relabel or replace their old packages. Source
  version fields stay synchronized. Desktop releases include the matching
  standalone CLI and check its clean install/upgrade and bundled-Host match.
- Keep explicit release authorization, English notes, source/upload privacy
  hooks, immutable released assets and the guarded cleanup requirements.

The full profile below remains the default for feature releases and changes
outside the recorded patch scope.

## Full release upstream gate

Before freezing a full release, complete the upstream integration update gate:

- Inventory all integrated open-source projects from package manifests,
  vendored-source manifests and `LICENSING.md`, including Excalidraw, Vditor,
  baoyu-design (canvas and slides), their bundled/adapted skills and future integrations; this is not a fixed three-project list.
- Include skill entrypoints, authoring references and helper scripts in that inventory.
  Review SKILL.md diffs even when package/editor versions have not changed. Keep
  skill/editor pins aligned; adapt upstream guidance to the App protocol rather
  than copying standalone server instructions. Verify skill resources in the
  standalone/App host package and selected global install locations; smoke explicit
  Baoyu Design/PPT routing and preserve default skills for ordinary PPT requests.
- Check each official upstream repository/release feed against the version or
  commit actually bundled. Use the latest stable release; for commit-pinned
  projects without a release channel, check the latest upstream commit.
  Do not treat a prerelease as stable or a failed lookup as "no update".
- If newer code exists, integrate it before publishing: review API/data-format
  changes, preserve existing saved content, adapt the integration, refresh
  lockfiles/vendor hashes and copyright/license notices, and pass the affected
  desktop/mobile, Bot/CLI and build checks. A version-number edit or successful
  download alone is not an upgrade; verify the actual bundled runtime and its
  relevant user flows. Then freeze the updated source and build release artifacts.
- In release evidence, record each project's source URL, check date, current and
  upstream version/commit, upgrade result and validation. An unavailable upstream
  check, unresolved incompatibility or failed/missing required validation blocks
  publication; report the blocker rather than silently shipping the old version.

Before building, follow [unindexed artifact storage](macos-artifact-retention.md).
Create a unique `.noindex` workspace and source its `build-env.sh`: Electron
output/cache/Cargo targets (`TAROBOT_DESKTOP_OUTPUT`, `TAROBOT_ELECTRON_CACHE`,
`TAROBOT_DESKTOP_TARGET`) and `CARGO_TARGET_DIR` stay inside physical `.noindex`
roots; include staging, rollback, native fixtures, DMG mounts and updater
extraction. A held release keeps its `OWNER-HOLD.json` at the task root.

1. Run `./scripts/pre-complete-hook.sh` (standalone build and tests with no Feishu SDK).
2. Run the shared and compatibility regressions in the default suite. `npm run build` must reject retired adapter imports, including type-only imports; never reinstall the retired SDK to make a product build pass.
3. Run `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --prefix client` and `npm run build --prefix client`. Native packaging/physical-device checks are separate evidence.
4. Run `npm run pack:standalone`; every build platform must produce `bin/tarobot-host-launcher.exe` as a Windows x64 GUI-subsystem executable. macOS/Linux use `cargo-xwin`; missing build tools or a missing/invalid launcher must fail packaging. For direct `npm pack` from source, first run `node scripts/build-host-launcher.mjs --output bin`; the prepack guard verifies the launcher. Install the resulting directory in a location outside this checkout with `npm ci --omit=dev` and inspect the transitive dependency tree. It must not contain the Feishu SDK or SDK patch hooks. Run `npm pack` in that directory, extract the archive elsewhere, and repeat installation and `scripts/verify-standalone-package.mjs` against the extracted package; it verifies the launcher on all operating systems.

   The Ubuntu source-check job and macOS desktop packaging job prepare the Windows Rust target, LLVM/LLD and pinned `cargo-xwin` 0.23.1 through `.github/actions/setup-host-cross`; SDK/CRT downloads are cached and limited to x64. Their cold-build budgets are 45 and 60 minutes. Windows packaging and native migration acceptance use the native MSVC toolchain with a 90-minute budget. Local `desktop:prepare`, `desktop:build`, `desktop:release`, `desktop:windows` and standalone packaging need the same cross tools when run outside Windows. See the [cargo-xwin prerequisites](https://github.com/rust-cross/cargo-xwin/tree/v0.23.1#prerequisite); Homebrew provides [LLD separately from LLVM](https://formulae.brew.sh/formula/llvm).
5. Verify paired-client → Hub → supervised Gateway → real engine → client, recording real CLI results separately from doubles. Include files, voice, question cards and stop/resume; state any missing provider/device validation.
6. Desktop defaults now package Electron. Supply fresh absolute `.noindex` output,
   cache and Cargo target paths through `TAROBOT_DESKTOP_OUTPUT`,
   `TAROBOT_ELECTRON_CACHE` and `TAROBOT_DESKTOP_TARGET`; set
   `TAROBOT_SOURCE_COMMIT` to the clean release commit. Run
   `npm run desktop:macos --prefix client` or
   `npm run desktop:windows --prefix client -- --signed-updates`.
   `desktop:build -- --development` produces an isolated acceptance package,
   which requires `--tarobot-development=/short/path.noindex/profile` to launch;
   it is not a distributable production App. The native Rust core, addon,
   transactional updater, one-time legacy WebView reader, React UI and bundled
   Host are built together. No Tauri desktop shell is built by these entrypoints.
   Keep the Tauri dependency only for the one-time old-origin data reader and
   update-signature compatibility.

   For Mac production, configure Developer ID, Team ID and a notarytool profile
   (see the [Electron migration guide](client/electron-migration-2026-10-30.md)).
   `electron-package.mjs` applies Electron-specific entitlements; do **not** run
   the old Tauri `macos-signing.mjs sign` against this package, because it would
   remove Chromium's JIT rights. `electron-macos-artifacts.mjs` verifies every
   executable, loads a foreign native addon in bundled Node, notarizes/staples,
   creates the DMG and updater archive, mounts/extracts the final artifacts and
   signs/verifies the archive's version. Only Host Node receives
   `disable-library-validation`; Electron main and renderer helpers receive JIT
   rights without that exception. Publish the `.app.tar.gz`, its signature and
   `macos-tarobot-latest.json` together. A DMG-only upload does not update the
   in-app channel. Never change/re-sign an App after signing its archive.

   Before the first Tauri → Electron release, run the signed Mac disposable-key
   compatibility probe (`client/electron/tests/macos-credential-compat.smoke.mjs`)
   with the old App's designated requirement and a signed development Electron
   App (`--signed-acceptance`). It exercises the genuine Electron main process
   as caller and verifies that launching the helper directly from Node is refused.
   Reading a key is insufficient:
   verify its signature, exact-key deletion and rejection after deletion. This
   fixture does not replace actual installed-version read-back.

   Production starts must reject debugging/profile overrides before Chromium
   opens a debugger endpoint. Persistent browser data belongs under
   `electron-profile/browser-data`; it is not a disposable cache. Resume a
   notarization wait using its saved submission ID and immutable ZIP. Rejected
   submissions keep their receipts; a corrected App uses a new output directory.

   On a disposable Windows runner, use
   `client/scripts/windows-acceptance.mjs` for install/upgrade/update/uninstall
   and native tests, and `desktop-persisted-migration-audit.mjs` for real
   WebView2 → Electron content preservation. Follow
   [the Windows acceptance instructions](../client/windows-electron/ACCEPTANCE.md).
   Record the judged scopes: CI's `install,native` receipt does not establish
   old-Tauri/custom-path upgrade or an Electron-to-Electron update. Missing
   required checks are `incomplete`, never pass. Cross-compilation and installer
   extraction alone do not satisfy these Windows gates.

7. Check the final installers, not just the source icons: `python3 scripts/verify-release-icons.py --mac-app /Volumes/TaroBird/TaroBird.app --windows-exe /private/output/windows-extracted/tarocub-client.exe --windows-icon-group 1 --apk /private/output/TaroBird.apk --aapt2 /path/to/android-sdk/build-tools/36.0.0/aapt2 --receipt /private/output/icons.json` (Python 3 + Pillow; Windows also requires pefile). Use the App mounted from the final DMG, the main EXE extracted from the final Windows installer, and the signed APK; flags can be used separately per platform. Electron selects Windows icon group `1`; legacy Tauri verification keeps the default `32512`. The check validates the selected master, sealed macOS icon/version, Windows transparent alpha and all six ICO frames in its actual app icon resource, Android launcher manifest and adaptive references, background, and all 15 PNG density variants after decoding. Recheck the downloaded GitHub asset digests after upload; merged source alone does not update an existing release.
8. Commit only source changes and sanitized evidence. Create an accurate GitHub Release only when explicitly releasing.
9. After publication and asset read-back, run `python3 scripts/cleanup-macos-artifacts.py --apply --keep-version APP_VERSION --receipt CLEANUP.json` (the Mac publisher invokes it automatically). Keep the newest `macos-ready` backup, skip six-hour/active-task/build/owner-hold/activation guards, and use `/usr/bin/trash` only. Record skipped paths, then run the Spotlight query in the artifact guide. Never touch installed Apps under `/Applications` (TaroBird or legacy TaroBot).

Native ID transition gate: the owner selected `com.tarobot.client` on every
platform. Follow [the transition record](client/native-app-identity-2026-10-28.md).
The first cross-ID release needs a one-time installer transition; old macOS and
Android updater identity checks must remain strict. Verify existing Host data
and workspace paths, fresh client pairing, Windows uninstall/reset for both
roots, native notification permissions and the final artifact identifiers.
Android Firebase config must contain the new registered package. iOS requires
a new App Store Connect record, App Group associations, distribution profiles
and the new APNs topic; do not silently break old installed iOS pushes by
changing the live topic. Simulator/APK compilation is not signed distribution
or real-device acceptance. Keep all signing credentials/config outside Git.

The new identity uses **separate updater channels**: `macos-tarobot-vX.Y.Z`
with `macos-tarobot-latest.json`, `windows-tarobot-vX.Y.Z` with
`windows-tarobot-latest.json`, and `android-tarobot-vX.Y.Z`. Never upload the new
ID to the legacy `macos-v`, `windows-v` or `android-v` tags or replace their
assets. Old installed updaters cannot perform the identity transition; offer a
one-time installer with explicit re-pairing instructions instead. Both versions
must ignore the other's release channel. Verify this against the actual old
binary before publishing; source policy tests do not certify that migration.

Keep `bundle.publisher: "tarocub"` as the Windows NSIS installation registry
namespace used by prior releases. This compatibility value does not change the
new application identifier. Test an old custom install directory, interactive
upgrade, normal uninstall, and explicit data reset in Windows before shipping.

On macOS, verify the new signed App and its child Host/engines can access the
owner's required folders, external/network volumes and automation targets;
TCC permission read-back must be checked for the new identity, not inferred
from old App permissions. For Android, explain that keeping both app packages
paired may yield duplicate notifications and a deep-link chooser; remove or
revoke the old client only after the replacement works. Host sessions stay put.


Before packaging changed Host behavior or schema, increment the Host/CLI version
and the accompanying App version relative to the published release. Equal-version
desktop reconciliation intentionally retains the running Host. In particular,
schema-21 source must not be republished as the released schema-20 combination
Host 0.1.445 / App 1.0.97. Verify the migration through the existing-host upgrade
path with the final artifacts, not merely by opening a new test database.

Keep versioned installer links, current App/CLI version mappings and checksums in
the corresponding GitHub Release and its verification document. The English and
Chinese READMEs link to the stable Releases page from the installation guide;
do not restore a Downloads table or update the homepage for each version bump.
Update homepage feature descriptions and product images when the product changes.

For iOS, follow [the iOS build and TestFlight guide](client/ios-build.md). Run the
release-plan tests and ad-hoc-signed Simulator build before a distribution archive/export.
Verify the final IPA (including the share extension), record its digest, and
confirm Apple's processing result. Simulator build success is not physical
iPhone or APNs acceptance; record those separately. Never upload signing keys,
provisioning profiles, account details or local signing logs to the repository.

For desktop renderer changes, verify the final package's `resources/app.asar`
(on Mac, `Contents/Resources/app.asar`). The Host's `host/client/dist` is a
separate served UI and cannot prove the desktop renderer's bytes. Run
`node client/scripts/verify-electron-shell.mjs --resources /extracted/resources --frontend client/dist --version APP_VERSION --commit SOURCE_COMMIT`.
This compares the full frontend inventory and every file, version and source
binding; it remains a packaging check, not native Windows startup acceptance.
The old `verify-windows-shell.mjs` is only for historical Tauri artifacts.

Run `node scripts/verify-windows-runtime.mjs /path/to/extracted-installer` against
the final Windows installer contents. This checks normal and delayed imports of
every EXE/DLL/native addon and rejects unbundled VC++ runtime dependencies. The
standalone prepack gate enforces the same rule for its service launcher. The
launcher build uses static CRT linkage scoped to that executable.

Do not call a release complete based only on a test count or browser preview. Keep `package.json` private; external package-registry publishing is not a release step. Local `npm pack` creates a reviewable archive and does not publish it. Never restart an unrelated service or migrate its data as a side effect of a TaroBot release.

## Installer naming

Use `scripts/release-artifact-names.mjs` as the distribution filename contract.
New packages contain `TaroBird.app`; the DMG volume, Windows default directory
and new shortcuts say TaroBird. Existing installation directories and user data
remain in place. Never reuse a frozen historical release script's TaroBot asset
names for a new release.

After signing Android, stage the exact signed bytes before calculating the
publication checksums; use the same helper for the standalone CLI archive:

```sh
node scripts/release-artifact-names.mjs --kind android --version VERSION --source /private/build/app-signed.apk --output /private/release
node scripts/release-artifact-names.mjs --kind cli --version VERSION --source /private/build/tarobot-VERSION.tgz --output /private/release
```

The helper refuses overwrites and verifies byte identity. The npm package name
and native identities remain compatible. Release review must reject old-brand
installer filenames and inspect the actual DMG App/volume and Windows installer
shortcuts/default directory. Existing published versions are not overwritten.

Android clients through 1.1.1 only discover the old APK filename. The first
TaroBird-only APK release requires a manual download for those existing users;
include that transition in English release notes and verify an in-place upgrade
on a physical device using the retained application ID and signing key. New
clients accept the canonical TaroBird filename and historical TaroBot filenames.
Do not rename an already published asset or silently add an old-brand alias.

## CLI parity and release gate

For every App/host change and release:

- Record whether the CLI is affected. Host features must work with the desktop
  closed; add a CLI entry point where command-line management is needed. Explain
  UI-only exceptions in the change/release notes.
- Share implementation and authorization with the Apps. Check host identity,
  Bot ownership, network join/leave and independent phone membership; do not
  fork their behavior into a separate CLI backend.
- Check all five engines for relevant changes: Codex, Claude, Antigravity, Kimi
  and DeepSeek. Distinguish unsupported provider capabilities from regressions.
- Update CLI help and operator docs. Run relevant CLI/API regressions, the
  standalone build and complete required checks. Verify clean installation and
  upgrade of an existing host, including preserved data and identity.
- Build App-bundled host and standalone CLI from the same source revision for
  host-affecting releases. Record the mapping of App and host/CLI versions,
  protocol/schema compatibility and SHA-256 digests in release notes.
- Publish the matching CLI archive with the release; verify the downloaded
  artifact, not just local output. State any blocked artifact/platform explicitly.
  A commit, rebuilt App or README update alone is not a CLI release.

Desktop/mobile UI and headless operation have different acceptance surfaces.
Unit tests, cross-compilation, native OS service tests and physical-phone delivery
must be reported separately. Do not replace a production host merely to complete
a test without an authorized rollout plan.
