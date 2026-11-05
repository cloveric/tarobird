# History search keyword highlighting

Search results previously rendered excerpts as plain text, making it difficult
to locate the matched words. Current-conversation and host-wide search now mark
every non-overlapping literal occurrence in the displayed excerpt. Highlighting
uses the applied query, including during pagination or a failed next-page
request; editing the filter field alone does not relabel existing results.

The renderer follows the Hub's ASCII case-insensitive matching and exact Unicode
matching. Punctuation is literal, not a regular expression. It preserves text
and uses React text nodes rather than HTML injection. Existing readable Markdown
and Bot-name previews remain unless they would hide a matched URL, marker,
whitespace sequence or ID; that excerpt then retains its original text.

Highlights use theme colours, inherit the existing font and size, wrap with the
snippet and add no layout padding. Forced-colour mode uses system mark colours.
The existing message-focus behaviour after opening a result is unchanged.

This is an App presentation change. Search APIs, result membership, pagination,
stored messages, Host and headless CLI behaviour are unchanged. No CLI command,
protocol migration, release or installed-App update is part of this change.

Validation covers literal Chinese, repeated/case-varied matches, emoji and
Unicode offsets, special characters, preview fallback, filter/query races,
pagination, navigation, deletion sync, mobile wrapping and light/dark contrast.
Browser evidence does not establish physical iPhone/Android or native-shell
acceptance.

Verified locally: 29 focused unit tests; 10 Chromium and 10 WebKit browser
journeys, including the existing search and deletion-sync suites; Host and
client builds. The two new visual journeys initially sampled an in-progress
theme colour transition; they now use the existing reduced-motion preference
to measure stable theme colours, and pass in both browsers. No product colour
rule was relaxed to make those checks pass. Screenshots were inspected at
390 and 1360 CSS pixels; text contrast was checked across nine colour families
in light and dark modes.
