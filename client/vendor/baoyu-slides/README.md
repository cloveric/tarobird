# Baoyu Slides vendor

Pristine Slides editor and authoring references from JimLiu/baoyu-design 2.12.2,
commit `64a874988262e558c9b071eb55b4d02038ca33f8`, aligned with the canvas editor.
`UPSTREAM.json` records every included byte. `skills/baoyu-ppt/UPSTREAM.json`
records upstream skill/helper provenance. The adapted entry loaded by Bots is
`skills/baoyu-ppt/SKILL.md`.

`client/design-assets.ts` verifies hashes and applies bounded, fail-closed patches
when emitting `slides-sandbox.html`. It selects the file-backed deck mode, keeps
comments on the tab-owned bridge, omits standalone chat/merge and batch dispatch,
flushes live text before saves,
resolves local image/font resources and connects user exports to the parent save
flow. No upstream server, external network, filesystem, account or share service
is installed. The editor runs under the existing opaque-origin Design loader.

Read `NOTICE.md` and the editor's `third-party-licenses.txt`: the root MIT license
does **not** grant a license to all reconstructed editor/reference/icon assets.
Do not describe this integration as entirely MIT.

Upgrade together with the canvas editor and both adapted skill manifests. Review
upstream SKILL.md and authoring references; test real render, manual edit/quit,
Bot publish, format selection, assets, export and isolation before release.
