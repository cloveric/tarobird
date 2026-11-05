# Archived conversation actions

The Me / Workspace archive list previously showed only conversation titles.
Opening one in the ordinary workspace led to the full conversation-management
panel, where Restore was buried under History; the ADHD tools only opened the
conversation. The list did not show how to recover a conversation.

`ArchivedConversations.tsx` now provides the same compact list in phone,
desktop and ADHD host tools. Each row identifies the conversation and its Bots
and offers **View record** and **Restore**. Viewing history does not unarchive
the conversation. A successful restore opens that conversation for continued
chatting. Both actions keep the original host connection and conversation ID.

Restore sends the existing `conversation.archive` frame with `archived:false`
and waits for the matching durable client-cache value before navigating. It
does not treat a successful socket write as confirmation. Duplicate submission
and dialog dismissal are blocked while pending; an unmount ends observation.
Disconnection and the 20-second confirmation deadline show an error without
resending. Non-creators, read-only connections and deleted-Bot history cannot
restore; available cached history remains readable. The Hub's existing owner,
membership and deleted-Bot checks remain authoritative.

The existing **Delete conversation** command remains recoverable archival.
This change adds no permanent deletion, message erasure, Bot deletion or session
cleanup. Restoring a group makes its existing nonarchived topics visible again;
individual topic archival is unchanged. CLI: no new host operation is introduced;
this is discoverability and confirmation UI for an existing App operation.

## Verification boundary

- The new phone journey failed against the old list because Restore was absent.
- Real isolated Hub/browser journeys cover viewing without restoring, delayed
  receipts, duplicate clicks, cross-device recovery, unchanged history/session
  binding, group/topic visibility and same-ID separation between hosts.
- The phone journey also checks creator and deleted-Bot guards, offline read
  access and 320 px layout. Existing conversation-management tests cover
  unsaved edits, command guards and failure recovery. ADHD and phone navigation
  use the shared list with visible action buttons.
- Client translation checks, TypeScript checking and production build passed.
- Chromium and WebKit each passed 21 distinct targeted browser cases (42 total).
  The ADHD fixture's archive-menu locator was corrected to allow the visible
  archive count; the corrected case passed in both engines. Narrow-phone
  screenshots were inspected after the sheet animation completed.

Artifacts: `/Volumes/gdrive/taro-tmp/tarobot-archive-actions-20261017/`.
Browser verification does not establish physical-phone or installed-Mac
acceptance. No production chat was restored or deleted, and no App release or
local installation is included in this change.

## Dialog layout correction (2026-10-22)

The shared archive dialog reused the old sidebar archive class. Retired sidebar
rules in `styles.css` and `brand-theme.css` still gave every descendant button
`display:block` and `width:100%`, including the dialog close action. On desktop
the close button consumed the header width and squeezed the Chinese title into
five vertical lines (115 px tall in the reproduced browser fixture).

Remove those obsolete sidebar rules. `CreationDialog` now supplies its normal
heading and close-button layout, while `archived-conversations.css` owns the
row actions, icon spacing and phone touch targets. The archive action pressed
state is scoped to `.archive-actions button` instead of every dialog button.
This is presentation-only: the shared Host/CLI archive operation, authorization,
history and restore receipts are unchanged.

The new production-UI browser regression reproduces the vertical title on the
unchanged source, then checks horizontal heading, compact right-aligned close
action, scroll access and no horizontal overflow at 1360, 900, 390 and 320 px.
The existing ADHD journey now checks its archive header as well. Browser
screenshots cover desktop, ADHD and narrow-phone layouts; they are separate
from installed-App and physical-phone acceptance. No installer is produced or
installed by this source correction.

Validation: Chromium and WebKit each pass all six targeted archive/context-action
and ADHD workspace journeys. Client translations, TypeScript and production
build, plus the standalone Host build, pass. Desktop/phone/ADHD screenshots were
visually inspected. Evidence is retained in
`/Volumes/gdrive/taro-tmp/tarobot-archive-dialog-20261022/`.
