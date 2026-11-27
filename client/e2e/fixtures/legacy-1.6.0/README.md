# Projects written by TaroBird 1.6.0

Fixtures for `client/e2e/workbench-legacy-1.6.0.spec.ts` and
`client/tests/workbench-slides-legacy.test.ts`. They are real output of the
1.6.0 App (tag `v1.6.0`, commit `29e277d6`) and its two Baoyu editors, which
this tree no longer contains. Do not edit them by hand: a test that passes on a
retouched file says nothing about a 1.6.0 user's project.

## How they were produced (2026-11-27)

`generate-in-v1.6.0.spec.ts.txt` is the Playwright spec that made them. It only
runs in a checkout of `v1.6.0`:

```bash
git worktree add --detach <dir> v1.6.0          # dependencies: the lockfiles of 1.6.0
cd <dir>/client
npx vite build --outDir <build>
cp <this directory>/generate-in-v1.6.0.spec.ts.txt e2e/zz-legacy-fixtures.spec.ts
LEGACY_V160_DIST=<build> LEGACY_FIXTURE_OUT=<out> \
  npx playwright test e2e/zz-legacy-fixtures.spec.ts --workers=1   # Chromium
```

It pairs a browser with a fixture Host of that version and, in the 1.6.0
Workbench:

| Files | What was done in 1.6.0 |
| --- | --- |
| `plain-deck.*` | `+ → PPT`; tab renamed; cover title typed over by hand in the old editor; a 96 × 64 PNG uploaded through the old editor's own asset upload; four slides (text with bold and italic runs, a list and speaker notes; a painted box, arrow, ellipse, diamond and line; a table; the picture) published the way a 1.6.0 Bot did, with `design.publish`; then by hand in the old editor: a heading and a paragraph typed over, `Shapes → Rounded rectangle` and `Table` from its toolbar. Every slide file is therefore in the old editor's own saved form. |
| `design-system-deck.*` | `+ → PPT`; cover typed over; the design system in `design-system-source.stored.json` installed with the App's `设计系统` button, which copies it under `project/ds/system-brand/` and records it in `deck.json`; a slide using the system's logo by path and its colours published with `design.publish`; its paragraph typed over by hand. |
| `canvas-project.*` | `+ → 画布`; tab renamed; the heading typed over by hand in the Baoyu Design canvas editor. |

For each project there are two files:

- `*.tarobot-design.json`: the file the 1.6.0 App itself downloaded when its
  `备份 PPT 项目` (decks) or `导出设计` (canvas) button was clicked.
- `*.stored.json`: the records the 1.6.0 App left in IndexedDB (database
  version 13) for that project, read back raw: `document` (store
  `workbenchDesign`), `meta` (`workbenchDesignMeta`: history), `objects`
  (`workbenchDesignObjects`) and its `tab` from the conversation's layout. The
  scope key is left out: it names the fixture Host and user of that run.

`design-system-source.stored.json` is the one file that 1.6.0 did not write: a
design-system source was written into the 1.6.0 App's storage by the generator,
because no code path was found in the 1.6.0 client that creates one (its
sources only validate, list and install a stored `format: "design-system"`
project). The copy inside the deck was made by 1.6.0.

## What 1.6.0 itself did with them

Recorded so that a difference in this build can be told from a 1.6.0 limit:

- The logo slide of the design-system deck stays editable in 1.6.0 but the logo
  is not painted there: it shows the picture's name only. Pointing a slide at
  the system's uploaded asset instead, as `/project/ds/system-brand/assets/<id>`
  or without the leading slash, makes 1.6.0 mark the slide "can't be edited
  right now"; such slides are not in the fixtures.
- The dashed rule published as `<hr … dashed>` was saved by the 1.6.0 editor as
  a solid `<x-shape kind="line">`.
- A shape inserted from the 1.6.0 toolbar is stored as
  `top:50%; left:50%; …; transform:translate(-50%, -50%)` and 1.6.0 draws it
  centred on the slide.

The identities in the files are the fixture's (`Owner`, `Bot`); there is no
real Host, user or device in them.
