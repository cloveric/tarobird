# TaroBot Mac 1.0.85 / host CLI 0.1.433

Mac users can now sign in to GitHub from Settings → Application updates, check
for a release, download and install its signed archive, then restart the App.
Installation waits for active work and unanswered question cards, pauses only
the App-owned local Hub, preserves its identity and data, and confirms host
recovery before reporting success. Older DMG-only versions need one bootstrap
upgrade before they gain this update path.

## Release and compatibility

- [Mac release and SHA-256 checksums](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.85).
- Executable source: [de9f454](https://github.com/cloveric/tarobot/commit/de9f454768802e97ba67a40a6d1e51312c8bc8ab).
- Mac App **1.0.85**, Apple Silicon; bundled host and standalone CLI **0.1.433**, from the same source revision.
- Windows and Android downloads remain **1.0.84**; this release does not claim new builds or device acceptance for those platforms.
- Protocol **1**, network membership **2**, Hub schema **17**, supported input schemas **1–17**.
- Bundled Node **24.14.0**; standalone CLI needs Node 20.17+ (official Node 24 recommended).
- Mac bundle is ad-hoc sealed, not Apple-notarized. Updater archive signing is a separate pinned-key check, not Developer ID signing.

The CLI includes the shared host lifecycle and matching web client. The private
`desktop-update` helper coordinates native replacement; normal CLI-managed
services retain their existing update path and are not stopped by an App update.
No new public CLI command or package-registry publication is introduced.

## Changes

The private GitHub provider now selects a separate Mac channel and signed
`.app.tar.gz` artifacts. A DMG is never selected as an updater archive. Native
OAuth credentials stay in the OS Keychain; expiring tokens and refresh rotation
are supported. The repository remains private, with no embedded access token.
GitHub's actual `repo` scope is broader than the updater's read-only requests;
the first sign-in requires the user's GitHub authorization.

The update dialog displays downloading, waiting, replacing and host recovery.
Waiting can be canceled. Active tasks are not killed, and questions are not
answered by installation. A stopped host remains stopped. A sealed same-volume
App backup allows known installation failures to restore the old bundle before
resuming the host. Databases are not rolled back over possibly migrated data.

Build and publication now produce and verify the bootstrap DMG, signed updater
archive, manifest, signature, matching CLI and checksums. The publisher binds
assets to one numeric draft-release ID and source commit, verifies the complete
set before publication, and reads the published assets back. The generic latest
release pointer and other platform channels are unchanged.

See [Mac updater design and operating details](macos-github-updates.md).

## Verification

The sanitized [verification receipt](evidence/release-1.0.85-2026-10-17.json)
records artifact sizes and hashes. Published assets were downloaded again;
checksums, updater signature and signed version all passed verification.

| Surface | Result | Boundary |
| --- | --- | --- |
| Full source gate | **316 files, 4,174 passed / 1 Windows-only skipped**; build passed | Two workers, original assertions and timeouts |
| Client | Translation, TypeScript and Vite build passed | Build verification |
| Update browser tests | **16 passed** | Rendered confirmation/progress, cancellation, login/logout/expiry fixtures; not production OAuth |
| Native Rust | **63 passed** | Policy, credential rotation, restoration and existing native regressions |
| Native isolated installer | Tampered archive rejected; signed archive installed by the real Tauri macOS installer; App bundle replaced; bundled Hub stopped and resumed | External-disk App copy and synthetic host state; identity, pairing, chat and file retained |
| Final DMG | Read-only mount, deep/strict bundle seal, icons, versions, OAuth client ID, pinned update key and exact host helper verified | Ad-hoc signing; no notarization or full production GUI update acceptance |
| CLI clean install | Production install, transitive dependency audit, pack, extraction, clean install and startup passed | No OS service installation or external registry publication |
| CLI upgrade | **0.1.432 → 0.1.433**; identity, controller, network and workspace retained; upgraded host started | Disposable state on external disk |
| GitHub release | Complete asset set published, downloaded and verified | Publication is not installation |

The initial unrestricted source run hit four timing failures in two files.
Those files passed all 55 focused tests unchanged; the complete gate then passed
with two workers. No assertions or timeouts were relaxed.

The native installer fixture starts from a copy of the updater-enabled bootstrap
build. It is not a previously shipped DMG-only release completing a GUI update.
Production GitHub OAuth authorization has not been performed. The old production
Mac requires the one-time bootstrap, prepared to wait for this active Bot turn
before switching; its later activation receipt is separate from release evidence.

Cloud [Source checks run 38992518334](https://github.com/cloveric/tarobot/actions/runs/38992518334)
did **not start**: GitHub reports failed account payments or a spending limit
that needs increasing. The new Mac workflow has not run in GitHub Actions;
local build/test/publication results are not cloud CI success.

## Remaining acceptance boundaries

First GitHub sign-in and a subsequent production GUI update still need live
acceptance. Keychain/Gatekeeper prompts require normal macOS authorization.
A sudden process or power failure during bundle replacement can require manual
recovery from the retained App backup; this release does not promise
transactional recovery across power loss. No Windows, physical-phone or Apple
notarization result is inferred from these Mac checks.
