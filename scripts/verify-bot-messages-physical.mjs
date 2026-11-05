// Manual physical-host acceptance harness. Run with Node 24 after npm run build.
// This deliberately creates isolated hosts; messages CLI commands never do so.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubServer } from '../dist/src/hub/server.js';
import { desktopTls } from '../dist/src/hub/desktop-tls.js';
import { startHubControl } from '../dist/src/hub/service.js';
import { acquireInstanceLock } from '../dist/src/state/instance-lock.js';
import { initializeHost } from '../dist/src/host-cli/setup.js';
import { hostProcessEnvironment } from '../dist/src/host-cli/environment.js';
import { LocalHostClient } from '../dist/src/host-cli/client.js';
import { HostManagement } from '../dist/src/host-cli/management.js';
import { HostNetwork, verifyCliNetworkMembership } from '../dist/src/host-cli/network-cli.js';
import { networkCanonical } from '../dist/src/client-protocol/private-network.js';
import { messageHostId } from '../dist/src/hub/bot-messages.js';

const [command, stateArg, ...args] = process.argv.slice(2);
if (!stateArg) throw new Error('Usage: node scripts/verify-bot-messages-physical.mjs serve|resume|network|trigger|status STATE [arguments]');
const state = path.resolve(stateArg), marker = path.join(state, 'physical-bot-messages-test.json');
const entrypoint = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = async (file, value) => writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
// Never inherit the initiating production Bot's routing or active message.
for (const key of Object.keys(process.env)) if (/^TAROBOT_(?:ACTIVE_|INSTANCE$|STATE_DIR$|MESSAGE_ID$|HOST_DIR$|HOST_SUPERVISOR$)/.test(key)) delete process.env[key];

if (command === 'serve' || command === 'resume') {
  const [name, ip, portText] = args, port = Number(portText);
  if (!name || !ip || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('serve STATE NAME LAN_IP TLS_PORT');
  if (command === 'resume' && (await json(marker)).kind !== 'bot-messages-physical-test') throw new Error('Not a test directory');
  if (command === 'serve' && await stat(state).then(() => true, () => false)) throw new Error('A fresh, nonexistent test state directory is required; production state is never accepted');
  await initializeHost(state, name); await save(marker, { kind: 'bot-messages-physical-test', createdAt: new Date().toISOString() });
  const lock = await acquireInstanceLock(state), tls = await desktopTls(state, [ip]);
  const hub = await HubServer.start({ stateDir: state, host: '127.0.0.1', port: 0,
    tlsListeners: [{ host: ip, port, exposure: 'public', tls: { cert: await readFile(tls.cert), key: await readFile(tls.key) } }],
    managedBots: { entrypoint, env: hostProcessEnvironment() } });
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const control = await startHubControl(state, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, stop, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(state, { enroll: true });
  const management = new HostManagement(client), network = new HostNetwork(client);
  const routes = [{ name: 'Direct', url: `https://${ip}:${port}`, certificateAuthority: tls.certificateAuthority }], view = await network.view();
  if (JSON.stringify(view.host.routes) !== JSON.stringify(routes)) await network.command({ operation: 'routes', networkId: view.membership?.manifest.id ?? '', routes });
  const bots = {};
  for (const role of ['sender', 'receiver']) bots[role] = await management.createBot({ requestId: `physical_${role}`, name: `${name} ${role}`, engine: 'codex', model: 'gpt-5.6-sol', effort: 'low', permission: 'bypass', workspace: '' });
  const info = { name, hostId: messageHostId(hub.auth.publicKey), publicKey: hub.auth.publicKey, ip, port, bots: Object.fromEntries(Object.entries(bots).map(([role, bot]) => [role, { id: bot.id, name: bot.name }])), platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version, executable: process.execPath, pid: process.pid };
  await save(path.join(state, 'public-info.json'), info); console.log(JSON.stringify(info));
  let busy = false, reader = client;
  const tick = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      const trigger = await json(path.join(state, 'trigger.json')).catch(() => undefined);
      if (trigger) {
        const c = await hub.store.createConversation('owner', [bots.sender.id], 'Physical CLI verification', 'physical_origin');
        const sent = await hub.store.sendMessage('owner', { conversationId: c.id, clientMsgId: trigger.id, text: trigger.text, attachments: [], mentions: [bots.sender.id] });
        await save(path.join(state, 'trigger-receipt.json'), { messageId: sent.message.id, conversationId: c.id });
      }
      const deliveries = await hub.store.db.serial(() => hub.store.db.all('SELECT message_id,bot_id,status,dispatched FROM deliveries ORDER BY rowid'));
      const messages = await hub.store.db.serial(() => hub.store.db.all('SELECT id,author_type,author_id,reply_to,blocks_json,bot_source_json,status FROM messages ORDER BY created_at,id'));
      const audits = await hub.store.db.serial(() => hub.store.db.all("SELECT at,kind,detail_json FROM audit_log WHERE kind LIKE 'bot-message.%' ORDER BY at"));
      // Reuse the session until its refresh window: reconnecting every tick
      // would hit the Hub's authentication rate limit during a long test.
      if (Date.now() + 60_000 >= reader.ready.expiresAt) { reader.close(); reader = await LocalHostClient.connect(state); }
      const current = new HostManagement(reader);
      const services = Object.fromEntries(await Promise.all(Object.entries(bots).map(async ([role, bot]) => [role, await current.botStatus(bot.id)])));
      await save(path.join(state, 'evidence.json'), { info, deliveries, messages, audits, services });
    } catch (error) { console.error(error.message); } finally { busy = false; }
  }, 2000);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const expiry = setTimeout(stop, 2 * 60 * 60 * 1000);
  await stopped; clearTimeout(expiry); clearInterval(tick); reader.close(); client.close(); await control(); await hub.close(); await lock.release();
} else {
  if ((await json(marker)).kind !== 'bot-messages-physical-test') throw new Error('Not a test directory');
  if (command === 'status') { console.log(JSON.stringify(await json(path.join(state, 'evidence.json')))); process.exit(0); }
  const client = await LocalHostClient.connect(state), network = new HostNetwork(client);
  try {
    if (command === 'network') {
      const [operation, inputFile, expectedKey] = args; let result;
      if (operation === 'create') result = await network.command({ operation, name: 'Physical Bot Messages Acceptance' });
      else if (operation === 'propose') {
        const membership = verifyCliNetworkMembership(await json(inputFile));
        if (membership.manifest.authorityKey !== expectedKey) throw new Error('Unexpected authority key');
        result = await network.command({ operation, networkId: membership.manifest.id, authorityKey: expectedKey, seenManifestHash: createHash('sha256').update(networkCanonical(membership.manifest)).digest('hex') });
      } else if (operation === 'admit') {
        const proposal = await json(inputFile);
        if (proposal.proposal.host.publicKey !== expectedKey) throw new Error('Unexpected peer key');
        result = await network.command({ operation, proposal });
      } else if (operation === 'join') {
        const membership = verifyCliNetworkMembership(await json(inputFile));
        if (membership.manifest.authorityKey !== expectedKey) throw new Error('Unexpected authority key');
        result = await network.command({ operation, membership, nonce: (await json(path.join(state, 'proposal.json'))).proposal.nonce });
      } else throw new Error('Unsupported network operation');
      const exported = result.proposal ?? result.membership ?? result.view.membership;
      await save(path.join(state, operation === 'propose' ? 'proposal.json' : 'membership.json'), exported);
      console.log(JSON.stringify(exported));
    } else if (command === 'trigger') {
      const [destination, nonce = randomUUID()] = args;
      if (!destination) throw new Error('trigger STATE HOST_ID/BOT_ID [NONCE]');
      const info = await json(path.join(state, 'public-info.json'));
      const workspace = path.join(state, 'bots', info.bots.sender.id, 'workspace');
      const script = path.join(workspace, 'physical-send.mjs'), output = path.join(workspace, `receipt-${nonce}.json`);
      // Run by the real sender Bot, preserving its authenticated active-turn env.
      await writeFile(script, `import { spawnSync } from 'node:child_process';\nimport { writeFile,readFile } from 'node:fs/promises';\nimport { createHash } from 'node:crypto';\nconst directory=${JSON.stringify(state)},to=${JSON.stringify(destination)},nonce=${JSON.stringify(nonce)},workspace=${JSON.stringify(workspace)};\nconst context=process.env.TAROBOT_MESSAGE_ID||process.argv[2]; if(!context) throw new Error('real_active_bot_turn_required');\nconst probe=workspace+'/probe-'+nonce+'.txt',task=workspace+'/task-'+nonce+'.txt';\nconst bytes=Buffer.from('TaroBot physical text and file '+nonce+'\\n');\nawait writeFile(probe,bytes);\nawait writeFile(task,'真实跨主机验收任务 '+nonce+'。请读取本消息附件并计算 SHA256；回复 ACK '+nonce+' 和哈希，并用 app_send_file 原样发回该附件一次。不要发送其他 Bot 消息，不访问其他文件。');\nconst cli=args=>{const p=spawnSync(process.env.TAROBOT_NODE_EXECUTABLE,[process.env.TAROBOT_CLI_ENTRYPOINT,...args,'--state-dir',directory,'--json'],{encoding:'utf8',timeout:660000,maxBuffer:4*1024*1024});if(p.status!==0)throw new Error(p.stderr||p.error?.message||'CLI failed');return JSON.parse(p.stdout);};\nconst [host,bot]=to.split('/'); const list=cli(['conversations','list','--host',host,'--bot',bot]);\nconst sent=cli(['messages','send','--to',to,'--context-message',context,'--request-id',nonce,'--text-file',task,'--file',probe]);\nawait writeFile(${JSON.stringify(output)},JSON.stringify({list,sent},null,2));\nconst reply=cli(['messages','wait','--to',[sent.hostId,sent.botId,sent.conversationId].join('/'),'--message',sent.messageId,'--timeout','600','--out',workspace+'/replies-'+nonce]);\nconst sha256=createHash('sha256').update(bytes).digest('hex');\nfor(const file of reply.files) if(createHash('sha256').update(await readFile(file.path)).digest('hex')!==sha256)throw new Error('returned_file_mismatch');\nconst evidence={platform:process.platform,nonce,sha256,list,sent,reply,verified:reply.status==='completed'&&reply.text.includes('ACK '+nonce)&&reply.text.toLowerCase().includes(sha256)&&reply.files.length===1};\nawait writeFile(${JSON.stringify(output)},JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence));\nif(!evidence.verified)throw new Error('physical_acceptance_failed');\n`, { mode: 0o600 });
      await save(path.join(state, 'trigger.json'), { id: `trigger_${nonce}`, text: `用户已授权的真实跨主机消息验收。工具的 workdir 使用目录 ${workspace.replaceAll("\\", "/")}；脚本路径为 ${script.replaceAll("\\", "/")}。Windows 的 JavaScript 工具调用字符串中使用 C:/ 形式，不能用未转义的反斜杠。请只执行该脚本，使用环境变量 TAROBOT_NODE_EXECUTABLE 指向的 Node（为你的 shell 正确引用路径），不要编辑脚本。将本轮附加说明中的 --context-message 消息 ID 作为脚本唯一参数传入（例如 node 脚本 msg_xxx），无需设置环境变量。它调用与你同版本的三条 CLI，在已有 Hub 上发送一个测试文件并等回复，最长 10 分钟。执行后报告 verified 字段；若失败报告原始错误，不重发，不启动 Hub，不读凭据。` });
      console.log(JSON.stringify({ trigger: nonce, output }));
    } else throw new Error('Unsupported command');
  } finally { client.close(); }
}
