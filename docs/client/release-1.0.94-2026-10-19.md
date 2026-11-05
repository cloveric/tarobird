# TaroBot 1.0.94 / host CLI 0.1.442

Agent Bus now binds workflow slots to Bot/conversation pairs, allows repeated
Bots with separate conversations, supports per-stage tasks and explicit member
removal, and makes naming, grouped navigation, draft confirmations and run status
clearer. Long queues and returning from Bus no longer expand the ADHD container.
This release also includes 27 owner-supplied mascot avatars.

The shared transport no longer inherits Node fetch's five-minute response-header
cutoff. Ordinary delegation retains its existing 30-minute deadline and explicit
cancellation; Crew research/analysis stages retain their separate 60/120-second
budgets. This is not an unlimited execution policy.

The follow-up review repairs lost-response recovery, duplicate creation, concurrent
edits, retained/deleted drafts, retired default record allocation, owned automatic
record titles and incomplete output delivery. Permission boundaries remain intact
and uncertain operations do not automatically repeat model work or file delivery.
See the [execution design and wall-clock probes](agent-bus-stage-tasks-2026-10-19.md)
and [independent interaction audit](agent-bus-followup-audit-2026-10-19.md).

## Compatibility and CLI

App 1.0.94; host/CLI 0.1.442; bundled Node 24.14.0; protocol 1; private-network
membership 2; schema 19, accepting input schemas 1–19; per-stage Bus capability v3.
Android versionCode 2026101901 retains the original package ID and signer.
Desktop update keys are unchanged. Agent Bus routing remains host-local and the
visual workspace remains desktop-only. Existing CLI commands use the same fixed
host core; standalone and bundled hosts use the same source revision.

Executable source: [e2f1cb6](https://github.com/cloveric/tarobot/commit/e2f1cb6b0f821f7aa7cfaf26a163a84882820f4d).

## Verification

| Surface | Result | Boundary |
| --- | --- | --- |
| Full source gate | 342 files; 4,683 passed, 3 intentional skips; secret scan and 372-module standalone build passed | One Windows-only check and two opt-in 305-second probes skipped in this run |
| Long HTTP probes | Both header/body delays of 305 seconds succeeded with exactly one request | Verified in the preceding repair; not repeated for version-only bump |
| Final browser journeys | Chromium 21 / WebKit 21 passed on 5c3c58f | Actual Hub/Gateway/Bus with scripted engines plus recovery UI; not native Mac |
| Client | Clean dependency install, translations, TypeScript and Vite passed | Final package renderer additionally verified |
| Release scripts | 9 passed | iOS release plan and privacy guards |
| Mac native tests | 64 passed | Native lifecycle/policy unit tests |
| CLI | Two clean production installs, pack/extract, dependency tree and startup passed | No Feishu SDK or external registry publication |
| CLI upgrade | 0.1.441 → 0.1.442; identity, controller, network and workspace retained | Disposable existing host |
| Real Codex | All 5 paths passed: text/two-client sync, byte-identical file, local ASR, question submit/resume, stream stop/resume | Packaged Hub/Gateway with paired protocol clients |
| Android | Original signer; 39 JVM tests; lint 0 errors / 19 warnings; 433 web files matched | No physical phone connected |
| Mac DMG | Strict seal, icons, version and embedded renderer verified; 808 Host/CLI files matched | Apple Silicon; ad-hoc seal, no Apple notarization |
| Mac updater | 4973 file/link entries match final DMG | Bytes, modes, links and seal |
| Windows | NSIS extraction, embedded renderer and native import checks; 808 Host/CLI files matched | Cross-built x64; no native Windows execution or Authenticode |
| Published assets | All three releases downloaded and matched local bytes, GitHub digests and SHA256SUMS | Pinned desktop signatures and signed versions also rechecked |

[Sanitized evidence and artifact hashes](evidence/release-1.0.94-2026-10-19.json).

- [Mac and CLI](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.94)
- [Windows and CLI](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.94)
- [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.94)

GitHub Source checks and Secret scanning executed zero steps because account
billing/spending limits blocked the jobs. The reported passes are local, not
successful cloud CI. Other live model engines and physical Windows/Android were
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
