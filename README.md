<p align="center">
  <img src="assets/tarobot-cover.png" width="100%" alt="TaroBird — Your agents. One conversation away.">
</p>

<h3 align="center">Your AI agents, running on your own computers.<br>The same conversations on desktop and phone.</h3>

<p align="center">
  Codex · Claude Code · Kimi Code · DeepSeek Harness · Antigravity
</p>

<p align="center">
  <a href="https://github.com/cloveric/tarobird/releases"><b>Download</b></a> &nbsp;·&nbsp;
  <a href="https://testflight.apple.com/join/ByFWEfFW"><b>iOS TestFlight beta</b></a> &nbsp;·&nbsp;
  <a href="#quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
  <a href="#connection-options">Connection options</a> &nbsp;·&nbsp;
  <a href="docs/details.md">Details</a> &nbsp;·&nbsp;
  <a href="docs/README.en.md">Docs</a> &nbsp;·&nbsp;
  <a href="README.zh-CN.md">中文</a>
</p>

https://github.com/user-attachments/assets/6cd6e2a9-92c9-47e5-96f1-8b0a02df69a7

<p align="center"><sub>57-second product overview · <a href="https://www.youtube.com/watch?v=R0WvfGiIFiw">YouTube</a> · <a href="assets/product/demo-en.gif">Animated overview</a></sub></p>

TaroBird is a self-hosted workspace for AI agents. It brings command-line agents such as Codex and Claude Code, running on your computers or servers, into a single conversation interface: assign tasks, answer questions, follow each run and receive deliverables from desktop or phone. Bots, conversations and files stay on your own hosts.

<table>
  <tr>
    <td width="33%" valign="top"><b>Native engines</b><br>Runs the official CLIs and keeps each engine's native agent capabilities.</td>
    <td width="33%" valign="top"><b>Desktop and phone</b><br>macOS, Windows and mobile share the same Bots and conversations, so work continues anywhere.</td>
    <td width="33%" valign="top"><b>Multi-host network</b><br>Each computer joins your private network with its own Bots.</td>
  </tr>
  <tr>
    <td valign="top"><b>Groups and collaboration</b><br>Multi-Bot groups with topics, plus visual workflows with Agent Bus.</td>
    <td valign="top"><b>Cross-host tasks</b><br>Bots hand tasks, files and results to one another across hosts.</td>
    <td valign="top"><b>ADHD mode</b><br>Up to 12 desktop conversations side by side, each moving independently.</td>
  </tr>
</table>

<h3 align="center">Desktop</h3>
<p align="center">macOS · Windows<br>Organize work by Bot or by conversation, inspect each run, and review replies and files.</p>

<p align="center">
  <a href="assets/product/desktop-en.png"><img src="assets/product/workspace-en.png" width="100%" alt="Desktop: the monochrome and warm-gray TaroBird window, with seven Bots, a file attachment and a table reply"></a>
</p>

<h3 align="center">Mobile</h3>
<p align="center">Start on your computer. Continue on your phone.<br>Read replies, answer questions and receive files in the same conversations.</p>

<p align="center">
  <a href="assets/product/phone-pair-en.png"><img src="assets/product/phone-pair-en.png" width="100%" alt="Mobile: the inbox and chat side by side in matching phone frames, with their original proportions preserved"></a>
</p>
<p align="center"><sub><a href="assets/product/mobile-en.png">Full-size inbox</a> · <a href="assets/product/mobile-chat-en.png">Full-size chat</a></sub></p>

<a id="adhd-workspace"></a>
<h3 align="center">ADHD · Parallel conversation workspace</h3>
<p align="center">Keep several Bot conversations in view, each moving independently.<br>Switch to ADHD beside Bots / Chats, then select the chats for your board.</p>

<p align="center">
  <a href="assets/product/adhd-en.png"><img src="assets/product/adhd-demo-en.gif" width="100%" alt="ADHD demo: starting from two panes, two more conversations are checked in the conversation list to add panes 3 and 4; the Codex launch-plan pane is expanded, then the board returns to four panes"></a>
</p>
<p align="center"><sub>Desktop only · macOS / Windows · Recorded from the real interface with demonstration data · <a href="assets/product/adhd-en.png">Full-size view</a></sub></p>

- **Work in parallel.** Select up to 12 chats across hosts. Each pane keeps its own messages, draft and input; removing a pane neither closes the conversation nor stops its running task.
- **Flexible layout.** Use automatic layout or 2–6 columns, resize the sidebar, reorder panes or expand one to focus. ADHD text size is adjustable from 11 to 16 px.
- **Actions in place.** Questions, replies and files stay in their own conversations, and the board layout is saved on this device.

<a id="agent-bus-workspace"></a>
<h3 align="center">Agent Bus · Visual multi-Bot collaboration</h3>
<p align="center">Assign a task to each step and see how work moves between Bots.<br>Open a saved Bus from the sidebar to view member conversations alongside the workflow.</p>

<p align="center">
  <a href="assets/product/agent-bus-en.png"><img src="assets/product/agent-bus-demo-en.gif" width="100%" alt="Agent Bus demo: a saved Product brief workflow with three member panes; the Configuration tab shows each step's Bot and task, then the Run tab shows Codex coordinating, Kimi's step complete and Claude writing the brief"></a>
</p>
<p align="center"><sub>Desktop only · macOS / Windows · Real interface with demonstration data and a simulated run status · <a href="assets/product/agent-bus-en.png">Full-size workflow</a> · <a href="assets/product/agent-bus-setup-en.png">Member configuration</a></sub></p>

- **Orchestrate the workflow.** Choose delegation, parallel work, sequential steps, verification or a research crew, and bind each step to a Bot and a result conversation with its own task.
- **Progress at a glance.** The flow shows the status of every step while the panes show its output. Saved Buses are reusable, and closing the panel does not stop a running collaboration.
- **Runs within one host.** Members work in independent sessions and record their results in the bound conversations. [Design and operation](docs/client/agent-bus-workspace-2026-10-18.md) · [Per-step tasks](docs/client/agent-bus-stage-tasks-2026-10-19.md)

<p align="center"><sub>Actual UI with demonstration data · <a href="assets/product/README.md">Screenshot provenance</a> · <a href="docs/client/adhd-board-2026-10-17.md">ADHD design and verification</a></sub></p>

<a id="group-chats"></a>
<h3 align="center">Groups and topics · Bring your Bots into one conversation</h3>
<p align="center">Put research, writing and review Bots in one group to work through the same question.<br>Join the group from desktop or phone, and organize each project or question into its own topic.</p>

<p align="center">
  <a href="assets/product/feature-groups-en.png"><img src="assets/product/feature-groups-en.png" width="100%" alt="A Product review group with Codex, Claude and Kimi, a Roundtable mode bar, a topics menu and replies from each Bot"></a>
</p>
<p align="center"><sub>Actual UI with demonstration data; replies are illustrative, not model execution · Group members currently belong to one host · <a href="assets/product/feature-group-modes-en.png">Discussion settings</a> · <a href="docs/client/group-discussion-2026-10-20.md">Group guide</a></sub></p>

- **Choose who replies.** In ordinary group chat, select or @ the Bots you want to answer. Switch to parallel replies for everyone to answer independently.
- **Keep topics separate.** Create topics within the group for different projects or questions. Topics use the same group members and keep their own conversation history.
- **Choose a discussion mode.** Use group chat, parallel replies, roundtable or independent review. Automatic discussions support speaking order and round limits, with controls to pause, resume or end a discussion.

<a id="bot-network"></a>
<h3 align="center">Connected Bots · One team across your computers</h3>
<p align="center">Give one Bot a goal. Let authorized Bots on other computers contribute their part.<br>Tasks, files and results travel between Bots; each machine runs its own work.</p>

<p align="center">
  <a href="assets/product/bot-team-en.png"><img src="assets/product/bot-team-en.png" width="100%" alt="A coordinating Bot on a Mac delegates to build and review Bots on Windows and research and analysis Bots on a server. Results return to the coordinator; authorized peers can also hand work to each other."></a>
</p>
<p align="center"><sub>Illustrative messaging pattern, not a live run · Each task direction needs permission</sub></p>

> “Ask the Windows Bot to build and test this change, and the server Bot to analyze the data. Bring their reports and files back here.”

- **One Bot can coordinate several machines.** In one task, tell a Bot which parts to send to which hosts. It acts as your point of contact, collects those replies and combines the results. Each receiving Bot works through its own engine and permissions on its host.
- **Peers can help one another.** A review Bot can ask a research Bot for context, or a coding Bot can hand a change to a test Bot. The same message flow works within one host and across hosts; a central Bot is optional.
- **Bring another computer's Bots into the team.** Connect the joining computer to an existing host, then confirm joining under **Settings → Network & connections → My network**. Authorized desktop and phone clients can access its Bots. Hosts must be online and mutually reachable for a handoff.
- **Keep the work traceable.** Dedicated collaboration conversations retain tasks and replies, and the recipient sees the source host and Bot. Files you hand off are copied to the receiving host; joining a network does not merge workspaces or grant access to every Bot.

**Choose who can communicate.** Manage same-host access in **Settings → Bot message permissions**. From 1.2.0, the receiving host’s owner can use its **Cross-host** tab to select a source host/Bot and receiving Bot, then allow or revoke by direction. Joining the network does not authorize messages. Replies to the original task do not need a reverse grant.

<p align="center">
  <a href="assets/product/bot-permissions-en.png"><img src="assets/product/bot-permissions-en.png" width="85%" alt="Actual cross-host message permission settings: Studio Mac's Coordinator is allowed to contact Build PC's Build and test Bot; the receiving owner can revoke the permission."></a>
</p>
<p align="center"><sub>App permission UI in 1.2.0 · Real settings and signed authorization with disposable hosts and fictional data; no model ran · Also available through <a href="docs/details.md#bot-to-bot-tasks-across-hosts">CLI authorization</a></sub></p>

This is a foundation for a coordinating Bot or a network of collaborating peers. Automatic host selection, cross-host scheduling and shared ticket tracking are future possibilities, not built-in capabilities today. **Agent Bus, groups and Chancellor ticket dispatch currently stay within one host**; cross-host work uses direct Bot messages.

[Permissions and recovery](docs/client/cross-host-message-permissions.md) · [Network setup](docs/details.md#private-network) · [Commands and delivery guarantees](docs/details.md#bot-to-bot-tasks-across-hosts)

<a id="conversation-features"></a>
<h3 align="center">Discuss, visualize and review</h3>
<p align="center">Group discussions, interactive replies, change review and voice transcription.</p>

<p align="center">
  <a href="assets/product/features-en.png"><img src="assets/product/features-en.png" width="100%" alt="Four TaroBird features: Codex, Claude and Kimi in a group discussion; a delivery chart with date filters; recorded code changes with a review comment; local, cloud and automatic voice transcription settings"></a>
</p>
<p align="center"><sub>Full-size views: <a href="assets/product/feature-groups-en.png">Group chat</a> · <a href="assets/product/feature-group-modes-en.png">Discussion modes</a> · <a href="assets/product/feature-visual-en.png">Interactive report</a> · <a href="assets/product/feature-changes-en.png">Run changes</a> · <a href="assets/product/feature-voice-en.png">Voice settings</a></sub></p>

- **Interactive replies.** Bots can present charts, timelines and filters directly in a reply, with an expanded view and history. [Interactive replies](docs/client/inline-widgets-2026-10-22.md)
- **Change review.** Step through the files each reply edited; on desktop, comment on lines and send them back to the Bot. [Recorded changes](docs/client/run-diff-2026-10-20.md)
- **Voice transcription.** Choose all-local, all-cloud or automatic routing by duration for each host. [Voice settings](docs/client/voice-transcription-settings-2026-10-21.md)

<a id="workbench"></a>
<h3 align="center">Workbench · Keep references and creative work beside the chat</h3>
<p align="center">Web browsing, canvas, whiteboard, Markdown notes and PPT in one workspace.<br>Each conversation keeps its own Workbench, in the side panel or expanded into the main area.</p>

<h3 align="center">Canvas · Turn an idea into something you can edit</h3>
<p align="center">Create pages, posters and visual drafts with your Bot.<br>Double-click text to edit and refine the result as you go.</p>

<p align="center">
  <a href="assets/product/workbench-canvas-en.png"><img src="assets/product/canvas-demo-en.gif" width="100%" alt="Canvas demo: open a warm studio launch page, double-click and edit its headline, then review the updated canvas"></a>
</p>
<p align="center"><sub>Recorded from the real interface with demonstration content · <a href="assets/product/workbench-canvas-en.png">Full-size view</a> · <a href="docs/client/workbench-design.md">Canvas guide</a></sub></p>

<a id="workbench-browser"></a>
<h3 align="center">Browser · Web pages inside the App</h3>
<p align="center">Open a web page in the conversation's Workbench; the Bot in that conversation can observe and operate the page within its limits.<br>Page tools include find, zoom, size preview, print to PDF, screenshots and downloads.</p>

<p align="center">
  <a href="assets/product/workbench-browser-en.png"><img src="assets/product/browser-demo-en.gif" width="100%" alt="Web browsing demo: open Field Guide in Workbench, take control, scroll its journal, follow a link to an article and continue reading"></a>
</p>
<p align="center"><sub>Desktop App only · Actual UI with demonstration data · <a href="docs/client/browser-page-tools-2026-10-31.md">Page tools</a></sub></p>

<a id="workbench-whiteboard-notes"></a>
<h3 align="center">Whiteboard and notes · Sketch ideas, keep decisions</h3>
<p align="center">Draw shapes, text, connectors and images on a whiteboard, and write Markdown notes with preview and autosave.<br>Edits from you and the Bot share the same versions and undo.</p>

<p align="center">
  <a href="assets/product/workbench-whiteboard-en.png"><img src="assets/product/workbench-whiteboard-framed-en.png" width="100%" alt="A whiteboard expanded in the conversation's main area: a title and three connected boxes for research, create and review, with drawing tools, Undo, Export and Send to Bot"></a>
</p>
<p align="center">
  <a href="assets/product/workbench-notes-en.png"><img src="assets/product/workbench-notes-framed-en.png" width="100%" alt="A Markdown note expanded in the conversation's main area, in editing mode with a heading, checklist and decision, saved on this device"></a>
</p>
<p align="center"><sub>Actual UI with demonstration data · Whiteboard by Excalidraw · Notes by Vditor · <a href="docs/client/conversation-workbench-2026-10-30.md">Workbench guide</a></sub></p>

<a id="workbench-side"></a>
<h3 align="center">Side panel · Chat and Workbench side by side</h3>
<p align="center">Workbench opens to the right of the conversation, so you can keep chatting while you work.<br>Resize the panel, show two to four tabs together with Split, or expand one tab to focus.</p>

<p align="center">
  <a href="assets/product/workbench-side-en.png"><img src="assets/product/workbench-side-framed-en.png" width="100%" alt="A conversation on the left with Workbench open in the side panel on the right"></a>
</p>
<p align="center"><sub>Actual UI with demonstration data · Each conversation keeps its own Workbench · Content stays on this device; export a project to move or back it up</sub></p>

<a id="remote-screen"></a>
<h3 align="center">Screen control · View and operate another Mac</h3>
<p align="center">Open an authorized Mac's screen from the desktop App. It starts in view mode;<br>choose Start control to operate it, then Stop control or return to your local chat to release it.</p>

<p align="center">
  <a href="assets/product/remote-screen-en.png"><img src="assets/product/screen-demo-en.gif" width="100%" alt="Remote screen demo: the viewer for Demo Studio starts in view mode, Start control switches to control mode with a release shortcut shown, and Stop control returns to viewing"></a>
</p>
<p align="center"><sub>Desktop App · requires access and macOS permissions on the target Mac · real viewer with a simulated frame and connection in this recording · <a href="docs/client/remote-screen-2026-10-31.md">Controls and permissions</a></sub></p>

<a id="chancellor"></a>
<h3 align="center">Chancellor · One goal, tracked as tickets</h3>
<p align="center">Choose Make it a Chancellor when creating a Bot, then describe the goal in its conversation.<br>It splits the work into tickets, runs each with an engine CLI on this host and reports back.</p>

<p align="center">
  <a href="assets/product/chancellor-en.png"><img src="assets/product/chancellor-demo-en.gif" width="100%" alt="Chancellor demo: in the Chancellor's conversation, the ticket summary expands into three tickets: Review implementation (active), Summarize feedback (needs your review) and Write the launch brief (queued)"></a>
</p>
<p align="center"><sub>Actual UI with demonstration data; ticket states are illustrative and no model ran · <a href="docs/client/dispatcher-bot-2026-11-01.md">Chancellor guide</a></sub></p>

- **Visible tickets.** See queued, active, waiting and ready-for-review tickets, and open any ticket's worker conversation.
- **You set the pace.** Approve each plan or let it dispatch on its own; choose the allowed engines and how many tickets run at once. Pause, cancel or add context at any time.
- **Pick the right tool.** A Chancellor plans and delegates; Agent Bus runs a workflow you define; ADHD keeps several conversations in view.

See the complete [feature list](docs/details.md#features).

<details>
<summary><b>More views: themes, folders and list options</b></summary>

<img src="assets/product/themes-en.png" width="100%" alt="Monochrome with a light warm-gray accent, in light and dark appearances">
<img src="assets/product/folders-en.png" width="100%" alt="Desktop conversation layout with project folders and a multi-Bot group">

Right-click a folder name or an empty area of the desktop list to group by host, show disconnected Bots or manage folders.

<a href="assets/product/list-options-en.png"><img src="assets/product/list-options-en.png" width="100%" alt="The desktop list options menu with Group by host, Show disconnected Bots and Manage folders"></a>

</details>

## Supported engines

<p align="center"><img src="assets/product/engines.png" width="100%" alt="Supported engines: Codex (codex), Claude Code (claude), Kimi Code (kimi), DeepSeek Harness (dsh), Antigravity (agy)"></p>

**Built on official native CLIs.** TaroBird does not reimplement agents. It runs the official command-line tools of Codex, Claude Code, Kimi Code, DeepSeek Harness and Antigravity. A harness is the execution system around a model — its agent loop, tool use, context and session management — and the harness a provider builds and tunes for its own model brings out the best in it. TaroBird adds desktop and phone access, multi-Bot collaboration and a unified workspace on top.

**Improves as the CLIs evolve.** When a host's CLI is updated, its gains in execution, context handling and reliability carry straight into TaroBird's Bots. Available capabilities depend on the installed CLI, account and adapter, and new interfaces may require further TaroBird adaptation. [Engine capabilities](docs/client/capability-map.md)

Install and sign in to any one engine on the computer that runs your Bots to get started; TaroBird does not include AI engines, model accounts or credits. See the [engine comparison](docs/details.md#engine-comparison) for adapter differences.

<a id="engines"></a>

> [!IMPORTANT]
> Most engines default to full access. Adjust this in the Bot's **Permissions & approvals**. See [Engines and permissions](docs/details.md#engines-and-permissions) for models, effort and permission details.

## Quick start

<table>
  <tr>
    <td width="33%" valign="top"><b>01 · Install the host</b><br>Install TaroBird on your computer, make it a host and create a Bot.</td>
    <td width="33%" valign="top"><b>02 · Pair your phone</b><br>Scan the QR code on your phone, then approve its 8-digit code.</td>
    <td width="33%" valign="top"><b>03 · Connect from anywhere</b><br>Reach your Bots over Tailscale or a VPS relay.</td>
  </tr>
</table>

### 01 · Install the host

1. Install the desktop App. On macOS, drag **TaroBird.app** into Applications; the App is notarized by Apple. On Windows, run the installer. The installer is not yet code-signed, so if SmartScreen appears, choose **More info → Run anyway**. Existing Mac users should use **Settings → General → App updates** to keep their current installation location; do not keep both TaroBot.app and TaroBird.app. For a manual upgrade, follow the [rename transition](docs/client/artifact-branding-2026-11-05.md#upgrading-an-existing-mac).
2. On first launch, choose **Use this computer as a host** and name the computer.
3. Create a Bot with an engine installed on this computer.

### 02 · Pair your phone

1. Install TaroBird on your phone. **iOS:** install Apple’s TestFlight app, then [join the TaroBird public beta](https://testflight.apple.com/join/ByFWEfFW). **Android:** use the APK from [Releases](https://github.com/cloveric/tarobird/releases).
2. On the computer, open **Settings → Network & connections → Add device**, choose a [connection option](#connection-options) and generate the QR code. The host restarts briefly the first time, so let current tasks finish first.
3. On the phone, open TaroBird and tap **Scan connection QR code**, or use **Import a QR image** or **Paste connection details**.
4. The phone displays an **8-digit pairing code**, valid for 5 minutes. Enter it on the computer and click **Approve pairing**; the phone then opens your chats automatically.

### 03 · Connect from anywhere

<a id="connection-options"></a>

**Connection options**

Each row is a different route to the **same computer running your Bots**.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 20, "rankSpacing": 24, "padding": 12, "subGraphTitleMargin": {"top": 8, "bottom": 14}}}}%%
flowchart TB
  subgraph lan["01 · Local network / LAN"]
    direction LR
    phone1("Phone") <-->|"Same LAN"| host1("Computer<br/>Runs Bots")
  end
  subgraph tailscale["02 · Tailscale · Remote"]
    direction LR
    phone2("Phone<br/>Tailscale") <-->|"Private<br/>network"| host2("Computer<br/>Tailscale")
  end
  subgraph relay["03 · VPS relay · Remote"]
    direction LR
    phone3("Phone") <--> vps("VPS<br/>Relay only") <--> host3("Computer<br/>Runs Bots")
  end
  lan ~~~ tailscale
  tailscale ~~~ relay
  classDef device fill:#f6f6f5,stroke:#b6bab7,color:#27312e
  classDef host fill:#fff1e4,stroke:#caa17c,color:#503b2a
  classDef relayNode fill:#edf3ee,stroke:#92a795,color:#304e39
  class phone1,phone2,phone3 device
  class host1,host2,host3 host
  class vps relayNode
  style lan fill:transparent,stroke:#b6bab7,rx:8,ry:8
  style tailscale fill:transparent,stroke:#b6bab7,rx:8,ry:8
  style relay fill:transparent,stroke:#b6bab7,rx:8,ry:8
```

| Option | Best for | What you need |
| :--- | :--- | :--- |
| **Local network (LAN)** | Phone and computer on the same Wi-Fi or reachable local network | No extra network service; devices must be able to reach each other |
| **Remote access with Tailscale** | Away from home, with Tailscale on both devices | Both devices in the same Tailscale network; no VPS of your own required |
| **VPS relay** | Away from home, with no VPN on the phone | A cloud server; we recommend letting an AI deploy it |

> [!TIP]
> **Let your own agent set up the VPS relay.** Give Codex, Claude Code or another agent the [ready-to-use setup instructions](docs/client/remote-access.en.md#ask-an-agent-to-configure-it), and ask it to follow the project documentation to deploy and verify the relay. The agent needs terminal access on your host computer and authorized SSH access to your VPS.

With every option above, Bots run on your computer, and chats, files and sign-ins stay there, so keep the computer on and online. **The VPS relay only forwards connections; it does not run your Bots.** To keep Bots working while the computer is off, see [running a full host on a VPS](docs/client/host-deployment.md).

**Option 1 · Tailscale**

1. Install [Tailscale](https://tailscale.com/download) on the computer and the phone, sign in, and join the same Tailscale network.
2. On the computer, open **Settings → Network & connections → Add device**, choose **Remote access with Tailscale** and click **Generate Tailscale QR code**. TaroBird detects the computer's Tailscale address automatically.
3. Scan and approve as in [Pair your phone](#02--pair-your-phone). A phone that is already paired can open **Me → Connection status & routes** and tap **Scan a code to update connection** to add the Tailscale route without pairing again.

Keep Tailscale connected on both devices, and make sure your Tailscale access rules allow the phone to reach the computer.

**Option 2 · VPS relay (recommended: let an AI deploy it)**

1. On the computer, open an AI agent that can use a terminal and SSH, such as Codex or Claude Code. Give it the complete [setup prompt](docs/client/remote-access.en.md#ask-an-agent-to-configure-it) together with the VPS SSH alias and the **path** to your private key (never the key itself). It deploys the relay, issues certificates with automatic renewal, verifies the connection end to end and returns an HTTPS address. To deploy it yourself, follow the [manual guide](docs/client/vps-relay-manual.md).
2. On the computer, open **Settings → Network & connections → Connection status & routes**. Under **VPS relays for this host**, click **Add VPS relay**, enter the address and click **Verify and save relays**.
3. If an already paired phone does not receive the new route automatically, open **Me → Connection status & routes → Edit routes → Add relay**, enter the same address and tap **Save routes**. A new phone can scan the computer's QR code with **VPS relay** selected.
4. Turn off the phone's Wi-Fi and confirm that it connects over cellular data.

### Add more computers

Install TaroBird on the new computer, choose **Connect to an existing host**, then scan or paste the connection details from **Add device** on a paired device. On any paired phone or computer, open **Devices & network → Enter code to confirm** and enter the 8-digit code shown on the new computer; there is no need to be at the host. If the new computer will run its own Bots, confirm joining the network when prompted. [Private network](docs/client/private-network.md)

For a host without a desktop window, use the [TaroBird CLI](#headless-host-tarobird-cli). On first launch, macOS may ask for keychain access; choose **Always Allow** ([why](docs/client/macos-keychain-prompts.md)).

## Headless host (TaroBird CLI)

Install the TaroBird CLI on a computer or server to run a host without the desktop App; phones still connect, send tasks and receive files. Assistants that can run commands, such as Dot or Grok, can also use the CLI to put TaroBird's Bots to work. [Installation and commands (中文)](docs/host-cli.md) · [Details](docs/details.md#run-a-host-without-a-desktop-window)

## Bot isolation and sharing

One Bot can hold many independent conversations that share its persona, model and workspace. Bots pointed at the same folder read and write the same files, and Bot processes are not operating-system sandboxes. [Details](docs/details.md#bot-isolation-and-sharing)

## More resources

| Resource | Contents |
| :--- | :--- |
| [Details](docs/details.md) | Features, engines and permissions, private network, cross-host tasks, CLI, prompt queue, isolation and sharing, architecture, where data goes, updating, building from source, project status, naming and compatibility |
| [Documentation index](docs/README.en.md) | Every design, setup and verification document |
| [Releases](https://github.com/cloveric/tarobird/releases) | Installers and per-release verification records |

## Acknowledgements

Thank you to the [LINUX DO](https://linux.do/) community for supporting TaroBird.

Workbench builds on [Excalidraw](https://github.com/excalidraw/excalidraw) for whiteboards,
[Vditor](https://github.com/Vanessa219/vditor) for Markdown notes, and
[Jim Liu's baoyu-design](https://github.com/JimLiu/baoyu-design) for the canvas and slide editors and their adapted authoring skills.
Thank you to their authors and contributors. Excalidraw and Vditor use MIT. baoyu-design has [mixed licensing](client/vendor/baoyu-design/NOTICE.md), with the reconstructed editor outside its MIT grant. Original copyright, scope notices and bundled
dependency notices are retained; see [third-party notices](LICENSING.md) and the
[Design integration guide](docs/client/workbench-design.md).

## License

Copyright (c) 2026 Cloveric. TaroBird is licensed under the
[GNU Affero General Public License v3.0 only (AGPL-3.0-only)](LICENSE).
See [license scope and third-party notices](LICENSING.md).
