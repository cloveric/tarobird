import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID, sign } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { startHubControl, controlPath, inspectHubService } from "../src/hub/service.js";
import { deviceFields, enrollTrusted, loginFor, testDevice } from "./helpers/pairing-invite.js";
import { hashSecret } from "../src/hub/auth.js";
import { screenConfigureText } from "../src/client-protocol/remote-screen.js";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import { writeScreenFrame } from "../src/client-protocol/screen-wire.js";
const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanups.reverse())await close();cleanups.length=0;});
async function fixture(){
 const dir=await mkdtemp(path.join(os.tmpdir(),"screen-ws-"));cleanups.push(()=>rm(dir,{recursive:true,force:true}));
 const hub=await HubServer.start({stateDir:dir});cleanups.push(()=>hub.close());
 const owner=testDevice("local"),viewer=testDevice("viewer");await hub.enrollLocalController(deviceFields(owner));await enrollTrusted(hub.auth,viewer);
 const local=await loginFor(hub.auth,owner),remote=await loginFor(hub.auth,viewer);
 const command={operation:"screen.configure" as const,expectedRevision:0,enabled:true,requestId:randomUUID(),grants:[{deviceId:viewer.deviceId,publicKey:viewer.publicKey,permission:"control" as const}]};
 const statement=await hub.auth.prepareDeviceAction({operation:"screen-grant",target:hashSecret(screenConfigureText(command))},local.token,local.session);
 await hub.remoteScreen.configure(local.session,command,{nonce:statement.nonce,signature:sign(null,Buffer.from(deviceActionProofText(statement)),owner.privateKey).toString("base64")});
 const desktop={desktopId:"desktop",instanceId:"instance",loginSession:"login",platform:"macos",capture:"granted",accessibility:true,locked:false,displays:[{id:"display",nativeId:"1",name:"Display",revision:1,x:0,y:0,width:1280,height:720,scale:1,rotation:0}]};
 return{dir,hub,local,remote,desktop,owner,viewer};
}
function connect(url:string,autoPong=true){
 const ws=new WebSocket(url,{autoPong});const values:unknown[]=[];let closed=false;
 ws.on("message",(data,binary)=>values.push(binary?new Uint8Array(data as Buffer):JSON.parse(data.toString())));ws.on("error",()=>{});ws.on("close",()=>{closed=true;});
 cleanups.push(async()=>ws.terminate());
 return{ws,values,get closed(){return closed;},ready:new Promise<void>((resolve,reject)=>{ws.once("open",()=>resolve());ws.once("error",reject);}),send:(v:unknown)=>ws.send(JSON.stringify(v))};
}
const wait=async(check:()=>boolean,timeout=2000)=>{const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error("test_wait_timeout");await new Promise(r=>setTimeout(r,5));}};
it("reserves bounded local target capacity when unauthenticated viewer slots are full", async () => {
 const f = await fixture(), base = f.hub.instanceUrl.replace("http:", "ws:");
 const pending = Array.from({length: 16}, () => connect(base + "/screen/v1/control"));
 await Promise.all(pending.map(socket => socket.ready));
 const extraViewer = connect(base + "/screen/v1/control");
 await expect(extraViewer.ready).rejects.toThrow();
 const source = connect(base + "/screen/v1/target"); await source.ready;
 source.send({type:"hello",ticket:f.hub.remoteScreen.serviceTicket("desktop").ticket,desktop:f.desktop});
 await wait(() => source.values.some((v:any) => v.type === "registered"));
 // Target capacity is bounded too and remains exclusive to the instance listener.
 const localPending = Array.from({length: 3}, () => connect(base + "/screen/v1/target-media"));
 await Promise.all(localPending.map(socket => socket.ready));
 await expect(connect(base + "/screen/v1/target").ready).rejects.toThrow();
 expect((await f.hub.remoteScreen.status(f.local.session)).desktop?.desktopId).toBe("desktop");
});
it("forwards ordered config and binary video on separate sockets and revokes all channels",async()=>{
 const f=await fixture(),base=f.hub.instanceUrl.replace("http:","ws:");
 const source=connect(base+"/screen/v1/target");await source.ready;
 source.send({type:"hello",ticket:f.hub.remoteScreen.serviceTicket("desktop").ticket,desktop:f.desktop});await wait(()=>source.values.length===1);
 const j=await f.hub.remoteScreen.open(f.remote.session,{desktopId:"desktop",displayId:"display",displayRevision:1,requestId:randomUUID()});
 const control=connect(base+"/screen/v1/control"),media=connect(base+"/screen/v1/media");await Promise.all([control.ready,media.ready]);
 control.send({type:"hello",ticket:j.controlTicket});media.send({type:"hello",ticket:j.mediaTicket});await wait(()=>source.values.some((v:any)=>v.type==="start"));
 const start:any=source.values.find((v:any)=>v.type==="start"),target=connect(base+"/screen/v1/target-media");await target.ready;target.send({type:"hello",ticket:start.mediaTicket});await wait(()=>target.values.length===1);
 target.send({type:"stream",streamGeneration:1,geometryRevision:1,codec:"vp8",codecString:"vp8",width:1280,height:720,contentRect:{x:0,y:0,width:1280,height:720}});
 const packet=writeScreenFrame({key:true,codec:"vp8",streamGeneration:1,geometryRevision:1,sequence:1,captureMs:Date.now(),width:1280,height:720},new Uint8Array([1,2,3]));target.ws.send(packet);
 await wait(()=>media.values.some(v=>v instanceof Uint8Array));expect(media.values.filter((v:any)=>v.type==="stream")).toHaveLength(1);expect(media.values.at(-1)).toEqual(packet);
 await f.hub.auth.revoke("viewer","local-owner");await wait(()=>control.closed&&media.closed&&target.closed);
 expect((await f.hub.remoteScreen.status(f.local.session)).sessions).toHaveLength(0);
});
it("screen service bootstrap requires local token AND expected Host identity",async()=>{
 const f=await fixture();const stop=await startHubControl(f.dir,{running:true,pid:process.pid,url:f.hub.url,instanceUrl:f.hub.instanceUrl,publicKey:f.hub.auth.publicKey},()=>{}, {screenServiceTicket:id=>f.hub.remoteScreen.serviceTicket(id)});cleanups.push(stop);
 const raw=(value:unknown)=>new Promise<string>(resolve=>{let data="";const socket=net.createConnection(controlPath(f.dir));socket.on("connect",()=>socket.write(JSON.stringify(value)+"\n"));socket.on("data",v=>data+=v.toString());socket.on("close",()=>resolve(data));socket.on("error",()=>resolve(data));});
 const token=(await readFile(path.join(f.dir,"hub-control.key"),"utf8")).trim();
 for(const v of [{expectedPublicKey:f.hub.auth.publicKey},{token,expectedPublicKey:"wrong"}])expect(await raw({command:"screen-service-ticket",desktopId:"desktop",...v})).toBe("");
 const result=await inspectHubService(f.dir,"screen-service-ticket",{desktopId:"desktop",expectedPublicKey:f.hub.auth.publicKey});
 expect(result).toMatchObject({running:true,instancePort:Number(new URL(f.hub.instanceUrl).port)});expect((result as any).screenServiceTicket.ticket).toHaveLength(43);
});
it("viewers cannot inject binary data onto the control channel",async()=>{
 const f=await fixture();const service=f.hub.remoteScreen.serviceTicket("desktop");f.hub.remoteScreen.registerService(service.ticket,f.desktop,{send:()=>true,close:()=>{}});
 const j=await f.hub.remoteScreen.open(f.remote.session,{desktopId:"desktop",displayId:"display",displayRevision:1,requestId:randomUUID()});const control=connect(f.hub.instanceUrl.replace("http:","ws:")+"/screen/v1/control");await control.ready;control.send({type:"hello",ticket:j.controlTicket});await wait(()=>control.values.length>0);control.ws.send(Buffer.from([1]));await wait(()=>control.closed);expect((await f.hub.remoteScreen.status(f.remote.session)).sessions).toHaveLength(0);
});
it("CLI screen grants and stop use the same signed HTTP authorization",async()=>{
 const f=await fixture();const stop=await startHubControl(f.dir,{running:true,pid:process.pid,url:f.hub.url,instanceUrl:f.hub.instanceUrl,publicKey:f.hub.auth.publicKey},()=>{}, {enrollController:c=>f.hub.enrollLocalController(c)});cleanups.push(stop);
 const {LocalHostClient}=await import("../src/host-cli/client.js"),{screenCommand}=await import("../src/host-cli/screens.js");
 const cli=await LocalHostClient.connect(f.dir,{enroll:true});cleanups.push(async()=>cli.close());
 const status:any=await screenCommand(cli,"status");expect(status.canManage).toBe(true);expect(status.devices.find((d:any)=>d.id==="viewer").publicKey).toHaveLength(60);
 await expect(screenCommand(cli,"disable")).rejects.toThrow("--yes");
 await screenCommand(cli,"revoke","viewer",{yes:true});expect((await f.hub.remoteScreen.status(f.remote.session)).permission).toBe("none");
 await screenCommand(cli,"allow","viewer",{yes:true,permission:"view"});expect((await f.hub.remoteScreen.status(f.remote.session)).permission).toBe("view");
 await screenCommand(cli,"disable",undefined,{yes:true});expect((await f.hub.remoteScreen.status(f.remote.session)).enabled).toBe(false);
});

it("reclaims a paused authenticated viewer after a real-time pong timeout without stopping a healthy target service",async()=>{
 const f=await fixture();
 const {epoch}=f.hub.remoteScreen.registerService(f.hub.remoteScreen.serviceTicket("desktop").ticket,f.desktop,{send:()=>true,close:()=>{}});
 const heartbeat=setInterval(()=>f.hub.remoteScreen.serviceStatus(epoch,f.desktop),500);cleanups.push(async()=>clearInterval(heartbeat));
 const join=await f.hub.remoteScreen.open(f.remote.session,{desktopId:"desktop",displayId:"display",displayRevision:1,requestId:randomUUID()});
 const base=f.hub.instanceUrl.replace("http:","ws:"),control=connect(base+"/screen/v1/control",false),media=connect(base+"/screen/v1/media");
 await Promise.all([control.ready,media.ready]);control.send({type:"hello",ticket:join.controlTicket});media.send({type:"hello",ticket:join.mediaTicket});
 await wait(()=>control.values.some((v:any)=>v.type==="attached")&&media.values.some((v:any)=>v.type==="attached"));
 control.send({type:"visibility",sessionId:join.session.id,generation:join.session.generation,visible:false});
 await wait(()=>control.values.some((v:any)=>v.type==="state"&&v.session.state==="paused"));
 await wait(()=>control.closed&&media.closed,17000);
 const status=await f.hub.remoteScreen.status(f.local.session);expect(status.sessions).toHaveLength(0);expect(status.desktop?.desktopId).toBe("desktop");
},20000);

it.each(["screen_frame_stale", "screen_lease_expired", "screen_renew_expired", "screen_input_stale", "screen_control_not_authorized", "screen_accessibility_denied"])("%s releases control but keeps real viewer sockets alive", async reason => {
 const f=await fixture(), values:any[]=[];
 const {epoch}=f.hub.remoteScreen.registerService(f.hub.remoteScreen.serviceTicket("desktop").ticket,f.desktop,{send:value=>{values.push(value);return true;},close:()=>{}});
 const j=await f.hub.remoteScreen.open(f.remote.session,{desktopId:"desktop",displayId:"display",displayRevision:1,requestId:randomUUID()});
 const base=f.hub.instanceUrl.replace("http:","ws:"),control=connect(base+"/screen/v1/control"),media=connect(base+"/screen/v1/media");
 await Promise.all([control.ready,media.ready]);control.send({type:"hello",ticket:j.controlTicket});media.send({type:"hello",ticket:j.mediaTicket});
 await wait(()=>values.some(v=>v.type==="start"));
 const ids={sessionId:j.session.id,generation:j.session.generation};
 const frame=(sequence:number,streamGeneration:number,config=true)=>{
  if(config)f.hub.remoteScreen.stream(epoch,j.session.id,j.session.generation,{type:"stream",streamGeneration,geometryRevision:1,codec:"vp8",codecString:"vp8",width:1280,height:720,contentRect:{x:0,y:0,width:1280,height:720}});
  const captureMs=Date.now();
  expect(f.hub.remoteScreen.frame(epoch,j.session.id,j.session.generation,{key:true,codec:"vp8",streamGeneration,geometryRevision:1,sequence,captureMs,width:1280,height:720},new Uint8Array([sequence]))).toBe(true);
  f.hub.remoteScreen.viewerCommand(j.session.id,{type:"ack",...ids,frameSequence:sequence});f.hub.remoteScreen.serviceFrameConfirmed(epoch,j.session.id,sequence,captureMs,streamGeneration);return captureMs;
 };
 frame(1,1);f.hub.remoteScreen.viewerCommand(j.session.id,{type:"control",...ids,frameSequence:1});
 const captured=frame(2,2),lease=values.findLast(v=>v.type==="lease");f.hub.remoteScreen.serviceLeaseReady(epoch,j.session.id,lease.leaseId);
 await wait(()=>control.values.some((v:any)=>v.type==="state"&&v.lease));
 const input={type:"input",...ids,desktopId:"desktop",displayId:"display",displayRevision:1,leaseId:lease.leaseId,sequence:1,frameSequence:2,expiresAt:captured+2000,event:{kind:"move",x:.5,y:.5}};
 if(reason==="screen_control_not_authorized"){
  const policy=(await f.hub.remoteScreen.status(f.local.session)).policy!;
  const command={operation:"screen.configure" as const,expectedRevision:policy.revision,enabled:true,requestId:randomUUID(),grants:[{deviceId:f.viewer.deviceId,publicKey:f.viewer.publicKey,permission:"view" as const}]};
  const statement=await f.hub.auth.prepareDeviceAction({operation:"screen-grant",target:hashSecret(screenConfigureText(command))},f.local.token,f.local.session);
  await f.hub.remoteScreen.configure(f.local.session,command,{nonce:statement.nonce,signature:sign(null,Buffer.from(deviceActionProofText(statement)),f.owner.privateKey).toString("base64")});
 }
 if(reason==="screen_accessibility_denied")f.hub.remoteScreen.serviceStatus(epoch,{...f.desktop,accessibility:false});
 control.send(reason==="screen_control_not_authorized"||reason==="screen_accessibility_denied"?{type:"control",...ids,frameSequence:2}:reason==="screen_renew_expired"?{type:"renew",...ids,leaseId:lease.leaseId,frameSequence:2,challenge:"x".repeat(43)}:
  {...input,...(reason==="screen_frame_stale"?{frameSequence:999}:reason==="screen_lease_expired"?{leaseId:"x".repeat(43)}:{expiresAt:input.expiresAt+1})});
 await wait(()=>control.values.some((v:any)=>v.type==="state"&&v.session.reason===reason));
 expect((await f.hub.remoteScreen.status(f.local.session)).sessions).toMatchObject([{id:j.session.id,state:"viewing",reason}]);
 expect(values.filter(v=>v.type==="release")).toHaveLength(1);expect(values.some(v=>v.type==="input"||v.type==="stop")).toBe(false);
 frame(3,2,false);await wait(()=>control.values.some((v:any)=>v.type==="frame-ready"&&v.frameSequence===3));
 expect(control.closed||media.closed).toBe(false);expect(values.filter(v=>v.type==="lease")).toHaveLength(1);
 // Only recoverable control refusals are retained. A protocol violation still closes the group.
 control.send({type:"unknown",...ids});await wait(()=>control.closed&&media.closed);
 expect((await f.hub.remoteScreen.status(f.local.session)).sessions).toHaveLength(0);
});
