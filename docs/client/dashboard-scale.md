# Dashboard and file inventory under load

The dashboard remains read-only and returns every valid scheduled task. A large
store previously validated every record and calculated every next execution in
one synchronous pass. With 5,000 synthetic tasks and ten history entries each,
the measured event-loop gap was 787 ms, delaying other work in the same process.

The reader now reuses the native validator in batches of 32 and yields to I/O
between batches. An invalid later batch rejects the whole cron section instead
of returning a plausible partial list. Schedule calculations share one reference
time and a cache within that read only; different timezones, disabled tasks,
one-shot reminders and per-job history retain their original behavior. Refreshing
creates a new cache. No scheduler configuration or files are rewritten.

The client displays 25 tasks per page, searches names/content/IDs/conversations
across the entire result, filters enabled/disabled tasks, and supports direct
page selection. A refresh that reduces the result clamps the selected page.
Execution history mounts only when expanded. Date formatters are reused per
locale/timezone. Screenshots were inspected at desktop and phone sizes.

File inventory cancellation now reaches root enumeration, not only recursive
scanning. The regression test cancels after a real directory's first entry and
verifies that enumeration stops and the directory handle closes. Existing Hub
tests retain the previous inventory on cancellation and continue to protect
labels, configured roots and symlink boundaries.

## Local measurements (2026-10-03)

| Scenario | Result |
| --- | --- |
| Dashboard, 5,000 tasks / 50,000 history entries | 818 ms before; 232 ms after |
| Maximum event-loop gap during that read | 787 ms before; 11 ms after |
| Display task tab, Chromium desktop / phone | 40 / 42 ms |
| Display task tab, WebKit desktop / phone | 54 / 54 ms |
| Phone stop concurrent with large dashboard refresh | 79 ms Chromium; 66 ms WebKit |
| Inventory, 10,000 files in 2,000 units | 166 ms scan; 6 ms status read |
| Inventory cancellation / maximum event-loop gap | 16 / 11 ms; previous result preserved |

Reproduce with temporary synthetic data only:

```sh
TMPDIR=/tmp/t node --import tsx scripts/benchmark-bot-dashboard.mts
TMPDIR=/tmp/t node --import tsx scripts/benchmark-file-center.mts
TMPDIR=/tmp/t npx vitest run tests/bot-dashboard.test.ts tests/dashboard.test.ts tests/cron-store.test.ts tests/ui-file-inventory.test.ts tests/hub-file-center.test.ts
cd client
TMPDIR=/tmp/t npx playwright test e2e/dashboard.spec.ts e2e/file-center.spec.ts e2e/stop.spec.ts
TMPDIR=/tmp/t npx playwright test --config playwright.webkit.config.ts e2e/dashboard.spec.ts e2e/file-center.spec.ts e2e/stop.spec.ts
```

The browser cases use independent desktop/phone contexts, real authenticated
Hub/Gateway connections and a controlled engine AbortSignal. They verify complete
search/filter/page reachability, lazy history, refresh clamping, cross-device
chat after stopping, no duplicate engine calls and existing label/stop behavior.
Both browser engines passed all four focused cases.

These are isolated local measurements, not public VPS/Tailscale latency or native
Mac/phone performance acceptance. No paid model session, SDK-license acceptance,
production deployment or fleet restart is involved. The universal Mac development
DMG was rebuilt with this frontend and passed signature, read-only mount and
file-hash verification; see the updated bundle receipt（本地材料：`evidence/macos-dashboard-scale-2026-10-03.json`）.
Native execution and production distribution remain separate acceptance gates.

Machine-readable results: receipt（本地材料：`evidence/dashboard-scale-2026-10-03.json`）.
Rendered evidence: `design/dashboard-scale/2026-10-03/`.
