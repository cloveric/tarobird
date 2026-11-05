# New content beside workbench tabs (2026-10-31)

The new-content plus lived in the fixed action group at the far right of the
workbench, leaving a large empty gap after one or a few tabs. Move the existing
control after the tab list in a content-sized group. Only tabs scroll when the
group exceeds available width; the plus remains visible. The other actions
stay at the right edge. Keep the plus outside `role=tablist`, so arrow-key tab
navigation and selected-tab indexing still operate exclusively on tabs.

Move the unchanged creation menu under that group, anchored beside the plus
and bounded for narrow layouts. Keep the existing menu dismissal, keyboard
navigation, focus restoration, native-browser overlay marker, and import/file
picker path. Do not add a second plus. The control continues to offer webpage,
note, whiteboard and text import; mobile still disables native webpages.

Validation:

- Client build passed (existing chunk-size and Capacitor import warnings).
- Workbench usability: Chromium 10/10 passed. This includes previous focus,
  context-menu, phone actions, editor recovery and failed-save safeguards.
- Focused WebKit: 2/2 passed. These cover new-content geometry and existing
  Escape/Tab/arrow navigation.
- Added one regression for adjacency/vertical alignment, popup position,
  scroll extremes at 1360/1000/390/320 viewport widths, hit testing, focus
  restoration, and creation/reveal of the next active tab.
- Preview-only follow-up waited for editor content before capturing the two
  screenshots and reran that same regression successfully; it is not an
  additional distinct test. Screenshots are browser fixtures, not physical
  phone or installed Electron acceptance.

CLI impact: none. No Host API, Bot operation, data model or permission change.
No release or installed application update. Previews were delivered separately
with this boundary; production App/Host state was untouched.
