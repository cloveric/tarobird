import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function privateCommitIdentity(ident) {
  const match = /^([^<>\r\n]+) <([^<>\s]+)> \d+ [+-]\d{4}$/.exec(ident.trim());
  return Boolean(match && !/\.local\b/i.test(match[1])
    && /^[a-z0-9+._-]+@users\.noreply\.github\.com$/i.test(match[2]));
}

export function checkGitIdentity() {
  for (const role of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    let ident;
    try { ident = execFileSync('git', ['var', role], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new Error(`${role}: configure your repository-local name and GitHub noreply email. See docs/repository-privacy.md.`); }
    if (!privateCommitIdentity(ident)) {
      // Never echo the rejected address or local machine name into shared logs.
      throw new Error(`${role}: use your GitHub noreply email and a display name without a local hostname. See docs/repository-privacy.md.`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { checkGitIdentity(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
