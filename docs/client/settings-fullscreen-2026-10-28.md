# Phone settings as full pages

The Device & Network screenshot showed the Me page behind a rounded bottom
sheet. The previous content redesign had kept the shared `CreationDialog`
phone-sheet container. This change makes settings navigation fill the current
phone window, with a persistent leading Back button and a separate scrolling
body. It applies to both portrait and touch landscape. Desktop retains compact
modals and dragging.

## Covered settings

- Device & Network: overview, add device, create/join network, host details,
  route synchronization and network change review.
- This device's connections and host renaming.
- Bot settings: model, effort, permissions, persona, Chrome integration, name,
  avatar and Bot message grants.
- Conversation/group settings, conversation avatars and folder management.
- Device management and the multi-step pairing wizard.
- General, notifications, device/security and connection/route preferences
  already filled portrait windows; they now retain that layout in touch
  landscape and while the keyboard changes the available window.
- Runtime and Skills/MCP settings already use their full-page shell.

Confirmations, action menus, pickers and short explanations retain their modal
layout. Tool workspaces such as scheduled tasks, archive and file center are not
settings and are not changed by this patch.

## Implementation and behavior

`CreationDialog.mobilePage` is explicit. Its body remains mounted across window
changes, using `display: contents` for the established desktop layout. Existing
Back, close, busy, focus and unsaved-change handlers remain in control. Pairing
keeps its custom repeated-Escape handling and separate Back/exit actions.

The page consumes the shell's current visible height and safe insets once. Its
body observes keyboard/viewport changes to keep a focused field visible. Sheet
height clamps in safe-area, generic keyboard and iOS CSS exclude full settings
pages. The same width-or-touch media query is used for phone layout and disabling
dialog dragging. Direct-child form, section, consent and note styles include
the new wrapper; nested confirmations do not inherit the page geometry.

## Verification

Verification receipts and screenshots are retained in
`/Volumes/gdrive/taro-tmp/settings-fullscreen-20261028`.

- Baseline reproduction: network overview geometry failed the full-page
  assertion (20px top radius, incorrect viewport bounds).
- Final focused results: **37 Chromium + 10 WebKit cases pass**. Chromium:
  device layout (2), group phone layout (1), mobile Bot settings (3), full-page
  journeys (2), conversation settings (15), dialog history (1), group settings
  (4), pairing invitation lifecycle (2), persona/mobile polish (2), preferences
  navigation (5). WebKit: the first four groups (8) plus persona/mobile polish
  (2). Root build, client translation/type/build checks and `git diff --check`
  pass.
- Full-page journeys use disposable real Hubs and cover Android/iOS inset
  simulations, portrait/touch landscape, keyboard height, nested rename drafts,
  compact discard confirmations, pairing Back versus exit, four preferences
  categories and folder subpage Back. With a 24px left inset, preferences header
  controls start at 36px and content at 40px, consuming that inset once.
- Actual Opus 5.5 independently inventoried and reviewed the diff. Its folder
  subpage Back finding, compact iOS inset conflict and pairing bottom padding
  finding were resolved and rereviewed. The final CSS inset follow-up has no
  remaining blocker. Reports: `opus-inventory.md`, `opus-final-review.md`.
- Early failures retained in the artifact directory include corrected test
  assumptions: dynamic viewport dimensions, the existing rename action label,
  explicit mouse input for the desktop persona case, waiting for category slide
  animations before overflow checks, and entering Messages before folder tools.
  The passing final reruns are `fullscreen-final.log`,
  `webkit-fullscreen-final.log`, `persona-final.log`; unaffected successful cases
  are in `pages-final.log`, `regression.log` and `webkit.log`.
- Host/CLI assessment: presentation-only; no API, persistence, runtime, protocol,
  package version or native binary changes. Root and client build checks cover
  integration; disposable Hub fixtures do not call a real model.
- Browser layout and simulated insets/keyboard are not physical Android/iPhone
  acceptance. No installer or local App update is produced by this change.

## Follow-up: category label weight

Phone settings category labels now use regular weight (400), matching the Me
page entries immediately before them, including touch landscape. This changes
only label weight; header hierarchy, font sizes and desktop sidebar labels are
unchanged. Host and CLI are unaffected because this is a CSS presentation fix.

Verified with disposable Hub/browser inspection in Chromium and WebKit: all
seven category labels and the preceding Me action rows compute to weight 400,
in portrait and touch landscape; desktop category labels remain 500. Client
translation/type/build checks pass. Screenshots and `computed-weights.json` are
in `/Volumes/gdrive/taro-tmp/settings-weight-20261028`. No new tests or native
installation were needed for this isolated CSS change.
