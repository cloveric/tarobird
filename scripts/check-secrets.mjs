import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';

// One policy for POSIX hooks and PowerShell. Never emit raw scanner reports.
const policyRoot = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? 'history';
const usage = 'Usage: node scripts/check-secrets.mjs [staged|history|pre-push <remote>]';

// `pre-push` reads Git's hook lines and scans only the commits being uploaded:
// everything after the remote's current tip, or after the remote's live main for
// a branch the remote does not have yet. `history` stays the all-refs scan.
function outgoingRanges(root, remote) {
  const quiet = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  const zero = sha => /^0+$/.test(sha);
  const known = sha => { try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], quiet); return true; } catch { return false; } };
  let liveMain;
  const mainTip = () => {
    if (liveMain === undefined) {
      try { liveMain = execFileSync('git', ['ls-remote', '--heads', remote, 'refs/heads/main'], quiet).trim().split(/\s+/)[0] ?? ''; }
      catch { liveMain = ''; }
    }
    return liveMain && known(liveMain) ? liveMain : undefined;
  };
  const ranges = [];
  for (const line of readFileSync(0, 'utf8').split('\n').filter(row => row.trim())) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !remoteRef || !/^[0-9a-f]{40,64}$/.test(localSha ?? '') || !/^[0-9a-f]{40,64}$/.test(remoteSha ?? '')) throw new Error('Malformed pre-push input.');
    if (zero(localSha)) continue; // Deletion uploads no content.
    // A remote tip this clone has never fetched cannot bound the range; fall back
    // to the live main, then to the whole ancestry of what is being pushed.
    const base = !zero(remoteSha) && known(remoteSha) ? remoteSha : mainTip();
    ranges.push(base ? `${base}..${localSha}` : localSha);
  }
  return ranges;
}

try {
  const prePush = mode === 'pre-push';
  if (!['staged', 'history', 'pre-push'].includes(mode) || process.argv.length !== (prePush ? 4 : Math.min(process.argv.length, 3))) throw new Error(usage);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // 8.30.1 auto-loads a worktree baseline even when ignore-path is /dev/null.
  // Also reject index-only files so a local deletion cannot hide a future bypass.
  const baseline = lstatSync(path.join(root, '.gitleaksignore'), { throwIfNoEntry: false });
  const indexedBaseline = execFileSync('git', ['ls-files', '--cached', '--', '.gitleaksignore'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (baseline || indexedBaseline) throw new Error('Repository .gitleaksignore baselines are forbidden; remove the file from the working tree and index.');
  const options = { cwd: root, stdio: 'inherit' };
  const ranges = prePush ? outgoingRanges(root, process.argv[3]) : undefined;
  if (mode !== 'staged') execFileSync(process.execPath, [path.join(policyRoot, 'scripts/check-rewritten-history.mjs')], options);
  let version;
  try { version = execFileSync('gitleaks', ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('Gitleaks 8.30.1 is required; see docs/repository-privacy.md.'); }
  if (version !== '8.30.1') throw new Error('Use Gitleaks 8.30.1 so local and CI checks use the same rules.');
  const scans = mode === 'staged' ? [['--pre-commit', '--staged']] : (ranges ?? ['--all']).map(range => [`--log-opts=${range}`]);
  for (const scope of scans) execFileSync('gitleaks', ['git', ...scope,
    '--config', path.join(policyRoot, '.gitleaks.toml'), '--gitleaks-ignore-path', process.platform === 'win32' ? 'NUL' : '/dev/null',
    '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color', '--log-level', 'warn', '.'], options);
} catch (error) {
  // Subprocess checks print their own redacted errors; do not log their object.
  if (typeof error.status !== 'number') console.error(error.message);
  process.exitCode = typeof error.status === 'number' && error.status > 0 ? error.status : 2;
}
