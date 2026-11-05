// Source and build identity recorded in README capture manifests. A capture
// from uncommitted work is marked dirty; index and entry hashes pin the build.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function captureProvenance(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const dist = path.join(root, 'client/dist');
  const index = await readFile(path.join(dist, 'index.html'));
  const file = index.toString('utf8').match(/<script[^>]+src="\/([^"]+\.js)"/)?.[1];
  if (!file) throw new Error('Built client entry script not found');
  const sha256 = data => createHash('sha256').update(data).digest('hex');
  return {
    sourceRevision: git('rev-parse', 'HEAD'),
    sourceDirty: git('status', '--porcelain').length > 0,
    // index.html names the content-hashed entry, CSS and preloads; together they pin the build.
    clientEntry: { file, sha256: sha256(await readFile(path.join(dist, file))), indexSha256: sha256(index) },
  };
}
