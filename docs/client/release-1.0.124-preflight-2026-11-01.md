# 1.0.124 release preflight (2026-11-01)

Candidate App **1.0.124**, Host/standalone CLI **0.1.469**, protocol **1**, Hub schemas **1–22**. Source starts from the completed audit checkpoint `cbf9b15d5d5dedae6025cf3d3da0fc17a0d4e68e`. The owner authorized publication after review; this request does not replace or restart the installed Mac App. Windows actual runtime acceptance remains owner-deferred and its publication remains held.

## Changes carried into this release

The [post-1.0.123 audit](post-1.0.123-audit-2026-11-01.md) and [DeepSeek follow-up audit](deepseek-followup-audit-2026-11-01.md) record the repairs, rejected proposals, source/runtime distinctions and remaining limits. This includes Workbench file management and persistence, Design routing, browser extension lifecycle and optional compatibility mode, Agent Bus queue/authorization/controls, remote-screen lifecycle, native visibility/geometry and OAuth cancellation. UI-only repairs do not introduce a separate CLI backend; Host-affecting fixes share the canonical App/CLI core.

## Upstream gate

[Official inventory and dependency audit](release-1.0.124-dependency-inventory.md) covers every integrated editor/font project and all 68 direct manifest entries. Excalidraw0.18.1, Vditor4.0.1 and bundled fonts remain current under their recorded stable/pinned policies. baoyu-design is upgraded from2.4.1 to2.5.0, commit `8398e52f3c58ab12e080e8579de66dcb02ea384a` (annotated tag object `645ddc5d22ccf3b7081648cf80b4e35dc9f7c424`).

Actual Claude Opus5.5 independently compared the prior/new archives, all vendor hashes, changed bridge/app tokens, exact adapter anchors, licence bytes and retained failure traces. It accepted the three renamed adapter anchors without changing save/flush, CAS, targeting or permissions. Its proposed omission of unused `editor/share-ui.js` is adopted: 26 exact upstream files remain. LAN sharing, roles and the Share button from upstream's standalone server are not integrated.

The repository-root 26-file sandbox probe builds with guarded single-match adaptation; its probe-only SHA-256 is `415b8a062c83a971bf9cb29f57120723a9bc72260f4a2d735aadc8924224757e`, 16,120,656 bytes. This is not the shipped HTML hash: production package hashes and the four source-comment-only platform differences are recorded in [final release verification](../releases/1.0.124-verification.md#design-html-byte-identity). Full LICENSE/NOTICE are unchanged and remain shipped with their existing mixed-licence exclusions; the prior owner decision does not establish additional rights.

## Test environment and retained failures

Fresh independent root/client dependencies were installed. Root build and client production/translation build passed. Full Electron module suite327 and artifact-path checks8 passed. Native core62 passed/2 explicitly ignored credential-fixture cases, addon33, updater71, legacy104 passed. Legacy initially lacked its generated `host/` resource; preparing the real Host bundle resolved compilation, without changing product code. The large TLS-stream test is actual isolated loopback transport, not production remote-screen acceptance.

The artifact-path negative fixture previously put its supposedly indexed symlink destination below the inherited physical `.noindex` temporary root. It now finds a genuinely indexed ancestor, still creating only empty directories and a symlink, then removes its owned fixture. All eight checks pass with the release TMPDIR; protection assertions are unchanged.

Initial Chromium Design run11/14 passed; three load/total-budget timeouts were retained with traces. The same three tests passed unchanged in a focused rerun: dual-conversation isolation78s, manual edit/save/reopen/export/import54.2s, phone27.0s. No timeout or assertion was relaxed. Trace/source review found no new ready/session/preview protocol or page error; these measurements were made while other suites ran and are not an idle-performance claim. The final 26-file build and quiet runs, full logic-suite retries, packaged-runtime checks and publication receipts must be recorded separately before claiming release completion.

At this preflight checkpoint full Vitest and remaining final-editor tests are still running. The full run has bus/Host-update/group-discussion timeout failures pending isolated diagnosis. This document does not count them as passed or authorize skipping a gate. Release verification must report original failures and resolved retakes accurately.

## Publication boundaries

Final gates include clean/extracted CLI install and retained-state upgrade, paired-client real-engine journeys, signed/notarized Mac and final bundled Node model acceptance, Android signer/native checks, iOS simulator/signed IPA/Apple processing/internal-group read-back, Windows cross-build with runtime hold, and downloaded asset/source/digest checks. Temporary Apps remain in physical `.noindex` storage. Only guarded old-artifact retirement through `/usr/bin/trash` is allowed; installed App and active/recent Bot work remain protected.

No physical iPhone/Android, Windows runtime, real external-network capture/control or Google embedded-login success is inferred from browser, simulator or unit checks. GitHub CI for the audit checkpoint is actually green; historical billing failures do not describe the current run.

## Final publication read-back

The final frozen source is `26b62d57586a0214ca965ac547de799410ef5d5a`. Mac/CLI and Android were published and all assets downloaded and matched. iOS 1.0.124 (1) reached Apple `VALID` / `IN_BETA_TESTING` in the existing internal group, with Chinese and English notes read back. [Final verification](../releases/1.0.124-verification.md) records complete tests, original failures and unchanged retakes, exact production hashes, retention results and platform limits. Windows publication remains held; this release did not replace the installed Mac App. The pending statements above describe the earlier preflight checkpoint.

The owner later separately authorized the local Mac update; [installed Mac acceptance](../releases/1.0.124-verification.md#installed-mac-acceptance--2026-11-01) records 1.0.124 / Host and CLI 0.1.469, preserved data, installed-model and native GUI verification. This does not change the earlier preflight/publication boundaries.
