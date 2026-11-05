# Reading while a Bot is running

The phone report was that neither scroll direction worked during thinking.
Two shared presentation paths were writing or re-enabling scroll position:

- `Workspace` re-enabled following whenever the viewport was within 80 pixels
  of the bottom, including the first movement of a pull toward older content.
  Publishing another run paragraph then moved the viewport back down. A
  pre-fix browser reproduction moved native and legacy card readers by more
  than 400 pixels while their fingers were still down.
- The process reader assigned `scrollTop` after every journal refresh, even
  when the offset was unchanged. Native scrolling must be allowed to own that
  position during a swipe and its momentum.

The chat now pauses follow writes while a touch is active, keeps manual history
reading across updates, and resumes only after an intentional return to the
actual bottom (2 pixel rounding tolerance) or the existing latest-message
button. Small gesture deltas accumulate; touch end/cancel clears touch tracking.
The shared viewport covers all Bot engines and both run-card formats.

The process reader restores its saved position in a layout effect after rows
commit, on entry and page/search changes only. Ordinary live refreshes leave
the scroll offset to the browser. Closing and reopening retains the position.

Regression coverage includes native/legacy streaming cards, both swipe
directions under Chromium's trusted touch input, explicit and manual return to
latest, delayed Markdown measurement, desktop typing, queue rows, conversation
switching, process refreshes and reopening. WebKit covers the DOM scroll and
touch-event behavior; these browser checks do not certify physical phone
inertia or an installed APK.

The conversation-entry fixture's explicit chronology now updates both the
message snapshot and replay journal. Its old snapshot-only timestamps let
cold replay put the intended last message in the middle of the list; this also
failed against the pre-change client.

This is a source change. Native installers and physical-device acceptance are
separate release gates; no running host or user conversation is restarted.
