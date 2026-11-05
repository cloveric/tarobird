# Lightweight document reading

Word attachments previously opened a blank unsupported-file dialog; Markdown
attachments displayed only source text. Both now use the existing modal/file
transfer/export lifecycle with a responsive reading surface.

- `.md` / `.markdown` use the existing worker-backed Markdown renderer: headings,
  lists, tables and code. Existing raw-HTML and opt-in external-image policy stays
  intact. A 256 KiB preview limit has an explicit notice; original bytes still save.
- `.docx` loads a separate Mammoth worker only when opened. Semantic headings,
  paragraphs, emphasis, lists, tables and embedded PNG/JPEG/GIF/WebP images render
  locally. This is a reading view, not Word pagination/editing. Old `.doc`, complex
  page design, unsupported images, encrypted and damaged files retain Save As.
- DOCX input is limited to 10 MiB; actual ZIP inflation is bounded to 32 MiB total,
  16 MiB per entry and 2,000 entries. Validated entries are repacked before parsing
  to avoid trusting a different central-directory interpretation. Image output,
  HTML size, element count and processing time are bounded. Closing terminates the
  worker, including startup; completed parsing terminates it too.
- External file access and embedded style maps are disabled. Semantic HTML is
  sanitized, document styling/scripts/frames removed, link protocols restricted,
  and only embedded raster image data may load automatically. No external Office
  service, account, SDK or heavyweight editor is required.

Implementation: `attachment-export.ts`, `DocumentReader.tsx`, `DocxPreview.tsx`,
`docx.worker.ts`, `docx-archive.ts`, `document-html.ts`, `document-preview.css`.
The design follows Mammoth's [semantic conversion and security guidance](https://github.com/mwilliamson/mammoth.js#security).

## Verification and size

- New frontend output totals **361,678 bytes** beyond the prior build. The Word
  worker is 326,832 bytes (101,798 gzip), its lazy UI/sanitizer chunk 30,543 bytes
  (12,258 gzip). The worker is not requested before opening Word. These are built
  resource sizes, not measured native process-memory usage.
- Three archive tests pass, including forged ZIP size metadata and actual
  decompression limits. Root/client builds pass.
- Chromium: new document journeys and PDF regressions passed except one first run
  where an overlapping rebuild removed a PDF worker asset (trace confirms 404).
  That exact PDF test passed after the build, alongside the new Word startup-close
  case. No assertions were weakened.
- WebKit: all 11 document/file-action cases pass. Desktop, 390px and 320px verify
  heading/list/table/image reading, long-document scrolling, original downloaded
  bytes, focus restoration, malformed/large/legacy fallback, no automatic external
  requests and parser cleanup. Browser native-file dialogs use existing doubles.
- A separate macOS App 1.0.11 preview paired to a disposable Hub opened both real
  fixture attachments through the native transport. Word/Markdown rendering and
  close-to-file focus were verified in the native window. No real Bot was invoked.
- Physical Android/iOS were not tested. The Android APK is built and signed with
  the existing test key. Mac remains ad-hoc signed, not notarized.

Pre-release: `0.1.384-test.1`, desktop 1.0.11, Android code 2026101112.
