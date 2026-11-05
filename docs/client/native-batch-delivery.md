# Native App batches and persisted tool versions

2026-10-03. New Codex App sessions can use `app_send_batch` to publish a titled
image gallery together with other attachments and captions in one message.
The model's tool call reaches the Gateway directly; no response-text directive
is needed. Existing native single-file and compatibility paths remain available
according to the native thread's actual registered tool version.

## Publication contract

- Up to 50 artifacts, 512 MiB total, absolute allowed-root paths. Captions are
  limited to 12,000 characters each and 200 KiB combined after JSON encoding.
- All paths pass existing credential/root checks before uploads begin. Open file
  descriptors recheck identity, size and modification time. Empty files are
  rejected with their zero-based artifact index, matching the Hub upload policy.
- All uploads finish before one message is published. Images form a titled
  gallery; other attachments retain their accompanying text. A failed upload
  returns `published: false`, its status when available, and artifact index.
  Completed but unpublished uploads use the Hub's existing retention/cleanup.
- A confirmed receipt contains one message ID and all file hashes. Calls replay
  through durable receipts. A per-user-turn batch promise and member promises
  prevent duplicate native single-file or batch sends during automatic repair.
  An overlapping, non-identical batch is rejected instead of silently splitting
  it. Changing file bytes or a fresh explicit user turn can send a new version.
- Uncertain publication retains uncertainty for the batch and every member;
  changing the tool call ID does not resend it in the same turn. Cancellation
  stops uploads but cannot retract a publish request already submitted.
- Every member is tracked by message ID, canonical path and hash. Stream/error
  recovery strips markers for every delivered version, and repair accounting
  counts distinct repaired versions rather than just the number of messages.

## Existing native threads

Codex persists dynamic tools at `thread/start`. `AppPlatformTools.forSession`
selects the known registered definition set, standing instructions, per-turn
procedures and callback authorization together. Earlier two-tool native threads
retain `app_send_file` and `app_capability`; they are not told to call the new
batch tool. Their context and registration file are not reset or rewritten.

The v1 definition digest is locked in a regression test:
`8ef5114a6d1726e315c98b2f864bcd5fda7518204122312ae1454e722942972b`.
Future schema changes must preserve every supported prior definition set.
Unknown/corrupt/missing records use the existing compatibility fallback.

## Evidence

`client/e2e/live-native-batch.spec.ts` runs an actual Codex CLI 0.160.0 /
gpt-6-astra / low worker. Its ordinary-language request does not name a tool or
legacy marker. The phone composer sends ten random-code PNGs, a random-code PDF
and text as one message. The model reads all codes correctly and autonomously
calls `app_send_batch` once, returning the ten original PNGs, original PDF and
its JSON report in one message. Native success and a durable receipt agree.

Chromium and WebKit each passed with separate desktop and phone browser contexts:
all twenty cached image hashes match, PDF/report downloads are checked, captions
are intact and viewport screenshots were inspected. The existing real native
single-file/restart/capability case also passed with the new tool version. All
temporary native sessions were archived through the native API, with
read-back confirmation. Ordinary collection skips the paid case before runtime
creation. Run explicitly from `client`:

```sh
TAROCUB_LIVE_NATIVE_BATCH=1 TMPDIR=/tmp/t npx playwright test e2e/live-native-batch.spec.ts
```

Add `--config playwright.webkit.config.ts` for WebKit. This verifies browser
clients and actual native engine tools, not physical phone containers or public
relay routes. Old v1 dispatch is covered by controlled protocol/integration
tests, not a claim that all historical production threads have been exercised.
No frontend assets changed, so the existing r4 client can render these blocks;
the Hub/Gateway must run the updated code. No deployed fleet was restarted.

Opus 5.5 xhigh's read-only review identified per-message receipt collapsing.
Two regression cases reproduced duplicate delivery after engine failure and a
false repair-failure message. The short-final variant did not reproduce the
failure but remains a regression. The fix records every file version; upload
failure indexing and empty-file preflight were also added. The fixed focused
run passed 642 tests, including the shared Lark and Telegram delivery suites.
The earlier legacy-definition test weakness was independently addressed by
locking its digest while the review was still running.

The bounded follow-up review accepted the compound-key fix. A negative regression
confirms that repairing only one of two rejected artifacts still reports failure.
The existing repair policy checks actual delivery and replacement quantity; it
does not certify that replacement file contents are semantically equivalent.
Full final gate: **227 files, 3,565 passed, 1 skipped**, followed by a successful
root build. An earlier full run hit three short wait deadlines in unchanged
AGY/Kimi cases; all three passed in isolation and in the complete rerun. No
production timeout was changed to hide those failures.

Initial Opus review and focused follow-up（本地材料：`evidence/native-batch-opus55-review-2026-10-03.md`）.

Full gate, review follow-up, source hashes and rendered/download evidence:
receipt（本地材料：`evidence/native-batch-2026-10-03.json`）.
