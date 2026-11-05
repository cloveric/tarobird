# Workbench names and narrow empty-state actions

The owner's 1.0.129 screenshot showed the empty Workbench's five creation buttons
extending into the conversation and beyond the right edge. The horizontal flex
row had no wrapping, and button labels broke onto multiple lines while still
overflowing a 320px panel.

The row now wraps within the panel and centers each row. Buttons retain their
labels on one line. This applies to the shared Workbench empty state; existing
tab-strip scrolling, menus, panel resizing and platform density tokens stay intact.

Product-controlled labels use **画布 / Canvas** and **PPT**. New-content actions,
import/sharing descriptions, default new-project titles, iframe document titles,
error messages and generated comment/request drafts no longer show the upstream
brand. Existing user project titles/content are not rewritten. Upstream names
remain in licenses, technical identifiers, vendor paths and skill names.

Skill selection is unchanged: ordinary “用 Design 做 PPT” uses the engine's
native presentation skill; an explicit Baoyu/宝玉/clear 宝育 PPT request selects
`baoyu-ppt`. The UI names do not select a different engine or grant access.

CLI impact: the shared default title used when creating an unnamed project is
neutral too. Commands, formats, schemas, permissions and stored identities are
unchanged; no new CLI operation is needed for this presentation repair.

## Validation

Evidence is retained under
`/Volumes/gdrive/taro-tmp.noindex/workbench-labels-20261104/`.

- Before changing production code, Chinese/English browser regressions and the
  desktop screenshot reproduced branding, overflow and wrapped button text.
- Client production build (including type/translation checks) and Host production
  build passed. Focused client/protocol/routing checks: 6 files, 50 tests passed.
- Chinese/English real-editor entry journeys passed: neutral new-project labels,
  canvas edits/undo/redo, PPT opening and tab switching preserved the edited text.
- Chromium and WebKit: 4 unique layout journeys passed per browser (Chinese and
  English desktop/phone). Desktop checks cover a 320px panel and drag enlargement;
  phone checks cover 390px and 320px viewports. Screenshots were visually checked.
  The first three cases passed on both engines; English phone passed after the
  fixture explicitly returned from Settings/Me to its conversation. This was a
  test navigation omission, not a product repair or relaxed layout assertion.
- The initial layout harness combined a mocked desktop bridge with phone viewport
  resizing and timed out after the valid desktop observations. The final harness
  uses separate desktop-capability and phone browser contexts. Original logs are
  retained; this is not described as an unchanged retake.

These are source/browser checks, not installed-App proof of the new labels.
No version, release or installation was performed for this change. The owner's
installed 1.0.129 remains bound to its published source, and its pending fullscreen
acceptance remains separate.
