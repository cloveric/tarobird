// Exercises iOS core source with real Apple Foundation/Security on this Mac.
// Does not build an iOS app, install a CA, accept SDK terms, or touch user data.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
const repo=fileURLToPath(new URL("../../",import.meta.url));
const output=path.resolve(process.argv[2] ?? await mkdtemp(path.join(os.tmpdir(),"tarocub-ios-receipt-")));
await mkdir(output,{recursive:true});
const scratch=await mkdtemp(path.join(os.tmpdir(),"tarocub-ios-tls-"));
async function run(command,args,name,timeout) {
  const log=createWriteStream(path.join(output,name));
  const child=spawn(command,args,{cwd:repo,env:{...process.env,TMPDIR:scratch},detached:true,stdio:["ignore","pipe","pipe"]});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  const kill=()=>{if(child.pid)try{process.kill(-child.pid,"SIGTERM");}catch(error){if(!["ESRCH","EPERM"].includes(error.code))throw error;}};
  let expired=false;const timer=setTimeout(()=>{expired=true;kill();},timeout);
  try {const code=await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});if(expired||code!==0)throw Error(`${name}: ${expired?"timeout":`exit ${code}`}`);}
  finally{clearTimeout(timer);kill();await new Promise(resolve=>log.end(resolve));}
}
try {
  // Validate Swift/ObjC plugin declarations against the installed Capacitor
  // headers with a macOS-only convenience-method overlay. Not an iOS build.
  const headers=path.join(repo,"client/node_modules/@capacitor/ios/Capacitor/Capacitor");
  const module=path.join(scratch,"Capacitor");await mkdir(module);
  await writeFile(path.join(module,"BridgeHeaders.h"),`#import <Foundation/Foundation.h>\n@class UIViewController;\n#import "${headers}/CAPBridgedPlugin.h"\n`);
  await writeFile(path.join(module,"module.modulemap"),'module Capacitor { header "BridgeHeaders.h" export * }\n');
  await run("swiftc",["-swift-version","5","-target",`${process.arch==="arm64"?"arm64":"x86_64"}-apple-macosx13.0`,"-typecheck","-I",scratch,"client/ios/tests/CapacitorCompileOverlay.swift","client/ios/App/App/HubTLS.swift","client/ios/App/App/HubTransport.swift","client/ios/App/App/HubTransportPlugin.swift"],"plugin-typecheck.log",90_000);
  const binary=path.join(scratch,"HubTLSChecks");
  await run("swiftc",["-D","HUB_TRANSPORT_AUDIT","-swift-version","5","-target",`${process.arch==="arm64"?"arm64":"x86_64"}-apple-macosx13.0`,"-O","client/ios/App/App/HubTLS.swift","client/ios/App/App/HubTransport.swift","client/ios/tests/HubTLSChecks.swift","client/ios/tests/HubTransportChecks.swift","-o",binary],"compile.log",90_000);
  await run("/usr/bin/time",["-l",binary,repo,scratch,path.join(output,"ios-foundation-result.json")],"run.log",180_000);
  console.log(await readFile(path.join(output,"ios-foundation-result.json"),"utf8"));
}finally{await rm(scratch,{recursive:true,force:true});}
