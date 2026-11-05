# Documentation

[Home](../README.md) · [中文文档导航](README.md)

## Start here

| I want to… | Read |
| --- | --- |
| Read the detailed sections moved off the README | [Details](details.md): features, engines and permissions, Bot-to-Bot tasks, CLI, queues, isolation, where data goes, updating, building from source, project status, naming and compatibility |
| Understand the product and everyday workflows | [Product guide](product-guide.md) |
| Download an App and check platform-specific limits | [Current downloads](https://github.com/cloveric/tarobird/releases) |
| Build a local Hub and pair my first device | [Getting started](getting-started.en.md) |
| Install, run or update a headless host | [Host CLI — 中文](host-cli.md) · [Update and rollback — 中文](host-cli-update.md) |
| Send tasks from one Bot to another host's Bot | [Authorization, commands and receipts — 中文](client/cross-host-bot-messages-2026-10-17.md) (implemented in source; packages pending) |
| Check supported platforms and remaining acceptance work | [Project status](details.md#project-status) |
| Find detailed screen-by-screen instructions | [User guide — 中文](client/user-guide.md) |
| Pair devices and join computers | [Remote pairing](client/remote-pairing-2026-10-14.md) · [Private network](client/private-network.md) |
| Use queues, reply markers or Claude process details | [Queue](client/prompt-queue-2026-10-14.md) · [Reply status](client/user-reply-status-2026-10-16.md) · [Claude event scopes](client/claude-scoped-process-2026-10-15.md) |
| Discuss, visualize or review code | [Group modes](client/group-discussion-2026-10-20.md) · [Interactive replies](client/inline-widgets-2026-10-22.md) · [Recorded run changes](client/run-diff-2026-10-20.md) |
| Adjust avatars, density or themes | [Conversation avatars](client/conversation-avatars-2026-10-13.md) · [Density](client/layout-density-2026-10-13.md) · [CLI/Pixel](client/cli-pixel-themes-2026-10-12.md) |
| Configure notifications, voice or search | [Voice routing settings](client/voice-transcription-settings-2026-10-21.md) · [Notification requirements](client/message-notifications-2026-10-14.md) · [Integrations](integrations.md) |
| Compare engines and trust boundaries | [Capability map](client/capability-map.md) · [Permissions](permissions.md) · [Security](client/security.md) |
| Develop or release | [Entrypoint map](entrypoint-map.md) · [CLI parity rule](../AGENTS.md#desktop-mobile-and-cli-evolve-together) · [Release checklist](release-checklist.md) · [Docs index](README.en.md) |

## Hosts, connections and data

- [Client architecture](client/architecture.md) and [protocol](client/protocol.md)
- [Security model](client/security.md): pairing, device revocation and TLS identity
- [Host deployment — 中文](client/host-deployment.md) and [relay deployment](client/relay-deployment.md)
- [Remote phone access with an Agent](client/remote-access.en.md) or [manual VPS relay commands](client/vps-relay-manual.md)
- [Multiple hosts — 中文](client/multiple-runtime-hosts.md)
- [Download recovery](client/resumable-downloads.md): interrupted transfers, local checkpoints and device limitations
- [Hub operations — 中文](client/operations.md): configuration, backups and restore

## Bots and engines

- [Bot, conversation and session scopes — 中文](client/session-model.md)
- [Effort settings](client/effort-settings.md) and [mid-turn steering — 中文](client/steering.md)
- [Capability map — 中文](client/capability-map.md)
- [Skills and MCP](client/skills-mcp.md)
- [App platform instructions and structured tools — 中文](client/app-platform-prompt.md)
- [Telegram and Feishu/Lark reference](full-reference.md)

## Contributing and verification

Read the [entrypoint map](entrypoint-map.md) before changing code. Root tests and
builds run in default CI; browser and native matrices have separate workflows.
See the [acceptance gates](client/acceptance-gates.md) and
[implementation records](client/implementation-status.md) for detailed evidence.
Those engineering records are primarily in Chinese.

Dated review documents describe the version and environment tested at that time.
Their local screenshots, traces and recordings are not distributed with this
repository. The [homepage screenshots](../assets/product/README.md) use controlled
demonstration data and record their capture date and client version. Installers
are distributed as GitHub Release assets.
