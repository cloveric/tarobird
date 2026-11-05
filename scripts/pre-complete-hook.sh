#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

node scripts/check-git-identity.mjs
node scripts/setup-privacy-hooks.mjs --check
node scripts/release-version.mjs check
node scripts/check-upload-privacy.mjs staged
node scripts/check-secrets.mjs history

# Host CLI tests launch the compiled entrypoint, including on a fresh clone.
echo "[pre-complete] running build..."
npm run build

echo "[pre-complete] running test suite..."
npm test

echo "[pre-complete] building desktop/mobile client..."
npm --prefix client run build

echo "[pre-complete] testing native desktop (including integration targets)..."
cargo test --locked --manifest-path client/src-tauri/Cargo.toml

echo "[pre-complete] verification passed."
