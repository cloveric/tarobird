import { releaseConfig } from './desktop-release.mjs';
import { validateGithubRepository } from './desktop-update-manifest.mjs';

export function macosBuildPlan({ arch = 'arm64', signedUpdates = true } = {}, env = process.env) {
  if (arch !== 'arm64') throw new Error('The verified full-host macOS build currently supports Apple Silicon only');
  const target = 'aarch64-apple-darwin';
  const args = ['build', '--target', target, '--bundles', 'app,dmg', '--ci'];
  if (!signedUpdates) return { target, args: [...args, '--no-sign'], updateConfig: undefined };
  const repository = validateGithubRepository(env.TAROBOT_GITHUB_REPOSITORY);
  const clientId = env.TAROBOT_GITHUB_CLIENT_ID;
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9._-]{8,100}$/.test(clientId)) throw new Error('TAROBOT_GITHUB_CLIENT_ID is required for private GitHub updates');
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw new Error('TAURI_SIGNING_PRIVATE_KEY is required for signed update artifacts');
  const updateConfig = releaseConfig(`https://api.github.com/repos/${repository}/releases`, env.TAROBOT_UPDATE_PUBLIC_KEY ?? env.TAROCUB_UPDATE_PUBLIC_KEY ?? '');
  // Private distributions still need a sealed bundle. Ad-hoc sealing does not
  // replace Developer ID or notarization; deployments can supply that identity.
  updateConfig.bundle.macOS = { signingIdentity: env.APPLE_SIGNING_IDENTITY || '-' };
  updateConfig.plugins['github-updates'] = { repository, clientId };
  return { target, args, updateConfig };
}
