# New Bot form refinement — 2026-11-04

The New Bot sheet previously presented model setup, a long CLI prerequisite,
dispatcher explanation and permissions as one continuous column. The revised
form separates identity, model setup, and role/permissions with short captions
and dividers. The runtime host is a compact caption. Model and effort share a
row only when the dialog has enough width; phone fields remain stacked.

The dispatcher choice is a bordered option with its creation-only restriction
always visible. Additional explanation and dispatcher settings appear after
selection. The prerequisite still names the owning host and requires CLI
installation plus sign-in or API configuration; executable detection is not
presented as authentication readiness. Permission descriptions remain visible.
Catalog failures and missing-CLI notices lead the form, with retry outside the
disabled fieldset, so the explanation is visible without scrolling to the end.

`client/src/new-bot.css` is scoped to `.bot-setup`. It uses the existing palette
and warm-gray primary button, without changing global density, reading size,
other dialogs or stored appearance settings. The mobile title/close action stays
outside the single scrolling form. The action area is in normal document flow
so it cannot cover a focused field when the keyboard reduces the viewport.

Creation requests, retry request IDs, selection normalization, busy/pending
guards, catalog recovery, optional workspace and the created-Bot flow are
unchanged. This is App presentation only; the headless CLI is not applicable
because there is no new host capability, API or configuration behavior.

Opus 5.5 implemented the form, scoped CSS and English copy in an isolated
checkout. Root independently reviewed the diff and owns validation/integration.
Actual Opus execution was verified from the native session's model metadata.

Validation:

- Host build, client translation check, TypeScript and production build passed.
- Chromium: 7 existing creation/dispatcher/catalog-recovery cases, 5 layout
  probes (320/390/430/1360, Chinese/English, light/dark), and 2 keyboard-window
  shrink cases passed.
- WebKit: mobile creation, catalog recovery and the 320/430 keyboard-window
  shrink cases passed (4 cases).
- Final source hashes were checked against the frozen production bundle.
  No horizontal overflow was found, and advanced fields and the create/close
  actions remained reachable.

The final follow-up moved only catalog failure/missing-CLI notices to the top.
The new viewport assertion failed on the preceding frozen bundle (intersection
ratio 0), demonstrating the hidden-error problem. The catalog regression now
also checks that the retry control and missing-CLI warning are initially in view
and creation remains disabled without an available CLI. This affected path
passed again in Chromium and WebKit against the rebuilt reviewed bundle; the ordinary
form, success flow and keyboard geometry are unchanged by this follow-up.

The temporary layout probe is retained with the task evidence. Its first English
run needed a navigation correction after leaving Settings. An intermediate
WebKit keyboard run overlapped CSS/locale hot reload and failed; the final
unchanging-source run passed both widths. These initial artifacts are retained
and are not counted as final passes. Opus's auxiliary screenshot harness also
had navigation/timeout failures; Root's final Hub-backed browser runs are the
acceptance evidence.

Evidence is recorded under
`/Volumes/gdrive/taro-tmp.noindex/new-bot-ui-20261104/`. Browser fixtures do not
establish physical Android/iPhone, installed Mac App or real model acceptance.
This change does not publish or install a release.
