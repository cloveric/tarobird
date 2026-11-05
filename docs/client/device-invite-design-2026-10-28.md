# Device overview and QR invitation design — 2026-10-28

The owner supplied two phone screenshots and requested normal-weight Add device/My network labels, aligned connection statuses, a simpler invitation page, long-press saving to Photos, and the label “重新生成二维码”. The implementation was reviewed jointly with Opus 5.5.

## Interface

The network overview uses a common status column so Connected and Connecting dots and labels align. The two requested labels use regular weight. The invitation keeps a compact three-step progress row, one primary QR, adjacent Copy/Save actions, then its remaining lifetime and Regenerate action. Repeated instructions have been shortened; route availability, the target Host identity, expiry, single-device use, and the separate eight-digit approval step stay visible or accessible.

A still touch on the displayed QR opens its own action menu. Scrolling, moving the pointer, ending the gesture, replacing the QR, hiding the page or leaving the component cancels a pending hold. A visible Save action also supports keyboard and assistive-technology users; desktop right-click opens the same menu. Phones say Save to Photos; desktop/browser use Save QR image and the existing file export flow.

Saving starts only for the currently displayed, locally live invitation. Repeated triggers during a write are ignored. Permission denial, cancellation and native failures never produce a success message. A result for a replaced, expired or unmounted invitation is not shown on the new QR. An explicit save already handed to the operating system may still finish after the page closes; it does not extend or reactivate the invitation. The Host remains the authority for expiry, claim and approval.

## Native implementation

`qr-hold.ts` handles the cancellable gesture; `qr-photo-save.ts` selects the platform and validates a bounded PNG data URL. The dedicated `TaroBotQrPhotos` bridge accepts only a bounded PNG and a generated TaroBot QR filename, never arbitrary URLs or paths.

- iOS uses Photos add-only authorization and `PHAssetCreationRequest`, resolving success only after the Photos change completes. `NSPhotoLibraryAddUsageDescription` explains this requested action.
- Android 10+ inserts into `Pictures/TaroBot` using MediaStore with a pending row, then publishes it after the bytes are written; failed writes remove the pending row. Android 7–9 request legacy write permission, limited in the manifest to API 28.
- Desktop/browser reuse the existing export receipt: a dismissed file dialog is cancellation and a browser handoff is described as a download handoff.

This is App presentation and local image export. The CLI retains the same pairing APIs, five-minute invitation, single-device claim and separate owner approval; no new CLI command or changed authorization rule is required. No production invitation, network setting or photo library was changed during verification.

## Verification

- Chromium and WebKit QR interaction/layout: 8 passed in each engine, including 320/390/1360 widths, aligned status dots, 400-weight overview labels, menu placement and save receipts.
- Android full Debug Java compilation passed using the real Capacitor and Android dependencies. The Gradle unit-test run passed all 10 selected tests: 3 QR image-validation and 7 notification-body cases.
- Final integrated client translation check, TypeScript check and production build passed.
- Existing invitation behavior: 19 Chromium and 19 WebKit checks passed. Related network-manager and pairing-wizard-invite regression: 47 Chromium checks passed.
- iOS unsigned simulator build passed for both arm64 and x86_64 with the Photos and notification-settings plugins registered; temporary compile-only web assets were removed afterward.
- QR gesture/image-export unit checks: 4 passed.

Browser bridge tests establish application behavior, not physical Photos/MediaStore acceptance. The iOS simulator build is unsigned compilation only; no updated App was installed or released. The owner received the network overview, compact invitation and phone Photos-menu previews in the current App conversation; the gallery has a confirmed delivery receipt.

Primary native references: [Apple add-only usage description](https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSPhotoLibraryAddUsageDescription), [Apple Photos library](https://developer.apple.com/documentation/photos/phphotolibrary), [Android shared media storage](https://developer.android.com/training/data-storage/shared/media).
