import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../../src/hub/server.js';
import { hashSecret } from '../../../src/hub/auth.js';
import { attachGateway } from '../../../src/gateway/service.js';
import { createCoreServiceRuntime } from '../../../src/core/runtime.js';

/** A real Hub/Gateway with an isolated, deterministic Codex input boundary. */
export async function codexSendChoiceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-choice-'));
  const stateDir = path.join(root, 'bot'); await mkdir(stateDir);
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine: 'codex', locale: 'zh' }));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const secret = randomBytes(32).toString('base64url');
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Codex',?,'codex')", [hashSecret(secret)]);
  const turns: string[] = [], inputs: string[] = [], gates = new Map<number, () => void>();
  const options = { supported: true, loseAdmission: false };
  let closing = false;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace('http', 'ws') + '/instance', secret, botId: 'bot', engine: 'codex', runtime: createCoreServiceRuntime(), bridge: {
    supportsSteering: () => options.supported,
    steerActiveTurn: async input => { inputs.push(input.text); if (options.loseAdmission) throw new Error('simulated lost admission'); return true; },
    handleAuthorizedMessage: async input => {
      const index = turns.push(input.text) - 1;
      if (closing) return { text: '关闭测试' };
      await input.onEngineEvent?.({ type: 'assistant_text', text: '正在核对方案。', delta: true });
      await new Promise<void>(resolve => { gates.set(index, resolve); input.abortSignal?.addEventListener('abort', resolve, { once: true }); });
      gates.delete(index); return { text: '本轮已完成。' };
    },
  } });
  const chats = [await hub.store.createConversation('owner', ['bot'], 'Codex 发送方式', 'first'), await hub.store.createConversation('owner', ['bot'], '另一段 Codex 对话', 'second')];
  return { hub, chats, turns, inputs, options, finish: (index = 0) => gates.get(index)?.(),
    close: async () => { closing = true; for (const resolve of gates.values()) resolve(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); },
  };
}
