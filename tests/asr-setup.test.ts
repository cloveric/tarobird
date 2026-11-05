import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { parseIntegrationEnvironment } from "../src/runtime/integration-environment.js";
import { standardAsrReady } from "../src/runtime/qwen-asr-paths.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QwenAsrSetup, type AsrExecutor } from "../src/runtime/qwen-asr-setup.js";
import { HubServer } from "../src/hub/server.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { startHubControl } from "../src/hub/service.js";
import { createDefaultTranscribeVoice } from "../src/core/voice.js";

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const temp=async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'asr-setup-'));roots.push(root);return root;};
const idle={platform:'darwin',supported:true,installed:false,pythonPresent:true,modelPresent:false,running:false,managed:false,legacyService:false,activeRequests:null,watchdog:null,autostart:'disabled'};
const command={requestId:'install-one',model:true,service:true};

it.skipIf(process.platform === 'win32')('persists phases and receipts, coalesces starts, and never reruns a completed request',async()=>{
  let release!:()=>void, runs=0;const gate=new Promise<void>(r=>release=r);
  const home=await temp();
  const exec:AsrExecutor=async(args,_signal,phase)=>{if(args.includes('--status'))return JSON.stringify(idle);runs++;phase?.('model');await gate;return '';};
  const setup=new QwenAsrSetup(home,exec);
  await setup.start(command);
  expect(await setup.start({...command,requestId:'duplicate-click'})).toMatchObject({requestId:command.requestId});
  await vi.waitFor(async()=>expect((await setup.status()).job?.phase).toBe('model'));
  release();await setup.wait();
  expect((await setup.status()).job?.status).toBe('completed');expect(runs).toBe(1);
  const fresh=new QwenAsrSetup(home,exec);await fresh.start(command);expect(runs).toBe(1);
  await expect(fresh.start({...command,model:false})).rejects.toThrow('installation_request_conflict');
});

it.skipIf(process.platform === 'win32')('records a failure and closes installation without claiming completion',async()=>{
  const home=await temp();
  const setup=new QwenAsrSetup(home,async(args,signal)=>{
    if(args.includes('--status'))return JSON.stringify(idle);
    await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('secret path must not escape')),{once:true}));return '';
  });
  await setup.start(command);await setup.close();
  expect((await setup.status()).job).toMatchObject({status:'interrupted',error:'installation_failed'});
  const failed=new QwenAsrSetup(home,async(args)=>{if(args.includes('--status'))return JSON.stringify(idle);throw new Error('insufficient_disk_space');});
  await failed.start({...command,requestId:'install-two'});await failed.wait();
  expect((await failed.status()).job).toMatchObject({status:'failed',error:'insufficient_disk_space'});
});

it.skipIf(process.platform === 'win32')('requires owner authentication and strict input at the Hub; Bot credentials cannot install',async()=>{
  const root=await temp(),home=await temp();let runs=0;
  const setup=new QwenAsrSetup(home,async(args)=>{if(args.includes('--status'))return JSON.stringify(idle);runs++;return '';});
  const hub=await HubServer.start({stateDir:root,asrSetup:setup});
  const close=await startHubControl(root,{running:true,pid:process.pid,url:hub.url,instanceUrl:hub.instanceUrl,publicKey:hub.auth.publicKey},()=>{}, {enrollController:value=>hub.enrollLocalController(value)});
  const client=await LocalHostClient.connect(root,{enroll:true});
  try {
    expect(client.ready.serverCapabilities).toContain('integrations.asr.v1');
    expect((await fetch(hub.url+'/api/integrations/asr')).ok).toBe(false);
    await expect(client.request('/api/integrations/asr/install','POST',{...command,command:'arbitrary'})).rejects.toThrow();
    expect(await client.request('/api/integrations/asr')).toMatchObject(idle);
    await client.request('/api/integrations/asr/install','POST',command);await setup.wait();
    expect(runs).toBe(1);
    await expect(client.request('/api/integrations/asr/install','POST',{...command,model:false})).rejects.toMatchObject({status:409});
    expect(await client.request('/api/integrations/asr')).toMatchObject({job:{status:'completed'}});
    const log=await hub.store.db.all("SELECT kind FROM audit_log WHERE kind='asr.install-requested'");expect(log).toHaveLength(1);
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    await expect(client.request('/api/integrations/asr/install','POST',{...command,requestId:'denied'})).rejects.toThrow();
    expect(runs).toBe(1);
  }finally{client.close();await close();await hub.close();}
});

it.each([400,422,429,503])('does not treat HTTP %s as a service failure or restart trigger',async status=>{
  const watchdog={recordSuccess:vi.fn(),recordFailure:vi.fn()};
  const voice=createDefaultTranscribeVoice({env:{},httpUrl:'http://127.0.0.1:8412/transcribe',cliPython:'',cliScript:'',
    fetchImpl:vi.fn(async()=>new Response('',{status})),watchdog,
    execFileImpl:((_file:any,_args:any,_options:any,callback:any)=>callback(null,'1','')) as any});
  await expect(voice('/fixture/test.wav')).rejects.toThrow(`ASR HTTP server returned ${status}`);
  expect(watchdog.recordFailure).not.toHaveBeenCalled();
});


it.skipIf(process.platform === 'win32')('does not displace another process installation and reports orphaned jobs as interrupted',async()=>{
  const home=await temp();await mkdir(path.join(home,'.tarobot'));
  const file=path.join(home,'.tarobot/asr-setup.json');
  const running={...command,status:'running',phase:'checking',pid:process.pid,startedAt:Date.now()};
  await writeFile(file,JSON.stringify({jobs:[running]}));let runs=0;
  const setup=new QwenAsrSetup(home,async()=>{runs++;return JSON.stringify(idle);});
  expect((await setup.start({...command,requestId:'other-process'})).requestId).toBe(command.requestId);expect(runs).toBe(0);
  await writeFile(file,JSON.stringify({jobs:[{...running,startedAt:Date.now()-4_000_000}]}));
  expect((await setup.status()).job?.status).toBe('interrupted');
});

it('uses published readiness and preserves literal env paths including shell metacharacters',async()=>{
  const home=await temp();await writeFile(path.join(home,'transcribe.py'),'fixture');expect(standardAsrReady(home)).toBe(true);
  await writeFile(path.join(home,'installation.json'),'{"ready":false}');expect(standardAsrReady(home)).toBe(false);
  const value = `/fixture/a b/"$back\`tick`;
  const {stdout}=await promisify(execFile)('python3',['-c',`import importlib.util,sys
s=importlib.util.spec_from_file_location('i','scripts/qwen-asr-install.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print('ASR_MODEL_PATH='+m.env_quote(sys.argv[1]))`,value]);
  expect(parseIntegrationEnvironment(stdout).ASR_MODEL_PATH).toBe(value);
});

it.skipIf(process.platform === 'win32')('reads the receipt requested by a retry rather than a newer failed install',async()=>{
  const home=await temp();let attempts=0;
  const setup=new QwenAsrSetup(home,async args=>{if(args.includes('--status'))return JSON.stringify(idle);if(++attempts>1)throw new Error('fixture_failure');return '';});
  await setup.start(command);await setup.wait();
  await setup.start({...command,requestId:'later'});await setup.wait();
  expect((await setup.status()).job).toMatchObject({requestId:'later',status:'failed'});
  expect(await setup.start(command)).toMatchObject({requestId:command.requestId,status:'completed'});
  expect((await setup.status(command.requestId)).job).toMatchObject({requestId:command.requestId,status:'completed'});
  expect(attempts).toBe(2);
});

it.skipIf(process.platform === 'win32')('does not treat a reused live PID as the previous installer',async()=>{
  const home=await temp();await mkdir(path.join(home,'.tarobot'));
  await writeFile(path.join(home,'.tarobot/asr-setup.json'),JSON.stringify({jobs:[{...command,status:'running',phase:'checking',pid:process.pid,startedAt:Date.now(),processEpoch:{processBirth:process.platform+':1'},futureField:true}]}));
  const setup=new QwenAsrSetup(home,async()=>JSON.stringify(idle));
  expect((await setup.status()).job?.status).toBe('interrupted');
  expect((await setup.start({...command,requestId:'replacement'})).requestId).toBe('replacement');await setup.wait();
});
