import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { privateCommitIdentity } from './check-git-identity.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const zero = value => /^0+$/.test(value);
const media = /\.(?:png|jpe?g|webp|gif|avif|svg|ico|icns|pdf|mp4|mov|webm|m4a|mp3|wav|ogg|flac|docx?|xlsx?|pptx?|woff2?|ttf|otf|jar|zip|gz|tgz|dmg|exe|dll|node|apk|ipa)$/i;

// Only synthetic/public build identities are allowed in literal home paths.
// Do not add an owner's identity here to make a scan pass.
const exampleUsers = new Set(['example', 'user', 'username', 'test', 'tester', 'runner', 'runneradmin', 'node', 'vsts', 'build', 'builder', 'ci', 'shared', 'public', 'default', 'alice', 'bob', 'a', 'lab', 'secret', 'attachment-specific']);
export function privacyFindings(text) {
  const findings = new Map();
  const add = (kind, value) => {
    const fingerprint = hash(value);
    findings.set(`${kind}:${fingerprint}`, { kind, fingerprint });
  };
  for (const match of text.matchAll(/(?:\/(?:Users|home)\/|[A-Za-z]:[\\/]+Users[\\/]+)([^\s/\\"'<>:;`{}$]+)/g)) {
    if (!exampleUsers.has(match[1].toLowerCase())) add('personal-home-path', match[0]);
  }
  const hostText = text.replace(/\b(?:env|example|test|localhost|host|machine|workstation|computer|device|mdns)\.local\b/gi, '');
  for (const match of hostText.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\.local\b|\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b|(?:["'`]|https?:\/\/|@)[a-z0-9-]+\.local(?=[\s/:'"`])/gi)) add('device-or-tailnet-name', match[0]);
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@(?:gmail|hotmail|outlook|icloud|qq|163|126)\.(?:com|net)\b/gi)) add('personal-email', match[0]);
  for (const match of text.replace(/(?:Chrome|Chromium|Edge|Edg|OPR)\/[0-9.]+/g, '').matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const ip = match[0], parts = ip.split('.').map(Number);
    if (parts.some(part => part > 255)) continue;
    const [a, b, c] = parts;
    const documented = a === 192 && b === 0 && c === 2 || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113;
    const localOrReserved = a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
    if (!documented && !localOrReserved && !['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '100.64.0.1'].includes(ip)) add('non-example-public-ip', ip);
  }
  return [...findings.values()];
}
export function privacyKinds(text) {
  return [...new Set(privacyFindings(text).map(finding => finding.kind))];
}

function revision(value) {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) throw new Error('Use a full commit SHA, not a shell expression or moving ref.');
  return git('rev-parse', '--verify', `${value}^{commit}`).trim();
}

function manifestAt(head, name = '.privacy-reviewed-media.json') {
  try {
    const value = JSON.parse(git('show', `${head}:${name}`));
    if (value.format !== 1 || !Array.isArray(value.entries)) throw new Error();
    return value.entries;
  } catch { return []; }
}

function scanBytes(bytes, context, approvals, file, failures, textReviews = []) {
  const digest = hash(bytes);
  // Public license attributions, synthetic fixtures and numeric graphics/version
  // data can look private. Review only the exact match in exact file bytes;
  // no path globs, whole-file waiver or relaxation of commit/publication scans.
  const reviewed = textReviews.filter(entry => entry.path === file && entry.sha256 === digest
    && /^[a-z0-9][a-z0-9-]*$/i.test(entry.reviewer ?? '')
    && typeof entry.note === 'string' && entry.note.length >= 12 && Array.isArray(entry.findings));
  for (const finding of privacyFindings(bytes.toString('utf8'))) {
    if (!reviewed.some(entry => entry.findings.some(item => item.kind === finding.kind && item.fingerprint === finding.fingerprint))) {
      failures.push(`${context}: ${finding.kind}`);
    }
  }
  if (media.test(file)) {
    if (!approvals.some(entry => entry.path === file && entry.sha256 === digest
      && /^[a-z0-9][a-z0-9-]*$/i.test(entry.reviewer ?? '')
      && ['visual-review', 'generated-from-reviewed-source', 'unpacked-review'].includes(entry.method)
      && typeof entry.note === 'string' && entry.note.length >= 12)) failures.push(`${context}: media-review-required (${digest.slice(0, 12)})`);
  }
}

export function checkRange(base, head) {
  head = revision(head);
  if (base) base = revision(base);
  if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') throw new Error('Privacy scans require full history; fetch --unshallow first.');
  const exclusions = base ? [`^${base}`] : [];
  const commits = git('rev-list', head, ...exclusions).trim().split('\n').filter(Boolean);
  const failures = [];
  for (const commit of commits) {
    const raw = git('show', '-s', '--format=%an <%ae> %at %ai%x00%cn <%ce> %ct %ci%x00%B', commit).split('\0');
    // Use raw identities so environment overrides and historical local emails
    // are checked, not merely the current checkout's git config.
    const identities = git('cat-file', 'commit', commit).split('\n').filter(line => /^(author|committer) /.test(line));
    if (identities.length !== 2 || identities.some(line => !privateCommitIdentity(line.replace(/^(author|committer) /, '')))) failures.push(`${commit.slice(0, 12)}: private-commit-identity-required`);
    for (const kind of privacyKinds(raw.at(-1))) failures.push(`${commit.slice(0, 12)}: commit-message-${kind}`);
  }
  const entries = manifestAt(head);
  const textReviews = manifestAt(head, '.privacy-reviewed-text.json');
  // Scan every newly introduced blob, including intermediate commits and
  // deleted-before-HEAD material. A clean final diff alone is insufficient.
  const objects = git('rev-list', '--objects', head, ...exclusions).trim().split('\n').filter(Boolean);
  const blobPaths = new Map();
  for (const object of objects) {
    const space = object.indexOf(' '); if (space < 0) continue;
    const oid = object.slice(0, space), file = object.slice(space + 1);
    if (git('cat-file', '-t', oid).trim() === 'blob') blobPaths.set(`${oid}:${file}`, { oid, file });
  }
  // Git object enumeration lists a reused blob only once. Inspect each changed
  // tree path too, so copying previously reviewed bytes elsewhere cannot inherit
  // a path-specific text or media approval.
  for (const commit of commits) {
    const changed = new Set(git('diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '--no-renames', '-r', '-z', commit).split('\0').filter(Boolean));
    for (const row of git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t'), file = row.slice(tab + 1);
      if (!changed.has(file)) continue;
      const [, type, oid] = row.slice(0, tab).split(' ');
      if (type === 'blob') blobPaths.set(`${oid}:${file}`, { oid, file });
    }
  }
  let blobs = 0;
  for (const { oid, file } of blobPaths.values()) {
    const bytes = execFileSync('git', ['cat-file', 'blob', oid], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    scanBytes(bytes, `blob ${oid.slice(0, 12)}`, entries, file, failures, textReviews); blobs++;
  }
  if (failures.length) throw new Error(`Upload privacy blocked (${failures.length} findings; values redacted):\n${failures.slice(0, 60).join('\n')}`);
  console.log(`Upload privacy passed: ${commits.length} new commits, ${blobs} new blobs; base ${base?.slice(0, 12) ?? 'empty repository'}. Historical base is not certified clean.`);
}

function checkStaged() {
  let approvals = [];
  let textReviews = [];
  try { approvals = JSON.parse(git('show', ':.privacy-reviewed-media.json')).entries ?? []; } catch {}
  try { textReviews = JSON.parse(git('show', ':.privacy-reviewed-text.json')).entries ?? []; } catch {}
  const failures = [];
  const files = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean);
  for (const file of files) {
    const bytes = execFileSync('git', ['show', `:${file}`], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    scanBytes(bytes, `staged file ${hash(file).slice(0, 12)}`, approvals, file, failures, textReviews);
  }
  if (failures.length) throw new Error(`Staged privacy blocked (values redacted):\n${failures.slice(0, 60).join('\n')}`);
  console.log(`Staged privacy passed: ${files.length} files.`);
}

function prePush(remote) {
  const lines = readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!localRef || !remoteRef || !localSha || !remoteSha) throw new Error('Malformed pre-push input.');
    if (zero(localSha)) continue; // Deletion introduces no content.
    const versionScript = new URL('./release-version.mjs', import.meta.url);
    execFileSync(process.execPath, [fileURLToPath(versionScript), 'git', revision(localSha)], { stdio: 'inherit' });
    if (git('cat-file', '-t', localSha).trim() === 'tag') {
      const tag = git('cat-file', 'tag', localSha);
      const ident = tag.split('\n').find(row => row.startsWith('tagger '))?.slice(7);
      if (!ident || !privateCommitIdentity(ident) || privacyKinds(tag).length) throw new Error('Annotated tag contains an unsafe identity or privacy marker (values redacted).');
    }
    let base = zero(remoteSha) ? undefined : remoteSha;
    if (!base) {
      // A newly published PR branch must scan all changes since the live main,
      // even when its commits already exist in another local/remote-tracking ref.
      const rows = git('ls-remote', '--heads', remote, 'refs/heads/main').trim();
      if (rows) base = rows.split(/\s+/)[0];
    }
    checkRange(base, localSha);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'staged' && !args.length) checkStaged();
    else if (mode === 'range' && args.length === 2) checkRange(args[0] === 'EMPTY' ? undefined : args[0], args[1]);
    else if (mode === 'pre-push' && args.length === 1) prePush(args[0]);
    else if (mode === 'text' && args.length) {
      for (const file of args) {
        if (privacyKinds(readFileSync(file, 'utf8')).length) throw new Error('Publication text contains privacy markers (values redacted).');
      }
      console.log('Publication text privacy markers: clean. Run Gitleaks and review images/links separately.');
    } else throw new Error('Usage: check-upload-privacy.mjs staged | range BASE_SHA|EMPTY HEAD_SHA | pre-push REMOTE | text FILE...');
  } catch (error) {
    // Git subprocess stderr may include private paths. Never echo it.
    console.error(error.status !== undefined ? 'Privacy scan could not read complete Git evidence; fetch the required refs and retry.' : error.message);
    process.exitCode = 1;
  }
}
