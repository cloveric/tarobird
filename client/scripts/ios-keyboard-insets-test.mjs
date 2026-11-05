import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pure geometry/timing tests use the production Swift file on macOS. The App's
// UIKit/WebKit implementation is compiled separately by the iOS build gate.
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(process.env.TAROBOT_ACCEPTANCE_TMPDIR || os.tmpdir(), 'keyboard-insets-'));
try {
  const binary = path.join(temp, 'keyboard-insets-tests');
  execFileSync('xcrun', ['--sdk', 'macosx', 'swiftc',
    path.join(client, 'ios/App/App/KeyboardInsets.swift'),
    path.join(client, 'ios/tests/KeyboardInsetsTests.swift'), '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
} finally { rmSync(temp, { recursive: true, force: true }); }
