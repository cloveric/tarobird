import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-shell.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Workspace } from "../../src/App.js";
import { HubConnection } from "../../src/connection.js";
import { ClientCache } from "../../src/storage.js";
import { applyAppearance } from "../../src/appearance.js";
import type { ScreenStatus } from "../../../src/client-protocol/remote-screen.js";

// Real Workspace and cache. Only Host responses/native IPC are replaced.
// No capture, protected operation, native input or real device grants.
const calls: string[] = [];
const display = { id:"display", nativeId:"1", name:"测试显示器", revision:1, x:0, y:0, width:1280, height:720, scale:1, rotation:0 };
const statuses: Record<string, ScreenStatus> = Object.fromEntries(["a", "b"].map(key => [key, {
  supported:true, enabled:true, canManage:false, permission:"view", serverTime:Date.now(), sessions:[],
  desktop:{desktopId:`desktop-${key}`, instanceId:"fixture", loginSession:"fixture", platform:"macos", capture:"granted", accessibility:false, locked:false, displays:[display]},
}])) as Record<string, ScreenStatus>;
const params = new URLSearchParams(location.search);
if (!params.has("web")) Object.assign(window, { tarobotDesktop: { version:1, engine:"electron", platform:"darwin", on:()=>()=>{}, openSocket:async()=>{}, invoke:async(command:string) => {
  calls.push(command);
  if (command === "desktop_window_read") return {x:0,y:0,width:innerWidth,height:innerHeight,outerWidth:innerWidth,outerHeight:innerHeight,scale:1,maximized:true,fullscreen:false,resizable:true,work:{x:0,y:0,width:innerWidth,height:innerHeight}};
  if (command === "desktop_host") return {running:false};
  return null;
} } });
applyAppearance({ theme:"light", palette:"mono", monoAccent:"warm-gray", animations:true });
async function main() {
  const connections = await Promise.all(["a", "b"].map(async key => {
    const cache = new ClientCache(`screen-entry-${key}-${crypto.randomUUID()}`);
    const conversation = {id:`chat-${key}`,title:`主机 ${key.toUpperCase()} 的工作对话`,type:"direct" as const,ownerId:"owner",botIds:["bot"],archived:false,createdAt:1};
    await cache.saveConversations([conversation]); await cache.saveSelectedConversation(conversation.id);
    const connection = new HubConnection({deviceId:`gui-${key}`,name:`Host ${key}`,publicKey:"fixture",hubPublicKey:key,routes:[]},cache);
    await cache.saveIdentity(connection.identity);
    connection.start = async()=>{}; connection.resume=()=>{};
    connection.state = {...connection.state,status:"online",screenAvailable:true,user:{id:"owner",name:"Owner",role:"owner"},bots:[{id:"bot",name:"工作助手",online:true,engine:"codex"}]};
    connection.screenStatus = async()=>{calls.push(`status:${key}`);return structuredClone(statuses[key]);};
    connection.screenOpen = async()=>{calls.push(`open:${key}`);throw Error("screen_connect_timeout");};
    connection.screenConfigure = async()=>{calls.push(`configure:${key}`);throw Error("unexpected_grant");};
    return connection;
  }));
  function Fixture() { const [index,setIndex] = useState(0); return <><button style={{position:"fixed",bottom:0,left:0,zIndex:999}} onClick={()=>setIndex(i=>1-i)}>Switch fixture host</button><Workspace key={index} connection={connections[index]} forget={async()=>{}}/></>; }
  Object.assign(window,{screenEntryFixture:{calls,statuses,connections}});
  createRoot(document.getElementById("root")!).render(<Fixture/>);
}
void main();
