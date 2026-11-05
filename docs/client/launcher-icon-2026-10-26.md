# Warm-gray fox launcher

The owner approved an enlarged, tilted fox on warm light gray. The exact image
is `assets/brand/launcher-art.png`, SHA-256
`21ec2257c23309cea12c21582223c5f6e551325ed7c9d8410693e0bbcbf47598`.
`brand-identity.json.launcher` pins this separately from the original avatar and
transparent scene mark. Reproduction is documented in `assets/brand/README.md`.

## Scope

- iOS, Android, macOS, Windows, favicon and Apple touch icons use the approved
  close-up. Windows taskbar/window and notification-area icons use the same tile.
- macOS keeps its existing outer margin; Windows adds transparent rounded corners.
- Android maps the artwork to the central 72dp viewport. Both eyes stay inside
  the guaranteed 66dp circle. Peripheral ears/cheeks/tail may be cropped by masks.
  Explicit left/bottom edge extension avoids a straight cutoff during motion.
- The Mac cat-head menu icon, Android notification/themed glyphs, personal Bot
  avatars, in-app scene marks, iOS launch mark, GitHub promotional images and App
  themes remain unchanged. No Host/CLI behavior or schema changes: CLI not applicable.

## Verification

- Source icon checker: 84 generated resources, iOS opacity, six ICO frame sizes,
  Windows transparency/content, Android geometry and rendered edge continuity.
  The square and Windows masters are compared back to the approved original;
  regenerated checksums alone cannot establish that relationship.
- Four negative probes reject an unapproved original, stale iOS icon, retired
  Windows cutout ICO, and unextended Android artwork even with a matching manifest.
- Repeated generation produces an identical manifest. Eight independent avatar,
  scene, menu, notification and promotional assets were checked byte-for-byte.
- Actual resource previews checked at small sizes, multiple Android masks and
  simulated foreground offsets. Opus 5.5 xhigh independently reviewed the chain
  and caught the Android edge cutoff; the corrected version has no blocking finding.
- Android AAPT2 resource compilation, iOS simulator asset-catalog compilation,
  frontend typecheck/translation check/Vite build and standalone Host build pass.

This is a source update, not a release or installation. Final installer read-back,
physical Android/iPhone behavior and the macOS Dock remain release acceptance
checks. Android edge extension can briefly look stretched during large launcher
offsets; it does not alter the approved central artwork.
