# Upstream Integration Notes (basketikun/infinite-canvas @ 4c67f1e)

This extension integrates `basketikun/infinite-canvas` (MIT License, Copyright (c) 2026 basketikun) as a desktop-only, on-demand TaroBird Workbench extension.

## Minimal Adaptations
1. **Isolated Sandbox Entry & Host Storage Namespace**: Runs inside TaroBird's opaque-origin `PluginSandboxFrame` (`tarobird.plugin.v1`), scoping all local storage by `device + Host identity + user` with workspace JSON export/import.
2. **Isolated API Key Storage**: Model channel API keys are stored via TaroBird's isolated credential vault (`credentials.*`), never written to `localStorage`, Hub state, logs, or synced across devices.
3. **No Preset Unofficial Channels**: Removes promotional/unofficial channel presets (`chatgpt2api`, etc.); users configure their own OpenAI-compatible API endpoint and key.
4. **Offline Bundled Official Node Plugins**: Bundles the 6 official node plugins (`html`, `markdown`, `panorama`, `sticky-note`, `svg`, `template`) directly inside the signed extension artifact instead of fetching remote scripts from jsDelivr.
5. **Default-Off Third-Party Node Plugins**: Adds a per-scope `Allow installing third-party plugins` switch (default OFF) requiring explicit security-warning confirmation and per-URL confirmation; toggling it OFF disables third-party plugins without deleting them.
6. **TaroBird Host Canvas Agent Bridge**: Replaces launching upstream's standalone `canvas-agent` CLI/server process with TaroBird Host's compatible Canvas Agent bridge (`/api/canvas-agent/*`, protocol v12, 13 MCP tools) authorized by a short-lived tab-scoped token and conversation Bot permissions.
