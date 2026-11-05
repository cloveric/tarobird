# Bare links beside Chinese prose

A question such as `Open https://example.test/login/device，输入新代码` made
the Chinese comma and following instructions part of the clickable URL. GFM's
literal autolink parser accepts those characters in a URL path; rehype then
percent-encodes the incorrect destination.

`markdown-link-boundaries.ts` splits bare HTTP(S)/www links at common Chinese
sentence punctuation before conversion to HTML. The suffix remains visible
prose. Link source positions distinguish bare links from explicit `[label](url)`,
reference links and `<url>` autolinks; explicit destinations remain authoritative.
Chinese URL letters, query strings, fragments, balanced ASCII parentheses and
percent-encoded punctuation are preserved. A bare URL containing actual sentence
punctuation should use explicit Markdown or percent encoding to disambiguate it.

The shared Worker parser covers replies and native question cards. No stored
messages, network requests, OAuth scopes or credentials change. CLI impact is
not applicable: this fixes App rendering only, leaving CLI output untouched.

## Verification

- Before the fix: 27 of 31 new parser cases failed, including the reported
  authorization-question shape; four compatibility cases already passed.
- After the fix: 59 focused parser/image/currency assertions passed.
- Chromium and WebKit: 11 Markdown browser tests each passed. The new regression
  checks streaming updates, real QuestionForm rendering at 390 and 1360 pixels,
  complete prose/code display and the URL opened by an actual link click.
  External navigation is intercepted with a synthetic page.
- The existing same-step question-focus regression passed with the URL fixture.
- Host build and client translation/type/Vite build passed.

This is source and isolated-browser evidence, not installed-App or physical-phone
acceptance. No new release or local App replacement was performed for this fix.

## Release audit follow-up

The audit found that the first split retained a trailing ASCII period or an
unmatched closing parenthesis, and made a second adjacent URL plain text. Each
separated segment now uses the existing GFM parser's URL recognition and endpoint
rules. Only exact-source literal HTTP(S)/www links are retained from that parse;
all other characters remain text, so detached prose does not acquire Markdown,
HTML or new protocol interpretation. No dependency was added.

Chinese ellipses (`…`), a doubled em dash (`——`) and fullwidth tilde (`～`) also
separate prose. A single em dash and ASCII tilde remain URL characters. Explicit
Markdown/autolinks and percent-encoded punctuation still disambiguate intentional
URL punctuation, including the three added separators.

- Before this follow-up: seven of 39 parser cases failed. The first post-fix run
  exposed an incorrect test expectation that GFM links `www` inside a preceding
  word; the fixture was corrected to place the URL directly after punctuation.
- Final focused parser/image/currency run: 67 assertions passed, including all
  39 link cases. Client TypeScript checking passed.
- Full Chromium and WebKit passed the extended Worker/real-click regression at
  390 and 1360 pixels, including the second adjacent URL and captured rendering.
  Chromium used its bundled full-browser headless channel. The default Chromium
  headless shell stalled repeatedly during frame-dependent clicking/screenshot
  capture after DOM/href assertions passed; those failed runs remain recorded
  separately. Firefox was unavailable and is not counted as verified.
- The original independent audit probe now keeps both comma-adjacent URLs
  clickable and excludes the reported punctuation from each destination.
  Its generic text round-trip flag is not a valid assertion for table, list,
  quote or strong Markdown syntax; those cases were not counted as plain-text
  round-trip successes.

These checks cover App parsing and isolated fixtures. They do not assert a
physical-phone, installed-App or release acceptance result.
