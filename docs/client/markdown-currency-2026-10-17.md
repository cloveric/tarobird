# Dollar amounts and reply typography

The reported Claude reply contained `$10` and `$0.2` in an ordinary Chinese
paragraph. `remark-math` treated the text between consecutive dollar signs as
inline math, so KaTeX changed the intervening prose's font, size and spacing and
consumed the currency symbols. The stored reply was correct; this was a shared
client parsing defect, independent of the Bot adapter or chosen font size.

## Parsing behavior

`client/src/markdown-math-boundaries.ts` guards the existing inline-math tokenizer
after `remark-math` is installed. Single-dollar formulas follow
[Pandoc's delimiter boundaries](https://pandoc.org/MANUAL.html#extension-tex_math_dollars):

- No whitespace immediately after the opening `$` or before the closing `$`.
- No digit immediately after the closing `$`.
- A rejected match rolls back through micromark, allowing a later real formula
  in the same paragraph to be parsed normally.

For example, `$0.2 到 $10` remains ordinary text, while `$E=mc^2$`, `$10$` and
`$\frac{1}{2}$` remain formulas. Padded single-dollar input such as `$ x $` is now
literal text; use `$x$` or `$$ x $$` for formulas. This is a delimiter rule, not a
general classifier of prices versus mathematics: intrinsically ambiguous dollar
notation can still require escaped currency signs.

The parser does not rewrite the message source. Code blocks, inline code, link
destinations, escaped dollars, double-dollar formulas and math fences retain
their Markdown semantics. Formula/highlighting engines remain lazy-loaded.
The request-observation test now matches exact engine module names so the small
boundary helper is not mistaken for a loaded formula engine.

The same parser serves phone and desktop Apps and all Bot adapters. Existing
messages benefit when re-rendered by an updated client; no history migration is
required. CLI is not applicable: this is client presentation only, with no host,
message protocol, command or stored-data change.

## Verification and delivery boundary

- Before the fix, the new currency suite reproduced eight failures.
- Unit coverage includes the reported Chinese text, ordinary prices, tables,
  code, escaped dollars, strict delimiter boundaries, real formulas and partial
  streaming revisions; existing Markdown image/link tests also run: 28 passed.
- Browser coverage exercises worker rendering, uniform text sizes at 320 px,
  mixed prose/formulas, lazy dependencies and recovery, rich Markdown, wide
  tables and CLI-theme typography: 22 passed in Chromium and 22 in WebKit.
- Client translation checks, TypeScript checking and the production build passed.
- Local browser verification is not native Mac or Android device acceptance.
  This change does not publish a release or update installed applications.

Artifacts: `/Volumes/gdrive/taro-tmp/tarobot-markdown-currency-20261017/`.
