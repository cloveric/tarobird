#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactRoot, noIndexDirectory } from './macos-artifact-paths.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const { values } = parseArgs({ options: { name: { type:'string' }, 'dry-run': {type:'boolean'}, root:{type:'string'}, target:{type:'string'}, cache:{type:'string'} } });
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(values.name ?? '') || values.name.includes('..')) throw new Error('--name must be a unique task name');
const root = values.root ? noIndexDirectory(values.root) : artifactRoot();
const lab = path.join(root, values.name);
const target = noIndexDirectory(values.target ?? (existsSync('/Volumes/gdrive')
  ? path.join('/Volumes/gdrive/dev-cache', 'tarobot-release-target.noindex')
  : fileURLToPath(new URL('../client/src-tauri/target.noindex', import.meta.url))));
// Electron builds require explicit physical .noindex output/cache/target roots;
// packages stay in this task so hold/activation guards apply to them.
const electron = { output: path.join(lab, 'electron-output.noindex'), target,
  cache: noIndexDirectory(values.cache ?? path.join(path.dirname(target), 'tarobot-electron-cache.noindex')) };
const result = { lab, cargoTarget: target, electron, paths: Object.fromEntries(['macos-ready','previous-app','rollback','mac-updater-final-extracted','paint-candidate','native-acceptance'].map(name=>[name,path.join(lab,name)])), dryRun: !!values['dry-run'] };
if (!values['dry-run']) {
  await mkdir(root, {recursive:true});
  await mkdir(lab); // Never overwrite another Bot's workspace.
  const q = text => "'" + text.replaceAll("'", "'\\''") + "'";
  await writeFile(path.join(lab,'build-env.sh'), '#!/bin/sh\nexport TAROBOT_ARTIFACT_ROOT='+q(root)+'\nexport TAROBOT_RELEASE_LAB='+q(lab)+'\nexport CARGO_TARGET_DIR='+q(target)+'\nexport TAROBOT_DESKTOP_OUTPUT='+q(electron.output)+'\nexport TAROBOT_ELECTRON_CACHE='+q(electron.cache)+'\nexport TAROBOT_DESKTOP_TARGET='+q(electron.target)+'\n');
  await writeFile(path.join(lab,'artifact-workspace.json'),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result,null,2));
