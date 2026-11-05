# Keep reading size stable when changing themes

Follow-up: the user's preferred slider was restored with horizontal gesture
arbitration on 2026-10-13. See [the current behavior and checks](font-slider-2026-10-13.md).
The selector implementation below records the earlier repair.

The font-size control now uses an explicit 12–20 px selector on phone and
desktop. Scrolling the settings page to reach the theme cards cannot change
the reading size. Existing saved sizes are retained; an already enlarged size
can be corrected once in Settings → General → Font size.

## Cause

The previous native range input saved its new value on touch-down, before the
browser decided whether the gesture was a vertical page scroll. A real touch
regression starting at 85% of the slider width reproduced a saved change from
14 to 19 while scrolling toward the palettes. The larger reading size then
appeared when returning to chat. All palettes shared the same input.

The replacement keeps the existing preference storage and live preview, while
requiring an explicit option selection. It preserves accessibility labels and
a 44 px minimum phone touch target.

## Verification

- Chromium touch regression: vertical swipes starting on the size control,
  followed by each of all 13 palettes, leave the saved value and chat text at
  14 px. This regression failed with 19 px before the fix.
- Chromium and WebKit: explicit 12, 16, 20 and 14 px choices persist through
  CLI, pixel and monochrome palettes, light/dark/system modes, chat navigation
  and page reload. Both phone and desktop widths are covered, including a
  320 px overflow check. Language switching and unsaved settings drafts still
  work. Five Chromium cases and four WebKit cases pass; the WebKit-only skip
  is the Chromium touch-driver case.
- Installed Android API 36 emulator: `PairingJourneyTest` with
  `-e fontSettings true` performs a native vertical touch gesture over the
  size control, switches to CLI, returns to chat and reloads the WebView.
  The size stays 14 px. This uses the isolated
  `com.tarocub.client.fontsize.pairingtest` package and a disposable TLS Hub.
  It does not access the user's hosts or chats.
- Root/client production builds and Android release assembly pass.
- Android selector (historical image omitted from this clean snapshot) and
  chat after reload (historical image omitted from this clean snapshot).

This verifies browsers and an installed emulator APK, not the user's physical
phone. Android `0.1.414-test.3` (code `2026101231`) contains this fix and the
previous system-bar restoration fix. The signed local APK retains package ID
`com.tarocub.client` and the existing signing certificate; no GitHub Release
was published for this repair.

APK SHA-256:
`0e2cc818873176a6b09905b53128ae479410480c271fbfff92af4aebbc14ce2d`.
The final package's production JS/CSS assets match the current build; its
native index retains the Capacitor sync CSP. Signature, version, both adaptive
launcher references and all 15 PNG icon variants were verified.
