# TaroBird repository migration

`cloveric/tarobird` is the active development repository, initially private.
`cloveric/tarobot` is retained as a private historical archive.

The new repository starts with a reviewed current-file snapshot and fresh commit
history. No old commits, PRs, issues, tags, Actions records, release assets or
repository secrets are imported. Historical development notes describe earlier
work; they are not new package or physical-device acceptance. Historical test
screenshots are omitted rather than republished with device information.
Product images use demonstration data. Copyright/license notices are retained.

## Releases and existing installations

This migration publishes no Release, changes no product version, installs no App
and restarts no Host. The new Releases page remains empty until an explicit
release request. Its first release will contain only the then-current version;
the historical release catalog stays in the archive. All future GitHub Release
titles and notes are written in English.

Future builds must use `TAROBOT_GITHUB_REPOSITORY=cloveric/tarobird`. The existing
desktop build planners validate this setting, and GitHub workflows use their own
repository context. Before shipping, authorize the updater GitHub App for the
new private repository, provision the required CI signing credentials through
their approved secret stores, and verify the exact new manifest/download URLs,
signature and source binding. Repository source does not carry those secrets.

Already installed binaries still read the old repository's release endpoint;
creating this repository does not redirect them. Keep the archive and existing
release assets accessible. The first new release must provide a verified one-time
installer upgrade that preserves Host state and then reads updates here. Do not
republish changed bytes under an old version or assume automatic migration.
App IDs, signing keys, Keychain services, saved paths and compatibility CLI names
remain unchanged. Windows native installation and physical-phone acceptance must
be recorded separately from source and package checks.

## Development and privacy

Use the new repository for every future commit, PR and release. Do not fetch and
merge old history or mirror old refs here. Import needed changes as reviewed
patches and run the normal staged, exact-outgoing-range and full-history scans.
Enable the checkout hooks and use a GitHub noreply commit identity.

Fresh history avoids importing old GitHub records. It does not erase the archive,
GitHub-managed caches or copies previously downloaded by others, nor is it a
guarantee that a scan detects every kind of private information. Continue review
of source, screenshots, documents, binary metadata and every publication.
