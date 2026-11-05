# Phone inbox and attachment composer

The iPhone screenshots showed a small inbox and a single-image draft taking a
large share of the area above the keyboard. Compact density is the existing
default on both native mobile platforms; this is not evidence of an iOS-only
viewport scale defect.

The initial adjustment used shared Compact tokens and enlarged both platforms.
The owner confirmed Android was already the desired size. Android now restores
the complete previous Compact geometry: 22px home heading, 14px list titles,
12.5px previews, 11px timestamps, 40px avatars, 60px minimum rows, 10px gaps and
6px vertical padding. iPhone retains 24/16/14/12px text, 44px avatars, 64px rows,
12px gaps and 8px padding. Standard and Comfortable choices are unchanged.

`appearance.ts` sets the runtime platform before the first React render. The
readability override is now explicitly iOS-only, including the density picker
preview. Avatar props use the same platform distinction so real images and
group collages have the correct geometry, rather than just shrinking an outer
CSS box. Saved density choices, chat reading size and safe-area handling are
retained. Android and browser/desktop narrow layouts use their original Compact
geometry.

The desktop follow-up confirmed that the original iPhone adjustment did not
change the regular desktop sidebar's dedicated title, preview, row or avatar
sizes. It did leak into the desktop Compact settings preview and the narrow
window layout, because both consumed shared mobile tokens. The initial Android
restoration did not cover those surfaces. Moving the enlargement into an iOS
override restores them without shrinking the regular desktop sidebar or
undoing the iPhone improvement. `AGENTS.md` now records the perceived difference
between iPhone and the established Android/desktop UI as a platform-scoping
principle, without fixed pixel values.

On phones, pending images use 72px square thumbnails with their existing local
preview and remove actions. Image filenames remain in accessible button names
and the full preview. A single image omits the duplicate attachment header;
multiple attachments retain their count, Add and overflow paging. The per-file
limit is not displayed in the phone tray; upload validation is unchanged.
Document/audio drafts and desktop attachment cards retain their metadata.
The phone composer uses a quiet focus border and smaller rich-draft corners;
individual keyboard controls retain their focus indication.

## Verification

- WebKit and Chromium: 9 existing journeys per engine covering mixed text/file
  sends and synchronization, three-image paging/local previews at 320/390px,
  busy/idle composer geometry at 320/390/1360px, quoted keyboard drafts, and
  density changes at 390/1360px.
- Extended the existing attachment journey with a single decoded image and a
  caption at a simulated 460px keyboard viewport: the composer stays at most
  190px high, the message area remains over 100px, and removal preserves text.
  Both 320px and 390px passed in both engines (4 additional executions).
- Root standalone build and client translation/type/production build passed.
- Visually inspected WebKit inbox, original/revised multiple-image drafts,
  and the revised single-image draft screenshots.

Android restore follow-up: `layout-density` adds Android/iOS platform-hint
journeys for the production App. They measure real list and Bot avatars, text,
rows, spacing and the picker preview across all three density choices, then
reload Compact. These use a cached browser conversation with native plugins
disabled; they do not validate native transport or physical devices. The existing
phone/desktop cases also cover chat font, drafts, group collages, saved preferences
and migration. Android/iOS rendered Bot-list screenshots were visually checked.
Evidence is in `/Volumes/gdrive/taro-tmp/android-list-density-20261023`.
Chromium passes the two platform-hint cases and four existing cases; WebKit
passes all six in one run. Client translation/type/production build and the
standalone Host build pass. No new native package was built or installed.

Desktop boundary follow-up: the new web Compact journey and desktop settings
preview assertion both failed against the preceding build, reproducing the
unintended enlargement. After the iOS-only scope correction, all seven density
journeys pass in Chromium and WebKit (14 executions). They cover Android/iOS/web
lists, desktop sidebar typography, the Compact preview, desktop-to-narrow-window
resizing, saved density, chat font, drafts and reload. Desktop sidebar, narrow
window and iOS screenshots were visually inspected. Client translation/type/
production build and standalone Host build pass. Evidence is in
`/Volumes/gdrive/taro-tmp/platform-density-boundaries-20261023`.

Browser viewport simulation does not validate a physical iPhone keyboard,
Android WebView, or installed native package. No installer was built or released
for this change. No real provider calls were needed for these view-only changes.

CLI not applicable: this changes client presentation only. Host APIs, attachment
bytes, upload limits, storage, permissions and engine behavior are unchanged.
