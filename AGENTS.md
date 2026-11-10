# Agent Entry

The product is **TaroBird** (`tarobird`). Read
[repository privacy](docs/repository-privacy.md) and
[versioning](docs/versioning.md) before any commit, PR, push or release.

## Canonical repository and releases

The active repository is **cloveric/tarobird**, initially private. The former
`cloveric/tarobot` repository is a private historical archive. All new development
and future releases belong here. Never merge or mirror old history, PR refs,
tags, Actions records or release assets into this repository. Port a reviewed
source patch when an old change is needed.

The migration publishes no Release and installs no App. Releases stay empty
until the owner explicitly requests publication. The first release here contains
only the then-current version; do not import the old release catalog. Write all
future GitHub Release titles and notes in **English**. Continue semantic
versioning; migration does not reset or reuse a released version.

Before the first new release, build with `TAROBOT_GITHUB_REPOSITORY=cloveric/tarobird`
and verify updater OAuth access and downloaded signatures for this repository.
Existing binaries still use the historical update endpoint. Preserve their old
downloads and verify a one-time upgrade path without changing App identities,
signing keys, saved Host data or credentials. See
[repository migration](docs/repository-migration.md).

## Mandatory GitHub upload gate

Every push to `main` **and every PR branch/update**, including merges and
documentation-only changes, must pass a fresh privacy scan of the exact outgoing
commits. Do this **before upload**; GitHub Actions is a second check, not permission
to upload first. No `--no-verify`, disabled hooks, broad allowlists or skipped
checks to make a push work. A missing tool, incomplete/shallow history, failed
scan or unavailable evidence blocks that upload.

- Configure this checkout's GitHub noreply identity and run `npm run privacy:setup`.
  Verify with `node scripts/setup-privacy-hooks.mjs --check`; cloning does not
  copy hook settings. Preserve and review existing hooks before changing them.
- Run `npm run privacy:staged` before committing. The pre-push hook scans the
  actual outgoing range, author/committer and tag identities, intermediate
  blobs, personal paths/hostnames/emails/IPs, media review records, full-history
  Gitleaks and retired ancestry. Run `npm run version:check` as well.
- Review **PR/issue titles, bodies, comments, commit messages, screenshots,
  recordings, logs, attachments, Actions artifacts and release assets** before
  uploading. They are not all Git files. Scan publication text with
  `check-upload-privacy.mjs text` and Gitleaks; CI also scans PR title/body.
  Never paste raw scanner output or private evidence into GitHub.
- Screenshots require visual inspection (and OCR where practical); remove real
  device/account names, chats, addresses, tokens, QR pairing data and home paths.
  Record only the reviewed file path, SHA-256, reviewer and review method in
  `.privacy-reviewed-media.json`. A byte change requires new review. This record
  is evidence of review, not an automatic privacy detector or directory waiver.
- Unpack release installers/archives and inspect their contents, metadata and
  binary strings, including UTF-16 and compiled Rust source paths. Use build
  path remapping; do not ship developer home directories. Recheck the exact
  signed/uploaded bytes. A clean source scan does not certify a binary.
- Use synthetic examples and public noreply identities. Keep owner reports,
  raw mirrors, service configs, credentials, signing material and private scan
  output outside Git. Never copy the private audit report into this repository.
- Record exact source SHA, scan range, tool version, result and evidence boundary.
  CI blocked by billing is **not run**, not pass. Run local gates before an
  authorized push; report the remote blocker. Do not change billing/visibility.

The November 2026 audit of the former repository found screenshot,
commit-metadata, old PR/ref, Actions and binary-path residue. New gates and this
authorized fresh-snapshot migration do **not** erase that archived content. Do
not claim complete historical cleanup, close that work or rewrite history beyond
the separate approved remediation scope.

Before modifying this repository, read [docs/entrypoint-map.md](docs/entrypoint-map.md).

That file is the source of truth for:
- App/Gateway and headless CLI entry flows
- retired transport boundaries and current App compatibility readers
- bus flow
- state/config ownership
- shared usage/budget/audit logic
- required regression tests by change area

If you change behavior rather than comments/docs, prefer focused tests first, then `npm run build`.

## Storage on the owner's Mac

Use the mounted `/Volumes/gdrive` disk for project checkouts, release installers,
build caches and temporary verification artifacts. Put checkouts in `projects`,
caches in `dev-cache`, and release/test output in `taro-tmp.noindex`. Every
temporary `.app` (including rollback/acceptance copies and extracted archives)
must live below a physical `.noindex` directory. Use a `.noindex`
`CARGO_TARGET_DIR`, such as `dev-cache/tarobot-release-target.noindex`, and the
Electron `.noindex` output/cache/target roots exported by the artifact workspace.
Follow [artifact retention](docs/macos-artifact-retention.md) and the
[release artifact skill](skills/tarobot-release-artifacts/SKILL.md). Preserve the
installed App and active/recent task directories; retire eligible old Apps only
with the guarded `/usr/bin/trash` helper after publication. Check mount access
before a large build; do not silently fall back to large directories on the
internal disk. Keep installed applications and active host state in their
supported locations. A small local installation staging directory is acceptable
when required for an atomic App replacement; retire it after verified installation.
When relocating existing task files, preserve uncommitted work, check active
processes, verify copied bytes and links, and retain path compatibility where needed.

## Desktop, mobile and CLI evolve together

TaroBot's headless CLI is a first-class entry point to the same host core as the
desktop and mobile Apps. For every feature or behavior change, assess the CLI
impact before implementation. Host capabilities (Bots, conversations, files,
collaboration, scheduled work, permissions, pairing, network membership and
operations) must remain usable without launching the desktop App. Add or update
the relevant CLI command, help and documentation when the capability needs a
command-line entry point; do not create a separate, reduced host implementation.
Pure presentation changes may be CLI-not-applicable, but state that reason in
the change/release notes rather than silently omitting the CLI.

Use shared APIs and business rules. Preserve the same canonical host identity,
state, permission checks and private-network semantics across entry points;
hosts retain their Bots, and phones retain independent membership. Cover Codex,
Claude, Antigravity, Kimi and DeepSeek according to each adapter's capabilities.

For a host-affecting release, build, test and publish the corresponding standalone
CLI package from the same source revision as the App's bundled host. Record the
App version, host/CLI version, supported protocol/schema range and artifact
checksums. Verify both a clean CLI installation and an existing-host upgrade;
source changes or App installers alone do not update the published CLI package.
If one artifact or platform is blocked, report it explicitly. Follow
[the release checklist](docs/release-checklist.md) and
[the CLI architecture map](docs/entrypoint-map.md#headless-host-cli).

GitHub checkpoint rule: after each coherent requested change is implemented and
validated, commit the intended project changes directly on `main`, or merge a
completed working branch into local `main`, then push `main` before reporting
completion. Do not create pull requests unless the user explicitly asks for one.
Integrate dependent changes in order, preserve unrelated uncommitted work, and
sync with remote `main` without force-pushing. Verify that remote `main` contains
the intended commits and report the commit link; do not leave completed work
only locally or on a development branch. Investigate failing checks and report
unresolved verification or infrastructure blockers accurately; never claim
checks passed when they did not run. Documentation-only workflow changes do not
require a new App release.

Release rule: publish or update an installed App only when the owner explicitly
requests a release/update. Routine fixes, audits, commits and pushes do not imply
release authorization. If the owner says to wait for a new release request, hold
any previously prepared publication/installation and preserve its receipts.
Follow `docs/release-checklist.md`. The retired Telegram/Lark adapters are not part of this repository. Do not
restart old fleets or migrate their data as part of an App/CLI release. Do not publish to an external package registry as a release side effect.

For an explicitly owner-authorized scoped patch, follow the reduced validation
profile in [the release checklist](docs/release-checklist.md#scoped-patch-releases).
It may retain unchanged dependencies and baseline evidence for unaffected code;
new artifact signatures, privacy scans and download readback are never inherited.
For other releases, check upstream updates for all integrated open-source
projects, including Excalidraw (whiteboard), Vditor (Markdown), baoyu-design
(Baoyu Design and Baoyu PPT), and future integrations. Include upstream SKILL.md,
references and helper scripts, not only editor/npm versions. Keep adapted skill
routing and protocols aligned with the corresponding pinned editor, validate
resource installation and test explicit Baoyu selection without intercepting
ordinary PPT/design requests. If an update exists, upgrade the integration,
resolve compatibility issues and pass the relevant regression/build checks
before publishing. Record current/upstream versions or commits, check date,
source links and validation in the release evidence; update lockfiles, vendored
hashes and license notices as applicable. Follow the upstream update gate in
`docs/release-checklist.md`; an unavailable check or an unverified upgrade blocks
release and must be reported, not silently skipped.

Stable App transport rules are host-owned in `src/gateway/agent-instructions.ts`.
Per-Bot persona/preferences remain user-owned; do not write transport rules or
turn-scoped paths into resumed project `AGENTS.md` / `CLAUDE.md`.
See [adapter retirement and retained regression coverage](docs/adapter-retirement-2026-10-21.md).

## Platform-specific visual sizing

iPhone has a different perceived visual size from the established Android and
desktop interfaces. Equal CSS values do not imply an equally readable or
balanced result across these platforms. Evaluate iPhone, Android and desktop
separately against their own accepted appearance; do not use iPhone feedback
as a reason to resize every platform.

Keep platform-specific adjustments explicitly scoped to the requested platform.
Preserve the accepted Android and desktop appearance when improving iPhone
readability, unless the owner also requests changes to those platforms. Check
shared-token consumers, settings previews and narrow desktop windows as well as
the main list: they must not inherit an unintended iPhone adjustment. Record
these principles here, not fixed pixel sizes; current geometry belongs in the
implementation and its regression coverage.

Preserve explicit saved density choices and the separate chat reading-size
setting. Keep CSS tokens, actual Avatar/group-collage sizes and the settings
preview consistent. The platform attribute is set by `client/src/appearance.ts`;
geometry lives in `client/src/layout-density.css` and `layout-density.ts`.
Check iPhone, Android and desktop/browser branches with
`client/e2e/layout-density.spec.ts` when changing these sizes; browser checks do
not establish physical-device acceptance.
See [the sizing decision and verification](docs/client/phone-inbox-composer-2026-10-23.md)
for the implementation history and platform-boundary corrections.

An iPhone window can change size while the App remains active, including across
the phone/sidebar layout boundary. Do not infer a desktop input device from
window width or reserve keyboard space using the physical screen height.
Use the current window and its asymmetric safe areas; preserve the active
conversation, draft, attachments and pending-send choice through a resize.
Verify touch controls and native pickers in both compact and expanded iOS
layouts. Simulator/browser evidence must stay distinct from physical-device
acceptance. See [adaptive iPhone coverage](docs/client/iphone-duo-2026-10-25.md).

Duo-specific adjustments must preserve ordinary iPhone behavior in both
portrait and landscape. An iPhone user agent or a wide window alone does not
identify an expanded display. Scope expanded-only layout and keyboard changes
to the current unoccluded window geometry, and withdraw them on folding or
window resizing. Cover ordinary phones, cover displays and expanded windows
separately in regressions; keep shared iOS changes intentional and explicit.

## Product naming

New shared App/CLI code, prompts, environment variables and workspace artifacts
must use TaroBird or neutral names. Put shared implementation outside optional
transport directories. Keep Lark/Telegram names only for genuine integrations or
explicitly documented compatibility boundaries; never mass-rewrite persisted
session/routing identifiers. Read [docs/neutral-naming.md](docs/neutral-naming.md)
before changing historical names and cover old-state read/new-state write behavior.

TaroBird display copy is separate from compatibility identifiers: retain current
App IDs, credentials/keychain services, stored paths, deep links, updater URLs,
release-channel tags and old `tarobot` CLI commands until an explicit migration
is implemented and tested. The `tarobird` CLI alias uses the same host.

New installers, App bundle names and default installation directories use
**TaroBird**, including `TaroBird.app` and new Windows shortcuts. Do not retain
TaroBot filenames as a compatibility shortcut. Use
`scripts/release-artifact-names.mjs` for the distribution filenames. Existing
install locations, data directories and Bot workspaces remain unchanged under
the owner's current scope; do not move them as a branding side effect.

## Product version rule

`release-version.json` is the single source of truth. Starting with the next
TaroBird line, App and bundled/standalone CLI use the same `MAJOR.MINOR.PATCH`.
Breaking compatibility increments MAJOR; compatible features increment MINOR;
fixes increment PATCH. Use `npm run version:bump -- patch|minor|major`, then
`npm run version:check`; never independently increment platform/package files.
Platform upload build counters are separate, monotonic, and never reused for
different bytes. Protocol/schema versions and internal helper-crate versions
are separate contracts. A version edit is not release authorization.
