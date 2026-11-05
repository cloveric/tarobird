import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { checkGitIdentity } from './check-git-identity.mjs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const root = git('rev-parse', '--show-toplevel');
  const expected = path.join(root, '.githooks');
  let current = ''; try { current = git('config', '--get', 'core.hooksPath'); } catch {}
  if (current && path.resolve(root, current) !== expected) throw new Error('An existing hooksPath needs review; refusing to replace unrelated hooks.');
  if (!current) {
    for (const hook of ['pre-commit', 'pre-push']) {
      if (existsSync(git('rev-parse', '--git-path', `hooks/${hook}`))) throw new Error('An existing Git hook needs review; refusing to bypass it.');
    }
  }
  checkGitIdentity();
  if (process.argv[2] === '--check') {
    if (!current) throw new Error('Privacy hooks are not installed; run npm run privacy:setup.');
  } else if (process.argv.length === 2) {
    for (const hook of ['pre-commit', 'pre-push']) chmodSync(path.join(expected, hook), 0o755);
    git('config', '--local', 'core.hooksPath', expected);
  } else throw new Error('Usage: setup-privacy-hooks.mjs [--check]');
  console.log('Repository privacy hooks and commit identity verified.');
} catch (error) {
  console.error(error.status !== undefined ? 'Could not verify local Git configuration.' : error.message); process.exitCode = 1;
}
