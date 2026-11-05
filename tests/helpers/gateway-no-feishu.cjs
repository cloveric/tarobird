// Test-only process guard. Not imported by production code or a security sandbox.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const preload = __filename;
const canonical = value => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
const fixtures = new Set(['gateway-delivery-crash.ts', 'gateway-restart-loop.ts'].map(name => canonical(path.join(root, 'tests/fixtures', name))));
const loader = path.join(root, 'node_modules/tsx/dist/loader.mjs');
const esbuildVersion = require(path.join(root, 'node_modules/esbuild/package.json')).version;
let active;

function install(report) {
  if (active) throw new Error('gateway_guard_already_installed');
  if (!report || !path.isAbsolute(report)) throw new Error('gateway_guard_report_required');
  function deny(kind) {
    // No command arguments, tokens, URLs or SDK options enter the receipt.
    fs.appendFileSync(report, JSON.stringify({ kind, pid: process.pid }) + '\n', { mode: 0o600 });
    throw new Error(`gateway_no_feishu_guard:${kind}`);
  }
  const seen = new WeakMap();
  function guardSdk(value) {
    if (value === null || !['object', 'function'].includes(typeof value)) return value;
    if (seen.has(value)) return seen.get(value);
    const result = typeof value === 'function' ? function forbiddenSdkCall() { return deny('sdk'); } : Object.create(null);
    seen.set(value, result);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (typeof value === 'function' && ['name', 'length', 'prototype', 'caller', 'arguments'].includes(key)) continue;
      Object.defineProperty(result, key, { value: guardSdk(value[key]), enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  function allowed(command, args, options = {}) {
    if (typeof command !== 'string' || !Array.isArray(args) || options.shell) return false;
    // Lock ownership needs one read-only kernel epoch probe. Admit this exact
    // operation only; this is not a general sysctl/PowerShell exception.
    if (process.platform === 'darwin' && command === '/usr/sbin/sysctl'
      && args.length === 2 && args[0] === '-n' && args[1] === 'kern.bootsessionuuid') return true;
    // Matching process birth is part of lock ownership. Permit only the
    // fixed read-only Darwin query, never arbitrary ps flags or a shell.
    if (process.platform === 'darwin' && command === '/bin/ps'
      && args.length === 4 && args[0] === '-p' && /^[1-9]\d*$/.test(args[1])
      && args[2] === '-o' && args[3] === 'lstart='
      && options.env?.LC_ALL === 'C' && options.env?.TZ === 'UTC') return true;
    if (process.platform === 'win32' && command === 'powershell.exe' && args.length === 4
      && args[0] === '-NoProfile' && args[1] === '-NonInteractive' && args[2] === '-EncodedCommand') {
      const script = `$ErrorActionPreference='Stop';[Console]::Write([System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture))`;
      if (args[3] === Buffer.from(script, 'utf16le').toString('base64')) return true;
    }
    // tsx needs only the exact installed esbuild compiler service. No arbitrary
    // compiler arguments, shell commands or model/Feishu executables are admitted.
    if (args.length === 2 && args[0] === `--service=${esbuildVersion}` && args[1] === '--ping') {
      const real = canonical(command).replaceAll('\\', '/');
      const packages = canonical(path.join(root, 'node_modules/@esbuild')).replaceAll('\\', '/');
      if (real.startsWith(packages + '/') && /\/(?:bin\/esbuild|esbuild\.exe)$/.test(real)) return true;
    }
    if (canonical(command) !== canonical(process.execPath) || args.length !== 5) return false;
    const resolvedLoader = args[3].startsWith('file:') ? fileURLToPath(args[3]) : args[3];
    return args[0] === '--require' && canonical(args[1]) === canonical(preload)
      && args[2] === '--import' && canonical(resolvedLoader) === canonical(loader)
      && fixtures.has(canonical(args[4]))
      && options.env?.TAROBOT_GATEWAY_GUARD_REPORT === report;
  }
  const originals = new Map();
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = cp[name]; originals.set(name, original);
    cp[name] = function (...input) {
      if (name === 'exec' || name === 'execSync') return deny('process');
      if (name === 'fork') {
        const args = Array.isArray(input[1]) ? input[1] : [], options = (Array.isArray(input[1]) ? input[2] : input[1]) ?? {};
        if (args.length || !allowed(options.execPath ?? process.execPath, [...(options.execArgv ?? []), input[0]], options)) return deny('process');
      } else {
        const args = Array.isArray(input[1]) ? input[1] : [], options = (Array.isArray(input[1]) ? input[2] : input[1]) ?? {};
        if (!allowed(input[0], args, typeof options === 'object' ? options : {})) return deny('process');
      }
      return Reflect.apply(original, this, input);
    };
  }
  const originalSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (options) {
    const env = Object.fromEntries((options.envPairs ?? []).map(entry => { const equal = entry.indexOf('='); return [entry.slice(0, equal), entry.slice(equal + 1)]; }));
    if (!allowed(options.file, options.args.slice(1), { ...options, env })) return deny('process');
    return Reflect.apply(originalSpawn, this, [options]);
  };
  const originalLoad = Module._load;
  const cachedSdk = new Map();
  Module._load = function (request, ...args) {
    const result = Reflect.apply(originalLoad, this, [request, ...args]);
    const name = typeof request === 'string' ? request.replaceAll('\\', '/') : '';
    if (!(name === '@larksuiteoapi/node-sdk' || name.startsWith('@larksuiteoapi/node-sdk/') || name.includes('/node_modules/@larksuiteoapi/node-sdk/'))) return result;
    if (!cachedSdk.has(result)) {
      cachedSdk.set(result, Object.getOwnPropertyDescriptors(result));
      const guarded = guardSdk(result);
      // ESM can retain the original exports object internally. Guard its
      // properties in place rather than only replacing require.cache.exports.
      for (const key of Object.getOwnPropertyNames(result)) {
        const descriptor = Object.getOwnPropertyDescriptor(result, key);
        if (descriptor.configurable || descriptor.writable) Object.defineProperty(result, key, { ...descriptor, value: guarded[key] });
      }
    }
    return result;
  };
  // Node 24's ESM translator may execute a CJS module without _load. Seed the
  // any unexpectedly installed SDK through the guarded require before ESM can import it.
  const adapterRequire = Module.createRequire(path.join(root, 'package.json'));
  let sdkPath;
  try { sdkPath = adapterRequire.resolve('@larksuiteoapi/node-sdk'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (sdkPath) adapterRequire(sdkPath);
  Module.syncBuiltinESMExports();
  active = { guardSdk, dispose() {
    for (const [name, original] of originals) cp[name] = original;
    cp.ChildProcess.prototype.spawn = originalSpawn; Module._load = originalLoad;
    for (const [value, descriptors] of cachedSdk) Object.defineProperties(value, descriptors);
    Module.syncBuiltinESMExports(); active = undefined;
  } };
  return active;
}
module.exports = { install, preload };
if (process.env.TAROBOT_GATEWAY_GUARD_REPORT) install(process.env.TAROBOT_GATEWAY_GUARD_REPORT);
