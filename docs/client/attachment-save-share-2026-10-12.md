# Separate phone downloads from sharing

The phone's download icon previously called the same system share sheet as
sharing. It produced a temporary cache copy without saving to user-visible
storage. The file card now says **Save to device** on native phones; file and
draft previews expose separate Save, Share and Other apps actions.

- Android 10+ saves into `Download/TaroBot` through MediaStore. The source is
  restricted to one prepared cache file. Writing uses a bounded buffer, verifies
  the closed destination's size and clears `IS_PENDING` only after completion.
  Failures remove the newly created entry. No broad storage permission is added.
- MediaStore's pending size/name metadata can lag behind its actual file. Size
  verification uses a file descriptor; the receipt reads the final name after
  publishing, including any duplicate-name suffix. Tests use different bytes for
  two downloads with the same name and confirm both remain intact.
- Android 7–9 use `ACTION_CREATE_DOCUMENT`. Cancelling is neutral; success is
  reported after copying and closing. A failed document-provider write may leave
  a partial destination, as can an interrupted desktop save.
- iOS uses `UIDocumentPickerViewController(forExporting:asCopy:)`, validates the
  same prepared-cache boundary and resolves only on completion or cancellation.
- Share retains the system share sheet. Other apps retains Android's read-only
  reader chooser and iOS's document-app share sheet. Neither claims a disk save.
  Temporary reader/share files remain until the existing later cleanup; save
  copies are removed from cache after the native operation settles.
- Desktop and browser exports retain their existing save/handoff semantics.
  Native mobile save locations are display receipts, not desktop open-file grants.

Platform contracts: [Android shared storage](https://developer.android.com/training/data-storage/shared/media)
and [Apple document export](https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller/init(forexporting:ascopy:)).

## Verification

Android API 36 instrumentation exercises the actual Capacitor plugin in an
isolated `.downloadtest` App: public location, complete bytes across a 1 MiB
boundary, duplicate preservation, rejection of a path outside the export cache,
and cleanup after a failed write. It uses disposable files and no real Hub.

Browser checks use native bridge doubles and cover save/share separation,
cancellation, errors, accurate receipts, desktop short writes, draft previews,
Excel and small-screen layouts. They do not prove native document-provider or
share-sheet behavior. iOS source syntax and project registration are checked;
this machine has no iOS SDK, so native iOS compilation/picker acceptance and
Android 7–9 picker acceptance remain unverified. The user's physical Android
phone must install the new APK to receive the native saver.

Validation: 60 Chromium checks, 22 WebKit checks, 2,875 host tests (one existing
skip), Android unit tests/lint/release build, and one native Android save journey
passed. The final APK retains the prior signing certificate and application ID,
increments the version code, and contains the verified native saver and 376 web
assets. This is an Android-only prerelease; the existing macOS package is unchanged.

390px preview (historical image omitted from this clean snapshot) ·
320px preview (historical image omitted from this clean snapshot) ·
[Native Android result](evidence/attachment-save-share-2026-10-12/android-save-test.txt) ·
[Verification receipt](evidence/attachment-save-share-2026-10-12/verification.json)

## Forward destination picker

The same release removes the forwarded-content preview and host helper line
from the picker. Search and destinations take priority. Destinations show their
Bot or group avatar; topics inherit their parent group's image, including custom
uploads. Source deletion, live updates, recipient changes and archive filtering
still gate submission. The delivered copy retains full text, files and provenance.

An additional 22 Chromium and 11 WebKit checks passed. Verification covers
320px, 390px and desktop layouts, custom/default
avatars, search, latest-source forwarding, deleted sources, changing group members,
attachment delivery and normal creation dialogs. This is shared client UI; the
Android package contains it, while the existing macOS installer is unchanged.

390px destination picker (historical image omitted from this clean snapshot) ·
320px destination picker (historical image omitted from this clean snapshot)
