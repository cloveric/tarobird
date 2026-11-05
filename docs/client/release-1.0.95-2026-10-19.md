# TaroBot 1.0.95 / host CLI 0.1.443

This release adds a lightweight workspace Diff viewer with desktop review notes,
a graphical panel for local Bot direct-message permissions, and managed local ASR
setup/status. It includes the day's Windows redirected-directory safeguards,
network/device-name and queue fixes, transparent Windows icons, model/effort
selection, and attachment handling improvements.

An independent Opus 5.5 xhigh review covered all 19 commits (444 files) in the
initial daily range. Codex reproduced the findings and repaired CLI initialization
and verification, rollback-compatible mutex tickets, Kimi startup serialization,
Diff Git configuration checks, ASR job receipts/service registration and several UI
recovery paths. The [daily audit record](../audits/2026-10-19-day-closeout.md) separates
Codex validation, Opus findings, withdrawn reports and remaining platform limits.

Agent Bus remains distinct from Bot direct-message permissions. Ordinary Bus
HTTP requests retain the 30-minute delegation deadline; Crew role budgets remain
separate. No authority or state was migrated between those features.

## Compatibility and CLI

App 1.0.95; host/CLI 0.1.443; bundled Node 24.14.0; protocol 1; private-network
membership 2; schema 19, accepting input schemas 1–19; per-stage Bus capability v3.
Android versionCode 2026101902 retains the original package ID and signer.
Desktop update keys are unchanged. Agent Bus routing remains host-local and the
visual workspace remains desktop-only. Existing CLI commands use the same fixed
host core; standalone and bundled hosts use the same source revision.

Executable source: [c1bf8bb](https://github.com/cloveric/tarobot/commit/c1bf8bb8426131e002e5bcb4ce9532c7abadbc05).

## Verification

| Surface | Result | Boundary |
| --- | --- | --- |
| Full source gate | 5108 passed, 5 conditional skips; full pre-complete hook passed | Local checks; cloud execution result recorded separately |
| Legacy adapter isolation | 1,231 passed | Fixture tests only; no fleet restart |
| Long HTTP probes | 92 passed, including 305-second header and body waits with one request each | Executed this release turn |
| Browser journeys | See detailed initial matrix and corrected reruns in JSON evidence | Chromium/WebKit; actual Hub/Gateway with scripted engines, not physical phones |
| Client | Clean dependency install, translations, TypeScript and Vite passed | Embedded frontend additionally verified |
| Release scripts | 6 passed | iOS release plan and privacy guards |
| Mac native tests | 76 passed | Native lifecycle/policy and real TLS integration targets |
| CLI | Two clean production installs, pack/extract, dependency tree and startup passed | No Feishu SDK or external registry publication |
| CLI upgrade | 0.1.442 → 0.1.443; identity, controller, network and workspace retained | Disposable existing host |
| Real Codex | All 5 paths passed: text/two-client sync, byte-identical file, local ASR, question submit/resume, stream stop/resume | Packaged Hub/Gateway with paired protocol clients |
| Android | Original signer; 39 JVM tests; lint 0 errors / 19 warnings; 444 web files matched | No physical phone connected |
| Mac DMG | Strict seal, icons, version and embedded renderer verified; 833 Host/CLI files matched | Apple Silicon; ad-hoc seal, no Apple notarization |
| Mac updater | 4999 file/link entries match final DMG | Bytes, modes, links and seal |
| Windows | NSIS extraction, embedded renderer, six transparent icon frames and native import checks; 833 Host/CLI files matched | Cross-built x64; no native Windows execution or Authenticode |
| Published assets | All three releases downloaded and matched local bytes, GitHub digests and SHA256SUMS | Pinned desktop signatures and signed versions also rechecked |

[Sanitized evidence and artifact hashes](evidence/release-1.0.95-2026-10-19.json).

- [Mac and CLI](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.95)
- [Windows and CLI](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.95)
- [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.95)

At the final check, Source checks and the first Secret scanning run for this
source commit had failed before executing any steps: GitHub explicitly reported
failed account payments or a spending limit. Additional tag-triggered scans were
still queued. Exact statuses and annotations are retained in the JSON evidence;
the reported passes here are local, not successful cloud CI. Other live model engines and physical Windows/Android were
not repeated. iOS source versions are synchronized; no signed IPA or TestFlight
publication occurred. Optional transport fleets and external package registries
were not changed.

## Local Mac activation

The verified replacement and sealed previous App are prepared, with backup and
build artifacts on the external disk. A detached helper uses the shared host
update lifecycle: wait for active work/questions to finish, pause the exact
App-owned host, take an offline private snapshot, replace the sealed App, restart,
and check version/schema, retained identity/history and authenticated reconnect.
It records GUI-process startup separately from native-window interaction.

Activation status at this documentation checkpoint: `waiting_for_current_turn_and_other_active_work`.
This status is not a claim of completed installation while work is still active.
The helper's private receipt is the source for the subsequent installation check.
