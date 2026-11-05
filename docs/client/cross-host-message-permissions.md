# Cross-host Bot message permissions

Open the **receiving host** in the App, then **Settings → Bot message permissions
→ Cross-host**. Bot settings opens the same permission page with that Bot as
the recipient. The Local scope continues to manage messages within one host.

1. Join the hosts to the same TaroBird network in Devices & Network.
2. Choose the source host and source Bot, then a receiving Bot on this host.
3. Review the displayed direction and select **Allow sending**. The App signs
   the exact change with the receiving owner's authenticated device and reads
   the resulting permission back from that host.

When this App is connected to the source host, ordinary Bots can be selected by
name. Internal workers are hidden; a manually entered ID matching a known
worker is also rejected. Without a live authenticated source connection, an
exact Bot ID can be entered with an explicit unverified-name notice. The
receiving host cannot independently verify the remote Bot's role or existence;
manual IDs retain the existing owner-controlled CLI semantics.

Authorization is one-way. It allows listing the receiving Bot's conversation
names and sending collaboration messages and files. The sender can retrieve
only replies to its own tasks; receiving the original task result does not need
a reverse grant. Joining a network or connecting the App does not grant Bot
message access automatically. Bots cannot approve their own access.

Existing CLI permissions appear in the same list. **Revoke access** blocks
subsequent sends and result queries without cancelling work already submitted.
Sources that have left the network and deleted recipients remain revocable.
Internal worker-target records remain stored and excluded, consistent with the
Local scope; existing CLI administration of those records is unchanged.

Network or permission changes invalidate an unsaved draft. If a save receipt
is lost, the page keeps an unconfirmed result until the owner explicitly reloads
and checks; it never retries the mutation automatically. Older receiving hosts
show an update instruction while Local permissions continue to work.

The CLI remains available: `tarobird messages grants --cross-host --json`
reads the same cross-host snapshot. `messages grants` without the flag still
lists local grants, and existing `messages allow` / `messages revoke` commands
retain their behavior. See [CLI usage](../host-cli.md).

Regression coverage includes owner/device proofs, replay and command tampering,
revision changes, removed peers, deleted targets, CLI compatibility, both grant
and revoke receipt loss, real isolated Hub messaging, source-name selection,
and Chinese/English browser layouts at phone and desktop widths. Isolated Hub
and browser tests do not establish physical multi-machine, native mobile,
installed-App or real-model acceptance.
