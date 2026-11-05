import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAuditChild } from './native-audit-runner.mjs';

test('timeout forcibly reaps only its own SIGTERM-ignoring child', { timeout: 8000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audit-runner-test-'));
  try {
    const started = Date.now();
    await assert.rejects(runAuditChild(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)"], {
      cwd: root, env: process.env, logPath: path.join(root, 'child.log'), timeout: 500, grace: 150,
    }), /timed out/);
    assert.ok(Date.now() - started < 4000);
    const log = await readFile(path.join(root, 'child.log'), 'utf8');
    const pid = Number(log.match(/^\d+$/m)?.[0]); assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.match(log, /SIGKILL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('successful process preserves output and nonzero exit is a failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audit-runner-test-'));
  try {
    const options = { cwd: root, env: process.env, logPath: path.join(root, 'child.log'), timeout: 2000, grace: 100 };
    await runAuditChild(process.execPath, ['-e', "console.log('complete')"], options);
    assert.match(await readFile(options.logPath, 'utf8'), /complete/);
    await assert.rejects(runAuditChild(process.execPath, ['-e', 'process.exit(7)'], options), /exited 7/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('drains all flushed stdout and stderr after both successful and failed exits', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audit-runner-test-'));
  try {
    for (const code of [0, 7]) {
      // Check streams separately: relative ordering across stdout and stderr
      // is not guaranteed. A callback before exit flushes the child's writes,
      // leaving only the runner responsible for draining the OS pipe.
      for (const stream of ['stdout', 'stderr']) {
        const expected = `${`${stream} payload\n`.repeat(600000)}${stream}-tail\n`;
        const script = `process.${stream}.end('${stream} payload\\n'.repeat(600000)+'${stream}-tail\\n',()=>process.exit(${code}));`;
        const options = { cwd: root, env: process.env, logPath: path.join(root, `${stream}-${code}.log`), timeout: 5000, grace: 100 };
        const run = runAuditChild(process.execPath, ['-e', script], options);
        if (code === 0) await run;
        else await assert.rejects(run, /exited 7/);
        const log = await readFile(options.logPath, 'utf8');
        assert.equal(log.length, expected.length, `complete ${stream} length for exit ${code}`);
        assert.ok(log === expected, `exact ${stream} contents, including tail, for exit ${code}`);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a successful leader cannot leave a SIGTERM-ignoring descendant behind', { timeout: 8000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audit-runner-test-'));
  try {
    const descendant = "process.on('SIGTERM',()=>{}); console.log('descendant='+process.pid); setInterval(()=>{},1000)";
    const leader = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']});c.stdout.once('data',data=>{process.stdout.write(data);process.exit(0)});`;
    await runAuditChild(process.execPath, ['-e', leader], { cwd: root, env: process.env, logPath: path.join(root, 'child.log'), timeout: 3000, grace: 150 });
    const log = await readFile(path.join(root, 'child.log'), 'utf8');
    const pid = Number(log.match(/descendant=(\d+)/)?.[1]); assert.ok(pid > 0);
    // macOS launchd may need a brief turn to reap the orphan after SIGKILL.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('owned descendant survived cleanup');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('spawn errors reject promptly and close the log', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audit-runner-test-'));
  try {
    await assert.rejects(runAuditChild(path.join(root, 'missing-executable'), [], { cwd: root, env: process.env, logPath: path.join(root, 'child.log'), timeout: 2000, grace: 100 }), { code: 'ENOENT' });
    // Invalid spawn arguments throw synchronously. A simultaneous log-open
    // failure must still be handled instead of escaping as an unhandled rejection.
    await assert.rejects(runAuditChild('', [], { cwd: root, env: process.env, logPath: path.join(root, 'missing', 'child.log'), timeout: 2000, grace: 100 }), { code: 'ERR_INVALID_ARG_VALUE' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a successful exit still reports a log close failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audit-runner-test-'));
  const logPath = path.join(root, 'child.log');
  const originalDestroy = WriteStream.prototype._destroy;
  const closeError = Object.assign(new Error('simulated log close failure'), { code: 'EIO' });
  // Preserve real fd closure, but simulate a filesystem failure in its receipt.
  // This occurs after writable finish, when an end callback would report success.
  t.mock.method(WriteStream.prototype, '_destroy', function (error, callback) {
    originalDestroy.call(this, error, failure => callback(failure ?? (this.path === logPath ? closeError : null)));
  });
  try {
    await assert.rejects(runAuditChild(process.execPath, ['-e', "process.stdout.end('complete\\n')"], {
      cwd: root, env: process.env, logPath, timeout: 2000, grace: 100,
    }), { code: 'EIO' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a pipe retained outside the owned group fails within a bounded time', { timeout: 8000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audit-runner-test-'));
  let pid;
  try {
    // This fixture deliberately leaves the audit group. Its PID is written by
    // the fixture itself, and only this test owns cleanup of that separate group.
    const descendant = "require('node:fs').writeFileSync('escaped.pid',String(process.pid)); process.stdout.write('escaped-ready\\n'); setTimeout(()=>process.exit(0),10000);";
    const leader = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','inherit','inherit']}); c.unref();`;
    const started = Date.now();
    await assert.rejects(runAuditChild(process.execPath, ['-e', leader], {
      cwd: root, env: process.env, logPath: path.join(root, 'child.log'), timeout: 3000, grace: 100,
    }), /audit output did not close.*log may be incomplete/);
    assert.ok(Date.now() - started < 5000);
    pid = Number(await readFile(path.join(root, 'escaped.pid'), 'utf8'));
    assert.ok(pid > 0);
    assert.doesNotThrow(() => process.kill(pid, 0), 'the runner must not signal a different process group');
    assert.match(await readFile(path.join(root, 'child.log'), 'utf8'), /escaped-ready/);
  } finally {
    if (!pid) pid = Number(await readFile(path.join(root, 'escaped.pid'), 'utf8').catch(() => ''));
    if (pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows tree: the parent chain from the child, never older processes or a reused PID', async () => {
  const { ownedTree } = await import('./native-audit-runner.mjs');
  const list = [
    { pid: 10, parent: 1, created: 1000 },  // the audit child
    { pid: 11, parent: 10, created: 1100 }, // WebView2 browser
    { pid: 12, parent: 11, created: 1200 }, // renderer
    { pid: 13, parent: 10, created: 500 },  // older than the child: a stale parent ID
    { pid: 14, parent: 99, created: 1300 }, // unrelated
    { pid: 15, parent: 10, created: 5000 }, // child of a process that reused PID 10 after exit
  ];
  assert.deepEqual(ownedTree(list, 10, { started: 900 }).sort(), [11, 12, 15]);
  assert.deepEqual(ownedTree(list, 10, { started: 900, exited: 2000 }).sort(), [11, 12]);
  assert.deepEqual(ownedTree([], 10, { started: 900 }), []);
  assert.deepEqual(ownedTree([{ pid: 11, parent: 10, created: Number.NaN }], 10, { started: 900 }), []);
});
