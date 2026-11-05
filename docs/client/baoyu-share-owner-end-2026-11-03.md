# Owners end Baoyu shares without the shared document (2026-11-03)

## Defect

A share was closed only through the source window's live `DesignSession`
(`WorkbenchController.endDesignShare` → `DesignShareManager.close(session)`).
In each of these cases nothing closed it:

- the design was deleted while the App was offline;
- the design was deleted from the Workbench library while no window held it;
- the source window was gone.

The Host record stayed `open` with its grants, and grantees kept seeing it. Each
such record also counted against the owner's 16-share limit, so after 16 of them
every new share failed with `design_share_limit`. The lists hid the source
device's own shares, so no UI could end them.

## Behavior

- Both share lists — the Workbench menu's "Baoyu designs shared with me" and the
  design Share panel's "Shared with me" — offer **End share** on every share
  whose role is `owner`:
  - on the owner's other devices, next to Open;
  - for this device's own shares, in a separate "Shared from this device" list
    with End only, because a source device cannot join its own share.
- Ending asks for confirmation first, ends the share for everyone and deletes
  no design.
- Grantees see no End control. The Host also refuses them
  (`design_share_forbidden`), as before.
- `DesignShareManager.closeShare(shareId)` sends the existing Host `close`
  operation. Host authorization, permissions and data are unchanged; there is no
  Host cleanup heuristic, so offline but still valid documents are never closed
  automatically.
- A source this connection serves for that share retires only after the Host
  confirms the close (no detach afterwards).
- A source window also retires when its share was ended elsewhere:
  - immediately, when it receives the Host's `revoked` event;
  - otherwise, when its reconnect attach or a later "Start sharing" gets
    `design_share_closed` / `design_share_not_found`.

  "Start sharing" then opens a new share instead of failing permanently.
- A close that arrives before the initial open reply is also observed; the late
  reply cannot adopt an already closed source.
- An open joined copy keeps its existing "access revoked or share ended" state.

CLI: not applicable. Sharing is an App-connection feature with no CLI command,
and the Host operation and its authorization are unchanged.

## Regression coverage

- `tests/hub-workbench-design-share-owner-close.test.ts` (real broker and
  HubStore, production manager and sessions):
  - an offline-deleted orphan ended without a session;
  - the owner's other device ends a share; the serving window retires and the
    joined copy shows the end;
  - a source that was offline when its share ended can share again;
  - a grantee is refused and offered no End;
  - quota recovery after 16 orphans;
  - an active source retires only after a confirmed close;
  - a close received before the initial open reply prevents adoption of that
    ended source.
- `client/tests/design-share-row.test.tsx`: the actions each row offers and the
  confirmation markup.

The final production client passed all three Playwright sharing journeys with
a real temporary Hub, signed sockets and separate browser contexts: same-owner
editing/reconnect/leave, granted-member read-only/revoke, and offline document
deletion followed by owner recovery from an empty Workbench. The last journey
covers both Cancel and confirmed End share. Its confirmation screenshot was
also inspected. This verifies local browser behavior, not an installed App,
physical device or wide-area network. See the
[second review](baoyu-design-ppt-second-review-2026-11-03.md) for evidence.
