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
  'skills/baoyu-design/LICENSE',
  'skills/baoyu-design/NOTICE.md',
  'skills/baoyu-design/SKILL.md',
  'skills/baoyu-design/UPSTREAM.json',
  'skills/baoyu-design/references/brand-colors.md',
  'skills/baoyu-design/references/brand-typography.md',
  'skills/baoyu-design/references/craft.md',
  'skills/baoyu-design/references/design-system-components.md',
  'skills/baoyu-design/references/diagrams.md',
  'skills/baoyu-design/references/format.md',
  'skills/baoyu-design/references/google-fonts-families.json',
  'skills/baoyu-design/references/google-fonts-notices.json',
  'skills/baoyu-design/references/google-fonts-reserved.json',
  'skills/baoyu-design/references/make-from-this.md',
  'skills/baoyu-design/references/print.md',
  'skills/baoyu-design/references/shaders.md',
  'skills/baoyu-design/references/questions.md',
  'skills/baoyu-design/references/view-state.md',
  'skills/baoyu-ppt/LICENSE',
  'skills/baoyu-ppt/NOTICE.md',
  'skills/baoyu-ppt/SKILL.md',
  'skills/baoyu-ppt/UPSTREAM.json',
  'skills/baoyu-ppt/references/craft.md',
  'skills/baoyu-ppt/references/deck-files.md',
  'skills/baoyu-ppt/references/diagram-recipes.md',
  'skills/baoyu-ppt/references/diagrams.md',
  'skills/baoyu-ppt/references/fonts.md',
  'skills/baoyu-ppt/references/format.md',
  'skills/baoyu-ppt/references/google-fonts-families.json',
  'skills/baoyu-ppt/references/google-fonts-notices.json',
  'skills/baoyu-ppt/references/google-fonts-reserved.json',
  'skills/baoyu-ppt/references/images.md',
  'skills/baoyu-ppt/references/layout.md',
  'skills/baoyu-ppt/references/photo-library.md',
  'skills/baoyu-ppt/references/questions.md',
  'skills/baoyu-ppt/references/styles.md',
  'skills/baoyu-ppt/references/view-state.md',
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
