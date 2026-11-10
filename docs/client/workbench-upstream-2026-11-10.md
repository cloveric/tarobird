# Workbench editor and skill refresh

The canvas and PPT integration moves from 2.9.2 to the stable 2.12.2 source.
The editor, offline build adapters, authoring references, original helper hashes
and adapted skills move together. This is a source update, not an App release.

## Official upstream inventory

Checked on 2026-11-10 against official releases and npm distribution tags:

| Integration | Bundled after this change | Decision |
| --- | --- | --- |
| [Excalidraw](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1) | 0.18.1 | Already latest stable; preserve local font and embedded viewport fixes |
| [Vditor](https://github.com/Vanessa219/vditor/releases/tag/v4.0.1) | 4.0.1 | Already latest stable; 4.0.2-alpha.8 is a prerelease |
| [Design and PPT](https://github.com/JimLiu/baoyu-design/releases/tag/v2.12.2) | 2.12.2, `807fe38ac8f0a82afcfba0d38ef3ef5c32e69c93` | Upgrade both editors and both skills from 2.9.2 |

The downloaded upstream source was compared with the prior pinned source,
including both SKILL.md files, authoring references and helper provenance.
Typography guidance changed; file formats and reference filenames remain
compatible. Upstream server, network sharing, archives and standalone helper
execution remain outside the App adapter. No Motion integration is added.

## Compatibility decisions

- Rebind the exact, fail-closed build patches to the new bundles: bounded wheel
  movement, local assets and font decoder, Unicode artboards, comment receipts,
  editor settlement and save acknowledgement. Pristine vendor bytes retain
  per-file hashes, notices and mixed-license attribution.
- Keep the opaque-origin frame and existing CSP. Project scripts do not gain
  App-origin access, native APIs, network fonts or an upstream HTTP server.
- Preserve existing native PPT selection. A Workbench destination or the word
  Design alone does not select Baoyu PPT. Explicit selection still uses the
  adapted skill. New typography guidance respects available fonts and script
  coverage; older installed editors are not promised the new Figma export.
- The new upstream standalone **Send all to Agent** control expects a new
  server endpoint and directly reports dispatch. It is omitted in the App;
  existing per-thread actions retain the reviewable composer-draft flow.
  Saving a comment does not send a message or start a model task.
- CLI impact: existing Workbench guide, exact-target operations, schemas,
  permissions and revision checks remain unchanged. Both updated skill resource
  sets remain in the shared App/standalone Host packaging allowlist.

## Privacy and provenance

New vendor files are compared byte-for-byte with the official source. The
scanner's numeric matches are compact SVG coordinates and codec profile
numbers, recorded by exact file digest and match fingerprint. Two narrow
Gitleaks entries recognize the new bundles' literal shortcut comparisons;
other paths, changed syntax and credentials in the same files remain detected.
Upstream removed the public Happy DOM example key from its worker. The existing
historical exception remains tested against its unchanged fixed digest because
older reachable revisions still contain that public fixture.

## Validation boundary

Completed locally on the updated source:

- 350 focused source tests across 40 files passed. The final adapter, skill
  installation, routing and packaging rerun passed 35 tests, including two new
  editor/skill provenance checks. Host and client production builds passed.
- 31 existing Chromium journeys passed: canvas/PPT editing, persistence,
  portable assets, Unicode artboards, real PPTX export, comments, wheel input,
  whiteboard narrow layouts and Markdown editing/import/export.
- Four independent asset/editor tests and six new upgrade tests passed in
  both Chromium and WebKit. These cover bilingual active editing and save,
  HTML for Figma, unsupported batch-comment control removal, and nine-slide
  phone navigation/order/reopening. Four existing comment/history journeys
  also passed again after the final adapter change.
- Six Electron quit unit tests and 17 isolated Electron runtime checks passed,
  including production CSP, opaque-origin isolation, local assets, Unicode,
  interrupted save and quit cancellation. This used a test runtime, not the
  owner's installed App.
- All 56 vendored editor/reference files matched the official source bytes.
  Production Host resource copying preserved all 36 skill files. Both skills
  were backed up, installed and read back at all three local engine locations.
- All 12 privacy regression tests passed; exact outgoing commits also require
  fresh staged/range, identity, version and full-history secret scans.

Two full WebKit journeys stopped at their pairing-code fixture before opening
the editor (the existing canvas flow and phone multipage flow). They are not
passes; independent real-editor WebKit tests above avoid that authentication
fixture and do not certify pairing. Physical iPhone and Windows acceptance is
still separate. No installed App, TestFlight build or release is changed.
