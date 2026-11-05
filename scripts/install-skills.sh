#!/usr/bin/env bash
# Install selected repository skills and their references. Discovery is engine-
# and session-dependent; copying metadata does not prove a skill was executed.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
selected=()
destinations=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skill) selected+=("${2:?--skill requires a directory name}"); shift 2 ;;
    --destination) destinations+=("${2:?--destination requires a skills directory}"); shift 2 ;;
    *) echo "Usage: $0 [--skill NAME ...] [--destination SKILLS_DIR ...]" >&2; exit 2 ;;
  esac
done
if [ "${#destinations[@]}" -eq 0 ]; then destinations=("$HOME/.claude/skills" "${CODEX_HOME:-$HOME/.codex}/skills" "$HOME/.agents/skills"); fi
shopt -s nullglob
if [ "${#selected[@]}" -eq 0 ]; then
  for directory in "$REPO_DIR"/skills/*/; do [ ! -f "${directory}SKILL.md" ] || selected+=("$(basename "$directory")"); done
fi
for name in "${selected[@]}"; do
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] && [ -f "$REPO_DIR/skills/$name/SKILL.md" ] || { echo "Unknown skill: $name" >&2; exit 2; }
done
for name in "${selected[@]}"; do
  for destination in "${destinations[@]}"; do
    mkdir -p "$destination/$name"
    cp -R "$REPO_DIR/skills/$name/." "$destination/$name/"
  done
  echo "[skills] installed $name (including references)"
done
echo "[skills] Existing sessions may need their skill catalog refreshed by the engine. This does not change models or restart sessions."
