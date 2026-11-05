# Avatar remains active after answering a question — 2026-10-31

The owner reported a still avatar while the conversation showed a task in
progress, after submitting a native selection card. The main reply started at
09:04:27; a separate question card was created at 09:04:57. The main reply was
still streaming at the screenshot time and finished at 09:14:40. The installed
App is 1.0.122; this change does not modify it.

`ConversationActivity.replies` retains only the newest message per Bot by
creation time. A newer question, resolved receipt, attachment, or queued reply
could replace an older streaming main reply. Further updates to that main
reply did not recover the avatar because the same creation-time guard rejected
it. The question's attention state could still animate while open; once answered
and read, the row incorrectly became idle.

`workingReplies` now retains active message IDs and timestamps independently.
A terminal update removes only its own entry. Open questions/approvals retain
priority; after resolution the still-running task animates again. Existing
finished/unread precedence, queued-message behavior, forwarded/Agent Bus record
exclusion and the device-local animated-avatar switch remain unchanged.

Existing reply caches backfill this field once through the IndexedDB `status`
index, reading only streaming messages. The batch query is shared across all
conversations needing the field. It does not reread completed histories or
change their bodies, previews, preferences or unread markers. Caches predating
the original reply/attention metadata still use their pre-existing one-time
history projection. Full snapshots reset the active map; merge snapshots and
live updates maintain it without dropping other active messages.

This is a client display/cache fix. The Host protocol, scheduling, model and
headless CLI behavior are unchanged; a new CLI command is not applicable.

## Verification

- The unmodified implementation failed two focused regressions: newer cards
  hide running work; settling one reply hides a parallel running reply.
- 11 focused logic cases passed (`client-agent-state`, `client-avatar-face`).
- 7 Chromium and 7 WebKit cases passed. The desktop, iOS and Android layouts
  cover pending question priority, resolved/read cards, newer delivery receipts,
  reload, real CSS transform progression and terminal cleanup. Additional
  IndexedDB cases cover the one-time indexed upgrade and full/merge snapshots.
- Client translation/TypeScript/production build and Host standalone build passed.
  Existing large-chunk and mixed Capacitor Keyboard import warnings remain.
- Browser desktop/iOS/Android layout checks are not physical-device acceptance.
- No release, installed App update or model call is part of this change.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/avatar-active-task-20261031/`.
