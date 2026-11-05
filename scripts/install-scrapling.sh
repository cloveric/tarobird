#!/usr/bin/env bash
# Install the Scrapling web-scraping skill for TaroBot's Claude + Codex bots.
#
# Scrapling is an anti-bot scraper (Cloudflare/Turnstile bypass, stealth + JS-render
# + spider). It is wired as a CLI SKILL, NOT an MCP: a Python venv, a PATH symlink,
# and a SKILL.md copied into the USER-LEVEL Claude and Codex skill dirs — so every
# bot, including newly-created instances, inherits it with zero per-instance setup.
#
# Idempotent; re-running upgrades an existing venv to the reviewed runtime.
# Keep this version aligned with skills/scrapling/SKILL.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Reuse an existing legacy installation; new installations use product data.
legacy_venv="$HOME/projects/scrapling-mcp/venv"
if [ -n "${SCRAPLING_VENV:-}" ]; then
  VENV="$SCRAPLING_VENV"
elif [ -x "$legacy_venv/bin/python" ]; then
  VENV="$legacy_venv"
else
  VENV="$HOME/.tarobot/tools/scrapling/venv"
fi
# Directory on the bots' PATH to symlink `scrapling` into. Honor an explicit override,
# else pick the first existing + writable of: Homebrew (Apple Silicon), /usr/local/bin
# (Intel / older Homebrew), then ~/.local/bin as a no-permission fallback.
BIN_DIR="${SCRAPLING_BIN_DIR:-}"
if [ -z "$BIN_DIR" ]; then
  for candidate in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then BIN_DIR="$candidate"; break; fi
  done
  BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
fi

# Scrapling 0.5 requires Python 3.10+. Check before changing anything; macOS's
# bundled python3 may be older. SCRAPLING_PYTHON selects another interpreter.
PYTHON="${SCRAPLING_PYTHON:-python3}"
require_python() {
  local version
  version="$("$1" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null)" || version=""
  if [[ "$version" =~ ^([0-9]+)\.([0-9]+) ]] && { [ "${BASH_REMATCH[1]}" -gt 3 ] || { [ "${BASH_REMATCH[1]}" -eq 3 ] && [ "${BASH_REMATCH[2]}" -ge 10 ]; }; }; then return 0; fi
  echo "[scrapling] Scrapling 0.5 needs Python 3.10+ (found ${version:-none} at $1). Install a newer Python, then rerun with SCRAPLING_PYTHON=/path/to/python3 (an existing venv must be recreated)." >&2
  exit 1
}

echo "[scrapling] venv: $VENV"
if [ -x "$VENV/bin/python" ]; then require_python "$VENV/bin/python"; else require_python "$PYTHON"; "$PYTHON" -m venv "$VENV"; fi
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q --upgrade "scrapling[fetchers]==0.5"
"$VENV/bin/python" -c 'from importlib.metadata import version; print("[scrapling] runtime:", version("scrapling"))'
# From here the runtime is 0.5; this installer does not roll it back. Install the matching
# CLI link and Skill before the optional browser step so a browser failure never
# leaves an older Skill describing commands this runtime removed.

echo "[scrapling] symlinking 'scrapling' into $BIN_DIR"
mkdir -p "$BIN_DIR"
ln -sf "$VENV/bin/scrapling" "$BIN_DIR/scrapling"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "[scrapling] NOTE: $BIN_DIR is not on PATH — add it (e.g. in ~/.zshrc) so 'scrapling' resolves" ;;
esac

echo "[scrapling] installing the skill for Claude + Codex"
for dir in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/scrapling" "${CODEX_HOME:-$HOME/.codex}/skills/scrapling"; do
  mkdir -p "$dir"
  cp "$REPO_DIR/skills/scrapling/SKILL.md" "$dir/SKILL.md"
done

# Scrapling 0.5 browser fetching uses Patchright Chromium. HTTP `get` works without it.
if ! "$VENV/bin/scrapling" install; then
  echo "[scrapling] Browser setup failed. Runtime and Skill are 0.5; HTTP fetching does not require browser setup. Rerun this installer before using browser fetches." >&2
  exit 1
fi

echo "[scrapling] done. Verify: scrapling extract get https://example.com /tmp/t.md && head /tmp/t.md"
