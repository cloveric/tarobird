# ADHD pane-local history search — issue #74

Each ADHD conversation pane now exposes the existing “搜索当前对话” search
button, including its Cmd/Ctrl+F shortcut. The query and history filters belong
to that Workspace instance. Searching does not leave the board, add a pane,
change its conversation, submit its draft, or stop a running task.

The implementation reuses `useHistorySearch`, `/api/search/page`, the shared
message cache, and virtualized history navigation. Every page is scoped by
conversation ID; old responses are cancelled/ignored, and a host returning
another conversation's results is rejected by the existing compatibility guard.
No new search index, persistence format, permissions or Host API is introduced.

## Presentation and focus

- The ADHD stylesheet no longer hides the search trigger. Its existing
  accessible name and shortcut hint are retained.
- The search header keeps the pane's reorder, expand, open-in-single-chat and
  remove controls, including the original busy/unsaved-draft guards.
- Optional date/attachment filters live under “筛选条件” in ADHD. The keyword
  and Search button remain visible, and active filters are counted while folded.
  Ordinary chat retains its existing filter form.
- Closing search returns focus to its entry button. Only the active pane can
  autofocus search when visibility changes; returning from another expanded
  pane or a compact window no longer steals keyboard focus. Merely focusing a
  date field does not move focus to the keyword field.
- Pending-answer headers tighten their gaps while preserving every click
  target, the existing question/shield icon, title and host minimum width.
  The new search action cannot cover the pending-answer/approval control.

## Located words

Only pane-search result clicks carry a search query into message navigation.
CSS Custom Highlights paint matching text without replacing React DOM, changing
selection, altering copied text, or adding a whole-message outline. Matching
reuses the existing ASCII-case-insensitive/literal search rules, joins inline
text nodes inside each prose/code block, and keeps separate paragraphs separate.
Each pane removes only its own ranges. A single empty registry entry is retained
so that another pane with a temporarily unmounted virtual target keeps ownership.
Observers disconnect while the search target/view is inactive or unmounted.

Merged background tasks retain their original message IDs as DOM data attributes;
search location still reveals the existing group/member and highlights its task
name. Group records stay read-only and keep the original process/detail controls.

For a reply taller than the viewport, the first visible-text match refines the
initial message location once, using the virtualizer's public offset API. Reader
scroll/touch/key intent releases the request; live replies must not pull the
reader back to the word.

## Boundaries

- This is App presentation only. Headless CLI/Host search and adapters are
  unchanged; no additional CLI command or package release is needed for this
  source change.
- Keyword painting requires CSS Custom Highlight support (verified in current Chromium and
  Playwright WebKit). Older engines still search, show marked excerpts and locate the
  original message, but cannot paint words in the original bubble.
- With an empty keyword (date/attachment-only browsing), navigation locates
  the message but has no words to paint.
- A match present only in raw Markdown markup, transformed Bot IDs, hidden
  process data or metadata need not exist as visible text in the original
  message. The result excerpt still identifies the match; navigation keeps
  using the original message/group record. This change does not expand hidden
  process details automatically.
- Browser verification is distinct from installed Tauri/macOS, Windows, iPhone
  or Android acceptance. No installed App, production Host or database is
  changed as part of issue #74.

## Verification

- Unit tests: `client-search-highlight` and `adhd-board-state`, **8 passed**.
- Client translation check, client TypeScript check and production build passed;
  standalone Host build passed (451-module graph).
- Broad Chromium run: `adhd-board`, `search`, `message-focus`,
  `deletion-result-sync` and the first four `adhd-search` journeys: **59 passed,
  1 failed**. The failure exposed a real overlap between a narrow group's
  pending-answer control and its topic control after adding search. It was
  fixed without weakening that assertion. The subsequent focused run was
  **9/9 passed**, including both header suites and the new code-token,
  background-member and tall-reply cases.
- Final UI polish: all **7 ADHD search journeys passed in Chromium**; those
  seven plus the header suite passed **8/8 in WebKit**. The earlier WebKit run
  also passed ordinary search/scope rejection and narrow group/approval tests.
  One header-run reload produced an access-control error from an outstanding
  queue fetch after all geometry assertions had passed; the unchanged test
  passed on the final rerun. The failure trace was retained, not suppressed.
- Checks cover scoped pagination over 135 messages, old-message location,
  multiple simultaneous searches, late/unsupported responses, compact/expanded
  focus changes, drafts and attachments, an active synthetic reply, 3/6-column
  layouts, light/dark themes, larger reading size, syntax-highlighted code and
  original-message word contrast. App screenshots were inspected and delivered.
- Independent reviewer: Opus 5.5 xhigh, in a separate worktree and disposable
  Hub. Confirmed baseline defects and reviewed subsequent diffs/rendering.
  Review identified the long-message target, inverted Monochrome own-message
  highlight and keyboard-trigger ring; each was corrected and regression-tested.

Tests use synthetic accounts/messages and an in-process deterministic gateway,
not production conversations or live model calls. The existing development
cache was reused (including DOMPurify 3.4.16 and Zod 4.6.5); this was not a fresh
lockfile installation. No release/installed-App/native-device acceptance is
claimed. Final independent review status is recorded in the issue closure.
