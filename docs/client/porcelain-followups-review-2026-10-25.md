# Porcelain phone follow-ups: PR 62 review

PR: <https://github.com/cloveric/tarobot/pull/62>.

The change separates captioned user attachments from the text bubble, refines
forwarded sources and long-image labels, simplifies phone inbox filters and
uses a neutral composer focus border. Monochrome Bot cards become white in
light mode. The follow-up voice change retains the full player width and
controls while reducing the phone player height. Other palette families retain
their presentation.

This is App presentation only. Host APIs, message routing, queues, model
adapters, stored data and headless CLI commands do not change. Merging this PR
does not release or install a new App.

## Reviewed revisions

- Main integrated for review: `989be8dc498e3d94ad39affdcdfac9d0e4e696ff`.
- Initial PR head: `43a9181a8ea36af6d087792637b16481da115c88`.
- Additional author change reviewed: `71bc2c29e5568521fbae64bf2fd1cb5aa84bcdab`
  (restore full phone audio controls; use the slimmer player height).

The main changes integrate cleanly. Recent Claude background-input fixes and
the neutral promotional artwork remain included. The review uses isolated
fixture Hubs and synthetic conversations, rather than the owner's live chats.

## Confirmed regressions and repairs

### Touch controls overlapped their neighbours

The proposed negative margins kept a nominal 44px button rectangle, but
neighbouring content covered part of the actual target. In a 390px browser,
the image overlapped the attachment actions by 11px. The Bot reply-source
button overlapped the author row by 10px and reply body by 14px. A hit near the
button edge reached the image or the first reply link instead. Unmodified main
did not have these overlaps.

The corrected rules keep the complete touch targets in normal flow. Internal
alignment puts attachment icons near the image and the source label near the
reply without covering adjacent content. Accessible names and click handlers
are unchanged. The new test measures `elementFromPoint` at both edges and the
centre, checks neighbour geometry, and follows the source to the original
message. Both 320px and 390px tests failed against the original PR.

### Inline link previews lost contrast outside the bubble

Opus's independent main/candidate comparison found that an inline link preview
beside an attachment retained the inverse bubble colours after its background
became the page. Monochrome light rendered white on white (1:1); dark rendered
near-black on near-black (approximately 1.03:1). This affected both phone and
desktop. The baseline remained readable.

Only the direct link-preview child of a split attachment message now remaps
its bubble foreground, muted, link and hover-background tokens to page tokens.
Text-only bubbles retain their inverse colours; other palettes are not changed.
Regression coverage reads actual contrast for titles, domains, icons and the
expand/collapse button, including hover, expanded details and collapsed
details. It covers image, file, audio and text-only messages at 320px, 390px and 1360px,
in light/dark Monochrome, Porcelain, Terminal and Pixel. All three widths failed
against the unfixed candidate.

### Quoted code retained the inverse bubble background

The split quote correctly inherited page text and syntax colours, but
`quoted-reply.css` also directly references `--self-code-bg`. That background
remained dark in Monochrome light mode, producing roughly 1.13:1 code contrast
(and roughly 1.16:1 in dark mode). The split quote now maps that token to its
inherited page surface. Expanded quoted code, syntax tokens and inline code
are checked in the same three-width regression; all three widths reproduced
the problem before this repair. Text-only quotes remain inside their bubble.

### Attachment action colours leaked into audio bubbles

Captioned audio remains inside the original bubble. The new quiet-action rule
matched every captioned attachment, including audio, and replaced the bubble
foreground with page-muted ink. The rule now matches only split photo/file
messages. Audio keeps the existing foreground and opacity; regression coverage
checks the resulting composited contrast on the phone. Desktop retains its
separate message toolbar without duplicate attachment actions.

The first phone filter's underline was also 6px right of its text centre.
Positioning now accounts for that item's asymmetric padding. The filter and
conversation-return journey passes after the adjustment. Narrow windows with
a mouse also keep text-only hover feedback instead of a square grey fill.

## Independent review

Opus 5.5 xhigh independently compared an unmodified main build with the
candidate, then rechecked the repairs in Chromium and WebKit. It reviewed
image/file/audio combinations, quotes with code, forwarded sources, compact
and desktop widths, Monochrome and Porcelain light/dark appearances, and
classic/Terminal palette isolation. It independently verified edge hit-testing
at 320px and 390px and measured the first filter underline at the text centre.
The reviewed repairs have no remaining blocker.

The apparent long-code overflow was excluded: the long line scrolls within
its code block and does not expand the page. Some existing image-only action
and legacy syntax colours remain below ideal contrast; baseline comparison
shows these are unchanged by this PR. This review does not redesign them.

## Verification boundary

`porcelain-followups.spec.ts` contains the new hit-target and link-contrast
regressions. The WebKit suite now includes both Porcelain specs and palette
coverage. Existing quote/forward, image/media, voice, phone filtering, density,
composer and adaptive-iPhone checks provide the surrounding integration
coverage.

- Root build and client translation/TypeScript/Vite build pass.
- Original candidate surrounding coverage: Chromium 44 passed / 1 conditional
  skip. The new touch tests then reproduced 2 failures, illustrating why box
  geometry and old passing suites alone were insufficient.
- Touch repair: Chromium 15 passed; WebKit 31 passed / 2 conditional skips.
- Phone filters, density, composer stability and adaptive iPhone: Chromium
  26 passed.
- The new link-contrast tests reproduced failures at all 3 widths before the
  repair. Final candidate, including the author's audio-height update and both
  repairs: Chromium 19 passed / 1 conditional skip; WebKit 17 passed /
  1 conditional skip. These runs include the two new regression groups, link
  preview journeys and real browser media playback/seek/close behaviour;
  Chromium also covers voice capture/drafts.
- The quoted-code and audio-action repairs add a final round of 18 checks in
  each engine. After correcting the fixture assumptions below, all 18 pass
  (13 unchanged integration checks plus the 5 expanded regression checks).
- Distinct successful coverage across these runs, without counting reruns
  twice: Chromium 78 passed / 1 skipped; WebKit 44 passed / 2 skipped. No
  unresolved failure. The skips are the optional owner-supplied MP4 fixture in
  each engine and unsupported forced-colors emulation in WebKit.

The final expanded test initially exposed two incorrect fixture assumptions:
desktop does not render the phone attachment toolbar, and the unchanged
Terminal-light syntax keyword has 4.33:1 contrast in both main and candidate.
The test now asserts no duplicate phone toolbar on desktop and applies the
new quoted-code contrast threshold to the Porcelain/Monochrome palettes
changed by this PR. Existing Terminal/Pixel link and quote journeys remain
covered; their syntax palette is not redesigned here.

GitHub Actions for the author's final head did not start: both Source checks
and Secret scanning report account payment/spending-limit restrictions, with
no runner steps. Job IDs are `121192768705` and `121192769051`. These are not
passing remote checks. Local verification above remains separate from CI.

Browser platform attributes, touch emulation and WebKit checks are not physical
iPhone/Android or native Mac acceptance. This task does not install an App or
restart the production Host.
