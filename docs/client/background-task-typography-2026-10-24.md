# Background task description typography

A standalone background review card could show a native completion summary as a
500-character task label. `ensureReviewScope` passes `task.summary` into the
scope label; the App displayed that metadata in one unlimited paragraph at
weight 550. Markdown markers were literal text. This explains the reported
phone screenshot without treating it as a grouped-card or model-output failure.

`ScopedTaskDescription.tsx` now presents short task metadata in regular type.
Long or structured descriptions have a two-line plain excerpt, a muted label
and an explicit expand/collapse button. Expanded text uses the existing safe
Markdown renderer with paragraphs, lists and inline emphasis; headings stay at
the description's reading size. The original stored label is never rewritten.
Layout overflow is measured at the current width so shorter descriptions remain
accessible when the viewport narrows. A new label resets its disclosure state.
The disclosure mounts Markdown only when opened and retains keyboard focus.

The expandable section follows the chat scrollport rather than adding another
nested vertical scroll area. This is an intentional departure from the reviewer's
suggested height cap: expansion is explicit, input labels are already bounded,
and the recent mobile task-dialog fix removed competing scroll containers.

The former label's reading size is retained; only its weight and layout change.
This is scoped to standalone task metadata, with no changes to ordinary reply
fonts, platform density, grouped rows, status strips or process-reader typography.

## Preserved boundaries

The A+C grouped cards, per-round ownership, completed receipts, five-row limit,
per-task readers and offscreen dock are unchanged. The recently unified native
manager entry and its independent counts/control handles are unchanged.
Background cards remain read-only. No engine, queue, stop/recovery, scope/origin/
provenance checks, persistence, schema, capability, grouping or forwarding change
is needed. Existing history receives the presentation fix on render.

CLI impact: not applicable; this is App-only metadata presentation. The headless
Host, native protocols, reply text, copy/export and task-control APIs are unchanged.

The producer already caps labels at 500 characters and may cut Markdown mid-block.
Expansion means the complete stored label, not recovery of text never persisted.
Full reply readers remain separate and copy only the actual reply. Compact group
rows keep their existing labels and accessible names in this scoped correction.

## Validation

A pre-fix browser regression reproduced weight 550 on the reported long-description
shape. Focused unit/browser checks cover text classification, responsive clipping,
regular weight, parsed paragraphs/list/code, keyboard disclosure/reset, long URLs,
and an unfinished Markdown fence. Existing grouped-card, unified manager, source,
report and scoped-process cases verify the retained interaction boundaries.
Validation results:
- 96 focused unit cases passed across four files.
- 52 Chromium browser cases passed; the final five description cases were
  repeated after the responsive-focus and actual-theme assertions were refined.
- WebKit covered the same 52 cases. The initial run had 47 passes, four new
  assertions that incorrectly expected pointer clicks to focus Safari buttons,
  and one existing overscan test that timed out entering history with Home.
  All 25 background-report cases passed after testing keyboard focus through
  keyboard activation. The unchanged overscan case passed its targeted recheck.
- Host and client type/translation/production builds passed. The existing
  Capacitor keyboard import warning remains non-blocking. Fixture-only KaTeX
  font allow-list warnings did not prevent the existing formula-reader checks.
- Dark/light screenshots assert actual background paint. These are browser
  fixtures, not native phone acceptance.

Independent Opus 5.5 high reviewed the root cause, implementation and final
phone/desktop screenshots. No blocker was found; the reviewer identified an
expanded-description font-size override in terminal themes and ADHD. A local
metadata-only font rule now prevents that jump while preserving actual reply
reading preferences. Ten palette/ADHD cases cover this distinction. The final 35 background-report
cases passed in both Chromium and WebKit after the theme rule landed. Combined
with the retained 27 grouped/scoped cases, coverage is 62 cases per browser.
The full repository/native suite was not rerun for this App presentation change.

Source/browser verification is separate from release, installation and physical
Android/iPhone acceptance. This change does not install or restart the App.
