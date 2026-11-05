// Dedicated acceptance worker only. Observe native inputs without changing
// prompts, protocol bytes, permissions, tools or model responses.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

if (process.argv[1] === process.env.TAROCUB_MEDIA_WORKER_ENTRY && process.env.TAROCUB_MEDIA_OBSERVER_LOG) {
  const record = value => appendFileSync(process.env.TAROCUB_MEDIA_OBSERVER_LOG, JSON.stringify({ at: Date.now(), ...value }) + '\n');
  const input = content => {
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
    const files = [...text.matchAll(/^Attachment: (.+)$/gm)].map(match => match[1]);
    record({ type: 'input', files: files.map(file => ({ name: path.basename(file), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })) });
  };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    record({ type: 'spawn', pid: child.pid, executable: path.basename(String(args[0])) });
    const reader = direction => {
      const decoder = new StringDecoder('utf8'); let pending = '';
      return chunk => {
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        const lines = pending.split('\n'); pending = lines.pop();
        if (pending.length > 1024 * 1024) pending = '';
        for (const line of lines) { try {
          const frame = JSON.parse(line);
          if (direction === 'in') {
            if (frame.method === 'turn/start') input(frame.params?.input);
            else if (frame.method === 'session/prompt') input(frame.params?.prompt);
            else if (frame.type === 'user' || frame.event === 'user') input(frame.message?.content);
          } else if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string') record({ type: 'session', sessionId: frame.session_id });
        } catch {} }
      };
    };
    child.stdout?.on('data', reader('out'));
    if (child.stdin) {
      const write = child.stdin.write, observe = reader('in');
      child.stdin.write = function (...values) { observe(values[0]); return Reflect.apply(write, this, values); };
    }
    child.once('exit', () => record({ type: 'exit', pid: child.pid }));
    return child;
  };
  syncBuiltinESMExports();
  const { DeepSeekHarnessProtocolClient } = await import(process.env.TAROCUB_MEDIA_PROTOCOL_MODULE);
  const request = DeepSeekHarnessProtocolClient.prototype.request;
  DeepSeekHarnessProtocolClient.prototype.request = function (method, ...args) {
    if (method === 'session.prompt') input(args[0]?.content);
    return Reflect.apply(request, this, [method, ...args]);
  };
}
