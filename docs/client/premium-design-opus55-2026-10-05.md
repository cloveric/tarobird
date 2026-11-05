# Premium visual pass: "Porcelain & Ink" (Opus 5.5, 2026-10-05)

Status: implemented in source. **Not yet rendered after the change.** I did not
open a browser or rebuild, so every claim below about appearance is design intent
until the parent's screenshots confirm it.

## 1. Diagnosis (from the four "before" captures)

The captures in `screenshots/premium-20261005/01–04` show a coherent token
system that still reads as an amateur product, for five concrete reasons:

1. **Box inside box inside box.** On the reading plane each Bot reply is a beige
   bubble. Each own message is a latte bubble *with a darker ring*, and holds a
   white file card *with its own ring and shadow*, whose actions are grey
   filled buttons. That makes four nested containers for one sentence and a
   file, and it is the main reason the screen looks "muddy beige everywhere".
2. **Inflated file cards on phones.** At ≤480px the card breaks into a name row
   plus a second row of 44×44 grey squares (02-phone-chat). The attachment
   ends up taller than the message.
3. **A flat hierarchy in the sidebar.** Brand row, host row, two equal-weight
   raised "新建 Bot / 新建群组" chips and the search field are four stacked
   control rows at the same visual weight. The host heading, the "Bot"/"群组"
   labels and the tool label all use one 11.5px grey style, so host → section →
   Bot → chat is not visible.
4. **Default identities look like flat stickers.** The monogram dots use one
   soft radial gradient, so graphite and teal read as flat discs. They don't
   look like objects.
5. **Little typographic contrast.** Reading text, row titles and meta all sit
   at 12–15px with similar weights. Large negative tracking does the work that
   weight and size steps should do.

## 2. Direction (one decision, applied everywhere)

**Porcelain & Ink.** This is a work instrument, not a lounge. The reading plane
is clean porcelain, and *only the human* speaks in a tinted shape. Bots speak in
set type, the way a document or a Grok/Claude-class reply does. Warmth comes
from the palette accent, the self tint and the glazed identity dots, not from
filling every surface.

Rules adopted:

- **Bot text is unboxed** (desktop and phone): avatar + name carry identity,
  and prose holds a ~42em measure. Code, tables and cards may use the full
  column. Bot *cards* keep the soft `--bot-message-bg` fill and are now the
  only Bot container.
- **The own bubble is tint only**: no ring, 18px corners with a 6px tail corner
  toward the sender, and max width 560px. Text has an 8/14px inset.
- **Attachments sent with text sit inset in the bubble**: 6px gutter (5px on
  ≤480px) and 12/13px corners, so the radii run parallel. There is no ring or
  shadow inside the bubble.
- **File card = one row at every width**: a 34px accent-soft tile, name
  (2 lines on desktop, 1 line with an ellipsis on ≤480px) over a tabular size,
  then 打开 as a soft pill and 另存为 as a ghost disc. On phones the controls
  are drawn at 36px, and a transparent `::after` keeps the hit target at 44px.
- **Sidebar hierarchy**: creation is one joined, raised control (Bot | 群组)
  with accent glyphs and a short hairline divider. The host heading is one step
  stronger (12px/620, text colour). Section labels are 11px/650 with +.06em
  tracking, and counts are tabular figures. The unread badge is a 16px pill.
- **Glazed identity dots**: a key light from the upper left, a darker lower
  rim and a 1px specular edge, all done with gradients and inset shadows.
  Custom pictures still win (the `[data-hue]` rules apply only when no custom
  picture exists).
- **Phone surfaces**: inbox Bot tags are recessed fills instead of hairline
  boxes. Me becomes a raised profile panel plus grouped lists whose rows lead
  with 30px neutral icon tiles (separator inset 56px). The per-message "⋯"
  entry recedes to 72% opacity until touched.
- **Type**: grayscale antialiasing, kerning and `optimizeLegibility` on body.
  No web fonts and no new assets.

## 3. Changed files

| File | Change |
|---|---|
| `client/src/brand-theme.css` | House rules updated. Motion tokens (`--t-slow` 220ms, `--t-sheet` 280ms). Body type rendering. Joined sidebar create control, section label, unread badge. Glazed dots. Message meta. Own bubble shape and inset attachments. Unboxed Bot text with code/table fills. One-row file card (desktop, ≤760 hit areas, ≤480 compact). Inset cards inside the own bubble. |
| `client/src/palette-tokens.css` | Sand light `--self-message-bg` `#f0e3d4` → `#f3e8dc` (subtler tint; dark text contrast only rises). |
| `client/src/mobile-im.css` | Recessed Bot tag in inbox rows. Raised Me profile panel with `:active` feedback. 30px cell icon tiles. Group separator inset 54 → 56px. |
| `client/src/mobile-shell.css` | Me card width for a shrink-to-fit button. Receding "⋯" message entry. |
| `client/src/hosts.css` | Host heading hierarchy. Tool label matches the section label style. |

No TSX, tests, viewport/keyboard code, state, network or navigation was touched.
Accessible names, `data-*` selectors and every control are unchanged.

## 4. Motion and accessibility spec (measurable)

| Interaction | Property | Duration | Easing | Travel |
|---|---|---|---|---|
| Hover/press colour on rows, chips, file actions, create control | background-color, color, box-shadow | 120ms (`--t-fast`) | `--ease` | none |
| Tab indicator, topic segment, selection | opacity + scaleX / colour | 180ms (`--t-med`) | `--ease-out` | scaleX .6 → 1 |
| Command menu, jump-to-latest, phone create menu | opacity + translate | 180ms | `--ease-out` | 4px |
| Desktop dialogs | opacity + translate + scale | 220ms (`--t-slow`, was 240) | `--ease-out` | 8px, .985 → 1 |
| Phone sheets | translateY | 280ms (`--t-sheet`, was 300) | `--ease-sheet` | from 100% |
| Scrims/backdrops | opacity | 180ms | `--ease` | none |

- Loops are limited to real work: progress spinners and the recording dot.
- `.message` rows, react-virtual positions, streamed tokens and scroll height
  are never animated. The new bubble and file-card rules are static.
- `prefers-reduced-motion: reduce` already removes every animation and
  transition (`brand-theme.css`, `mobile-im.css`). No function waits on
  `animationend`.
- Touch targets: file actions 44px tall via `::after` (36px drawn). The icon
  disc is 44×44 via `inset:-4px`. Tablet coarse-pointer rules keep 44px.
- Contrast: text on the unboxed Bot plane is now measured against `--bg`
  (higher than the old bubble). File-card meta uses `--muted` on `--raised`.
  No `color-mix()` was added to any background the palette contrast test
  composites.

## 5. Unverified limits (be explicit)

- **No rendered verification.** I haven't seen 320/360/390/430px, landscape,
  desktop, the four palettes or dark mode after these edits. The parent's
  visual QA is the acceptance gate.
- Bubble padding uses `:has(>.markdown):has(.file-card,.attachment-image)`. I
  assumed attachments render as descendants of `.message-blocks`, which is
  consistent with the existing selectors, but I didn't confirm it in the DOM.
- The 42em measure targets `p/ul/ol/blockquote/h*/dl` as direct children of
  `.markdown`. If `MarkdownText` wraps content in another element, the measure
  won't apply. That is harmless, but long lines would stay wider.
- With one-line file names on 320px phones inside an own bubble, roughly 80px
  is left for the name. Long names will ellipsize heavily, though the full name
  stays in the card's `aria-label` and the preview.
- `-webkit-line-clamp` on `strong` relies on `display:-webkit-box`. It is fine
  in Chromium and WebKit, but older engines show the full name.
- e2e contrast (`client/e2e/palettes.spec.ts`) and the full suite were **not
  run** by me.

## 6. Parent integration and actual screenshot review

The preceding sections preserve the initial Opus design record, including its
unverified claims. The parent rendered the implementation and found two real
regressions: 36px phone button bounds and excessive filename compression on
320px screens. Final phone buttons have real 44px bounds. Screens of 360px or
less give the filename a separate row; larger phones retain the compact row.

Actual Opus 5.5 xhigh then reviewed the rendered desktop, 390px and 320px
screenshots. Its follow-up recommendations were applied: a transparent inset
border paints a quieter 32px Open pill inside the real 44px control, narrow
two-line filenames use normal word breaking with an anywhere overflow fallback,
and Bot paragraphs use progressive `text-wrap:pretty` support. The existing
header divider and explicit message-action entry were retained.

The parent verified phone sheet animation at 280ms, and `none` / 0s with
reduced motion. The visual reviewer explicitly described this as progress,
not proof that the entire product meets a subjective high-end standard.

See [rendered acceptance and limits](premium-design-qa-2026-10-05.md) and the
actual model receipt and review（本地材料：`evidence/premium-opus55-2026-10-05.json`）.
