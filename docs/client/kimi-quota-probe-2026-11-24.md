# Kimi Code Quota Probe (2026-11-24)

Tested against locally installed `kimi 2.7.3` (`kimi --version` → `2.7.3`) to verify read paths without reading/copying Kimi credentials or sending any model turns.

## Paths Tested (in priority order)

### 1. ACP `/usage` (`kimi acp` → `session/new` → `session/prompt` `"/usage"`)
- **Advertised command**:
  ```json
  {"name":"usage","description":"Show session token usage"}
  ```
- **Observed response** (zero model calls):
  ```json
  {"type":"text","text":"Context: 0 / 1048576 tokens (0%)\nSession total: no LLM calls yet"}
  ```
- **Conclusion**: Returns only session token usage / context window. Does **not** include plan quotas (`limit5h`, `limit7d`, `monthTotal`, `extraUsage`).

### 2. Non-interactive prompt (`kimi -p "/usage" --output-format stream-json`)
- **Observed behavior**: `/usage` is treated as a regular user prompt and sent to the LLM (triggered tool calls to `check-kimi-code-docs` and replied that `/usage` is a TUI-only slash command).
- **Conclusion**: Disqualified — sends a model turn and cannot return live plan quotas.

### 3. Local managed service (`kimi web --port 0 --json` → `GET /api/v1/oauth/usage`)
- **Startup output** (`kimi web --port 0 --json`, single JSON line on stdout with ephemeral bearer token, `--no-open` implied, bound to `127.0.0.1`):
  ```json
  {
    "origin": "http://127.0.0.1:<ephemeral_port>",
    "ws_url": "ws://127.0.0.1:<ephemeral_port>/ws",
    "token": "<ephemeral_token>",
    "kimi_agent_protocol_version": "..."
  }
  ```
- **Observed `GET /api/v1/oauth/usage` response (HTTP 200, sanitized)**:
  ```json
  {
    "code": 0,
    "msg": "success",
    "data": {
      "kind": "ok",
      "quota": {
        "usages": {
          "limit5h": { "usedRatio": 0.0006, "resetAt": "2026-11-24T01:40:30Z" },
          "limit7d": { "usedRatio": 0.0289, "resetAt": "2026-11-30T02:40:30Z" }
        },
        "extraUsage": null
      }
    },
    "request_id": "<redacted>"
  }
  ```
- **Error envelope schema (inspected from `kimi` CLI `managedUsageResultSchema`)**:
  - `data.kind === "error"` with `message: string` and optional `status?: number`:
    - `status === 401`: `"Authorization failed. Please check your API key (try /login)."` → mapped to `login_required`.
    - `status === 404`: `"Usage endpoint not available. Try Kimi For Coding."` → mapped to `mode_not_supported` (non-Kimi For Coding account).
    - `status === 429`: rate limited → mapped to `rate_limited`.
- **Top-up pack schema (`boosterWalletInfoSchema`)**:
  - `balanceCents`, `totalCents`, `monthlyChargeLimitEnabled`, `monthlyChargeLimitCents`, `monthlyUsedCents`, `currency`.

## Decision

Use **Path 3 (`kimi web --port 0 --json` → `GET /api/v1/oauth/usage`)** as a bounded, short-lived loopback probe (killed immediately once the single HTTP read finishes):
- Sends **zero** model turns.
- TaroBird **never** reads, copies, or transmits Kimi's stored credentials; `kimi web` uses Kimi's own managed OAuth session internally.
- Account switches are detected via filesystem metadata (`statSync` on Kimi config/credential paths without reading credential bytes) so cached quotas are cleared immediately when the login changes.
