import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeTempRoot } from "./helpers/temp-files.js";
import { handleDelegationCoreCommand } from "../src/core/shared/delegation-commands.js";
import { parseAuditEvents } from "../src/state/audit-log.js";
import { delegationCommand, parseDelegationPlan } from "../src/bus/delegation-plan.js";
import { prepareCollaboration, settleCollaborationRestarts } from "../client/src/collaboration-task.js";
import type { CollaborationSnapshot } from "../src/client-protocol/collaboration.js";

async function execute(text: string, options: { delegate?: any; local?: any; signal?: AbortSignal; peers?: string[] } = {}) {
 const root = await mkdtemp(path.join(os.tmpdir(), "collaboration-task-"));
 const sent: string[] = [], delegate = options.delegate ?? vi.fn(async ({targetInstance}: any) => ({ text: `Result ${targetInstance}` }));
 const local = options.local ?? vi.fn(async () => ({text: "Original answer"}));
 try {
  await handleDelegationCoreCommand({stateDir: root, startedAt: Date.now(), locale: "zh", cfg: {}, normalized: {chatId: 1, userId: 1, chatType: "private", text, attachments: []}, context: {instanceName: "alpha", abortSignal: options.signal, api: {sendMessage: async (_id: number, message: string) => {sent.push(message); return {message_id: 1};}} as never}, bridge: {handleAuthorizedMessage: local}, delegateToInstance: delegate, loadBusConfig: async () => ({peers: options.peers ?? ["beta", "gamma"], parallel: ["gamma"], chain: ["beta"], verifier: "gamma", port: 0, secret: "test", maxDepth: 3, crew: null})});
  const audit = await readFile(path.join(root,"audit.log.jsonl"), "utf8").then(parseAuditEvents, () => []);
  return {sent, delegate, local, audit};
 } finally { await removeTempRoot(root); }
}
describe("per-task collaboration execution", () => {
 it("preserves multiline task text and executes only the selected members in the chosen order", async () => {
  const prompt = "Original task\n/verify quoted command\n-- literal flags";
  expect(parseDelegationPlan(delegationCommand("chain",["gamma","beta"],prompt).slice(7))).toEqual({targets:["gamma","beta"],prompt});
  const result = await execute(delegationCommand("chain",["gamma","beta"],prompt));
  expect(result.delegate.mock.calls.map((call: any) => call[0].targetInstance)).toEqual(["gamma","beta"]);
  expect(result.delegate.mock.calls[0][0].prompt).toBe(prompt);
  expect(result.delegate.mock.calls[1][0].prompt).toContain("Result gamma");
  expect(result.local).not.toHaveBeenCalled();
 });
 it.each(["/fan --bots=foreign -- task","/verify --bots=beta,gamma -- task","/chain --bots=alpha -- task","/fan --bots=beta,beta -- task","/chain --bots=../x -- task"])("rejects invalid plans before any work: %s",async text => {
  const result=await execute(text);expect(result.delegate).not.toHaveBeenCalled();expect(result.local).not.toHaveBeenCalled();expect(result.sent.join("\n")).toContain("任务未启动");
 });
 it("retains completed chain stages after failure and records actual completed count", async () => {
  const delegate=vi.fn().mockResolvedValueOnce({text:"Preserved first stage"}).mockRejectedValueOnce(new Error("peer offline"));
  const result=await execute("/chain --bots=beta,gamma -- task",{delegate});
  expect(result.sent.at(-1)).toContain("Preserved first stage");expect(result.sent.at(-1)).toContain("串联执行失败");
  expect(result.audit).toContainEqual(expect.objectContaining({outcome:"error",metadata:expect.objectContaining({stageCount:1})}));
 });
 it("retains an unverified original answer if the reviewer fails",async()=>{
  const result=await execute("/verify --bots=beta -- task",{delegate:vi.fn().mockRejectedValue(new Error("offline"))});
  expect(result.sent.at(-1)).toContain("尚未完成复核");expect(result.sent.at(-1)).toContain("Original answer");
 });
 it("does not report a partially failed parallel task as success",async()=>{
  const result=await execute("/fan --bots=beta,gamma -- task",{delegate:vi.fn(async({targetInstance}:any)=>{if(targetInstance==="beta")throw new Error("offline");return{text:"Retained gamma"};})});
  expect(result.sent.at(-1)).toContain("部分完成：2/3");expect(result.sent.at(-1)).toContain("Retained gamma");
  expect(result.audit).toContainEqual(expect.objectContaining({outcome:"error",metadata:expect.objectContaining({errorCount:1})}));
 });
 it("stops a chain between stages and keeps completed work",async()=>{
  const abort=new AbortController();const delegate=vi.fn(async()=>{abort.abort();return{text:"Completed before stop"};});
  const result=await execute("/chain --bots=beta,gamma -- task",{delegate,signal:abort.signal});
  expect(delegate).toHaveBeenCalledTimes(1);expect(result.sent.at(-1)).toContain("串联已停止");expect(result.sent.at(-1)).toContain("Completed before stop");
 });
 it.each(["ask beta", "fan", "chain", "verify", "btw"])("does not start a pre-cancelled %s task",async command=>{
  const abort=new AbortController();abort.abort();const result=await execute(`/${command} task`,{signal:abort.signal});
  expect(result.local).not.toHaveBeenCalled();expect(result.delegate).not.toHaveBeenCalled();expect(result.sent[0]).toContain("任务未启动");
 });
});

function snapshots(): Map<string,CollaborationSnapshot> {
 return new Map(["alpha","beta","gamma"].map(id=>[id,{revision:"a".repeat(64),listener:"offline",settings:{enabled:id==="alpha",peers:id==="alpha"?["gamma"]:[],maxDepth:3,parallel:[],chain:[],verifier:null,crew:null},peers:["alpha","beta","gamma"].filter(peer=>peer!==id).map(id=>({id,name:id,online:true,listener:"offline",allowsThisBot:false}))}]));
}
function connection(data:Map<string,CollaborationSnapshot>, fail?:string){
 const writes:any[]=[];const reads:string[]=[];const restarts:any[]=[];
 const http=vi.fn(async(route:string,options?:any)=>{
  const id=route.split("/")[3]!;
  if(route.endsWith("/restart")){restarts.push({id,...JSON.parse(options.body)});return{ok:true};}
  if(options?.method==="PUT") { const body=JSON.parse(options.body); if(id===fail)throw new Error("collaboration_conflict");writes.push({id,...body});data.set(id,{...data.get(id)!,settings:body.settings});return data.get(id); }
  reads.push(id);return structuredClone(data.get(id));
 });
 return{http:http as any,writes,reads,restarts};
}
describe("guided reciprocal collaboration preparation",()=>{
 it("preserves existing grants and defaults, adds only the chosen pair, and starts services without sending a task",async()=>{
  const data=snapshots(),api=connection(data);const defaults=structuredClone(data.get("alpha")!.settings);
  await prepareCollaboration(api,"alpha",["beta"],new Map(),()=>{},new AbortController().signal);
  expect(api.reads).toEqual(["alpha","beta"]);expect(api.writes.map(w=>w.id)).toEqual(["alpha","beta"]);
  expect(data.get("alpha")!.settings).toEqual({...defaults,enabled:true,peers:["gamma","beta"]});expect(data.get("beta")!.settings.peers).toEqual(["alpha"]);expect(data.get("gamma")!.settings.enabled).toBe(false);
  expect(api.restarts.map(w=>w.id)).toEqual(["alpha","beta"]);
 });
 it("keeps confirmed writes on conflict without restarting partially prepared services",async()=>{
  const data=snapshots(),api=connection(data,"beta");
  await expect(prepareCollaboration(api,"alpha",["beta"],new Map(),()=>{},new AbortController().signal)).rejects.toThrow("collaboration_conflict");
  expect(api.writes).toHaveLength(1);expect(api.restarts).toHaveLength(0);expect(data.get("alpha")!.settings.peers).toEqual(["gamma","beta"]);
 });
 it("does not write any configuration if a member cannot be prepared",async()=>{
  const data=snapshots();data.get("beta")!.peers=[];const api=connection(data);
  await expect(prepareCollaboration(api,"alpha",["beta"],new Map(),()=>{},new AbortController().signal)).rejects.toThrow("collaboration_invalid_peer");expect(api.writes).toHaveLength(0);
 });
 it("reuses accepted restart receipts on retry and skips connected services",async()=>{
  const data=snapshots(),api=connection(data),ids=new Map<string,string>();
  await prepareCollaboration(api,"alpha",["beta"],ids,()=>{},new AbortController().signal);
  await prepareCollaboration(api,"alpha",["beta"],ids,()=>{},new AbortController().signal);
  expect(api.restarts[0].receiptId).toBe(api.restarts[2].receiptId);expect(api.restarts[1].receiptId).toBe(api.restarts[3].receiptId);
  for(const value of data.values())value.listener="online";
  // The long-lived App observes readiness; CLI request IDs remain immutable.
  for(const [id,value] of data)settleCollaborationRestarts(value,id,ids);
  await prepareCollaboration(api,"alpha",["beta"],ids,()=>{},new AbortController().signal);expect(api.restarts).toHaveLength(4);
  // A later outage is a new recovery attempt only after online was observed.
  for(const value of data.values())value.listener="offline";
  await prepareCollaboration(api,"alpha",["beta"],ids,()=>{},new AbortController().signal);
  expect(api.restarts[4].receiptId).not.toBe(api.restarts[0].receiptId);
  expect(api.restarts[5].receiptId).not.toBe(api.restarts[1].receiptId);
 });
 it("does not start more writes after leaving the host",async()=>{
  const data=snapshots(),api=connection(data),abort=new AbortController();
  await expect(prepareCollaboration(api,"alpha",["beta"],new Map(),step=>{if(step.state==="saved")abort.abort();},abort.signal)).rejects.toThrow();expect(api.writes).toHaveLength(1);expect(api.restarts).toHaveLength(0);
 });
});
