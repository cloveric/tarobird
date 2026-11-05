// Opt-in acceptance. No production guard; only synthetic Bots/workspaces created here.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink, readFile, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createAcceptanceInvitationIssuer, requestAcceptancePairing } from './standalone-acceptance-pairing.mjs';
if (process.env.TAROBOT_LIVE_ACCEPTANCE !== '1') throw new Error('Set TAROBOT_LIVE_ACCEPTANCE=1 for real CLI acceptance');
const packageRoot = path.resolve(process.env.TAROBOT_ACCEPTANCE_PACKAGE ?? '.');
const requirePackage = createRequire(path.join(packageRoot, 'package.json'));
try { requirePackage.resolve('@larksuiteoapi/node-sdk'); throw new Error('SDK unexpectedly installed'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const load = (p) => import(pathToFileURL(path.join(packageRoot, 'dist', p)).href);
const { HubServer } = await load('src/hub/server.js');
const { deviceProof } = await load('src/hub/auth.js');
const { blocksText } = await load('src/client-protocol/index.js');
const { nodeFrameReader } = await load('src/client-protocol/fragments-node.js');
const { WebSocket } = requirePackage('ws');
const root = await mkdtemp(path.join(os.tmpdir(), 'tarobot-live-independent-'));
const bin = path.join(root, 'bin'), home = path.join(root, 'home'); await mkdir(bin); await mkdir(home);
for (const [name, executable] of Object.entries({ node: process.execPath, codex: '/opt/homebrew/bin/codex', ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe' })) await symlink(executable, path.join(bin, name));
// Claude's default macOS keychain service differs from a custom config-dir service.
// Keep its normal authentication lookup; Hub/Gateway HOME and state stay isolated.
const quote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
await writeFile(path.join(bin,'claude'), '#!/bin/sh\nexport HOME='+quote(os.homedir())+'\n'+(process.env.CLAUDE_CONFIG_DIR?'export CLAUDE_CONFIG_DIR='+quote(process.env.CLAUDE_CONFIG_DIR):'unset CLAUDE_CONFIG_DIR')+'\nexec /opt/homebrew/bin/claude --strict-mcp-config --setting-sources "" "$@"\n'); await chmod(path.join(bin,'claude'),0o700);
const env = { USER: process.env.USER, LOGNAME: process.env.LOGNAME, PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: process.env.TMPDIR || os.tmpdir(), CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), CODEX_EXECUTABLE: path.join(bin, 'codex'), CLAUDE_EXECUTABLE: path.join(bin, 'claude'), ASR_HTTP_URL: 'http://127.0.0.1:8412/transcribe' };
const observer=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests/helpers/standalone-observer.cjs');
const observation=path.join(root,'runtime-observation.jsonl'); await writeFile(observation,'');
env.NODE_OPTIONS=`--require=${observer}`;env.TAROBOT_STANDALONE_OBSERVER=observation;
let larkCliAvailable = false; try { execFileSync('/usr/bin/which', ['lark-cli'], { env, stdio: 'ignore' }); larkCliAvailable = true; } catch {} if (larkCliAvailable) throw new Error('Lark CLI on isolated PATH');
console.log(`Acceptance state: ${root}`);
const report = { testedAt: new Date().toISOString(), packageRoot, sdkInstalled: false, feishuCredentials: false, larkCliAvailable, physicalApp: false, boundary: 'Paired App WebSocket/HTTP protocol → compiled Hub → separate Gateway worker → real CLI → App protocol', checks: [] };
const hub = await HubServer.start({ stateDir: path.join(root, 'hub'), clientDir: path.join(packageRoot, 'client/dist'), managedBots: { entrypoint: path.join(packageRoot, 'dist/src/index.js'), env } });
const sockets = [];
const until = async (check, label, timeout = 120_000) => { const end = Date.now()+timeout; for (;;) { const result = await check(); if (result) return result; if (Date.now()>end) throw new Error(`timeout:${label}`); await new Promise(r=>setTimeout(r,100)); } };
async function paired(deviceId, issueInvite) {
 const keys = generateKeyPairSync('ed25519');
 const pair = await requestAcceptancePairing(hub.url, issueInvite, { deviceId, name: 'Standalone acceptance', platform: 'web', publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') });
 await hub.auth.approve(pair.code, 'local-owner');
 const ws = new WebSocket(hub.url.replace('http','ws')+'/ws'); sockets.push(ws); const frames = [], reader = nodeFrameReader();
 const send = frame => ws.send(JSON.stringify({ v: 1, ...frame }));
 ws.on('message', raw => { const frame = reader.read(raw.toString()); if (!frame) return; frames.push(frame); if (frame.type==='snapshot.message') send({ type:'snapshot.ack', id:frame.id, count:frame.index+1 }); });
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 const next = (type,predicate=()=>true) => until(()=>{const index=frames.findIndex(f=>f.type===type&&predicate(f));return index>=0?frames.splice(index,1)[0]:undefined;},type,15_000);
 const nonce = randomBytes(32).toString('base64url'); send({type:'hello', deviceId, nonce, protocolVersions:[1], capabilities:['cards.v1','streaming.v1'], cursors:{}});
 const challenge=await next('challenge'); send({type:'auth',signature:sign(null,deviceProof(deviceId,challenge.nonce,nonce),keys.privateKey).toString('base64')});
 const ready=await next('ready');await next('sync.complete');
 return {send,next,frames,token:ready.sessionToken};
}
try {
 const issueInvite = await createAcceptanceInvitationIssuer(hub.auth, deviceProof);
 const desktop=await paired('standalone_desktop', issueInvite), phone=await paired('standalone_phone', issueInvite);
 const request=async(route,body,method='POST')=>{const response=await fetch(hub.url+route,{method,headers:{authorization:`Bearer ${desktop.token}`},...(body!==undefined?{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}:{})}); const value=await response.json();if(!response.ok)throw new Error(`${route}:${JSON.stringify(value)}`);return value;};
 for (const engine of (process.env.TAROBOT_ACCEPTANCE_ENGINES || 'codex').split(',')) {
  const workspace=path.join(root,engine);await mkdir(workspace);
  const bot=await request('/api/bots',{requestId:`accept_${engine}`,name:`Standalone ${engine}`,engine,model:engine==='claude'?'sonnet':'gpt-6.1-sol',effort:'low',workspace});
  await until(async()=> (await hub.store.bots('owner')).find(b=>b.id===bot.id)?.online,'online');
  const conversation=await request('/api/conversations',{v:1,type:'conversation.create',clientActionId:`conv_${engine}`,botIds:[bot.id],title:`Standalone ${engine} validation`});
  const snapshot=async()=> (await hub.store.snapshot('owner',conversation.id)).messages;
  let counter=0;
  const send=async(text,attachments=[])=>{const clientMsgId=`input_${engine}_${++counter}`;desktop.send({type:'message.send',conversationId:conversation.id,clientMsgId,text,attachments});return (await desktop.next('message.ack',f=>f.clientMsgId===clientMsgId)).messageId;};
  const completed=async(messageId,marker)=>until(async()=>{const messages=await snapshot();const incoming=messages.find(m=>m.id===messageId);const result=messages.find(m=>m.authorType==='bot'&&m.createdAt>=incoming.createdAt&&m.status==='complete'&&blocksText(m.blocks).includes(marker));return result;},marker);
  const token=`ORANGE_${randomBytes(3).toString('hex')}`;
  const textId=await send(`这是独立 App 验收。请记住本轮标记 ${token}，不要写入文件。只回复 STANDALONE_TEXT_OK ${token}，不要调用工具。`);
  const textResult=await completed(textId,'STANDALONE_TEXT_OK');
  await until(()=>phone.frames.some(f=>f.type==='event'&&f.conversationId===conversation.id),'phone sync');
  report.checks.push({engine,path:'text_and_two_device_sync',passed:true,messageId:textResult.id}); console.log(`${engine}: text/sync passed`);
  const body=Buffer.from(`Independent file payload ${token}\n`), hash=createHash('sha256').update(body).digest('hex');
  const upload=await request('/api/uploads',{conversationId:conversation.id,name:'standalone-input.txt',size:body.length,mime:'text/plain',sha256:hash});
  await request(`/api/uploads/${upload.id}/0`,body,'PUT');await request(`/api/uploads/${upload.id}/complete`);
  const fileId=await send('读取这条消息附带的文本文件，把同一个原文件作为可下载附件发回当前 App 对话，附文字 FILE_RETURN_OK。保持文件字节不变，不要发送到任何外部平台。',[upload.id]);
  const fileMessage=await until(async()=>{const messages=await snapshot();const incoming=messages.find(m=>m.id===fileId);return messages.find(m=>m.authorType==='bot'&&m.createdAt>=incoming.createdAt&&m.blocks.some(b=>b.type==='file'));},'file return');
  const attachment=fileMessage.blocks.find(b=>b.type==='file');
  const downloaded=Buffer.from(await (await fetch(hub.url+`/api/attachments/${attachment.attachmentId}`,{headers:{authorization:`Bearer ${phone.token}`}})).arrayBuffer());
  if(!body.equals(downloaded))throw new Error('returned bytes differ');
  report.checks.push({engine,path:'captioned_file_roundtrip',passed:true,sha256:hash});console.log(`${engine}: file roundtrip passed`);
  await until(async()=> (await hub.store.pendingForBot(bot.id)).length===0,'idle after file');
  if (process.env.TAROBOT_ACCEPTANCE_EXTENDED === '1') {
   const audioPath=path.join(workspace,'voice.aiff'), wavPath=path.join(workspace,'voice.wav');
   execFileSync('/usr/bin/say',['-v','Samantha','-o',audioPath,'The test color is orange.']);
   execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-y','-i',audioPath,'-ar','16000','-ac','1',wavPath]);
   const wav=await readFile(wavPath);const voice=await request('/api/uploads',{conversationId:conversation.id,name:'voice.wav',size:wav.length,mime:'audio/wav',sha256:createHash('sha256').update(wav).digest('hex')});
   await request(`/api/uploads/${voice.id}/0`,wav,'PUT');await request(`/api/uploads/${voice.id}/complete`);
   const voiceId=await send('请根据本条语音的转录，回答其中的测试颜色是什么。回复格式 VOICE_OK 加英文颜色，不要另行调用工具。',[voice.id]);
   const voiceResult=await completed(voiceId,'VOICE_OK');if(!blocksText(voiceResult.blocks).toLowerCase().includes('orange'))throw new Error('voice recognition incorrect');
   report.checks.push({engine,path:'real_local_asr_and_cli',passed:true});console.log(`${engine}: real ASR passed`);
   await until(async()=> (await hub.store.pendingForBot(bot.id)).length===0,'idle after voice');
   const questionId=await send('这一步必须测试 App 原生问题卡片：请调用 request_user_input / request_user_input_async 或 AskUserQuestion 工具，询问“选择验收颜色”，给出 Orange 与 Blue 两个单选选项。收到选择后只回复 QUESTION_OK 加选择的颜色。不要使用纯文字提问，不要访问任何外部平台。');
   const flatten=elements=>elements.flatMap(e=>[e,...flatten(e.children||[])]);
   const form=await until(async()=>{const messages=await snapshot();const incoming=messages.find(m=>m.id===questionId);for(const message of messages){if(message.authorType!=='bot'||message.createdAt<incoming.createdAt)continue;const elements=message.blocks.filter(b=>b.type==='card').flatMap(b=>flatten(b.elements));const submit=elements.find(e=>e.type==='button'&&(e.value?.cctb_lark==='ask_user_question'&&e.value?.action==='form_submit'||e.value?.cctb_lark==='choice'&&e.value?.label==='Orange')&&!e.disabled);if(submit)return {message,submit,elements};}},'native question card',90_000);
   const values={};for(const element of form.elements)if(element.type==='select')values[element.name||element.actionId]=element.options[0].value;
   desktop.send({type:'interaction.submit',conversationId:conversation.id,messageId:form.message.id,actionId:form.submit.actionId,values,clientActionId:`answer_${engine}`});await desktop.next('interaction.ack');
   await completed(questionId,'QUESTION_OK');report.checks.push({engine,path:'native_question_submit_resume',passed:true});console.log(`${engine}: native question passed`);
   await until(async()=> (await hub.store.pendingForBot(bot.id)).length===0,'idle after question');
  }
  const longId=await send(`请直接写一篇一万字的故事，标题必须是 STOP_STREAM_${token}。逐段输出正文，不要调用工具，也不要只给计划。`);
  await until(async()=>{const messages=await snapshot();const incoming=messages.find(m=>m.id===longId);return messages.some(m=>m.authorType==='bot'&&m.createdAt>=incoming.createdAt&&m.status==='streaming'&&blocksText(m.blocks).includes(`STOP_STREAM_${token}`));},'streaming');
  desktop.send({type:'turn.stop',conversationId:conversation.id});
  await until(async()=> (await hub.store.pendingForBot(bot.id)).length===0,'stop');
  const follow=await send('不要读文件或调用工具。刚才要求记住的 ORANGE_ 标记是什么？只回复 RESUMED_OK 加标记。');
  const resumed=await completed(follow,'RESUMED_OK');if(!blocksText(resumed.blocks).includes(token))throw new Error('context lost after stop');
  report.checks.push({engine,path:'stream_stop_resume_context',passed:true});console.log(`${engine}: stream/stop/resume passed`);
 }
} catch(error) { report.error=error instanceof Error?error.message:String(error);console.error(report.error);process.exitCode=1; }
finally { for(const ws of sockets)ws.terminate();await hub.close();const observations=(await readFile(observation,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));report.unexpectedFeishuCalls=observations.filter(o=>o.kind.startsWith('feishu_'));report.spawnedExecutables=[...new Set(observations.filter(o=>o.kind==='process').map(o=>o.name))];if(report.unexpectedFeishuCalls.length){report.error='unexpected_feishu_call';process.exitCode=1;}await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(`Report: ${root}/report.json`); }
