# Compact process search and first-run palette

The process reader's search field now has a 32 px outline, 13 px input text,
14 px search icon and 8 px horizontal padding. Removing the old 10 px vertical
input padding reduces the measured frame from 38 to 32 px. Search, refresh and
export stay on one aligned row; phone action buttons retain 44 px height. This
only changes the process reader toolbar, not chat inputs or global font sizes.

New installations use Porcelain Violet (`white-violet`), including the CSS
fallback before preferences load. Existing saved palettes and light/dark/system
mode are preserved. See [white palettes](white-palettes-2026-10-11.md).

## Verification

Chromium and WebKit geometry checks at 320, 390, 480 and 1360 px confirm a 32 px
search frame, no document overflow and working search submissions. Screenshots
were reviewed. Browser tests cover existing palette selection/persistence and
process-reader search, refresh, cancellation and scroll restoration: eight
passed per engine, 16 total.
Fresh browser contexts in both engines reach pairing with `white-violet`, white
canvas and violet accent; removing the palette attribute confirms the same CSS
fallback. Client translation checks, TypeScript checking and production build pass.

Artifacts: `/Volumes/gdrive/taro-tmp/tarobot-compact-search-theme-20261017/`.
These are local browser checks, not physical-phone or installed-Mac acceptance.
No release or installed application is updated by this source change.

CLI: not applicable; these are client presentation changes with no host,
protocol or stored-message changes.

## 2026-10-27 search surface repair

The current Monochrome toolbar reproduced a gray rounded input inside a white
outlined field. Porcelain's generic dialog-field rules overrode the wrapped
input's transparent background. Excluding this input in both idle and focus
rules restores one continuous surface while retaining the wrapper's focus border.
Chromium/WebKit checks passed at 320/390/1360 px across Monochrome, Violet,
Orange and Plum in light/dark mode (96 idle/focused states), with search and
close interactions. Three existing Chromium reader checks and the client build
passed. Evidence: `/Volumes/gdrive/taro-tmp/followup-run-search-color-20261027/`.
These are browser checks; no native install or release was performed.
