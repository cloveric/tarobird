import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../../src/hub/server.js';
import { hashSecret } from '../../../src/hub/auth.js';
import { attachGateway } from '../../../src/gateway/service.js';
import { createCoreServiceRuntime } from '../../../src/core/runtime.js';
import type { EngineTask } from '../../../src/client-protocol/engine-tasks.js';
import type { NativeInputObserver } from '../../../src/client-protocol/native-input.js';

/** Isolated, deterministic input boundary; never launches a model or a production Host. */
export async function sendChoiceFixture(clientDir = path.resolve('dist')) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-send-choice-'));
  const stateDir = path.join(root, 'bot'); await mkdir(stateDir);
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine: 'claude', locale: 'zh' }));
  const hub = await HubServer.start({ stateDir: root, clientDir });
  const secret = randomBytes(32).toString('base64url');
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Claude',?,'claude')", [hashSecret(secret)]);
  const inputs: { text: string; observer: NativeInputObserver }[] = [], turns: string[] = [], controls: string[] = [];
  const gates = new Map<number, () => void>();
  const options = { native: true, sendNow: true, loseAdmission: false, receivedBeforeControlReply: false, unknownControl: false, tasks: [] as EngineTask[], backgroundGroups: false, stopScope: 'foreground' as 'foreground' | 'subagents' };
  let closing = false;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace('http', 'ws') + '/instance', secret, botId: 'bot', engine: 'claude', runtime: createCoreServiceRuntime(), bridge: {
    supportsSteering: () => true, inFlightSendBehavior: () => 'steer',
    listTasks: async () => ({ supported: true, tasks: structuredClone(options.tasks), foregroundStopScope: options.stopScope }),
    nativeInputCapability: async () => options.native ? { sendNow: options.sendNow, cancel: true, modelReceipt: true } : undefined,
    steerActiveTurn: async input => {
      inputs.push({ text: input.text, observer: input.nativeInput! });
      if (options.loseAdmission) throw new Error('simulated lost admission');
      input.nativeInput!.onProgress({ state: 'queued' }); return true;
    },
    controlNativeInput: async input => {
      controls.push(input.action);
      if (options.unknownControl) return { outcome: "unknown" };
      const original = inputs.find(item => item.observer.id === input.inputId)!;
      original.observer.onProgress({ state: input.action === 'cancel' ? 'cancelled' : options.receivedBeforeControlReply ? 'received' : 'dequeued' });
      return { outcome: 'accepted', result: input.action === 'cancel' ? 'cancelled' : 'delivering' };
    },
    handleAuthorizedMessage: async input => {
      const index = turns.push(input.text) - 1;
      if (closing) return { text: '关闭测试' };
      await input.onEngineEvent?.({ type: 'assistant_text', text: '我正在整理视频脚本，接下来核对镜头顺序和时长。', delta: true });
      if (options.backgroundGroups) {
        for (let i = 0; i < 3; i++) {
          const scope = { id: `layout-task-${i}`, kind: 'subagent' as const, label: `核对素材 ${i + 1}` };
          await input.onEngineEvent?.({ type:'scoped', origin:'bound', detached:true, scope, event:{ type:'tool_use', toolUseId:`layout-read-${i}`,toolName:'Read',toolInput:{file_path:`素材${i + 1}.md`} } });
          if (i === 2) await input.onEngineEvent?.({ type:'scoped',origin:'bound',detached:true,scope,event:{type:'scope_status',status:'done'} });
        }
      }
      await new Promise<void>(resolve => { gates.set(index, resolve); input.abortSignal!.addEventListener('abort', () => resolve(), { once: true }); });
      gates.delete(index); return { text: '本轮整理完成。' };
    },
  } });
  const chats = [await hub.store.createConversation('owner', ['bot'], '视频脚本讨论', 'direct'), await hub.store.createConversation('owner', ['bot'], '另一段对话', 'create')];
  return { hub, chats, inputs, turns, controls, options,
    appendHistory: async () => { for (let i=0;i<12;i++) await gateway.send(chats[0]!.id,{text:`素材检查 ${i+1}：核对脚本顺序、素材来源和镜头时长。\n\n公开过程和原始记录已保留。`}); },
    finish: (index = 0) => gates.get(index)?.(),
    close: async () => { closing = true; for (const resolve of gates.values()) resolve(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); },
  };
}
