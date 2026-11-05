# Electron migration: DeepSeek audit and independent adjudication

This follow-up audits the Electron desktop migration from the pre-migration
baseline `0255848`, including the published 1.0.120 candidate
`f1f61429cb8da40b438c1e5019c073975eb95444` and documentation base
`a30e14ea3ee684dffcb0df040ce78aa7a3e59df0`. DeepSeek DD1 independently
produced 27 findings. Codex and **Claude Opus 5.5** then checked the call paths,
reproductions and fixes independently. The original model report is retained;
it is not treated as 27 confirmed defects.

The review covers Electron main/preload/window lifecycle, IPC, Rust identity
and transport, legacy data export/import, OS bridges, updater, release scripts,
CI and the affected Host/CLI entry paths. It is not a new audit of all unchanged
mobile or Hub business logic. The previous
[actual functional verification](electron-functional-verification-2026-10-30.md)
remains separate evidence.

## Confirmed changes

| ID | Reproduction and previous failure | Result |
| --- | --- | --- |
| ROOT-01 | A migration repair entry globally disabled local-controller initialization, even when another Host was healthy. All four startup regressions failed before the fix. | Repair remains scoped to its Host; local initialization/proof and healthy remote connections proceed. No identity is deleted. |
| O9-1 | Chromium committed import A, but main's receipt/profile marker was interrupted. A later legacy write caused export B; import refused to replace committed A and repeatedly failed. | Read the committed ID first; main re-verifies A's HMAC and installation binding, finishes pending localStorage and its receipt. It preserves drafts, committed data and the legacy-divergence notice; forged/missing exports still fail closed. |
| DS-01 | A real loopback WebSocket closed at its allocation deadline despite being open and healthy. The same path existed in Tauri. | Open sockets survive that deadline in both retained Tauri and Electron Rust transports; HTTP and connecting sockets still expire. Reset, cancellation, ACK credit and write timeouts remain. |
| DS-17 | Windows build configuration accepted a 101–128-character OAuth client ID that native policy rejected. | Build and runtime limits agree at 100 characters. Actual normal GitHub IDs are shorter; this is a boundary mismatch, not a demonstrated current-user login failure. |
| DS-26 | The native updater replaced/read-back verified the bundle, then Host recovery failed. Main treated it as an ordinary install failure and could start new helpers from the new bundle while old main remained running. | Return a distinct error and set the App-wide restart fence. The UI offers restart, blocks another check/install/logout, and says Host recovery is unconfirmed. It does not display verified installation success or discard the recovery backup. |

DS-18 also adds the missing Electron/packaging and isolated macOS native/updater
jobs to push/PR CI. DS-19 and DS-24 correct inaccurate comments about request-size
validation and unsigned local-build Keychain behavior; they do not loosen any
runtime guard.

The CLI uses the same canonical Host and state. No CLI action or Host business
rule changes in this patch: the changed startup UI and Rust transports belong
to desktop clients. Updater Host drain/recovery still uses the existing CLI
contract. Android/iOS retain Capacitor and do not execute these Rust transports
or Electron migration paths.

## Adjudication of all 27 proposals

The [machine-readable ledger](electron-deepseek-audit-2026-10-30.json) records
Codex's disposition and reasoning for every original ID. Opus independently
reviewed all 27, then reviewed the patches; disagreements about severity are
retained as unproven hardening work rather than silently turned into bugs.

- **Fixed behavior:** DS-01, DS-17, DS-26, plus independently found ROOT-01 and
  O9-1. **Coverage/comments:** DS-18, DS-19, DS-24.
- **Rejected claimed failure paths:** DS-04 (normal recovery is single-flight),
  DS-05 (local controller migration is not remote reinstall authentication),
  DS-06 (duplicate same-key Keychain records were not demonstrated), DS-12
  (publishing already requires signed updates), DS-13's cancelled-Quit trigger
  (stdin stays open), DS-14 (manual downgrade and automatic update differ).
- **Retained hardening/platform work:** DS-02/03/08/20/21/22/27 concern bounded
  saturation, memory or latency; DS-07/09/15/23 require platform evidence or
  Windows signing/runtime work; DS-16 is an extra publication cross-check.
- **Explicit residual risks:** DS-10's two-rename crash gap, DS-11's power-loss
  durability, and O9-4's macOS old-instance check/export race are not fixed or
  crash/power-cut verified here. O9-2 notes retained full exports can consume
  disk space after repeated failed attempts; this patch does not blindly delete
  recovery material. The adjacent double-failure path (replacement validation and backup restore both fail) still needs a separate no-restart recovery fence; Electron-framework upgrades also need process-spawn acceptance after replacement. DS-25's registry 2/cache 9 gate remains the supported
  compatibility boundary; older schemas need an explicit transform/upgrade path.

Only Windows real-runtime acceptance was deferred by the owner. DeepSeek's
original metadata also described installed-upgrade/crash timing as deferred;
that is incorrect. Those are simply unverified boundaries, and installed Mac
acceptance remains required.

## Verification and evidence

All new reproductions use isolated `.noindex` state. Production keys, user
messages and `/Applications/TaroBot.app` were not used as failure fixtures.
Local evidence root: `electron-migration-20261030/phase9-deepseek-audit.noindex`.

| Check | Result / boundary |
| --- | --- |
| ROOT-01 HostApp + real IndexedDB startup fixtures | Before: 4 fail. After: 4 pass; native IPC/Hub start are fixture interfaces, not installed acceptance. |
| O9-1 real browser IndexedDB + HMAC-bound main migration state | 4 Chromium/WebKit checks pass, including interruption, source change, pending localStorage, forged/missing export and retained notice. |
| Electron contracts including migration changes | Opus initially ran 115 tests, all pass; final CI command with the required fixture environment passes 126/126 on macOS (includes packaging and updated updater tests; do not add overlapping counts). |
| Updater controller and real browser settings UI | 20 pass, including public/private restart-required state and recoverable/cancelled paths. |
| Native core | 62 pass, 2 intentionally ignored (explicit OS Keychain fixture and cross-language fixture writer). |
| Retained Tauri transport | 4 pass; deadline reproduction also passes in the shared Electron transport. |
| Native OS addon | 23 pass. |
| Native updater Rust | 67 pass; platform-gated Windows execution is not implied. |
| Real native updater lab | 15 pass: local TLS download/signatures, Host fixture process, bundle replacement, rollback/cancellation, preserved backup and Electron-main failed-Host restart fence. |
| Build/client-ID/local-controller focused regressions | 40 pass. |
| Windows installer contracts on macOS | 8 pass; not Windows runtime acceptance. |
| Complete pre-complete hook | 528 Vitest files pass; 7,151 tests pass / 5 existing skips (7,156 total). Root/client builds, translation checks and retained Tauri 98 unit + 3 shortcut + 3 real pinned-transport tests pass. |
| CI workflow | Local actionlint passes; local native/packaging commands run. GitHub billing-blocked jobs are not counted as executed. Linux runner execution remains unverified. |

Two attempted native probes selected an older non-lab binary and failed before
installation at fixture authentication; they are not bug reproductions. A subsequent run with the verified older lab-feature binary reproduced the generic Host error (`ds26-native-before-valid.log`). The
new separately compiled lab-feature binary provides the 15-pass evidence above.
Opus also reproduced a pre-existing test race: the verification URL assertion ran before the asynchronously loaded opener. It now polls the observed open-URL call; it does not change product behavior.
An initial browser command ran from the repository root instead of `client`
and failed Vite module resolution; corrected working-directory execution passes.

The pending 1.0.120 installation helper was stopped while it was still waiting
for active tasks, before Host drain or App replacement. Its receipt explicitly
records `held_for_confirmed_audit_fix`, `installed:false`. The running Tauri
1.0.119 App and Host were preserved. Published 1.0.120 artifacts are immutable;
these fixes need a new frozen release before local activation. Source tests and
published downloads do not establish installed Mac/GUI/model acceptance.
