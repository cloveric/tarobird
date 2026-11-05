# Live state and pressed material: Grok-referenced motion pass (Opus 5.5, 2026-10-11)

Status: **implemented by Opus 5.5 xhigh; parent build and rendered checks below.**
The Opus invocation completed successfully with model `claude-opus-5-5`.
It reviewed the supplied native-app screenshots and edited the source. The
parent performed the builds and interactive checks; see section 8 for their
scope and the remaining native-window acceptance limit.

Scope: interaction and motion in the existing App client. No transport or model
execution behavior changed. The parent also stabilized one existing test's
state-initialization wait, without changing its production attachment window.

## 1. Reference: what was actually observed

These sources were provided: the parent's notes from inspecting the running Grok Bot
macOS app on 2026-10-11, and three screenshots under
`/tmp/tarobot-grok-motion-20261011/` (`02-grok-composer-menu.png`,
`03-grok-details.png`, `04-grok-new-chat.png`). I read the screenshots for
structure only. Their conversation content is the user's and is not reproduced
here or in code. The screenshots are not committed.

Observed (structure, from the screenshots and the parent's notes):

- A 1040 × 760 window. A narrow neutral sidebar with a clearly filled selected
  row, and restrained, elevated circular utility buttons (search, new).
- The composer is a compact rounded pill with a modest shadow and a quiet
  placeholder. A circular plus sits inside it at the left; mic and voice actions
  sit at the right.
- The plus opens a small light menu anchored just above it, at the composer's
  leading edge. It has two clear icon rows and is not a modal sheet.
- The Bot's identity is a small floating capsule (avatar and name) over the top of
  the conversation. Details open in a right rail while the conversation stays
  beside it, with circular share/close controls.
- The new-chat recipient field sits under the header. Its picker list anchors
  directly beneath it, with a highlighted (keyboard-selected) first row and a
  close control.
- A neutral reading surface, a tinted own-message bubble, moderate radii and no
  large decorative intro while in a conversation.
- Accessibility exposes the working state as localized "[Bot name] 正在工作".

Not observed or measured: frame timings, easing or spring constants, any
live-stream motion. The bright cursor glow in the screenshots is an
automation-pointer artifact and was deliberately **not** reproduced. **Every
duration and curve below is our own choice, not a Grok measurement.**

## 2. Diagnosis of the current client (before this pass)

Inspected: `brand-theme.css`, `palette-tokens.css`, `mobile-im.css`,
`mobile-shell.css`, `viewport.css`, `styles.css`, `App.tsx`, `CreationDialog.tsx`,
`AttachmentPicker.tsx`, `MessageActions.tsx`, `Avatar.tsx`, `EffortControl.tsx`,
and the run block in `Content.tsx`.

1. **Work state was implicit.** The only signals were an accent ring on the
   *desktop* header avatar, a ring on the streaming message's avatar, and
   the composer placeholder and Stop colour. The phone header hides its avatar,
   so a phone chat had no header-level working signal at all. No text named the
   state the way Grok's "[Bot] 正在工作" does.
2. **Stop told its state by glyph colour alone** (red glyph on a transparent
   disc).
3. **There was no press state on composer controls.** Hover existed; press did not, and
   transitions eased presses in, so a tap could finish before the tone showed.
4. **The slash/@ menu was a full-width slab** spanning the composer, rising from
   its centre. It read as a panel rather than a menu anchored to its source.
5. **Sources lost their link to their sheets.** The phone + and the per-message
   "…" entry gave no open state while their sheets showed (the CSS already
   anticipated `aria-expanded` on the entry, but it was never set).
6. **Focus rings were clipped** in the grouped sheet lists (`聊天操作`,
   `消息操作`, `已归档对话`), which are flush-edged with `overflow:hidden`. A
   keyboard user saw almost no ring.
7. The phone + had a border *and* a ring shadow, on a different material from the
   composer it belongs to.

Dialog and sheet entrances were already coherent (`tc-dialog-in` 220ms,
`tc-sheet-up` 280ms, scrim fade) and close unmounts immediately. I kept them (see
§5).

## 3. Design choices (ours)

Concept: **live state and pressed material.** State becomes explicit (text, shape,
open state), presses land instantly as a tone, and popovers belong to their
source. Hierarchy is borrowed from Grok. The mascot, brand, layout and features
are not: multi-host, groups and topics, steering, capabilities and the lit-dot identity
all stay.

### 3.1 Reply activity status line (desktop and phone)

- New `ReplyActivity.tsx`, rendered first in the header's detail row (the IM
  "typing…" subtitle idiom): an accent **lit dot** and text.
  - Direct chat: `正在回复` / "Replying". This existing catalog key was unused.
  - Group or topic: `正在回复 · {Bot}` / "Replying · {0}". The state comes first,
    so ellipsis on a narrow phone cuts the name, not the state.
  - Two or more streaming Bots: `{0} 个 Bot 正在回复` / "{0} Bots replying".
- **Truthfulness:** it reads the same bounded tail as the existing avatar ring and
  composer mode (`App.tsx`, last 8 messages). It is shown **only** for Bot messages
  whose status is `streaming` **and** only while connected. `pending`
  (acknowledged) replies are not labelled, because I could not confirm that
  pending always means "working"; they keep the existing quiet desktop ring.
  When the stream ends the text simply disappears. Nothing says "done".
  Offline means no claim.
- **Accessibility:** a persistently mounted `aria-live="polite"` span, *without*
  `role=status` (the page keeps its single status messages unambiguous, as
  `MessageActions.tsx` already does). While idle it is empty and visually hidden,
  so each real change is announced once. Streamed tokens do not re-announce,
  because the text node is unchanged.
- **Motion:** the dot has a static 2px accent-soft halo. A `::after` halo
  "breathes" (opacity 0→.3, scale .6→1.3, 2.4s ease-in-out loop) **only while the
  element exists**, which is only while streaming. It is paused (`data-paused`)
  while `document.visibilityState === "hidden"`. Under `prefers-reduced-motion` it
  is removed by the existing global rule. In both cases the still dot and text
  remain. The avatar itself never scales or animates. Nothing inside the virtual
  message list changes.
- Desktop: a hairline separates it from the host label / effort line, like the
  existing host | effort separator. Phone: 11.5px, does not shrink, capped at
  46% of the row; the host and effort text ellipsize first.

### 3.2 Composer and buttons

- **Presses land at once:** `button:active{transition-duration:0s}`, so the release
  still eases over each control's own transition. Press is a tone, never a scale
  (house rule kept).
- Round toolbar actions press to `--surface-alt`. Labelled pills (引导, cancel
  upload) press to `--selected-row`.
- **Send** presses "in": the top light becomes a short inner shade, and the hover
  glyph lift settles instantly. No scaling.
- **Stop while live** is a filled `--red-soft` disc with a red glyph and a darker
  red-soft press. Idle Stop stays a quiet grey glyph (desktop always shows it;
  phones show it only while replying, as before). This works on phones'
  padding-box discs without resetting the clip.
- **Phone +** shares the composer's material: `--raised`, `--elev-2`, no second
  border, a `--grey` glyph and a darker press. While its attachment sheet is open
  (`aria-expanded=true`, already set by `AttachmentPicker`) it takes an
  accent-soft fill with an accent glyph. The selector outranks `styles.css`
  `button:hover`, so sticky touch hover cannot hide the state.
  `AttachmentPicker` logic is untouched: `flushSync` close and `node.click()` still
  happen in the same gesture.

### 3.3 Anchored popovers

- The slash-command / @-mention `.command-menu` is now a **compact anchored menu
  on desktop**. It hugs its rows (min 280px, max 520px or the composer width) at
  the composer's leading edge, where the trigger character is typed, and grows
  from that corner (`tc-pop`: opacity plus 4px plus scale .98,
  `--t-med`/`--ease-out`, `transform-origin: bottom left`). Rows gain a press tone
  and an inset focus ring. Phones restate a full-width list. No behaviour,
  keyboard semantics or Enter handling changed.
- The phone create menu (`mh-create-menu`) already followed this pattern and is
  unchanged.

### 3.4 Selection and focus

- The phone message entry gets `aria-expanded` (false, or true for the message whose
  sheet is open). The open entry paints an accent-soft pill with an accent glyph
  inside its existing 44px bounds, the same rule as the +. It changes colour only;
  the row is never transformed or resized.
- Inset (−2px) focus rings for flush, clipped lists: `.mobile-chat-action-list>button`,
  `.message-sheet-list>a`, `.attachment-source-list>button` and
  `.command-menu button`.

### 3.5 Timing vocabulary (house rules updated in `brand-theme.css`)

| Token / motion | Value (ours) | Use |
|---|---|---|
| press | 0s on `:active` | every button; release uses the control's transition |
| `--t-fast` | 120ms `--ease` | colour/opacity feedback, release |
| `--t-med` | 180ms `--ease-out` | `tc-pop` anchored menus, `tc-rise` jump-to-latest, selection indicators |
| `--t-slow` | 220ms `--ease-out` | desktop dialogs (`tc-dialog-in`), unchanged |
| `--t-sheet` | 280ms `--ease-sheet` | phone sheets (`tc-sheet-up`), unchanged |
| `tc-breathe` | 2.4s ease-in-out loop | reply-activity halo only, while streaming, paused when hidden |

The allowed loops are progress spinners, the recording dot and the reply-activity
halo. The house rules now name the accent as also marking live reply activity,
which the `is-working` avatar ring already did.

## 4. Files changed (exactly)

1. `client/src/ReplyActivity.tsx` (new): the status line plus the page-visibility pause.
2. `client/src/App.tsx`: import; `recent`/`streamingBots` derived from the existing
   bounded tail; `ReplyActivity` in the header detail row; `expanded` passed to
   the phone message entry. No change to queue, steering, stop, send, session,
   host, scroll or virtualizer logic.
3. `client/src/MessageActions.tsx`: optional `expanded` prop sets `aria-expanded`.
4. `client/src/locales/en.json`: two new keys (`正在回复 · {0}`, `{0} 个 Bot 正在回复`);
   the existing `正在回复` key is now used.
5. `client/src/brand-theme.css`: edited in place, with no override layer. Changes:
   house rules, global press landing, the inset-focus list, the status line and
   dot, Stop live disc, composer and Send press, the command menu and its phone
   restatement, the motion table, and the `tc-pop`/`tc-breathe` keyframes.
6. `client/src/mobile-shell.css`: phone status-line sizing, the open-entry pill, and
   the + material and states.
7. This receipt.

Not touched: `CreationDialog.tsx` (still unmounts on close; focus restore
unchanged), `AttachmentPicker.tsx`, `Avatar.tsx`, `palette-tokens.css`,
`mobile-im.css`, `viewport.css`, `styles.css`, tests, `AGENTS.md`/`CLAUDE.md`,
and `docs/entrypoint-map.md`. Linking this receipt from the entrypoint map is left
to the parent because of the scope boundary.

## 5. Considered and deliberately not done

- **Desktop composer collapse to one line / Grok-style internal +.** An earlier
  Atelier decision rejected height changes on desktop focus because they fight
  follow-latest. Moving the attach control would also churn tested DOM. I kept
  that decision.
- **Floating identity capsule / right-rail details.** These are layout changes
  beyond this motion pass. Our header must also carry host, effort and connection.
- **Exit animations.** Dialogs unmount. A delayed-close architecture would risk
  focus return and the attachment picker's same-gesture chain.
- **Phone settings horizontal "push".** Several browser checks measure settings
  geometry without polling, so a transient horizontal transform could make them
  flaky. The existing rise was kept.
- **Animating the phone chat container on open.** Transforms on an ancestor of
  the virtual list would skew the reading-anchor measurements and become the
  containing block for fixed layers.
- **Keyboard selection in the slash menu.** It would change Enter-to-send
  semantics that tests rely on.
- **A sheet grabber.** There is no drag-to-dismiss, so a grabber would be a false
  affordance.

## 6. Risks for review

1. **Bounded tail.** A stream older than the last 8 messages is not shown. This is a
   false negative, never a false claim, and is shared with the existing avatar
   ring and composer steering mode.
2. **Pending is unlabelled**, by design (§3.1). On phones a pending-only reply shows
   no header signal.
3. **New header text in groups** (`正在回复 · {Bot}`) could make a non-exact
   `getByText(botName)` ambiguous in group streaming tests. Exact locators are
   unaffected.
4. **`aria-live` announcements:** one polite announcement when a reply starts,
   or when switching to a chat whose reply is streaming.
5. **`aria-expanded="false"`** is now exposed on every phone message entry (screen
   readers will say "collapsed").
6. **Desktop slash/@ menu width** now hugs content. Long descriptions wrap within
   520px instead of spanning the composer.
7. The **global `button:active` 0s** changes press-in timing for every button
   (colour only). Release timing is unchanged.
8. `color-mix()` is used for the Stop press, as it already is elsewhere in this file.

## 7. Suggested focused checks (parent)

- `node client/scripts/check-translations.mjs`, client `tsc --noEmit`, `vite build`.
- Browser (Chromium and WebKit): `stream`, `steering`, `stop`, `command-parity`,
  `attachment-composer`, `message-actions`, `message-hold`, `keyboard`,
  `settings-language` (English narrow header and action-row bounds), `topics`,
  `cross-device`, `host-workspace` (exact `.runtime-host-label` text), `mobile-im`,
  `native-back`, `palettes`.
- Visual QA at 1040×760, 1360×900, 390×844 and 320 wide; light and dark; sand plus
  one other palette:
  - idle versus streaming header (direct chat, group with one and with two
    streaming Bots), with the breathing halo;
  - halo paused with the window hidden (`data-paused` present);
  - reduced motion: static dot and instant menus;
  - Stop live disc;
  - `/` menu anchored at the left on desktop and full width on phone;
  - phone + resting, pressed and open with the attachment sheet;
  - "…" entry tinted while its sheet is open;
  - Tab focus visible inside `聊天操作` / `消息操作` rows.

## 8. Parent verification

The following checks used an isolated loopback Hub, synthetic conversation data
and a deterministic fake model. They exercise the real App, Hub and Gateway
path; they are not live model, relay or phone-device acceptance.

- Translation validation, TypeScript and the production client build passed.
- The repository pre-completion build/test hook passed with two Vitest workers
  and a 15-second per-test ceiling. Earlier local runs exposed a pre-existing
  1-second polling deadline while preparing attachment state. The test now
  waits up to 5 seconds for initialization, still inside the production
  15-second attachment window. The same 390-test service file also passed in
  isolation before that change; production transport code was not changed.
- Rendered checks covered 1040 x 760 desktop and 390 x 844 / 320 x 640 phone
  layouts, Chinese/English, light Sand and light/dark Sage.
- A sent message showed the reply line and `tc-breathe` halo during the fake
  model turn; both disappeared on completion. Under emulated reduced motion,
  the same active turn retained its text and dot with `animation-name: none`.
  No animation was applied to message descendants.
- The phone attachment sheet focused Camera, exposed three 56-pixel rows,
  retained its source highlight, and restored the Plus focus and unchanged
  draft on Escape. Choosing Upload file opened the file chooser and preserved
  the text-plus-file draft; sending delivered both in one message.
- The message action sheet highlighted exactly one source. Quote reply closed
  it, cleared the highlight and returned focus to the preserved composer draft.
- Desktop `/sta` produced an approximately 298-pixel menu anchored at the input
  edge; the English full command menu stayed within its 520-pixel limit.
  Neither the desktop nor 320-pixel layouts overflowed the document.
- A synthetic two-Bot streaming snapshot showed the localized count, including
  the complete English `2 Bots replying` line at 320 pixels. Snapshot fixture
  messages were subsequently completed.

Local accepted images are kept outside Git under
`docs/client/evidence/grok-native-motion-2026-10-11/`. No screenshots of the
user's Grok conversations are committed.

A macOS ARM64 development preview was built with a separate app identifier and
saved as `~/Downloads/TaroBot-Motion-Preview-20261011.app`. Its ad-hoc bundle
signature passed `codesign --verify --deep --strict`. This is not a notarized
release or a replacement for the installed app. Native window inspection was
blocked by the Mac lock screen; the user was asked to unlock it.

Remaining verification: native macOS window behavior, physical mobile shells,
and actual background-window visibility transitions. The in-app browser kept
both test tabs visible to the Page Visibility API, so it could not verify the
background pause experimentally. The visibility listener and reduced-motion
fallback are present, but background suspension is not claimed as tested.
