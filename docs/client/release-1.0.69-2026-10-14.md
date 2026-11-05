# TaroBot 1.0.69 / host and CLI 0.1.422

[Mac and Windows release](https://github.com/cloveric/tarobot/releases/tag/v0.1.422-test.1)
· [Standalone CLI](https://github.com/cloveric/tarobot/releases/tag/cli-v0.1.422)

Mac Apple Silicon and Windows x64 bundle the same host 0.1.422 source as the
standalone CLI. Client wire protocol is **1**; private-network capability is
`private-network.v2`. Packages support Hub schema **1–15** and write schema **15**.
An older schema-14 package cannot be rolled back onto a migrated schema-15 host
without a compatible state restore. Follow the [update guide](../host-cli-update.md).

## Included work

- Pending prompt reorder, edit and cancellation in the shared host queue, with
  engine-specific capability checks; active work remains separate.
- Pairing by shared connection information, whole-screenshot recognition,
  remote confirmation on an already paired phone, and clearer device/host names.
- Context isolation and Claude background-progress handling, including suppressing
  empty or expired Monitor notifications that previously appeared as task completion.
- Current conversation/group ordering, native run presentation and theme fixes.
- [Native run update scheduling](run-update-latency-2026-10-14.md): local controller
  consecutive-update delay measured about 550 ms before and 100 ms after. This is
  not a measurement of model generation or phone/VPS end-to-end response time.

Host changes apply equally to headless CLI operation; the core, identity,
permissions and private-network model remain shared. UI improvements use the
same client bundle served by the headless host. Production Bots were not stopped
or restarted for this release.

## Verified artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TaroBot-1.0.69-macos-arm64.dmg` | 127,227,739 | `c6fe3c68162fcce5a0a7169077ff7760ca50b6f1d1369150136112b9bb9d40bf` |
| `TaroBot-1.0.69-windows-x64-setup.exe` | 95,185,934 | `07b0174b96ad948589b2d8070e541825600067fd224cc8080a1c15fccc4e0fd7` |
| `tarobot-0.1.422.tgz` | 24,584,877 | `55603c147f87ddc077896ef55e27c5438d3311ba3a311048ada936445f920367` |

- Final full local gate: 271 test files; **3,564 passed, one skipped**. Standalone
  graph build and clean client install/translation/TypeScript/production build passed.
- Client npm audit reports three moderate findings along Mammoth's command-line
  `argparse` → `sprintf-js` dependency chain. The observed import is in Mammoth's
  CLI executable, not its library sources. npm's proposed automatic fix downgrades
  Mammoth to 0.3.29; that incompatible downgrade was not applied. The standalone
  production dependency installation reports zero known vulnerabilities.
- Independent CLI directory and archive-extracted installations passed launcher,
  dependency, isolated Hub startup and served-client checks without the Feishu SDK.
- Actual published 0.1.421 package upgraded to the extracted 0.1.422 package in
  disposable state. The upgraded host started; host/controller identities, name,
  signed network identity and workspace bytes were retained. This check did not
  install an OS service or exercise an old-version rollback after schema migration.
- Mac DMG integrity, read-only mounting, deep strict bundle signature and packaged
  icon/version checks passed. All 4,887 App files match the sealed input; 723
  standalone runtime/client/helper files match the independent CLI archive.
  Its own bundled Node passed native process arguments, private pipes, signed
  device enrollment, authenticated messaging, Bot creation, synthetic engine reply,
  restart and name/identity retention in disposable state. This is a synthetic CLI
  round trip, not live acceptance of all five model providers.
- Windows full desktop cross-build and NSIS packaging passed using the internal
  toolchain. Installer extraction succeeded; all 4,884 bundled host files match
  the prepared input. Desktop, Node, launcher and native addons are Windows x64 PE.
  Mac/Windows runtime target gates each passed four isolated native audit tests.
- Release assets carry SHA256SUMS.txt; fresh downloads must match these digests.

## Open acceptance and blockers

Android remains on the previous **1.0.67** installer. Source version 1.0.69 /
2026101403 is prepared, but the original signer and Android tools on the external
volume remain inaccessible pending macOS authorization. No alternate signer or
uninstall/data-reset workaround was used.

Firebase's notification project and Android app exist and FCM HTTP v1 is enabled.
The downloaded Android configuration is not yet available to this build process;
the production host sender configuration and real phone registration/delivery are
not complete. Lock-screen/background push is **not verified or advertised as fixed**.

Mac uses an ad-hoc seal, not Developer ID or Apple notarization. Windows is
unsigned and cross-compiled; **native Windows install/run acceptance is pending**.
Installed-Mac upgrade/Keychain behavior, real mobile operation and production VPS
round trips were not revalidated. The running production App was not replaced.
GitHub hosted checks remain blocked before execution by account billing/spending
limits; local results are not a claim of successful GitHub CI.
