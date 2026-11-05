# Phone avatar editor spacing

The full-page phone editor still capped its avatar library at the desktop
dialog's 248/264 px height. This left a large unused area below the save actions.

Library mode now fills the available vertical space and keeps the actions near
the bottom, with 12 px padding inside the existing safe area. Short viewports
retain a minimum scrollable library and an outer scrollport. Upload/crop mode
and desktop dialog geometry retain their existing rules. Both Bot and direct
conversation avatar editors share this presentation change. CLI: not applicable;
no avatar API, persistence, or permission behavior changed.

## Verification

- Existing `bot-avatar-library.spec.ts` and `conversation-avatars.spec.ts`:
  Chromium 7/7 and WebKit 7/7. Covers selection, uploads/cropping, saves,
  cross-device conflicts, restoration, keyboard focus and desktop/phone entries.
- Client build (including TypeScript/translations) and standalone Host build pass.
- Isolated Hub/browser visual checks at 390×844, 360×800, 320×568 and 740×390,
  with simulated 24 px top/20 px bottom safe areas: no horizontal overflow;
  save remains visible, last library choice and upload/library switching work.
  At 390×844, the library grows from 248 to 429 px and the bottom action gap
  inside the safe area falls from 173 to 12 px. At 320×568 the library remains
  scrollable at 128 px; the short landscape page retains outer scrolling.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/phone-avatar-editor-20261031/`,
including `geometry.json`, before/after screenshots and browser/build logs.
These are browser checks, not physical Android/iPhone acceptance. No release
or installed App update is included.
