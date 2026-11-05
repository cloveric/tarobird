# Topic rename and removal — 2026-10-12

The phone topic strip previously led to discussion and the topic directory, but
rename/archive were buried in general conversation settings. Topics now have
explicit **Rename topic** and **Delete topic** actions in the current chat's
more menu and beside every active topic in the directory, on phone and desktop.
The directory action targets its own topic without selecting that conversation.

## Scope and behavior

- The existing creator-only Hub rename/archive protocol is reused. No new
  backend route, schema, destructive delete or session migration is introduced.
- Rename preserves the topic ID, parent group, messages, engine session, binding
  and draft. It closes after the Hub update reaches the durable client cache.
- Delete requires confirmation and uses recoverable archive. Only that topic is
  removed from the active list; the group and sibling topics are unaffected.
  History remains under **All topics → Archived**, where it can be restored.
  Running tasks are not stopped; the confirmation states this explicitly.
- Removing the current topic from either new entry returns to the parent group;
  removing another topic leaves the current chat and draft in place. A second
  device already reading the archived topic retains its read-only history.
- Server changes synchronize across paired devices. Offline and non-owner
  actions are disabled. Parent-group archive removes its directory actions.
- If a notification selects another topic while deletion is waiting for the
  server, completion checks the latest selection and does not redirect it back.
- Escape/native Back closes the top dialog and restores focus. The phone topic
  navigation unmounts when its host workspace becomes hidden, avoiding stale
  topic dialogs after an external host navigation.

## Verification

Production browser checks use an isolated Hub, two paired clients, 390px and
320px phone widths, and a 1360px desktop observer. The fixture deliberately gives
the group and one topic the same name. It covers both menus, cross-device rename,
sibling deletion, cancellation, offline controls, restoring history and drafts,
retaining session/binding IDs, current-topic return to the group, native Back,
focus return and a minimum 44px directory action target.

- Chromium and WebKit each passed all three topic journeys, including delayed
  deletion followed by notification navigation. Each engine also passed 13
  related checks across `topics`, `conversation-rename`,
  `conversation-context-actions`, `group-settings` and `native-back`.
- Initial WebKit fixture failures were corrected: unread text changed a tab's
  accessible name; browser offline emulation did not close existing WebSockets.
  The final test stops/restarts the isolated Hub to establish real disconnection.
- Client TypeScript/Vite build, Android unit tests, release lint and assembly
  passed. Sanitized captures and package receipt are in
  [`evidence/topic-actions-2026-10-12`](evidence/topic-actions-2026-10-12).
- The default-concurrency root gate had six failures in the unchanged
  `tests/service.test.ts` (timeouts and subsequent polling state assertions),
  with 222 other files passing. Its isolated rerun passed all 172 checks.
  The full `pre-complete-hook.sh` gate then passed with `VITEST_MAX_WORKERS=2`:
  223 files, 2875 tests passed, one existing skip. Default-concurrency test
  reliability remains a separate harness issue; no assertions or skip flags
  were changed to obtain this result.

## Package and acceptance boundary

The Android package is `0.1.412-test.1`, versionCode `2026101227`, package
`com.tarocub.client`. It uses the same certificate as `0.1.411-test.1`.
All 376 bundled web assets match the synchronized production build byte-for-byte;
the signed package/version, signature, adaptive launchers and 15 icon variants
were verified. Shared desktop source is included on main; this Android
release does not replace the installed Mac App. Browser validation and APK
verification do not establish physical-phone or installed native WebView
acceptance. No production host, relay or legacy adapter is restarted.
