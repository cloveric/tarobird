#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
asr_python="${PYTHON_BIN:-}"
if [[ -z "$asr_python" ]]; then
  asr_python="$(command -v python3.12 || command -v python3 || true)"
fi
[[ -n "$asr_python" ]] || { printf 'TAROBOT_ASR_ERROR=python_312_required\n' >&2; exit 1; }
exec "$asr_python" "$script_dir/qwen-asr-install.py" "$@"
