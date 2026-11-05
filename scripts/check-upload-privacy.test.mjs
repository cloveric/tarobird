import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { privacyKinds } from './check-upload-privacy.mjs';
import { versionFiles } from './release-version.mjs';
const script = fileURLToPath(new URL('./check-upload-privacy.mjs', import.meta.url));
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'upload-privacy-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = () => { git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'synthetic fixture'); return git('rev-parse', 'HEAD'); };
  const scan = (base, head) => spawnSync(process.execPath, [script, 'range', base, head], { cwd: root, encoding: 'utf8' });
  try {
    git('init', '-q'); git('config', 'user.name', 'Example'); git('config', 'user.email', '123+example@users.noreply.github.com');
    const source = fileURLToPath(new URL('../', import.meta.url));
    const manifest = JSON.parse(readFileSync(join(source, 'release-version.json')));
    for (const file of ['release-version.json', ...versionFiles(source, manifest).keys()]) {
      mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(join(source, file), join(root, file));
    }
    writeFileSync(join(root, 'README.md'), 'synthetic baseline'); const base = commit();
    fn({ root, git, commit, scan, base });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('literal private home/device/email markers are detected without printing their value', () => {
  const name = ['private', 'person'].join('-');
  for (const text of [`/Users/${name}/data`, `C:\\Users\\${name}\\data`, `${name}.local`, `${name}@gmail.com`, `host.${name}.ts.net`]) assert.ok(privacyKinds(text).length);
  for (const text of ['/Users/example/project', '/home/runner/work', '/home/node/app', '.env.local', 'example.local', '127.0.0.1']) assert.deepEqual(privacyKinds(text), []);
});
test('reviewed public text is bound to its exact path, file bytes and match', () => fixture(({ root, git, commit, scan, base }) => {
  const email = ['public-fixture', 'gmail.com'].join('@');
  const bytes = `Copyright Example Author <${email}>\n`;
  const fingerprint = value => createHash('sha256').update(value).digest('hex');
  writeFileSync(join(root, 'LICENSE.txt'), bytes);
  writeFileSync(join(root, '.privacy-reviewed-text.json'), JSON.stringify({ format: 1, entries: [{
    path: 'LICENSE.txt', sha256: fingerprint(bytes), reviewer: 'example',
    note: 'Public synthetic copyright fixture; required attribution is not owner data.',
    findings: [{ kind: 'personal-email', fingerprint: fingerprint(email) }],
  }] }));
  const approved = commit();
  assert.equal(scan(base, approved).status, 0);
  writeFileSync(join(root, 'copy.txt'), bytes); let head = commit();
  assert.equal(scan(approved, head).status, 1, 'another path is not covered');
  git('reset', '--hard', approved);
  writeFileSync(join(root, 'LICENSE.txt'), bytes + 'Additional content\n'); head = commit();
  assert.equal(scan(approved, head).status, 1, 'modified file requires fresh review');
  git('reset', '--hard', approved);
  const extra = bytes + '/Users/' + ['private', 'person'].join('-') + '/data';
  writeFileSync(join(root, 'LICENSE.txt'), extra);
  const review = JSON.parse(readFileSync(join(root, '.privacy-reviewed-text.json')));
  review.entries[0].sha256 = fingerprint(extra);
  writeFileSync(join(root, '.privacy-reviewed-text.json'), JSON.stringify(review)); head = commit();
  assert.equal(scan(approved, head).status, 1, 'updating the file hash does not approve another match');
}));
test('pushing a previously committed personal identity fails despite safe current config', () => fixture(({ root, git, commit, scan, base }) => {
  git('config', 'user.email', 'synthetic@example.com'); writeFileSync(join(root, 'file.txt'), 'clean'); const head = commit();
  git('config', 'user.email', '123+example@users.noreply.github.com');
  const result = scan(base, head); assert.equal(result.status, 1); assert.match(result.stderr, /private-commit-identity/); assert.doesNotMatch(result.stderr, /synthetic@example/);
}));
test('intermediate data deleted before the final tree is still blocked', () => fixture(({ root, git, commit, scan, base }) => {
  const name = ['private', 'person'].join('-');
  writeFileSync(join(root, 'leak.txt'), `/Users/${name}/data`); commit(); git('rm', 'leak.txt'); const head = commit();
  const result = scan(base, head); assert.equal(result.status, 1); assert.match(result.stderr, /personal-home-path/); assert.equal(result.stderr.includes(name), false);
}));
test('media approval is bound to exact bytes and path, not a directory-wide waiver', () => fixture(({ root, commit, scan, base }) => {
  const bytes = Buffer.from('synthetic media'); writeFileSync(join(root, 'image.png'), bytes); let head = commit();
  assert.equal(scan(base, head).status, 1);
  writeFileSync(join(root, '.privacy-reviewed-media.json'), JSON.stringify({ format: 1, entries: [{ path: 'image.png', sha256: createHash('sha256').update(bytes).digest('hex'), reviewer: 'example', method: 'visual-review', note: 'Reviewed synthetic fixture only.' }] })); head = commit();
  assert.equal(scan(base, head).status, 0);
  writeFileSync(join(root, 'image.png'), 'changed bytes'); head = commit(); assert.equal(scan(base, head).status, 1);
}));
test('audio, Office documents, fonts and Java archives require byte-specific review', () => fixture(({ root, commit, scan, base }) => {
  const extensions = ['m4a', 'mp3', 'wav', 'ogg', 'flac', 'docx', 'xlsx', 'pptx', 'woff2', 'ttf', 'jar'];
  const bytes = Buffer.from('synthetic binary fixture');
  for (const extension of extensions) writeFileSync(join(root, `fixture.${extension}`), bytes);
  const head = commit();
  const result = scan(base, head);
  assert.equal(result.status, 1);
  assert.equal((result.stderr.match(/media-review-required/g) ?? []).length, extensions.length);
}));
test('pre-push scans each ref and detects a new PR branch against live main', () => fixture(({ root, git, commit, base }) => {
  git('branch', '-M', 'main'); const remote = join(root, 'remote.git'); git('init', '--bare', '-q', remote); git('remote', 'add', 'test-remote', remote); git('push', '-q', 'test-remote', 'main');
  writeFileSync(join(root, 'file.txt'), 'safe'); const safe = commit();
  git('config', 'user.email', 'synthetic@example.com'); writeFileSync(join(root, 'file.txt'), 'changed'); const unsafe = commit();
  const input = `refs/heads/a ${safe} refs/heads/a ${base}\nrefs/heads/b ${unsafe} refs/heads/b ${'0'.repeat(40)}\n`;
  const result = spawnSync(process.execPath, [script, 'pre-push', 'test-remote'], { cwd: root, input, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /private-commit-identity/);
}));
test('JS local properties and browser versions are not hostnames or deployment IPs', () => {
  for (const text of [...['state', 'view', 'target', 'this'].map(name => `${name}.local`), 'Chrome/136.0.0.0']) assert.deepEqual(privacyKinds(text), []);
  assert.ok(privacyKinds(`https://${['private', 'machine'].join('')}.local/`).length);
  assert.ok(privacyKinds(['45', '67', '89', '10'].join('.')).includes('non-example-public-ip'));
});
test('version gate reads staged bytes even if the working file has been repaired', () => fixture(({ root, git }) => {
  const file = join(root, 'package.json'), original = readFileSync(file, 'utf8');
  const value = JSON.parse(original); value.version = '0.1.999'; writeFileSync(file, JSON.stringify(value)); git('add', 'package.json');
  writeFileSync(file, original);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./release-version.mjs', import.meta.url)), 'git', 'INDEX'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /version drift/);
}));
