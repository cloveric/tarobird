// Read-only prerequisite check. Never sends search queries / cloud ASR jobs,
// never reads credential-file contents, and never emits config values.
import { standardAsrReady } from '../dist/src/runtime/qwen-asr-paths.js';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadGatewayEnvironment } from '../dist/src/gateway/environment.js';
import { resolveSearchRouting } from '../dist/src/runtime/search-routing.js';
const { values } = parseArgs({ options: { 'state-dir': { type: 'string' }, probe: { type: 'boolean', default: false } } });
const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
const env = await loadGatewayEnvironment(values['state-dir'] ?? path.join(home, '.tarobot', 'diagnostics'), 'diagnostics', process.env);
const searchRouting = await resolveSearchRouting(env);
const exists = async value => !!value && await access(value).then(() => true, () => false);
const installed = path.join(home, '.tarobot/integrations/qwen3-asr');
const legacy = path.join(home, 'projects/qwen3-asr');
const legacyFallback = !standardAsrReady(installed) && await exists(path.join(legacy, 'transcribe.py'));
const local = legacyFallback ? legacy : installed;
const python = env.ASR_CLI_PYTHON ?? path.join(local, legacyFallback ? 'venv/bin/python3' : '.venv/bin/python');
const script = env.ASR_CLI_SCRIPT ?? path.join(local, 'transcribe.py');
const commandAvailable = async command => {
  try { await promisify(execFile)(command, ['-version'], { env, timeout: 5000, maxBuffer: 65536 }); return true; } catch { return false; }
};
const url = env.ASR_HTTP_URL ?? 'http://127.0.0.1:8412/transcribe';
let http = url ? 'not_probed' : 'disabled';
if (values.probe && url) {
  try {
    const health = new URL(url); health.pathname = '/health'; health.search = ''; health.hash = '';
    const response = await fetch(health, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    http = response.ok && (await response.text()).trim() === 'ok' ? 'ready' : 'unavailable';
  } catch { http = 'unavailable'; }
}
const tingwu = env.TINGWU_ASR_DIR?.trim();
console.log(JSON.stringify({
  search: { braveConfigured: searchRouting.providers.brave, tavilyConfigured: searchRouting.providers.tavily, usesNativeCodexFallback: searchRouting.source === "codex-fallback", providerCalls: 'not_run' },
  media: { ffmpeg: await commandAvailable('ffmpeg'), ffprobe: await commandAvailable('ffprobe') },
  localAsr: { http, pythonPresent: await exists(python), scriptPresent: await exists(script), legacyFallback, modelPresent: await exists(env.ASR_MODEL_PATH ?? path.join(local, 'models/Qwen3-ASR-0.6B')) },
  longAsr: { configured: !!tingwu, adapterPresent: await exists(tingwu && path.join(tingwu, 'tingwu_transcribe.py')), pythonPresent: await exists(tingwu && path.join(tingwu, '.venv/bin/python')), credentialFilePresent: await exists(tingwu && path.join(tingwu, '.env.local')), providerCalls: 'not_run' },
}, null, 2));
