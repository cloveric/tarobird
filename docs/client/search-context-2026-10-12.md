# Search page context

Desktop history search kept the active conversation's header, avatar and chat
menu above results from multiple conversations. The existing dedicated search
header was only rendered on phones, so desktop results appeared conversation
scoped even though the query was host scoped.

Both layouts now show **Search message history** and **Search scope: {host}
· All conversations**. The selected conversation's identity, chat menu and
details panel are absent while searching, including loading, empty and error
states. The details panel's state is preserved when returning to the chat.
Search filters, permission checks and host boundaries are unchanged.

Closing search restores the desktop conversation and draft; phone close/back
continues to return to the inbox. Selecting a result opens its conversation
and focuses the matching message.

## Validation

- Added assertions to the existing search journey. Before the fix, the desktop
  check failed because the search header was missing.
- Root standalone and client production builds passed.
- Chromium and WebKit: 3 existing journeys each passed, covering desktop/phone
  scope, restored draft/details, result navigation, empty/invalid/loading
  states, literal matching, filters, pagination, failed/superseded requests,
  and phone inbox return with unread/draft preservation.
- Built a separately identified Tauri preview. With an isolated temporary Hub,
  native search displayed five hits across conversations beneath the search
  header; close restored the original conversation and its unsent draft;
  selecting another hit opened that conversation.
- Native search screenshot (historical image omitted from this clean snapshot)
  and phone WebKit screenshot (historical image omitted from this clean snapshot).

The installed production app, Hub/Bot services and their data were unchanged.
No installer was released and no Android physical-device check was performed.
