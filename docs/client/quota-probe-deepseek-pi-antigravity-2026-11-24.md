# Quota Probe: DeepSeek Harness, Pi, and Antigravity Local Server (2026-11-24)

Empirical probe results recorded before implementation (all account identifiers and tokens omitted).

## 1. DeepSeek Harness (`dsh 0.2.2-rc.5`)

- **Method**: Reused the private `dsh web --no-open --host 127.0.0.1 --port 0` server via `DeepSeekHarnessHost` (no credential files read or copied by TaroBird).
- **Verified RPC routes** (from `@deepseek-ai/dsh-deepseek-account` Typert remote catalog and live `dsh web` calls):
  - `account.getState` (`POST /api/account/getState`):
    ```json
    {
      "status": "signed-out",
      "attempt": null,
      "links": {
        "usageUrl": "https://platform.deepseek.com/usage",
        "topUpUrl": "https://platform.deepseek.com/top_up"
      }
    }
    ```
  - `account.getBalance` (`POST /api/account/getBalance`, payload `{ client: { version, locale, timezoneOffsetSeconds } }`):
    - When signed out: returns `null`.
    - When signed in (`status: "credential-stored"`): returns `AccountDetails['balance']`:
      ```json
      {
        "status": "ready",
        "value": [{ "currency": "CNY", "balance": "12.50" }],
        "bonusWallets": [{ "currency": "CNY", "balance": "0E-16" }]
      }
      ```
      or `{ "status": "failed" }`.
- **Conclusion**: Supported directly through the existing private `dsh web` transport. Recharge (`value`) and bonus (`bonusWallets`) wallets map cleanly to `QuotaBalance` entries (`kind: "currency"`).

## 2. Pi (`pi 1.6.0`)

- **Method**: Inspected `pi --help`, Pi 1.6.0 bundle, and `src/codex/pi-rpc-protocol.ts`.
- **Findings**:
  - `pi --mode rpc` exposes `get_state`, `get_session_stats`, `get_available_models`, `get_commands`, etc.
  - `get_session_stats` reports only local session token counts and per-session estimated cost, not upstream provider account quotas.
  - No provider quota RPC or CLI command exists in Pi 1.6.0.
- **Conclusion**: Wire `PiRpcAdapter.getAccountQuota` to return `state: "unsupported", reason: "mode_not_supported"` and display a clear message ("This provider does not provide account quotas") instead of "Not yet implemented".

## 3. Antigravity Local Language Server (`agy 1.5.15`)

- **Reference**: `getagentseal/codeburn` (MIT), `app/electron/quota/antigravity.ts`.
- **Method**: Inspected running `agy acp` processes via `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` and sent Connect-RPC JSON `POST` requests to loopback `127.0.0.1:<port>` (no new `agy` process spawned, no credentials read).
- **Verified live response** from `POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary` (HTTP 200, `< 10ms`, no CSRF required for `agy` CLI embedded server):
  ```json
  {
    "response": {
      "groups": [
        {
          "displayName": "Gemini Models",
          "description": "Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash",
          "buckets": [
            { "bucketId": "gemini-weekly", "displayName": "Weekly Limit Remaining", "remainingFraction": 0.8279316, "resetTime": "2026-11-30T22:28:38Z" },
            { "bucketId": "gemini-5h", "displayName": "Five Hour Limit Remaining", "remainingFraction": 0.34799987, "resetTime": "2026-11-24T03:28:38Z" }
          ]
        },
        {
          "displayName": "Claude and GPT models",
          "description": "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
          "buckets": [
            { "bucketId": "3p-weekly", "displayName": "Weekly Limit Remaining", "remainingFraction": 0.9992052, "resetTime": "2026-11-29T01:21:17Z" },
            { "bucketId": "3p-5h", "displayName": "Five Hour Limit Remaining", "remainingFraction": 1, "resetTime": "2026-11-24T05:00:01Z" }
          ]
        }
      ]
    }
  }
  ```
- **Conclusion**: Matches `agy -p /usage --output-format json` groups, model lists, remaining fractions, and reset times exactly, without spawning any extra `agy` process. Query running `agy acp` PIDs and local Antigravity language server first, keeping `agy -p /usage --output-format json` as fallback when no local server is running.
