# Temporary side image delivery

The Codex side fork inherited `app_send_file` but TaroBot removed its App
receiver. A legitimate image request returned a tool error and the model told
the user to ask again in the main chat. Supported sides now receive their own
file receiver: sending an image there needs no separate approval and never
publishes a parent message.

## Flow and compatibility

The App and headless CLI request `delivery=1` together with `tools=1`. The Gateway
advertises `delivery: true` only when the native adapter supports it and an upload
channel is present. Only then does the client open with `delivery: true` and
`tools: "inherited"`. These options belong to that temporary handle.

The Core binds `app_send_file`, `app_send_batch` and file capability guidance to
the current side exchange. Codex routes the inherited native tool call using its
actual thread and turn IDs. Unrelated/late calls cannot borrow the receiver;
approval/question callbacks and parent task controls remain separate.

`gateway/side-delivery.ts` reuses main App preflight, file reads, checksums,
deduplication and batch validation. It uses the Bot's configured workspace and
normal permission mode. Credential filename checks and recipient override
rejection remain in place. A live test caught a missing workspace override in
the first implementation; the Gateway regression and native test now both use
a custom workspace outside the Bot's default workspace.

Uploads use the existing authenticated Hub attachment API. After all uploads
finish, the Core appends metadata to the side exchange and increments its
revision. Only then does the tool return `delivered: true`, with
`destination: "side"` and `temporary: true`. A receipt's `messageId` identifies
the temporary output, not a Hub message. Partial/aborted uploads do not create a
visible output or claim success. Receipt and publication caches are in memory.

Existing strict clients never receive the new fields without opting in. New
clients and Hubs drop the newest negotiation flag first for older versions;
existing tools, incoming attachments and audio remain usable. Unsupported
engines do not advertise delivery. Claude's native tool-free side and Kimi's
restricted fork are unchanged; this does not emulate a new session or silently
forward files to the main conversation.

## Data and presentation

An opted-in exchange may contain:

```json
{
  "deliveries": [{
    "id": "msg_temporary_output",
    "caption": "Optional gallery caption",
    "attachments": [{
      "type": "image",
      "attachmentId": "att_uploaded_image",
      "title": "overview.png",
      "caption": "Optional image caption"
    }]
  }]
}
```

File entries retain `type`, `attachmentId`, `name`, `size`, `mime` and an optional
caption. Captions are separate from filenames, avoiding duplicated captions and
the filename length limit. The side reuses `AttachmentImage`, its full-screen
viewer, and `AttachmentFile`; no separate approval or preview UI is introduced.

Switching conversations retains the image with its originating side. Closing,
restarting the side, or reloading the App clears its temporary transcript as
before. Neither side text nor delivery receipts enter the main message journal
or client transcript cache. Uploaded bytes use existing conversation-level
attachment permissions and orphan collection (normally after seven days), not
a new private-storage scheme. Closing does not delete user source files or
downloads. Handle capacity is 50 output artifacts and 256 MiB in total, reserved
before parallel uploads; existing individual-file and batch checks also apply.

`tarobot side ask ... --json` uses the same receiver and returns `deliveries`
alongside `text` and `closeConfirmed`. These are authenticated attachment IDs
and display metadata, not downloaded files or a persistent chat transcript.
Existing `side ask --file` input behavior is unchanged.

## Validation

- 136 focused tests across 13 suites: native routing, scope/turn closure,
  duplicate/content receipts, failed batches, cancellation, capacity, long
  captions, configured workspace, Hub compatibility, CLI outputs and existing
  file preflight, input attachment/audio and other native side engines.
- Chromium side suite: 27 cases. Two pre-existing stale expectations were
  updated: the fixed width ceiling and settings selections for hidden themes.
  Current selectable themes and the actual resize maximum are exercised.
- WebKit: incoming file navigation and outgoing image delivery, 2 cases.
- Real Codex CLI 0.164.0 with an isolated Hub: native `app_send_file` returns an
  image rendered in the side; no approval or new parent message, parent binding
  unchanged, and synthetic native parent cleaned up through `thread/delete`.
- Client translation/type/build and Host build passed. The repository-wide
  standalone TypeScript check still reports unrelated existing test-type errors;
  it is not reported as passing. No full repository test run was claimed.

Evidence is under `side-image-delivery-20261026` in the local test artifact
directory. The initial native failure is retained separately from the passing
final run. No production restart, release, installation or phone/device
acceptance was performed. Side entry availability remains desktop direct-chat
only; the CLI shares the Host feature.
