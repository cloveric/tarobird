# 1.0.126 preflight

App 1.0.126 / Host and canonical CLI 0.1.471 retain protocol 1 and Hub schema 23.
The owner authorized publication and local Mac installation on 2026-11-02.
Windows packaging/runtime publication remains deferred under the earlier owner
decision. Desktop, Android, iOS TestFlight and the canonical CLI use one frozen
source revision; publication and installed verification are separate gates.

## Release content

This release carries the post-1.0.125 Chancellor repairs: independently delivered
ticket authorization and selection context, clearer inactive-context errors,
per-task worker model/effort selection, confirmation/acceptance boundaries and
explicit scheduled-dispatch limitations. Omitted model/effort values remain
valid CLI defaults. Task quality requirements and scoped owner-reported outcomes
can inform the existing coordinator judgment; no topic-to-provider map, vendor
quota, calibrated ranking or automatic preference learning is introduced.
Unavailable preferred targets can fall back under the same ask/auto rules;
an owner-restricted target must not be silently replaced.

The live and plan-only observations in the dispatcher documents remain distinct.
Explicit successful runs of another engine prove connectivity, not autonomous
cross-provider selection or better finished-video quality. Production personas,
Bot models and existing conversations are not rewritten by this release.

## Upstream and package boundary

See the [fresh dependency inventory](release-1.0.126-dependency-inventory.md).
The integrated editor/font selections have no new upstream stable update.
Fresh root and production-client audits report zero known vulnerabilities.
The client development graph retains seven moderate build-tool findings from
the previous release; no automatic incompatible downgrade is applied.

## Validation recording

Source tests, real isolated model/CLI journeys, signed package readbacks,
publication downloads and the installed Mac each require their own receipts.
The initial Electron suite passed 324 cases and failed three asynchronous
browser cases while concurrent builds were running. The exact three passed
unchanged under a lower-load focused run; no assertion or timeout was weakened.
Both results are retained. Complete final-source results and remaining platform
limitations belong in the release verification document; this preflight does
not claim publication, installation or physical-device acceptance.

CLI impact: all Chancellor changes use the shared Host/Gateway/CLI ticket path,
and ship in the same canonical CLI archive as the App-bundled Host. There is no
separate UI-only routing implementation or new command surface.
