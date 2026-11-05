import { createWriteStream } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { finished } from 'node:stream/promises';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const outputGrace = 2000;
const within = async (promise, timeout, message) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout);
    })]);
  } finally { clearTimeout(timer); }
};

/** Windows has no process groups. The owned tree is the child plus every
 * process whose recorded parent chain leads to it. A process older than the
 * child, or a direct child created after the child exited (its PID may have
 * been reused), is never adopted. */
export function ownedTree(processes, root, { started, exited = Infinity }) {
  const owned = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const item of processes) {
      if (owned.has(item.pid) || !owned.has(item.parent) || !(item.created >= started)) continue;
      if (item.parent === root && item.created > exited) continue;
      owned.add(item.pid); grew = true;
    }
  }
  owned.delete(root);
  return [...owned];
}
const windowsCommand = (file, args) => new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
  (error, stdout) => resolve(error ? undefined : String(stdout))));
async function windowsProcesses() {
  const out = await windowsCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) }"]);
  return out?.split(/\r?\n/).map(line => line.trim().split(' ')).filter(parts => parts.length === 3)
    .map(([pid, parent, created]) => ({ pid: Number(pid), parent: Number(parent), created: Date.parse(created) }));
}

// macOS/POSIX audit children get a new process group. Only that group is ever
// signalled: never a name match, caller process group, or an existing app PID.
// Windows: the child's tree is ended by PID (see ownedTree), never by name.
export async function runAuditChild(command, args, { cwd, env, logPath, timeout, grace = 2000 }) {
  const windows = process.platform === 'win32';
  const log = createWriteStream(logPath);
  const outputError = new Promise((_, reject) => log.once('error', reject));
  void outputError.catch(() => {});
  const logClosed = finished(log, { cleanup: true });
  // A write may fail before the child exits. Keep the final close receipt, too,
  // so a failure during the final flush cannot turn into a successful audit.
  void logClosed.catch(() => {});
  let child, exitedAt = Infinity;
  // A one-second margin for clock granularity; ownedTree still requires the parent chain.
  const started = Date.now() - 1000;
  try { child = spawn(command, args, { cwd, env, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    log.destroy();
    await within(logClosed, outputGrace, 'audit log did not close after spawn failure').catch(() => {});
    throw error;
  }
  child.stdout.once('error', error => log.destroy(error));
  child.stderr.once('error', error => log.destroy(error));
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const closed = new Promise(resolve => child.once('close', resolve));
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exitedAt = Date.now() + 1000; resolve({ code, signal }); }); });
  // Cleanup also uses this promise after a spawn failure; avoid a stray rejection.
  const settled = exit.catch(() => undefined);
  const signalGroup = signal => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, signal); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const stopWindows = async () => {
    if (!child.pid) return;
    const list = await windowsProcesses();
    if (!list) log.write('audit runner could not list Windows processes; only the direct child can be ended\n');
    const tree = list ? ownedTree(list, child.pid, { started, exited: exitedAt }) : [];
    // While Node still holds the child's handle its PID cannot be reused.
    const alive = child.exitCode === null && child.signalCode === null;
    if (!alive && !tree.length) return;
    log.write(`audit runner ending owned Windows process tree ${[...(alive ? [child.pid] : []), ...tree].join(', ')}\n`);
    if (alive) await windowsCommand('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
    for (const pid of tree) await windowsCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    await within(settled, grace + 1000, 'audit child did not exit after forced termination');
  };
  let stopping;
  const stop = () => stopping ??= (async () => {
    if (windows) return stopWindows();
    if (!signalGroup('SIGTERM')) return;
    const deadline = Date.now() + grace;
    while (signalGroup(0) && Date.now() < deadline) await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    if (signalGroup(0)) { log.write('audit runner escalating owned process group to SIGKILL\n'); signalGroup('SIGKILL'); }
    // Wait for the direct child to be reaped, but do not hang cleanup forever
    // if the kernel cannot deliver an exit receipt after SIGKILL.
    await within(settled, 1000, 'audit child did not exit after forced termination');
  })();
  let timer, timedOut = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      log.write(`audit runner timeout after ${timeout} ms\n`);
      void stop().then(() => reject(new Error(`${path.basename(logPath)}: timed out; inspect the log`)), reject);
    }, timeout);
  });
  try {
    const result = await Promise.race([exit, deadline, outputError]);
    if (timedOut) throw new Error(`${path.basename(logPath)}: timed out; inspect the log`);
    if (result.code !== 0) throw new Error(`${path.basename(logPath)}: native process exited ${result.code ?? result.signal}; inspect the log`);
  } finally {
    clearTimeout(timer);
    try { await stop(); }
    finally {
      try {
        // `exit` does not imply empty stdout/stderr pipes. First stop any owned
        // descendants, then keep reading until `close`. A descendant that leaves
        // our process group can retain a pipe, so the wait must remain bounded.
        await within(Promise.race([closed, outputError]), outputGrace, 'audit output did not close after process cleanup; log may be incomplete');
      } finally {
        child.stdout.unpipe(log); child.stderr.unpipe(log);
        child.stdout.destroy(); child.stderr.destroy();
        try {
          if (!log.destroyed) log.end();
          await within(logClosed, outputGrace, 'audit log did not finish writing');
        } finally { log.destroy(); }
      }
    }
  }
}
