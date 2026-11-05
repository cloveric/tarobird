# GitHub showcase refresh — 2026-10-28

Both homepage languages now show the current **Monochrome + Light warm gray**
appearance. Desktop, phone, ADHD, Agent Bus, feature crops and the five-scene
animations were recorded again from the real shared client. Covers and framing
use matching warm neutrals; the original fox artwork and engine-logo strip stay
intact. The optional theme gallery shows light and dark Monochrome appearances.

## Source and scope

- Shared-client source: `91853e0089edabf20e1e78c2975d9b578dcb14da`, package label
  `1.0.118`, with documentation fixture changes. The manifests explicitly record
  `sourceDirty: true` and the built entry/index SHA-256 hashes.
- This source includes the message-icon and sidebar-drag presentation follow-ups
  after the published 1.0.118 artifact. These are development-source captures,
  not screenshots or acceptance of that installer or a physical phone.
- Each recording uses a disposable loopback Hub and browser profile, authored
  example messages and existing catalog avatars. No private chats, screenshots,
  account credentials or user-avatar exports are published.
- The fixture selects ordinary saved `palette: mono` / `monoAccent: warm-gray`
  preferences and verifies the actual `#e7e2dc` control-fill token. No product
  CSS or controls are hidden or restyled for recording. Other Bot groups are
  folded with their normal disclosure controls to fit the desktop hero.
- Recording scripts now follow the current invitation-based pairing flow in
  their disposable Hubs. Demo bridges and Bus responses remain synthetic;
  no model runs, repository pushes or production collaboration are performed.

## Requested portraits

All seven appear together in both desktop heroes, both phone inboxes, both
ADHD lists and the opening desktop scenes of both animations.

| Example Bot | Existing catalog portrait |
| --- | --- |
| Codex | `pastel-fox` |
| Claude | `peach-patch-cat` |
| Kimi | `cream-bunny` |
| DeepSeek | `mini-octopus` |
| Gemini | `mini-matcha` |
| Antigravity | `mini-clownfish` |
| Claude · Studio | `mini-bluebird` |

## Verification

- Host build and client build passed. All changed capture/composition scripts
  passed `node --check`; `git diff --check` passed.
- All five capture scripts completed in both languages: **28 raw PNGs and
  2 GIFs**. Their assertions cover saved appearance, avatar coverage, the
  demonstrated interaction states and browser errors. Every raw-output hash
  matches its capture manifest.
- **14 PNG compositions**, including both covers, were regenerated. Framing
  preserves capture proportions. Representative desktop, phone, ADHD, Bus,
  feature and light/dark images, plus animation scene frames, were inspected.
- Both READMEs rendered through GitHub's Markdown API. Local previews of that
  HTML at **1080 and 390 CSS pixels** loaded all ten images per language,
  preserved aspect ratios and had no horizontal page overflow. The preview
  stylesheet is local, so this does not claim pixel-identical GitHub chrome.
- All **21 distinct artwork links per README** resolve. The
  [verification manifest](../../assets/product/visual-refresh-verification.json)
  records all 44 output dimensions, sizes and SHA-256 hashes, portrait coverage,
  build identity and responsive-preview results.
- The unrelated `client/android/gradlew.bat` edit is excluded. Its working-copy
  SHA-256 remains `1d297e00bd21de3ace22b4d7f2de1f9dfa858883d66bbf7c1ccbecccec8f4f3b`.

This change is documentation and recording tooling only. App, Host and headless
CLI behavior is unchanged; CLI commands and an installer release are not
applicable. It does not alter the installed Mac or the user's theme preferences.
See [capture and reproduction instructions](../../assets/product/README.md).

## English sidebar-label follow-up

The previous `By conversation` text exceeded its equal-width button in the
English desktop showcase. The English translations now use `Bots` and `Chats`
beside `ADHD`; both the visible labels and accessible names change together.
Chinese labels, sizing, switching behavior and saved preferences are unchanged.
The README instructions and capture selector use the same new names.

Six English raw desktop/ADHD/Bus captures, four compositions and the English
five-scene demo were refreshed from base
`89143880795d23dea9eea9a393115d69d41393db` plus this change. Other artwork retains
its original bytes and provenance. The captures use the same real shared UI,
Monochrome + Light warm gray and synthetic fixtures as the initial refresh.

Validation: client build (translation check, TypeScript and Vite), capture-script
syntax and `git diff --check` passed. Capture assertions measure each visible
switch button's text/icon bounds and scroll width. All three labels fit the
79 px buttons in the desktop/folder/light/dark captures and approximately
84.3 px buttons in ADHD/Bus. The actual desktop capture was visually inspected.
Animation recording exercises the existing desktop/phone approval and ADHD/Bus
flows. Output hashes are refreshed in the verification manifest. This does not
claim physical-device acceptance or a new installer. CLI is not applicable:
the only product change is two English presentation strings.

## Markdown icon correction

`launch-notes.md` was correctly identified as MD in its accessible label, but
the shared icon classifier grouped Markdown and plain text under the visible
`TXT` mark. Markdown now has its own display category and `MD` mark. `.md` and
`.markdown` match case-insensitively, even when uploaded as `text/plain` or
`application/octet-stream`; `text/markdown` and `text/x-markdown` also supply a
hint when the filename has no recognized extension. Known final extensions
still take precedence, so `.txt` stays TXT and `.md.zip` stays ZIP. Generic text
MIME fallbacks still use TXT.

The same component serves sent attachments, conversation files, draft files
and rich references. Preview, original-byte download, MIME validation and file
contents are unchanged. This is client presentation only; no Host or CLI
command change is applicable and no installed App is changed.

The main README captures in both languages were regenerated with an explicit
assertion that the rendered attachment badge is MD. Other capture families and
demo animations contain no affected attachment badge and are unchanged.
Validation: client translation/TypeScript/Vite build; ten focused classification
checks covering extension/MIME precedence and generic text fallback; two rich
reference unit tests; existing Word/Markdown browser cases at 1360, 390 and
320 px. Browser cases verify formatted reading and original-byte download.
Capture hashes and composition dimensions are recorded in the artwork manifest.

## Homepage screenshot polish

The next documentation pass uses shared-client commit
`d6b7c82c0df267005a5125e3d314700bbfb49fa2`, which includes the short English mode
labels, MD file badge and compact desktop list menu. The demonstration release
plan uses shorter table cells and conversation titles. The theme and seven
catalog portraits are preserved. No production message, model request or user
setting is involved.

`capture-readme.mjs` now records the ellipsis menu in both languages through
real pairing with two disposable Hubs. A single-host list intentionally does
not show the host-grouping option; the new capture exercises the genuine
multi-host state and checks all three menu actions and Escape dismissal.
The two homepage galleries link these full-size screenshots and explain the
ellipsis entry. Main desktop, phone, folder and light/dark captures and their
workspace/phone/theme compositions are refreshed. Other capture families and
both animations are already current and retain their bytes and provenance.

CLI impact: not applicable. This changes documentation and synthetic recording
fixtures only, with no product, protocol, runtime or installer changes. Local
capture, asset and responsive-preview evidence is recorded in
`assets/product/visual-refresh-verification.json` under `homepagePolishFollowup`.

Validation: fourteen raw PNGs and six composed PNGs were regenerated; all
thirty-two current raw captures match their manifests. All forty-four prior
artwork dimensions are preserved; the two new menu images are 2400 × 1560.
Both READMEs have twenty-two distinct valid artwork links. GitHub Markdown API
previews with local CSS at 1080 and 390 px load all eleven images per language,
including the expanded gallery, with no horizontal overflow or distorted aspect
ratios. Source syntax and `git diff --check` pass. No product tests or installer
build were needed for this documentation-only change.
