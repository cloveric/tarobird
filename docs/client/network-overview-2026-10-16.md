# Network overview and guidance — 2026-10-16

The phone's My network sheet repeated its title, put public-key suffixes in every
row and displayed an always-visible paragraph about the coordinator. It also
reported a connected coordinator as unavailable when this device lacked owner
permissions, and a slow manual refresh prevented closing the sheet.

## Result

- One title and a short introduction, a compact Add host button, a quiet refresh
  control, and a bounded host list using the current theme's colors. The default
  network name is presented as a section label instead of repeating the title;
  custom network names and the multiple-network selector remain available.
- Rows show the shared name and a dot plus connection status. Connecting,
  disconnected, unknown connection, expired access and pending admission remain
  distinct. Pending hosts have a separate count, rather than silently inflating
  or contradicting the active-host total.
- Identity suffixes appear in the overview when displayed names collide after
  Unicode normalization, trimming and case folding. Detail, selection and consent
  screens retain the identity information. The connection manager uses the same
  public-key suffix as the network view.
- Data ownership and coordinator responsibilities are under an accessible
  disclosure. Important availability or permission restrictions remain visible,
  with the reason attached to the disabled Join control. Host detail explains
  why rename/share controls are unavailable.
- “Connections on this device” replaces the ambiguous local-computer wording in
  all entry points and the destination title. Connection removal retains its
  existing draft/history warning and explicit confirmation.
- Refresh is a read-only operation with its own in-progress state. It retains
  keyboard focus, does not lock closing/navigation, and ignores late UI results
  after unmount. Membership writes still retain their existing busy guards and
  explicit consent. Reduced-motion preferences disable the refresh animation.

## Independent review

The user requested Opus 5.5 at xhigh effort. A real Claude Code 2.1.301 invocation
used `claude-opus-5-5[1m]`, `--effort xhigh` and read-only tools. Its completed
29-turn review reports canonical model `claude-opus-5-5` with a 1M context window.
It inspected the supplied screenshot and scoped source. Findings informed the
status separation, refresh behavior, identity disambiguation, pending counts,
disabled-control guidance and compact visual hierarchy.

A second completed five-turn invocation with the same model and effort inspected
the implementation and both 390px screenshots. It found no blocking issues. Its
remaining actionable guidance was integrated: the admission dialog now shares
the overview's status explanation, successful operations clear stale refresh
errors, and returning/canceling clears the relevant operation's error.

Raw reviewer output, reproduction traces and browser screenshots remain in the
external-disk verification directory, outside the repository.

## Validation and delivery boundary

The original 23 network-manager browser scenarios passed before changes. Two new
regressions failed against the old behavior: an online non-owner coordinator was
described as unavailable, and a held refresh disabled the close button.

Validation includes Chromium and WebKit at phone and desktop widths, long English
content in portrait/landscape, light/dark screenshots, duplicate names, keyboard
disclosure and focus restoration, late refresh failure, and existing explicit
admission/route/departure consent. Keyboard focus tests activate the host row with
Enter because WebKit intentionally does not focus buttons on a pointer click.

The broader journeys also exposed stale selectors from the previous
host-grouping presentation: they expected a source badge on every
mobile conversation while host grouping was enabled. Their failure snapshots
showed the correct source headings and rows. The tests now choose conversations
within the named host section and check that the duplicate badges are absent;
no host-grouping product behavior was changed here.

Final local results:

- 32 network-manager cases passed in each browser engine (64 total).
- 23 broader journeys passed in each engine (46 total), including the corrected
  grouped-host selectors in targeted rechecks. These use disposable real Hubs
  for pairing, shared names, membership, offline access, isolated drafts/files,
  and connection removal; no production host is involved.
- 146 focused host/protocol/device-action tests passed across 10 files.
- Root standalone build, client translations, TypeScript and production build
  passed. Light/dark phone screenshots were visually inspected, including the
  independent Opus review, and the updated phone preview was delivered in App.

CLI impact: not applicable to this presentation change. Shared identity,
membership APIs, permission gates, signing, CLI commands and schema are unchanged.

These changes are source/browser verification, not a new APK, macOS/Windows
installer or physical-phone acceptance. Installed versions are not changed.
