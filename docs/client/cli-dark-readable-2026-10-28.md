# Dark-only CLI theme with wider Latin text

The owner requested one dark CLI theme and less narrow English lettering.
The App's **终端 CLI / Terminal CLI** palette now always renders dark. Its
settings tile shows one dark miniature, and the appearance row reports Dark
instead of offering ineffective light/system choices.

`appearance.ts` resolves CLI to `data-theme=dark` both when applying preferences
and when restoring the synchronous startup mirror. The user's underlying
light/dark/system preference remains stored, so returning to another palette
restores that choice. Native canvas, keyboard and theme-color synchronization
continue to use the rendered palette. CLI CSS no longer contains a light token
set or a system-dependent variant. Other terminal-family palettes are unchanged.

CLI now uses bundled **JetBrains Mono** Regular and SemiBold for Latin text,
with the existing Sarasa Term SC faces retained for Chinese. Latin cells are
0.6em rather than the previous 0.5em, while Chinese and the chosen reading size
are unchanged. UI, prose, tables, expanded tables and code use the same stack;
ligatures are disabled. This replaces the former mixed-script 1:2 width promise:
Latin remains monospace, but one Chinese character is not exactly two Latin cells.
No font is fetched from an external service when the App runs.

The unchanged upstream WOFF2 files add 186,864 bytes. Their pinned source,
checksums and OFL license are recorded in the
[font README](../../client/src/assets/fonts/jetbrains-mono/README.md); the license
is also packaged in `client/public/licenses/JetBrains-Mono.txt`.

Headless CLI impact: not applicable. This changes an App palette named CLI,
not shell commands, the Host runtime, engine adapters or persisted conversation
data. No release, installation or Host restart is part of this source change.

Validation covers loaded fonts and actual glyph widths, 12/14/20px reading
sizes, rendered contrast, phone/desktop controls, settings preview, OS scheme
changes, reload and returning to other palettes. The Android native typography
fixture is updated for the new contract; source/browser validation is distinct
from native or physical-device acceptance.

Evidence: `/Volumes/gdrive/taro-tmp/cli-dark-20261028`.
Client translation/TypeScript/Vite and standalone Host builds passed. Both font
files and the license were verified in the built assets. The existing Capacitor
keyboard static/dynamic-import warning remains non-blocking.

Five browser journeys passed in Chromium and WebKit (10 distinct engine/case
executions): desktop/phone bilingual typography and contrast; CLI/Pixel drafts,
controls and mode switching; desktop/phone font-size persistence. The first phone
typography attempt stopped on the inbox after a test-added reload; the fixture
was corrected to re-enter the conversation, and only that failed case was rerun
in both engines. It then passed. This was a navigation omission in the test,
not an App change. Desktop/phone/setting screenshots were inspected.

The updated Android native fixture has not been run on a device in this task.
No installed-version or release acceptance is claimed.

## Sidebar avatar follow-up (2026-10-31)

The owner requested another small reduction to the CLI theme's left Bot
portraits. The visible parent-Bot avatar changes from 30 to 26 CSS px; side
margins increase from 5 to 7 px to retain the 40 px layout footprint and name
alignment. The existing Bot identity button retains its click area. Status
badges and the typing bubble use the same smaller geometry; avatar motion
and selected pictures are preserved.

Only `.sidebar .bot-identity` under `data-palette=cli` is affected. Other
palettes, phone home, conversation portraits, settings previews and headless
CLI behavior retain their previous sizing. Client build and the existing
compact-sidebar/theme browser regression are the verification boundary;
no release or installed-App update is included. Evidence:
`/Volumes/gdrive/taro-tmp.noindex/cli-avatar-smaller-20261031/`.
