#!/usr/bin/env bash
set -euo pipefail
policy_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$policy_root/scripts/check-secrets.mjs" "$@"
