# baoyu-design canvas editor

Source: https://github.com/JimLiu/baoyu-design
Pinned commit: `016a68e1b1ac1c7c291b2cb88d66ff087e50b017` (2.15.2).
Component: `skills/claude-design/scripts/editor` and its artifact format references.
Mixed licensing: the maintainer's original work is MIT; the reconstructed editor, references and Anthropicons are outside that grant. Retain LICENSE, NOTICE.md and editor/third-party-licenses.txt. See upstream NOTICE.md for the stated scope; availability here does not expand its grant.

Vendored files remain byte-for-byte intact and are checked against UPSTREAM.json
before every build. client/design-assets.ts applies bounded adaptations at
build time: show the framed toolbar, bind the synthetic local file service,
omit unimplemented upstream comment/chat capabilities, settle active editing
before the upstream save handshake, map local assets in
initial/live previews, and retain full blob URLs for runtime/Babel resources. A mismatch fails the build.
The adapter is separate TaroBird code. The upstream server, model integration,
dashboard/design-system editors and host-writing skill are not installed. PPT
uses the separately pinned editor in `client/vendor/baoyu-slides`.

The trusted loader only redirects to an opaque data document; project HTML never
runs in the App origin. A per-tab MessagePort provides bounded files and CAS
persistence. External requests and native APIs are unavailable. No local HTTP
service or remote CDN is required. See docs/client/workbench-design.md.

The upstream standalone server and its unused `editor/share-ui.js` are excluded. LAN sharing, roles and the Share button are not part of this embedded integration.
