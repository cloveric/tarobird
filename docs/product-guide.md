# TaroBot product guide

This guide explains how TaroBot works from the user's side: the core concepts, the everyday flows, which settings apply where, what syncs between devices, and the current limits. For screen-by-screen detail, see the [user guide](client/user-guide.md) (Chinese). For setup, see [Getting started](getting-started.en.md).

TaroBot is a development preview with test installers and a headless CLI package. Start with the [current downloads](https://github.com/cloveric/tarobird/releases); source development uses the separate setup guide above. This guide describes the shared client and marks source-only additions. Button names below are the English UI labels. Existing `tarocub` application IDs and data paths remain for compatibility; the product name is **TaroBot**.

**Contents:**
[Concepts](#1-concepts) ·
[Connecting](#2-connecting-devices-and-hosts) ·
[Everyday flows](#3-everyday-flows) ·
[While a Bot works](#4-while-a-bot-is-working) ·
[Context and memory](#5-context-memory-and-sessions) ·
[Setting scopes](#6-which-settings-apply-where) ·
[Sync](#7-what-syncs-and-what-stays-on-the-device) ·
[Operator tools](#8-operator-tools) ·
[Security and privacy](#9-security-and-privacy) ·
[Limitations](#10-current-limitations)

---

## 1. Concepts

| Term | What it is |
| :--- | :--- |
| **Host** | The computer or VPS where Bots run. It holds the engine CLIs and their logins, MCP servers, skills, workspaces and memory. |
| **Hub** | The service on the host that stores history, attachments and device trust, and syncs them to paired devices. It is the system of record. |
| **Bot** | A saved assistant configuration: engine, model, effort, default workspace and persona. A host can have many Bots. |
| **Conversation** | A direct chat with one Bot, the default discussion of a group, or a topic inside a group. |
| **Session** | The engine's own context for one Bot in one conversation. A multi-Bot group gives each Bot its own session. |
| **Device** | A paired desktop or phone app that controls a Hub. A computer may also act as a host, but viewing a remote Bot does not move its engine onto the viewing device. |
| **Route** | One way for a device to reach a Hub: a direct address (LAN or Tailscale) or a VPS relay. |

The single most useful distinction: **a Bot is configuration, and a conversation is a context.** Opening a new chat doesn't create a new Bot or ask you to choose a model again. It gives the same Bot a clean session.

## 2. Connecting devices and hosts

### Pairing a device

1. In the app, enter a device name and the Hub address, or scan the Hub's QR code from a trusted device.
2. Choose **Pair this device**. The app shows an 8-digit code and a confirmation QR code, both valid for five minutes.
3. Approve the request. From an already trusted device, go to **Settings → Devices & security**, scan the new device's QR code and confirm. With an installed host CLI, the owner can run `tarobot devices approve '<code>'` on the host (over SSH if the host is a VPS). For a separate development Hub, use the exact `node dist/src/index.js hub devices approve` command and state directory from [Getting started](getting-started.en.md#3-start-a-separate-development-hub).
4. Back on the new device, choose **Approved, connect**.

Scanning a QR code never approves anything by itself. If a pairing request appears that you didn't start, don't approve it.

### Choosing where the Hub runs

| Deployment | Path | Must be online |
| :--- | :--- | :--- |
| Your own computer runs the Bots | Device → direct address or relay → computer | The computer, plus at least one relay if you use relays |
| A VPS runs the Bots, reached directly | Device → VPS over HTTPS | The VPS |
| A VPS runs the Bots behind other relay VPSs | Device → relay VPS → host VPS | The host VPS and at least one relay |

A configured VPS route does not need Tailscale or a separate VPN on the phone. Your own computer can be switched off only when the Bots and Hub run elsewhere; a relay alone does not replace their host. Tailscale is an optional route for the self-hosted case. Saving addresses in the app does not deploy a relay, install Bots or migrate data. Start with [Agent-assisted or manual remote setup](client/remote-access.en.md); see also [Host deployment](client/host-deployment.md) (Chinese) and [Relay deployment](client/relay-deployment.md).

### Routes and failover

In current `main`, **Connection** is a separate entry immediately above **My network** under **Me** on phones and **Workspace** on desktop. The published App 1.0.83 still has the earlier **Settings → Connection** entry; this navigation change awaits packaging. See [the change and verification record](client/connection-navigation-2026-10-17.md).

Under **Connection → Edit routes**, enter an optional direct address and up to eight relay addresses in priority order. No deployment-mode selection is needed. Leaving the direct address blank uses relays alone; adding it back preserves the relay list. The app uses a working direct address first, then relays from top to bottom. When the active route fails, it switches routes and resumes from the same message IDs and sync position. When a higher-priority route has been stable again for a while, it switches back, after current replies, pending sends and uploads have finished.

All routes must reach the same Hub identity. A route that answers with a different identity is refused. Backup routes protect against a relay or network path failing. They are **not** a standby Hub: if the host or its network is down, every route is down.

Route preferences are stored per device. The **connection QR code** carries the full route list, so a newly paired device can import it.

### More than one host

A phone can pair with a Mac mini, a laptop and a VPS. A computer can run its own Bots and also control another host. Go to **Manage runtime hosts → Add host** (under **Me** on the phone, or at the top of the desktop sidebar) and pair with each host separately.

- The Bot and message lists show which host each item belongs to, and **All hosts** can be filtered down to one host.
- Bots or chats with the same name on different hosts stay separate, with their own sessions, files and drafts.
- A group can only contain Bots from one host. Hubs never merge their histories.
- File center, Skills & MCP, Operations and device settings apply to the host you have selected. Language and appearance apply to the device.
- **Remove this host** clears only this device's connection, cache, drafts, pending sends and keys for that host. The Hub keeps its history. If the host is offline, you must confirm removing only the local connection, and then revoke the device on the host later.

## 3. Everyday flows

### Create a Bot

Choose **New Bot**, then give it a name and pick an engine, model and effort. The host must already have that engine installed and signed in. If you leave the workspace empty, the Bot gets its own new folder. You can also point the Bot at an existing project. Creating a Bot starts a real supervised process on the host. Then choose **Start chatting**.

Switching a Bot's engine later clears session bindings that the new engine can't use. The running process switches after you choose **Restart when idle** in **Operations**.

### Chats, groups and topics

- **New chat** opens another independent conversation with the same Bot. The earlier chat stays in the list.
- **New group** brings existing Bots into one conversation. A one-Bot group is fine, and each Bot keeps its own configuration.
- **New topic** creates a separate thread inside a group, with its own sessions and drafts. **All topics** lists topics by recent activity and separates active topics from archived ones.
- **Reply with**, above the group composer, chooses which Bots receive the message. You can also type `@`.
- **Group reply mode** (`/config`, or `/group all`, `/group at` and `/group status`) sets whether a Bot hears every message in this group or topic, or only @-mentions. It affects that one Bot in that one conversation.

### Send text, images and files together

Write first or attach first; either order works. You can drag files in, paste images, or use the attachment menu (camera, photos and files on the phone). The message is published once, after every attachment has uploaded and been verified. If one attachment fails, nothing is published, and a retry sends everything together.

- Each file can be 1 byte up to the Hub's `maxFileBytes`, which is 512 MiB by default. The current limit is shown after you attach something.
- Uploads go in 8 MiB chunks. After a disconnect or route change, the app asks the Hub which chunks it already has and sends only the missing ones. **Cancel upload** keeps those chunks, so sending the same file again continues where it stopped.
- Switching to another conversation cancels an in-progress upload, so it can't land in the wrong place.
- Images open full size. Text, code, PDF, Word and Excel files have built-in previews, and HTML and SVG are shown as source. **Save as** opens the desktop save dialog. **Save to device** writes to **Downloads/TaroBot** on Android 10 or later, preserving duplicate names as separate files and reporting the actual location. Older Android and iOS use the system document save picker. Only completed saves report success.
- Phone file previews have separate **Share** and **Other apps** actions. Sharing opens the system share sheet; it does not claim a saved file. Opening in another app retains a readable temporary copy. Originals stay unchanged. Android saving has native emulator coverage; iOS document export and physical-phone acceptance remain separate.

### Downloads and recovery

Downloads retain completed 8 MiB ranges while reconnecting or switching routes, verify the file hash before export, and keep bounded local checkpoints across a reload. Click the file again to resume from a retained checkpoint; reopening the app does not automatically start a download. Checkpoints belong to this device and pairing, expire, and can be evicted by storage limits. Native process termination and phone lifecycle behavior still need real-device acceptance. This is not an OS background download service. See [download recovery](client/resumable-downloads.md).

### Quote and forward

- **Reply** quotes a message, including its attachments, above your new text. The Bot reads the quoted content within the same conversation. Use this to put a question to a file that was sent earlier.
- **Forward** copies a message, with its text, cards, images, audio, files and link preview, into another chat, group or topic, and labels where it came from. Cards in the copy are read-only, and later edits to the original don't change it. The picker shows destinations with Bot/group avatars, without repeating the forwarded content. Direct chats ask the destination Bot to reply by default; groups and topics only save the copy by default. Adjust **Ask a Bot to reply to this forward** and the selected Bots to change this.

### On your phone

The app opens to an IM-style inbox, with separate navigation for messages, Bots and your tools. The **Needs attention** filter brings pending questions and approvals together. Open a conversation for a focused full-screen chat; go back to the inbox to switch conversations.

Use the **+** button for camera, photos and files. Long-press a message to open reply, forward and other message actions. Tap a file card to open it; a separate “Open” label is unnecessary on the phone. You can customize your own avatar and the avatars for Bots and groups. These are shared through the Hub; the language, theme and font size stay specific to this device.

### Delete your own message history

Use a message's menu to delete it or enter multi-select. Deletion syncs to your own devices; it does not remove another member's copy, retract input already sent to a Bot, stop queued or running work, or delete shared attachment files. See [personal deletion](client/message-deletion-2026-10-16.md).

### Voice

Tap the microphone to record. You can then listen back, re-record, and add text or other attachments before sending. Unsent recordings stay on the recording device.

After you send, a transcription card shows its progress, and then the Bot continues with the transcript. Short audio uses a local model on the host. Audio of 15 minutes or longer uses a cloud transcription service if one is configured on the host, and falls back to local if that fails. Including `强制本地转写` (force local) or `强制云端转写` (force cloud) in the same message overrides the route. Gaps in a transcript are marked, never presented as complete. Recordings are capped at 64 MiB, and longer existing audio can be sent as an ordinary file.

### Link previews

Paste a link and the composer prepares a **card** by default. In **Settings → General → Messages → Link preview style**, choose **Card** (title, summary and cover when supplied by the website) or **Title** (title and domain). The preference applies to new links sent from this device; existing messages keep their saved style, which syncs with the message. The Hub fetches previews from public websites without your browser's logins. LAN, Tailscale and local management addresses are not fetched. A failed preview never blocks the message.

### Share from other apps

Android's share sheet and the iOS share extension save the text, link or files as a pending share in the app. You open the app, choose the conversation, edit if you like, and choose **Send share**. Nothing is sent automatically. Native share callbacks are not yet accepted on physical phones.

### Search and offline use

History search runs on the Hub. On the phone, choose **Search message history** below the inbox search field. You can filter by Bot, date range and attachments, and results open at the original message. Offline, you can read cached history and queue text messages, which are sent in order once you reconnect. After a long absence (more than 1,000 missing events), the app downloads a fresh snapshot before switching over to it.

## 4. While a Bot is working

### The run card

A running turn shows streamed text, tool calls and results, plans, and whatever reasoning progress or summaries the engine chooses to expose. That is not a guaranteed view of the model's private chain-of-thought. When the turn ends, tool details fold into a summary.

### Questions and approvals

Questions and approval cards can be answered from any paired device. The other devices show the decision, and the card becomes read-only. On the phone, the **Needs attention** filter gathers questions and approvals that have synced to that device.

| Choice | Meaning |
| :--- | :--- |
| Allow once | Only this request |
| Allow for this turn | Covers the current task |
| Allow for this session | May also cover later messages in this conversation. Use it deliberately. |
| Kimi's "allow subsequent calls" | Kimi's own persistent rule, not limited to this turn |
| Deny | Refuses the request |

Engines offer different buttons. If "allow once" isn't offered, the app won't upgrade your choice to a longer grant. Codex permission requests show the exact host paths and network scope, and approval grants exactly what was shown. Antigravity in normal mode asks once before the turn, not per tool. Stopping a turn cancels any approval it is still waiting for.

### Queue, steer and stop

| You want to… | Do this | What happens |
| :--- | :--- | :--- |
| Add another task | Send normally | It queues as the next turn. Attachments, quotes and commands work as usual. |
| Adjust the task that's running | **Steer** (text only, one Bot) | Codex and DeepSeek Harness accept the text into the current turn. **CLI accepted steering** means the engine received it, not that output stopped at that instant. Other engines report "unsupported" and keep your draft. |
| End the current task | **Stop**, or `/stop` | Cancels the current turn, any transcription in progress and any attachments still waiting to be combined. Queued turns continue. In a group, all Bots in this discussion are asked to stop, and other topics are unaffected. |

Steering and stop requests go straight to the host. They are never queued offline or replayed after a reconnect, so an old stop can't hit a new task. If a steering result is uncertain because of a timeout, use **Check steering receipt** instead of sending it again. Tools that have already run are not undone by stopping.

### Interruptions and recovery

- A dropped network connection or a Hub reconnect is not an interruption. The app catches up on the same turn.
- If the Bot's process restarts mid-turn, the run is marked as interrupted. Content received so far is kept, and stale buttons are closed. The turn is **not** re-run automatically, to avoid repeating commands. Check the result and send again if needed.
- A final reply that had already been generated is redelivered after a restart. If delivery is uncertain, it is marked as a possible duplicate. The model is not run again.

### Goals

`/goal` runs a longer, self-directed objective where the engine supports it: Codex (bridge-managed), Claude Code, DeepSeek Harness (durable native goals with a token budget) and Antigravity. Kimi Code rejects it explicitly.

## 5. Context, memory and sessions

- **A new chat, group or topic starts a fresh session.** It inherits the Bot's model, effort, workspace and persona, but not any earlier transcript.
- **Switching devices does not start a new session.** The desktop and the phone are looking at the same conversation.
- **Workspace files persist** across conversations, because they are files in a folder. But "the memory file still exists" and "the new session reads it" are different things. TaroBot has no cross-engine memory system that forces every memory file into context. Each engine discovers project instructions and memory by its own rules, or when you ask it to read a file.
- **Bots are not sandboxes.** Separate Bots get separate workspaces by default, and you can point several at one project. Engine-wide settings in the host's home directory (logins, plugins, global memory) may be shared between Bots.

See the [Bot isolation and sharing table](details.md#bot-isolation-and-sharing) for the scopes of private chats, groups, shared project folders, devices and hosts.

| Command | Effect |
| :--- | :--- |
| `/resume` | Bind an existing native session to this conversation, using each engine's own syntax (Codex: `/resume thread <id>`). **Continue an existing session** in the advanced options of **Conversation settings** applies when the next message is processed. Chats bound to the same session share context and serialize their turns. |
| `/detach` (**Disconnect from the current session**) | Return to the pre-resume context if one exists; otherwise detach the current session and start fresh. Visible messages and workspace files remain. |
| `/reset` | Start a new context for this conversation. The workspace and chat history remain. |
| `/stop` | Stop the current turn. The session stays bound. |

The owner can edit the Bot's persona from **Bot settings → Persona** or the Bot section of conversation details. All conversations with that Bot use the same persona; changes apply to subsequent work without deleting history or cancelling active tasks. Memory files remain managed on the host, separately from this editor. See [persona editing](client/persona-mobile-polish-2026-10-12.md).

## 6. Which settings apply where

| Setting | Applies to | Same on all your devices? |
| :--- | :--- | :---: |
| Engine, model, effort, workspace, persona | The Bot: all its chats, groups and topics | Yes |
| Group reply mode | One Bot in one group or topic | Yes |
| Collaboration permissions and crew roles | One Bot (owner only) | Yes |
| Name, archive, mute, session binding | One conversation | Yes |
| Read state, File center labels, avatars | That Hub | Yes |
| Trusted devices, maximum file size | That Hub | Yes |
| Routes (direct address, VPS order) | This device, for one host | No |
| Notification preferences, app lock | This device | No |
| Language, theme, palette, font size | This device | No |
| Default link preview style for newly sent links | This device; the sent message retains its chosen style | No |

**Effort** is Bot-wide, with no per-conversation override. Saving it creates no message and no new session, doesn't cancel running work, and is applied at the engine's next safe point. The picker shows choices supported by the selected engine and model; some models have no separate effort override. **Use defaults** removes the override and does not mean thinking is off. An offline Bot's effort can't be changed. If another device changed the setting first, you are asked to reload instead of overwriting it. See [Effort settings](client/effort-settings.md).

## 7. What syncs and what stays on the device

**Synced through the Hub** to every device paired with it: messages and attachments, streaming progress and final replies, question and approval decisions, read state, renames, archives, mutes, session bindings, and groups and topics created on any device. A device that was closed or offline catches up when it reconnects, without resending messages it had already submitted.

**Kept on each device:**

- Unsent drafts: text, attachments, recordings, quotes and the selected recipients
- Pending shares from other apps
- Pinned lists, theme, palette, font size and language
- The conversation you are currently viewing (the desktop reopens it, and the phone opens to the inbox)
- Route preferences and notification preferences
- Cached history, plus recently viewed attachments up to 16 MiB each (128 MiB in total)

Drafts never sync, so typing on the phone won't overwrite what you left on the desktop. The Hub and the Bots' host must be online for anything to run. Closing the app on a phone doesn't stop work on the host.

## 8. Operator tools

These are available to the Hub owner's trusted devices, from the desktop sidebar or **Me** on the phone.

- **Operations:** service state for each Bot, and a restart that waits until the Bot is idle so that no running turn gets cut off.
- **Bot dashboard:** live activity (running, queued, waiting for approval), scheduled tasks with their next run and recent history, the latest research-crew stages, and usage by UTC day or month. Missing data stays "unknown", never zero. Kimi Code reports no per-turn usage, and only Claude Code reports dollar cost. The dashboard's schedule list is read-only; use **Scheduled tasks** to create, edit, pause or remove a schedule. Runs aren't guaranteed while the host is offline.
- **Activity records:** the task timeline (runs, retries, file delivery, collaboration) and audit logs, plus the Hub audit (pairing, logins, revocations, approvals, restarts), with filters and paging.
- **File center:** an inventory of Bot workspaces, received attachments and transcripts, with sizes and sources. Labels and notes are shared across devices. It never deletes or moves files.
- **Skills & MCP:** an inventory of what each Bot's engine configuration declares. "Found" doesn't mean loaded or online. The page can prepare a configuration request for you to review and send to the Bot in a separate conversation; opening it does not install or authorize anything.
- **Bot collaboration on one host:** `/ask`, `/fan`, `/chain` and `/verify` let one Bot delegate to others, and **Start Bot collaboration** offers the same without remembering instance IDs. Both Bots must allow each other, and creating a group doesn't grant that. Dropped connections and timeouts never re-run a delegation automatically. A five-role research crew can be enabled per Bot.
- **Bot-to-Bot messages across hosts (App 1.0.83 / CLI 0.1.431):** the new `conversations list`, `messages send` and `messages wait` CLI commands send text/files to an authorized Bot and retrieve its reply. They default to a dedicated collaboration chat and use the normal durable queue. They do not answer approval cards or turn Agent Bus commands into cross-host commands. Use a current matching App/CLI release on both hosts; 0.1.431 is the feature minimum, not an upgrade target. See [examples and authorization](details.md#bot-to-bot-tasks-across-hosts).
- **Backup and restore:** with the Hub and its Bots stopped, `tarobot backup <new-dir>` captures device trust, attachments, Bot configuration, sessions and default workspaces. `tarobot restore <backup-dir> --state-dir <original-host-path>` requires the original path to be absent; it does not overwrite an existing host. External project folders and engine logins need their own backups. The automatic daily backup covers the database only. Follow the [CLI backup and restore steps](host-cli.md#更新备份与恢复); separate development Hubs use the explicit state-directory commands in [Operations](client/operations.md#backup-and-export).

Type `/help` in any chat for the commands the current engine supports, and `/config` for the Bot's settings card.

## 9. Security and privacy

- **Approving a device is an authorization decision.** A trusted device can make a Bot run commands on the host. Approval is owner-only, single-use and expires after five minutes.
- **Transport:** remote connections require HTTPS with a pinned Hub identity. Plain HTTP is for loopback development only. A new address or route is accepted only after it proves the same Hub identity.
- **Revocation:** revoke a lost device from another trusted device. A device that was offline receives a signed denial when it reconnects. Revocation removes access. It doesn't erase history already cached on that device.
- **App lock:** phones can require Face ID, fingerprint or the device passcode when reopening. Previews in the app switcher are covered, and on Android screenshots are blocked. It protects the screen, and it is not a substitute for revocation.
- **Relays** pass TLS traffic through. They store no chat or file copies and don't decrypt the content.
- **The Hub stores everything** on its host. A Hub on a VPS means your data is on that VPS. Application-layer end-to-end encryption is deferred.
- **Third parties:** prompts and attachments go to each engine's model provider. Configured cloud transcription receives audio. Link previews are fetched by the Hub from public sites.

Details: [Security model](client/security.md).

## 10. Current limitations

- **Distribution:** test installers and CLI archives are available from [Downloads](https://github.com/cloveric/tarobird/releases), with platform-specific versions and limits. Android keeps the original signing certificate; macOS uses an ad-hoc signature without Apple notarization. There is no app-store release. Source changes do not update an installed App or frozen CLI runtime automatically.
- **Phones:** SDK builds, physical-device behavior, backgrounding, camera, microphone, push delivery, share-sheet callbacks and Android Back gestures are not yet accepted on real devices.
- **macOS:** only bounded native scenarios have been verified. Notification banners appear, but clicking one to navigate is not yet verified.
- **Windows:** 1.0.83 includes the native-startup fix missing from the old 1.0.76 candidate. See the [final-package verification and boundaries](client/release-1.0.83-2026-10-17.md); it remains an unsigned development preview.
- **Multiple hosts:** cross-host Bot messaging passed real Mac mini ↔ Windows text/file/reply round trips with isolated Hubs and real Codex Bots. This does not certify production installers, every engine, native clients controlling each other or multi-host phone push. See the [scope and receipts](client/cross-host-bot-messages-2026-10-17.md#验证记录).
- **Transfers:** uploads and downloads have recovery support. Download checkpoints are bounded, local to a device and not encrypted at rest by this feature. Phone process termination, OS storage eviction and background transfer behavior still need target-device acceptance.
- **Performance:** native resident memory is above the 200 MB target.
- **Engine gaps:** steering works only on Codex and DeepSeek Harness. Kimi Code has no goals or usage reporting, and its project MCP servers load only after the workspace is trusted in native Kimi. Antigravity approves per turn, not per tool, and has no manual compact.
- **Settings:** effort and persona are Bot-wide, with no per-conversation override. The app edits the Bot's persona, but does not provide a memory-file editor.
- **Feishu-only features** such as document-comment events and video meetings are not emulated in the app.

What has and hasn't been verified, with evidence: [Project status](project-status.md) (Chinese) and [Acceptance gates](client/acceptance-gates.md) (Chinese).
