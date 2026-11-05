import { spawn } from 'node:child_process';
import path from 'node:path';
import { electronBuildCLI } from './electron-build.mjs';
import { isolatedRoot } from '../electron/isolation.mjs';
import { helperEnvironment } from '../electron/helper-rpc.mjs';
// Even a development launch must never choose the production profile implicitly.
const profile = await isolatedRoot(process.env.TAROBOT_DESKTOP_DEV_PROFILE);
const args = process.argv.slice(2);
if (args.includes('--production')) throw new Error('desktop:dev cannot build a production package');
const result = await electronBuildCLI([...args, '--development', '--package-only']);
const binary = process.platform === 'darwin' ? path.join(result.packaged.paths[0], 'TaroBird.app/Contents/MacOS/tarocub-client') : path.join(result.packaged.paths[0], 'tarocub-client.exe');
const child = spawn(binary, [`--tarobot-development=${profile}`], { stdio: 'inherit', shell: false, env: helperEnvironment() });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
