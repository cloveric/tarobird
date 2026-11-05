# List avatar states — 2026-10-30

The owner asked for Bot avatars in the desktop sidebar and the phone message
list to show what a Bot is doing. The owner reviewed and approved a fox
demo video before implementation. Idle rows stay static; four states animate
when the device-local animated-avatar setting is on (the default).

| State | Source | Motion | Corner badge |
| --- | --- | --- | --- |
| Working | any ordinary reply in the row is `streaming` | slow head sway, reading eyes and a typing bubble (loop) | none |
| Done | newest finished reply is `complete` and still unread | one cheer jump with sparkles when seen live, then two small hops every 2.4 s; `^ ^` eyes held until read | green check until read |
| Failed | newest finished reply is `error` and still unread | one head shake, then lowered and slightly desaturated; `> <` eyes held until read | red `!` until read |
| Needs you | the row has an open question/approval (`attention`) | head tilt left/right with a short hop (loop) | blue `?` with a ripple |

A request outranks work, and work outranks finished replies. Queued (`pending`)
replies are not shown as work because an offline Bot has not started them.
Group rows include their topics. Desktop Bot rows (按 Bot) and phone Bot rows
summarize that Bot's own direct conversations.

## Data

`ConversationActivity.replies` keeps the newest reply per Bot author
(`client/src/agent-state.ts`). The cache projects it at the same three points as
attention: live stream deltas, message create/update events and snapshot
staging. Existing caches backfill it once, like attention did. Forwarded copies
and mirrored Agent Bus records do not count as the conversation's own turn.
The independent `workingReplies` map keeps active IDs/timestamps so a newer
answered question or delivery receipt cannot hide an older running task.
See [the active-task fix](avatar-active-task-2026-10-31.md) for its indexed upgrade.

One-shot completion/failure motion plays only for a transition observed while
the row is mounted (after its first 1.2 s) and within two minutes of the reply's
Host time. A cold start, reload, remount or long-offline catch-up shows the
resting state and badge without replaying history. The one-shot marker is
cleared after 2.6 s so later row reordering cannot restart it.

## Setting

Desktop, iOS and Android share **Settings → General → Appearance → Animated
avatars** (`animatedAvatars`, default `true`). Turning it off immediately stops
body, eye, badge and one-shot motion and removes animated face overlays, while
static done/failed/pending badges remain. Turning it back on does not replay
completed history. This setting is independent of ordinary page, dialog and
reply-indicator animation.

The legacy cache and multi-host registry both preserve an explicit `false`;
missing or malformed values default on. The appearance startup mirror carries
the same value before IndexedDB hydration. The setting applies to this device,
not other paired phones or computers. It is presentation-only and does not
change Host protocol, Bot behavior or the CLI.

## Faces

Body motion and badges work for every avatar, including uploads and group
collages. Animated eyes (blink, looking around, `^ ^`, `> <`, looking up)
are added when the shown picture has two solid dark eyes on a transparent
cutout (`client/src/avatar-face.ts`). The picture is analyzed once per URL in a
256 px canvas. The eyes are painted over with the surrounding face colour, and
SVG eyes are drawn on that copy. Opaque pictures (photos, framed animal tiles)
are skipped. Because library choices are saved as ordinary PNGs, detection
runs on pixels rather than catalog IDs. The bounded cache stores self-contained
image data, so evicting one of its 96 entries cannot invalidate a face still in
use by a mounted avatar. Async PNG conversion keeps the previous pipeline. In Chromium, 138 of the 144 library
mascots get eyes, including `pastel-fox`. Six are left to motion only: the
black bird, croissant, duck, ice cream, rice ball and panda.

This is presentation only. Host protocol, delivery and the headless CLI are
unchanged; no CLI entry point is applicable.

## Verification

- `tests/client-agent-state.test.ts` and `tests/client-avatar-face.test.ts`.
- `client/e2e/avatar-agent-state.spec.ts` covers desktop (1360), iOS layout (390)
  and Android layout (412) in Chromium and WebKit.
  A real Hub drives streaming, completion, error and question replies, then a
  reload and a read receipt. It also exercises the real settings UI, persisted
  on/off state, no replay on re-enable, 44 px targets and viewport fit. A separate
  case checks library face coverage and retaining a visible face after cache eviction.
- Browser evidence is not physical-device acceptance.

The Electron merge review and final validation are recorded in
[PR97/98 integration](pr97-pr98-electron-review-2026-10-30.md).

## Held expressions (2026-10-31)

On 2026-10-31 the owner asked that finished states keep their face instead of
returning to plain eyes. The owner chose the `> <` option for failure over a
closed-eye "sad" variant and over the earlier lowered gaze, which was hard to
read at list size. Done keeps `^ ^` and failed keeps `> <` until the reply is
read; the one-shot body motion still plays only when seen live. Restored rows
show the held face immediately. When the animated-avatar setting is off, faces
are not mounted and only the corner badge shows, as before.
Covered by `avatar-agent-state` (Chromium and WebKit).

## Done resting hops (2026-11-01)

After reviewing six resting-motion options for done (demo video), the owner chose
"happy hops". After the cheer, or immediately for a restored done row, the avatar
makes two small hops every 2.4 s: about 3.5% and then 2% of its height. It does
this until the reply is read. Each row's cycle is offset by its stable React
identity (`--agent-phase`), so simultaneous completions are staggered without
per-frame JavaScript. Working retains its slow sway (PR #101). Nothing moves when the
animated-avatar setting is off. A slow-down for long-unread rows was discussed
but not chosen yet.

