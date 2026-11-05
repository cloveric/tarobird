# Host connection stability audit — 2026-10-16

## Incident evidence and limits

The reported symptom was that several Bots appeared disconnected from a phone
after the user returned to the Mac mini host. Read-only local evidence includes:

- At 06:42 China time, Codex recorded `spawn codex ENOENT`, and Claude recorded
  `spawn claude ENOENT`. Codex recorded the same error again at 06:47. These are
  process startup failures, not a model's failure to produce a reply. ENOENT can
  mean an executable or working directory is missing; the logs alone cannot
  distinguish every case or explain every reported disconnection.
- The installed 0.1.424 host does not contain `hostProcessEnvironment` from
  `e7a0f29`. That source fix supplies the common engine search paths to foreground,
  detached and managed hosts. The two affected workspaces exist at inspection
  time, which does not prove their state at the moment of failure.
- Later inspection found the host running, its relay connected and six Bots
  registered online. This is transport health, not a fresh successful model turn.
- Older relay warning lines lack timestamps. They cannot reliably be correlated
  with the incident and are not treated as proof of its cause.

The running host and active engine processes were not restarted for this audit.
No real user prompt, credentials, device keys or private network identity were
copied into the regression fixtures.

## Confirmed source repairs

All five engines use the same Gateway transport, as do App-managed and headless
CLI hosts. These repairs do not introduce a separate CLI implementation or alter
host identity, pairing, network membership or conversation/session routing.

1. **Bound connection setup.** A stalled WebSocket upgrade expires after 10s;
   an open socket that never becomes application-ready expires after 15s.
   Existing reconnect backoff remains in effect.
2. **Check real socket liveness.** Every 30s, a protocol ping checks the peer. If
   the next check still has no pong, the socket reconnects. Pongs bypass model
   execution, application database work and local metadata reads. This is not
   a model execution timeout and does not impose a 30/60-second task limit.
3. **Fence old connection callbacks.** Input waiting behind startup recovery
   cannot enter the Bot after stop, socket closure or replacement. A late RPC
   result from an old connection cannot be returned on the new connection.
4. **Preserve the startup recovery barrier.** If an old replay is still waiting
   for disk IO when a replacement connection becomes ready, the new connection
   can begin recovery. Once recovery has actually started, every later connection
   waits for the same attempt; it does not start another sweep.
5. **Timestamp operational warnings.** Host startup, relay, maintenance and
   worker connection warnings now include ISO timestamps. They still log static
   warning codes, not message bodies or secrets.
6. **Bound metadata reads and serialize the latest replay.** Configuration reads
   expire after 2s and retain the last known status; a late read cannot replace
   newer status. New publications wait for the current replay even if another
   reconnect replaced the one they initially awaited. A reused transport retains
   its completed boot state instead of permanently advertising startup work.
7. **Recover failed processes without permanent suspension.** After the initial
   fast retries, the Bot supervisor probes at 1, 2, 4, then at most 5 minutes,
   subject to the existing failure window. Failure history is not reset just
   because a worker briefly connected. The desktop requests native `resume`
   periodically and after foreground/network events; disabled and client-only
   installations are respected. Headless deployments retain their OS supervisor;
   `tarobot doctor` explains when one is absent.
   Automatic resume and explicit stop share the desktop mutex, resume rechecks
   intent after waiting and never writes the enabled flag. An installed OS
   supervisor owns its recovery; a UI timer cannot rearm it during service stop.
8. **Retire workers before lengthy cleanup.** Stop or parent IPC loss starts
   channel shutdown before waiting for cron/Bus cleanup. A worker cannot reconnect
   and accept new input during that cleanup. Startup/cleanup failures release
   owned resources and exit rather than remain alive with engine handles. Fatal
   exceptions/rejections and supervisor exit evidence are persisted with redaction;
   fatal observers do not swallow Node's normal failure behavior.
   A requested stop before startup completes exits cleanly without incrementing
   or clearing prior crash history; real cleanup failures still count as failures.
9. **Restore opted-in network listeners.** The running Hub rechecks LAN/Tailscale
   addresses every 30s. An absent additional endpoint no longer prevents local
   control, workers and relay from starting. Restored addresses bind without a
   Hub restart; leaf renewal keeps the existing CA, host identity and paired
   devices. Custom listeners are protected from replacement. Supervised resume
   does not race the running Hub by rewriting its network configuration.
   Legacy opt-in flags are persisted before replacing listeners, so a failed
   flag write or interrupted migration cannot silently disable the missing network.
10. **Honor mutex wait deadlines throughout the queue.** A same-process waiter
    previously bypassed the explicit timeout. It now times out without later
    running its callback or letting the next waiter bypass the active owner.
    Network maintenance yields to an ongoing native start/stop operation.

Reconnect reuses durable publication request IDs. It does not create new user
tasks or retry an uncertain model operation. Existing receipts and Hub
idempotency remain responsible for safe delivery.

## Independent Opus review and decisions

Reviews used the installed Claude CLI with `claude-opus-5-5[1m]` and
`--effort xhigh`; returned model metadata confirms Opus 5.5. The first review
examined source independently with read-only tools, the second reviewed the
transport patch, and the final review examined a frozen lifecycle/network patch
snapshot. No user conversations, secrets or live host state were supplied.

Adopted findings include optional-listener startup isolation, dynamic listener
recovery, desktop host recovery, slow worker retry, early retiring-worker fencing,
fatal evidence retention and bounded metadata reads. Fault tests also exposed
the replay/boot race and the in-process mutex timeout omission; both are repaired.

The final frozen-snapshot review identified three additional defects: resume
racing explicit stop, a requested startup stop being counted as a crash, and
legacy network opt-in being saved after its source listener had been removed.
All three were repaired and given focused regression tests. The startup-stop
test failed with exit 1 before the repair and passes with exit 0 afterwards,
preserving existing crash history. The final full gate was rerun after these
repairs; review of an earlier snapshot is not used as evidence for the final code.

We did not treat every hypothesis as an incident cause or make unrelated changes:

- A phone's “not connected” status refers to its host connection. An engine
  process startup error alone does not establish why the phone lost its Hub.
- No confirmed session/routing regression was found in the recent neutral-name
  migration. Persisted identities and old session identifiers are not rewritten.
- No crash-budget reset on every worker hello: rapid crash loops must remain
  visible. There is no automatic resubmission of uncertain model work.
- OS sleep, pre-login/FileVault availability and a full system-wide hang were
  not reproduced. Power settings and system services were not changed.
- Replacing an App bundle while its old host is executing remains an update
  boundary: use the existing drain and matching-runtime release procedure.
- The 15s ready deadline is transport recovery, not a model-task timeout. Extreme
  database saturation and real-device sleep/wake still require deployment checks.
- Retired TLS listener bookkeeping currently remains for the Hub process lifetime;
  rapid repeated address churn can slowly grow that list. It does not reopen
  retired endpoints or change ownership, and this minor cleanup is deferred.

## Verification

- Real local sockets simulate a silent upgrade, missing ready frame, lost pong,
  lost publication acknowledgement, slow metadata reads and long recovery.
- The stale-input and missing-ready tests fail against the pre-fix transport:
  reconnect admitted input twice; stop admitted input once; ready never retried.
- An additional fault test reproduced skipped startup recovery when old replay
  was blocked in a disk write. The repaired barrier starts exactly once.
- A real isolated Hub commits a publication while its acknowledgement is lost;
  replay preserves the same business message and does not run boot recovery twice.
- Worker tests hold cleanup open, verify admission stops immediately, and retain
  pending input for a replacement. Separate real Node processes prove handled
  startup failures and unhandled fatal errors actually exit and record evidence.
- Listener tests cover offline boot, address restoration, same-CA renewal,
  custom-endpoint ownership and a native operation holding the desktop mutex.
- Desktop recovery tests cover stop/resume concurrency, an installed supervisor,
  and a failed legacy network-flag write before configuration replacement.
- Disposable foreground and detached hosts find Codex, Claude, Antigravity, Kimi
  and DeepSeek from a minimal system PATH. These use fixture executables and do
  not call the user's model accounts. Host identity stays unchanged.
- Final standalone build and `scripts/pre-complete-hook.sh`: **294 files,
  3,899 tests passed; one pre-existing conditional skip**. The standalone graph
  contains 341 modules and no optional legacy transport SDK.
- `npm run test:legacy`: **57 files, 1,230 tests passed**. This is regression
  verification only; no optional adapter services or user data were changed.
- Client production build passed. Targeted `network-cache` and
  `desktop-host-name` browser checks: **31 Chromium + 31 WebKit passed**.
- Test artifacts and the three model review receipts are kept outside source
  under the task's external-disk audit directory. The first full-suite run found
  a stale offline-Tailscale expectation; it was changed to assert preserved
  listener configuration, then the entire gate was rerun successfully.

## Deployment boundary

These are source repairs. The already running installation is not updated by a
Git push or by local test success. Release/update must use matching App and CLI
artifacts and the existing drain procedure; active tasks must not be killed just
to replace the host. A new installed build and a real phone-to-host-to-model
round trip are still required to verify the user's complete acceptance surface.
