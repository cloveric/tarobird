# Bus Protocol

This document is the source of truth for the local instance-to-instance bus protocol.

The project currently speaks a compatibility-first `v1` protocol:
- new clients send `protocolVersion: 1`
- new servers reply with `protocolVersion: 1`
- parsers still accept the legacy unversioned shape

## Goals

- Keep local delegation between instances explicit and inspectable.
- Allow mixed old/new processes during upgrade.
- Give callers structured failure semantics instead of plain text only.

## Transport

- Endpoint: `POST /api/talk`
- Scope: loopback-only local HTTP
- Auth: `Authorization: Bearer <bus secret>` when a secret is configured
- Health check: `GET /api/health`
- The long POST uses a private Node HTTP connection, not global fetch. One
  caller-owned deadline covers headers and response body; no implicit 300-second
  fetch timeout, redirect or automatic retry. Response buffering is limited to
  16 MiB; request bodies remain limited to 256 KiB.

## Request Shape

Legacy request and `v1` request share the same payload fields. `v1` adds protocol metadata.

```json
{
  "fromInstance": "reviewer",
  "prompt": "Please verify this answer",
  "depth": 1,
  "protocolVersion": 1,
  "capabilities": ["structured-errors", "retryable-errors"]
}
```

Rules:
- `fromInstance` must be a non-empty string.
- `prompt` is the delegated prompt body.
- `depth` is a non-negative integer.
- `depth` is incremented by the caller before sending across the bus.

## Response Shape

New servers always emit a `v1` envelope, even for pre-handler failures such as auth or peer denial.

```json
{
  "success": false,
  "text": "",
  "fromInstance": "worker",
  "error": "Budget exhausted: $1.2000 used of $1.00.",
  "errorCode": "budget_exhausted",
  "retryable": false,
  "durationMs": 12,
  "protocolVersion": 1,
  "capabilities": ["structured-errors", "retryable-errors"]
}
```

Success responses use the same envelope:

```json
{
  "success": true,
  "text": "Looks correct overall.",
  "fromInstance": "worker",
  "durationMs": 241,
  "protocolVersion": 1,
  "capabilities": ["structured-errors", "retryable-errors"]
}
```

Compatibility notes:
- parsers still accept legacy success responses without `protocolVersion`
- parsers still accept legacy failure responses that only contain `success: false` and `error`

## Error Codes

The bus protocol uses stable, additive string codes. Existing codes:

- `invalid_request`
- `request_too_large`
- `bus_disabled`
- `auth_failed`
- `peer_not_allowed`
- `max_depth_exceeded`
- `invalid_handler_response`
- `internal_error`
- `instance_unavailable`
- `connection_lost`
- `response_too_large`
- `server_busy`
- `invalid_response`
- `timeout`
- `cancelled`
- `budget_exhausted`
- `auth`
- `write_permission`
- `telegram_conflict`
- `telegram_delivery`
- `engine_cli`
- `file_workflow`
- `workflow_state`
- `session_state`
- `unknown`

Rules:
- Add new codes; do not silently rename existing ones.
- Prefer machine-readable codes over parsing `error` text.
- Keep `error` human-readable because Telegram and CLI paths still surface it directly.

A process admits at most eight in-flight bus requests. Excess requests return
HTTP 503 with `code: "server_busy"` and `retryable: true` before dispatch. This
is not evidence that an already admitted task failed or can safely be replayed.

## Retry Semantics

`retryable` answers the narrow question:

Can the caller reasonably try the same delegation again without local operator action?

Current policy:
- `false`
  Permanent/configuration/state failures:
  `invalid_request`, `request_too_large`, `bus_disabled`, `auth_failed`, `peer_not_allowed`, `max_depth_exceeded`, `budget_exhausted`, `auth`, `write_permission`, `file_workflow`, `workflow_state`, `session_state`, `cancelled`, `timeout`, `connection_lost`, `response_too_large`, `invalid_response`
- `true`
  Availability/transient failures:
  `server_busy`, `invalid_handler_response`, `internal_error`, `instance_unavailable`, `telegram_conflict`, `telegram_delivery`, `engine_cli`, `unknown`

The local client reports deadlines, connection loss, malformed replies and
response overflow as non-retryable because execution may already have begun.
Only failure before admission (such as an actual refused connection) is reported
as unavailable/retryable. Structured remote errors preserve their returned code
and `retryable` value. These fields do not enable automatic retries in TaroBot.

Important clarification:
- remote `auth` means the target instance could not authenticate its own provider CLI
- the caller cannot repair that automatically, so it is `retryable: false`
- remote `budget_exhausted` means the target instance itself is over budget, not the caller

## Cancellation

Engine runtime watchdog preferences are loaded from the target Bot for each
delegated turn. Disabling those protections with `/timeout off` does not disable
the independent Agent Bus request deadline (default 30 minutes, configurable by
`CCTB_DELEGATION_TIMEOUT_MS`) or an explicitly bounded crew stage. The timeout
status text states this distinction; no Bus wire field changes are required.

Caller cancellation and timeout are non-retryable: the remote turn may already
have performed work. A caller's explicit abort is reported as `cancelled`, not a
timeout. A pre-aborted call never probes or posts to the target.

After an authenticated request starts, losing the unfinished HTTP response
connection aborts that request's engine signal. A fully read request body or a
normally completed response does not cancel the turn. The local handler context
owns this signal; clients cannot provide it in JSON. Other concurrent requests
keep independent signals. Gateway's busy accounting stays active until the
affected handler actually settles. Cancellation is best effort for the native
engine and cannot undo tools that already executed; it is not a rollback receipt.
Reported usage is retained if completion races cancellation, while its timeline
outcome is `interrupted` rather than successful delivery.

## Capability Flags

Current capabilities:
- `structured-errors`
- `retryable-errors`

Rules:
- The current v1 parser accepts only the two listed flags. Adding a flag needs
  explicit version/compatibility work; never send a new enum value to an older
  strict parser and assume it will be ignored.
- do not remove capabilities without a version bump
- only advertise behavior the process actually implements

## Change Rules

- Treat the bus as a protocol, not an internal helper.
- Keep request/response parsing backward-compatible by default.
- Prefer adding fields over changing meaning of existing fields.
- When changing error semantics, update this file and the corresponding tests in:
  - `tests/bus.test.ts`
  - `tests/bus-handler.test.ts`
