# Built-in PDF reader — design and implementation notes (2026-10-05)

> Parent integration follow-up: the notes below preserve Opus's original handoff.
> The final code explicitly owns a same-bundle Worker instead of assigning
> `GlobalWorkerOptions.workerSrc`; this avoids custom-scheme blob wrapping without
> relaxing CSP and adds retryable worker failures plus bounded shutdown.
> Current rendered verification and remaining limits are in
> [the parent QA report](pdf-preview-qa-2026-10-05.md).

Owner of this slice: `client/src/PdfPreview.tsx`, `client/src/pdf-preview.css`, appended
keys in `client/src/locales/en.json`, this note. Integration (lazy import in
`Content.tsx`, asset packaging, tests, real-browser and device verification) belongs to
the parent change.

## Why

The file preview rendered PDFs in `<iframe sandbox="allow-scripts">` pointed at a blob
URL. Chrome blocks its built-in PDF viewer inside a sandboxed frame, so the body never
showed (reproduced in real Chrome:
`docs/client/screenshots/pdf-preview-20261005/01-blocked-before.png`). Phone WebViews
have no PDF plugin at all. The reader now draws pages itself with PDF.js; no iframe,
`<object>` or native plugin is involved.

## Design

The page is the content; everything else recedes.

- **Stage and paper.** The reading area is a recessed `--surface` stage with a hairline
  ring. The page is always document white with `--elev-2`, in light and dark themes, so
  the PDF keeps its own colours while everything around it follows the Atelier palette.
- **One control bar, below the stage, on every screen.** Two raised chip groups
  (`--raised` + `--elev-1`): page navigation `‹ [3] / 12 ›` and zoom `− [Fit width ▾] +`.
  Below the stage it sits in the thumb zone on phones and stays out of the reading line
  on desktop, matching how file-preview lightboxes usually work. The preview header
  above it already holds name, Save as and Close; the reader does not repeat them.
- **Desktop.** 32 px controls, tooltips, a typed page field, a native zoom menu (Fit
  width, 50–400 %, plus the current custom value after pinch or wheel zoom).
- **Phones / coarse pointers (≤ 760 px or `pointer: coarse`).** 44 px targets; page
  field, zoom menu and password field use 16 px text so iOS does not zoom on focus.
  When the reader is narrower than 400 px (container query) the − / + steps hide; pinch
  and the zoom menu remain, and the stage gutter shrinks to 10 px. At 320 px the bar
  wraps rather than overflowing (`flex-wrap`); 360 px and wider fit on one row.
- **Typography.** Titles 15/600, body 13/1.6 muted, page numbers tabular. No decorative
  motion. The page spinner is revealed only after 200 ms, so fast renders don't flash;
  reduced motion stops spinners (existing global rule) and shows that spinner at once.

### Interaction

| | Desktop | Phone |
|---|---|---|
| Turn page | ‹ ›, type a number + Enter, ← / → when the page fits the width, Page Down / Page Up at the bottom / top edge (Page Up lands at the end of the previous page) | ‹ ›, page field (numeric keypad), horizontal swipe when the page fits the width |
| Zoom | − / +, zoom menu, `+` `-` `0`, Ctrl/⌘ + `=` `-` `0`, Ctrl + wheel and trackpad pinch anchored at the pointer (WebKit gesture events on macOS) | Pinch anchored between the fingers (live transform preview, then a sharp repaint), zoom menu |
| Text | Drag to select, copy as plain text | Long-press to select, system copy |

Swipes are ignored if they are slow (> 600 ms, i.e. long-press selection), short
(< 64 px), mostly vertical, while the page scrolls sideways, or while text is
selected. Escape in the page field reverts a typed number. Disabled buttons use
`aria-disabled`, so keyboard focus is not lost at the first or last page.

### States

- **Opening:** spinner + “正在打开 PDF…” (`role=status`).
- **Password:** lock emblem, “这个 PDF 已加密”, a single field + 解锁. A wrong password
  shows “密码不正确，请重新输入。” and focuses the field again. The value goes straight to
  PDF.js through `onPassword`, the form is reset right away, nothing is kept in React state
  or storage, and the field has `autocomplete=off`.
- **Unreadable:** “无法显示这个 PDF”, with separate copy for a damaged/invalid file
  (`InvalidPDFException`) and other read failures, plus 重试. Both say Save as can open
  it in another app.
- **One page fails:** an in-page message and 重试 (refetches the page and repaints).
- Focus goes to the reader after unlocking or retrying, and to the error card on failure.
  A visually hidden status line reads “第 3 页，共 12 页” and the zoom state.

## Engineering

- `pdfjs-dist/legacy/build/pdf.mjs` imported statically by this module (the parent loads
  the module through `React.lazy`). The worker is `pdfjs-dist/legacy/build/pdf.worker.min.mjs?url`
  (same 6.4.299 build), set via `GlobalWorkerOptions.workerSrc`.
- `getDocument({ data, cMapUrl, cMapPacked, standardFontDataUrl, wasmUrl, iccUrl })` with
  every URL resolved from `./pdfjs/6.4.299/{cmaps,standard_fonts,wasm,iccs}/` against
  `document.baseURI`. The bytes come from the `Blob` in memory; nothing is uploaded and
  no CDN is used. A retry re-reads the Blob, because PDF.js moves the buffer to the worker.
- **One page at a time.** Only the current page has a canvas. Each paint uses a new canvas,
  so a cancelled task can never draw into the visible one. The previous canvas stays on
  screen (stretched) during a zoom or resize of the same page and is swapped out when the
  paint finishes. Old canvases are released (`width = height = 0`, which matters on WebKit).
- **Pixel budget:** device pixel ratio, capped so the backing store stays ≤ 8 Mi pixels
  and ≤ 8192 px per side. At high zoom the canvas is softer instead of running out of memory.
- **Cancellation and staleness:** the render effect cancels its `RenderTask` on page,
  zoom, resize, DPR change or unmount. Zoom and resize repaints are debounced by 120 ms.
  Every async step (`arrayBuffer`, `getDocument`, `getPage`, render, text layer) checks a
  per-effect flag before touching state or the DOM, so an old page or document cannot
  overwrite a newer one.
- **Text layer:** PDF.js `TextLayer` with `streamTextContent({ includeMarkedContent,
  disableNormalization })`, built on PDF.js's own CSS variables (`--total-scale-factor`,
  `--min-font-size`, `--scale-x`, `data-main-rotation`), copied from the 6.4 `pdf_viewer.css`
  contract. It is updated in place on zoom, so a selection survives zooming. The
  `selecting` / `endOfContent` behaviour mirrors `TextLayerBuilder`. The copy handler
  writes normalised plain text only; the transparent runs would otherwise paste
  invisibly as rich text. `innerHTML` is not used anywhere.
- **Teardown:** unmount destroys the loading task, which in turn destroys the document
  and its private worker. It also cancels render and text tasks, calls `page.cleanup()`
  on the page being left, releases the visible canvas, and calls `TextLayer.cleanup()`
  (PDF.js's measuring canvases).
- **Safety:** there is no annotation layer, so links, form widgets, attachments and
  document JavaScript stay inert; appearance streams are still painted onto the canvas.
  XFA stays off (PDF.js default), so XFA-only files show their static fallback page. The
  6.4.299 legacy display build was grepped for `eval(` / `new Function`, with no matches.

## Integration contract (parent)

```tsx
const PdfPreview = lazy(() => import("./PdfPreview.js"));
// in .file-preview, instead of the iframe and its blob-URL effect:
<Suspense fallback={…}><PdfPreview blob={preview.blob} name={block.name}/></Suspense>
```

- Copy `pdfjs-dist/{cmaps,standard_fonts,wasm,iccs}` into the build output at
  `pdfjs/6.4.299/` relative to the document. The URLs are passed as absolute URLs.
  On http(s) pages the worker fetches cmaps, fonts and wasm itself. On other schemes
  (Tauri, Capacitor) PDF.js loads those three from the main thread, using XHR. The CMYK
  ICC profile is always loaded with a synchronous XHR inside the worker. Both
  custom-scheme paths need a real check in the native shells.
- The root is `.pdf-reader` (`flex: 1; min-height: 0`), so the parent should keep
  `.file-preview` a column flex box with a bounded height. The old `.file-preview iframe`
  rule becomes unused.
- A drag-selection released outside the sheet must not close the dialog; that fix is in
  the parent.
- The component imports its own CSS (lazy chunk).

## Verification status

**Done here, statically:** every PDF.js call was checked against the installed 6.4.299
types and implementation: `getDocument` options, `onPassword(reply, reason)` with
`PasswordResponses`, `render({ canvas, viewport, transform, background })`, same-canvas
reuse being rejected, `RenderTask.cancel`, `TextLayer` constructor / `render` / `update` /
`cancel` / `cleanup`, `setLayerDimensions` CSS, factory URLs requiring a trailing slash,
and `loadingTask.destroy()` destroying the worker. All `t()` literals have English keys
with matching placeholders, and no API beyond the `ES2022` lib is used.

**Not done here** (the brief excluded commands): `tsc`, `vite build`, the translation
check script, unit and e2e tests, any browser run, any phone or native-shell run. Nothing
in this note claims those passed.

**Suggested acceptance for the parent:**

1. Chrome / WebKit desktop: a normal multi-page PDF. Body visible, page field, ← / →,
   Page Down at the edge, Ctrl + wheel anchored at the cursor, text selection and copy
   (pastes plain text), resize while at Fit width.
2. Rapid page flips and zoom taps: no wrong page on screen, no “same canvas” console
   error, memory flat over ~50 flips.
3. Encrypted PDF: wrong then right password; nothing written to storage.
4. Damaged file and non-PDF renamed `.pdf`: the invalid copy; 重试; Save as still works.
5. CJK PDF without embedded fonts (cmaps / standard fonts load locally, no network
   requests leave the app), a JPX/JBIG2 scan (wasm), and a page with `/Rotate 90`
   (text layer aligned).
6. 320 / 390 px viewports: no horizontal overflow, 44 px targets, bar wraps only at 320.
7. Real iOS and Android: pinch (anchored, no page zoom of the app), swipe vs. long-press
   selection, keyboard and password field without focus zoom, Tauri macOS trackpad pinch.
8. Close during load, during the password prompt, and mid-render: the worker terminates
   and there are no errors after close.

## Known limits / next

No search, outline, thumbnails, rotation control, clickable links or printing. Double-tap
zoom is deliberately left out until pinch is verified on devices. Browser password managers
may still offer to save the password; `autocomplete=off` is a hint, not a guarantee.
WebKit `GestureEvent` coordinates may be missing, in which case trackpad pinch anchors at the
view centre. `round()` in the text-layer size needs a current engine; older WebViews fall back
to the layer filling the page box, which is the same size.
