// Test-only preload in the dedicated managed worker. Observe native cancellation
// without altering arguments, prompts, protocol bytes, permissions or results.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

if (process.argv[1] === process.env.TAROCUB_STOP_WORKER_ENTRY && process.env.TAROCUB_STOP_OBSERVER_LOG) {
  const record = (value) => appendFileSync(process.env.TAROCUB_STOP_OBSERVER_LOG, JSON.stringify({ at: Date.now(), workerPid: process.pid, ...value }) + '\n');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args), pending = new Map();
    record({ type: 'native.spawn', pid: child.pid, executable: path.basename(String(args[0])) });
    function inspect(direction, frame) {
      if (process.env.TAROBOT_NATIVE_INPUT_OBSERVER === '1') {
        if (direction === 'in' && frame.type === 'user') record({ type: 'input.sent', pid: child.pid, uuid: frame.uuid, origin: frame.origin?.kind, priority: frame.priority });
        if (direction === 'in' && frame.type === 'control_request' && ['interrupt', 'cancel_async_message'].includes(frame.request?.subtype)) record({ type: 'input.control', pid: child.pid, id: frame.request_id, request: frame.request });
        if (direction === 'out' && frame.type === 'command_lifecycle') record({ type: 'input.lifecycle', pid: child.pid, uuid: frame.command_uuid, state: frame.state });
        if (direction === 'out' && frame.type === 'control_response' && frame.response?.response && ['send_now','cancelled'].some(key => key in frame.response.response)) record({ type: 'input.control.receipt', pid: child.pid, id: frame.response.request_id, response: frame.response.response });
        if (direction === 'out' && frame.type === 'assistant' && !frame.parent_tool_use_id) for (const part of frame.message?.content ?? []) if (part.type === 'tool_use') record({ type: 'input.tool', pid: child.pid, id: part.id, name: part.name, foregroundPing: part.name === 'Bash' && /ping\s+-c\s*60\s+127.0.0.1/.test(part.input?.command ?? '') });
        if (direction === 'out' && frame.type === 'system' && frame.subtype === 'task_updated') record({ type: 'input.task.updated', pid: child.pid, taskId: frame.task_id, patch: frame.patch });
        if (direction === 'out' && frame.type === 'result') record({ type: 'input.result', pid: child.pid, error: frame.is_error, uuids: frame.user_message_uuids ?? [frame.user_message_uuid] });
      }
      if (direction === 'in' && (['turn/start', 'session/prompt'].includes(frame.method) || frame.type === 'user' || frame.event === 'user')) {
        record({ type: 'native.prompt.sent', pid: child.pid });
      }
      if (direction === 'in' && ['turn/interrupt', 'session/cancel', 'session/prompt'].includes(frame.method)) {
        if (frame.id !== undefined) pending.set(frame.id, frame.method);
        if (frame.method !== 'session/prompt') record({ type: 'cancel.sent', pid: child.pid, method: frame.method });
      }
      if (direction === 'in' && frame.type === 'control_request' && ['interrupt', 'stop_task'].includes(frame.request?.subtype)) {
        pending.set(frame.request_id, `claude.${frame.request.subtype}`);
        record({ type: 'cancel.sent', pid: child.pid, method: `claude.${frame.request.subtype}` });
      }
      if (direction === 'out') {
        if (frame.type === 'control_response' && pending.get(frame.response?.request_id)?.startsWith('claude.')) {
          const method = pending.get(frame.response.request_id);
          pending.delete(frame.response.request_id);
          record({ type: 'cancel.ack', pid: child.pid, method, ok: frame.response.subtype === 'success' });
        }
        if (frame.type === 'result') record({ type: 'native.turn.end', pid: child.pid, status: frame.subtype, stopReason: frame.terminal_reason });
        const method = pending.get(frame.id);
        if (method) {
          pending.delete(frame.id);
          if (method === 'turn/interrupt') record({ type: 'cancel.ack', pid: child.pid, method, ok: !frame.error });
          if (method === 'session/prompt') record({ type: 'native.prompt.end', pid: child.pid, stopReason: frame.result?.stopReason, error: !!frame.error });
        }
        if (frame.method === 'turn/completed') record({ type: 'native.turn.end', pid: child.pid, status: frame.params?.turn?.status });
        if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string') record({ type: 'native.session', pid: child.pid, sessionId: frame.session_id });
      }
    }
    const reader = (direction) => {
      const decoder = new StringDecoder('utf8'); let pending = '';
      return (chunk, encoding) => {
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        const lines = pending.split('\n'); pending = lines.pop();
        // A non-JSON subprocess can emit arbitrary output; it is not retained.
        if (pending.length > 1024 * 1024) pending = '';
        for (const line of lines) { try { inspect(direction, JSON.parse(line)); } catch {} }
      };
    };
    child.stdout?.on('data', reader('out'));
    if (child.stdin) {
      const write = child.stdin.write, observe = reader('in');
      child.stdin.write = function (...values) { observe(values[0], values[1]); return Reflect.apply(write, this, values); };
    }
    child.once('exit', (code, signal) => record({ type: 'native.exit', pid: child.pid, code, signal }));
    return child;
  };
  syncBuiltinESMExports();

  // DeepSeek uses its local authenticated RPC transport instead of CLI stdio.
  // Record the actual RPC's resolution; do not equate it with provider billing
  // cessation or fabricate a native turn-completed event.
  const { DeepSeekHarnessProtocolClient } = await import(process.env.TAROCUB_STOP_PROTOCOL_MODULE);
  const request = DeepSeekHarnessProtocolClient.prototype.request;
  DeepSeekHarnessProtocolClient.prototype.request = async function (method, ...args) {
    if (method === 'session.prompt') record({ type: 'native.prompt.sent' });
    if (method !== 'session.cancel') return Reflect.apply(request, this, [method, ...args]);
    record({ type: 'cancel.sent', method });
    try { const result = await Reflect.apply(request, this, [method, ...args]); record({ type: 'cancel.ack', method, ok: true }); return result; }
    catch (error) { record({ type: 'cancel.ack', method, ok: false }); throw error; }
  };
}
