# Infinite Canvas integration

The Workbench editor is built from the complete upstream commit listed in
`UPSTREAM.json`. The build extracts the web application, workbench, shared,
model runtime, SDK and three bundled node contributions from that commit.
The upstream pnpm lock is verified before frozen installation with lifecycle
scripts disabled. The upstream MIT notice and the complete bundled dependency notices ship in
the optional HTML artifact and are available in the canvas under Settings →
Plugins → Open-source licenses. The same texts appear in the App
acknowledgements.

`node scripts/build-infinite-canvas-plugin.mjs` builds the optional artifact.
Use `--candidate` to build the two-line sidebar brand locally under
`dist/plugins/tarobird.infinite-canvas/1.0.1-preview.1/`. The default still
reproduces the catalog-pinned 1.0.0 bundle.
Set `TAROBIRD_INFINITE_CANVAS_SOURCE` to a local Git checkout containing the
same commit to build from the review fixture. The build reads the committed
tree and never modifies that checkout. The builder requires the pinned pnpm
version and Git. It emits the HTML bundle, its byte-count/SHA-256 manifest, the upstream MIT
license, and the bundled npm dependency notices. The fixed on-demand
release location is tag `infinite-canvas-v1.0.0`, asset
`infinite-canvas-1.0.0.html` (publish the verified bytes of `bundle.html`
under that release filename). Publish the generated `LICENSE` and
`THIRD_PARTY_NOTICES.txt` alongside it.

The release manifest and compiled installer catalog use the same
`client/src/infinite-canvas-catalog.json` template. The release uses the
actual artifact bytes for the digest and size. The installer pins them from
`client/src/infinite-canvas-artifact.json`.

The verified asset is 15,474,355 bytes with SHA-256
`2a2880c343c8d740865f48a6fadf63aa2392cc1f308256505b4a7a5d81605fcb`.

`patch-upstream.mjs` records the changes to the imported source. It uses the
native upstream routes, views and canvas commands. The `overlay` contains the
TaroBird-specific adapters.

- Use memory routing inside the opaque Workbench frame. The original logo,
  name and author identify the editor.
- Use App-scoped storage for journals, preferences, project archives and media.
  Store channel secrets through the separate credential host method and omit
  them from configuration exports. No cross-device sync.
- Use the existing upstream v12 Agent commands and transport those calls by
  TaroBird's conversation-scoped bridge rather than launching upstream's local
  server.
- Bundle upstream Panorama, Multi-format Renderer (HTML, Markdown, SVG), and
  template note node at build time. Use a separate TaroBird adapter for
  third-party nodes and exclude the upstream same-frame plugin loader. HTML
  preview accepts only sanitized structural elements.
- Use the pinned upstream OpenAI-compatible model implementations compiled as
  functions at build time. Runtime can call only the permitted provider via
  the App broker. The bundled manifest declares `api.openai.com` and actual
  access depends on the user's grant. User-supplied gateways, object storage,
  and realtime model streaming require separate transport.
- Upstream prompt JSON sources are disabled initially. After the user grants
  `raw.githubusercontent.com` and enables a listed source, the dedicated broker
  can load its text records. Arbitrary source URLs, covers, and reference-image
  loads are excluded.
- Remove channel sponsor presets, upstream analytics, and upstream version checks. TaroBird controls updates to the pinned artifact.

## Third-party node files

Third-party nodes are disabled by default. Open the canvas, then open its
Settings → Plugins tab. Review the warning and enable them there. For each installation, review the source address
in the canvas, then the verified immutable source and SHA-256 in the App
confirmation. Supported URLs use the form
`https://raw.githubusercontent.com/<owner>/<repository>/<full-commit-sha>/<file>.js`.
Disabling preserves installed records. Uninstalling removes the installed
module. Existing canvas nodes retain their texts and selected plug-in IDs.

Add a Third-party Node from the native editor and double-click it to choose an
installed module and write its input. Select that node and press Run. The
isolated interpreter receives only the selected node's `text` and optional
`title`. A synchronous JavaScript file must define either
`function render(node) { return { text: node.text }; }` or
`export default function render(node) { return { text: node.text }; }`.
The return value must contain `text` and may contain a `color` in
`#RRGGBB` format. Text and output are limited to 16,384 UTF-16 characters
each, and the optional title to 160. The App bounds execution. The source
does not run during installation and has no DOM, network, OS access or imports.
The canvas only renders the returned text and approved hex color.

## Dependency notice sources

The notice build reads licenses from packages in the bundled inputs and
checks that the result matches the copy used by App acknowledgements,
`notices/BUNDLED_DEPENDENCIES.txt`. To update that copy after a dependency change,
run the builder with `--refresh-notices`, review the diff, and then build the
artifact normally. The following repositories supply complete texts for
packages whose tarballs only reference the license or omit its text.

- `@ai-sdk/provider-utils@5.0.70` uses the [AI SDK release notice](https://raw.githubusercontent.com/vercel/ai/@ai-sdk/provider-utils@5.0.70/LICENSE).
- `@uiw/codemirror-extensions-basic-setup@4.25.12` and `@uiw/react-codemirror@4.25.12` use the [React CodeMirror release license](https://raw.githubusercontent.com/uiwjs/react-codemirror/v4.25.12/LICENSE).
- `react-remove-scroll-bar@2.3.8` uses the existing TaroBird notice copy, verified against the [publisher's license](https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/master/LICENSE).
- The separate [Apache License 2.0 text](https://www.apache.org/licenses/LICENSE-2.0.txt) covers the listed Apache-licensed packages, including [Workflow SDK](https://github.com/vercel/workflow/blob/main/LICENSE.md).
