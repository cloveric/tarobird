# Returning from unfinished desktop pairing

The desktop onboarding flow must not become a one-way route into remote
pairing. Before this change, the start link disappeared whenever an enrollment
was pending or an existing workspace supplied a Cancel action. Windows skipped
the welcome page altogether, and its instructions referred to a local-host
choice that the Windows companion does not implement.

## Behavior

- Mac and Windows pairing screens expose **返回开始**, including pending or
  expired enrollment restored after launch. An existing workspace retains its
  separate **返回会话** action.
- Returning changes the visible setup step only. It preserves the unfinished
  enrollment, its device key/code and the current form values. **继续连接已有主机**
  resumes that enrollment. No remote revocation or local data reset is needed.
- A late approval cannot automatically navigate away from the start screen.
  Returning to the enrollment resumes normal authenticated completion.
- On Mac, **将这台电脑设为主机** remains available after returning. A regression
  completes the local enrollment with a new device identity while retaining
  the unrelated pending remote identity.
- Windows now has a start page with explicit capability copy. The current
  Windows companion still does **not** run a local Hub/Bot. Its pairing guide
  points to a Mac host or an already deployed server; this navigation repair
  does not claim to implement Windows hosting.

## Verification

- Chromium: 43 focused native-transport, layout, pairing-recovery and host-
  workspace checks passed; the additional local-after-remote enrollment check
  passed separately.
- WebKit: 40 focused native-transport, layout and host-workspace checks passed;
  11 final onboarding/recovery checks passed after adding pairing-recovery to
  its collected suites. The additional local-after-remote check also passed.
- Root build and client translation/type/production build passed.
- Human-style browser operation used the actual components with isolated native
  responses: pending code → return → local-host choice → resume same code;
  Windows form → validation failure → return → reopen with retained address.
- No user pairing, keys, chats or Bot processes were changed. Native Windows
  execution and a new installer release are not part of this checkpoint.

These screenshots use synthetic fixture data:

Mac start screen after leaving pending pairing (historical image omitted from this clean snapshot)

Windows pairing with a visible return action (historical image omitted from this clean snapshot)
