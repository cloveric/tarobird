# 1.0.129 fullscreen repair preflight

The owner authorized publication and updating the local Mac on 2026-11-03.
App 1.0.129 and Host/canonical CLI 0.1.474 use protocol 1 and Hub schemas 1–25.
The installed baseline is App 1.0.128 / Host and CLI 0.1.473 / schema 25.
Windows remains owner-deferred; Motion remains outside the requested scope.

The product change since 1.0.128 is the [Design fullscreen repair](design-fullscreen-2026-11-03.md), commit bddfd93.
Each editor navigation receives a unique fixed bootstrap URL. Electron permits
user-triggered fullscreen only for the unique live direct editor frame in an
owned App window. Automatic fullscreen, nested/duplicate frames and other child
permissions stay denied. Existing canvas/PPT saving and native/Baoyu routing are retained.

CLI impact: the fullscreen permission policy is Electron-only; the per-editor
loader URL fragment is shared by desktop, web and mobile. Chromium and WebKit
checks cover that shared loader. This change introduces no Host API or CLI
command. The matching standalone CLI still ships from the same frozen source,
with clean/extracted package and existing-host upgrade checks.

See the [fresh upstream inventory](release-1.0.129-dependency-inventory.md).
The integrated editors and skills remain at the latest stable pins; recorded
SDK/framework updates retain the prior reviewed scope. Production dependency
audits, source checks, native Electron fullscreen, packaging signatures and
published downloads must be recorded for this source.

Prior 1.0.128 runtime/model/GUI and native/Baoyu authoring evidence is retained;
it is not repeated or labeled 1.0.129 evidence. The new installation requires
its own version/connection and repaired fullscreen readback. Source/package
checks do not establish installed or physical-device acceptance. The previous
GitHub billing restriction and remote-screen first-connect issue are not fixed
by this change and remain separately reported if still present.
