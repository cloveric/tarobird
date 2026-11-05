# Monochrome theme

## Behavior in 0.1.400-test.1

- Adds **黑白 / Monochrome** as the first option under the pure-white palettes.
  On a phone, open **我的 → 设置 → 通用 → 配色风格 → 黑白**. Desktop uses the same
  General settings. Porcelain Teal remains the first-run default; existing saved
  preferences are preserved.
- Light mode uses a white canvas, black own-message bubbles with white text,
  black primary buttons, and pale gray neutral reply cards. Dark mode uses a
  charcoal canvas, pale own-message bubbles with dark text, and dark gray cards.
  The palette also follows the system theme and survives reload.
- Links, quotations, inline code, highlighted code, attachments and previews
  retain readable foregrounds. Document syntax uses a separate scale from the
  inverse own-message bubble. Avatar artwork and meaningful status colors remain.
- Held-recording controls use the primary foreground/background pair, avoiding
  white text on a pale recording button in dark mode.

## Verification

- Chromium and WebKit each passed the two `palettes.spec.ts` journeys. The first
  covers all eleven palettes, explicit light/dark and system switching, saved
  preferences, default migration, English labels, keyboard selection, mobile
  overflow and the synchronous appearance mirror. Rendered text/link/syntax/
  quotation/file/preview targets meet a 4.5:1 contrast ratio in both modes.
- The phone journey selects Monochrome through real settings, reloads, and
  renders messages persisted in an isolated Hub. It verifies inverse bubbles,
  neutral reply cards, send-button contrast, live waveform feedback, recording
  contrast, cancellation and draft retention in both modes. Audio is synthesized
  by the browser fixture; these checks do not use the user's microphone.
- Inspected the actual mobile captures: light (historical image omitted from this clean snapshot),
  dark (historical image omitted from this clean snapshot), and
  dark recording (historical image omitted from this clean snapshot).
- Standalone gate passed: 220 test files, 2,858 passed tests and one existing skip.
  Clean client installation, translations, TypeScript and Vite build passed.
- Android release assembly, JVM tests and release lint passed. Independent
  installations of both the standalone directory and npm archive start their
  isolated Hub and serve the client without the Feishu SDK.
- Final signed APK has version code 2026101215 and retains the existing Android
  test certificate. All bundled public assets match the synchronized client;
  the compiled palette and translated option are present. The selected mascot
  passes all 15 PNG-density checks and both adaptive launcher references.

This release is Android-only. Browser checks and package verification do not
constitute physical-phone acceptance. No paired host, relay or legacy fleet is
restarted for this client appearance change.
