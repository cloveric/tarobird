import { chmod, lstat, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function writeClaudeObserver(wrapper: string, nativeLog: string, executable: string, persist = false): Promise<void> {
  // Transparent protocol observer; only optional session persistence differs.
  // No tools, prompts, model output or delivery results are injected/replaced.
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const record = (data) => appendFileSync(${JSON.stringify(nativeLog)}, JSON.stringify({ observerPid: process.pid, ...data }) + '\\n');
const child = spawn(${JSON.stringify(executable)}, ${JSON.stringify(persist ? [] : ['--no-session-persistence'])}.concat(process.argv.slice(2)), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
record({ type: 'launch', childPid: child.pid, resume: process.argv.includes('-r') });
const { StringDecoder } = require('node:string_decoder');
function observe(stream, direction, forward) {
  const decoder = new StringDecoder('utf8'); let pending = '';
  stream.on('data', (chunk) => {
    forward.write(chunk); pending += decoder.write(chunk);
    const lines = pending.split('\\n'); pending = lines.pop();
    for (const line of lines) { try {
      const frame = JSON.parse(line);
      if (direction === 'out' && frame.type === 'control_request' && frame.request?.subtype === 'mcp_message') record({ type: 'mcp-request', frame });
      if (direction === 'out' && frame.type === 'system' && frame.subtype === 'init') record({ type: 'session', sessionId: frame.session_id });
      if (direction === 'in' && frame.type === 'control_response') record({ type: 'mcp-response', frame });
      if (direction === 'in' && frame.type === 'user') record({ type: 'input', files: [...frame.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\\n').matchAll(/^Attachment: (.+)$/gm)].map((match) => match[1]) });
    } catch {} }
  });
}
observe(process.stdin, 'in', child.stdin); observe(child.stdout, 'out', process.stdout);
process.stdin.on('end', () => child.stdin.end());
child.stdin.on('error', () => {});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1)); child.on('exit', (code) => { record({ type: 'observer-exit', code }); process.exit(code ?? 1); });
`);
  await chmod(wrapper, 0o700);
}

/** Only a fresh temporary test workspace owns these transcript directories.
 * Capture absence BEFORE starting Claude; never search/delete by age or model. */
export async function ownClaudeFixtureTranscripts(workspace: string) {
  const resolved = await realpath(workspace);
  if (!/^live-claude-app-tools-[A-Za-z0-9]+$/.test(path.basename(path.dirname(resolved))) || path.basename(resolved) !== "workspace") throw new Error("Not an owned Claude acceptance workspace");
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  const roots = [...new Set([path.resolve(workspace), resolved].map((cwd) => path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"))))];
  for (const root of roots) {
    try { await lstat(root); throw new Error("Refusing an existing Claude project"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return async (sessions: string[]) => {
    let removed = 0;
    for (const root of roots) {
      const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
      for (const entry of entries.filter((name) => name.endsWith(".jsonl"))) {
        if (!sessions.includes(entry.slice(0, -6))) throw new Error("Unexpected transcript in fixture workspace");
        const records = (await readFile(path.join(root, entry), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        if (!records.some((record) => record.cwd === resolved || record.cwd === workspace)) throw new Error("Fixture transcript cwd mismatch");
        removed++;
      }
      if (entries.length) await rm(root, { recursive: true });
      try { await lstat(root); throw new Error("Fixture transcript cleanup failed"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return removed;
  };
}
