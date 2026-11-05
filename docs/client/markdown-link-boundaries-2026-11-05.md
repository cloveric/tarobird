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
