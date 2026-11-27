import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

// Explicit public-file allowlist: never recursively copy integration directories.
export const integrationAssets = [
  'integrations/.env.example',
  ...['server.py', 'transcribe.py', 'requirements.txt', 'README.md'].map(name => `integrations/qwen3-asr/${name}`),
  ...['tingwu_transcribe.py', 'configure_env.sh', 'requirements.txt', '.env.example', 'README.md', 'README.zh-CN.md'].map(name => `integrations/tingwu-asr/${name}`),
  'scripts/install-qwen-asr.sh', 'scripts/qwen-asr-install.py', 'scripts/install-tingwu-asr.sh',
  'scripts/search-mcp.mjs', 'scripts/check-integrations.mjs',
  'scripts/install-skills.sh',
  'scripts/install-scrapling.sh', 'skills/scrapling/SKILL.md',
  'docs/integrations.md', 'docs/search-mcp.md',
];

export async function copyIntegrationAssets(source, destination) {
  const canonicalSource = await realpath(source);
  for (const relative of integrationAssets) {
    const from = path.join(source, relative), to = path.join(destination, relative);
    if (!(await lstat(from)).isFile()) throw new Error(`Integration asset must be a regular file: ${relative}`);
    if (await realpath(from) !== path.join(canonicalSource, relative)) throw new Error(`Integration asset must not traverse symlinks: ${relative}`);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}
