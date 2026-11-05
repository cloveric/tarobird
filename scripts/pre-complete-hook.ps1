$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

node scripts/check-git-identity.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/setup-privacy-hooks.mjs --check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/release-version.mjs check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/check-upload-privacy.mjs staged
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/check-secrets.mjs history
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Service-command tests require the compiled entrypoint on a fresh clone.
Write-Host "[pre-complete] running build..."
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[pre-complete] running test suite..."
npm test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[pre-complete] building desktop/mobile client..."
npm --prefix client run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[pre-complete] testing native desktop (including integration targets)..."
cargo test --locked --manifest-path client/src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[pre-complete] verification passed."
