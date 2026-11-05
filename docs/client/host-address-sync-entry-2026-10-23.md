# Host address sync entry

The owner could not find address publication without instructions. It was under
Settings → Devices & network → host details → Connection → Sync host addresses.
The overview now exposes **Sync host addresses**, with the existing question-mark
help, directly in the network summary card. The host list remains uncluttered.

The shortcut opens the existing review page. Multiple hosts require an explicit
selection; only a network with exactly one non-revoked, active host preselects it.
Pending members are handled through Continue joining. A selected host's name and
identity suffix identify it independently of the coordinator and local computer.
The detail and joining entries remain available.

Opening the page or help and refreshing the overview never publishes addresses.
The owner still reviews and confirms the addresses. When the merge would remove
an already shared URL, the review shows the addresses being replaced separately
from the resulting list. This is a review aid, not a reachability or freshness
test; the existing merge policy and Host authorization remain unchanged.

## Correctness boundaries

- Overview review is bound to its opening network ID and authority key. A
  changed membership, revoked/missing member, pending network-change review,
  offline connection or missing owner/capability blocks publication. The target
  is rechecked at confirmation; the Host remains the final authority.
- The page explains offline, permission and older-Host limitations in terms of
  address synchronization. Server `network_identity_mismatch` is localized.
- Pending writes lock target selection and close/back actions. Errors retain
  the target; the existing busy guard prevents duplicate commands.
- Acknowledgment distinguishes a saved network address from a member's address
  awaiting coordinator synchronization. Overview receipts are network-scoped
  and never appear after the old detail/join flows, including standalone hosts.
- Saving closes the review before background directory refresh. Focus restores
  after the overview trigger becomes enabled; cancel, Escape, help and nested
  connection settings retain their expected return destinations.
- Narrow windows and touch input retain the established help-button target
  size. Shared avatar, typography and platform density settings are untouched.

## Review and verification

An independent CC1 reviewer configured for `claude-opus-5-5[1m]`, effort `xhigh`,
reviewed the design, source and screenshots. Its findings prompted the replaced
address preview, context-specific notices, scoped receipts, pending-member
handling and narrow-screen help target correction. No Host was restarted and
no real network configuration was changed during validation.

Relevant suites: `network-address-sync-entry`, `network-manager`,
`network-manager-target`. The new suite is included in the WebKit configuration.
They cover desktop/narrow layouts, English/dark display, permission and membership
changes, explicit selection, write failures, duplicate prevention, return focus,
waiting acknowledgments, read-only refresh and original-entry compatibility.
Client build includes translations, TypeScript and Vite.

Final verification: 64 Chromium checks across all three suites, 19 WebKit checks
across the new entry and target-navigation suites, and the client build passed.
The final Opus review found no blocking issues; its remaining copy and test-race
suggestions were applied before these runs. Desktop and narrow Chinese/English,
light/dark screenshots were inspected, including the address-replacement panel.

The tests use isolated simulated connections and browser engines. They do not
establish native iPhone/Android acceptance or delivery to real Tailscale peers.
This change does not publish a release or update the installed App.

CLI impact: none. This is App navigation and review presentation over the same
Host API. `tarobot network routes --from FILE --yes`, pairing, membership,
listener configuration and signed route propagation retain their behavior.
