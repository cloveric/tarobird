import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HubServer } from "../src/hub/server.js";
import { desktopTls } from "../src/hub/desktop-tls.js";
// Bundler resolves the exact verifier imported by packaged Electron main.
// @ts-ignore JavaScript Electron boundary
import { screenRoute, screenPin, openScreenSocket } from "../client/electron/screen-network.mjs";
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.reverse())await close();cleanup.length=0;});
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),"screen-tls-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));const certs=await desktopTls(root,["127.0.0.1"]);const hub=await HubServer.start({stateDir:root,tls:{cert:await readFile(certs.cert),key:await readFile(certs.key)}});cleanup.push(()=>hub.close());const route=screenRoute({url:hub.url,publicKey:hub.auth.publicKey,certificateAuthority:certs.certificateAuthority});return{hub,route,root};}
it("uses private CA, hostname and canonical Host proof before a fresh pinned socket",async()=>{
 const {hub,route}=await fixture();const pin=await screenPin(route);expect(pin).toMatch(/^[a-f0-9]{64}$/);let upgrades=0;hub.http.on("upgrade",()=>upgrades++);
 const closed=new Promise<void>(resolve=>{openScreenSocket(route,pin,"control","a".repeat(43),{close:()=>resolve()});});await closed;expect(upgrades).toBe(1);
});
it("wrong Host identity and wrong leaf pin fail before any ticket is delivered",async()=>{
 const {hub,route}=await fixture();const second=await fixture();await expect(screenPin({...route,publicKey:second.hub.auth.publicKey})).rejects.toThrow("tls_identity_mismatch");
 let upgrades=0;hub.http.on("upgrade",()=>upgrades++);await new Promise<void>(resolve=>{openScreenSocket(route,"0".repeat(64),"control","a".repeat(43),{close:()=>resolve()});});expect(upgrades).toBe(0);
});
it("custom CA replaces roots and IP route has no SNI",async()=>{
 const a=await fixture(),b=await fixture();expect(a.route.tls.servername).toBe("");const wrong=screenRoute({url:a.hub.url,publicKey:a.hub.auth.publicKey,certificateAuthority:b.route.certificateAuthority});await expect(screenPin(wrong)).rejects.toThrow();
});
it("TLS loopback cannot impersonate the private target listener",async()=>{
 const {hub,route}=await fixture();const result=await new Promise<string>(resolve=>{const ws=new WebSocket(hub.url.replace("https:","wss:")+"/screen/v1/target",route.tls);ws.on("open",()=>{resolve("open");ws.close();});ws.on("error",()=>resolve("rejected"));});expect(result).toBe("rejected");
});
it("rejects public plaintext, credentials, fragments and arbitrary media endpoints",()=>{
 const publicKey="a".repeat(59)+"=";
 for(const url of ["http://example.com","https://u:p@example.com/","https://example.com/path","https://example.com/#fragment"])expect(()=>screenRoute({url,publicKey})).toThrow();
});
