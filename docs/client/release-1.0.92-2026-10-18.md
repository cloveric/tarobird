# TaroBot 1.0.92 / host CLI 0.1.440

This release delivers reusable desktop Agent Bus workspaces, interactive
participant diagrams, ADHD dragging improvements and the reviewed repairs.

## Changes

- Create and save a named Agent Bus from the desktop sidebar or ADHD toolbar.
  Open a saved Bus from the sidebar, configure its members and collaboration
  mode, explicitly start a task, and follow its member conversations in ADHD.
- Select participants in the compact collaboration diagram to inspect their
  configuration. The editor explains incomplete configuration, preserves drafts,
  and guards stale cancellation confirmations and concurrent edits.
- Drag an ADHD pane by its number or unused header space. Drag animation makes
  the intended destination visible; existing reading positions are retained.
- Correct cancelled-work results, obsolete capacity warnings, navigation to Bus
  participants, hidden invalid limits, delayed-send focus ownership and the
  latest-message button after a short conversation expands to fit.
- Release completed relay connections without truncating pending writes, with
  both peers and late close ordering covered.
- Apply AGPL-3.0-only to the project. Optional transport adapters remain separate
  from App and CLI distribution and are not restarted by this release.

See the [Bus design and CLI examples](agent-bus-workspace-2026-10-18.md),
[independent audit](agent-bus-independent-audit-2026-10-18.md) and
[hands-on Opus review](agent-bus-interaction-audit-2026-10-18.md). The latter
distinguishes the eight repaired defects from remaining design improvements.

## Compatibility and CLI

App 1.0.92; host/CLI 0.1.440; bundled Node 24.14.0; protocol 1;
private-network membership 2; Hub schema 18, accepting input schemas 1–18.
Older Hubs reject schema 18; downgrading requires a compatible state backup.
Android versionCode 2026101802 retains the existing package ID and signer.
Desktop update keys are unchanged.

The CLI provides `tarobot bus list`, `create`, `show`, `permissions`, `prepare`,
`run` and `stop` through the same host APIs, authorization and durable queues.
Agent Bus scheduling remains local to one host. Cross-host `messages send` is
a separate capability. Visual ADHD controls remain desktop-only.

All executable artifacts use source
[afe3447](https://github.com/cloveric/tarobot/commit/afe344784e91b1398b5568f1f228fae3134b7d96).
The standalone archive and desktop-bundled hosts include the same compiled host
and shared web client. No external package registry is used.

## Verification and distribution

| Surface | Result | Boundary |
| --- | --- | --- |
| Local source gate | 338 files; 4,596 passed, 1 skip; full-history secret scan and standalone build passed | 367-module import graph; Windows-only skip |
| Release scripts | 9 passed | iOS release-plan and privacy guard tests |
| Client | Clean dependency install, translations, TypeScript and Vite passed | Shared production frontend |
| Mac native tests | 64 passed | Native policy/lifecycle unit tests |
| CLI | Two clean production installs, pack/extract, dependency tree and startup passed | Matching standalone archive; no npm registry publication |
| CLI upgrade | 0.1.439 → 0.1.440 retained identity, controller, network and workspace | Disposable host |
| Real Codex | Text/two-client sync, original-file roundtrip, ASR, question card, stop/resume passed | Packaged Hub/Gateway and paired protocol consumers, not physical App devices |
| Android | Original signer, 39 JVM tests, lint 0 errors/19 warnings; 412 web files matched | No physical phone connected |
| Mac DMG | Strict deep seal, icons, versions and embedded frontend passed; 782 Host/CLI files matched | Apple Silicon; ad-hoc seal, no Apple notarization |
| Mac update archive | 4,947 file/link entries matched the final DMG | Bytes, modes, link targets and seal checked |
| Windows installer | Extracted NSIS, embedded frontend and runtime imports passed; 782 Host/CLI files matched | Cross-built x64; no native Windows execution or Authenticode |
| Update channels | Fixed public keys, signed versions and final executable configuration verified | Separate Mac and Windows feeds |
| Published assets | Downloaded and matched against local bytes, GitHub digests, checksums and desktop signatures | All three platform releases |

[Sanitized verification manifest and artifact hashes](evidence/release-1.0.92-2026-10-18.json).

- [Mac and CLI](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.92)
- [Windows and CLI](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.92)
- [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.92)

The pre-release [hands-on audit](agent-bus-interaction-audit-2026-10-18.md)
documents browser journeys, reproduced defects and focused Chromium/WebKit
regressions. Those journeys were not repeated for the version-only commit.
No physical Windows/Android or other live-model acceptance is claimed here.
The Android installer/OAuth UI was not repeated. iOS source versions were
synchronized; no new Simulator build, signed IPA or TestFlight upload occurred.
Optional adapter changes since 1.0.91 are license metadata only; no adapter
dependency or runtime change was introduced and no fleet was restarted.

GitHub [Source checks](https://github.com/cloveric/tarobot/actions/runs/39123528210)
executed zero steps because of account billing/spending limits. The failed cloud
status is not a failed local regression and is not recorded as a successful CI run.

## Local Mac activation

The update retains a sealed copy of the previous App on the external disk and
takes an offline private host-state snapshot before replacement. The guarded
App-owned update path drains active Bot work, swaps the App, restarts the host,
and verifies its identity, record counts, version and authenticated connection.
Activation status is separate from package and publication verification.

The later activation receipt confirms App 1.0.92 and host 0.1.440, successful
schema 18 activation, retained host identity and record counts, authenticated
reconnection, and the restarted GUI process. The installed App version was read
back independently. Native-window interaction was not repeated.
