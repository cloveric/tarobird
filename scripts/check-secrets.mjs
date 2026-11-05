import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lstatSync } from 'node:fs';

// One policy for POSIX hooks and PowerShell. Never emit raw scanner reports.
const policyRoot = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? 'history';
try {
  if (!['staged', 'history'].includes(mode) || process.argv.length > 3) throw new Error('Usage: node scripts/check-secrets.mjs [staged|history]');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // 8.30.1 auto-loads a worktree baseline even when ignore-path is /dev/null.
  // Also reject index-only files so a local deletion cannot hide a future bypass.
  const baseline = lstatSync(path.join(root, '.gitleaksignore'), { throwIfNoEntry: false });
  const indexedBaseline = execFileSync('git', ['ls-files', '--cached', '--', '.gitleaksignore'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (baseline || indexedBaseline) throw new Error('Repository .gitleaksignore baselines are forbidden; remove the file from the working tree and index.');
  const options = { cwd: root, stdio: 'inherit' };
  if (mode === 'history') execFileSync(process.execPath, [path.join(policyRoot, 'scripts/check-rewritten-history.mjs')], options);
  let version;
  try { version = execFileSync('gitleaks', ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('Gitleaks 8.30.1 is required; see docs/repository-privacy.md.'); }
  if (version !== '8.30.1') throw new Error('Use Gitleaks 8.30.1 so local and CI checks use the same rules.');
  execFileSync('gitleaks', ['git', ...(mode === 'staged' ? ['--pre-commit', '--staged'] : ['--log-opts=--all']),
    '--config', path.join(policyRoot, '.gitleaks.toml'), '--gitleaks-ignore-path', process.platform === 'win32' ? 'NUL' : '/dev/null',
    '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color', '--log-level', 'warn', '.'], options);
} catch (error) {
  // Subprocess checks print their own redacted errors; do not log their object.
  if (typeof error.status !== 'number') console.error(error.message);
  process.exitCode = typeof error.status === 'number' && error.status > 0 ? error.status : 2;
}
