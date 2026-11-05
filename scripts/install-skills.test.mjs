import {test} from 'vitest';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {integrationAssets} from './integration-assets.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
test('selected skill installation includes references, preserves unrelated data and packages the same resources', async()=>{
 const destination=await mkdtemp(path.join(os.tmpdir(),'baoyu-skill-install-'));
 try{
  await writeFile(path.join(destination,'unrelated.txt'),'keep');
  execFileSync('bash',[path.join(root,'scripts/install-skills.sh'),'--skill','baoyu-design','--skill','baoyu-ppt','--destination',destination]);
  assert.equal(await readFile(path.join(destination,'unrelated.txt'),'utf8'),'keep');
  for(const name of ['baoyu-design','baoyu-ppt']){
   const skill=await readFile(path.join(destination,name,'SKILL.md'),'utf8');assert.match(skill,/ordinary/i);
   const files=(await readdir(path.join(root,'skills',name),{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>path.relative(path.join(root,'skills',name),path.join(entry.parentPath,entry.name)));
   for(const file of files){
    assert.deepEqual(await readFile(path.join(destination,name,file)),await readFile(path.join(root,'skills',name,file)));
    assert.ok(integrationAssets.includes(`skills/${name}/${file}`));
   }
  }
  const before=await readdir(destination);
  assert.throws(()=>execFileSync('bash',[path.join(root,'scripts/install-skills.sh'),'--skill','../bad','--destination',destination],{stdio:'pipe'}));
  assert.deepEqual(await readdir(destination),before);
 }finally{await rm(destination,{recursive:true,force:true});}
});
