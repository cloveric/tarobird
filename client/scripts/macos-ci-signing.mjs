// Ephemeral GitHub runner credentials only. Never imports into a user's login
// keychain or changes the owner's existing release keychain.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, appendFile, unlink, realpath, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
const env = process.env;
if (env.GITHUB_ACTIONS !== 'true' || process.platform !== 'darwin' || !env.RUNNER_TEMP) throw new Error('Only an ephemeral macOS GitHub runner is supported');
const temporary = await realpath(env.RUNNER_TEMP), root = path.join(temporary, 'tarobot-signing.noindex');
const keychain = path.join(root, 'release.keychain-db');
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000 });
  // Security arguments can contain the temporary password. Never echo args,
  // subprocess errors or credential tool output on failure.
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} credential setup failed`);
  return result.stdout;
}
if (process.argv[2] === 'cleanup') {
  const marker = JSON.parse(await readFile(path.join(root, 'ownership.json'), 'utf8').catch(() => '{}'));
  if (marker.run === env.GITHUB_RUN_ID && marker.keychain === keychain) {
    if (await lstat(keychain).catch(error => { if (error.code !== 'ENOENT') throw error; })) run('/usr/bin/security', ['delete-keychain', keychain]);
    for (const name of ['certificate.p12', 'notary.p8', 'ownership.json']) await unlink(path.join(root, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
} else {
  for (const name of ['APPLE_CERTIFICATE_BASE64', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_NOTARY_PRIVATE_KEY', 'APPLE_NOTARY_KEY_ID', 'APPLE_NOTARY_ISSUER_ID', 'TAROBOT_APPLE_TEAM_ID', 'GITHUB_ENV']) if (!env[name]) throw new Error(`${name} is required for signed, notarized Electron releases`);
  await mkdir(root, { mode: 0o700 });
  await writeFile(path.join(root, 'ownership.json'), JSON.stringify({ run: env.GITHUB_RUN_ID, keychain }), { mode: 0o600 });
  const password = randomBytes(32).toString('base64url');
  await writeFile(path.join(root, 'certificate.p12'), Buffer.from(env.APPLE_CERTIFICATE_BASE64, 'base64'), { mode: 0o600 });
  await writeFile(path.join(root, 'notary.p8'), env.APPLE_NOTARY_PRIVATE_KEY, { mode: 0o600 });
  run('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
  run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain]);
  run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
  run('/usr/bin/security', ['import', path.join(root, 'certificate.p12'), '-k', keychain, '-P', env.APPLE_CERTIFICATE_PASSWORD, '-T', '/usr/bin/codesign']);
  run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
  const previous = [...run('/usr/bin/security', ['list-keychains', '-d', 'user']).matchAll(/"([^"\n]+)"/g)].map(match => match[1]);
  run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...previous, keychain]);
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
  const match = [...identities.matchAll(/([A-F0-9]{40}) "Developer ID Application: [^"\n]+ \(([A-Z0-9]+)\)"/g)].find(value => value[2] === env.TAROBOT_APPLE_TEAM_ID);
  if (!match) throw new Error('Developer ID certificate for the configured team was not found');
  run('/usr/bin/xcrun', ['notarytool', 'store-credentials', 'tarobot-release', '--key', path.join(root, 'notary.p8'), '--key-id', env.APPLE_NOTARY_KEY_ID, '--issuer', env.APPLE_NOTARY_ISSUER_ID, '--keychain', keychain]);
  await appendFile(env.GITHUB_ENV, `APPLE_SIGNING_IDENTITY=${match[1]}\nTAROBOT_SIGNING_KEYCHAIN=${keychain}\nTAROBOT_NOTARY_PROFILE=tarobot-release\n`);
  await unlink(path.join(root, 'certificate.p12')); await unlink(path.join(root, 'notary.p8'));
}
