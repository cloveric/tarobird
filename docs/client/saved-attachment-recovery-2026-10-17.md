# Remember saved Android attachments

The file card used to print the entire download path in a flex item that could
not shrink. Long APK names overflowed narrow screens. The card now displays
**已保存到手机 / Saved to device**, next to **打开文件 / Open file** or **安装 APK**.
The attachment name remains on the card; its full storage path is not repeated.

The previous saved-file receipt existed only in the React component and native
plugin instance. Leaving the conversation or restarting the App lost the Open
action even though the public download was still present. The renderer now
restores the receipt on mount, conversation activation and foreground return.
It opens that exact public copy without fetching the attachment again.

## Identity and storage

- A SHA-256 key over a versioned tuple of paired Hub public key, local device ID
  and attachment ID identifies the receipt. Names and changing route URLs are
  not identities. Equal attachment IDs on different hosts cannot collide.
- The Android saver writes the content URI, MIME type, byte count and optional
  display location to private SharedPreferences only after the native save
  succeeds. The renderer cannot register an arbitrary URI as a saved file.
- Recovery verifies a readable content descriptor and its size when available.
  A deleted, unavailable-permission or size-mismatched file invalidates the
  private receipt and the in-process opening grant. Other check failures remain
  retryable; they do not trigger a download or fabricate a successful save.
- The Open action retains its read-only URI grant. APK installation still goes
  through Android's permission screen and installer. No broad storage permission
  or automatic installation is added.
- Android 10+ uses app-owned MediaStore Downloads. Android 7–9 uses the system
  save picker and remembers the receipt only if its provider grants persistable
  read access. Cancelling another Android save preserves a previous valid copy.
- Async recovery cannot overwrite a newer save or cross a changed host/device
  scope. Metadata stays on this phone; no host or other device receives it.

Platform references: [Android MediaStore](https://developer.android.com/training/data-storage/shared/media)
and [persistent document access](https://developer.android.com/training/data-storage/shared/documents-files).

## Compatibility and delivery

Files saved by older versions have no attachment-key record. They remain in
`Download/TaroBot`, but cannot safely be associated retroactively by filename.
Persistent recovery applies to saves made by the updated native App. An older
native bridge is tolerated and retains its existing in-session behavior.

Desktop/browser/iOS save semantics and Hub APIs are unchanged. CLI impact is
not applicable: this is an Android device's local copy and the client status UI;
it adds no host-side file capability or alternate storage model.

This source change does not replace the installed 1.0.85 App or publish an APK.
Native recovery requires a subsequent Android release. Physical-phone and
Android 7–9 document-provider acceptance remain unverified.

## Verification

The browser bridge fixture tests short status text at 320/390px, APK and document
Open actions, unmount/remount, page reload, exact existing URI reuse without
another download, host/device isolation, deleted-file invalidation, cancellation
and stale asynchronous lookups. Native validation uses a separate
`com.tarocub.client.downloadtest` package on the external-disk API 36 emulator.
It never pairs with a real Hub or installs over the production App.

The process-restart test is `AttachmentSavedRestoreTest#savedApkSurvivesRestartWithoutCacheOrDownload`:
run once with instrumentation argument `savedReceiptPhase=seed`, force-stop the
disposable package, then run with `savedReceiptPhase=verify`. The test asserts a
different PID, absent export cache, exact saved APK bytes, restored URI, system
installer launch/cancellation, and removal of the opening grant after deletion.
Without the phase argument, the same test covers Activity/plugin recreation.

Results on 2026-10-17:

- 5 Android saved-file browser tests passed. The 27 existing file-actions,
  mobile-file-export and desktop-export cases passed after updating the two
  assertions that intentionally expected the removed full-path text.
- Client translation check, TypeScript and Vite production build passed.
- Android debug/test APKs built; 30 native unit tests passed. Lint completed
  with no errors (24 warnings, including synchronous preference commits that
  run on the saver IO executor).
- API 36 emulator: process-death seed and verification phases both passed.
  The separate Activity/plugin recreation and native MediaStore save regression
  also passed (exact bytes, duplicate names and failed-write cleanup).
- These are browser-fixture and native-emulator results, not physical-phone
  acceptance. No installer was accepted and no production App was replaced.
