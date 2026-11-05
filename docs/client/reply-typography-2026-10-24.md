# Restrained reply typography

The reported DeepSeek reply combined normal prose, strong emphasis, headings
and strong emphasis inside headings. The App already prevented nested heading
emphasis from stacking weight, but ordinary emphasis still used browser bold
and heading sizes ranged from the App's enlarged h1 to browser-default h5/h6.
This is shared App presentation, not a DeepSeek-specific renderer defect.

`reply-typography.css` opts authored Bot prose into a restrained hierarchy:
normal body text retains its selected size; emphasis and headings use semibold;
h1/h2 have small relative size steps while the remaining semantic heading levels
keep body size. Section spacing provides hierarchy without large type jumps.
Lists, quotes, links, inline code, fenced code, tables and formulas retain their
existing rendering and theme treatments. Headings remain semantic headings.

The `reply-prose` marker covers native public replies, legacy card prose,
plain Bot replies, attachment captions, side answers and complete reply readers.
The marker is opt-in on `MarkdownText` itself, not on a containing card; nested
forms, layout columns and collapsible process records keep their existing styles.
Expanded table readers retain the origin marker for consistent emphasis. The legacy run-status label, user messages, document readers and standalone
task descriptions keep their previous typography. Other top-level Markdown in
Bot cards, including ordinary receipts and notices, uses the restrained hierarchy.

The terminal themes retain their more-specific flat heading scale and markers.
Pixel font identity, Android/iPhone density and independently chosen ADHD/body
reading sizes remain unchanged. No provider-specific output rewriting, prompt
change, extra streaming parsing, animation or new font dependency is involved.
The added section spacing also applies in terminal themes; their message heading
scale remains flat. Side/full-reply readers keep their pre-existing theme boundary
outside `.message`; this change does not extend terminal selectors to those readers.
Historical replies receive the display adjustment when rendered; their persisted
text, copy/export content and message ownership are unchanged.

CLI impact: not applicable. This changes only App reply presentation, not Host
or CLI adapters, message queues, native task controls, schema, capabilities,
scope/origin/provenance checks or the A+C grouped background cards and dock.

## Validation

The pre-change regression reproduced body emphasis at weight 700 rather than
the intended restrained emphasis. Browser checks cover all six heading levels,
nested emphasis, regular body text, lists/quotes/links, source-preserving code,
no horizontal page overflow, native/legacy/plain surfaces, terminal/pixel themes
and independent ADHD reading sizes. Existing task-description, background-report,
plain-text wrapping, clipboard and saved-font-setting cases are included.

Initial runs exposed an incorrect test locator: the first legacy Markdown
block is the status label, not the reply. The corrected locator selects the
authored text; additional assertions keep legacy status/process styles outside
the new scope.

Browser screenshots at 390 and 1360 pixels cover light and dark modes. They are
rendering fixtures, not physical iPhone/Android acceptance. Source verification
does not install, restart or release the App.

The perceived difference between semibold and bold depends on the platform font.
Browsers verify the requested CSS weight, not the physical Android/iPhone font
face. Smaller headings and narrower emphasis can produce normal text reflow.
The source still decides which passages are emphasized; this change preserves
that meaning instead of removing Markdown from the response.


Independent Opus 5.5 xhigh reviewed the approach and then the final patch plus
phone-light/desktop-dark screenshots. No blocker remained after moving the marker
to `MarkdownText`, limiting heading spacing to chunk-level headings, retaining
the expanded-table marker and fixing the legacy test locator. The terminal
spacing trade-off and actual platform-font limitations above are intentional.


Final root validation:
- 72 Chromium cases passed: 70 reply/theme/background/plaintext/table cases,
  plus two side-conversation interaction/theme cases. The full-App font and
  table cases use the production client bundle, not just the Vite fixture.
- 31 distinct WebKit cases passed. Two new assertions initially compared a CSS
  float as an exact string (18.200001px vs 18.2px); numerical tolerance fixed the
  assertion. All four Bot/user table-reader cases passed the focused rerun.
- 114 unit cases passed in `core-card-renderer`, `gateway-cards` and
  `client-background-task-groups`.
- Client translation/type/production build and Host standalone build passed.
  Existing Capacitor keyboard import and fixture symlinked KaTeX-font warnings
  remain non-blocking. The existing formula-rendering checks pass.
- The complete repository and physical-device suites were not run for this
  presentation-only change. No native App install or restart was performed.
