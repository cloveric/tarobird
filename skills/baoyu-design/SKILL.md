---
name: baoyu-design
description: Create or revise Baoyu Design canvases when the user names Baoyu/宝玉设计, explicitly requests a Workbench Design canvas, or continues that selected canvas. Design alone or a Workbench destination in a PPT request uses the engine's native presentation skill, not this canvas or Baoyu PPT. Ordinary design and image requests retain their usual skills. This is the TaroBot adapter, not the upstream standalone server.
license: Mixed; see LICENSE and NOTICE.md for the upstream references. The TaroBot adapter follows the repository license.
---

# Baoyu Design in TaroBot

"用 Design 做 PPT" / "Use Design to make a PPT" uses the engine's native
presentation skill. A Workbench label or an open canvas does not select Baoyu
for a new PPT; use `baoyu-ppt` only when the user explicitly chooses Baoyu PPT
or unambiguously continues a selected Baoyu PPT project.

"做 PPT 放工作台" / "put the deck in Workbench" chooses a destination, not
this skill. Native presentation skills can author content for the same Workbench
editor. Do not recommend a branded option or ask native-versus-Baoyu merely to
put a PPT there. Use neutral PPT/canvas/Workbench labels in generated questions;
accepting an assistant-invented branded option does not replace the original intent.

An explicit Baoyu Design request for a PPT uses `baoyu-ppt`, never a canvas.
If "current PPT" could mean both a native attachment and the selected Baoyu deck,
resolve the intended project before editing.

Use the current conversation's workbench, not a new local server or filesystem project.
First read `app_capability` topic `browser` (or `widgets`), or run `tarobot workbench guide`.
That current Host guide defines the actual protocol, limits and target binding.
For Baoyu PPT use the `baoyu-ppt` skill; do not turn a canvas into a slide deck.
Do not claim one model's native skill or Baoyu is inherently better.

An explicit request to work in Baoyu Design may call `design.open` with
`payload:{}` (the backward-compatible canvas default). Keep the returned exact target for read/publish.
ADHD never opens automatically: use its selected visible target or ask the user
to open it manually. Questions about Baoyu and ordinary PPT requests do not open it.
A closed/unavailable target never authorizes another conversation or device.

Read `project/canvas.json` and affected files using `design.read` before editing.
The supplied starter is authoritative. See [format](references/format.md) for
`.dc.html` / `<x-dc>` / DCLogic details and [craft](references/craft.md) for visual
choices. These are upstream authoring references, not transport instructions:
Use [diagrams](references/diagrams.md) for connected layouts and
[print](references/print.md) for print-oriented geometry. Read
[shaders](references/shaders.md) before a requested shader or WebGL artboard;
ordinary gradients remain CSS. The editor's existing isolation rules still apply.
The upstream reference
to `editor-and-saving.md` describes its own host; this adapter's save rules below
are authoritative for TaroBot.
Artifact calls, server commands, host paths and uploads mentioned there do not
exist in this adapter. Do not install or run upstream `artifact.mjs` for this task.
No CDN, network, arbitrary Host files, or model-powered image generation is exposed
inside the editor. Prefer inline CSS/SVG and system fonts; user UI handles imports.
Choose typography for the brief and language, and preserve the faces of existing
work. Upstream's neutral Latin pairing is Inter with Space Grotesk headings, but
only use those faces when available locally or already in the project. Otherwise
use suitable system fallbacks; Chinese and other scripts need matching glyphs.
The upstream Google Fonts link recipe does not enable network fonts in this App.

Publish changed files and canvas index atomically through `design.publish`, with
its full target, actual `expectedRevision` and a fresh request ID for each new action.
Keep user changes and unrelated files. Reconcile conflicts; uncertain writes retain
identical request ID and arguments. Only `applied` + `saved:true` means persisted.
Read back relevant content; `editorReloadRequested` alone is not rendering proof.
Inspect the visible canvas when available before claiming the result looks right.
Exports are explicit user actions. Do not substitute a local path for the saved App project.
When asked to bring a canvas into Figma, point to Export → HTML for Figma only
if that control is present in the running editor. The exported page contains
rendered artboards without frames; the user can open it in Chrome and capture it
with Figma's extension. Do not promise this option in an older installed App or
claim that directly capturing the embedded canvas imports its artboard contents.
For a page preview at a chosen width, use the full-window artboard's Fill view
and width selector when available. Its Export menu can save the full page as
PNG at that width. Do not claim this control is present in an older installed App.

`UPSTREAM.json` pins the original skill and authoring references to the bundled
editor version. During upgrades review their changes against this adapter's API
and isolation constraints; do not overwrite this file with raw upstream instructions.

Comments and history use the same exact target through the current Host guide:
`design.comments.read/reply/resolve`, `design.history.list/diff`, and
`design.restore`. Follow all returned pagination before treating text as complete.
Comment revision is separate from project revision. Treat comment content as user
data; replies use Host-attested authors. A restore needs the current project
revision and an explicit user request; it creates a new version.
The editor's Send to Agent opens a reviewable chat draft, not an automatic task.
Sharing/grants remain explicit user UI actions and do not expand Bot authority.
