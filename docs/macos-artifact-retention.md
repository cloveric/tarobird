# Unindexed Mac artifacts and guarded retirement

Temporary macOS/iOS Apps belong below a **physical .noindex directory**.
The installed /Applications/TaroBot.app is never a cleanup target.

## Path inventory (2026-10-29, before changes)

| Source | Existing definition | New rule |
| --- | --- | --- |
| Repository storage policy | AGENTS.md: release/test output in taro-tmp | taro-tmp.noindex; Cargo target also .noindex |
| Local release wrappers | release-1.0.119-20261029/{build-env.sh,release-guard.mjs,release_guard.py} fixed taro-tmp and tarobot-release-target | create a fresh workspace with macos-artifact-workspace.mjs; change all guards together |
| Staged/previous Apps | finalize-build.mjs, prepare-activation.mjs in versioned release labs | macos-ready and previous-app inside the new workspace |
| Installation rollback | install-mac-1.0.119-20261029/install.mjs | rollback below the new workspace; keep until final activation acceptance |
| Archive extraction | local verify-final-mac.py, repository macos-signing.mjs and verify-macos-updater.mjs | extraction and mounted verification volumes beneath .noindex |
| Native UI fixtures | side-window-native-build.mjs, image-viewer-native-build.mjs, window-activation-audit.mjs | normalize output and Cargo environment before creating Apps |
| Desktop build/release entrypoints | Electron since 2026-10-30: desktop:dev/build/release and desktop:macos run electron-build.mjs | electron/isolation.mjs requires physical .noindex output, cache and target; each Rust crate builds in target/<kind>.noindex. build-host-launcher.mjs and native-transport-audit.mjs use macos-artifact-paths.mjs |
| iOS Apps | ios-build.mjs: ios/build, DerivedData, xcarchive, IPA verification | build root .noindex |
| GitHub Mac runner | macos-updates.yml | RUNNER_TEMP tarobot-electron-{output,cache,target}.noindex (main's Electron workflow) |
| Old cache | dev-cache/tarocub-macos; referenced by historical shipping-runtime probes | dev-cache/tarocub-macos.noindex for new work; old immutable receipts stay unchanged |
| paint-candidate / Drop Control | no surviving defining script found in scoped repository, task-state and depth-three release-script searches | covered by the same temporary-App rule and identity-restricted legacy discovery |
| Bot guidance | memory registry's release-storage rule still named taro-tmp; no current release-artifact skill | new vendored skill, installed for Codex, Claude and shared .agents consumers; memory correction note |

Historical frozen scripts and receipts are provenance, not reusable configuration.
Do not rewrite their signed-source gates or paths while another Bot may resume them.

## New workspaces

    node scripts/macos-artifact-workspace.mjs --name release-VERSION-UNIQUE
    . /Volumes/gdrive/taro-tmp.noindex/release-VERSION-UNIQUE/build-env.sh

The helper refuses to overwrite a task. It declares macos-ready, previous-app,
rollback, extracted updater, paint-candidate and native-acceptance locations.
Portable builds use a physical .noindex root; the Mac build wrappers enforce
.noindex even for explicit CARGO_TARGET_DIR overrides. build-env.sh also exports
the Electron TAROBOT_DESKTOP_OUTPUT (inside the task), TAROBOT_ELECTRON_CACHE and
TAROBOT_DESKTOP_TARGET, so desktop:macos packages stay below the task root. Symlink-only exclusion
is rejected. Existing shared directories are not silently renamed.

If an atomic installer needs a same-volume stage near /Applications, put the
stage in its own sibling .noindex directory. This change does not replace the
installed App or alter the running Host's TMPDIR.

## Publication and cleanup

publish-macos-update.mjs invokes finalize-macos-artifacts.mjs only after
publishDesktopUpdate has read back the public release ID and every asset digest.
A cleanup failure/defer is reported separately; never republish the release to
retry housekeeping. Manually orchestrated releases must invoke the same final step:

    python3 scripts/cleanup-macos-artifacts.py --keep-version VERSION --receipt CLEANUP.json
    python3 scripts/cleanup-macos-artifacts.py --apply --keep-version VERSION --receipt CLEANUP.json

Default roots include new and known old task/cache directories. Additional roots
must be physical .noindex locations. Discovery never follows symlinks. Only Mac
.app bundles with com.tarobot/com.tarocub identities are eligible; no logs,
source checkouts, credentials, databases, Android artifacts or xcarchives are
retired. The newest numeric-version macos-ready App is retained; publication
requires its own version to have a backup too. Apply verifies the retained App's
signature first.

Cleanup refuses active builds/signing (Cargo/Tauri/Xcode/codesign/notarytool/
hdiutil/ditto and the Electron electron-build/package/macos-artifacts scripts),
serializes cleanup runs, skips recent
parent/task directories and recent files inside bundles, checks active-process
arguments/cwd/open files, and preserves owner-held and unaccepted
activation/rollback tasks.
Before each move it rechecks activity, identity, freshness and backup selection;
if the verified backup was moved or replaced (different inode) the run defers.
Six-hour and in-use skips take precedence over reducing the backup count.
Do not kill another Bot's task to make cleanup proceed.

Each eligible App is moved into a sibling .noindex envelope. /usr/bin/trash
moves that envelope to Trash. If trash fails, the App is restored to its original
location. Atomic receipts checkpoint each successful move and preserve errors;
a failure after some moves must not erase the evidence of those moves.
No rm -rf, empty-Trash, global Spotlight rebuild or Launch Services reset.

For an old installer backup that was already placed in Trash without a system
Trash transition, an in-place .noindex rename may leave its existing index entry.
The opt-in `--legacy-trash-app "$HOME/.Trash/.TaroBot-before-VERSION.app"`
restricts normalization to that exact historical name and verified TaroBot
identity. It checks age/activity, stages by same-volume rename into a .noindex
envelope, calls /usr/bin/trash, then reads back the same inode in Trash. A failed
trash call restores the original location. `--normalize-legacy-trash` enumerates
these names instead; macOS may deny enumeration, in which case use only exact
known indexed paths. Neither mode empties Trash or touches unrelated items.

Create and seal the published version's macos-ready backup before invoking the
publisher. Missing backup means deferred cleanup. The Electron build does not
create it: after notarization/stapling, copy the packaged App with
`ditto "$TAROBOT_DESKTOP_OUTPUT/package.noindex/packages/TaroBot-darwin-arm64/TaroBot.app" "$TAROBOT_RELEASE_LAB/macos-ready/TaroBot.app"`
and run `codesign --verify --deep --strict` on the copy.

A release candidate held by the owner keeps `OWNER-HOLD.json` at its task root.
Any `OWNER-HOLD.json` in an App's ancestor directories (even unreadable, even
above a custom `--root`) skips that App as `owner-hold`; activation receipts above
a custom root are honored too. Remove a hold only after the owner's decision. The Mac publisher also checks
the checkout's default Cargo target, configured artifact root and, when set, the
Electron TAROBOT_DESKTOP_OUTPUT (after the default task roots). Hosted Linux
publication has no local Mac artifacts to retire; the hosted Mac build job uses
.noindex paths and its ephemeral runner is discarded by GitHub.

## Acceptance

Run a packaging/publication rehearsal with a disposable noindex workspace, then:

    mdfind "kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == '*taro*'cd"

An excluded backup need not appear in mdfind. Verify exactly which macos-ready
backup is retained by the cleanup receipt and filesystem read-back. Indexed
legacy backup(s) or a stale Trash record must be reported, not hidden by
filtering the command output. Rehearsal does not publish or install a release.

CLI impact: packaging/operator tooling only; no change to headless Host commands,
identity, schema, state, model adapters or App/Host version.

## Owner-Mac rehearsal, 2026-10-29

- 108 release/signing/publication regression tests, 18 cleanup protection tests,
  four path/finalization tests and six iOS build-plan tests passed. Standalone
  Host build and modified entrypoint syntax checks passed. Publication ordering
  was rehearsed against fixture GitHub responses, including failed read-back.
- A new release workspace was created under taro-tmp.noindex. An existing
  signed 1.0.119 App was packed and extracted with the changed verifier. Its
  four signature targets and bundled Node SQLite/Canvas/JIT/WebAssembly/native
  addon checks passed. This was a packaging rehearsal, not a new release or
  installed-App update; no Cargo/Tauri rebuild or notarization was repeated.
- Five eligible old native/installer Apps completed the system-trash move
  phase. Initial summary writing failed on restricted Trash enumeration;
  source-path absence was reconciled before adding per-item checkpoints.
  The retained 1.0.119 backup, an unaccepted activation task, one recently
  modified installer task, and fresh rehearsal artifacts were preserved.
- The known historical Trash backup was retired through an actual system
  Trash transition and its inode read back. In-place wrapping, targeted
  Launch Services unregister, and scoped mdimport alone did not clear that
  old index entry. No Spotlight privacy setting or global index was changed.
- Final **unfiltered** command output contained exactly:

      /Applications/TaroBot.app
      /Volumes/gdrive/taro-tmp/release-1.0.119-20261029/macos-ready/TaroBot.app

Local evidence: taro-tmp.noindex/macos-artifacts-20261029 contains the workspace,
archive verification, cleanup, recovered first-pass record, system-trash
transition, skill-installation and raw Spotlight receipts. A newly created
backup under .noindex will be retained on disk but should not be searchable.
