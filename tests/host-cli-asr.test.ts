import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it, expect } from 'vitest';
const exec=promisify(execFile);
it('ASR CLI checks state without creating a Hub and requires explicit install confirmation',async()=>{
  const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'asr-cli-')));
  const args=[path.resolve('bin/tarobot.mjs'),'integrations','asr'];
  const options={env:{...process.env,HOME:home,USERPROFILE:home},timeout:15000};
  try{
    await expect(exec(process.execPath,[...args,'install','--json'],options)).rejects.toMatchObject({code:1});
    await expect(exec(process.execPath,[...args,'status','--state-dir',home,'--json'],options)).rejects.toMatchObject({code:1});
    const {stdout}=await exec(process.execPath,[...args,'status','--json'],options);
    const state=JSON.parse(stdout);expect(state.installed).toBe(false);expect(state.job).toBeNull();
    expect(await readdir(home)).toEqual([]);
  }finally{await rm(home,{recursive:true,force:true});}
});
