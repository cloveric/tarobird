# Interface density

Settings → General → Interface density offers Compact, Standard and Spacious
with an immediate list preview. On phones, open Me → Settings → General.
The choice is local to the device, shared across its host workspaces and
retained after reopening. Since the 2026-10-14 source update, missing or invalid
values default to Compact on native mobile and phone-width web (760px or less).
Native desktop stays Standard, including in a narrow window. Native mobile stays
Compact in landscape. First paint uses the same rule before IndexedDB opens.
All valid saved choices take precedence, including Standard and Spacious.
Older versions persisted their default without recording whether the user chose
it, so an already-saved Standard value is retained rather than guessed at.

Compact reduces heading, list title, avatar and row dimensions to show more
content. Spacious enlarges those elements and adds breathing room. Phone Bot
lists, navigation, settings rows and chat header/outer message spacing follow
the same choice. Desktop conversation lists support both Bot and conversation
arrangements with corresponding spacing and title/preview size changes.

Chat reading size stays independent. The implementation changes component
geometry rather than applying page zoom or transforms. System cutouts, status
bars, keyboard viewport handling and native safe-area ownership retain their
existing dimensions. Compact list rows and separate phone controls retain
touch targets of at least 44 CSS pixels. Group avatars receive their actual
size, allowing their member collage to scale correctly.

`layout-density.ts` defines the three persisted values and normalizes legacy
data. `ClientCache` and `HostRegistry` normalize on read; `appearance.ts` mirrors
the non-sensitive choice for first paint. `LayoutDensityPicker` uses native
radio semantics and theme tokens, including keyboard focus and forced colors.

## Verification

The `layout-density` browser journeys cover phone and desktop switching,
relative row sizes, group-avatar containment, no list overflow, independent
reading size, draft preservation, reload persistence, English labels, narrow
viewports, light/dark themes, both desktop arrangements, simulated top/bottom
insets, a reduced keyboard viewport, device
isolation and old/invalid saved preferences. Chromium and WebKit passed.
Actual Compact/Standard list renders and the setting control were inspected.
The 2026-10-14 default change adds fresh phone/desktop defaults, saved Standard
and Spacious choices, and missing/invalid preference migration at both widths.
Together with `theme-font-size` and `sidebar-layout`, 19 browser journeys passed
(10 Chromium, 9 WebKit); the Chromium-specific touch injection case is
intentionally skipped in WebKit. Client and repository builds passed.

This is browser and source validation. A packaged Android, macOS or Windows
build and physical-device keyboard/cutout validation remain release checks;
this change does not install or publish new packages.

## 2026-10-17 phone inbox spacing

The message inbox removes the extra margin above its filter strip, the header's
bottom spacer and the folder toolbar's bottom margin. The header override uses
the existing density variable, so Compact and Spacious cannot reintroduce the
same blank band. Adjacent folders no longer add another bottom margin, and
host-grouped headings have a smaller top gap.

Text sizes, filter/checkbox/button hit areas, conversation rows and native safe
insets keep their existing dimensions. The change is scoped to the phone inbox;
desktop/ADHD layout, host behavior and CLI commands are unaffected.

At Standard density, measured 320/390/480px inboxes place the first conversation
at 180px instead of 196px, with unchanged 44px filter targets, 40px toolbar and
folder headings, and 72px conversation rows. No horizontal overflow was found.
Client type/translation checks and build passed. Chromium and WebKit each passed
five existing density, phone navigation/search and host-grouping journeys,
including desktop density, saved drafts and narrow screens. The comparison
renders use an isolated Hub; no Android package was installed in this change.
