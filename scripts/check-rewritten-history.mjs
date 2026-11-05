import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkRewrittenHistory() {
  const retired = new Set(JSON.parse(readFileSync(new URL('./retired-history-fingerprints.json', import.meta.url), 'utf8')));
  // Include detached HEAD as well as local branches, tags and fetched refs.
  const commits = execFileSync('git', ['rev-list', '--all', 'HEAD'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  }).trim().split('\n');
  if (commits.some(commit => retired.has(createHash('sha256').update(commit).digest('hex')))) {
    throw new Error('Pre-cleanup history is reachable. Use a clean checkout or rebase local work onto the rewritten history; do not merge an old clone. See docs/repository-privacy.md.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { checkRewrittenHistory(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
