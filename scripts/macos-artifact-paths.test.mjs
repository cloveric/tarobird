import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noIndexDirectory, macosBuildEnvironment, physicalPath } from './macos-artifact-paths.mjs';
import { finalizeMacosArtifacts } from './finalize-macos-artifacts.mjs';

test('legacy task paths and explicit Cargo caches become physically unindexed', () => {
  assert.equal(noIndexDirectory('/Volumes/gdrive/taro-tmp/release-x'), '/Volumes/gdrive/taro-tmp.noindex/release-x');
  assert.equal(noIndexDirectory('/Volumes/gdrive/dev-cache/tarobot-release-target'), '/Volumes/gdrive/dev-cache/tarobot-release-target.noindex');
  assert.equal(noIndexDirectory('/private/tmp/work.noindex/candidate'), '/private/tmp/work.noindex/candidate');
  const env=macosBuildEnvironment('/private/source', { CARGO_TARGET_DIR:'/private/cache', SIGNING_SENTINEL:'retained' }, 'darwin');
  assert.equal(env.CARGO_TARGET_DIR,'/private/cache.noindex');
  assert.equal(env.SIGNING_SENTINEL,'retained');
  assert.deepEqual(macosBuildEnvironment('/private/source',{CARGO_TARGET_DIR:'C:/cache'},'win32'),{CARGO_TARGET_DIR:'C:/cache'});
});
test('installed application destinations are refused', () => {
  for (const p of ['/Applications','/Applications/TaroBot.app','/applications/TaroBot.app','/SYSTEM','/SYSTEM/Applications/Foo','/System/Applications/Foo']) assert.throws(()=>noIndexDirectory(p));
});
test('a symlink cannot route an otherwise noindex build path into installed applications', { skip: process.platform !== 'darwin' }, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'artifact-installed-alias-'));
  try {
    // Only create the alias in this fixture; never write to its protected target.
    for (const target of ['/Applications', '/System']) {
      const alias = path.join(tmp, path.basename(target));
      symlinkSync(target, alias);
      assert.throws(() => noIndexDirectory(path.join(alias, 'candidate.noindex')), /installed application/);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test('physical paths use the filesystem case for existing ancestors', t => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'artifact-case-'));
  try {
    const actual = path.join(tmp, 'CaseFolder.noindex'), alias = path.join(tmp, 'casefolder.noindex');
    mkdirSync(actual);
    if (!existsSync(alias)) { t.skip('requires a case-insensitive filesystem'); return; }
    assert.equal(physicalPath(alias), realpathSync.native(actual));
    assert.equal(physicalPath(path.join(alias, 'new-task')), path.join(realpathSync.native(actual), 'new-task'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test('a noindex symlink to an indexed directory is not accepted', () => {
  // This negative fixture must be outside physical .noindex storage, even
  // when the release runner deliberately puts its TMPDIR below .noindex.
  // It creates only directories/a symlink, never an App or an installed path.
  let indexedParent = physicalPath(os.tmpdir());
  while (indexedParent.split(path.sep).some(part => part.endsWith('.noindex'))) indexedParent = path.dirname(indexedParent);
  const tmp=mkdtempSync(path.join(indexedParent,'artifact-path-'));
  try {
    mkdirSync(path.join(tmp,'plain'));
    symlinkSync(path.join(tmp,'plain'),path.join(tmp,'alias.noindex'));
    assert.throws(()=>noIndexDirectory(path.join(tmp,'alias.noindex','child')),/physical/);
  } finally {rmSync(tmp,{recursive:true,force:true});}
});
test('cleanup is explicit trash after publication and deferral does not claim publication failure', () => {
  let args;
  const receipt=finalizeMacosArtifacts({version:'1.2.3',outputDir:'/private/result'}, {platform:'darwin',run:(cmd,argv)=>{
    assert.equal(cmd,'python3'); args=argv; return JSON.stringify({mode:'apply',blocked:true,trashed:0});
  }});
  assert.ok(args.includes('--apply'));assert.ok(args.includes('--keep-version'));
  assert.equal(receipt.blocked,true);
  assert.equal(finalizeMacosArtifacts({version:'1.2.3',outputDir:'/private/result'},{platform:'darwin',run:()=>{throw Error('busy');}}).status,'deferred');
});
test('the publisher hook also scans an Electron output root after the default task roots', () => {
  let args;
  finalizeMacosArtifacts({version:'1.2.3',outputDir:'/private/result'}, {platform:'darwin', environment:{TAROBOT_ARTIFACT_ROOT:'/private/tmp/artifacts.noindex', CARGO_TARGET_DIR:'/private/tmp/target.noindex', TAROBOT_DESKTOP_OUTPUT:'/private/tmp/release.noindex/electron-output.noindex'},
    run:(cmd,argv)=>{ args=argv; return JSON.stringify({mode:'apply',blocked:true,trashed:0}); }});
  const roots=args.flatMap((value,index)=>args[index-1]==='--root'?[value]:[]);
  assert.equal(roots[0],'/Volumes/gdrive/taro-tmp.noindex');
  assert.deepEqual(roots.slice(-3),['/private/tmp/artifacts.noindex','/private/tmp/target.noindex','/private/tmp/release.noindex/electron-output.noindex']);
  assert.ok(args.includes('--apply'));
});
test('the workspace helper exports Electron output, cache and target inside physical .noindex roots', async () => {
  const { execFileSync } = await import('node:child_process');
  const tmp=mkdtempSync(path.join(os.tmpdir(),'artifact-workspace-'));
  try {
    const root=path.join(tmp,'labs.noindex'), target=path.join(tmp,'target.noindex');
    const result=JSON.parse(execFileSync(process.execPath,[new URL('./macos-artifact-workspace.mjs', import.meta.url).pathname,'--name','release-test-1','--root',root,'--target',target],{encoding:'utf8'}));
    const script=execFileSync('/bin/sh',['-c','. "$1" && printf "%s\\n" "$TAROBOT_DESKTOP_OUTPUT" "$TAROBOT_ELECTRON_CACHE" "$TAROBOT_DESKTOP_TARGET" "$CARGO_TARGET_DIR"','sh',path.join(result.lab,'build-env.sh')],{encoding:'utf8'}).trim().split('\n');
    assert.deepEqual(script,[result.electron.output,result.electron.cache,result.electron.target,result.cargoTarget]);
    for (const value of script) assert.ok(value.split(path.sep).some(part=>part.endsWith('.noindex')));
    assert.ok(result.electron.output.startsWith(result.lab+path.sep));
    assert.throws(()=>execFileSync(process.execPath,[new URL('./macos-artifact-workspace.mjs', import.meta.url).pathname,'--name','release-test-1','--root',root,'--target',target],{stdio:'pipe'}));
  } finally { rmSync(tmp,{recursive:true,force:true}); }
});
