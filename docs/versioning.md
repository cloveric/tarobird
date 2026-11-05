# TaroBird version policy

`release-version.json` owns the product version and platform build counters.
The first unified product line is **1.1.0**. It is newer than the released
App 1.0.130 and CLI 0.1.475; neither old release is renamed or overwritten.
This change does not publish a release or install an App.

| Change | Increment | Example |
| --- | --- | --- |
| Fixes, compatible reliability/security/UI corrections | PATCH | 1.1.0 → 1.1.1 |
| Compatible new functionality or product-wide rebranding | MINOR | 1.1.2 → 1.2.0 |
| Incompatible public CLI, persisted-data or protocol contract requiring migration | MAJOR | 1.4.3 → 2.0.0 |

Choose the largest applicable increment for a release. Commits, PRs and build
retries do not each get a new product version. Do not reset to 1.0.0 on rename,
reuse a published version for new bytes, or use dates as semantic versions.

## One version across distributions

Mac, Windows, Android, iOS, the bundled Host and standalone CLI share the product
version and source commit. `scripts/release-version.mjs` synchronizes root/client
package manifests and locks, the native App manifest/Cargo package and lock,
Android defaults, and all iOS App/share-extension build configurations.
The pre-commit/pre-push and GitHub privacy workflow reject drift.

```sh
npm run version:check
npm run version:bump -- patch
# For a deliberate manifest/build-counter edit:
npm run version:sync
```

The manifest `status` is `development`, `rc` or `stable`; it describes intended
source maturity, not verified publication. Native stores receive the numeric
product version; preview/RC status belongs in the GitHub prerelease flag and
release notes. Do not publish an RC to the stable updater manifest. Version
bumping resets the iOS build to 1 for the new marketing version and increments
the Android code. A rebuilt upload of the same marketing version increments its
platform build counter before packaging. Android's code must always exceed
the previous store build and remain ≤ 2100000000; its retained initial value
continues the old counter and is no longer interpreted as a date.

After any upload, record product version, platform counter, source SHA, channel,
artifact digest, signing/readback results and acceptance scope. Never replace
a released asset with different bytes under the same version. If a published
GitHub binary needs a fix, increment PATCH. Store-only re-uploads require a new
build counter and a recorded reason; they cannot silently diverge from the
corresponding source/product version.

Internal non-distributed helper crate package versions (currently 0.1.0),
database schema numbers, tool-schema versions, capability versions and upstream
dependency versions are not product versions. Advance their own contracts only
when required. The release manifest still binds their packaged bytes/source.

## Existing update clients remain compatible

Publish future releases only to `cloveric/tarobird`, with English titles and
release notes. The clean repository migration publishes no release and imports
no historical tags or assets. Retain the current platform tag prefixes, such
as `macos-tarobot-v1.2.0`, `windows-tarobot-v1.2.0`,
`android-tarobot-v1.2.0` and CLI `v1.2.0`; these carry the **same** version.
New distribution filenames come from `scripts/release-artifact-names.mjs` and
use TaroBird. Compatibility update-manifest names retain their current spelling.

The owner has accepted the running Windows version and requested formal releases
from 1.2.0 onward. Publish Windows with `prerelease: false`, like macOS and Android.
Do not turn a missing test into a passing receipt: record new-installer, upgrade,
custom-path, uninstall and automatic-update validation separately. Historical
manual previews keep their existing tags and prerelease flags. Existing old tags remain as
historical records in the old archive. Existing installed clients still use that
archive's update endpoint; the first release from this repository must document
and verify its one-time upgrade path. See [repository migration](repository-migration.md).

Publishing still requires the owner's explicit release instruction and the
[release checklist](release-checklist.md). Source tests and a synchronized
manifest are not signed-package, store-processing or installed-device acceptance.
