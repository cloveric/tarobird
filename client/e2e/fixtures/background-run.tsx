import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Message } from '../../../src/client-protocol/index.js';
import type { RunSummary } from '../../../src/client-protocol/run.js';
import { MessageContent } from '../../src/Content.js';
import type { HubConnection } from '../../src/connection.js';
import { RuntimeHostActiveContext } from '../../src/RuntimeHost.js';
import { setLocale } from '../../src/i18n.js';
import '../../src/styles.css';
import '../../src/brand-theme.css';
import '../../src/palette-tokens.css';
import '../../src/cli-typography.css';
import '../../src/adhd-board.css';
import '../../src/conversation-creation.css';

const prose = '## 视频检查记录\n\n' + Array.from({ length: 35 }, (_, i) => `第 ${i + 1} 段：已检查画面的布局、字幕、声音和时间线。这是公开进展，完整记录需要保留。`).join('\n\n') + '\n\n**最后一段：成片与四个封面已交付。**';
const rootMessage = { id: 'request', conversationId: 'chat', authorId: 'owner', authorType: 'user', status: 'complete', createdAt: Date.now() - 5000, blocks: [{ type: 'text', text: '检查视频并生成四个封面' }] } as Message;
const listeners = new Set<() => void>();
const evidence = { urls: [] as string[], sent: [] as unknown[], located: 0, setLocale };
const connection = (host: string) => ({ identity: { hubPublicKey: host, deviceId: 'device' }, state: { status: 'online', runScopesAvailable: true, bots: [{ id: 'alpha', name: 'CC1', online: true }] },
  subscribe: (notify: () => void) => { listeners.add(notify); return () => listeners.delete(notify); },
  http: async (url: string) => { evidence.urls.push(url); return { entries: [{ seq: 1, revision: 1, at: 1, kind: 'text', status: 'done', text: '保留的公开过程', scope: { id: 'worker', kind: 'background', label: '检查视频' } }], next: null, expired: false, files: [] }; },
  send: async (value: unknown) => { evidence.sent.push(value); }, stopReceipt: () => undefined,
}) as unknown as HubConnection;
const hosts = [connection('host-a'), connection('host-b')];
function Fixture() {
  // Only simulated public updates change event time. Locale, connection and
  // unrelated view changes must not manufacture a fresh progress report.
  const [stamp, setStamp] = useState(() => ({ startedAt: Date.now() - 100000, updatedAt: Date.now(), revision: 1 }));
  const touch = () => setStamp(value => ({ ...value, updatedAt: Date.now() + (hub.state.serverTimeOffset ?? 0), revision: value.revision + 1 }));
  const [status, setStatus] = useState<Message['status']>('complete');
  const [current, setCurrent] = useState<RunSummary["current"]>();
  const [deliveryFailed, setDeliveryFailed] = useState(false);
  const [staticReport, setStatic] = useState(false);
  const [taskLabel, setTaskLabel] = useState<string>();
  const [phase, setPhase] = useState<RunSummary['phase']>('done'), [body, setBody] = useState(prose), [host, setHost] = useState(0), [active, setActive] = useState(true), [origin, setOrigin] = useState('bound'), [source, setSource] = useState(rootMessage);
  const hub = hosts[host];
  Object.assign(window, { backgroundRun: { ...evidence, get located() { return evidence.located; },
    setPhase: (value: RunSummary['phase']) => { touch(); setPhase(value); },
    setBody: (value: string) => { touch(); setBody(value); }, setCurrent: (value: RunSummary['current']) => { touch(); setCurrent(value); },
    setStatus, setStamp: (updatedAt: number) => setStamp(value => ({ ...value, updatedAt })),
    setConnection: (value: Partial<HubConnection['state']>) => { hub.state = { ...hub.state, ...value }; listeners.forEach(fn => fn()); },
    setTaskLabel, setStatic, setDeliveryFailed, setHost, setActive, setOrigin, deleteSource: () => setSource({ ...rootMessage, status: 'deleted' }), wrongSource: () => setSource({ ...rootMessage, conversationId: 'elsewhere' }), offline: () => { hub.state = { ...hub.state, status: 'offline' }; listeners.forEach(fn => fn()); }, restore: () => { hub.state = { ...hub.state, runScopesAvailable: true }; listeners.forEach(fn => fn()); }, rollback: () => { hub.state = { ...hub.state, runScopesAvailable: false }; listeners.forEach(fn => fn()); } } });
  const run: RunSummary = { version: 1, id: 'same-run', ...stamp, phase, current, count: 66, completed: 66, failed: 0, ...(['done', 'error', 'partial', 'stopped', 'interrupted'].includes(phase) ? { endedAt: stamp.updatedAt } : {}), truncated: false };
  const card = (scoped: boolean) => ({ type: 'card' as const, elements: [{ type: 'markdown' as const, text: '**后台任务已完成**' }, ...(scoped ? [{ type: 'markdown' as const, id: 'background_context', text: '后台任务回报 · 这是关联请求的后续通知。' }] : []), { type: 'markdown' as const, text: host ? '另一台主机的完整报告。'.repeat(100) : body }], extra: { ...(!scoped || !staticReport ? { [scoped ? 'scopedRun' : 'nativeRun']: run } : {}), ...(scoped && taskLabel ? { scopedTask: { version: 1, label: taskLabel, kind: "background" } } : {}), ...(scoped ? { backgroundTask: { version: 1, origin, ...(deliveryFailed ? { delivery: "unconfirmed" } : {}) } } : {}) } });
  return <main style={{ display: 'block', padding: 20, maxWidth: 600, margin: 'auto' }}><RuntimeHostActiveContext.Provider value={active}>
    {[true, false].map(scoped => <article key={String(scoped)} data-test={scoped ? 'background' : 'foreground'} className="message bot" style={{ position: 'relative', display: 'block', marginBottom: 20 }}><MessageContent connection={hub} message={{ ...rootMessage, status, id: scoped ? 'background' : 'foreground', authorId: 'alpha', authorType: 'bot', replyTo: 'request', blocks: [card(scoped)] }} backgroundSource={{ original: source, open: () => { evidence.located++; } }}/></article>)}
  </RuntimeHostActiveContext.Provider></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
