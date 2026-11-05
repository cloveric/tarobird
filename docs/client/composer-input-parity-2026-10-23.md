# Main and temporary side composer input parity

The side panel keeps its temporary, read-only native context. Switching chats
retains its draft; explicit Close clears it. Collaboration, steering, model
selection, prompt queues and persistent main-chat drafts are not added to it.

Both desktop composers use `ComposerAttachmentButton`, `AttachmentDraft`, the
composer paste handler and `ComposerVoiceRecording`. The side toolbar uses the
existing composer styles and provides attachment upload, desktop screenshot,
paste, drop, local preview, recording, send and stop.

Desktop main-composer placeholders (including the command hint and attachment
caption hint) now use a smaller interface size instead of inheriting the
reading/input size. Actual draft text retains its existing size and preference
behavior. The change is scoped to the regular desktop composer; native phones,
narrow phone layouts, compact panes and side composers retain their typography.
The earlier desktop height adjustment changed padding only, not the font size.
This presentation-only adjustment has no CLI or Host behavior impact.

Placeholder verification: all six existing composer size/busy journeys passed
in Chromium and WebKit (12 executions). Temporary measurements confirmed that
both desktop hints use the smaller size while actual input and phone-layout
text keep their previous sizes; command/caption screenshots were visually
inspected. Client translation/type/production and standalone Host builds passed.
Artifacts: `/Volumes/gdrive/taro-tmp/desktop-composer-placeholder-20261023`.
The temporary measurement logging is not part of the source change.

The side composer no longer displays persistent paragraphs about supported
attachment types, unavailable usage accounting or retaining/clearing the panel.
This removes the requested helper copy and its engine-specific variants; input
validation, accounting and session behavior are unchanged. Actionable errors,
disconnection status and the Escape shortcut remain. This copy-only adjustment
has no CLI or Host behavior impact.

The copy removal passed the three focused browser journeys in Chromium and
WebKit: text-only attachment validation, per-conversation panel retention and
palette/density rendering (six executions). Client translation/type/production
build and standalone Host build passed. The revised panel screenshot was
visually checked; this source checkpoint does not update installed Apps.

## Confirmed defects and fixes

- Native attachment menus were anchored to the entire side panel, putting the
  menu above the viewport. The shared button owns its relative positioning wrapper.
- Side Escape intercepted the attachment menu event. DesktopMenu now consumes
  its own Escape before the parent panel can close or move focus elsewhere.
- File paste was bound only to the textarea. Desktop preview return, removal,
  picker cancellation, screenshot cancellation and clicks on composer chrome
  now restore or retain editable focus; a container handler also accepts file
  paste from attachment/toolbar buttons. Portalled previews and other editable
  controls cannot add files to the underlying composer. Text paste keeps the
  browser's native editing and undo behavior.
- Focus/capture callbacks are scoped to their original chat and host. Phone
  preview return still focuses its opener, avoiding an unsolicited keyboard.

## Recording boundary

The side panel uses the same recorder and recording controls as the main chat.
The two microphones cannot start together. A finished encoder result may return
into its originating side draft after navigation. Closing/restarting the side
session invalidates that receipt; recording never auto-sends. Losing visibility
or connectivity finishes a recording into the draft. Leaving a chat without
finishing cancels the active recording, matching the main composer.
Escape during a side recording returns to the main composer instead of closing
an otherwise empty panel, so the recording is not discarded. A finished
recording is also kept when the side draft is already at its attachment limit;
the limit is reported and sending stays blocked until the draft fits, as in the
main composer, rather than silently dropping the only copy of the audio.

Audio capability is explicitly negotiated with `attachments=1&audio=1`; older
hosts retain their existing text and attachment behavior. The shared Host ASR
policy transcribes side audio before the native side model is invoked. It does
not create a main-chat message. The headless CLI uses this same path through
`side ask --file`; presentation changes require no separate CLI command.
For a longer recording, allow more time than the CLI's default 180 seconds:

```sh
tarobot side ask CONVERSATION --bot BOT --file meeting.m4a --timeout 600
```

Side transcripts stay beside the verified private attachment copies and are
released with the side session. They do not use the main transcript reuse cache.
The existing local/cloud ASR routing policy still applies.

## Validation boundary

Regression tests cover native-menu positioning, keyboard dismissal, real
Chromium clipboard PNG plus Command-V, WebKit event routing, repeated paste,
caption preservation, picker and screenshot cancellation, source chat isolation,
recording lifecycle and the actual Hub/Gateway side attachment path. Microphone
input and native screenshot IPC are fixtures; the browser MediaRecorder is real.
These checks do not establish Tauri OS menu, physical microphone, live ASR or
installed-App acceptance. A source checkpoint is not a signed release or local
Mac replacement.


The independent Opus review and this integration both exercised the backend
side/CLI paths. Host and client builds pass, including the client's type check.
The review also ran a broader Host `tsc --noEmit`; it reported existing errors
outside these changes, so this checkpoint does not claim a clean repository-wide
type check.
