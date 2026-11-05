# Desktop notification permission recovery — 2026-10-28

The owner could not enable notifications on the installed Mac App. The page
reported only “无法完成系统通知授权，请稍后重试。” without a recovery path.

## Observed cause and local recovery

CUA reproduced the same error on `/Applications/TaroBot.app` 1.0.117. macOS
System Settings → Notifications → TaroBot showed Allow Notifications off.
The native log recorded an authorization request returning `didGrant: 0` and
`hasError: 1`; no permission dialog appeared. Code inspection showed that Enable
requested authorization again for both `prompt` and `denied`. The native error
was then translated into generic retry text. The exact NSError was not exposed
by the existing native bridge and was not inferred from its generic error.

For the owner's requested recovery, CUA turned on TaroBot's system notification
switch and then enabled message alerts in the App. Read-back showed the OS switch
on, App “消息提醒已开启” and “接收条件已就绪”. No restart or installation was needed.
These are actual native permission and preference observations, not a delivered
banner, audible-sound or physical-phone acceptance claim. Other notification
presentation choices and global system settings were left as found.

## Source correction

- An already denied desktop permission goes directly to settings guidance.
  Only an undecided permission is requested; granted permission proceeds to the
  existing authenticated preference write. Neither denial nor a native error
  can persist a falsely enabled preference.
- Native permission read/request errors carry a typed recovery marker.
  Notification settings show a nearby manual path and explicit system-settings
  action for those failures. Windows installation/version and unbundled-App
  errors retain their distinct guidance; Host save failures are not mislabeled
  as OS permission failures.
- macOS guidance names System Settings → Notifications → TaroBot; Windows names
  Settings → System → Notifications → TaroBot. After allowing notifications, the
  user returns and enables message alerts. Opening settings itself never grants
  consent or writes Host preferences. If opening fails, the manual path remains
  beside the action, including with an older shell missing the settings bridge.
- A later explicit enable checks permission again. Quiet-hour drafts remain
  intact, and stale recovery feedback clears on the next toggle attempt.

This reuses the fixed native settings destinations introduced by the notification
design change. No native implementation, Host protocol, schema, push delivery,
phone permission behavior or CLI command changes. CLI impact is not applicable:
this is recovery for the desktop App's OS permission, while the shared Host API
and headless push behavior remain unchanged.

## Verification

The new denied-permission regression first failed on the unwanted native
permission request before the correction. Chromium desktop lifecycle/design
checks passed **65 cases**. A further Host-save-failure regression passed,
explicitly checking that an already granted permission does not receive OS
recovery guidance when the authenticated save fails. **Nine WebKit cases** passed,
covering permission reads/requests, denial, recovery, retained drafts and delayed
authorization errors. The macOS recovery screenshot was inspected for readable
instructions and a visible action. Client translation checks, type checking and
production build passed; the Host/CLI build passed with 456 standalone modules.

Actual Opus 5.5 independently reviewed the exact product diff and found no
blockers. Its suggested inverse Host-save-failure coverage was added and passed.
Browser native bridges are simulated; the separate installed-Mac observations
above establish local recovery. No new native implementation was introduced.

Local evidence: `/Volumes/gdrive/taro-tmp/notification-permission-20261028/`,
including `native-recovery.json`, baseline/focused test logs and review notes.
The source correction requires a future App build; no release or installation
was performed in this task.
