import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privacyKinds } from './check-upload-privacy.mjs';
try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (!event.pull_request || typeof event.pull_request.title !== 'string') throw new Error('Expected a pull request event.');
  const text = `${event.pull_request.title}\n${event.pull_request.body ?? ''}`;
  if (privacyKinds(text).length) throw new Error('PR title/body privacy markers found (values redacted). Edit the PR and rerun.');
  if (execFileSync('gitleaks', ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() !== '8.30.1') throw new Error('Gitleaks 8.30.1 is required.');
  const result = spawnSync('gitleaks', ['stdin', '--config', fileURLToPath(new URL('../.gitleaks.toml', import.meta.url)), '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--log-level', 'error'], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error('PR title/body secret scan failed (values redacted).');
  console.log('PR title/body privacy and secret scans passed. Attached media and linked pages require separate review.');
} catch (error) { console.error(error.status !== undefined ? 'PR privacy scan unavailable.' : error.message); process.exitCode = 1; }
