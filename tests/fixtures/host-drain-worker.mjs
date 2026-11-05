// Real IPC + local Hub transport, with no model/CLI invocation.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import http from 'node:http';
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const secret = (await readFile(path.join(arg('--state-dir'), 'gateway.key'), 'utf8')).trim();
const botId = arg('--bot-id'), ws = new WebSocket(arg('--hub-url'));
let busy = true, draining = false, cancelled = false, committed = false, drainId;
let blockers;
let pendingReply;
const peer = http.createServer((_request, response) => { busy = true; pendingReply = response; });
await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
const frames = [];
const send = value => ws.send(JSON.stringify({ v: 1, ...value }));
ws.on('open', () => send({ type: 'instance.hello', botId, secret, engine: 'codex', model: '', effort: '' }));
ws.on('message', raw => {
  const frame = JSON.parse(raw.toString()); frames.push(frame); process.send?.({ type: 'fixture.frame', frame });
  if (frame.type === 'instance.call') send({ type: 'instance.result', id: frame.id, result: { ok: true, result: null } });
});
process.on('message', message => {
  if (message.type === 'shutdown.now') process.exit(0);
  if (message.type === 'drain.whenIdle' || message.type === 'restart.whenIdle') {
    draining = true; drainId = message.requestId;
    const ack = () => process.send?.({ type: 'restart.queued', requestId: message.requestId, pid: process.pid });
    setTimeout(ack, Number(process.env.TAROBOT_FIXTURE_DRAIN_ACK_DELAY ?? 0));
  }
  if (message.type === 'drain.cancel') {
    draining = false; committed = false; cancelled = true;
    process.send?.({ type: 'drain.cancelled', requestId: message.requestId, pid: process.pid, ok: true });
  }
  if (message.type === 'drain.status') process.send?.({ type: 'drain.status.result', drainId: message.drainId, requestId: message.requestId, pid: process.pid, idle: draining && message.drainId === drainId && !busy, ...(blockers ? { blockers } : {}) });
  if (message.type === 'fixture.blocker') blockers = [{ botId, type: message.kind, conversationKey: message.conversationKey, count: 1 }];
  if (message.type === 'drain.commit' && message.drainId === drainId) { committed = true; if (!busy && draining) process.exit(75); }
  if (message.type === 'fixture.finish') { pendingReply?.end('done'); pendingReply = undefined; busy = false; if (draining && committed) process.exit(75); }
  if (message.type === 'fixture.state') process.send?.({ type: 'fixture.state', draining, cancelled, busy, port: peer.address().port, frames });
  if (message.type === 'fixture.delegate') { busy = true; void fetch(`http://127.0.0.1:${message.port}/delegate`).then(response => response.text()).then(() => { busy = false; if (draining && committed) process.exit(75); }); }
  if (message.type === 'fixture.ack') send({ type: 'instance.request', id: `ack_${message.messageId}`, method: 'ack', params: { messageId: message.messageId } });
});
process.on('SIGTERM', () => process.exit(0)); process.on('disconnect', () => process.exit(0));
