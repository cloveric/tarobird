import { releaseConfig } from './desktop-release.mjs';
import { validateGithubRepository } from './windows-update-manifest.mjs';

export function windowsBuildPlan({ arch = 'x64', signedUpdates = false } = {}, env = process.env) {
  const target = { x64: 'x86_64-pc-windows-msvc' }[arch];
  if (!target) throw new Error('This full-host installer targets Windows x64; Windows ARM64 can use x64 emulation.');
  const args = ['build', '--target', target, '--bundles', 'nsis', '--ci'];
  if (!signedUpdates) return { target, args: [...args, '--no-sign'], updateConfig: undefined };
  const repository = validateGithubRepository(env.TAROBOT_GITHUB_REPOSITORY);
  const clientId = env.TAROBOT_GITHUB_CLIENT_ID;
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9._-]{8,100}$/.test(clientId)) throw new Error('TAROBOT_GITHUB_CLIENT_ID is required for private GitHub updates');
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw new Error('TAURI_SIGNING_PRIVATE_KEY is required for signed update artifacts');
  const updateConfig = releaseConfig(`https://api.github.com/repos/${repository}/releases`, env.TAROBOT_UPDATE_PUBLIC_KEY ?? env.TAROCUB_UPDATE_PUBLIC_KEY ?? '');
  updateConfig.plugins.updater.windows = { installMode: 'passive' };
  updateConfig.plugins['github-updates'] = { repository, clientId };
  return { target, args, updateConfig };
}
