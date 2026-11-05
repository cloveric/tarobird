import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LegacyReader, oldDesktopRunning } from '../legacy-reader.mjs';
function fixture(options = {}) {
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.emit('close', 1); } });
  let spawns = 0;
  const reader = new LegacyReader('/App/Contents/MacOS/tarobot-migration-exporter', {
    checkOldDesktop: async () => false, spawnProcess(file, args, config) {
      spawns++; assert.deepEqual(args, ['--export-only']); assert.equal(config.shell, false);
      assert.equal(config.env.ELECTRON_RUN_AS_NODE, undefined); return child;
    }, idleMs: 1000, graceMs: 5, ...options,
  });
  return { reader, child, get spawns() { return spawns; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('reader single-flight requires a complete record and a clean process exit', async () => {
  const f = fixture(), first = f.reader.run(); assert.equal(f.reader.run(), first); await tick();
  assert.equal(f.child.stdin.read().toString(), '{"type":"start"}\n');
  assert.equal(f.child.stdin.writableEnded, false);
  f.child.stdout.write('{"type":"progress"}\n');
  const id = 'abcdabcd-1234-4321-a123-123456789abc';
  f.child.stdout.end(JSON.stringify({ type: 'complete', exportId: id }) + '\n'); f.child.emit('close', 0);
  assert.equal(await first, id); assert.equal(f.spawns, 1);
});
test('legacy App check prevents concurrent source access without killing its Host', async () => {
  const f = fixture({ checkOldDesktop: async () => true }); await assert.rejects(f.reader.run(), /migration_close_old_app/); assert.equal(f.spawns, 0);
  const seen = [];
  assert.equal(await oldDesktopRunning({ pid: 7, uid: 501, platform: 'darwin', execute: async (file, args) => {
    seen.push(args); return { stdout: file === '/bin/ps' ? '501 7 /Applications/TaroBot.app/Contents/MacOS/tarocub-client\n501 8 /Applications/TaroBot.app/Contents/Resources/host/node\n501 9 /old/TaroBot.app/Contents/MacOS/tarocub-client\n' : 'com.tarobot.client\n' };
  } }), true);
  assert.equal(seen.length, 2); assert.equal(seen[1].at(-1), '/old/TaroBot.app/Contents/Info.plist');
});
test('failure, truncated output and exit without result remain failures', async () => {
  for (const output of ['', '{"type":"complete"', JSON.stringify({ type: 'failed', error: 'migration_source_empty' }) + '\n']) {
    const f = fixture(), work = f.reader.run(); await tick();
    f.child.stdout.end(output); await tick(); f.child.emit('close', 0);
    await assert.rejects(work, /migration_(reader|source)/);
  }
});
test('idle timeout and shutdown first close only the reader lifeline', async () => {
  const f = fixture(), work = f.reader.run(); await tick(); f.reader.shutdown();
  assert.equal(f.child.stdin.writableEnded, true); f.child.emit('close', 3);
  await assert.rejects(work, /migration_cancelled/);
  await assert.rejects(f.reader.run(), /migration_cancelled/);
  const idle = fixture({ idleMs: 5 }), timed = idle.reader.run();
  // Keep the test alive while production timers are correctly unref'ed.
  const keepalive = setTimeout(() => {}, 100);
  await assert.rejects(timed, /migration_reader_timeout/); clearTimeout(keepalive);
});

test('unresponsive reader cannot leave migration pending forever', async () => {
  const f = fixture({ idleMs: 5, graceMs: 5 }), signals = [];
  f.child.kill = signal => { signals.push(signal); return true; };
  const keepalive = setTimeout(() => {}, 200);
  await assert.rejects(f.reader.run(), /migration_reader_timeout/);
  assert.deepEqual(signals, [undefined, 'SIGKILL']); clearTimeout(keepalive);
});
test('reader cannot inherit overrides for source profiles or debugging', async () => {
  const f = fixture({ environment: () => ({ HOME: '/safe', WEBVIEW2_USER_DATA_FOLDER: '/wrong', TAURI_CONFIG: '{}', ELECTRON_RUN_AS_NODE: '1' }),
    spawnProcess(file, args, config) { assert.deepEqual(config.env, { HOME: '/safe' }); return f.child; } });
  const result = f.reader.run(); await tick(); f.child.emit('close', 1);
  await assert.rejects(result, /migration_reader_failed/);
});

test('native Windows source conflict keeps the actionable close-old-App error', async () => {
  const f = fixture(), work = f.reader.run(); await tick();
  f.child.stdout.end(JSON.stringify({ type: 'failed', error: 'legacy_source_in_use' }) + '\n');
  f.child.emit('close', 1);
  await assert.rejects(work, /migration_close_old_app/);
});


test('another macOS login cannot block the current user migration', async () => {
  const execute = async (file, args) => {
    assert.equal(file, '/bin/ps'); assert.deepEqual(args, ['-axo', 'uid=,pid=,comm=']);
    return { stdout: '502 123 /Applications/TaroBot.app/Contents/MacOS/tarocub-client\n501 7 /Applications/TaroBot.app/Contents/MacOS/tarocub-client\n' };
  };
  assert.equal(await oldDesktopRunning({ pid: 7, uid: 501, platform: 'darwin', execute }), false);
});


test('a legacy App opened during export is detected before accepting its result', async () => {
  let checks = 0;
  const f = fixture({ checkOldDesktop: async () => ++checks > 1 });
  const work = f.reader.run(); await tick();
  f.child.stdout.end(JSON.stringify({ type: 'complete', exportId: 'abcdabcd-1234-4321-a123-123456789abc' }) + '\n');
  f.child.emit('close', 0);
  await assert.rejects(work, /migration_close_old_app/);
  assert.equal(checks, 2);
});

test('observed legacy writer remains a failure even if it closes before export finishes', async () => {
  let checks = 0;
  const f = fixture({ checkOldDesktop: async () => ++checks === 2, checkIntervalMs: 1 });
  const work = f.reader.run();
  const keepalive = setTimeout(() => {}, 200);
  await assert.rejects(work, /migration_close_old_app/);
  clearTimeout(keepalive);
  assert.equal(f.child.stdin.writableEnded, true);
});
