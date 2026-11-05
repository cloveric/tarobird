# Main and side input alignment — 2026-10-23

The side editor retained a taller two-row minimum and extra bottom padding.
Its Esc hint also occupied a separate footer row. The resulting input outline
and send button sat higher than the main composer, even with both drafts empty.

The side composer now uses the shared composer wrapper and draft measurement
hook. Its idle field floor follows the main desktop editor's one-line geometry
while keeping side text at its existing size. The extra lower padding is removed,
and the outside bottom inset matches the main composer. The Esc hint lives in
the spare toolbar space; upload and offline status take precedence there. Long
hint text can truncate rather than push the controls out of the panel.

Both empty or single-line inputs align at ordinary desktop widths. Multiline
text, attachments, recording UI and wrapped toolbars can grow independently;
the bottom edge stays anchored. Oversize input feedback appears above the side
composer. The shared measurement hook avoids collapsing the focused live field
to measure it and remeasures on width, appearance and visibility changes.

Main, phone and ADHD input styling is unchanged. Side font size and its temporary
session semantics are unchanged. CLI impact: not applicable; this is client
presentation only, with no Host, protocol, command or engine changes.

Validation evidence: `/Volumes/gdrive/taro-tmp/side-composer-alignment-20261023/`.
The new alignment journey failed on the prior source's bottom-edge mismatch.
It now checks equal idle heights, bottom edges and send-button baselines at two
desktop widths and two saved reading sizes, including multiline expansion,
shrinking, unchanged side typography and Escape returning focus to the main
input. The corrected light and dark screenshots were inspected.

All 27 journeys in `side-conversation` and `composer-size` passed in Chromium,
and all 27 passed in WebKit. Existing coverage includes attachments, paste/drop,
recording, narrow layouts, conversation switching, pending replies, stop/close,
palette changes and main-message reading stability.

The client translation/type/production build, staged secret scan and whitespace
checks passed. No installed App was
replaced and no running Host was restarted. Browser tests do not establish
native desktop or physical-phone acceptance.


## October 24 follow-up: text above, controls below

Desktop main and side composers now share one scoped vertical-spacing rule.
Their prompt/input text sits higher, while the complete toolbar row (attachments,
voice, shortcut/status, model controls and Send) sits closer to the bottom edge.
Both rows redistribute their existing padding; the input outline, total idle
height, draft growth/cap, font sizes and button sizes stay the same. Terminal-theme
prompt marks follow the text offset. Native iPhone/Android, ADHD panes and queue
edit dialogs keep their own spacing. CLI impact remains not applicable: CSS only,
without Host/API/engine changes. This follow-up is source-only, not an App install.

Follow-up validation: the existing targeted composer sizing/alignment and queue
editing journeys passed **8 Chromium + 8 WebKit** cases; the client production
build (including translation/type checks) passed. The paired-composer screenshots
were inspected. Evidence: `/Volumes/gdrive/taro-tmp/composer-spacing-20261024/`.
