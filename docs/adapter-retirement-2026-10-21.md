# Retire the unused chat transports (issue #48)

## Scope

TaroBot now ships the App/Gateway and headless Host CLI. The former Feishu/Lark
and Telegram Bot transports, their old fleet CLI and service startup scripts,
and the separate Feishu SDK package are retired. This change does not stop any
installed process, migrate live state, remove credentials, or delete user files.

The cleanup deliberately preserves shared behavior. Source imported by the
current App was moved before the transport directories were removed:

| Former owner | Current owner |
| --- | --- |
| Telegram message rendering/chunking | `src/runtime/message-renderer.ts` |
| Reset detection and absolute-path checks | `src/runtime/command-detection.ts`, `file-paths.ts` |
| Delivery receipts | `src/runtime/delivery-ledger.ts` |
| Injected attachment/text delivery | `src/core/shared/artifact-delivery.ts` |
| Normalized command/attachment types | `src/runtime/command-message.ts` |
| Reply port types | `src/runtime/reply-channel.ts` |
| Cron runtime interface | `src/runtime/cron-types.ts` |

The bundled `tarocub-service-ops` skill is also removed, so the skill installer
no longer teaches new Bots to start a retired fleet. Previously installed copies
in user skill folders are not removed automatically; those copies are stale and
can be removed separately after the owner confirms their use.

The reply port contains no SDK, token discovery or HTTP client. Callers provide
its implementation explicitly. Existing queue, approval, cancellation, engine,
file, audit and Bot collaboration rules are unchanged.

## Compatibility that remains

A matching word is not enough to identify a retired adapter. Some historical
identifiers are still written by the current shared code. This PR preserves:

- Persisted routing/session keys, receipt fields, card envelopes and database
  schemas, including historical `lark:` and `telegramChatId` identifiers.
- Readers for older attachment/output directories and resumed transcripts.
- Existing Core channel policies and injected channel-port contracts. They
  contain no retired SDK implementation; removing or changing these contracts
  would be a separate behavior/schema migration.
- User-invoked third-party tools, their credentials/environment aliases, and
  historical design/audit documents. This is not a ban on using a third-party
  service from an authorized Bot task.
- Negative SDK/subprocess canaries: these intentionally mention the old SDK or
  executable names to prove the App never silently falls back to them.

Some small Core contracts and general state/operations modules remain outside
this removal even where the current App does not call every exported branch:
`core/account-card`, the injected meeting policy, `core/lark-cli-error`,
`cron-cli`/`cron-helper-server`, `state/archive`, old runtime-state readers,
`service-directory-gate`, and the generic `ui`/`web` utilities. Their tests stay
while their implementations stay. This is a deliberate conservative boundary,
not a claim that every old label or unreachable helper has been deleted. A later
API/dead-code cleanup must establish its own callers and data migration needs.

The retirement document supersedes older instructions to install
`adapters/feishu`, run `build:legacy`/`test:legacy`, or launch an old fleet. Those
entry points are no longer supported here. Historical audit results are records
of earlier revisions and must not be read as current test instructions.

## Shared regression and boundary checks

Tests that merely re-exported Core code through a transport directory now import
Core directly. Mixed suites retain their shared cases and retire only cases
whose implementation was removed. Test fakes supply explicit channel ports;
they do not restore a transport runtime or require the Feishu SDK.

The normal `npm test` suite owns the retained shared regressions. The separate
legacy test list/mode and optional Feishu CI job are removed. Source-build checks
cover runtime graph edges, erased type imports, re-exports, literal dynamic
imports, CommonJS imports and test mocks. They also reject restored adapter
source directories. Packaging rejects retired compiled transport paths.

## CLI impact

The current `tarobot` CLI continues to enter through `src/index.ts` and the same
Host/Gateway implementation as the Apps. No current command or permission is
removed and no new command is needed. The former transport/fleet CLI is retired.
CLI configuration, Bot/message/file operations, identity and local-Host tests
remain part of the default suite. No standalone package is published by this PR.

## Concurrent PRs

PR #45 adds model/effort cases to the old `telegram-simple-commands` filename.
When rebasing, transplant those assertions to `tests/core-engine-command-rules.test.ts`
(and retained compatibility-profile cases to `tests/core-service-compat.test.ts`); do not resurrect the removed compatibility
facade or silently drop the model cases. Other open PRs must likewise use the
current Core/Gateway ownership.

## Verification

The [per-case disposition map](audits/2026-10-21-adapter-retirement-tests.json)
accounts for 2,453 baseline executions in changed/deleted test files: 1,599
migrated, 90 already covered by retained shared tests, and 764 retired with their
platform implementation. Parameterized executions remain separate entries.
These counts do not represent the entire suite or an assertion that test count
alone proves equivalent coverage. Every retained target file and test title was
resolved against the integrated source.

Current `tarobot --help` output matches the baseline byte for byte. A clean
unpacked production tarball, installed outside the source worktree, passed the
standalone verifier with no Feishu SDK, no platform credentials and no CLI
preinstalled on PATH. It initialized explicit isolated state, preserved the host
identity, started the Hub, served client assets and resolved the engine/helper
entrypoints. The Windows x64 launcher was cross-built and its PE/static-runtime
checks passed; this is not a real Windows execution.

No client UI or native source changed, so no browser or device interaction run
is claimed. No Docker daemon is available: the Docker-layout source-guard test
covers missing optional roots, but an actual Docker image build was not run.
No registry publish, live fleet restart, owner data migration or installed App
replacement was performed.

### Codex execution results

- Unmodified baseline: default suite 5,127 passed / 5 skipped; legacy suite
  1,231 passed. Both baseline source and legacy builds passed.
- Integrated full default suite: **5,515 passed / 5 skipped / 0 failed**.
  The 14 restored Core ASR cases were added after this run began; a separate
  run of those cases plus Gateway/cloud-ASR regressions passed **40 / 40**.
  These counts are reported separately to avoid counting overlapping tests twice.
- The five skips are unchanged opt-in/platform checks: two real >5-minute Bus
  timeout cases, a Windows Codex shim probe, an opt-in real-Git workspace-diff
  check and a physical Windows directory-context probe.
- Root source build, client production build, standalone package/prepack,
  production-only dependency installation and independent unpacked-package
  startup verification passed. Current CLI help is unchanged.
- Final migrated-fixture rerun: **440 passed**. Final ASR/source-guard/canary
  rerun: **69 passed**. These are focused reruns and overlap the suite above.
- The broad root `tsc --noEmit -p tsconfig.json` gate is **not green on the
  baseline or this branch**: 597 baseline diagnostics, 108 remaining after
  correcting migrated mock signatures. Every remaining diagnostic matches a
  baseline diagnostic after accounting for file/type renames, checkout paths
  and union-member order. Existing test/client type configuration debt is not
  represented as a pass; production source and client build gates pass.
- Full Git-history and staged-diff secret scans passed with the repository's
  pinned Gitleaks policy. No raw scanner reports or private runtime state are
  included in this PR.
- Native macOS Cargo tests: **76 passed**, including actual TLS/WebSocket
  rotation and a 512 MiB stream fixture. The clean checkout initially lacked
  installer resources; the test run used `TAURI_CONFIG={"bundle":{"resources":[]}}`
  to omit installer-only resources. This is a test build, not an App installer
  or bundled-host native acceptance.
- Additional instance-config/meeting regression: **48 passed**, including the
  preserved explicit defaults. Browser/physical-device/real-engine acceptance
  is not claimed.

### Opus review findings and disposition

- Confirmed Docker regression: the new guard initially required `tests/`, which
  the Docker host stage does not copy. Reproduced the `ENOENT`; only optional
  roots may now be absent. Required source roots still fail closed. Added
  filesystem-level regression cases, including restored retired modules.
- Confirmed stale operational skill: removed the bundled fleet skill and its
  installer-facing index entry. No user-installed skill or service was touched.
- The coverage reviewer caught an over-broad test-name replacement in the
  entrypoint map (`cli` also changed `client` paths). Reverted that textual
  substitution; no production source was affected. Current path references
  are checked separately below.
- Updated current setup, architecture, entrypoint/test-map, ASR and troubleshooting
  guidance; the old full reference is explicitly labelled historical.
- Expanded restored-path/import checks to retired helper modules and scripts,
  client/script/plugin-test roots, literal helper URLs, createRequire aliases
  and `vi.importMock`. SDK absence probes are admitted only at the verifier's
  `require.resolve` sites. SDK loads are rejected except in the two explicitly
  allowlisted negative-call guard fixtures; namespace/default/CommonJS
  `Module.createRequire` aliases are covered too.
- Confirmed missing shared ASR coverage: the old `telegram-message-input`
  suite also tested `core/voice`. Restored its 14 shared tests unchanged under
  `core-voice`, including HTTP/CLI cancellation, chunking, partial results,
  watchdog behavior and retry rules. The focused ASR/App run passed 40 cases.
- Preserved the remaining explicit shared meeting-default assertions in
  `instance-config`; the retired VC network API is not needed by these tests.
- Corrected a proposed coverage reference to the deleted launchd cleanup test:
  both the old service-doctor command and cleanup script are retired, so that
  case is explicitly retired rather than claimed as covered.
- Preserved negative SDK-call coverage with a synthetic SDK shape, without
  reinstalling the SDK. Process guard canaries and swallowed-error detection
  remain tested.
- Tightened migrated mock signatures to the existing Core channel/bridge ports;
  final fixture tests were rerun without dropping assertions. No new broad-root
  typecheck diagnostic remains relative to the baseline.
- Kept existing Core schema/profile and general state APIs for the reasons
  above. No speculative profile/default or live-data rewrite was included.
- Root self-review removed the obsolete `cctb send` rejection advice and added
  an assertion on the current attachment-permission guidance.

The source review compared all three App entrypoints and their type-inclusive
closures, as well as the built 389-module runtime graph. It found matching
closures after mapping the moved modules. This was static review evidence, not
an execution result; Codex's actual runs are reported separately.

### Final independent delta review

Opus 5.5 xhigh closed the previous required findings after inspecting the final
ASR/config/fixture reruns and guard/build evidence. Its remaining documentation
suggestion was applied to the required event/security/state guides: active
owners now point at Core/Gateway, and old transport environment/log sections are
labelled historical. The source guard is a static literal-edge check, not a
complete JavaScript data-flow proof; unobserved computed/chained import forms
remain outside that claim. No current source uses the hypothetical bypass forms
listed by the reviewer. Broad pre-existing typecheck debt and native/device
acceptance limits above remain explicitly open.
