# README artwork and product screenshots

## Quick start connection diagrams (2026-11-04)

Both homepages use compact Mermaid flowcharts in the existing Quick start
section. The three rows show a local-network route, a Tailscale private-network
route and a VPS relay route to the same computer. Rounded nodes, restrained
warm accents and consistent spacing keep the routes easy to compare. The VPS
is labeled as a relay; Bots execute on the computer.

The earlier 3D illustrations and their generation prompts were removed from
the current tree. Their historical media-review records remain intact.
Local previews cover both languages, desktop/phone widths and light/dark
surroundings. These conceptual diagrams are not real-network acceptance.
This documentation-only change has no App, Host or CLI behavior impact and
requires no version bump or installer release.

## Homepage structure and motion refresh (2026-11-04)

The English and Chinese homepages retain the original order: cover and demo,
desktop, phone, ADHD, Agent Bus, then conversation tools. Workbench, screen
control and Chancellor follow those sections. New functionality does not replace
the opening product story. Headings stay in Markdown; screenshot frames use
small labels instead of repeating the same headline inside the image.

The latest inbox, Workbench and browser recordings use source
`a0411ba26bfac96a5372e1022d838447eaa584af` plus the documentation fixtures in this
update. Existing desktop and phone stills retain their individually recorded
source revision. Seven distinct Bot portraits are visible in the main scenes;
task-oriented lists use different Bots instead of repeating one portrait across
most rows. Read receipts are set through the isolated Host store. No product
avatar, user preference or installed App state changes.

- `demo-capture.json`: the opening eight-part overview starts with conversations
  on desktop and phone, switches Chats/Bots, and continues a shared conversation.
  ADHD and Agent Bus follow. Advanced features appear later: webpage browsing,
  canvas editing, side panel with whiteboard/notes, screen control and Chancellor.
  Each segment names its source recording and exact hashes. It contains no PPT
  or approval scene.
- `inbox-capture.json`: actual desktop/phone shared UI in two browser contexts,
  with seven distinct Bots and fictional conversations. This is not physical
  phone or installed-App acceptance.
- `capture.json`: existing desktop, phone, folders, list options and theme stills.
- `workspaces-capture.json`: canvas, whiteboard, Markdown, side panel and
  Chancellor stills/recordings. The canvas sequence double-clicks and edits a
  headline and shows the updated composition; a read-back verifies persistence. Every sidebar Bot has
  its own portrait. PPT is mentioned only in the homepage's Workbench feature list.
- `browser-capture.json`: the production Electron WorkbenchBrowser in an isolated
  documentation harness. It opens a fictional local journal, takes control,
  scrolls the page, follows an article link and reads further. The renderer and
  native webpage surfaces are captured separately and joined at their actual
  child-view bounds without editing their pixels. No personal browser profile is used.
- `screen-capture.json`: production RemoteScreenPanel with simulated IPC/stream
  data and a synthetic ADHD frame. The recording switches between view and
  control mode; no OS capture, native input or real network connection occurs.
- `adhd-capture.json` and `agent-bus-capture.json`: conversation-list motion
  sequences. ADHD adds panes, expands one and restores the overview; Agent Bus
  switches member configuration and simulated run view. Their source revisions
  and the conversation-feature crops retain their earlier provenance.
- `approval-capture.json` and the older `workbench-demo-*` PPT assets are legacy
  recordings; neither is used in the current overview or homepage body.

All conversations, devices, projects and ticket states are demonstration data.
No model executes fixture tasks. Workbench and native browser are recorded at
1440 × 900 CSS pixels, Chancellor at 1440 × 760, and remote-screen at
1200 × 540. Browser captures use 1× pixels; the other new stills use 1.5×.
The remote-screen image includes the complete viewer dialog and excludes only
its browser backdrop. Compositions preserve captures and aspect ratios.
The opening overview is 1280 × 864 at 8 fps, with warm-gray framing and eight
short chapter captions. Exact durations, dimensions and hashes are in the manifests.

Record with `capture-readme.mjs`, `capture-readme-inbox.mjs`,
`capture-readme-workspaces.mjs`, `capture-readme-browser.mjs`,
`capture-readme-screen.mjs`, `capture-readme-adhd.mjs` and
`capture-readme-agent-bus.mjs` under `scripts/`. Legacy
`capture-readme-demo.mjs` produces separate approval assets and does not replace
the overview or the inbox recording.
Set `TMPDIR` and `DEMO_KEEP` to private directories beneath `.noindex/`;
`README_ELECTRON` selects the cached Electron executable for the browser harness.
Compose the opening GIF with `render-readme-overview.mjs` after all source
recordings finish. Compose stills with `render-readme-art.mjs`,
`render-readme-adhd.mjs`, `render-readme-agent-bus.mjs` and
`render-readme-features.mjs`. Shared `readme-motion.mjs` and `readme-frame.mjs`
helpers sample actual UI and add documentation framing. Encoding is asynchronous
so an isolated Hub's heartbeat remains responsive during long exports.

Visual review, OCR and metadata checks bind each changed media file's exact
SHA-256 in `.privacy-reviewed-media.json`. These illustrations are not
physical-device, real-model, network or installed-release acceptance.
Workbench content remains device-local; shared conversations do not automatically
sync design projects. App/Host/CLI behavior is unchanged, so no CLI API change,
version bump or installer release is needed.

## Earlier capture records

The following dated records describe earlier revisions; current captures are
identified above and in their per-image manifests. Earlier references to fox
covers or an ellipsis list menu are historical, not current product guidance.

## Short English sidebar labels (2026-10-28)

The English layout switch now reads **Bots / Chats / ADHD**, replacing
**By Bot / By conversation / ADHD**. English desktop, folder, theme, ADHD and
Agent Bus screenshots and the English demo were recaptured from base
`89143880795d23dea9eea9a393115d69d41393db` plus this translation-only UI change.
Their composed frames are refreshed too. Chinese artwork, phone images and
feature crops are unchanged; per-image provenance in the affected manifests
keeps those earlier captures distinct. The switch's visible and accessible
button names both use the short labels. Capture checks verify that text and
icons fit inside each button. This changes no layout behavior or Host/CLI API
and does not update the installed App.

## Markdown file badges (2026-10-28)

The shared attachment icon now labels `.md` / `.markdown` files **MD**, instead
of grouping them under TXT. The main desktop, folder, light/dark and phone-chat
captures in both languages were refreshed from base `59afdc48` plus this display
fix. Their compositions use those new captures; other artwork is unchanged.
The capture script checks the real `launch-notes.md` icon before recording.
This is source/browser verification; the installed App is not updated here.

## Desktop list options (2026-10-28)

The persistent `Group by host` / `Show disconnected Bots` rows are now inside
the desktop ellipsis menu, with `Manage folders` retained for conversation lists.
Desktop, folder, light/dark, ADHD and Agent Bus images and both animations were
recaptured from base `1199f62d` plus this UI change. Phone and feature artwork
is unchanged. See the [behavior and verification](../../docs/client/desktop-list-options-2026-10-28.md).
These remain development-source captures, not an installer update.

## Homepage screenshot polish (2026-10-28)

The main desktop, folder, theme and phone scenes were recaptured from
`d6b7c82c0df267005a5125e3d314700bbfb49fa2`. Shorter demonstration titles and
release-plan copy keep the English table and conversation list easier to read.
Both homepage galleries now include `list-options`, showing the actual ellipsis
menu with host grouping, disconnected Bots and folder management. This scene
pairs two disposable Hubs because host grouping only appears with multiple
hosts; no hidden control is forced into the screenshot. The ordinary hero keeps
all seven requested portraits and the same Monochrome + Light warm gray theme.

Only fixture text and documentation recording changed. The already-current
ADHD, Agent Bus, feature crops and demo animations keep their existing bytes and
provenance. Composed workspace, phone-pair and theme images use the new captures.
No App/Host/CLI behavior, installed version or personal settings change here.

## Product captures

Each name below has `-en.png` and `-zh.png` variants. These legacy capture scripts
use 2× scale; the viewport sizes are CSS pixels.

| Capture | Viewport | Content |
| --- | --- | --- |
| `desktop` | 1200 × 780 | Seven read-state Bots, model marks, file attachment and a formatted reply |
| `folders` | 1200 × 780 | Conversation layout with project folders |
| `list-options` | 1200 × 780 | Open list context menu with host grouping, disconnected Bots and folder management, using two disposable hosts |
| `mono-light`, `mono-dark` | 1200 × 780 | The same conversation in Monochrome + Light warm gray, with light and dark appearances |
| `mobile` | 390 × 844 | Phone inbox with folders, Bot avatars and model marks |
| `mobile-chat` | 390 × 844 | A short conversation with an attachment and follow-up messages |
| `adhd` | 1920 × 900 | Seven Bot conversations available, four selected in one row, 13 px pane text, an independent draft and a demonstration streaming reply |
| `agent-bus` | 1920 × 1040 | Saved Bus, three conversation panes, per-step tasks and the connected workflow; one member complete and another running |
| `agent-bus-setup` | Panel crop from 1920 × 1040 | Bot + result-conversation selection for each member; controls locked during the demonstration run |

The README presents the composed `workspace` and `phone-pair` images as two
adjacent, full-width sections: **Desktop / 桌面端** followed by **Mobile / 手机端**.
The original paired phone layout and restrained shadows were restored on
2026-10-17; the current refresh uses warm light-gray framing.
Both READMEs use live-text section headings and short
captions, so the platform distinction stays readable at narrow widths and is
available to assistive technology. The phone section is never hidden in a
collapsed gallery or separated from the desktop by setup instructions.

Click the desktop image for the raw desktop capture. The phone composition
opens at full size, with separate full-size inbox/chat links underneath. The
optional gallery retains `themes` and `folders`. The 2026-10-17 restoration
kept the 1.0.49 files; they were replaced by development-build captures on 2026-10-25,
and again on 2026-10-28 with the same layout. Compositions add only framing, labels and
backgrounds around the screenshots.
They do not paint over controls or invent native window chrome or status bars.
The two covers live one directory up as `tarobot-cover.png` and
`tarobot-cover-zh.png`.

The **ADHD** section follows Mobile immediately, before setup
instructions. `adhd-workspace` frames the entire new `adhd` screenshot in the
same neutral light-gray treatment, without altering or hiding controls. Its linked raw
capture preserves full resolution. Live README text explains selection, the
12-pane limit, automatic/2–6-column layout and independent 11–16 px text size.
This is a desktop feature; it is not advertised as a phone mode or as automatic
Bot delegation. Layout choices remain device-local. The release and capture
dates of the older images are retained separately.

The **Agent Bus** section follows ADHD immediately. `agent-bus-workspace`
uses the same neutral light-gray frame around the complete interface. The full-size raw
workspace and member-configuration crop are linked below it. This is a
desktop-only, host-local collaboration feature; the live README copy distinguishes
independent execution sessions from the selected result-recording conversations.
The saved definition and conversations come from a disposable Hub. Run status,
per-step progress and replies are synthetic, served by a read-only browser route;
the capture does not execute a real collaboration or call any model.

## Demo animation

The first GIF is the current eight-part overview described above, generated by
`render-readme-overview.mjs`. Its timing and per-segment source hashes are in
`demo-capture.json`. It opens with desktop/phone conversation organization and
a shared conversation, using fictional data. No model task runs. Later segments
record actual Workbench, ADHD, Agent Bus
and Chancellor interactions with fictional content. Screen control uses
simulated screen/connection data; the browser uses a disposable native Electron
profile and a local fictional website.

These are documentation demonstrations, not installed-device acceptance.

## Fox brand refresh (2026-10-25)

The product's top-left name is now text only. Full-screen pairing, welcome and
loading scenes keep the fox mark; they do not appear in these screenshots.
Every README image that showed the former sidebar mascot was recaptured in both
languages from a development build (package version 1.0.112):

| Manifest | Recaptured | Recomposed |
| --- | --- | --- |
| `capture.json` | `desktop`, `folders`, `cli`, `pixel`, `mobile`, `mobile-chat` | `workspace`, `phone-pair`, `themes` (`--products-only`) |
| `adhd-capture.json` | `adhd` | `adhd-workspace` |
| `agent-bus-capture.json` | `agent-bus`, `agent-bus-setup` | `agent-bus-workspace` |
| `demo-capture.json` | `demo` GIFs | — |

The feature grid and `engines.png` never showed the sidebar name and remain
unchanged. Each manifest records the base revision, `sourceDirty: true` for the
uncommitted changes and the built client entry file with its SHA-256, which
identifies the exact build. This is not the published 1.0.112 App.
Layout, framing, palettes and the Bot avatar catalog are unchanged.

Fixture-only adjustments: the main capture's Codex Bot uses the amber-flame
avatar slot, as in the demo, rather than the retired taro brand mascot. The Hub
now takes its name from its own profile, so the script sets the demonstration
name and fails if the capturing machine's hostname appears on screen.
The four capture scripts share `scripts/readme-provenance.mjs`; `capture.json`
also records image SHA-256 hashes. The demo
script waits for each ADHD pane removal, because a pane with an interactive
widget now saves the widget state first. App behavior is not modified for capture.

## Orange documentation refresh (2026-10-25)

The owner requested a fox for the first demonstration Bot and orange rather
than purple in GitHub promotional images, explicitly keeping the App theme
unchanged. Current captures are from source `f0c98819` plus documentation-only
script changes, package version 1.0.112; they are not images of a newly released
App. Capture manifests pin the actual client build and each output hash.

- The first main example Codex Bot has the existing `pastel-fox` avatar, assigned
  explicitly in each disposable Hub. Other Bots retain distinct portraits.
- Desktop, phone, ADHD, Agent Bus, feature crops and the two demo GIFs select the
  existing `white-orange` palette through the normal preference store.
- This first refresh used warm white/apricot backgrounds and brown/orange accents;
  the neutral-background follow-up below replaces that outer treatment.
  Geometry, typography, actual controls and full-resolution links are preserved.
- Terminal CLI and Pixel still demonstrate their own real palettes. Covers and
  the engine-logo strip were already suitable and are not regenerated.
- App defaults, user preferences, avatar randomization, native icons, Host/CLI
  behavior, installed applications and production data are unchanged.

Both languages are regenerated from isolated synthetic data. Captures check
palette and fox-image presence; compositions and README previews are reviewed
at desktop and 390-pixel widths. This verifies documentation presentation, not
physical-device acceptance. No release or installer update is required.

Validation covers 30 raw PNG/GIF outputs and their recorded SHA-256 hashes,
12 compositions with unchanged dimensions, and both GitHub-rendered README
documents at 1080 and 390 CSS pixels. All linked local images decode without
stretching or page overflow. The feature-capture script waits for the exact
selected date's detail text before taking a screenshot; it no longer races the
widget update with an immediate read.

The demo recorder also measures each recording's actual first-frame offset.
Playwright can deliver a background page's first frame later than `newPage()`,
which previously made the phone appear ahead of the desktop. A calibration
flash before the captured window aligns the two recordings; the script rejects
a missing marker or any marker overlapping the final GIF window. The marker
never appears in the delivered animation. This changes the recording pipeline,
not App timing or behavior.

## Neutral example backgrounds (2026-10-25)

The owner found the apricot stage too close to the orange interface. All twelve
product compositions and both demo GIFs now use a neutral `#f5f5f5` stage, gray
borders, charcoal captions and restrained neutral shadows. The white App surface
stands apart from the stage; orange is reserved for the fox, interface accents
and small section markers. The homepage brand covers are unchanged.

This is a composition-only update. The existing raw screenshots and synchronized
desktop/phone recordings are reused without changing their interface pixels,
layout, timing or content. `demo-capture.json` retains the original capture
provenance and adds recomposition metadata plus the new output hashes. App
themes, real Bots, Host/CLI behavior and installed applications are unaffected.
No release is needed.

Checked: all twelve PNG dimensions are preserved; all 511 GIF frames have a
neutral stage; scene timestamps are unchanged. Both README languages decode
correctly at 1080 and 390 CSS pixels without stretching or horizontal overflow.

## Reproduce

From the repository root, with root and client dependencies installed:

```sh
npm run build
npm --prefix client run build
node scripts/capture-readme.mjs
node scripts/render-readme-art.mjs     # or --products-only / --covers-only
node scripts/capture-readme-demo.mjs   # needs ffmpeg; zh and en GIFs
```

`render-readme-art.mjs` without an option renders both covers and the
`workspace`, `phone-pair` and `themes` compositions. `--products-only` leaves the
covers untouched; `--covers-only` renders only the two covers.

## Conversation feature grid

Added on 2026-10-22 in both README languages. `features-en.png` and
`features-zh.png` combine four focused views in a 2-by-2 layout after the existing
large product views. The current refresh regenerates these views too. Each UI capture
preserves its aspect ratio; composition adds only headings, spacing and framing.
The linked originals retain their 2× pixel scale for inspecting text and controls.

| Raw capture (both `-en.png` / `-zh.png`) | Actual interface shown | Demonstration data |
| --- | --- | --- |
| `feature-groups` | Group conversation, roundtable mode bar, three Bot replies and composer | Authored product-review replies from Codex, Claude and Kimi; no discussion or model execution |
| `feature-group-modes` | All four group modes, speaking order and round limit | Saved policy in a disposable Hub; opening settings does not start a task |
| `feature-visual` | Production inline widget and its expandable text fallback | Authored, localized SVG/JavaScript example; 29 items across six days; date buttons actually clicked before capture |
| `feature-changes` | Recorded run diff, two files, one line comment and send control | Read-only HTTP fixture for a synthetic run; counts match the fixture patch; note saved only in the disposable browser, never sent |
| `feature-voice` | Three routing modes, 15-minute threshold and configuration status | Temporary local policy and dummy adapter files; simulated local ASR readiness; no credentials or cloud call |

These screenshots use the built shared client at the revision in
`features-capture.json` (package label 1.0.118). They do not establish the installed
App's feature set or physical-device behavior. The manifest records source revision, time, viewport,
crop bounds and SHA-256 for all ten captures. Scripted content is illustrative,
not a record of model work or native/device acceptance. No user's Hub, chats,
workspace, browser profile, ASR service or private configuration is accessed.

Reproduce only this feature grid:

```sh
npm run build
npm --prefix client run build
node scripts/capture-readme-features.mjs
node scripts/render-readme-features.mjs
```

The capture uses real pairing, stored group settings, publication envelopes and
client navigation in disposable loopback Hubs. Source/ASR fixtures stay outside
the repository and are removed on completion. Its checks cover four visible
discussion modes, chart date selection, a saved diff comment, the selected voice
mode/threshold, page overflow and browser exceptions in both languages. The
renderer checks image loading and horizontal overflow. Homepage copy also updates
the feature table, model/effort placement and documentation links, and removes the
stale 1.0.83 "new" banner. App/host/CLI behavior is unchanged; a CLI command or
installer release is not applicable to this documentation update.

### Voice settings refresh (2026-10-22)

The voice panels now show the grouped configuration status, upload policy and
save actions from the revised client. They are captured at the real 740 × 1040
responsive layout, so the full English section fits without clipping the footer
inside the desktop preference dialog. Controls and styles are not altered for
capture. Both language compositions were regenerated from the current captures;
the original Desktop, Mobile, ADHD and Agent Bus artwork remains unchanged.
These remain synthetic documentation examples, not an owner-account health check.

### Feature-grid publication verification

Host and client builds passed. All ten captures and both compositions were
generated; capture assertions passed with no browser exceptions. GitHub's Markdown
API rendered both updated READMEs. Local previews of that rendered HTML at 1080 px
and 390 px loaded all eight images per language, retained image proportions and
had no horizontal page overflow. All 20 local artwork links per README resolved,
and all ten raw-image hashes matched the manifest. Both compositions and the
desktop/narrow previews were visually inspected. The local preview uses a small
GitHub-style stylesheet; it does not claim pixel-identical GitHub native rendering.

## Earlier showcase reproduction

To capture and compose **only ADHD**, leaving the original artwork intact:

```sh
npm run build
npm --prefix client run build
node scripts/capture-readme-adhd.mjs
node scripts/render-readme-adhd.mjs
```

To capture and compose **only Agent Bus**, preserving all existing artwork:

```sh
npm run build
npm --prefix client run build
node scripts/capture-readme-agent-bus.mjs
node scripts/render-readme-agent-bus.mjs
```

`agent-bus-capture.json` records the source revision, client version, capture time,
viewport and SHA-256 of each raw image. Raw workspace images are 3840 × 2080;
the framed compositions are 1600 × 992. The capture checks three conversation
panes, completed/running flow states, visible topology, no horizontal page overflow
and no browser errors in either language. Configuration controls are intentionally
disabled because the illustrated run is still active.

On the owner's Mac, source the external-disk build environment first so temporary
Hub state and browser artifacts use `/Volumes/gdrive/taro-tmp`. The ADHD script
uses the normal pairing, sidebar selection and display controls, with ordinary
preferences seeded only in its disposable browser. `adhd-capture.json` records
the source revision, version, time, dimensions and raw-image SHA-256 hashes.
The demo replies, checklist and streaming status are synthetic, not claims that
those model tasks ran. No real account, chat, file or model request is used.

The scripts use the client's Playwright installation and its Chromium browser.
The capture script starts a disposable loopback Hub for each language, pairs
fresh browser contexts, seeds demonstration Bots and conversations, and closes
and removes its own temporary state after capture. It does not load the user's
Hub, workspace, credentials, browser profile or conversation history. No model
is invoked; model names and replies are demonstration data. `capture.json`
records the client version, capture time, viewports and generated raw images.

The artwork renderer bundles Bricolage Grotesque Bold, Instrument Sans Regular
and IBM Plex Mono Regular from `fonts/`, each with its OFL license. Chinese
artwork labels use the system PingFang SC font on macOS. The screenshots use
the application's own typography. Older CLI/Pixel captures remain archived but
are not used by the current homepage theme gallery.

Native-platform acceptance and release status remain documented in the
[project README](../../docs/details.md#project-status).

## Homepage-only change

The 2026-10-17 layout restoration changes documentation and image references;
it does not change App or host behavior, require a new CLI command, or publish
an installer. Versioned download tables have been removed from both READMEs;
installation instructions point to the stable Releases page. Per-release
versions, checksums and verification remain in the release records.
Verify both README renderings, all linked images, original image
proportions and narrow-screen overflow before publishing layout changes.
The ADHD showcase is likewise documentation-only: no App, host or CLI behavior
changes, no new CLI command, and no installer release.

Initial ADHD publication checks on 2026-10-17: host/client builds passed; both fresh
captures rendered four panes without browser errors and kept every composer
visible. GitHub's Markdown API rendered both READMEs. Local previews of that
HTML at 1080 px and 390 px loaded all four showcase images, preserved their
aspect ratios and Desktop → Mobile → ADHD order, and had no horizontal overflow.
Both compositions and the narrow Chinese preview were visually inspected.
Raw-image hashes and all 13 local artwork links in each README were checked.
This verifies documentation rendering, not a native App or phone installation.

Four-column refresh checks: both captures show seven available Bot conversations
and exactly four selected, with all panes on the same row and every composer
visible. Both languages rendered through the GitHub Markdown API and were
checked at 1080 px and 390 px: four showcase images loaded, original proportions
retained, Desktop → Mobile → ADHD order preserved, no horizontal overflow.
All 11 local artwork links per README and raw-image hashes were verified;
both compositions were visually inspected. No App/host behavior changed, so
CLI changes and an installer release are not applicable.

The Agent Bus addition is also documentation-only. App, host and CLI behavior
are unchanged; no CLI command or installer release is required.
Both language captures and compositions were inspected. The capture assertions
passed, GitHub's Markdown API rendered both updated READMEs, all 14 local artwork
links per README resolved, and the four raw-image hashes matched the manifest.


## Bot network illustration — 2026-11-05

`bot-network-en.png` and `bot-network-zh.png` illustrate same-host Bot
collaboration, cross-host task/file/reply handoffs and another computer joining
with its own Bots. They appear in the existing Bot network section after Groups,
not in the opening hero or animation. Existing section order is unchanged.

These are authored diagrams, not App screenshots, live network captures or
real-model acceptance. Host A, Host B and Bot roles are fictional; there are no
addresses, pairing codes, account names, chat records or device identifiers.
Joining and communication authorization are separate, and each host retains its
Bots, conversations and files. Agent Bus and group membership remain host-local.

Reproduce with `node scripts/render-readme-bot-network.mjs` after installing the
client's Playwright dependencies and Chromium. The script uses the existing
licensed Instrument Sans font plus the macOS PingFang SC fallback for Chinese;
PNG output freezes the reviewed glyphs for other platforms. It renders only
inline SVG and local fonts, and calls no Host, model or network service.
An optional first argument selects an existing output directory. Both images
are 2240 × 1560 pixels. Exact reviewed hashes are recorded in
`.privacy-reviewed-media.json` at the repository root.

Documentation only: App, Host and CLI behavior and versions are unchanged;
no release or installation is performed.
