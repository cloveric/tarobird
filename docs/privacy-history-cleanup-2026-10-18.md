# Privacy history cleanup — 2026-10-18

After the initial current-content cleanup, the owner explicitly authorized removal
of the audited personal information from historical Git content and metadata.
This is a repository migration; App, mobile and headless CLI behavior is unchanged.
No App/CLI rebuild, credential rotation, host rename or runtime-state migration
is required by this change.

## Completed

- Rewrote historical text, filenames, commit messages and known personal
  author/committer/tagger identities in isolated mirrors. Replaced the audited
  relay address, home-directory paths, personal device names and private email
  metadata with documentation examples or GitHub noreply identity.
- Preserved every reachable commit and every branch/tag name. The current main
  file trees were byte-identical before and immediately after the rewrite.
  The follow-up privacy guard and this record are separate new changes.
- Published affected heads/tags with atomic pushes and explicit per-ref leases.
  Actions was temporarily disabled to avoid replaying all historical tag builds,
  then restored to its original settings and read back successfully.
- Updated 22 TaroBot and 30 legacy Release records where target commits or text
  needed migration. Release asset IDs, names, sizes and GitHub digests remained
  unchanged. Installers, manifests and their original signatures were not edited.
- Migrated four local checkouts and their ten working directories. Preserved
  dirty edits, staging and five local-only review commits; anonymized the one
  overlapping fixture without discarding its unrelated edits.
- Extended the shared pre-push/pre-completion/CI history scan to reject retired
  ancestry, including old tags. Only SHA-256 fingerprints of retired boundaries
  are committed, not the old commit IDs or removed personal values.

| Repository | Branches | Tags | Commits preserved in full rewrite mirror | Changed published refs |
| --- | ---: | ---: | ---: | ---: |
| TaroBot | 36 | 94 | 429 | 130 |
| Legacy TaroCub | 1 | 460 | 1,072 | 458 |

Commit and annotated-tag IDs change when their content or ancestry changes.
Git signatures tied to those old objects cannot survive the rewrite. This is
separate from the unchanged installer/update-artifact signatures. Original
artifact source-SHA references can be correlated with the private migration map;
do not rewrite signed release assets to make them appear rebuilt.

## Verification

- Fresh clones from GitHub exactly matched the rewritten ordinary heads/tags.
  Reachable blobs, commits, trees and annotated tags were checked for the audited
  personal markers, with zero remaining matches. Both fresh clones passed Git
  integrity checks.
- Full reachable-history Gitleaks scans passed. Three privacy-guard regression
  tests passed in each repository, covering effective identity, staged/history
  secret detection and rejection of retired branch/tag ancestry.
- All ten migrated worktrees retained their previous dirty status and staging;
  file bytes and normalized patches were compared, allowing only the intended
  fixture anonymization. Private offline backups and old-to-new commit maps were
  stored on the external disk with restricted access and push URLs disabled.
- These local checks do not establish success of a GitHub Actions run. The
  private repository previously reported an account billing/spending block;
  cloud execution must be reported independently. On the follow-up guard commits,
  the public legacy Secret scanning run `39050143327` passed. Private runs
  `39050132320` and `39050132343` executed zero steps because GitHub reported
  failed account payments or a spending-limit block.

## Remaining limits

GitHub still retains 44 TaroBot and 2 legacy read-only PR head refs pointing to
pre-cleanup commits. Old commit API URLs remain accessible. The owner approved a concrete Support
request, which was submitted through the authenticated GitHub Support portal.
The portal confirmed successful submission and an open ticket. Removal and
server-side cache/garbage collection remain pending; submission is not deletion.

The private repository reports zero forks. The legacy public repository reports
three third-party forks, so it is not accurate to assume the old public project
has never been copied. Those copies cannot be rewritten through the owner's
repository, and no fork owner was contacted or their repository modified.

Offline checkouts on other computers were not remotely modified. They must not
merge or push old history. Preserve their local work as patches, use a clean
checkout of the rewritten repository, and reinstall the local hooks. The guards
reduce accidental reintroduction; they can be bypassed and are not a server-side
pre-receive guarantee.

See [GitHub's removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
for the separate treatment of read-only PR refs, caches and external copies.
