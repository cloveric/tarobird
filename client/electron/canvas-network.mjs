// This broker belongs to the trusted App document. Plugin frames have no direct
// network access. Keep provider credentials and public prompt catalogs separate.
const promptSources = new Set([
  'banana-prompt-quicker', 'davidwu-gpt-image2-prompts', 'freestylefly-gpt-image-2',
  'awesome-gpt-image', 'awesome-gpt4o-image-prompts', 'youmind-gpt-image-2', 'youmind-nano-banana-pro',
]);
const maxBytes = 32 * 1024 * 1024;
let activeRequests = 0;

export const CANVAS_NODE_MAX_SOURCE_BYTES = 256 * 1024;

export function canvasNodeSourceURL(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('canvas_node_source_url_invalid');
  const match = /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/([a-fA-F0-9]{40})\/([A-Za-z0-9_./-]+\.js)$/.exec(raw);
  if (!match || match[0] !== raw || match[1].endsWith('-') || match[4].split('/').at(-1) === '.js' || [match[2], ...match[4].split('/')].some(part => !part || part === '.' || part === '..')) {
    throw new Error('canvas_node_source_url_invalid');
  }
  const [, owner, repository, commit, path] = match;
  return `https://raw.githubusercontent.com/${owner.toLowerCase()}/${repository.toLowerCase()}/${commit.toLowerCase()}/${path}`;
}

export async function canvasNetworkRequest(input, active = () => true, send = fetch) {
  if (!active() || activeRequests >= 4) throw new Error('canvas_network_busy');
  const source = input.kind === 'source';
  const url = new URL(source ? canvasNodeSourceURL(input.url) : input.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('canvas_network_denied');
  const prompts = input.kind === 'prompts';
  const method = input.httpMethod;
  const headers = new Headers();
  if (source) {
    if (method !== 'GET' || input.body !== undefined || Object.keys(input.headers ?? {}).length) throw new Error('canvas_network_denied');
  } else if (prompts) {
    const id = /^\/yukkcat\/image-prompts\/main\/dist\/sources\/([a-z0-9-]+)\.json$/.exec(url.pathname)?.[1];
    if (url.hostname !== 'raw.githubusercontent.com' || !promptSources.has(id) || method !== 'GET' || input.body || Object.keys(input.headers ?? {}).length) throw new Error('canvas_network_denied');
  } else {
    if (input.kind !== 'provider' || url.hostname !== 'api.openai.com') throw new Error('canvas_network_denied');
    const allowed = method === 'GET' ? /^\/v1\/(?:models|videos\/[A-Za-z0-9_-]+(?:\/content)?)\/?$/
      : method === 'POST' ? /^\/v1\/(?:images\/(?:generations|edits)|responses|chat\/completions|videos)\/?$/ : undefined;
    if (!allowed?.test(url.pathname)) throw new Error('canvas_network_denied');
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (!['authorization', 'accept', 'content-type'].includes(name) || typeof value !== 'string' || value.length > 16384) throw new Error('canvas_network_denied');
      headers.set(name, value);
    }
    if (input.body !== undefined && (method !== 'POST' || !(input.body instanceof Uint8Array) || input.body.byteLength > maxBytes)) throw new Error('canvas_network_denied');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), source ? 15_000 : 120_000);
  const limit = source ? CANVAS_NODE_MAX_SOURCE_BYTES : prompts ? 8 * 1024 * 1024 : maxBytes;
  ++activeRequests;
  try {
    const response = await send(url.href, { method, headers, body: input.body, signal: controller.signal, credentials: 'omit', redirect: 'error', referrer: '', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (source && (response.status !== 200 || response.redirected || response.url && response.url !== url.href)) throw new Error('canvas_network_response_rejected');
    if (!active() || Number(response.headers.get('content-length')) > limit) throw new Error('canvas_network_response_rejected');
    const reader = response.body?.getReader();
    let total = 0;
    const chunks = [];
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (!active() || total > limit) throw new Error('canvas_network_response_rejected');
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    if (!active()) throw new Error('canvas_network_response_rejected');
    if (source) new TextDecoder('utf-8', { fatal: true }).decode(body);
    if (prompts && response.ok) JSON.parse(new TextDecoder().decode(body));
    return { status: response.status, contentType: source ? 'text/javascript' : prompts ? 'application/json' : (response.headers.get('content-type') ?? 'application/octet-stream'), body };
  } finally {
    controller.abort();
    clearTimeout(timeout);
    --activeRequests;
  }
}
