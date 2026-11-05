# Conversation files

The desktop and phone chat ellipsis menu now has a **Files** entry. It opens
the current conversation's shared attachments, newest first, with name, size,
sender, source conversation and sent time. A scope selector can show files
across accessible conversations containing one of this conversation's Bots,
including archived conversations, groups and topics. Current-conversation scope
does not silently include a group's other topics.

File-name search is literal and paginated in pages of 50. Failed page requests
retain the displayed rows and retry the requested page; changing scope/search
or closing the panel aborts the old request. Each file uses the existing
authenticated preview/download/save flow and can open its original message.
Navigation preserves conversation drafts. The separate workspace inventory
remains available from the workspace menu.

`GET /api/conversation-files` validates the anchor conversation's membership
and optional Bot membership on every request. Source conversations require
current user and Bot membership. Cursors are bound to user, anchor, scope and
query. Results join current messages to completed attachment receipts and media
blocks; they exclude pending uploads, unsent attachments, withdrawn messages,
removed media and link-preview covers. No caller-supplied filesystem path is
accepted. Existing authenticated attachment download checks remain in force.

The shared file preview also handles raster images and browser-supported audio
and video with local object URLs, released on close. HTML/SVG remain text.
Escape from a nested preview now stops propagation so the underlying file list
stays open.

## Verification

- Standalone and client production builds passed.
- 19 focused Hub tests passed: conversation files, attachment downloads and
  link previews. File tests cover sender/source, nested card images, user
  uploads, removed/draft/cover exclusions, direct/group/topic/archived scopes,
  permission changes, literal names and cursor isolation/pagination.
- Chromium: nine journeys passed across conversation files, document preview
  and attachment safety. WebKit: four journeys passed across conversation
  files and attachment safety. The new journeys cover desktop and phone entry,
  scope/search, Word/Markdown/image preview, downloaded byte equality, returning
  focus, source-message navigation, draft preservation, empty results, pagination,
  request failure/retry and superseded responses. Failure injection disables
  service workers so WebKit cannot bypass the test's request interception.
- A separately identified Tauri preview connected to an isolated temporary Hub.
  Native checks opened the ellipsis file entry, previewed Word, closed the
  preview with Escape without losing the list, switched to all Bot conversations,
  searched for an older file and jumped to its source message.
- Native file panel (historical image omitted from this clean snapshot).

The preview app and temporary Hub were stopped after inspection. Installed
production apps, Bot services and their data were unchanged. No installer was
released and no Android physical-device acceptance is claimed.
