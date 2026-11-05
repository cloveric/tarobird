# Network join route setup and screenshot QR recovery

## Actionable route setup after pairing

Pairing a desktop to an existing host does not publish that host's routes to
network members. In the reported join screen, the new computer had shared routes
but the coordinator still had none. The consent checkbox and final join action
were correctly blocked, yet the main action only appeared disabled and a generic
note left the owner to find a separate route-review button farther up the dialog.

The join footer now identifies the next host missing shared routes and opens its
existing route preparation/review dialog. After routes are explicitly shared,
the footer advances to the next missing host or to the normal join confirmation.
The disabled consent checkbox references the named-host explanation for assistive
technology. Long host names wrap inside the new action.

This does not treat a paired connection as a published route or remove the route
checks. Opening a route review performs no mutation. Route sharing still requires
its own owner confirmation, and membership still requires explicit consent,
current owner access, and the existing signed join/review protocol.

## Dense QR codes surrounded by phone UI

The original private phone screenshot failed in the unmodified image decoder,
while a tight local crop decoded and passed the existing pairing parser. The
perspective reader could locate finder points but failed to decode this dense
code. The flat reader used outermost black pixels for its bounds, so neighboring
text and icons invalidated those bounds even inside the existing screenshot tiles.

The image decoder now retains a bounded set of ZXing finder points and uses
axis-aligned finder triples to schedule at most four deduplicated crop regions.
Crop origins and edges align to source pixels, avoiding another fractional
interpolation of dense modules. Each crop uses two existing pixel samplers.
Canvas limits, cancellation, original decode passes and the strict pairing parser
remain in place. There is no image upload, external decoder or new dependency.

The regression image is generated from public synthetic pairing data. The private
original, its decoded invitation and its connection addresses are not committed.

## Verification and delivery boundary

- Both new route-footer browser cases failed before the UI change and passed
  after it. All 23 network-manager browser tests passed, including independent
  route confirmation, explicit join consent, stale-review rejection and retry.
- All three real disposable two-Hub onboarding browser scenarios passed:
  foreground phone approval, background approval and controller-only pairing.
- All 14 QR browser tests passed in Chromium. The synthetic dense screenshot
  failed before the fallback and passed afterward. The original private JPEG
  also passed local decoding, strict parsing and the actual scanner file-input UI.
- Six focused network protocol/storage/route unit suites passed: 20 tests.
- Client translations, type checking and production build passed.

The local Chromium runs used an already-installed browser with a scratch config;
that machine did not have the revision pinned by the installed Playwright package.
The older installed WebKit runtime did not start the optional check. These results
do not establish native WebView, physical camera or rebuilt-installer acceptance.
The repository-wide suite also retains the separately recorded Windows symlink
permission limitation; it is not claimed green by these focused checks.

These are client route-guidance and image-recognition changes. Shared host APIs,
the headless CLI, schema, membership authorization and engine adapters do not
change. This PR does not publish or install a new App, change an update feed,
or alter existing host/device membership. Existing installed Apps need a later
build containing these source changes.
