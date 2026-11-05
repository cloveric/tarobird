import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
const exec = promisify(execFile);
/** Execute the generated installer in an isolated filesystem with fake host tools.
 * This verifies real Bash control flow/file rollback, not Linux/systemd behavior. */
export async function installerHarness(directory: string) {
  const box = path.join(directory, "box"), bin = path.join(directory, "bin");
  await Promise.all([bin, `${box}/etc/systemd/system`, `${box}/etc/apt/apt.conf.d`, `${box}/run/systemd/system`, `${box}/dev/net`, `${box}/tmp`].map((p) => mkdir(p, { recursive: true })));
  await writeFile(`${box}/dev/net/tun`, "fixture");
  const program = `#!${process.execPath}
const fs=require('fs'),p=require('path'),cp=require('child_process');
const tool=p.basename(process.argv[1]),args=process.argv.slice(2),box=process.env.TEST_RELAY_BOX;
const statePath=box+'/services.json',logPath=box+'/commands.jsonl';
const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{};
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
const log=()=>fs.appendFileSync(logPath,JSON.stringify({tool,args})+'\\n');
const fail=(name)=>{const f=box+'/'+name;if(fs.existsSync(f)){fs.unlinkSync(f);process.exit(1)}};
function copy(src,dst){fs.mkdirSync(p.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);fs.chmodSync(dst,fs.statSync(src).mode&0o777)}
if(tool==='id'){if(args.includes('tarocub-relay'))console.log(args.includes('-u')?'999':'fixture');else console.log('0')}
else if(tool==='getent')console.log('tarocub-relay:x:999:999::/nonexistent:/usr/sbin/nologin');
else if(tool==='uname')console.log('x86_64');
else if(['apt-get','useradd','flock','sleep','sha256sum'].includes(tool)){}
else if(tool==='install'){
 log();let mode='755',dirs=false,files=[];for(let i=0;i<args.length;i++){if(args[i]==='-m')mode=args[++i];else if(['-o','-g'].includes(args[i]))i++;else if(args[i]==='-d')dirs=true;else files.push(args[i])}
 if(dirs){for(const f of files)fs.mkdirSync(f,{recursive:true,mode:parseInt(mode,8)})}else{fail('fail-install-'+p.basename(files[1]));copy(files[0],files[1]);fs.chmodSync(files[1],parseInt(mode,8))}
}
else if(tool==='cp'){let files=args.filter(a=>!a.startsWith('-'));let [src,dst]=files;if(args.includes('--parents'))dst+=src;copy(src,dst)}
else if(tool==='mv'){
 const [src,dst]=args.filter(a=>!a.startsWith('-'));
 try{fs.renameSync(src,dst)}catch(error){
  // Real mv also works when the temporary staging directory is on another disk.
  if(error.code!=='EXDEV')throw error;
  fs.cpSync(src,dst,{recursive:true,preserveTimestamps:true,verbatimSymlinks:true});
  const modes=(s,d)=>{const st=fs.lstatSync(s);if(st.isSymbolicLink())return;fs.chmodSync(d,st.mode&0o777);if(st.isDirectory())for(const name of fs.readdirSync(s))modes(p.join(s,name),p.join(d,name))};
  modes(src,dst);fs.rmSync(src,{recursive:true});
 }
}
else if(tool==='nft'){log();if(args[0]==='list'&&!fs.existsSync(box+'/nft-active'))process.exit(1);if(args[0]==='delete')fs.rmSync(box+'/nft-active',{force:true});else if(args[0]==='--file')copy(args[1],box+'/nft-active')}
else if(tool==='curl'){
 const url=args.at(-1),out=args.indexOf('--output');if(out>=0)fs.writeFileSync(args[out+1],'verified fixture archive');
 else if(url.endsWith('/v1/health'))console.log(JSON.stringify({healthy:true}));
 else{if(fs.existsSync(box+'/fail-health'))process.exit(1);console.log(JSON.stringify({service:'tarocub-relay',connected:false,pending:0,connections:0,publicPort:443,tunnelPort:7443}))}
}
else if(tool==='systemctl'){
 log();const cmd=args[0],names=args.slice(1).filter(a=>!a.startsWith('-'));if(['is-active','is-enabled'].includes(cmd)){const v=state[names[0]]||{};if(cmd==='is-active')process.exit(v.active?0:3);console.log(v.enabled?'enabled':'disabled');process.exit(v.enabled?0:1)}
 for(const name of names){const v=state[name]??={};if(cmd==='restart')fail('fail-restart-'+name);if(['start','restart'].includes(cmd)){v.active=true;if(cmd==='start'&&name==='tarocub-tailscaled.service'&&fs.existsSync(box+'/delay-tail-start')){fs.unlinkSync(box+'/delay-tail-start');fs.writeFileSync(box+'/tail-set-not-ready','2')}}else if(cmd==='stop')v.active=false;else if(cmd==='enable'){v.enabled=true;if(args.includes('--now'))v.active=true}else if(cmd==='disable'){v.enabled=false;if(args.includes('--now'))v.active=false}}save();
}
else if(tool==='tar'){
 const dest=args[args.indexOf('-C')+1];for(const name of ['node','ntfy','tailscale','tailscaled']){if(!args.some(a=>a.endsWith('/'+name)))continue;
 const code=name==='node'?${JSON.stringify(`#!${process.execPath}\nconst cp=require('child_process');if(process.argv[2]==='--version')console.log('v24.0.0');else{const r=cp.spawnSync(${JSON.stringify(process.execPath)},process.argv.slice(2),{stdio:'inherit',env:process.env});process.exit(r.status??1)}`)}:name==='tailscale'?${JSON.stringify(`#!${process.execPath}\nconst fs=require('fs'),a=process.argv.slice(2).filter(v=>!v.startsWith('--socket=')),b=process.env.TEST_RELAY_BOX,f=b+'/prefs.json';let p=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};if(a[0]==='status')console.log(JSON.stringify({BackendState:fs.existsSync(b+'/tail-auth')?'Running':'NeedsLogin'}));else if(a[0]==='up')fs.writeFileSync(b+'/tail-auth','yes');else if(a[0]==='set'){const ready=b+'/tail-set-not-ready',left=fs.existsSync(ready)?Number(fs.readFileSync(ready,'utf8')):0;if(left>0){fs.writeFileSync(ready,String(left-1));process.exit(1)}p.RelayServerPort=Number(a.find(v=>v.startsWith('--relay-server-port=')).split('=')[1]);p.RelayServerStaticEndpoints=a.find(v=>v.startsWith('--relay-server-static-endpoints=')).split('=')[1].split(',').filter(Boolean);fs.writeFileSync(f,JSON.stringify(p))}else if(a[0]==='debug')console.log(JSON.stringify(p));`)}:'#!/bin/sh\\nexit 0\\n';fs.writeFileSync(dest+'/'+name,code,{mode:0o755})}
}else{console.error('Unexpected harness command',tool);process.exit(1)}
`;
  const script = path.join(bin, "mock-tool"); await writeFile(script, program); await chmod(script, 0o755);
  for (const name of ["id", "getent", "uname", "apt-get", "useradd", "flock", "sleep", "sha256sum", "install", "cp", "mv", "nft", "curl", "systemctl", "tar"]) await symlink(script, path.join(bin, name));
  function relocate(value: string): string { return value.replaceAll("/opt/tarocub-relay", `${box}/opt/tarocub-relay`).replaceAll("/etc/", `${box}/etc/`).replaceAll("/run/systemd/system", `${box}/run/systemd/system`).replaceAll("test -c /dev/net/tun", `test -f ${box}/dev/net/tun`); }
  return {
    box, root: `${box}/opt/tarocub-relay`,
    async run(input: string) {
      // Embedded files must receive the same relocation as the outer installer.
      const rewritten = relocate(input.replace(/(<<'TAROCUB_DATA'\n)([A-Za-z0-9+/=\n]+)(\nTAROCUB_DATA)/g, (_all, before: string, data: string, after: string) => before + Buffer.from(relocate(Buffer.from(data, "base64").toString())).toString("base64") + after));
      const filename = path.join(directory, "install.sh"); await writeFile(filename, rewritten, { mode: 0o600 });
      return exec("bash", [filename], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: `${box}/tmp`, TAROCUB_SSH_PORT: "2222", TEST_RELAY_BOX: box }, timeout: 30_000, maxBuffer: 128_000 });
    },
    async commands(): Promise<Array<{ tool: string; args: string[] }>> { return (await readFile(`${box}/commands.jsonl`, "utf8")).trim().split("\n").map((s) => JSON.parse(s)); },
  };
}
