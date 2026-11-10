# Private GitHub updates on Windows

The `com.tarobot.client` identity uses a separate `*-tarobot-v` channel. Legacy
`com.tarocub.client` installations keep their old channel and require a one-time
installer transition; never replace old release assets with new-ID packages.
See [the transition checklist](../release-checklist.md).

## User flow

Install a Windows build made with `--signed-updates` once. Existing installers
without a pinned key/GitHub provider cannot acquire that trust configuration
through an update they do not yet support. After the bootstrap installation:

1. Open Settings → Application updates → Sign in to GitHub.
2. Enter the displayed device code on GitHub and approve repository access.
3. Use Check for updates, review the version, and choose Download and install.
   Discovery runs on startup and daily; installation always needs confirmation.
4. The current-user Windows installer runs in passive update mode and restarts
   the App. Existing `/UPDATE`/passive installer guards preserve configuration,
   paired devices, host state and chat history; this is not a fresh-start reset.

Both source and installer releases remain private. Credentials stay in the OS
credential store under the configured repository/client ID. The renderer only
receives the user code, account name, and opaque update offer IDs. Signing out
removes the local credential and invalidates pending login/update operations;
it does not revoke the OAuth application's grant on GitHub or change host/device
membership. Accounts must have access to the private update repository.

## One-time maintainer setup

Create a GitHub OAuth App with device flow enabled and record its client ID.
Device flow uses GitHub's `repo` OAuth scope for private repository access; the
update implementation only reads releases/assets and never writes repository
contents. The client ID is public configuration; no OAuth client secret is shipped.
GitHub authentication is separate from the maintainer's updater signing key.

Generate and retain a Tauri updater signing key outside the checkout, using the
installed Tauri CLI's `signer generate` command. Keep the same signing identity
for future releases: installed clients pin its public key. No signing key or
GitHub OAuth App is created by this PR.

Configure these repository Actions settings:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `TAROBOT_GITHUB_CLIENT_ID` | Device-flow-enabled OAuth App client ID |
| Variable | `TAROBOT_UPDATE_PUBLIC_KEY` | Complete base64 Tauri public-key file contents |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Tauri private signing-key contents |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Signing-key password, if encrypted |

The workflow supplies `TAROBOT_GITHUB_REPOSITORY` from its own private repository.
For local builds set it to `owner/private-repository`. Signing secrets are passed
only to the configuration check/build, never written into the App config.
Generated config embeds the public key, repository and client ID, enforces signed
versions/no downgrades, and selects passive Windows installation.

## Build and publication

The Windows installer workflow has two explicit switches, both off by default:

- `signed_updates=true`: build/verify the signed installer and upload it as a
  private Actions artifact. Existing packaged-host, extracted-installer and
  native regression gates still run before staging the signed artifact.
- `publish_update=true`: additionally run the `windows-updates` environment job
  after the build passes. Configure environment protection/review rules before
  production use. Publication also requires `signed_updates=true`.

Local build command after configuring the environment:

```powershell
npm run desktop:windows --prefix client -- --arch x64 --signed-updates
```

The publication helper verifies the installer/signature with the pinned key and
its signed version before any upload. It checks repository privacy, creates a
draft `windows-tarobot-v<version>` release targeting the built source commit, then binds
every upload/read/publish to that release's returned numeric ID. Pending draft
tags are not used as release identities.

The installer is uploaded first so its private GitHub asset API ID is known.
`windows-tarobot-latest.json` advertises that authenticated API URL and the literal Tauri
signature. Installer, signature, manifest and checksums must all match GitHub's
size/SHA-256 before publication. Existing assets are never overwritten. Failures
before publication leave a draft for inspection; an ambiguous final response
requires checking the release state before retrying. The generic latest-release
pointer is not changed.

Only the publication job has a write-scoped `GITHUB_TOKEN`; it is not embedded
in the App. End-user login uses a separate user token held natively. The updater
currently searches the most recent 100 releases for a stable, non-draft
`windows-tarobot-v<version>` containing `windows-tarobot-latest.json`; unrelated mobile/macOS and
candidate releases are ignored.

The Tauri signing CLI binds each signature to the App version. Reusing an older
signed artifact under a higher manifest version is rejected. The JSON itself is
not a signed envelope; immutable asset IDs, TLS, release membership checks and
the artifact's signed-version binding protect acceptance.

## Verification and remaining acceptance

Checks cover real Tauri signer fixtures, byte/key/comment/version tampering,
private API URL policy, numeric draft identity, uploaded digests, missing build
configuration, login timing/cancellation/account changes, offer invalidation,
UI install confirmation and the existing public updater. Native policy/lifecycle
tests compile and run without real credential writes.

Local results: 83 focused build/signature/publication/checklist tests passed;
52 native tests and a native compile check passed; 10 isolated policy tests passed;
14 updater checks passed (three Chromium UI and eleven controller/backend cases).
Root standalone and client translation/type/production builds passed. Native/UI
and release/build changes received separate reviews; reported defects were fixed
and their regressions passed.

The repository-wide Windows suite is not green: a bounded full-suite run stops
at the unchanged Kimi ACP directory-symlink fixture with `EPERM`. No OS security
settings or unrelated tests were changed to bypass that environment restriction.

Full native GNU tests/checks use temporary
`TAURI_CONFIG={"bundle":{"resources":null}}` only to omit the unavailable staged
host resource mapping in the test build. This is not a packaging configuration.
Native metadata reads are bounded. The upstream updater re-fetches/buffers its
manifest internally; download cancellation aborts at the next async yield, so
byte limits are acceptance checks rather than a hard allocator cap. Final length,
signature, generation and account checks gate installation.

This source PR does not configure production OAuth/signing credentials, perform
a live login, publish a release or install an update. Before production, exercise
a rebuilt bootstrap and an actual newer signed private release with GitHub login,
upgrade/restart, retained host/device/network identity and history. Follow the
normal release checklist and include the prerequisite Windows startup fixes.

References: [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow),
[Tauri updater](https://v2.tauri.app/plugin/updater/).

## Public repository: no GitHub sign-in (2026-11-07)

`cloveric/tarobird` is public, so signed builds now write
`"public": true` into `plugins.github-updates` (a private fork sets
`TAROBOT_GITHUB_PRIVATE=true` to keep the sign-in flow). With that flag the
native updater:

- reports `public: true` from `info` without reading the OS credential store;
- lists releases, reads the manifest and downloads the installer without an
  `Authorization` header (anonymous 401/403/404, e.g. rate limiting, surface as
  a network error rather than an account problem);
- still selects only non-draft, non-prerelease `<platform>-tarobot-v*` releases
  that carry the platform manifest, and still verifies the pinned update key
  before anything is replaced.

Settings → Application updates then shows only Check for updates / Download and
install; the GitHub account controls are hidden. Installed builds without the
flag (1.2.1 and earlier) keep their existing flow: sign in once, or install the
next release manually, to reach a build that no longer asks.
