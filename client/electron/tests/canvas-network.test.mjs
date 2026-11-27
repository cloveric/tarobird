import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasNetworkRequest } from '../canvas-network.mjs';

const active = () => true;
const models = { kind: 'provider', url: 'https://api.openai.com/v1/models', httpMethod: 'GET', headers: { authorization: 'Bearer fixture' } };
const prompts = { kind: 'prompts', url: 'https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/awesome-gpt-image.json', httpMethod: 'GET' };

test('provider fetch uses only the approved endpoint, explicit headers and no ambient credentials or redirects', async () => {
  const result = await canvasNetworkRequest(models, active, async (url, options) => {
    assert.equal(url, models.url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual([...options.headers.keys()], ['authorization']);
    return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  });
  assert.equal(new TextDecoder().decode(result.body), 'ok');
  assert.equal(result.status, 200);
});

test('rejects undeclared destinations, headers and operations before fetching', async () => {
  const noFetch = () => assert.fail('unexpected transport');
  for (const invalid of [
    { ...models, url: 'https://api.example.com/v1/models' }, { ...models, url: 'https://api.openai.com/v1/files' },
    { ...models, headers: { cookie: 'fixture' } }, { ...models, httpMethod: 'DELETE' },
    { ...prompts, headers: { authorization: 'fixture' } }, { ...prompts, url: prompts.url.replace('awesome-gpt-image', 'custom') },
  ]) await assert.rejects(canvasNetworkRequest(invalid, active, noFetch), /canvas_network_denied/);
});

test('prompt sources are bounded JSON-only and their requests carry no user credentials', async () => {
  const result = await canvasNetworkRequest(prompts, active, async (_url, options) => {
    assert.equal([...options.headers].length, 0);
    return new Response('{"items":[]}');
  });
  assert.equal(result.contentType, 'application/json');
  await assert.rejects(canvasNetworkRequest(prompts, active, async () => new Response('plain text')));
  await assert.rejects(canvasNetworkRequest(prompts, active, async () => new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } })), /response_rejected/);
});

test('a retired document cannot read a completed request', async () => {
  let current = true;
  await assert.rejects(canvasNetworkRequest(models, () => current, async () => {
    current = false;
    return new Response('ok');
  }), /response_rejected/);
});

const source = {
  kind: 'source',
  url: `https://raw.githubusercontent.com/fixture/nodes/${'1'.repeat(40)}/src/example.js`,
  httpMethod: 'GET',
};

test('downloads pinned JavaScript source as bounded text without headers, body, redirects, or credentials', async () => {
  const result = await canvasNetworkRequest(source, active, async (url, options) => {
    assert.equal(url, source.url);
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.deepEqual([...options.headers], []);
    assert.equal(options.referrer, '');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response('// inert fixture');
  });
  assert.equal(result.contentType, 'text/javascript');
  assert.equal(new TextDecoder().decode(result.body), '// inert fixture');
});

test('rejects mutable refs, another origin, unsafe paths, and outbound headers and bodies', async () => {
  const noFetch = () => assert.fail('unexpected transport');
  for (const input of [
    { ...source, url: source.url.replace('1'.repeat(40), 'main') },
    { ...source, url: source.url.replace('raw.githubusercontent.com', 'example.org') },
    { ...source, url: source.url.replace('https://', 'http://') },
    { ...source, url: source.url + '?value=fixture' },
    { ...source, url: source.url + '#fixture' },
    { ...source, url: source.url + '\n' },
    { ...source, url: source.url.replace('src/example.js', 'src/../example.js') },
    { ...source, url: source.url.replace('src/example.js', 'src/%2e%2e/example.js') },
    { ...source, url: source.url.replace('example.js', 'example.html') },
    { ...source, headers: { authorization: 'fixture' } },
    { ...source, body: Uint8Array.of() },
    { ...source, httpMethod: 'POST' },
  ]) await assert.rejects(canvasNetworkRequest(input, active, noFetch), /denied|source_url_invalid/);
});

test('rejects invalid UTF-8, partial responses, redirects and streamed oversized sources', async () => {
  for (const response of [
    new Response(Uint8Array.of(0xff, 0xc0)),
    new Response('partial', { status: 206 }),
    Response.redirect('https://example.org'),
    new Response(new Uint8Array(256 * 1024 + 1)),
    new Response('small', { headers: { 'content-length': String(256 * 1024 + 1) } }),
  ]) {
    await assert.rejects(canvasNetworkRequest(source, active, async () => response));
  }
});
