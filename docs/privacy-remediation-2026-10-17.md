# Privacy remediation — 2026-10-17

This is the record of the initial current-content cleanup. The owner later
authorized [history rewriting on 2026-10-18](privacy-history-cleanup-2026-10-18.md);
the historical-assessment status below describes the earlier checkpoint.

Applied the corrected privacy audit in three parts: current content cleanup,
future-commit protection, and a separate assessment of historical cleanup.
No application runtime or live host identity/configuration was changed.

## Changes

- The current TaroBot test relay address already uses the documentation-only
  `203.0.113.10`; the personal Downloads path was already removed in 1.0.90.
- Replaced remaining personal device names and user paths in documentation,
  examples and matching test fixtures. Cross-host evidence explicitly labels
  display-name pseudonyms and omits OS patch versions; it retains isolated test
  IDs and file hashes so the actual acceptance result stays auditable.
- The old public TaroCub repository also replaces personal paths in two tests.
- Configured GitHub noreply identities in the local working checkouts, including
  the existing legacy checkout. No global Git identity setting was changed.
- Added effective-author/committer checks, staged Gitleaks scans, a pre-push
  full-history scan, a pre-completion gate and the dedicated Secret scanning CI.
  Tool version and CI download hash are pinned; logs redact findings.
- Documented setup and limits in [repository privacy](repository-privacy.md).
  Hook installation is local to each computer; CI travels with the repository.

## GitHub controls

The public legacy repository already has native secret scanning and push
protection enabled. The private TaroBot repository rejected an enable request
with HTTP 422: “Secret scanning is not available for this repository.” Its
visibility was not changed and no paid subscription was activated. The local
checks and independent Gitleaks workflow do not require GitHub native scanning.
Cloud Actions availability must be reported separately from local scanner tests.

## Historical cleanup assessment

The original audit snapshots contain 425 reachable TaroBot commits and 1,070
legacy TaroCub commits. Of those, 171 and 879 respectively contain a Gmail
address or local-hostname metadata. These are **snapshot counts**, not a claim
that every such commit contains a credential or that every current ref changes.

Remote inventory during remediation:

| Repository | Branches | Tags | PR head refs |
| --- | ---: | ---: | ---: |
| TaroBot | 36 | 94 | 44 |
| Legacy TaroCub | 1 | 460 | 2 |

A history rewrite must cover affected branches/tags and author/committer
metadata, preserve an offline mirror, generate old-to-new SHA maps and coordinate
all Mac/Windows checkouts. Existing release manifests and acceptance records
reference old source SHAs, so they need a documented mapping; signed artifacts
must not be silently edited. PR refs and cached views need separate handling,
and copies held by other people cannot be erased by a repository commit.

**No historical rewrite, force push, tag deletion, Release deletion or repository
visibility change was performed.** This implements the corrected report's
instruction to assess historical cleanup separately. Historical IP/path/device
names and email metadata may still be reachable through old refs. The complete
migration procedure and its limits are in [repository privacy](repository-privacy.md#historical-cleanup-is-a-separate-migration)
and [GitHub's guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

## Verification

The privacy-guard regression exercises personal-email/local-hostname rejection,
index-versus-worktree secret detection, inline-bypass rejection, public-key
allowlisting, historical detection after removal, and redacted errors. Full
reachable-history Gitleaks scans passed in both local repositories. Current
tracked text was checked again for the personal markers identified by the audit,
with no remaining matches. This is not proof that every possible privacy issue
has been eliminated. Historical binaries, third-party clones and external
caches were not re-audited.

TaroBot fixture validation: 19 focused unit tests and 60 Chromium browser checks
passed (58 host/network/sidebar checks plus 2 ADHD layout checks). The standalone
build passed with 359 modules and no legacy transport/Feishu SDK dependency.
One initial ADHD invocation used the wrong working directory and could not load
the client; the corrected client-directory invocation passed.

Legacy fixture validation: the 4 changed cases passed. The wider two-file run
had 414 passes and 1 pre-existing failure in the temporary-placeholder test with
an external-volume TMPDIR. Running that same failing case from the unmodified
baseline reproduced the identical assertion. This privacy change does not alter
the legacy delivery implementation or claim that suite is fully green.

The 3 equivalent legacy fixture cases in the current TaroBot tree also passed.

## Verified GitHub execution

- Legacy public repository: [Secret scanning run 39046669494](https://github.com/cloveric/tarocub/actions/runs/39046669494)
  completed successfully on implementation commit `577105e`. Download checksum,
  guard regressions and full reachable-history scanning all executed and passed.
- Private TaroBot: [Secret scanning run 39046660755](https://github.com/cloveric/tarobot/actions/runs/39046660755)
  on implementation commit `17325ab` executed **zero steps**. GitHub reported an
  account payment/spending-limit block. Its local staged and full-history scans
  passed; this is not a successful private-repository cloud run.
- GitHub read-back confirmed both implementation commits on their respective
  `main` branches and both author/committer emails using GitHub noreply.
