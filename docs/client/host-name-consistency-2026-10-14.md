# Shared host name consistency — 2026-10-14

The App could display a client-local alias on one screen and the host-owned
name on another. In particular, **Manage this device's connections** previously
saved only the local alias when network metadata was unavailable. A later sync
then replaced that apparent rename with the host's name, initially taken from
the operating system. A failed directory refresh could also report failure
after the host had already accepted a rename.

## Behavior

- Both App rename entries use the existing owner-authorized host-profile API.
  An offline, unauthorized or unsupported host cannot produce a successful
  local-only rename. The connection manager validates the name and prevents
  duplicate submissions while saving.
- A successful host receipt updates the connection immediately, independently
  of the network directory request. Failed directory refreshes do not undo the
  accepted name or leave its editor open with an obsolete revision.
- The registry caches the acknowledged name and revision, tied to the current
  registration. Older responses, closed/replaced connections and removed
  registrations cannot overwrite a newer acknowledged name.
- Desktop and phone views resolve the same acknowledged name. The old local
  label remains only a fallback until a host profile is available. Restarting
  the client retains its latest acknowledged name.

Renaming does not change the host public key, pairing, network membership or
Bot ownership. It does not rename controller devices or the OS computer.

Follow-up: [2026-10-16 native device naming](host-device-name-sync-2026-10-16.md)
now links the proven local desktop controller's display name to this profile.
Other accessing devices keep separate names; the OS computer name is unchanged.

## CLI parity

The CLI already reads and updates this same host profile through `tarobot name`.
This is a client consistency repair; no new command, host protocol, schema
version or engine-adapter behavior is needed. CLI management regression covers
shared renaming and rejection of a stale revision.

## Verification boundaries

Final focused validation: Chromium **60 passed**, WebKit **49 passed**, and host,
CLI management and profile-response unit tests **28 passed**. Client translation,
type checking and production build, root standalone build and whitespace checks
passed.

Focused tests cover immediate acknowledgement, delayed older reads, failed
directory refreshes, rejected writes, obsolete registrations and connection
epochs. Browser tests use disposable real Hubs and independently paired desktop
and phone-sized contexts to exercise shared renaming, reload, a newer host-side
rename, host shutdown and an unsupported profile endpoint. Network admission,
revocation, multiple-host isolation and HTTP lifecycle regression are included.

Separately, the user's running Mac mini was renamed to `example-mac` through the
installed desktop App. Its native network detail, sidebar and workbench showed
the new name, and a read-only check confirmed the saved host profile at revision
1. This is evidence of the live name change, not installation of the source fix.
The physical phone and remote MacBook were not directly inspected. No installer
is published by this source revision.
