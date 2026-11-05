// Runs the production Android transport core on a JVM, never an Android APK.
// Trust exists only in the test process; no SDK/license or OS trust changes.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
const repo=fileURLToPath(new URL("../../",import.meta.url));
const output=path.resolve(process.argv[2] ?? await mkdtemp(path.join(os.tmpdir(),"tarocub-android-receipt-")));
const cache=process.env.TAROCUB_JVM_CACHE ?? path.join(os.homedir(),".cache/tarocub-mobile-tls");
const java=name=>process.env.TAROCUB_JAVA_HOME?path.join(process.env.TAROCUB_JAVA_HOME,"bin",name):name;
await mkdir(output,{recursive:true}); await mkdir(cache,{recursive:true});
const scratch=await mkdtemp(path.join(os.tmpdir(),"tarocub-android-run-"));
const dependencies=JSON.parse(await readFile(path.join(repo,"client/android/audit/dependencies.json"),"utf8"));
const jars=[];
async function run(command,args,name,timeout) {
  const log=createWriteStream(path.join(output,name));
  const child=spawn(command,args,{cwd:repo,env:{...process.env,TMPDIR:scratch},detached:true,stdio:["ignore","pipe","pipe"]});
  child.stdout.pipe(log,{end:false}); child.stderr.pipe(log,{end:false});
  const kill=()=>{ if(child.pid) try { process.kill(-child.pid,"SIGTERM"); } catch(error) { if(!["ESRCH","EPERM"].includes(error.code)) throw error; } };
  let timedOut=false; const timer=setTimeout(()=>{timedOut=true;kill();},timeout);
  try { const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);}); if(timedOut || code!==0) throw new Error(`${name}: ${timedOut?"timeout":`exit ${code}`}`); }
  finally { clearTimeout(timer);kill();await new Promise(resolve=>log.end(resolve)); }
}
try {
  for(const dependency of dependencies) {
    const jar=path.join(cache,path.basename(new URL(dependency.source).pathname));
    let bytes; try { bytes=await readFile(jar); } catch(error) { if(error.code!=="ENOENT") throw error; }
    if(!bytes) { const response=await fetch(dependency.source); if(!response.ok) throw new Error(`dependency ${response.status}`); bytes=Buffer.from(await response.arrayBuffer()); }
    if(createHash("sha256").update(bytes).digest("hex")!==dependency.sha256) throw new Error(`dependency hash mismatch: ${dependency.artifact}`);
    await writeFile(jar,bytes); jars.push(jar);
  }
  const classes=path.join(scratch,"classes");await mkdir(classes);
  const classpath=jars.join(path.delimiter),source=path.join(repo,"client/android/app/src/main/java/com/tarobot/client");
  await run(java("javac"),["--release","8","-cp",classpath,"-d",classes,path.join(source,"HubTls.java"),path.join(source,"HubTransport.java"),path.join(source,"HubSocket.java"),path.join(repo,"client/android/audit/NativeTlsAudit.java")],"compile.log",60_000);
  await run(java("java"),["-Xmx512m","-cp",classes+path.delimiter+classpath,"com.tarobot.client.NativeTlsAudit",repo,scratch,path.join(output,"android-jvm-result.json")],"run.log",180_000);
  console.log(await readFile(path.join(output,"android-jvm-result.json"),"utf8"));
} finally { await rm(scratch,{recursive:true,force:true}); }
