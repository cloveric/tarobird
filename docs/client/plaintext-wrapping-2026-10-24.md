# Plain-text fence wrapping

The reported `text` panel is a Markdown fenced block rendered by
`MarkdownText` through the shared `CodeBlock` component. The existing
`.markdown pre code` rule preserves code columns with `white-space: pre` and
`overflow-wrap: normal`; prose therefore acquired a horizontal scrollport.
The narrow-phone regression reproduced a 3,592 px scroll width in a 264 px
text viewport before the fix.

## Type boundary and behavior

- Only explicit `text`, `txt` and `plaintext` labels, matched without regard
  to case, opt into wrapping. The language label comes from the sanitized
  Markdown code element or the component's explicit `language` prop.
- Program languages, `ascii`, unknown labels, unlabeled fences and unlabeled
  raw tool output retain their existing column alignment and local scrolling.
  We do not infer prose from punctuation or attempt automatic language detection.
  A diagram incorrectly labeled `text` will follow that explicit label; aligned
  content should use its appropriate language/diagram label or an unlabeled fence.
- `white-space: break-spaces` preserves original newlines, blank lines, tabs,
  repeated and trailing spaces while allowing soft wraps, including long runs
  of indentation. `overflow-wrap: anywhere` handles URLs and unbroken strings.
  Both the `pre` and its `code` receive the rule to override the existing code
  whitespace styles. Text and markup are not rewritten.
- The font, theme, border and copy control are unchanged. Overflow remains
  `auto`; content is neither clipped nor hidden. Copy still uses the raw text
  prop or sanitized code `textContent`, so visual wraps add no newline characters.
  Existing Markdown parsing/line-ending normalization is unchanged.

This is App presentation only. No CLI command, Host API, stored message,
adapter, queue or permission behavior changes. Passive quote thumbnails keep
their separate preview renderer.

## Verification

- `plaintext-blocks`: six cases in Chromium and six in WebKit, covering
  320/430/1360 px widths, all three aliases and uppercase `TEXT`, CJK paragraphs,
  blank lines, spaces, tabs, long URLs, unbroken words and long indentation.
  They assert no horizontal scrolling and unchanged code text; code/ASCII/
  unknown/unlabeled examples remain aligned even after reply type changes.
- Native and legacy reply rendering is checked across every palette in light
  and dark mode. Plain text retains the same font, background and borders as
  adjacent code. Copy labels remain clear of text; terminal themes deliberately
  extend their touch targets with transparent borders.
- Chromium reads the real browser clipboard and compares the full original
  payload. WebKit checks the exact clipboard write argument (its browser runner
  does not grant Chromium clipboard permissions). Failure feedback is covered.
- Eight existing `markdown` and five `run-formatting` Chromium cases passed:
  **19 distinct Chromium cases and 6 WebKit cases passed** across focused runs.
  Initial theme-test failures were corrected in the assertions: transparent
  touch borders are not painted content, and legacy text is under `.card-body`.
  The shared fixture also now provides the current `stopReceipt` interface.
- `npm run build --prefix client`, `npm run build`, and `git diff --check` passed.
  Dev-fixture runs reported optional KaTeX font allow-list warnings from the
  external dependency symlink; plain-text samples do not use those math fonts.

Evidence is under `/Volumes/gdrive/taro-tmp/plaintext-wrap-20261024/`.
Browser/WebKit checks do not establish physical iPhone or Android acceptance.
This source change does not install or release a new App.
