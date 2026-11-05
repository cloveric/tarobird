# Bubble text selection and copying

The reported desktop behavior selected a bubble and content below it. The old
client had no bubble-level double-click handler. A baseline WebKit run selected
only one word, so the screenshot's exact cross-message selection was not
reproduced; the requested whole-bubble selection was demonstrably missing.

`Content.tsx` now delegates double-clicks to `message-text-selection.ts`. It creates
a DOM range inside the current user bubble, individual reply card, or native
answer's prose. It never selects a virtual row or the conversation container.
Native answer status and process controls stay outside its prose range, and
separate cards in the same message retain separate selection boundaries.

Links, controls, editing fields, code, quote previews, message-delete selection,
and the phone long-press flow keep their existing interaction. Single-click and
ordinary substring drag selection remain available. Portal targets are rejected by DOM
containment, so selecting an expanded table or document cannot select the
underlying bubble. No global selection listener, delayed focus, layout changes,
or rendering state is added.

The subsequent toolbar report was reproduced with a real backward mouse drag
in WebKit: selecting a user bubble also included “引用” and “转发” from its toolbar.
`message-text-selection.css`, loaded by `Content.tsx`, marks message metadata,
avatars, run status/actions, usage metadata, buttons, disclosure controls and
code/table toolbars as non-selectable, including the WebKit-prefixed property.
These UI labels are excluded from both visible selection and the browser's
native clipboard serialization. Body prose, links, table cells, code indentation
and editable fields retain their selection behavior. Words such as “复制” and
“停止” in actual message content remain intact; no string filtering or clipboard
interception is used. Control click and keyboard semantics are unchanged.

CLI impact: not applicable. This is a browser/WebView text selection gesture;
message data, host APIs, queue behavior and model execution are unchanged.

Initial validation is recorded in `/Volumes/gdrive/taro-tmp/message-bubble-selection-20261023/`;
the control-selection follow-up is in `/Volumes/gdrive/taro-tmp/message-selection-controls-20261023/`.
Focused browser coverage: `message-selection`, `message-context-menu`,
`message-hold`. These checks cover rendered selection and selected-text copy,
background replies, adjacent cards, native answers, editable cards, code,
ordinary drag selection, portal isolation and existing phone long-press actions.
Follow-up tests use actual copy/paste (not a mocked clipboard) after mouse drag,
the selected-text context action and a range spanning multiple messages.
Browser/WebKit checks are not installed-App or physical-device acceptance.

Current result: all 24 browser cases passed (12 Chromium, 12 WebKit: 7 selection
cases, 1 context-menu case and 4 phone-hold cases per engine).
Client translation, TypeScript and Vite checks and the standalone build passed.
No App installation or release was performed for this change.
