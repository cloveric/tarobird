# Design incorrectly reports that the installed Host needs an update

## Reproduction and cause

The owner reported DD1 returning `workbench_design_host_update_required` while
the Design tab remained blank. The installed App is 1.0.123, built from
`8ca8f06ade38e9e8e6d524b8f812247a520c56c6`. A fresh read-only Host inspection
confirmed version 0.1.468, running, not draining, and relay online. This was not
evidence of an outdated or disconnected Host.

The Hub's App-client handshake advertised `workbench.design.v1`, but its separate
`instance.ready` handshake to Bot gateways omitted it. `GatewayTransport` retained
that incomplete list. The correct compatibility guard in `GatewayChannel` then
rejected `design.*` before dispatch, producing the misleading update requirement.
The local editor could load normally, and tests invoking the Instance API directly
bypassed this guard. Those checks therefore missed the actual Bot tool failure.

## Fix and preserved boundaries

`src/hub/server.ts` now includes `WORKBENCH_DESIGN_CAPABILITY` in `instance.ready`.
The existing guard remains: older Hosts without the capability still reject Design
operations before dispatch. The human CLI uses the App-client capability list and
did not have this omission; its old-Host rejection remains covered.

This does not change target selection, device authorization, source-message
ownership, ended-turn checks, revision matching or save receipts. It grants no
new authority and does not fall back to whichever Design happens to be active.

## Validation

`tests/hub-workbench-socket.test.ts` now runs the real Hub, signed App socket,
GatewayTransport, GatewayChannel and `app_workbench` tool in an isolated state
directory, with DeepSeek, Codex, Claude, Kimi and Antigravity engine identifiers.
All five cases first failed with the exact reported error. After the fix, they
pass the negotiated capability, source-bound `design.read`, exact-target
`design.publish`, admission and receipt checks. A publish result is only accepted
after the App peer returns `applied`, `saved: true` and the next revision.

`tests/workbench-cli-tools.test.ts` covers both Markdown and Design rejection by
an older Host, through the Bot tool and CLI, while whiteboard access still works.

- Focused red/green run: **5 failed before / 5 passed after**. The other ten tests
  in that file were intentionally filtered out in these two runs.
- Full affected suites: **99 passed across 5 files**, including gateway rejection,
  signed sockets, Design routing, CLI tools and broker behavior. This includes the
  five new cases; it is not an additional coverage total.
- Host standalone build: **passed**, including TypeScript compilation, relay
  bundling and standalone dependency-graph validation.

Logs are under `/Volumes/gdrive/taro-tmp.noindex/design-gateway-capability-20261031/`.
These are actual transport/tool integration tests with an App peer supplying
controlled receipts, not real model calls or evidence of installed editor writes.

## Installation boundary

The earlier 1.0.123 acceptance verified a real model response and local Design
loading separately. It did not verify the Bot-to-Design gateway handshake. This
post-release defect is recorded explicitly in that acceptance document.

This fix changes source only. No release, installed App replacement, production
Host restart or user Design modification was performed. The installed 1.0.123
still needs a later build containing this fix before that path is usable.
