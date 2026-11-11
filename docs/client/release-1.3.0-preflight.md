# TaroBird 1.3.0 preflight

The owner authorized a full stable release after the post-1.2.1 audit and the
queue-first Codex send choice. This is a preparation record, not a publication
or installed-device acceptance receipt. App and standalone CLI versions advance
together to 1.3.0; iOS build 1 and Android code 2026110406 are new counters.

## Product changes

- Codex uses the existing supplement/queue selector, defaults to queue, and
  retains task-bound delivery recovery without shrinking the send button.
- Desktop updates use the public repository without GitHub account credentials.
  Existing 1.2.1 binaries retain their original login/manual-upgrade behavior.
- Workbench editor loading, side-conversation focus, attachment/cache deletion,
  initial file drops, Chinese ZIP names, model discovery, iOS foreground
  recovery and remote-screen pointer handling include the reviewed repairs.
- Host changes ship in the matching CLI. The composer selector is presentation
  only and does not create a separate host queue or steering implementation.

See [the source audit](../audits/post-1.2.1-2026-11-11.md) for the earlier
reproductions and their physical-device boundaries. Those records are not new
signed-package acceptance for this version.

## Upstream review on 2026-11-11

Electron advances from 45.2.3 to 45.3.0, including the upstream destroyed-webview,
quit and redirect-loop crash fixes. ACP SDK advances to 2.6.0; web-push to 4.0.0;
ws to 8.22.2; Vite to 8.3.7; the React Vite plugin to 6.3.0; Playwright to 1.65.0;
and Lucide to 1.71.0. The notification/opener plugin bindings advance together to
2.8.1/2.7.3. Native UUID/flate2 advance to 1.29.2/1.1.11. The web-push ESM change
requires a namespace import; the old default import was reproduced failing in
Node before adapting it. The existing push regressions cover the adapted sender.

Node 24.22.2 and its matching 24.19.2 type definitions remain the current Node 24
line. Excalidraw 0.18.1, Vditor 4.0.1 and Sarasa 1.0.43 remain current stable.
Baoyu 2.13.0 (`64a874988262e558c9b071eb55b4d02038ca33f8`) has byte-identical
canvas/PPT editors, SKILL entrypoints and references compared with the reviewed
2.12.2 integration. Its only relevant helper delta adds title-clearance checking
to the standalone artifact script, which this App does not install. Provenance
and reviewed helper hashes advance together; native PPT selection stays default.

## Publication checks

Run fresh source, client, Electron, native, packaged CLI and signed-artifact
checks, including the exact outgoing source and binary privacy gates. Temporary
Apps and private receipts stay in the unindexed release workspace. GitHub notes
are English and include the existing public TestFlight invitation.

The Windows release-acceptance workflow accepts only a reviewed draft bound to
the executing source SHA, verifies both installer signatures, and exercises
the released Electron 1.2.1 to candidate upgrade on a disposable Windows runner.
It records candidate SHA-256 and the separately judged install/update/native
scopes. It neither publishes a release nor stores a signing secret. Missing or
failed Windows acceptance must not be reported as a passing update channel.
Physical Windows clipboard/resize behavior and physical iPhone foreground
reconnection remain separate from this automated installer check.

Release authorization does not replace the owner's installed Mac App or restart
its production Host. No App Store submission is part of TestFlight publication.

## Source validation before packaging

Fresh checks passed: 650 Vitest files (8,455 tests; 7 explicit skips), 20 Node
completion checks, Host/client production builds, 418 Electron tests, 54 Chromium
journeys, 27 release/privacy guard checks, desktop core/native/updater regressions
and 16 isolated updater scenarios. The native Tauri check initially lacked the
prepared Host resource in the clean release directory; after the normal Host
preparation step, the native stage passed. Earlier passing stages were not
relabelled or rerun to hide this preparation failure. Artifact scanner self-tests
passed 10 cases plus positive direct/archive secret-scanner fixtures. Actual
artifact scans still run against the final signed bytes before upload.
