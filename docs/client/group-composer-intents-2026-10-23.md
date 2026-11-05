# Main group composer intent audit — 2026-10-23

The main group composer now records an edit identity separately from its text.
An unchanged uncertain send reuses the exact Hub request across navigation,
reload, discussion completion and later mode changes. Clearing and retyping the
same words, changing attachments or changing a quote creates a new edit identity.
A note remains bound to the discussion that was active when the draft began;
a completed discussion cannot silently turn that note into a new discussion.
The user must select the offered rebind action and then explicitly send.

Text and intent share the existing batched settings transaction. Files stay in
the existing rich-draft store; typing does not copy their bytes. Compare-and-set
writes and conditional cleanup preserve newer edits and reject stale windows.
An unchanged pre-upgrade draft may migrate its old signature-only receipt; the
first explicit edit retires that compatibility behavior.

Confirmed Hub success is separate from local cleanup failure. Identity or rich
attachment conflicts block a new send before HTTP, but local attachment quota
failures retain the established ability to upload legal files from memory.
Transient text-save failures can be retried. Malformed intent or pending-send
state retains the visible draft and offers an explicit check-and-reset action;
refreshing or pressing the regular Send button never discards uncertain state.
Internal pending receipts do not appear in user draft previews or counts.

## Evidence

Opus's two actual UI-to-Hub repro cases failed before the fix: clearing and
retyping identical text called the old start route; a note composed during a run
became a new run after completion. Both now pass on phone and desktop widths.

Focused Chromium and WebKit: 23 passed each, followed by 5 passed each for the
final receipt-statistics and in-flight-edit additions. The incremental set
repeats three existing safety cases, so this is 25 distinct cases per engine,
not 28 distinct cases. Coverage includes exact request ID replay after reload
and mode change; explicit new-discussion conversion; attachment-only notes;
real browser MediaRecorder and phone hold-to-talk; malformed state recovery;
pre-send conflict, post-send cleanup conflict, quota failure, temporary storage
failure, concurrent edit preservation, and unchanged direct-chat draft/voice
behavior. Client build and `git diff --check` passed.

The browser tests run an isolated real Hub/Gateway queue with scripted model
outputs and a synthetic microphone using each browser's actual encoder. They do
not establish physical iPhone performance, real ASR availability, or real-model
acceptance. No running App/Host or user data was changed. CLI is unaffected: this
change records editable App draft intent; existing `groups start` and exact-run
`groups note` already use the shared Hub APIs.

## Cleanup concurrency follow-up

A review after the offline-guard merge found that the successful-send clear was
not part of the text-write queue. An edit made while its IDB tombstone was being
returned could compare against the old revision. Retyping identical text also
let the cleanup remove the new edit's unsaved marker, incorrectly displaying
“saved”; reloading then lost that new text.

Cleanup now joins the same per-conversation write tail. Later edits observe only
the tombstone produced by that successful local clear; a foreign window's
revision is never adopted. Clearing the unsaved marker requires the original
edit identity, not merely equal text. Two regressions pause after the actual IDB
clear commits and retype identical text; one also introduces a genuine foreign
write. Both failed before the fix and pass in Chromium and WebKit (2 each).
The normal path restores the new text after reload and sends it as a note; the
foreign path retains the local text and conflict without overwriting the foreign
draft. Client build and diff checks also pass. This is additional coverage beyond
the focused cases above.

## Observed mode changes

The final Opus review reproduced an additional draft-intent change: an ordinary
message addressed to one Bot became a full discussion after another device
changed the group mode, even when this App had already displayed the new mode.
The reverse direction silently became an ordinary message with no recipients.
The draft now requires the existing explicit rebind action when its original
ordinary/parallel versus automatic-discussion category changes. Repeated Send
clicks do not confirm the change. Same-category revision changes keep the
existing retry behavior; active-run notes and original uncertain receipts keep
priority. Recovery buttons continue to describe the current mode.

Text-draft compare-and-set conflicts now use the existing readable multi-window
message instead of exposing `draft_changed_elsewhere`. The stored error,
revision checks, retained local draft and explicit retry behavior are unchanged.

Both category-direction cases failed before the fix. Six focused cases passed in
each of Chromium and WebKit: the two directions, a mode change during upload,
original-receipt replay, a same-category order revision, and the genuine foreign
write conflict. Five passed in the first run; the reverse-direction case passed
on its focused rerun after normalizing the protocol's optional empty `mentions`
field in the assertion. Client build and diff checks passed.
