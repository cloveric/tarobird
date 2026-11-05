import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { privateCommitIdentity } from './check-git-identity.mjs';

for (const [editor, asset, symbol] of [
  ['baoyu-design', 'index-DyKwtQBI.js', 'J'],
  ['baoyu-slides', 'index-S9woRl4b.js', 'te'],
  ['baoyu-design', 'index-CYLuwRoc.js', 'J'],
  ['baoyu-slides', 'index-7OEzB54c.js', 'te'],
]) test(`${editor}/${asset} shortcut expression exception requires exact JavaScript syntax and exact asset path`, () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-design-'));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const file = `client/vendor/${editor}/editor/assets/${asset}`;
  const shortcut = `${symbol}.shortcut`;
  const expression = `const button={"aria-keyshortcuts":${shortcut}===void 0?void 0:parseShortcut(${shortcut})};\n`;
  try {
    copyFileSync(join(source, '.gitleaks.toml'), join(root, '.gitleaks.toml'));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    mkdirSync(join(root, `client/vendor/${editor}/editor/assets`), { recursive: true });
    const scan = () => spawnSync('gitleaks', ['git', '--pre-commit', '--staged', '--config', '.gitleaks.toml', '--gitleaks-ignore-path', '/dev/null', '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--log-level', 'error', '.'], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(root, file), expression); git('add', '.');
    assert.equal(scan().status, 0, 'the reviewed shortcut expression is not a credential');
    writeFileSync(join(root, 'other.js'), expression); git('add', 'other.js');
    assert.equal(scan().status, 1, 'the exception must not extend to other paths');
    git('rm', '--cached', 'other.js');
    const fake = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    for (const text of [expression.replace(shortcut, 'K.shortcut'), expression + `const apiKey="${fake}";\n`, `const apiKey="${shortcut}===void";\n`]) {
      writeFileSync(join(root, file), text); git('add', file);
      const result = scan();
      assert.equal(result.status, 1, 'different syntax and credentials in the same file remain scanned');
      assert.equal((result.stdout + result.stderr).includes(fake), false);
    }
    writeFileSync(join(root, file), expression); git('add', file);
    mkdirSync(join(root, 'scripts'));
    const regression = 'scripts/privacy-guards.node-test.mjs';
    writeFileSync(join(root, regression), expression + `const apiKey="${shortcut}===void";\n`); git('add', regression);
    assert.equal(scan().status, 0, 'the regression source contains these same reviewed non-credentials');
    writeFileSync(join(root, regression), `const apiKey="${fake}";\n`); git('add', regression);
    assert.equal(scan().status, 1, 'other credentials in regression source remain detected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Slides compiler modifier-key identifier exception requires exact syntax and path', () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-slides-compiler-'));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const file = 'client/vendor/baoyu-slides/editor/node/compiler.cjs';
  const identifier = ['MODIFIER', 'KEYS2'].join('_');
  // Match the upstream multiline property exactly; a trailing space belongs to
  // the scanner match and intentionally does not get the same exception.
  const expression = `const event = {\n  modifierKeys: ${identifier}\n};\n`;
  try {
    copyFileSync(join(source, '.gitleaks.toml'), join(root, '.gitleaks.toml'));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q'); mkdirSync(join(root, 'client/vendor/baoyu-slides/editor/node'), { recursive: true });
    const scan = () => spawnSync('gitleaks', ['git', '--pre-commit', '--staged', '--config', '.gitleaks.toml', '--gitleaks-ignore-path', '/dev/null', '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--log-level', 'error', '.'], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(root, file), expression); git('add', '.');
    assert.equal(scan().status, 0, 'the reviewed modifier-key identifier is not a credential');
    writeFileSync(join(root, 'other.js'), expression); git('add', 'other.js');
    assert.equal(scan().status, 1, 'the exception must not extend to other paths');
    git('rm', '--cached', 'other.js');
    const fake = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    for (const value of [expression.replace(identifier, identifier.replace('2', '3')), expression.replace(identifier, `"${identifier}"`), expression + `const apiKey="${fake}";\n`]) {
      writeFileSync(join(root, file), value); git('add', file);
      const result = scan(); assert.equal(result.status, 1, 'changed syntax and credentials remain scanned');
      assert.equal((result.stdout + result.stderr).includes(fake), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('commit identity accepts noreply and rejects personal email or local hostnames', () => {
  assert.equal(privateCommitIdentity('Contributor <123+contributor@users.noreply.github.com> 1700000000 +0000'), true);
  assert.equal(privateCommitIdentity('Contributor <contributor@users.noreply.github.com> 1700000000 +0000'), true);
  assert.equal(privateCommitIdentity('Contributor <person@example.com> 1700000000 +0000'), false);
  assert.equal(privateCommitIdentity('workstation.local <contributor@users.noreply.github.com> 1700000000 +0000'), false);
  assert.equal(privateCommitIdentity('invalid'), false);
});

test('staged scanning catches secrets even when the working copy was cleaned; public key stays allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-guard-'));
  const source = fileURLToPath(new URL('../', import.meta.url));
  try {
    mkdirSync(join(root, 'scripts'));
    for (const file of ['.gitleaks.toml', 'scripts/check-secrets.sh', 'scripts/check-secrets.mjs', 'scripts/check-git-identity.mjs', 'scripts/check-rewritten-history.mjs', 'scripts/retired-history-fingerprints.json']) copyFileSync(join(source, file), join(root, file));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.name', 'Example'); git('config', 'user.email', '123+example@users.noreply.github.com');
    const scan = mode => spawnSync('bash', ['scripts/check-secrets.sh', mode], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(root, 'fixture.ts'), 'const publicKey = "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";\n');
    git('add', '.');
    assert.equal(scan('staged').status, 0);
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'public fixture');
    // Generated test data, not a usable service credential. Do not print it.
    const fake = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    writeFileSync(join(root, 'probe.txt'), `token=${fake} # gitleaks:allow\n`);
    git('add', 'probe.txt');
    writeFileSync(join(root, 'probe.txt'), 'clean working copy\n');
    const blocked = scan('staged');
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.equal((blocked.stdout + blocked.stderr).includes(fake), false);
    git('add', 'probe.txt');
    assert.equal(scan('staged').status, 0);
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'safe content');
    assert.equal(scan('history').status, 0);
    writeFileSync(join(root, 'probe.txt'), `token=${fake}\n`);
    git('add', 'probe.txt');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'synthetic detection fixture');
    const fixtureCommit = git('rev-parse', 'HEAD').toString().trim();
    writeFileSync(join(root, 'probe.txt'), 'clean again\n');
    git('add', 'probe.txt');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'remove synthetic detection fixture');
    const historical = scan('history');
    assert.equal(historical.status, 1, historical.stderr);
    assert.equal((historical.stdout + historical.stderr).includes(fake), false);
    // Gitleaks 8.30.1 still auto-loads the worktree baseline even with the
    // explicit null ignore path. A fingerprint must never hide this finding.
    writeFileSync(join(root, '.gitleaksignore'), `${fixtureCommit}:probe.txt:github-pat:1\n`);
    for (const mode of ['history', 'staged']) {
      const baseline = scan(mode);
      assert.equal(baseline.status, 2, `${mode}: ${baseline.stderr}`);
      assert.match(baseline.stderr, /\.gitleaksignore/);
      assert.equal((baseline.stdout + baseline.stderr).includes(fake), false);
    }
    git('add', '.gitleaksignore');
    rmSync(join(root, '.gitleaksignore'));
    for (const mode of ['history', 'staged']) assert.equal(scan(mode).status, 2, 'an index-only baseline is forbidden too');
    git('reset', '--', '.gitleaksignore');
    assert.equal(scan('history').status, 1, 'history is still scanned after removing the forbidden baseline');
    const identity = spawnSync(process.execPath, ['scripts/check-git-identity.mjs'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_EMAIL: 'person@example.com' },
    });
    assert.equal(identity.status, 1);
    assert.equal((identity.stdout + identity.stderr).includes('person@example.com'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('historical pairing header exception requires both the exact public header and exact path', () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-pairing-'));
  const source = fileURLToPath(new URL('../', import.meta.url));
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'tests'));
    for (const file of ['.gitleaks.toml', 'scripts/check-secrets.mjs', 'scripts/check-rewritten-history.mjs', 'scripts/retired-history-fingerprints.json']) copyFileSync(join(source, file), join(root, file));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.name', 'Example'); git('config', 'user.email', '123+example@users.noreply.github.com');
    const scan = mode => spawnSync(process.execPath, ['scripts/check-secrets.mjs', mode], { cwd: root, encoding: 'utf8' });
    const file = 'tests/client-pairing-qr.test.ts';
    const header = 'MCowBQYDK2VwAyEA';
    const line = `const key = "${header}" + "A".repeat(43) + "=";\n`;
    writeFileSync(join(root, file), line); git('add', '.');
    assert.equal(scan('staged').status, 0);
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'synthetic public header');
    assert.equal(scan('history').status, 0);
    const fake = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    for (const text of [line.replace(header, header.slice(0, -1) + 'B'), `const token = "${fake}";\n`]) {
      writeFileSync(join(root, file), text); git('add', file);
      const result = scan('staged');
      assert.equal(result.status, 1, result.stderr);
      assert.equal((result.stdout + result.stderr).includes(fake), false);
      git('restore', '--source=HEAD', '--staged', '--worktree', file);
    }
    writeFileSync(join(root, 'different-path.ts'), line); git('add', 'different-path.ts');
    assert.equal(scan('staged').status, 1, 'the same header outside the exact fixture remains detected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('history guard rejects retired ancestry, including a tag, but allows clean replacements', () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-history-'));
  const source = fileURLToPath(new URL('./', import.meta.url));
  try {
    copyFileSync(join(source, 'check-rewritten-history.mjs'), join(root, 'check-rewritten-history.mjs'));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.name', 'Example'); git('config', 'user.email', '123+example@users.noreply.github.com');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'retired fixture');
    const retired = git('rev-parse', 'HEAD').toString().trim();
    writeFileSync(join(root, 'retired-history-fingerprints.json'), JSON.stringify([createHash('sha256').update(retired).digest('hex')]));
    const check = () => spawnSync(process.execPath, ['check-rewritten-history.mjs'], { cwd: root, encoding: 'utf8' });
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'apparently clean child');
    const blocked = check();
    assert.equal(blocked.status, 1);
    assert.equal((blocked.stdout + blocked.stderr).includes(retired), false);
    git('tag', 'retired-copy', retired);
    git('checkout', '--orphan', 'rewritten');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'clean replacement');
    for (const branch of git('for-each-ref', '--format=%(refname:short)', 'refs/heads').toString().trim().split('\n')) {
      if (branch !== 'rewritten') git('branch', '-D', branch);
    }
    assert.equal(check().status, 1, 'old tag must not reintroduce retired history');
    git('tag', '-d', 'retired-copy');
    assert.equal(check().status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public upstream worker key exception is limited to exact bytes and path', () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-worker-'));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const file = 'client/vendor/baoyu-design/editor/artifact-type/fast-edit-worker.js';
  const publicKey = readFileSync(join(source, file), 'utf8').match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/)[0];
  assert.equal(createHash('sha256').update(publicKey).digest('hex'), '7f7f8c83ded111336dca167452776b8b6c35e4223882103df5edeb55875a2d41');
  try {
    copyFileSync(join(source, '.gitleaks.toml'), join(root, '.gitleaks.toml'));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    mkdirSync(join(root, 'client/vendor/baoyu-design/editor/artifact-type'), { recursive: true });
    const scan = () => spawnSync('gitleaks', ['git', '--pre-commit', '--staged', '--config', '.gitleaks.toml', '--gitleaks-ignore-path', '/dev/null', '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--log-level', 'error', '.'], { cwd: root, encoding: 'utf8' });
    const check = expected => {
      const result = scan();
      assert.equal(result.status, expected, result.stderr);
      assert.equal((result.stdout + result.stderr).includes(publicKey), false);
    };
    writeFileSync(join(root, file), publicKey); git('add', file); check(0);
    writeFileSync(join(root, file), publicKey.replace(/\n([A-Za-z])/, (_, first) => '\n' + (first === 'A' ? 'B' : 'A')));
    git('add', file); check(1);
    writeFileSync(join(root, file), publicKey); git('add', file);
    writeFileSync(join(root, 'another.js'), publicKey); git('add', 'another.js'); check(1);
    git('rm', '--cached', 'another.js');
    const fake = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    writeFileSync(join(root, file), publicKey + '\nconst token = "' + fake + '";\n');
    git('add', file); check(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
