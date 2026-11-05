# Phone inbox actions and notification discoverability

The phone inbox previously handled taps only, allowing the WebView text-selection
menu to appear when holding a conversation preview. Holding a row for 500 ms now
opens a bottom sheet with pin/unpin, rename, and confirmed removal. A top-level
group uses “解散群组”. A short tap still opens its conversation.

## Behavior

- Selection/callout suppression applies only to inbox row controls. Chat content,
  editable fields, and message text-selection actions retain their behavior.
- Moving more than 10 pixels, actual list scrolling, a second pointer, pointer
  cancellation, blur, leaving the screen, or changing filters cancels the hold.
  Late native context menus cannot revive a cancelled gesture. Releasing the
  opening finger cannot click the underlying row or a newly opened action.
- Keyboard ContextMenu/Shift+F10 and mouse context-click also open the sheet.
- Actions resolve the held host plus conversation ID. Identical IDs on another
  host do not share writes. Pinning follows existing device-local persistence
  and works offline; rename/removal require connection and ownership.
- Delete/dissolve use the existing recoverable archive. The confirmation explains
  that the group/topics disappear across devices, history remains restorable,
  and Bot/workspace/memory and already-running tasks are retained. No engine or
  workspace is destroyed. Restoration is available under Me → Archived
  conversations. The UI waits for the accepted cache state before completion.

## Notifications: available UI is not background delivery

Me now exposes **消息通知** directly, with a saved-intent / setup summary. Opening
it goes directly to the notification permission, provider readiness, recovery,
UnifiedPush and quiet-hours page. Opening the entry requests no permission and
does not create a subscription. Back returns to Me and restores focus.

During read-only inspection the owner's active desktop host had a relay but no
APNs, FCM, Web Push or UnifiedPush configuration. The private Android build also
has no Firebase `google-services.json`. Therefore its VPS chat connection does
not establish lock-screen notification delivery. This change does not silently
enable a third-party service, install a distributor or restart the host/relay.

Android background delivery needs either the app/host Firebase configuration
and usable Google services, or a configured UnifiedPush distributor such as
ntfy. The ntfy route requires an additional phone app; the receiving route is
still a user setup decision. See [ntfy's official UnifiedPush documentation](https://docs.ntfy.sh/subscribe/phone/#unifiedpush)
and [private relay / ntfy deployment](relay-deployment.md#optional-ntfy-and-tailscale-peer-relay).
No phone lock-screen delivery claim is made here.

## Verification

- Chromium and WebKit exercise actual hold/release, cancellation, durable pins,
  delete confirmation, archive recovery, offline permissions, host isolation,
  direct notification navigation and honest unconfigured state.
- Chromium's first journey uses trusted touch input; its release does not open
  the conversation or activate an action. Other cancellation cases inject
  pointer events to cover each branch deterministically.
- Existing desktop conversation actions and mobile navigation journeys pass.
- Initial added-test failures were fixture issues: the scroll fixture attempted
  to scroll farther at its boundary, and direct store restoration did not publish
  a client update. The corrected cases move the actual scroll position and use
  the real archive restoration UI.
- Full standalone build/test gate: 220 files, 2,858 tests passed, one existing
  skip. Browser/native-package checks are distinct from physical-device use.

Screenshots: action sheet (historical image omitted from this clean snapshot),
group confirmation (historical image omitted from this clean snapshot),
notification entry (historical image omitted from this clean snapshot).
