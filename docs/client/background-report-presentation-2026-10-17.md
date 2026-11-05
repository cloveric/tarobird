# Background reports: compact chat presence, complete reading surface

October 22 copy revision: the full-text entry now says **查看完整回复**.
The reader uses **后台任务结果** / **子代理回复**, **回复摘录**, **复制回复**,
and **关闭完整回复**. This is client wording only (CLI not applicable); stored
reply bodies, including legacy wording, and open/copy/focus behavior are unchanged.

## Problem and verified boundaries

Completed scoped/background cards rendered all intermediate prose and the final
report in the chat timeline. The reported ADHD pane could therefore be occupied
by one long secondary report. A 390px isolated fixture reproduced the unbounded
card before the change.

The scoped renderer also omitted `backgroundSource`, while the conversation
suppressed its generic reply reference for bound background reports. The only
remaining source text was a noninteractive producer notice. The new renderer
restores the validated source link.

## Presentation

- Scoped reports show task kind, factual phase, duration, source request and up
  to three lines of literal text (latest public progress while active, the report
  opening after completion). No generated summary or guessed final paragraph.
- Plain short reports that actually fit are fully visible without an extra
  reader button. Long or formatted reports offer **Read full report**.
- Report text is read from persisted message blocks. It remains accessible when
  the process journal expires or the connected Hub lacks scoped-process support.
- **Process** retains the existing journal, pagination, search, refresh and export.
  No journal is fetched merely to display or open the public report.
- Source-unconfirmed text is visible, including the distinction from the current
  request. A deleted, missing or different-conversation source never becomes a
  clickable reference. The full reader also supports source navigation.
- Failure, waiting, disconnection and unavailable-process states remain visible.
  Scoped `partial` means **Final status unconfirmed**: the existing producer uses
  it for updates/unknown outcomes and unconfirmed delivery, not only partial work.
  Foreground `partial` retains its existing meaning and presentation.
- Live prose uses fixed preview height; long current-action labels are ellipsized
  without hiding waiting/error status. No background stop is wired to the
  foreground task.
- Legacy text-only background reports use the same preview and full reader.
  Interactive/mixed-element cards retain their existing renderer and controls.
  Unmarked plain text is not heuristically classified as a background report.

## ADHD and lifecycle

The desktop reader is a full-height side panel outside the narrow conversation
tile. On phones it occupies the available viewport with safe-area padding and
44px touch actions. ADHD metadata follows its own font preference; it does not
change ordinary-chat typography.

Opening a reader retains only its message row in that Workspace's virtual range.
Incoming messages can move the visible range without unmounting the reader.
Closing, deletion, conversation/host changes or loss of process support release
the relevant state. The key includes host public key, device, conversation,
message and run, preventing same-ID collisions and automatic reopening on return.

Closing normally restores the triggering control. A virtualized message that
still owns keyboard focus remains mounted until focus leaves and the range is
recomputed; closing a reader after many new messages does not drop focus to the
page background. If a live report finishes as
a short result and that control disappears, focus returns to an existing process
control or the card. This transition was reproduced failing before the fallback
and passing after it. Source navigation closes the reader before locating the
original message. Other panes retain drafts and focus through live updates.

## Integrity and scope

Stored blocks are unchanged. Copying the report reads the complete report prose;
message copy, forwarding and exports retain their existing original-block path.
Sibling file/image blocks remain outside the collapsed prose. The reader never
depends on the journal's 30-day/2000-event/8MiB retention limits.

CLI applicability: **not applicable**. This change is client presentation and
virtualized-reader lifecycle only; there are no new commands, host endpoints,
credential rules or delivery/queue semantics. Desktop and headless hosts keep
the same existing protocol. No engine transcript, thought stream or production
message was modified for testing.

The host does not always provide a reliable final-result versus progress boundary
inside the public report. This change preserves that text and labels its preview
as an excerpt. Structured result/progress fields remain a future host change;
the client does not infer them from headings, English narration or the last line.
Live producer bodies retain a rolling 12,000-character window. Reading an active
report can still be affected when that producer window advances; this change does
not add a frozen snapshot or change the producer retention policy.

## Review and verification

Actual independent review used CC1, configured as `claude-opus-5-5[1m]` with
`xhigh`, in a separate authorized review conversation. First review identified
the missing scoped source link, static-card compatibility, journal-retention
boundary, visible unknown-source notice and scoped partial-status ambiguity.

Verification logs and screenshots live on the mounted disk at
`/Volumes/gdrive/taro-tmp/tarobot-background-ui-20261017/`.

Validation:
- 66 focused unit checks (`run-presentation-ui`, `scoped-run-presentation`) passed.
- Chromium broad regression: 69 passed; final changed-path rerun: 10 passed.
- WebKit broad regression: 62 passed and two local fixture resource-access errors
  (`/health`, Markdown worker) failed the page-error assertion. Both cases passed
  an unchanged isolated rerun. No assertion or product transport was relaxed.
- Final WebKit changed-path regression: 20 passed, including full formatting,
  scoped journals, short-result focus recovery and the real App ADHD integration.
- The fixture checks cover 320/390/1360px, exact full-report copy, deleted/foreign
  sources, unsupported Hub, host-switch return, stable live heights and no
  foreground-stop action. ADHD covers 4/5/6 columns at 11/12/16px, unchanged
  composer geometry/focus/draft and an open reader surviving 35 new messages.
- Final short-report/link/formula checks: 11 passed in each browser.
- Final focused ADHD lifecycle checks: 4 passed in each browser.
- Client translation check, TypeScript and production build passed.

Second independent review reproduced two issues in the work in progress: short
links could lose their complete renderer, and closing a reader after many new
messages could lose keyboard focus when its row was recycled. Both were fixed:
conservative formatting detection retains the reader, and the virtual range also
retains the message holding keyboard focus. Active excerpts now use recent
public progress. Follow-up independent probes passed 44 checks across Chromium
and WebKit, including eight short report types in both scoped/static paths and
both Escape/source-navigation focus cases. The reviewer confirmed no remaining
blocking findings. The source jump highlights/scrolls to the original request
but keeps keyboard focus on the report trigger in the same pane; moving focus
onto the original message itself remains a small accessibility follow-up.
Browser/isolated-Hub tests do not represent native installed-Mac or physical
Android acceptance. This task does not release or install a build.
