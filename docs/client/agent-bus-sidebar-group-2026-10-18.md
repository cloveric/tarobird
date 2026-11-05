# Update — 2026-10-28

Globally pinned conversations now precede the Agent Bus directory section, as
requested for pinning above all groups. Bus ordering within its own section is
unchanged. See [two-level pins](global-conversation-pins-2026-10-28.md).

# Agent Bus in the conversation group list

Agent Bus previously occupied a separate fixed sidebar region above the
conversation filters, with its own 32vh scrolling area. It now appears as one
system group immediately below the filters, in the same scrolling list as
conversation folders. It shares the ordinary folder heading, count position,
spacing and disclosure icons. The group is hidden when no saved Bus exists;
the main Agent Bus entry remains available for creation.

The ordinary sidebar's Agent Bus and New buttons share the right-hand action
area with the existing 8 px gap. Only the Bus button consumes the flexible
space after the wordmark; New no longer adds a second automatic left margin.
Both controls keep their existing click targets and behavior.

`HostApp` owns the placement in normal and ADHD navigation. `CombinedSidebar`
accepts a leading section for merged host lists. The single/grouped-host path
places its first folder toolbar before the Bus group and retains the other
hosts' folder managers. The lifted toolbar is keyed by host registration so
changing the host filter cannot reuse an open editor for another host.
The former separate `ManagedWorkspace.agentBuses` slot is removed.

The Bus list follows the current host filter, while saved definitions and
selection remain scoped to host registration and workspace ID. A single host
does not repeat its name inside the group; multiple host sources remain named.
Collapsing the group retains its existing local preference and continues to
observe running work, without closing member panes or discarding task drafts.

This is a system navigation group, not persisted conversation-folder metadata:
it is not offered as a destination for moving user messages, and does not alter
the saved order of custom folders. No Hub, schema, execution, permissions or
headless CLI behavior changes are required. Agent Bus remains desktop-only.

## Verification

The final focused matrix passed **13 Chromium and 13 WebKit cases**.
Browser coverage uses the production client and isolated Hubs with
controlled Bus API responses. The matrix includes:

- Group placement after filters, the same heading metrics as custom folders,
  shared scrolling for ten Bus entries and regular conversations, and removal
  of the last empty group while retaining the creation entry.
- Collapse persistence across normal/ADHD navigation; task and member drafts.
- Two local test Hubs with identical Bus/conversation IDs, merged/grouped host
  lists and host filtering. No phone Agent Bus UI is introduced.
- Ordinary folder create/rename/delete/reorder, desktop/phone synchronization,
  same-ID host isolation, and closing modal editors when their host is hidden.
- The previous Bus-return scrollbar and explicit draft-discard regressions.

Client production build, TypeScript and translation checks also passed.

The subsequent header-button spacing adjustment reran the existing inline
sidebar journey once in Chromium and once in WebKit (both passed), inspected
the rendered sidebar, and passed the client production build. It changes only
the desktop spacing and has no CLI impact.

Native installed-App replacement and real-agent execution are separate from
this browser validation. This change does not publish a release or install a
new Mac App, and does not claim a new full host regression run.
