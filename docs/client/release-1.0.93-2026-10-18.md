# TaroBot 1.0.93 / host CLI 0.1.441

This release adds a compact disclosure control to the desktop's left Agent Bus
list. Clicking the heading folds or unfolds all saved Bus entries. The header
retains the count and a running indicator, with existing polling still active.
Normal and ADHD views share the local preference, including across reloads.
Member panes, configuration/composer drafts and running work remain intact.
The ADHD new-Bus button remains independent of the disclosure control.

This is a client presentation change. No host capability, permission, protocol
or CLI command is added. CLI 0.1.441 carries the matching shared web client;
App-bundled hosts and standalone CLI use the same release revision. Agent Bus
remains host-local and its visual controls remain desktop-only.

## Compatibility

App 1.0.93; host/CLI 0.1.441; bundled Node 24.14.0; protocol 1; private-network
membership 2; schema 18, accepting input schemas 1–18. Android versionCode
2026101803 retains the original package ID and signer. Desktop update keys are
unchanged. No external package registry or optional transport fleet is changed.

Executable source: [35130bb](https://github.com/cloveric/tarobot/commit/35130bbb2cf91300f3e7f5d8f99bf81a5c88da64).

## Verification

| Surface | Result | Boundary |
| --- | --- | --- |
| Local source gate | 338 files; 4,596 passed, one Windows-only skip; history secret scan and 367-module standalone build passed | Local, not cloud CI |
| Release script tests | 9 passed | iOS release-plan and privacy guards |
| Client | Clean dependency install, translation check, TypeScript and Vite passed | Shared frontend |
| Browser interaction | Chromium 4 / WebKit 4 passed before version bump | Folding, persistence, status, drafts, host isolation and phone entry exclusion; isolated Hub and controlled Bus APIs |
| Mac native tests | 64 passed | Native policy/lifecycle unit tests |
| Standalone CLI | Two clean production installs, packing/extraction, dependency tree and startup passed | Matching web client, no npm registry publication |
| CLI upgrade | 0.1.440 → 0.1.441 retained identity, controller, network and workspace | Disposable host |
| Real Codex | Text/two-client sync, original-file roundtrip, ASR, question card and stop/resume passed | Packaged Hub/Gateway and paired protocol consumers |
| Android | Original signer, 39 JVM tests, lint 0 errors/19 warnings; 412 web files matched | No physical phone connected |
| Mac DMG | Strict seal, icons, versions and actual embedded frontend verified; 782 Host/CLI files matched | Apple Silicon; ad-hoc seal, no Apple notarization |
| Mac updater | 4,947 file/link entries match final DMG | Bytes, modes, link targets and seal verified |
| Windows | NSIS extraction, actual embedded frontend and native import checks; 782 Host/CLI files matched | Cross-built x64; no native Windows execution or Authenticode |
| Updaters | Final executable configuration, pinned signatures and signed versions verified | Separate Mac and Windows feeds |
| Published files | All three releases downloaded; bytes, GitHub digests, checksums and updater signatures match | Installer and CLI artifacts |

[Sanitized evidence and artifact hashes](evidence/release-1.0.93-2026-10-18.json).

- [Mac and CLI](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.93)
- [Windows and CLI](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.93)
- [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.93)

The first full run overlapped native packaging and reported three
`host_update_runtime_probe_failed` errors in the upgrade tests, at the existing
15-second child-process deadline. After packaging ended, all 42 tests in that
file passed, followed by the complete source gate. No code or timeout was
changed. Concurrent build load is a plausible explanation, not a proven root
cause; the initial failure is retained in the local release evidence.

GitHub [Source checks](https://github.com/cloveric/tarobot/actions/runs/39125107023)
and [Secret scanning](https://github.com/cloveric/tarobot/actions/runs/39125107093)
executed zero steps due to account billing/spending limits. Local results do not
represent successful cloud jobs. Android install/OAuth, physical Windows and
other live engines were not repeated. iOS source versions were synchronized;
no Simulator rebuild, signed IPA or TestFlight publication occurred.

## Local Mac activation

The previous App is sealed and backed up on the external disk. Before replacing
the canonical App, a detached helper drains active work and takes a private
offline state snapshot. The helper then verifies the new App/host versions,
schema, retained identity and record counts, authenticated reconnect and GUI
process. This is separate from native-window interaction acceptance.

The private receipt confirms installation, host restart, authenticated reconnect
and GUI process startup. Native-window interaction was not repeated.
