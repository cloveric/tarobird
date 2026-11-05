# Live group avatars

Android **0.1.414-test.1** (version code **2026101229**).

## Behavior

- Default group portraits combine the group's current Bot avatars. One member
  fills the portrait; two to four use two columns; five or more use three.
  Partial rows are centered. Up to nine members are shown, in group order.
  Removing a visible member brings the next member into the collage.
- Adding/removing members or changing a Bot's picture updates the collage on
  connected clients. Reopening offline uses the last synchronized membership
  and cached pictures. The inbox, desktop sidebar, chat header, details and
  forwarding destinations use the shared component; topics inherit their group.
- A manually uploaded group picture stays authoritative. Removing that picture
  restores the current member collage. Empty historical groups retain the
  generic group icon until membership is available.
- The component uses each host's existing conversation directory and existing
  authenticated avatar loader. Identical group/Bot IDs on different hosts do
  not share membership or image identities. No Hub migration or saved composite
  image is needed, and existing groups gain the new default on client update.

## Verification

- Chromium and WebKit each passed 20 distinct focused journeys across avatars,
  avatar-library editing, group settings, forwarding, creation and startup.
  The collage journey checks one, two, three, four, five, eight, nine and ten
  members, member removal beyond the nine-avatar limit, bounds/overlap, live
  desktop-to-phone updates, topic headers/details and an offline phone reload.
  Other journeys cover Bot custom images inside the collage, group custom
  image precedence/restoration, competing revisions and same-ID host isolation.
- Older avatar tests still entered the former conversation quick settings;
  their navigation now uses the separate Bot settings page. Cold offline
  startup correctly leaves live Bot configuration unavailable while cached
  pictures remain readable. Both corrected journeys passed in both engines.
- Inspected actual isolated-Hub application captures:
  two members (historical image omitted from this clean snapshot),
  four members (historical image omitted from this clean snapshot),
  nine-avatar limit (historical image omitted from this clean snapshot) and
  topic details (historical image omitted from this clean snapshot).
- Standalone gate: 223 test files, 2,875 tests passed and one existing skip.
  Clean client install, translations, TypeScript, Vite and Android sync passed.
  No dependencies changed; npm still reports three moderate client advisories.
- Independent production-directory and extracted npm-archive installs start
  an isolated Hub and serve the client without the Feishu SDK.
- Android release build and lint passed with zero lint errors and 22 existing
  warnings. The JVM task reused its current passing 21-test result. The signed
  APK retains the update certificate; all 376 public assets match the synced
  client bytes, and the collage code/CSS is present. Launcher validation covers
  15 PNG densities, two adaptive launchers and the manifest references.
  [APK receipt](evidence/group-avatars-2026-10-12/apk-verification.json).

Browser rendering and package verification are separate from installation and
acceptance on a physical phone or an installed Mac application. This prerelease
publishes an Android APK. This client change does not require restarting
paired hosts, relays, Telegram or Lark services.
