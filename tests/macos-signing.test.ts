import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Build helpers are plain Node ESM.
import { BUNDLED_NODE, MACOS_ENTITLEMENTS, codesignArgs, entitlementsPlist, inspectSignature, macosSigningPlan, signatureProblems, verifyForeignAddon } from '../client/scripts/macos-signing.mjs';

const MACH_O = Buffer.from('cffaedfe0c000001', 'hex');
const temporary: string[] = [];
const tempDir = (prefix: string) => { const root = path.join(os.tmpdir(), 'tarobot-signing-tests.noindex'); mkdirSync(root, { recursive: true }); const dir = mkdtempSync(path.join(root, prefix)); temporary.push(dir); return dir; };
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fakeApp() {
  const app = path.join(tempDir('tarobot-sign-plan-'), 'TaroBot.app');
  const files: Record<string, Buffer | string> = {
    'Contents/MacOS/tarocub-client': MACH_O, [BUNDLED_NODE]: MACH_O,
    'Contents/Resources/host/node_modules/sqlite3/build/Release/node_sqlite3.node': MACH_O,
    'Contents/Resources/host/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node': MACH_O,
    'Contents/Resources/host/bin/tarobot-host-launcher.exe': 'MZ windows launcher', 'Contents/Resources/host/dist/src/index.js': 'export {};',
  };
  for (const [relative, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(app, relative)), { recursive: true }); writeFileSync(path.join(app, relative), body); }
  symlinkSync('node', path.join(app, 'Contents/Resources/host/node-link'));
  return app;
}
const good = () => [
  { relative: 'Contents/Resources/host/node_modules/sqlite3/build/Release/node_sqlite3.node', role: 'nested', runtime: true, team: 'TEAM123456', timestamp: true, entitlements: {} },
  { relative: BUNDLED_NODE, role: 'node', runtime: true, team: 'TEAM123456', timestamp: true, entitlements: { ...MACOS_ENTITLEMENTS.node } },
  { relative: '.', role: 'app', runtime: true, team: 'TEAM123456', timestamp: true, entitlements: { ...MACOS_ENTITLEMENTS.app } },
];

describe('macOS Developer ID signing plan', () => {
  it('lets only the bundled Node load third-party native addons', () => {
    expect(MACOS_ENTITLEMENTS.node).toEqual({ 'com.apple.security.cs.allow-jit': true, 'com.apple.security.cs.disable-library-validation': true });
    expect(MACOS_ENTITLEMENTS.app).toEqual({ 'com.apple.security.device.audio-input': true, 'com.apple.security.device.camera': true });
    const forbidden = ['com.apple.security.get-task-allow', 'com.apple.security.cs.allow-dyld-environment-variables', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-executable-page-protection'];
    for (const rights of Object.values(MACOS_ENTITLEMENTS)) for (const key of forbidden) expect(rights).not.toHaveProperty(key);
    expect(entitlementsPlist(MACOS_ENTITLEMENTS.node).match(/<key>[^<]+<\/key><true\/>/g)).toHaveLength(2);
  });

  it('signs nested code inside-out and gives entitlements only to Node and the bundle', () => {
    const app = fakeApp(), plan = macosSigningPlan(app, { mainExecutable: 'tarocub-client' });
    expect(plan.map((target: { path: string; role: string }) => [path.relative(app, target.path) || '.', target.role])).toEqual([
      ['Contents/Resources/host/node_modules/sqlite3/build/Release/node_sqlite3.node', 'nested'],
      ['Contents/Resources/host/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node', 'nested'],
      [BUNDLED_NODE, 'node'], ['.', 'app'],
    ]);
    const args = (role: string) => codesignArgs(plan.find((target: { role: string }) => target.role === role), { identity: 'Developer ID Application: Example (TEAM123456)', keychain: '/tmp/release.keychain-db', entitlementsDir: '/tmp/rights' });
    expect(args('node')).toEqual(expect.arrayContaining(['--options', 'runtime', '--timestamp', '--entitlements', '/tmp/rights/node.plist', '--keychain', '/tmp/release.keychain-db']));
    expect(args('app')).toEqual(expect.arrayContaining(['--entitlements', '/tmp/rights/app.plist']));
    expect(args('nested')).not.toContain('--entitlements');
    for (const role of ['node', 'nested', 'app']) expect(args(role)).not.toContain('--deep');
  });

  it('refuses a bundle without the bundled Node', () => {
    const app = fakeApp(); rmSync(path.join(app, BUNDLED_NODE));
    expect(() => macosSigningPlan(app, { mainExecutable: 'tarocub-client' })).toThrow(/no Contents\/Resources\/host\/node/);
  });

  it.each([
    ['Node without disable-library-validation (the DD1 regression)', (r: ReturnType<typeof good>) => { r[1]!.entitlements = { 'com.apple.security.cs.allow-jit': true }; }, /host\/node: entitlements/],
    ['debugging or DYLD exceptions on Node', (r: ReturnType<typeof good>) => { Object.assign(r[1]!.entitlements, { 'com.apple.security.get-task-allow': true }); }, /host\/node: entitlements/],
    ['library validation disabled on another binary', (r: ReturnType<typeof good>) => { r[0]!.entitlements = { 'com.apple.security.cs.disable-library-validation': true }; }, /node_sqlite3\.node: entitlements/],
    ['library validation disabled on the App', (r: ReturnType<typeof good>) => { Object.assign(r[2]!.entitlements, { 'com.apple.security.cs.disable-library-validation': true }); }, /^\.: entitlements/m],
    ['missing camera/microphone rights', (r: ReturnType<typeof good>) => { r[2]!.entitlements = {}; }, /^\.: entitlements/m],
    ['missing hardened runtime', (r: ReturnType<typeof good>) => { r[0]!.runtime = false; }, /hardened runtime missing/],
    ['another Team ID', (r: ReturnType<typeof good>) => { r[1]!.team = 'OTHER00000'; }, /Team ID OTHER00000/],
    ['missing secure timestamp', (r: ReturnType<typeof good>) => { r[2]!.timestamp = false; }, /secure timestamp missing/],
  ])('rejects %s', (_label, mutate, expected) => {
    expect(signatureProblems(good(), { team: 'TEAM123456', requireTimestamp: true })).toEqual([]);
    const records = good(); mutate(records);
    expect(signatureProblems(records, { team: 'TEAM123456', requireTimestamp: true }).join('\n')).toMatch(expected);
  });
});

// Real signatures and dlopen on macOS: an ad-hoc hardened copy of this Node with
// the release entitlements must load an addon signed by someone else, and the
// former allow-jit-only signature must be refused, as in the DD1 failure.
describe.runIf(process.platform === 'darwin')('macOS signed Node and third-party addons', () => {
  const signedNode = (rights: Record<string, true>) => {
    const dir = tempDir('tarobot-signed-node-'), node = path.join(dir, 'node'), plist = path.join(dir, 'rights.plist');
    copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE);
    writeFileSync(plist, entitlementsPlist(rights));
    execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', plist, node], { stdio: 'pipe' });
    return node;
  };
  it('loads a foreign ad-hoc addon only with the release Node entitlements', () => {
    const release = signedNode(MACOS_ENTITLEMENTS.node);
    expect(inspectSignature(release)).toMatchObject({ runtime: true, entitlements: MACOS_ENTITLEMENTS.node });
    expect(verifyForeignAddon(release, tempDir('tarobot-foreign-'))).toEqual({ addonSignature: 'adhoc', addonTeam: null, loaded: true });
    const regressed = signedNode({ 'com.apple.security.cs.allow-jit': true });
    expect(() => verifyForeignAddon(regressed, tempDir('tarobot-foreign-'))).toThrow(/refused a third-party native addon: library validation/);
  }, 120_000);
});
