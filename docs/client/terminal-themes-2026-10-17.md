# Terminal-family styles: TTY, Paper and Agent

Three additional **特色主题** join Terminal CLI and Pixel. They are separate
palettes (`tty`, `paper`, `agent`); the existing `cli` style is unchanged. Each
follows the light/dark/system theme control and persists like every palette.

## Selecting a style

**设置 → 通用 → 配色风格 → 特色主题**, then choose:

| Palette | Name | Direction |
| --- | --- | --- |
| `tty` | 终端 TTY | A tmux session: square cells, `❯` prompt lines, a gutter for Bot output, reverse-video cursor rows, `#` section labels, bracketed tags, box-drawn titled cards and code panes with their language and `[复制]` tags in the top rule. The input is a prompt line under a single rule. Dark is near-black with ANSI-like green/blue/magenta/yellow; light is a white terminal. |
| `paper` | 电传纸 | A line printer: paper tones, 2px ink rules, uppercase double-ruled headings, horizontal-rule tables, a `$` prompt, ink title bars, an inverted status stamp for finished runs and one signal orange for the cursor, focus ring and background-task tag. Dark mode prints in light ink on near-black. |
| `agent` | Agent 终端 | An agent TUI: small rounded panes, a `>` prompt block with an edge rule, `⏺` heading marks, rounded code/table panes, a dashed amber pane for background reports and a taro-violet accent. |

All three use the bundled Sarasa Term SC grid (Latin:CJK = 1:2), keep reading
text at the user's chosen size (headings and tables do not scale up) and keep
the native system-bar colour synchronized from a literal `--bg`.

## Implementation

- `client/src/palettes.ts` registers the palettes in the expressive family;
  `ExpressivePreview.tsx` draws their paired light/dark settings tiles.
- `client/src/terminal-themes.css` holds the tokens (light, dark and system)
  and the shared terminal kit, then the per-style rules. It is imported after
  `cli-typography.css` and uses no `[data-palette=cli]` selector, so the CLI
  style's rules and look are not affected.
- Prompt glyphs are background images of the input and of own prompt blocks:
  they never enter the draft, accessible value or clipboard. Other decorative
  glyphs are generated content with empty alternative text.
- Own turns and files stay square in every style; avatars, presence dots and
  uploaded media keep their own shapes and artwork. Phone controls keep their
  44px targets, including the code `[复制]` tag. Forced-colours mode drops the
  painted decoration.
- ADHD panes keep their own reading size in these styles.

CLI impact: presentation-only. No host API, protocol, storage schema or
headless CLI command changes; desktop, phone and headless hosts are unaffected.

## Verification

Chromium and WebKit:

- `palettes`: every palette (now including the three) passes rendered contrast
  ≥ 4.5 for message text, links, syntax, copy tags, quotes and file cards in
  light and dark, theme-colour synchronization, persistence, system-mode
  switching, unique own-turn colours and square own turns.
- `terminal-themes` (new): for each style and mode on desktop and phone, the
  monospace grid, the painted prompt, reverse-video cursor rows, square own
  turns, unscaled headings, settings tiles, draft retention and no horizontal
  overflow; switching back to `cli` leaves the CLI tokens untouched.
- `theme-font-size`, `cli-typography` and (Chromium) `run-formatting` and the
  every-palette `conversation-folders` checks.

The run-formatting fixture now loads `terminal-themes.css` in the same order as
production, so native and legacy replies are compared under the real styles.

## PR #44 integration review

Reviewed the PR against `main` after the multiline phone composer and README
updates. Found and reproduced one layout defect: terminal prompt placement used
`rem`, so a 20 px ordinary-chat preference with an 11 px ADHD pane moved the
prompt 8 px below its first text line. Prompt placement now uses `em` from the
textarea, preserving the independent ADHD font size. Normal-chat geometry is
unchanged. The existing Terminal CLI palette is outside this PR's style rules.

Added a browser regression with two independent drafts, all three new palettes,
light/dark modes, a 20 px main window and 11/16 px ADHD panes. It failed on the
original PR at the measured 8 px offset before the correction.

Local verification during integration:

- Full source gate: 325 test files, 4,310 passed and one existing skip; standalone
  build/graph check passed. No host code changed in this PR or the CSS correction.
- Client translation check, TypeScript check and production build passed,
  including a second build after the correction.
- Broad Chromium review: 65 passed across ADHD, terminal themes, palettes,
  conversation folders, composer sizing, reading size and run formatting.
- WebKit review: 11 passed and one existing touch-only skip across themes,
  palettes, composer sizing and reading-size checks.
- After the correction, both terminal-theme tests passed in each browser,
  including the new independent-font regression.
- A four-pane ADHD preview passed 12 combinations (three palettes, two modes,
  11/16 px reading sizes): independent drafts survived, the main preference
  stayed at 20 px, prompt alignment stayed within 1 px, composer controls
  remained 28 px, and inputs stayed visible without shell overflow. Reviewed
  the resulting light/dark screenshots.
- All five run-formatting cases passed again with the isolated worktree's
  linked font directory admitted to its temporary Vite fixture. The initial
  run hit that development-server allowlist; the fixture adjustment was
  reverted after verification and is not a product change.

GitHub Actions run `39040050540` executed no steps because of account
billing/spending limits. Local results do not claim a successful cloud CI run.
Browser checks use isolated demonstration data; installed desktop Apps and
physical phones were not upgraded or accepted by this merge.
