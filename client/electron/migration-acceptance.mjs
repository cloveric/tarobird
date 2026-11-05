import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const flag = '--tarobot-migration-acceptance';
// An acceptance package may read only the unique WebView2 fixture created by
// our audit runner. Production never accepts this switch or an audit exporter.
export async function developmentMigration({ production, root, argv = process.argv,
  platform = process.platform, env = process.env }) {
  const flags = argv.filter(arg => arg.startsWith(flag));
  if (!flags.length) return undefined;
  if (production || platform !== 'win32' || flags.length !== 1 || !flags[0].startsWith(`${flag}=`)) throw new Error('invalid_migration_acceptance');
  const bundleId = flags[0].slice(flag.length + 1);
  if (!/^com\.tarobot\.migration\.acceptance\.p[0-9a-f]{32}$/.test(bundleId)
    || !root || !path.isAbsolute(root) || !root.split(path.sep).some(part => part.endsWith('.noindex'))
    || !env.TAROBOT_MIGRATION_AUDIT_ROOT || !path.isAbsolute(env.LOCALAPPDATA ?? '')) throw new Error('invalid_migration_acceptance');
  if (await realpath(root) !== root || await realpath(env.TAROBOT_MIGRATION_AUDIT_ROOT) !== root) throw new Error('migration_acceptance_root_mismatch');
  const identityPath = path.join(root, 'identity.json');
  const identityFile = await lstat(identityPath);
  if (!identityFile.isFile() || identityFile.isSymbolicLink() || identityFile.size > 4096) throw new Error('invalid_migration_acceptance_identity');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  if (identity.bundleId !== bundleId || identity.productionDataAccess !== false) throw new Error('invalid_migration_acceptance_identity');
  const base = await realpath(env.LOCALAPPDATA);
  const source = path.join(base, bundleId), webview = path.join(source, 'EBWebView');
  for (const directory of [source, webview]) {
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('migration_acceptance_source_redirected');
  }
  return { bundleId, legacyWebviewDirs: [webview], auditRoot: root };
}
