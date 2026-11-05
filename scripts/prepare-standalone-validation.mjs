import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const destination = await mkdtemp(path.join(os.tmpdir(), 'tarobot-standalone-'));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of files) {
 if (file.startsWith('adapters/') || file.startsWith('.github/') || !await stat(file).then(() => true, () => false)) continue;
 const target = path.join(destination, file); await mkdir(path.dirname(target), { recursive: true });
 await cp(file, target);
}
await cp('client/dist', path.join(destination, 'client/dist'), { recursive: true });
await mkdir('test-results', { recursive: true }); await writeFile('test-results/standalone-validation-path.txt', destination+'\n');
console.log(destination);
