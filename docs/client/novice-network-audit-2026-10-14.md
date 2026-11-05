# New-computer network onboarding audit — 2026-10-14

## Review method

The user asked for Claude Opus 5.5 to act as a first-time user, walk a computer
through joining an existing network, and identify usability and safety defects.
The installed Claude CLI was run with model `claude-opus-5-5[1m]`, effort `xhigh`,
read-only tools and no persistent session. It independently reviewed the source,
then inspected screenshots and chose the next UI actions. Those actions were
executed through computer-use automation and the resulting screens returned for
review. Opus did not itself control the mouse. A second source review found
additional recovery and local-identity boundaries, which were repaired. A third
focused source review confirmed the four main repairs and identified the optional
controller-only dismissal and route-backtracking details addressed afterward.

The manual scenario used two disposable real Hubs with independent identities,
an already paired phone-sized App, and a clean desktop App origin. The new
computer started with only its local loopback connection, no published routes,
no network membership and no Bots. The phone approved the displayed eight-digit
code through the actual device settings UI. The computer then prepared a route,
reviewed the network and joined; the phone automatically showed both hosts as
connected. A preliminary run had started with a shareable local route already
available; Opus correctly rejected that as insufficient first-install coverage,
so the fixture and walkthrough were repeated from the loopback-only state.

## Findings and repairs

| Problem | Resulting behavior |
| --- | --- |
| Pairing looked like completion although local-host admission still remained | A three-step desktop journey distinguishes preparing the computer, phone approval, and network admission. Both devices explain the remaining step. |
| A fresh computer had no usable published route, and the join dialog sent it to a client route editor | LAN/Tailscale preparation is available directly inside the joining flow. It explains listener activation, brief host restart, authorization and external-access prerequisites. |
| Choosing LAN while away left no clear way to switch to Tailscale | Existing local routes also have **Change this computer's connection**. Ordinary pairing preserves Tailscale; intentionally switching the network back to LAN requires acknowledging the loss of direct remote access, while VPS fallbacks remain. Publication failures/timeouts are visible and retryable. |
| Local client routes could be overwritten, especially while native identity was loading or unavailable | Local identity is verified against the native public key. Unknown identity blocks route editing; failures or a bounded lookup timeout provide retry. Local routes point to host access setup instead of editing loopback. The submit handler also guards identity changes. |
| Closing the dialog or restarting lost the intent to join the existing network | A public-identity navigation intent restores pairing or offers **Continue joining**; **Not now** dismisses the intent for a controller-only computer. Hidden approval completes durable pairing without navigating away from current work. |
| Joining another host could clear the local computer's pending intent | Intent is cleared only when the verified local host is actually active in the intended target network. This also handles completion after reconnection and avoids overriding host selection on every future launch. |
| An initially offline local host consumed the join prompt permanently | The prompt opens after the local host becomes available; it need not be manually closed and reopened. Network loading is distinguished from an absent/unsupported network. |
| Creating a network could choose the new laptop instead of the intended existing host | The existing target is preferred; names use the host name, and singleton migration shows its direction explicitly. |
| A new-device approval could leave an out-of-date member review | Before consent, the member review follows the current directory. After consent, changes still require an explicit new review. |
| Sharing a current VPS route discarded other working routes | Sharing merges the route while preserving the configured direct/Tailscale and VPS fallbacks. The existing route-count bound remains enforced. |
| Busy feedback, identity labels and disabled actions were ambiguous | Progress stays on the selected setup action; pairing/network screens label the same public-key tail; missing-route guidance explains why confirmation is disabled. |

## Permission and network boundaries

An invitation still contains public host identity and routes, not a password,
private key or authorization grant. Phone approval still requires the short-lived
code and the existing signed owner action. Pairing a controller does not silently
authorize its local host to join a network. The admission dialog shows the
network members and devices, then requires explicit consent. A phone remains an
independent device member; no Bot, conversation or file is moved between hosts.

Sharing an address is not proof of reachability. A private LAN address normally
cannot be reached from outside that LAN. Tailscale must already be installed,
connected and allowed by its access rules. VPS relays must already be configured
for the applicable host; this UI does not provision one or copy another host's
relay registration. Real host-to-host admission still determines completion.
There is no automatic approval, no firewall change, and no bypass of a changed
membership review.

## CLI parity

This revision changes App onboarding, recovery and presentation. It does not
change the host protocol, schemas, membership rules or engine adapters. Headless
`pair`, `devices pending/approve`, network route publication and network
management continue to use the same host core. No new CLI command is required;
the existing CLI management and host authorization/network suites were included
in validation. No separate reduced host implementation was introduced.

## Verification and remaining gates

Final validation: root authorization/network/CLI suites **108 passed**; focused
WebKit **65 passed**; Chromium **65 distinct cases passed** across the final
broad run and the focused three-journey rerun. The Chromium controller-only case
initially exceeded the fixture helper’s five-second phone enrollment wait; it
was changed to a bounded readiness assertion (20 seconds), and all three
journeys passed on rerun. Client translation/type/production build, root
standalone build and `git diff --check` passed.

The automated
journey covers both foreground and background phone approval, restart while
pending, closing and resuming admission, route preparation from loopback-only
state, explicit consent, signed two-Hub membership, phone discovery and cleared
completion intent. Focused regression also covers stale consent, interrupted
admission, departure/revocation behavior, native identity lookup failure, and
LAN/Tailscale fallback behavior.

The disposable Hubs use real authentication, signed commands and membership
logic. Their TLS and peer connections are real within the fixture. Native shell
startup, OS network configuration, native certificate binding and Keychain IPC
are test substitutes. Browser WebKit is not an installed macOS App. No engine
Bot was run in this onboarding fixture, so this does not claim a model-response
round trip. Physical MacBook/Windows, Android camera/clipboard, cellular/VPS,
Tailscale ACL/certificates, lock-screen discovery and sleep/wake remain separate
installer/device acceptance gates.

This is a source revision. It does not update an installed App or publish a new
installer. The user's existing host identities, Bots and authorizations were not
changed during testing.
