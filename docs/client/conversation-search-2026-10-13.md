# Desktop current-conversation search

Mac 1.0.51 adds a magnifying glass beside the connection and more-actions icons
in the conversation header. Cmd+F (Ctrl+F on other desktops) opens the same
search and focuses its keyword field. The header identifies the host and chat.
Keyword, date and attachment filters apply to that exact conversation, with
server pagination across its full history. Selecting a result locates the
original message. Closing or pressing Escape retains the draft and returns
focus to the search button. Dialogs and file previews keep their own shortcuts.

The sidebar remains a host-wide search. Entering it after a scoped search
removes the conversation restriction. Another chat with the same Bot, the
parent group's default discussion and sibling topics do not count as the
current conversation. `conversationId` is an additive filter on both search
HTTP routes; membership remains required on every page. The cursor binds the
scope, while old host-wide cursor hashes remain unchanged. No migration is
needed. Unsupported hosts prompt for an update without falling back to
host-wide results. Out-of-scope responses are rejected before rendering.

Validation uses isolated Hubs with synthetic messages, including 135-message
history and 55 matching messages split across pages. It verifies older-message
navigation, draft retention, both keyboard shortcuts, Escape and close-button
focus, same-Bot conversation isolation, scope changes, modal shortcut ownership,
rejected/ignored filters on older hosts, authorization, cursor scope and
revocation. The existing global search, phone search, offline queue, reset and
native-back regression paths are covered too.

- `hub-search` and `hub-server`: 56 checks passed.
- Chromium `search`, `hub`, `local-reset`, `native-back`: 11 passed.
- WebKit `search`: 4 passed, including modal shortcut ownership.
- Root standalone build and client translation/type/build checks passed.

The Mac installer bundles the matching 0.1.415 host. Remote hosts need the
corresponding host update. Browser-engine acceptance does not claim an
installed-native or real-phone test; the installed App and live host data were
not replaced. No phone installer or public release is part of this change.

The Apple Silicon DMG passed checksum verification, strict ad-hoc App signature,
arm64/version/icon checks, and byte equality for the mounted App's executable,
all 378 bundled client files and all 296 host distribution files. The Downloads
copy matches SHA-256
`9d90fd78d7f98392cd75b4f967b480240b6640c5b7e5e7da95483503d14b6953`.
The final Chromium shortcut check also passed after adding close-button focus
and modal-ownership assertions.
