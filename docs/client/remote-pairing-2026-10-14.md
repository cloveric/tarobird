# Remote device enrollment — 2026-10-14

## Problem and resulting flow

A MacBook user away from home had to export a phone QR screenshot, recover from
image recognition failure by typing the host key and VPS address, then ask a Bot
to approve the device on the home computer. Existing owner-device authorization
already allowed the paired phone to approve, but the waiting screen specifically
instructed the user to confirm **on the computer**, and mobile controls were buried.

The supported journey is now:

1. Paired phone: **Me → Devices & security → Add a new device → Copy pairing information**.
2. New computer: **Connect existing host → Paste connection details**. Review the
   imported host route, name the device and request pairing. QR image import and
   camera scanning remain adjacent alternatives. macOS and Windows initially keep
   the technical manual form collapsed.
3. Paired phone: the open device-sharing flow shows a read-only pending request
   and **Enter code to confirm**. If returning later, **Confirm a new device** goes
   directly to the eight-digit form. The new computer explains this phone route.
4. Verify the code shown on the new computer and explicitly confirm. The computer
   enters the workspace only after authenticated connection succeeds.
5. A computer bringing its own host/Bots still goes through the existing explicit
   network admission review. A phone remains an independent network member.

No passwords, private device keys, bearer credentials or automatic approval were
added to invitations. Existing strict pairing validation, trusted Hub identity,
route-scoped certificates and signed device-action challenges remain mandatory.
Pending-device names do not authorize anything; codes are never exposed by that
read-only endpoint. Polling runs only while device settings or its wizard are
mounted, skips hidden pages, aborts on disposal and quietly supports older hosts
without the pending-list endpoint. Existing CLI `pair`, `devices pending` and
`devices approve` use the same core; the CLI guide now explains phone approval.
No host-core behavior or CLI command implementation changed in this UI revision.

## QR import and recovery

Connection/approval codes now use a larger 300 px layout (bounded by available
width), and the landscape invite no longer squeezes them to 150 px. The image
entry accepts a file, drag/drop or a pasted image without starting a camera.
Text is also directly accessible instead of being hidden behind the camera UI.

A deterministic 2400×8000 screenshot fixture containing a 450 px certificate-bearing
QR failed with the previous whole-image decoder. Its canvas size cap reduced the
QR itself below usable detail. The fallback now tries at most eight overlapping
square regions using the existing samplers and bounded resampling; each canvas
retains the existing 6-million-pixel/3200-edge budget. Cancellation is checked
between passes. The same original screenshot now decodes with its certificate
intact. The user's original failed connection screenshot was not supplied, so
this is a reproduced failure class, not proof of that exact image's recovery.

Expired approval screens stop the waiting animation, hide the expired approval
QR and show renewal guidance. Returning to setup, retaining pending identity and
recovering a changed address keep their existing behavior.

## Validation

- Root authorization, CLI management, private network and network HTTP suites:
  **106 passed**. Root standalone build and client translation/type/production
  build passed.
- Across the final focused runs, Chromium passed all **73** cases; WebKit passed
  **72**, with one Chromium-only canvas-camera fixture skipped. Covered remote phone-to-computer enrollment; direct confirmation;
  wrong-host approval rejection; QR masks, original/compressed/tall screenshots;
  paste/drop; camera cancellation; desktop back paths; expiry/reload; signed
  native-transport boundary; lost approval response; route repair; and existing
  multi-host network admission/departure journeys.
- Two existing fixture assumptions were repaired: the device-settings test now
  initializes the authoritative host profile instead of assuming a client alias
  renames it; offline-route reload waits for the existing startup recovery window
  (bounded at 20 seconds) before inspecting settings.
- Manual computer-use acceptance used two disposable loopback App origins sharing
  a disposable Hub. Prepared one phone identity, copied its connection information
  through the actual UI, imported it in a new computer tab, observed the named
  pending request in the 390 px phone UI, entered the displayed code and approved.
  The computer automatically entered its connected workspace. No live user host,
  Bot, membership or authorization was changed.

Browser WebKit is not native macOS acceptance. Windows WebView2, Android physical
camera/clipboard/keyboard, the user's real VPS and a remote physical MacBook still
need installer/device acceptance. No installer was rebuilt or installed for this
source change; it does not update the currently installed Apps.
