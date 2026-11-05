# Atelier: workspace visual refinement (Opus 5.5, 2026-10-04)

Status: **implemented by Opus; parent rendered QA and verification passed.**
See the parent addendum below for the completed acceptance and final contrast correction.

Original author handoff: **implemented in source, not yet rendered or built by me.** The concept
and plan below were written before editing; the implementation record, motion
spec, decisions and open risks follow them. I ran no build, tests, browser or
screenshots (out of scope for this role); visual acceptance is the parent's job
and nothing here claims it.

Inputs read: `screenshots/atelier-20261004/before-{desktop,phone,phone-chat}.png`
(live fixture, fictional data), `screenshots/grok-alignment/01-reference.png`,
`professional-ui-opus55.md`, `grok-ui-opus55.md`, `color-palettes-opus55.md`,
and the current theme/components.

## Diagnosis (from the before screenshots)

1. **Everything weighs the same.** Sidebar, header, topic strip, bubbles and
   composer all sit on near-identical warm beige with the same 12–14px medium
   text. Nothing leads the eye.
2. **Beige monotony.** Canvas, bubble, avatar tile, buttons, selected row and
   disabled Send are all sand variants; the self bubble's warmth gets lost.
3. **Identity tiles repeat.** Every Bot is the same beige square with one glyph
   (开 / 产 / 研), so rows only differ by text.
4. **Utility density at the top of the sidebar.** Four stacked control rows
   (brand, host select, two filled create buttons, search), each equally loud;
   a per-Bot `+` on every row; offline presence dots on every avatar.
5. **Raw controls.** Native-looking host select, bordered pills (`引导`), boxy
   chips, a tab-bar highlight drawn with a box-shadow square.
6. **Phone chat:** an always-visible labelled toolbar under every message, and
   a tall composer with a large beige `发送` pill.
7. **Generic lists/empty states:** flat 16px/500 rows, beige tag chips, red
   badges on one surface and walnut on the other.

## Concept: "Porcelain and ink"

Calm, warm, exact. Large surfaces become a warm porcelain (warm-neutral, not
sand); warmth is concentrated where it means something: the accent, the self
bubble and identity hues. Hierarchy comes from type and elevation, not boxes.

- **Two-plane surface model.** Stone canvas (sidebar) and porcelain reading
  plane (chat). On the stone, interactive and selected things are *raised
  chips*: white, a hairline ring and a 1–2px soft shadow (`--elev-1`). Fields
  are *recessed* (filled, no border) until focused, when they lift to raised.
  Overlays use `--elev-2/3`. Same language everywhere: selected sidebar row,
  topic segment, phone filter segment, create buttons, composer.
- **Segmented controls** replace pills: desktop topic strip and phone inbox
  filters become a track with a raised selected segment (no weight change, so
  nothing reflows).
- **Identity hues ("dots").** Default Bot pictures become softly lit spheres
  (circle, radial light from the top-left, hairline inner edge); groups become
  softly lit tiles. Eight muted mid-value hues (walnut, moss, slate, plum,
  teal, ochre, rose, graphite) chosen by a stable hash of the id; white glyphs
  at ≥4.5:1 on the base hue. Custom pictures always win: a target with a custom
  picture never receives a hue, even while its image loads.
- **Typography with a clear ladder** (system SF/PingFang stack retained):
  display 22/680, title 15.5–16/650 with tight tracking, row titles 13.5/600,
  child rows 13/450, section labels 11.5/600 with slight tracking, reading
  text 1rem+1px (15px default, still follows the font-size preference),
  meta 11.5–12 tabular.
- **Accent discipline.** The palette accent marks action (Send, primary),
  selection indicators and unread. Unread counts use the accent on desktop
  *and* phone (the red phone badges go); status colours stay semantic.
- **Quiet utilities.** Per-Bot `+` appears on hover/focus on pointer devices
  only (always visible on touch); offline presence dots are not drawn (online
  stays green); header connection state becomes a small status chip; the
  host select reads as a menu button.
- **Phone.** iOS-style large title, recessed search, segmented filters, rows
  with weight-based unread hierarchy, hairline tag instead of beige chip, a
  Material-style selection indicator in the tab bar (animated, not a hack),
  bottom-sheet dialogs (More / new / forward / topics), icon-only message
  actions with 44px hit areas on a 32px visual row, and a lighter composer
  (single line while empty and unfocused, 36px accent Send dot inside a 44px
  target; the `排队` label still shows whenever sending would queue).

Not doing: no new copy, slogans, decorative cards, stickers, blobs, drawings,
emoji, mascots or fake status; no new dependencies; no change to data flow,
navigation semantics, accessible names or selectors; nothing on `.message`
or virtual rows animates or transforms.

## Planned files

| File | Change |
|---|---|
| `client/src/brand-theme.css` | Elevation + motion tokens, identity hues, sidebar, header, topic segmented control, reading surface, message actions, composer, empty/welcome, dialogs (phone bottom sheets), motion keyframes, phone/wide restatements. Reworked in place. |
| `client/src/palette-tokens.css` | Sand light only: surfaces/borders de-saturated toward warm porcelain; text, accent and self-bubble tokens unchanged (contrast preserved). |
| `client/src/mobile-im.css` | Inbox header/title, search, segmented filters, rows/badges, create menu motion, Me groups, tab-bar indicator. |
| `client/src/mobile-shell.css` | Remove tab highlight hack; phone chat header/composer and More-sheet list. |
| `client/src/hosts.css` | Host select as a menu button; host heading. |
| `client/src/Avatar.tsx` | `data-hue` on default Bot/group pictures only (no caching or precedence change). |
| this file | Concept, final file list, motion spec, decisions, uncertainties. |

---

## Implementation record (after editing)

### Files actually changed

Exactly these seven; no others. `client/` is untracked, so do not rely on
`git diff`.

1. `client/src/brand-theme.css`: reworked in place, section by section; no override block appended.
2. `client/src/palette-tokens.css`: only the sand light block.
3. `client/src/mobile-im.css`
4. `client/src/mobile-shell.css`: rewritten in full (small file). The same
   rules remain, plus the restyled action sheet. The tab highlight hack and the
   `.composer textarea{min-height:48px}` rule were removed.
5. `client/src/hosts.css`
6. `client/src/Avatar.tsx`: a `hue(id)` helper and the `data-hue` attribute.
7. `docs/client/atelier-opus55-2026-10-04.md` (this file).

Not touched: `styles.css` (E2E fixtures load it alone), `App.tsx`,
`MobileHome.tsx`, `ConversationList.tsx`, locales (no new text), tests,
backend, native shells. Class names, accessible names, DOM order and selectors
are unchanged. The only DOM change is the new `data-hue` attribute.

### What changed, by surface

**Tokens (`brand-theme.css`, all modes).** Added `--elev-1/2/3` for light and
dark. Each is a hairline ring plus a soft drop, built from `box-shadow` so it
never shifts layout. Also added `--ease-out`, `--ease-sheet`, `--t-sheet`,
`--radius-2xl` and `--on-tone`. `--t-med` moves from 160 to 180ms and `--t-slow`
from 180 to 240ms (see the motion spec).

**Sand light palette.** Surfaces and borders move to warm porcelain:

| Token | Before | After |
|---|---|---|
| canvas | #f6f2ec | #f5f3ef |
| bg | #fcfaf7 | #fcfbf9 |
| raised | #fffdfa | #ffffff |
| surface | #f4efe8 | #f4f2ee |
| surface-alt | #ece5dc | #ebe8e2 |
| border | #e8e0d5 | #e7e3dc |
| border-strong | #d6cabd | #d3cdc4 |
| bot bubble | #f2eee8 | #f1eeea |
| composer-focus | #9b8b7b | #9b8f82 (3.15:1 on white) |

Text, accent, primary and every `--self-*` token are unchanged. Hand-checked
contrast with the WCAG formula: muted `#6a5c51` is about 5.8:1 on canvas, about
5.3:1 on surface-alt and about 5.1:1 on selected-row. The parent should
re-verify with the existing `palettes` spec. Dark sand and the other three
families are unchanged.

**Identity hues (`Avatar.tsx` + CSS).** Default Bot pictures are now circles
("dots") and default groups are rounded tiles (28%). Each takes one of eight
muted hues (walnut, moss, slate, plum, teal, ochre, rose, graphite), chosen by an
FNV-1a hash of the id. The same Bot or group therefore has the same hue in the
sidebar, header, messages and phone inbox. The light falls from the upper left:
a radial gradient for dots, a vertical gradient for tiles, a hairline inner edge
and a faint top highlight. Glyphs are white. Hand-computed white-on-base
contrast ranges from about 4.8:1 (moss) to about 6.9:1 (graphite).

`data-hue` is set only when the profile is known **and** `hasImage` is false. A
target with a custom picture never receives a hue, even while the image loads.
Blob caching, revisions and the monogram rules are untouched. Uploaded Bot
pictures now display round, and the Bot crop preview is round to match (it was
26%).

**Desktop sidebar.**
- Width 264→272 (288 on wide screens). Brand row 56px with a lit wordmark tile.
- The host switcher keeps the native `<select>` (13/600). It reads as a menu
  button: the label is the hover and focus surface.
- `新建 Bot / 新建群组` are raised chips (`--elev-1`). Search is a recessed fill
  that lifts to raised with a focus ring.
- Section labels are 11.5/600 with 0.02em tracking. Bot rows are 13.5/600 with
  model text at 11.5. Child rows are 13/450.
- The **selected row is a raised white chip**, not a tint; the guide-line
  accent segment stays. Unread badges use the accent at 10.5/650.
- With a fine pointer, the per-Bot `+` appears on hover or focus-within. On
  touch it is always visible. Offline presence dots are no longer drawn; online
  dots stay green.
- The tools block (`当前主机：…`, 文件中心, Skills 与 MCP) is set off by a
  hairline. Footer: avatar, status dot with a soft halo, and icons.

**Header.**
- 56px tall; title 15.5/650 with -0.012em tracking. A 10px hairline separates
  `运行于 …` from the model/effort control.
- `新对话` is a ghost button. The connection state is a small filled status chip
  (route and latency, tabular numerals); while connecting, the chip is amber.

**Group topics (desktop).** The topic strip is a **segmented control**: a
recessed track that hugs its topics, with the current topic a raised segment.
Weight is constant, so nothing reflows. `全部话题 n` is pushed right. On phones
there is no track. The current topic is a 34px soft pill drawn inside its 44px
target (`background-clip: padding-box`), and the edge-fade mask stays.

**Reading surface.**
- Reading width is 760.
- Message text is `calc(1rem + 1px)` with 1.62 line height, so the font-size
  preference still applies; the default is 15px. The composer textarea matches.
- Bubbles have 20px radius and 9×16 padding. Bot code blocks are raised white
  with a ring.
- Cards have 20px radius. Card buttons, file cards and link previews are raised
  chips (`--elev-1`) instead of bordered boxes; the danger button keeps its red
  border.
- The `.message` box only gains padding. It gets no transform, transition or
  animation.

**Message actions.**
- Desktop is unchanged in behaviour: the row is reserved at 28px and fades in
  on hover or focus.
- **Phone:** icons only on a 32px visual row. Each target is 44px wide, and an
  `::after` extends it 6px above and below into the row's own spacing, so it is
  44px tall. Text labels are visually hidden; names come from the existing
  `aria-label`s. Actions are always visible on touch.

**Composer.**
- One raised surface (`--elev-2`, 22px radius, no border box). On focus the ring
  becomes `--composer-focus`.
- Labelled toolbar actions (`引导`, cancel upload) are soft pills.
- Send is an accent pill with a top light. When disabled it is a quiet surface
  pill with a ring.
- The `让谁回复` chips and the command menu use the same chip and popover
  language. Jump-to-latest is a raised pill.
- **Phone:**
  - The field is **one line while empty and unfocused**
    (`:placeholder-shown:not(:focus)`) and two lines on focus or with a draft.
    No script is involved.
  - Round actions keep 44px targets but draw 36px discs (transparent border +
    `background-clip: padding-box`).
  - Send is an **accent dot**. Its `排队` label appears only while a reply is
    running (`:has(.composer-stop.is-live)`), which is exactly when sending would
    queue. At ≤360px it stays a dot.
  - Hover rules that use the `background` shorthand (including styles.css
    `button:hover`) would reset the clip. The clip is therefore restated above
    their specificity.

**Empty and welcome states.**
- Group/topic empty: the library glyph sits in a soft 44px disc, heading
  16.5/650, primary pill.
- Direct empty: heading 17/650 and raised chip actions.
- Welcome: title 24/680 and a raised action list (`--elev-2`, 16px radius). The
  first action's icon is accent-tinted, and the chevron nudges 2px on hover.
- Phone inbox empty: one 15/500 sentence and one primary pill.

**Dialogs.**
- Desktop dialogs and panels have 16px radius and `--elev-3`, with no border
  box.
- **Phones:** every `CreationDialog` (More / 聊天操作, new conversation,
  forward, topic directory, effort, host chooser, …) and every scrim
  `.settings-panel` (conversation settings, Skills & MCP, operations, share)
  docks as a **bottom sheet**: full width, 20px top corners, home-indicator
  inset. The File Center and the full-screen Settings keep their existing
  layouts.
- The More / archive lists are one grouped raised list with hairline rows and
  52px targets.

**Phone inbox (`mobile-im.css`).**
- Large title (27/700, -0.025em), no hairline under the header.
- `+` is a 34px soft disc inside a 44px target. Search is a recessed fill that
  lifts on focus.
- Filters are a **segmented control**: track plus raised segment, and each
  segment keeps a 44px hit area.
- Rows: titles at 16/550, rising to 650 when unread. Unread rows show an accent
  time and a darker preview. The Bot/host tag is a hairline label instead of a
  beige chip.
- **Unread badges use the accent** (they were red), matching desktop.
- Bot rows: `新对话` is a raised chip.
- The history-search row is a raised card with an accent-tinted icon disc.
- Me tab: grouped cells on raised panels.
- Tab bar: a Material-style **pill indicator** behind the current icon (accent
  tint, scaleX 0.6→1). The current label gains weight, and the badge uses the
  accent.

## Motion spec

| Token | Value | Use |
|---|---|---|
| `--t-fast` | 120ms, `--ease` `cubic-bezier(.2,0,0,1)` | hover/press colour, opacity, ring changes |
| `--t-med` | 180ms | selection indicators (segments, tab pill), popovers, scrims |
| `--t-slow` | 240ms, `--ease-out` `cubic-bezier(.16,1,.3,1)` | desktop dialog entrance; phone full-screen settings |
| `--t-sheet` | 300ms, `--ease-sheet` `cubic-bezier(.32,.72,0,1)` | phone bottom sheets |

| Keyframes | Motion | Where |
|---|---|---|
| `tc-fade` | opacity | scrims, `::backdrop`, phone sidebar backdrop |
| `tc-rise` | opacity + 4px up | command menu, jump-to-latest |
| `mh-menu-in` | opacity + 4px down + scale .97 (top-right origin) | phone create menu |
| `tc-dialog-in` | opacity + 8px up + scale .985 | desktop dialogs and scrim panels |
| `tc-sheet-up` | translateY(100%)→0 | phone dialogs and scrim panels |
| `tc-sheet-in` | opacity .6 + 16px up | phone full-screen settings |
| transitions | colour, shadow, opacity; tab pill opacity + scaleX | rows, chips, segments, tab indicator, per-Bot `+` reveal |

Kept loops: the real progress spinner and the recording dot. There is no exit
animation (React unmounts), no bouncing, no press scaling, no staggered
entrance, and no motion on `.message`, the virtual rows or streaming text.
Scroll behaviour is untouched. `prefers-reduced-motion: reduce` disables every
animation and transition, including `::before`, `::after` and `::backdrop`,
through the existing global rules in `brand-theme.css` and `mobile-im.css`.

## Decisions

- **Tinted self bubble kept.** The rejection of pure black self bubbles stands.
  The latte self bubble is now the warmest element on a porcelain plane, so it
  reads as intent.
- **Hues on identity, not chrome.** The eight bases are mid-value and muted,
  and they are shared across palettes so a Bot keeps its identity when the
  palette changes. The palette accent remains the only *interactive* colour.
- **Raised = selected/secondary, recessed = field.** One rule across sidebar
  rows, topic segments, phone filters, chips and the composer replaces the
  previous mix of tints, borders and fills.
- **Accent unread everywhere.** Red stays reserved for errors, stop-while-live
  and destructive actions.
- **No message overflow menu.** Folding Copy, Quote, Forward and Export into a
  menu needs new open/close/focus logic in `App.tsx`. Per the brief, it is
  deferred; the existing controls are restyled instead.
- **No auto-growing composer.** `field-sizing` or a script would change the
  scroll container height mid-stream and fight the follow-latest logic. The
  phone "one line while empty" rule only changes height on focus, when the
  keyboard is already resizing the viewport.

## Uncertainties and checks for the parent

Please inspect the rendered result. These are the points I could not verify
without a browser:

1. **Required screenshots:** 1360×900, 1345×1139, 390×844 and 320 width; light
   and dark; sand plus at least one other palette. Inbox, chat, group with
   topics, More sheet, new-conversation sheet and Settings.
2. **`palettes` e2e:** it reads computed `background-color` for contrast. The
   wordmark tile and hue avatars keep a solid `background-color` under their
   gradients for this reason. The sand light surfaces changed slightly;
   theme-color syncs from `--bg` at runtime. `client/index.html` still ships
   `#fcfaf7` as the pre-JS `theme-color`. That file is outside my scope; the
   difference is imperceptible but not identical.
3. **Hover-revealed per-Bot `+`** (fine pointer only) uses `opacity: 0`.
   Playwright treats it as visible and clickable. Please confirm keyboard
   focus reveals it.
4. **Offline presence dots hidden.** If any test asserts a grey dot for offline
   Bots, it will now find `display: none`.
5. **Phone message actions** are icon-only, with text spans visually hidden
   inside buttons that have `aria-label`. A test asserting visible "引用" or
   "转发" text on a phone width would fail. I found no such assertion in
   `message-actions.spec`.
6. **Phone bottom sheets** change the position of every `CreationDialog` and
   scrim `.settings-panel` on phones. Check:
   - forms with inputs (keyboard overlap on iOS);
   - the nested removal confirm inside the host manager;
   - the QR scanner;
   - that focus return still works (the logic is unchanged).
7. **Phone composer collapse:** focusing the empty field grows it by about one
   line. Check that the latest message stays in view during streaming. The
   follow-latest logic snaps on the next update. Also check
   `mobile-im.spec`'s viewport switch (phone→1360), where the threshold is
   80px.
8. **`background-clip` discs:**
   - Confirm they stay 36px on hover, press, recording (red disc) and disabled
     Send in WebKit and Chromium.
   - Confirm the queued Send (`排队`) pill appears only while a reply runs.
9. **`:has()` usage** is new for queued Send, scrim sheets and the group avatar
   button radius; it already appeared elsewhere. Firefox before 121 falls back
   to an unclipped label or a centered dialog.
10. **Hue legibility at 28px** for two-letter Latin monograms (12px glyph), and
    dark-mode tiles against `#1d1a17`.
11. **Segmented topic track** with many topics at 1345px. The track scrolls
    internally with a hidden scrollbar, and the active topic is scrolled into
    view by existing code.
12. The floating round icon at the right edge of the before screenshots (about
    y=810) does not appear to come from client source. I could not find it and
    assume it is a browser extension. Not addressed.


## Parent QA addendum — 2026-10-04

The parent built and inspected the implemented client on desktop and phone-sized
viewports, compared the same content before/after, and ran Chromium/WebKit
regressions. Full acceptance and limits are in [design-qa.md](../../design-qa.md).

The original white-on-base avatar contrast calculation above did not cover the
brightest gradient stop. The final implementation caps the white mix at 10% and
uses hues `#754f32`, `#4c6642`, `#425c74`, `#664871`, `#27615e`, `#745a21`,
`#82424c`, `#4d4c48`; peak-stop white-glyph contrast is 5.04–6.50:1. The top-edge
highlight was reduced from .22 to .12. The solid hue fallback remains in place.

Frontend build, 40 targeted browser cases across Chromium/WebKit, and the required
repository gate passed after this final source change. Reduced-motion and focus
return were verified in the live preview. Native physical-phone acceptance and
user approval of the aesthetic direction remain separate.
