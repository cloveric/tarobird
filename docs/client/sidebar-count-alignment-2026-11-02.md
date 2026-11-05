# Sidebar count alignment

In the Bot list, a folded ordinary Bot reserved space for its create-conversation button, while a Chancellor had no trailing action. Section headings used a different trailing inset. As a result, Chancellor and group counts appeared farther right than ordinary Bot counts.

All Bot rows now reserve the same non-shrinking action width; the Chancellor's empty space is decorative and not focusable. The original change also aligned Bot/group heading totals; the 2026-11-03 follow-up removes those heading totals entirely in both single-host and combined lists. Source-host badges precede the folded signals, so varying host-name widths do not move the count column. The existing phone-sized action width is retained below the sidebar breakpoint. Folder/inbox counts and mobile-home layouts are unchanged.

This is client presentation only. It changes no count values, conversations, dispatch behavior, permissions or CLI command.

## Validation

- Isolated Hub/browser visual readback reproduced the original offsets: Chancellor +28px and section headings +24px relative to ordinary Bot counts. After the change, all four right edges were 229px in both Monochrome and CLI themes. Screenshots and geometry receipts are retained in the private task lab.
- Client production build and root standalone build passed.
- Existing `bot-conversation-folds` browser regressions cover folding/drafts, unread/attention, multi-host identity, empty/pinned Bots, unavailable storage, narrow themes and pin round trips. All 8 distinct cases passed in Chromium and all 8 in WebKit across the initial successful cases and unchanged retakes (16 total); each retake was 4/4.
- The first concurrent run timed out in pairing/cache setup for the first two cases in each browser. Four subsequent cases passed in each; the runners were then interrupted. Those initial logs are retained. Failed and unfinished cases are retaken unchanged with no assertion or timeout edits.

This change is after the immutable 1.0.127 release freeze and is not present in its published or staged App. No additional release or local replacement is performed by this UI fix.

## 2026-11-03: simplify section headings

The Bot and Groups headings now show only their names. Individual Bot conversation
counts, unread/attention signals, section context menus and group rows are unchanged.
The unused heading-count inset is removed. Chancellor rows retain the same decorative
trailing action space as ordinary Bot rows, so their individual counts align.

This remains a desktop sidebar presentation change with no Host/CLI behavior or
phone-home change. The installed 1.0.127 App is not replaced by this change.

Follow-up verification:

- Client production build and `git diff --check` passed.
- Two existing Chromium regressions passed: host grouping/identity isolation and
  compact-sidebar/theme behavior.
- Temporary real-component visual/geometry probe passed. Bot/Groups headings had
  no child count in single-host, combined-host and host-grouped layouts; retained
  individual counts all ended at x=229 px, including the Chancellor. Monochrome
  and CLI previews were inspected. This is isolated browser evidence, not an
  installed-App or physical-phone update.
- The temporary probe and screenshots are retained in the task lab. No permanent
  test was added for the removal of decorative heading totals.
