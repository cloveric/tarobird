import { artifactRoot } from '../../scripts/macos-artifact-paths.mjs';
// Developer ID signing and verification for the macOS App bundle. Tauri's own
// signing applies no per-binary entitlements and does not re-sign the bundled
// Node. Run `sign` on the built .app before notarization, DMG and updater
// packaging; never re-bundle it with Tauri afterwards. Run `verify` on every
// final artifact (mounted DMG and extracted updater archive), not only the stage.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Exact rights. The bundled Node runs engines, MCP servers and project tools
 * whose native addons are signed by other developers, so only Node disables
 * library validation. The App and every other binary keep it. */
export const MACOS_ENTITLEMENTS = Object.freeze({
  node: Object.freeze({ 'com.apple.security.cs.allow-jit': true, 'com.apple.security.cs.disable-library-validation': true }),
  app: Object.freeze({ 'com.apple.security.device.audio-input': true, 'com.apple.security.device.camera': true }),
});
export const BUNDLED_NODE = 'Contents/Resources/host/node';
const MACH_O = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const RUNTIME_SMOKE = "const sqlite3=require('sqlite3'); const {createCanvas}=require('@napi-rs/canvas'); const db=new sqlite3.Database(':memory:'); db.get('SELECT 7 * 6 AS answer', (err,row)=>{ if(err || row.answer!==42)throw err||new Error('sqlite'); db.close(); const c=createCanvas(8,8); const ctx=c.getContext('2d'); ctx.fillStyle='red';ctx.fillRect(0,0,8,8); const png=c.toBuffer('image/png'); if(png.length<50)throw new Error('canvas'); let total=0;for(let i=0;i<1e6;i++)total+=i%17;const wasm=new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));console.log(JSON.stringify({node:process.version,sqlite:row.answer,canvasPngBytes:png.length,jitChecksum:total,webAssembly:wasm instanceof WebAssembly.Module})); });";
// A minimal Node-API module needs no headers. Ad-hoc signed, it has no Team ID,
// like npm prebuilds compiled by other developers.
const FOREIGN_ADDON_C = 'typedef struct napi_env__ *napi_env; typedef struct napi_value__ *napi_value;\n'
  + '__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) { (void)env; return exports; }\n'
  + '__attribute__((visibility("default"))) int node_api_module_get_api_version_v1(void) { return 8; }\n';

function run(command, args, { input, cwd, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${path.basename(command)} ${args[0] ?? ''} failed: ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
  return result;
}
function isMachO(file) {
  const fd = openSync(file, 'r');
  try { const magic = Buffer.alloc(4); return readSync(fd, magic, 0, 4, 0) === 4 && MACH_O.has(magic.toString('hex')); } finally { closeSync(fd); }
}
// Regular files only: symbolic links are sealed by the bundle signature.
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
});

export function entitlementsPlist(rights) {
  const keys = Object.keys(rights).sort();
  if (keys.some(key => rights[key] !== true || !/^[a-z0-9.-]+$/.test(key))) throw new Error('Only boolean true entitlements are supported');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0"><dict>${keys.map(key => `<key>${key}</key><true/>`).join('')}</dict></plist>\n`;
}

/** Inside-out order: nested Mach-O files deepest first, the bundle last. The
 * main executable is signed together with the bundle. */
export function macosSigningPlan(app, { mainExecutable }) {
  const main = path.join(app, 'Contents/MacOS', mainExecutable), node = path.join(app, BUNDLED_NODE);
  const nested = walk(app).filter(file => file !== main && isMachO(file))
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b));
  if (!nested.includes(node)) throw new Error(`macOS bundle has no ${BUNDLED_NODE}`);
  return [...nested.map(file => ({ path: file, role: file === node ? 'node' : 'nested' })), { path: app, role: 'app' }];
}

export function codesignArgs(target, { identity, keychain, timestamp = true, entitlementsDir }) {
  return ['--force', '--sign', identity, ...(keychain ? ['--keychain', keychain] : []), '--options', 'runtime', ...(timestamp ? ['--timestamp'] : []),
    ...(target.role === 'nested' ? [] : ['--entitlements', path.join(entitlementsDir, `${target.role}.plist`)]), target.path];
}

export function inspectSignature(file) {
  const details = run('codesign', ['--display', '--verbose=4', file]).stderr;
  const xml = run('codesign', ['--display', '--entitlements', '-', '--xml', file], { allowFailure: true }).stdout.trim();
  const entitlements = xml ? JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml }).stdout) : {};
  return {
    runtime: /flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/.test(details),
    adhoc: /^Signature=adhoc$/m.test(details),
    team: /^TeamIdentifier=(?!not set)(.+)$/m.exec(details)?.[1]?.trim(),
    timestamp: /^Timestamp=/m.test(details),
    entitlements,
  };
}

const sameRights = (actual, expected) => {
  const keys = Object.keys(actual ?? {});
  return keys.length === Object.keys(expected).length && keys.every(key => expected[key] === true && actual[key] === true);
};
/** Rules for every signed target, independent of how records were collected. */
export function signatureProblems(records, { team, requireTimestamp = false } = {}) {
  const problems = [];
  for (const record of records) {
    const label = record.relative ?? record.path, expected = record.role === 'nested' ? {} : MACOS_ENTITLEMENTS[record.role];
    if (!record.runtime) problems.push(`${label}: hardened runtime missing`);
    if (team && record.team !== team) problems.push(`${label}: Team ID ${record.team ?? 'none'} is not ${team}`);
    if (requireTimestamp && !record.timestamp) problems.push(`${label}: secure timestamp missing`);
    if (!sameRights(record.entitlements, expected)) problems.push(`${label}: entitlements ${JSON.stringify(record.entitlements ?? {})} differ from ${JSON.stringify(expected)}`);
  }
  return problems;
}

/** The signed Node must load a Node-API module signed by someone else. Checking
 * only components signed with the App's own Team ID cannot catch DD1. */
export function verifyForeignAddon(node, workdir) {
  const source = path.join(workdir, 'foreign-addon.c'), addon = path.join(workdir, 'foreign-addon.node');
  writeFileSync(source, FOREIGN_ADDON_C);
  run('xcrun', ['clang', '-bundle', '-undefined', 'dynamic_lookup', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-o', addon, source]);
  run('codesign', ['--force', '--sign', '-', addon]);
  const signer = inspectSignature(addon);
  if (!signer.adhoc || signer.team) throw new Error('Foreign addon fixture must be ad-hoc signed without a Team ID');
  const result = run(node, ['-e', `const m={exports:{}};process.dlopen(m,${JSON.stringify(addon)});console.log(JSON.stringify({loaded:typeof m.exports==='object'}))`], { allowFailure: true });
  if (result.status !== 0) {
    const reason = /different Team IDs/.test(result.stderr) ? 'library validation (different Team IDs)' : result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    throw new Error(`Bundled Node refused a third-party native addon: ${reason}`);
  }
  if (!JSON.parse(result.stdout.trim()).loaded) throw new Error('Foreign addon did not initialize');
  return { addonSignature: 'adhoc', addonTeam: null, loaded: true };
}

const mainExecutableOf = app => run('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]).stdout.trim();

export function verifyMacosApp(app, { team, requireTimestamp = false } = {}) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const records = macosSigningPlan(app, { mainExecutable: mainExecutableOf(app) })
    .map(target => ({ ...target, relative: path.relative(app, target.path) || '.', ...inspectSignature(target.path) }));
  const problems = signatureProblems(records, { team, requireTimestamp });
  if (problems.length) throw new Error(`macOS signature verification failed:\n${problems.join('\n')}`);
  const host = path.join(app, 'Contents/Resources/host'), node = path.join(app, BUNDLED_NODE);
  const runtime = JSON.parse(run(node, ['-e', RUNTIME_SMOKE], { cwd: host }).stdout.trim());
  const workdir = mkdtempSync(path.join(os.tmpdir(), 'tarobot-foreign-addon-'));
  try {
    return { app, team: records[0]?.team ?? null, targets: records.map(({ relative, role, team: signer, timestamp, entitlements }) => ({ path: relative, role, team: signer ?? null, timestamp, entitlements })),
      runtime, foreignAddon: verifyForeignAddon(node, workdir) };
  } finally { rmSync(workdir, { recursive: true, force: true }); }
}

export function signMacosApp(app, { identity, keychain, timestamp = true, team }) {
  if (!identity) throw new Error('A signing identity is required');
  const plan = macosSigningPlan(app, { mainExecutable: mainExecutableOf(app) });
  const entitlementsDir = mkdtempSync(path.join(os.tmpdir(), 'tarobot-entitlements-'));
  try {
    for (const [role, rights] of Object.entries(MACOS_ENTITLEMENTS)) writeFileSync(path.join(entitlementsDir, `${role}.plist`), entitlementsPlist(rights), { mode: 0o600 });
    for (const target of plan) run('codesign', codesignArgs(target, { identity, keychain, timestamp, entitlementsDir }));
  } finally { rmSync(entitlementsDir, { recursive: true, force: true }); }
  return verifyMacosApp(app, { team, requireTimestamp: timestamp });
}

const appIn = dir => {
  const apps = readdirSync(dir).filter(name => name.endsWith('.app'));
  if (apps.length !== 1) throw new Error(`Expected exactly one .app in ${dir}`);
  return path.join(dir, apps[0]);
};
export function verifyMacosDmg(dmg, options) {
  const root = artifactRoot(); mkdirSync(root, { recursive: true });
  const mountParent = mkdtempSync(path.join(root, 'tarobot-dmg-mount-'));
  const attached = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountrandom', mountParent, '-plist', dmg]).stdout,
  }).stdout);
  const mount = attached['system-entities'].map(entity => entity['mount-point']).find(Boolean);
  if (!mount) throw new Error('DMG did not mount');
  try { return { dmg, ...verifyMacosApp(appIn(mount), options) }; }
  finally { run('hdiutil', ['detach', mount], { allowFailure: true }); }
}
export function verifyMacosUpdaterArchive(archive, options) {
  const root = artifactRoot(); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'tarobot-updater-verify-'));
  // Keep the fresh App unindexed; guarded cleanup retires it after six hours.
  run('tar', ['-xzf', archive, '-C', dir]);
  return { archive, ...verifyMacosApp(appIn(dir), options) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals: [command], values } = parseArgs({ allowPositionals: true, options: {
    app: { type: 'string' }, dmg: { type: 'string' }, archive: { type: 'string' }, identity: { type: 'string' }, keychain: { type: 'string' },
    team: { type: 'string' }, 'no-timestamp': { type: 'boolean', default: false }, 'require-timestamp': { type: 'boolean', default: false },
  } });
  if (process.platform !== 'darwin') throw new Error('macOS signing must run on a Mac');
  const options = { team: values.team, requireTimestamp: values['require-timestamp'] };
  let report;
  if (command === 'sign' && values.app) report = signMacosApp(path.resolve(values.app), { identity: values.identity, keychain: values.keychain, team: values.team, timestamp: !values['no-timestamp'] });
  else if (command === 'verify' && (values.app || values.dmg || values.archive)) report = [
    ...(values.app ? [verifyMacosApp(path.resolve(values.app), options)] : []),
    ...(values.dmg ? [verifyMacosDmg(path.resolve(values.dmg), options)] : []),
    ...(values.archive ? [verifyMacosUpdaterArchive(path.resolve(values.archive), options)] : []),
  ];
  else throw new Error('Usage: macos-signing.mjs sign --app TaroBot.app --identity ID [--keychain PATH] [--team TEAMID] [--no-timestamp]\n       macos-signing.mjs verify [--app TaroBot.app] [--dmg TaroBot.dmg] [--archive TaroBot.app.tar.gz] [--team TEAMID] [--require-timestamp]');
  console.log(JSON.stringify(report, null, 2));
}
