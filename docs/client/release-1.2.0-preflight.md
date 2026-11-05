# TaroBird 1.2.0 preflight

This release adds App controls for cross-host Bot message grants, so it increments
the minor version from 1.1.1. All platforms and the standalone Host/CLI share
1.2.0; Android uses code 2026110404 and iOS uses build 1 for this marketing version.
Publication and installed-device acceptance are recorded separately.

## Integrated upstreams

The November 5 check covers 105 direct npm dependency entries, the authoritative
[SheetJS CDN](https://cdn.sheetjs.com/), integrated editor/font repositories and
the direct native dependencies. Vite moves from 8.3.5 to 8.3.6. Node stays on the
maintained 24 LTS line at 24.22.2; its declarations move to 24.19.2. TypeScript 7
remains the compiler, with the explicit TypeScript 6.0.3 compiler-API alias used
by source-analysis tools. Node 26 declarations are not runtime-compatible substitutes.

The canvas, PPT and both adapted skill manifests are aligned with
[baoyu-design 2.9.2](https://github.com/JimLiu/baoyu-design/releases/tag/v2.9.2),
commit `3ba4ecbcc9c3a468739f5515b30ac4f151563539`. The complete archive was compared
against all 90 recorded upstream files and both local vendor documents. The
editor bundles, skill entrypoints and authoring references are unchanged. The
standalone ZIP helper correction is recorded in provenance; those standalone
servers/helpers and the changed sharing script are not executed by the embedded
App integration. Motion is not introduced. Ordinary PPT requests retain the
model's own presentation skill; explicit Baoyu requests select its adapted skill.

Electron 45.2.3, Excalidraw 0.18.1, Vditor 4.0.1, Sarasa 1.0.43 and the pinned
JetBrains Mono source match their checked official upstreams. Licensing notices
remain attached to their components.

Native dependencies are updated together. The build toolchain minimum becomes
Rust 1.90 to match current Tauri compatibility-reader dependencies; this does not
raise the user operating-system requirement or change persisted data/protocols.
The minisign verifier's public validation API is unchanged by its 0.3 update;
signed-version, corruption and wrong-key rejection still require package checks.

## Distribution and evidence boundaries

New installers and App bundle names use TaroBird. Existing data, credentials,
identities and installation locations remain compatible. Android versions through
1.1.1 need one manual download of the TaroBird-named APK; its package identity and
signing key are retained. A signing-key comparison is not a physical-device
in-place upgrade test.

Windows releases are formal releases as requested by the owner. User feedback
that the existing Windows App runs successfully does not establish every new
installer or automatic-update scenario. Record those scopes independently.
CLI source and package checks cover the same Host authorization backend; title
bar, badge and layout changes have no headless presentation equivalent.

## Audit corrections

The owner CLI can revoke an existing permission after its source Host leaves the
network or its target Bot is deleted. The fallback requires exact IDs and an
existing active grant; allow still requires a current eligible peer. Both App
and CLI snapshots use the same revisions and audit records. An older receiving
Host now gets an explicit CLI upgrade hint instead of a bare missing-route error.

Bare web links stop at Chinese prose punctuation, trim GFM endpoint punctuation
and preserve a following adjacent link. Explicit Markdown links, Unicode URL
letters and encoded punctuation retain their original meaning. The standalone
sharing module is kept in vendored provenance but excluded from both editor
frames' resource maps.

Windows unread overlays are reapplied when a hidden window is shown or restored.
A zero count clears the cache; a failed update cannot overwrite the last applied
state. Explorer restart without a window show/restore remains outside this
change's automated evidence. Package verification now checks the badge atlas
against the same source bytes; real Electron image decoding is distinct from
Windows taskbar visual acceptance. Native menu language continues to follow the
operating-system locale, separately from the App language setting.
