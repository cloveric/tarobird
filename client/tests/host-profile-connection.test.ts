import { beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/storage.js', () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock('../src/transport.js', () => ({ hubFetch: io.fetch }));
import { HubConnection } from '../src/connection.js';

let connection: HubConnection;
beforeEach(() => {
  vi.resetAllMocks();
  connection = new HubConnection({ deviceId: 'fixture', name: 'device', publicKey: 'fixture', routes: [] });
  Reflect.set(connection, 'token', 'fixture-only-session');
  connection.state = { ...connection.state, status: 'online', networkAvailable: true, user: { id: 'owner', name: 'Owner', role: 'owner' }, route: { name: 'Direct', url: 'https://hub.example' } };
});

it('publishes a host rename receipt before any directory refresh', async () => {
  io.fetch.mockResolvedValue(Response.json({ name: 'example-mac', revision: 1 }));
  await connection.http('/api/host-profile', { method: 'PATCH', body: JSON.stringify({ name: 'example-mac', revision: 0 }) });
  expect(connection.state.hostProfile).toEqual({ name: 'example-mac', revision: 1 });
  expect(io.fetch).toHaveBeenCalledOnce();
});

it('does not roll back a rename when an older read arrives late', async () => {
  let finish!: (response: Response) => void;
  io.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = connection.http('/api/host-profile');
  io.fetch.mockResolvedValue(Response.json({ name: 'example-mac', revision: 2 }));
  await connection.http('/api/host-profile', { method: 'PATCH' });
  finish(Response.json({ name: 'system-name.local', revision: 1 })); await old;
  expect(connection.state.hostProfile).toEqual({ name: 'example-mac', revision: 2 });
});

it('refreshes the shared name even when the separate network directory is unavailable', async () => {
  io.fetch.mockImplementation(async (_url, route) => route === '/api/network'
    ? Response.json({ error: 'unavailable' }, { status: 503 })
    : Response.json({ name: 'example-mac', revision: 3 }));
  await expect(connection.refreshNetwork()).rejects.toThrow();
  await vi.waitFor(() => expect(connection.state.hostProfile).toEqual({ name: 'example-mac', revision: 3 }));
});

it.each(['close', 'reconnect'])('does not publish a stale profile after %s', async condition => {
  let finish!: (response: Response) => void;
  io.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const old = connection.http('/api/host-profile');
  if (condition === 'close') Reflect.set(connection, 'closed', true);
  else Reflect.set(connection, 'httpEpoch', new AbortController());
  finish(Response.json({ name: 'old-name', revision: 1 })); await old;
  expect(connection.state.hostProfile).toBeUndefined();
});

it('failed host writes never fabricate a successful local rename', async () => {
  connection.state.hostProfile = { name: 'original', revision: 0 };
  io.fetch.mockResolvedValue(Response.json({ error: 'host_profile_changed' }, { status: 409 }));
  await expect(connection.http('/api/host-profile', { method: 'PATCH' })).rejects.toThrow('host_profile_changed');
  expect(connection.state.hostProfile).toEqual({ name: 'original', revision: 0 });
});
