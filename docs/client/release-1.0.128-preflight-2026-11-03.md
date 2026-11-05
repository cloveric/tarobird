# 1.0.128 preflight

App 1.0.128 / Host and canonical CLI 0.1.473 use protocol 1 and Hub schema 25 (supported input schemas 1–25). The installed 1.0.127 Host upgrades schema 24 to 25; the older runtime must reject the migrated database.
The owner explicitly authorized publication and updating the local Mac on
2026-11-03, superseding the earlier release hold. Windows publication/runtime
remains owner-deferred.

The release contains the post-1.0.127 main changes through ea06c14: editable
Baoyu canvas and PPT, explicit Baoyu/native skill selection, Unicode artboards,
wheel behavior, comments/history/backup and authenticated sharing with the
second-review recovery/transport fixes. It also carries the reviewed queue pause,
ticket controls, remote-screen controls/entry, extension settings and Workbench
resize fixes already on main. Motion is outside the product scope.

See the [second review](baoyu-design-ppt-second-review-2026-11-03.md),
[PPT routing](baoyu-ppt-routing-2026-11-03.md) and
[upstream inventory](release-1.0.128-dependency-inventory.md).
The prior review is source/browser evidence, not final-package or installed
acceptance. Release artifacts use a fresh clean source and independent npm ci.

Host behavior affects the canonical CLI: publish its matching archive from the
same source as the App, and verify a clean install plus an existing 0.1.472 host
upgrade with identity/data preserved. App controls for device-local designs do
not introduce a second CLI authority. No Bot persona/model, unrelated fleet or
external package registry is changed.

GitHub Actions was blocked by account payment/spending-limit restrictions at
ea06c14. Local source/native/build/package checks must be recorded accurately;
an unstarted CI job is not a pass. Final source, publication/download hashes,
TestFlight processing and local installed runtime/model/GUI acceptance will be
recorded separately. This preflight does not claim any of those outcomes.
