import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
// Remove stale legacy outputs before compiling the standalone dependency closure.
for (const directory of ['dist/src', 'dist/deepseek-harness-plugin']) await rm(directory, { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.app.json'], { stdio: 'inherit' });
await import('./build-relay.mjs');
await import('./check-standalone-graph.mjs');
