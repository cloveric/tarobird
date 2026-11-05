// Acceptance-only observer. It records native goal/turn boundaries without
// changing prompts, protocol frames, permissions, results or model behavior.
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

if (process.argv[1] === process.env.TAROCUB_GOAL_WORKER_ENTRY && process.env.TAROCUB_GOAL_OBSERVER_LOG) {
  const record = (value) => appendFileSync(process.env.TAROCUB_GOAL_OBSERVER_LOG, JSON.stringify({ at: Date.now(), ...value }) + '\n');
  const original = childProcess.spawn;
  childProcess.spawn = function (...args) {
    const child = Reflect.apply(original, this, args), pending = new Map();
    record({ type: 'spawn', pid: child.pid, executable: path.basename(String(args[0])) });
    const inspect = (direction, frame) => {
      if (direction === 'in' && /^(thread\/goal\/|turn\/)/.test(frame.method ?? '')) {
        pending.set(frame.id, frame.method);
        record({ type: 'request', method: frame.method, threadId: frame.params?.threadId, turnId: frame.params?.turnId });
      }
      if (direction !== 'out') return;
      if (pending.has(frame.id)) {
        const method = pending.get(frame.id); pending.delete(frame.id);
        record({ type: 'response', method, ok: !frame.error, cleared: frame.result?.cleared, goalStatus: frame.result?.goal?.status, goalPresent: !!frame.result?.goal, turnId: frame.result?.turn?.id });
      }
      if (['turn/started', 'turn/completed'].includes(frame.method)) record({ type: frame.method, threadId: frame.params?.threadId, turnId: frame.params?.turn?.id, status: frame.params?.turn?.status });
      if (frame.method === 'thread/goal/updated') record({ type: frame.method, threadId: frame.params?.threadId, goalStatus: frame.params?.goal?.status });
      if (frame.method === 'item/completed' && frame.params?.item?.type === 'agentMessage') record({ type: 'answer', turnId: frame.params?.turnId, text: frame.params.item.text?.slice(0, 4096) });
    };
    const reader = (direction) => {
      const decoder = new StringDecoder('utf8'); let tail = '';
      return (chunk) => {
        tail += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        const lines = tail.split('\n'); tail = lines.pop();
        if (tail.length > 1024 * 1024) tail = '';
        for (const line of lines) { try { inspect(direction, JSON.parse(line)); } catch {} }
      };
    };
    child.stdout?.on('data', reader('out'));
    if (child.stdin) { const write = child.stdin.write, observe = reader('in'); child.stdin.write = function (...values) { observe(values[0]); return Reflect.apply(write, this, values); }; }
    child.once('exit', (code, signal) => record({ type: 'exit', pid: child.pid, code, signal }));
    return child;
  };
  syncBuiltinESMExports();
  const { DeepSeekHarnessProtocolClient } = await import(process.env.TAROCUB_GOAL_PROTOCOL_MODULE);
  const connect = DeepSeekHarnessProtocolClient.prototype.connect;
  DeepSeekHarnessProtocolClient.prototype.connect = function (handlers) {
    return Reflect.apply(connect, this, [{ ...handlers, onMuxFrame: (frame) => {
      const event = frame.payload?.event;
      if (['turn/start', 'turn/end'].includes(event?.type)) record({ type: event.type, threadId: frame.payload.sessionId, turnId: String(event.data?.turn), status: event.data?.reason?.kind });
      if (event?.type === 'user/message') record({ type: event.type, threadId: frame.payload.sessionId, source: { kind: event.data?.source?.kind, rpcId: event.data?.source?.rpcId } });
      if (frame.payload?.type === 'session/projection' && frame.payload.key === 'inbox') record({ type: 'inbox', threadId: frame.payload.sessionId, items: ['next-turn', 'next-step'].flatMap((key) => (frame.payload.value?.[key] ?? []).map((message) => ({ id: message.id, sourceRpcId: message.source?.rpcId }))) });
      if (event?.type === 'assistant/message') record({ type: 'answer', turnId: String(event.data?.turn), text: event.data?.message?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n').slice(0, 4096) });
      return handlers.onMuxFrame(frame);
    } }]);
  };
  const request = DeepSeekHarnessProtocolClient.prototype.request;
  DeepSeekHarnessProtocolClient.prototype.request = async function (method, ...args) {
    if (!/^(goal\.|session\.(prompt|cancel)$)/.test(method)) return Reflect.apply(request, this, [method, ...args]);
    record({ type: 'request', method, threadId: args[0]?.sessionId, sourceRpcId: args[0]?.requestId });
    try {
      const result = await Reflect.apply(request, this, [method, ...args]);
      record({ type: 'response', method, ok: true, cleared: result?.cleared }); return result;
    } catch (error) { record({ type: 'response', method, ok: false }); throw error; }
  };
  const { DeepSeekHarnessHost } = await import(new URL('./deepseek-harness-host.js', process.env.TAROCUB_GOAL_PROTOCOL_MODULE).href);
  const cancelPrompt = DeepSeekHarnessHost.prototype.cancelPrompt;
  const steerPrompt = DeepSeekHarnessHost.prototype.steerPrompt;
  DeepSeekHarnessHost.prototype.steerPrompt = async function (input) {
    const identity = { threadId: input.sessionId, sourceRpcId: input.sourceRpcId, turnId: String(input.expectedTurn), requestId: input.requestId };
    record({ type: 'exact-steer-request', ...identity });
    try {
      const result = await Reflect.apply(steerPrompt, this, [input]);
      record({ type: 'exact-steer-result', ...identity, outcome: result.outcome }); return result;
    } catch (error) { record({ type: 'exact-steer-result', ...identity, outcome: 'unknown' }); throw error; }
  };
  DeepSeekHarnessHost.prototype.cancelPrompt = async function (sessionId, sourceRpcId) {
    record({ type: 'exact-stop-request', threadId: sessionId, sourceRpcId });
    try {
      const result = await Reflect.apply(cancelPrompt, this, [sessionId, sourceRpcId]);
      record({ type: 'exact-stop-result', threadId: sessionId, sourceRpcId, outcome: result.outcome }); return result;
    } catch (error) { record({ type: 'exact-stop-result', threadId: sessionId, sourceRpcId, outcome: 'unknown' }); throw error; }
  };
}
