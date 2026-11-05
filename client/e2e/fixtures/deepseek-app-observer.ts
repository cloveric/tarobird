import { chmod, writeFile } from "node:fs/promises";

/** Byte-for-byte pipe forwarding. Records only the isolated fixture's native
 * App RPCs; never changes tools, prompts, permissions or delivery results. */
export async function writeDeepSeekObserver(wrapper: string, nativeLog: string, executable: string): Promise<void> {
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync, createReadStream, createWriteStream } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const native = process.env.TAROCUB_DSH_APP_PIPES === '1';
const child = spawn(${JSON.stringify(executable)}, process.argv.slice(2), { stdio: native ? ['inherit','inherit','inherit','pipe','pipe'] : 'inherit', env: process.env });
const record = (data) => appendFileSync(${JSON.stringify(nativeLog)}, JSON.stringify({ observerPid: process.pid, ...data }) + '\\n');
if (native) {
  record({type:'launch', childPid:child.pid});
  const input = createReadStream('', {fd:3,autoClose:false}), output = createWriteStream('', {fd:4,autoClose:false});
  function observe(stream, direction) {
    const decoder = new StringDecoder('utf8'); let pending = '';
    stream.on('data', chunk => {
      pending += decoder.write(chunk); const lines = pending.split('\\n'); pending = lines.pop();
      for (const line of lines) { try { record({type:direction,frame:JSON.parse(line)}); } catch {} }
    });
  }
  observe(input, 'host'); observe(child.stdio[4], 'native');
  input.pipe(child.stdio[3]); child.stdio[4].pipe(output);
  for (const stream of [input,output,child.stdio[3],child.stdio[4]]) stream.on('error', () => child.kill('SIGTERM'));
}
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1)); child.on('close', code => process.exit(code ?? 1));
`);
  await chmod(wrapper, 0o700);
}
