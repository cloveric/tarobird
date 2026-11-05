# Repository privacy

The active repository is `cloveric/tarobird`, initialized from a reviewed file
snapshot without importing old commits, PRs, tags, Actions records or Releases.
The old private repository remains a historical archive; this does not erase its
prior content or external copies. See [migration boundaries](repository-migration.md).

## Every main and PR upload

Read the root `AGENTS.md` upload gate before any GitHub write. Install this
checkout's hooks with `npm run privacy:setup` and verify with
`node scripts/setup-privacy-hooks.mjs --check`. This checks both effective
identities and refuses to replace unrelated hooks. Run `npm run privacy:staged`
before committing. The actual pre-push hook checks every outgoing ref, resolves
a new PR branch against the live remote main, and refuses shallow/missing
history. It scans new commit author/committer metadata, messages and every new
blob, including files removed before the final tree. An annotated tag's identity
and text are checked too. Full reachable Gitleaks/retired-ancestry checks remain.

```sh
npm run privacy:test
node scripts/check-upload-privacy.mjs range FULL_BASE_SHA FULL_HEAD_SHA
node scripts/check-upload-privacy.mjs text /private/output/pr-body.md
npm run version:check
```

Literal owner home directories, machine/tailnet names, common personal email
addresses and non-example public IPs are rejected, with values redacted. The
small public/synthetic address exceptions are not permission to add deployment
addresses. Review other private data manually; regex checks cannot establish
that all privacy data is absent. Do not put real strings into negative tests;
construct synthetic values. Keep reports private and upload only summaries.

New image/video/audio/document/font/archive/binary blobs need an exact path/SHA-256 review
record in `.privacy-reviewed-media.json`. `visual-review` means the exact image
was inspected; `generated-from-reviewed-source` means reviewed source plus
verified deterministic generation; `unpacked-review` requires inspection of the
container contents and metadata (including decoded audio and font names). An attestation is not proof produced by the
scanner: a reviewer must actually perform the stated work. Missing/stale entries
block upload. Changes to this manifest require the same independent scrutiny as
scanner/allowlist changes. Do not blanket-approve a directory or an old snapshot.

`.privacy-reviewed-text.json` records narrowly reviewed non-private matches:
synthetic test values, SVG coordinates, version/OID numbers and required public
upstream copyright attributions. Each entry binds the path, whole-file SHA-256
and each matched value's fingerprint and category. It does not waive the rest
of that file, other paths, changed bytes, Gitleaks, commit metadata or publication
text checks. Never use it to permit real owner paths, deployment addresses,
device names, credentials or private contact details. Re-review changed entries.
Screenshots/recordings need visual review and OCR where useful; binary releases
need unpacking plus UTF-8/UTF-16 strings, embedded paths, source maps, config,
symbols and metadata review. Use Rust/compiler path remapping before building.
Mac update tar members use neutral `root:wheel` ownership (UID/GID zero);
review header names as well as file contents. iOS exports omit optional symbol
uploads because generated symbol metadata embeds local archive paths. Keep
dSYMs privately for diagnostics; review them separately before any upload.

Before publishing PR/issue bodies, comments or release notes, run the text marker
scan **and** Gitleaks on the prepared text, then inspect linked attachments.
Git hooks cannot intercept GitHub UI/API comments. The GitHub workflow scans
PR titles/bodies on opened, edited, reopened and updated PRs, in addition to
new Git objects and product-version consistency. It does not cover arbitrary
issue comments, attachment pixels or all historical Actions records.

The former repository's ordinary main was an incremental base, **not a certified
clean baseline**. Its full empty-base audit reported old metadata/media; those
findings were separate remediation, not an allowlist. The November audit of
that repository confirmed residual screenshots/identities, old PR/history objects,
PR/Actions metadata and compiled home paths in published packages. Do not
republish raw findings, delete history, rotate credentials, or create a new
repository under the guise of enabling these gates. Those need their separately
approved scope. The owner-approved fresh-snapshot migration is documented above;
it does not certify the archived history. Native secret scanning/protection and required checks should
be enabled when the existing account permits them; do not change billing or
repository visibility automatically. Local hooks are bypassable and CI may be
unavailable; document exact checked SHAs and never label a non-started run pass.

This policy covers repository content and development workflows. It does not
rename real hosts, rotate credentials, change pairing identities or modify user
state. App/CLI runtime behavior is unchanged; no new App release is required.

## Public examples and evidence

- Use documentation addresses such as `203.0.113.10`, never a deployed relay IP.
- Use `~/Downloads`, `/Users/example`, `example-mac` and `示例电脑` in examples.
- Product screenshots and acceptance reports must remove personal paths,
  machine names, account details, private conversation content and deployment
  addresses before publication. Gitleaks does not reliably detect these.
- Label pseudonyms and omitted fields in sanitized evidence. Preserve the
  distinction between physical-device acceptance and browser/synthetic tests.
- Never commit host state, passports, `.env` files, service-account credentials,
  signing keys or raw scanner reports. A public key is not a private key.

## Future commits

Use the noreply email shown in **GitHub Settings → Emails**. Configure each
checkout without changing other projects' identity:

```sh
git config --local user.name "YOUR_GITHUB_LOGIN"
git config --local user.email "YOUR_GITHUB_NOREPLY_EMAIL"
git config --local core.hooksPath "$(git rev-parse --show-toplevel)/.githooks"
```

Install Node.js and [Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)
first; check the release checksum when using a downloaded binary. Hooks fail
closed if Gitleaks is missing or its version differs. Existing hooks must be
reviewed before changing `core.hooksPath`; using an absolute path also covers linked worktrees. Local configuration is not copied by
Git clone. Other computers must enable the hooks in their own checkout.

`pre-commit` checks both effective author and committer identities, including
environment overrides, then scans the **Git index**. Cleaning a working file
without staging the cleanup does not bypass scanning. `pre-push` scans full
reachable history. Before the secret scan, it rejects reachable pre-cleanup
ancestry, including old tags or branches copied from another machine. The guard
stores SHA-256 fingerprints rather than publishing the retired commit IDs.
The repository's POSIX and PowerShell pre-completion scripts also run both
checks through the same Node implementation. `check-secrets.sh` remains a
compatibility wrapper; scanner version, redaction and ignore policy are shared.
Both completion scripts also build/test the host, build the client and run the
native Cargo tests including integration targets.

```sh
node --test scripts/privacy-guards.node-test.mjs
node scripts/check-secrets.mjs staged
node scripts/check-secrets.mjs history
```

The [Secret scanning workflow](../.github/workflows/secret-scan.yml) runs on
pushes, pull requests and manual dispatch. It checks out full history and pins
the Gitleaks release and download SHA-256. It needs only read permission and no
paid scanner action/license, personal access token or uploaded source archive.
Output is redacted. Inline `gitleaks:allow` and `.gitleaksignore` bypasses are
disabled. The allowlist contains a deterministic Ed25519 **public** test key
and its fixed SPKI header in the historical synthetic pairing QR test. The
header exception requires both that exact value and that exact test path;
other values in the same file and the same header elsewhere remain scanned.
Neither value contains a private key or service credential.
Design 2.7.1 also contains a JavaScript comparison that Gitleaks mistakes for
an API key: `aria-keyshortcuts":J.shortcut===void `. Its exception requires both
that exact matched syntax and the exact `index-DyKwtQBI.js` asset path. The asset
is byte-identical to upstream commit `6759e358eb88d83986c753b0fc60c84e4aabdb3a`
(SHA-256 `886876c5751488924a13f1587190dfbf8871a67b01dbea9f611279e966302fe9`).
The expression checks whether a button has a keyboard shortcut; it is not a
string value or a credential. Regressions retain detection at other paths,
for changed syntax, for a quoted key value, and for credentials in the same file.
The regression source itself contains the same comparison and its quoted
negative-test value. A separate exact-path/exact-match exception permits only
those two known non-credentials in `scripts/privacy-guards.node-test.mjs`,
including its reachable history. Other credentials in that test remain detected.
The vendored Happy DOM worker also contains its upstream public virtual-server
example key. A separate exception requires both the complete unchanged PEM and
the exact vendored worker path; modified keys, other keys in that file and copies
at other paths remain detected. The source-byte comparison is recorded in
[the release preflight](client/release-1.0.123-preflight-2026-10-31.md). This fixture
is never used as a TaroBot identity, signing key or service credential.
Because Gitleaks 8.30.1 also auto-loads a worktree baseline despite an
explicit null ignore path, both scanning modes reject `.gitleaksignore` in the
working tree or index before invoking the scanner. Whole directories,
historical baselines and non-fixture private keys are not
allowlisted. Maintainers must review changes to the scanner and workflow.

Hooks can be bypassed and GitHub Actions can be unavailable. These controls
reduce accidental exposure; they do not prove that all privacy data is absent.
Do not call a queued or billing-blocked CI run successful. Enable GitHub native
secret scanning/push protection where the repository is eligible; do not change
repository visibility or purchase a plan as an implicit workaround.

## Historical cleanup is a separate migration

A normal commit only changes the current version. Old commits, branches, tags,
PR refs and copies may retain earlier content. Deleting Releases does not erase
Git history, and changing Git author settings does not rewrite past metadata.

Before rewriting, prepare an offline mirror and ref inventory, freeze pushes,
record open PRs and all active checkouts, then test content replacements and
author/committer metadata replacements in an isolated mirror. Preserve original
release binaries and SHA-256/signature evidence; their source SHA references
must be mapped to the rewritten history, not silently replaced in signed files.
Review the changed-ref/commit map before any force push. Existing clones must
re-clone or carefully rebase; merging old history would reintroduce it.

GitHub PR refs are read-only, and caches/forks/other clones cannot all be cleared
by a normal push. Support may need to review removal requests and may decline
requests involving non-sensitive data. See [GitHub's history-removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
Do not promise complete historical removal from a source commit alone.


## Completed history rewrite (2026-10-18)

The authorized rewrite covers the ordinary branches and tags of both repositories.
See [the migration record](privacy-history-cleanup-2026-10-18.md) for verification
and the remaining GitHub-managed PR refs/cache and external-copy limits.
Never merge or push pre-cleanup history from an older checkout. Preserve local
work as patches and apply it on a clean checkout of rewritten history, or use a
reviewed commit-map migration. Reinstall the local hooks after cloning.
