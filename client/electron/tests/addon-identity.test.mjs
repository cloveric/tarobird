import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeMacAddonIdentity } from '../../scripts/macos-addon-identity.mjs';

test('Darwin addon removes absolute install name before signing', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'addon-identity-'));
  try {
    const source = path.join(directory, 'addon.c'), addon = path.join(directory, 'addon.node');
    writeFileSync(source, 'int addon_identity_fixture(void) { return 1; }\n');
    execFileSync('cc', ['-dynamiclib', source, '-o', addon, '-Wl,-install_name,' + addon]);
    assert.ok(readFileSync(addon).includes(Buffer.from(addon)), 'fixture must reproduce absolute build identity');
    normalizeMacAddonIdentity(addon);
    assert.ok(!readFileSync(addon).includes(Buffer.from(directory)), 'build directory must be absent');
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', addon], { stdio: 'pipe' });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', addon], { stdio: 'pipe' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
