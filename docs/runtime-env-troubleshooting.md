# Runtime Env Troubleshooting

When Claude, Codex, or DeepSeek Harness works in your shell but a bot instance fails, treat it as a runtime environment mismatch first.

## Shared Engine Env Rules

- Do not inject default `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `DSH_HOME` values.
- Only forward `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `DSH_HOME` when the user explicitly exported them.
- A shell export does not change an already running desktop Host. Inspect the
  affected Bot environment and update it through the current Host/App configuration;
  restart only that Bot once idle. See [Host CLI](host-cli.md).
- DeepSeek gets a private writable home under the instance state directory, but its authenticated credentials/profiles are sourced from the selected `DSH_HOME`.

## Debugging Order

1. Check the real shell behavior first.
   - `claude auth status`
   - `claude -p "reply with exactly OK and nothing else"`
   - `codex --version`
   - `dsh --version`
2. Run `tarobot doctor` for the selected Host and inspect the affected Bot
   diagnostics in the App. Compare the actual engine executable and explicitly
   configured engine-home values with the working shell.
3. Run `npm run smoke:claude-auth` from the same shell.
   - This checks both the current shell and a minimal bot-style environment.
4. Only after the real runtime checks pass should you start building smaller reproductions.

## Retired fleet services

The old transport/fleet CLI and its launchd cleanup script are no longer part of
TaroBot. This source cleanup does not disable installed services or delete user
state. If an old service is still installed, identify its owner and data before
any separate removal. Use the current [Host CLI](host-cli.md) for App/CLI service
operations; do not follow archived Telegram/Lark fleet commands.
