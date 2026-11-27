# Native model quota visibility

The owner can inspect model quotas with `tarobird engines quota`.

The Settings › Model quotas page lists every Bot of the Host for the owner:
Claude Code, Codex and Antigravity with what their CLI reports, and Kimi,
DeepSeek and Pi as not supported yet. It was hidden on 2026-11-21 and shown
again on 2026-11-22. A client built with `VITE_TAROBIRD_ENGINE_QUOTA_UI=0` has
no entry for it, never mounts it and never reads the Host's quota list
(`client/src/engine-quota-feature.ts`); the Host API and CLI are unchanged.

This is separate from conversation token counts and estimated costs: those do
not establish an account's remaining allowance.

A conversation also shows two symbols of its own (issue 68), described under
"Symbols in a conversation" below: a battery for the Bot's quota and a ring for
the conversation's context. They use the same Host API as the page and CLI.

## Supported native sources

| Engine | Source and limits |
| --- | --- |
| Codex | Explicit read of native account and rate-limit APIs for a subscription identity. API-key/provider balances are not inferred. A cold reader uses a temporary CLI helper without creating a thread or sending a prompt. When the Host cannot verify the credential source from files (no `auth.json`, a keyring/auto store or an external helper), an explicit refresh still asks Codex's public `account/read`: "not signed in" becomes login required, and an account answer is shown for that one read only after the before/after identity check and only when the replies tie one stable user (`userId`), the workspace (`workspaceRouting.chatgptAccountId`, identical in both `account/read` replies) and the usage snapshot's own `accountId` to the same account, each a bounded whitespace-free token. Codex 0.170.0 documents none of these as guaranteed and does not scope `account/rateLimits/read` to the routed workspace in its protocol, so a missing usage account is never filled in from routing; such a reply, or one with only a type, plan or email, stays unverifiable and shows no values. A JSON-RPC -32603 reply with the CLI's exact unauthorized text from these quota calls (`workspace routing discovery unauthorized (401)`, `failed to fetch codex rate limits: … 401 Unauthorized`) is shown as login required, and the rate-limit call's `failed: 429 Too Many Requests` (status in its own position, not in a response body) as rate limited until a later read succeeds. A 429 during account discovery reaches `account/read` only as `workspace routing discovery failed`, with the status swallowed, so it stays a generic native error rather than a guess. Other native failures stay unavailable. Such a reading is never cached or reused. |
| Claude | On an explicit refresh, a running Claude Code process of the Bot is asked with the `get_usage` control request (no prompt, no model call). The answer is about the account that process uses, so it is shown wherever the login is stored (credential file or system keychain). An idle process is asked first; when every process is on a turn, the one that worked last is asked, because Claude Code answers this request during a turn and a Bot on a long turn has no other moment. Asking does not count as use of an idle process: its idle clock is put back, so a reading never keeps a process alive. The newest answer stays the Bot's reading after its process has ended: a Bot starts and ends processes with its turns, and its account seldom changes. It goes when a process answers again, when a process answers that the login has no windows, or when the login state the Host can see (credential file, settings, environment, the Bot's configuration) changes; the revision does not name processes. No Claude process is started for a reading, so a Bot that has not worked since the Host started has none. An answer that arrives after the login changed, or from a process started under an earlier login, is not shown. The process states its model when it starts a turn, and the Host uses that to decide whether a model's own pool counts (see below). The shared windows form one pool; a model with its own weekly allowance (`model_scoped`) is a pool of its own that names that model. A process on an API key answers that it has no windows and nothing is shown. A CLI that answers "Unsupported control request subtype" is asked once per process, and the earlier passive rule then applies (any other failure may be asked again): native quota events observed during an ordinary conversation count only for a credential source the Host can verify. |
| Antigravity | On an explicit refresh, one `agy -p /usage --output-format json` read after an `agy --version` check (1.1.11 or newer), accepted only with zero turns. Never started without local login state, because an unauthenticated `agy` opens a browser sign-in; after `agy` has answered that a sign-in is required, it is not started again for the same login state for thirty minutes. The print runtime and the ACP runtime use the same reader. Each usage group states the models it covers: the names listed in its description ("Models within this group: …"), or the group's own name for a separately metered model. |
| Kimi | The currently integrated ACP contract has no verified quota reader. |
| DeepSeek / Pi | No generic balance estimate is made across arbitrary providers. |

Each Bot is a separate displayed scope. Different Bots can share an account;
the App does not add their values together or infer sharing from a home path.
Native windows and credits retain their own units and reset times. An unknown
value is not zero or unlimited. Independent native restrictions can block use
even when a percentage is low.

## Official viewing guidance

When a card has no current reading (unsupported, unknown, login required,
unverifiable, stale or offline), the Settings page shows the
engine's official viewing method from the snapshot's `help` code.
`tarobird engines quota` keeps its JSON on standard output. In normal mode it also writes, on standard error, each such
Bot's status and reason in the App's exact Chinese/English wording, the refresh
command for an active reader (with its cooldown), and the official guidance.
With `--json` nothing is added to standard error. These lines are built only
from protocol codes, the Bot name and the scope/revision already in the JSON;
no native text or account identity is printed. The sources were
checked against the local CLIs' own help/changelog text and official docs:

| `help` | Guidance | Evidence |
| --- | --- | --- |
| `codex_usage` | Codex CLI `/usage` after a ChatGPT sign-in | Codex CLI 0.170.0 built-in help text |
| `claude_usage` | Claude Code `/usage`, or `claude.ai/settings/usage` | Claude Code 2.1.329 command list and limit message |
| `antigravity_usage` | Antigravity CLI `/usage`, `/quota`, `/credits`; a `GEMINI_API_KEY` has no account quota (Google AI Studio) | `agy changelog` (1.5.13) |
| `gemini_api_usage` | Google AI Studio for a `GEMINI_API_KEY` | `agy changelog` (1.5.13) |
| `kimi_usage` | Interactive Kimi Code CLI `/usage`; ACP `/usage` only reports session tokens | Kimi Code 2.7.0 command definitions |
| `deepseek_balance` | DeepSeek Platform balance for the official API; other providers' own consoles | DeepSeek API balance docs; DSH 0.2.2-rc.5 account plugin default origin |

The guidance never triggers a read, a login or a model request. Without a
running Claude Code process there is nothing to ask, and a passive observation
from a credential source the Host cannot verify (for example, a macOS Keychain
login) stays hidden.

## Read and refresh behavior

Opening the page and refreshing the directory reads worker caches only. A
per-card refresh is explicit, coalesced and limited to once per minute for the
same identity revision. Expired values
are marked stale; reaching a reset time does not manufacture a full allowance.
One shared rule (`quotaReadingExpired`) decides this for the Gateway, CLI output
and the Settings page: the reading's TTL, any window/credit expiry, or any reported reset
time, including an independent constraint's reset, ends the current reading.
The last restriction remains visible as a last reading until a new read.
After the list is read (on opening the page, or "Re-read list"), the page
starts one read by itself for each card that has no fresh reading and may be
read: an active reader, not offline, not waiting for a sign-in, not inside its
one-minute limit. Bots confirmed to share an account are one card and one
read. At most two reads run at a time, manual refreshes included. When a
Claude read times out, the card stays "Reading…" and the page looks at the
Host's cache every 2.5 s, for up to 90 s, for the answer that arrives late.
The page does not read again on a timer; an open conversation does (see "When
readings are taken"). No login or token refresh is started.

The owner-only HTTP entry points are `GET /api/engine-quotas` and
`GET /api/engine-quotas/:scopeId`. A single active refresh additionally requires
`refresh=1&revision=<last-read-revision>`. The Host and worker advertise
`engines.quota.v1`; old/offline workers return an explicit unavailable state.
A Host that also advertises `engines.quota.currency.v1` sends currency
balances (Kimi's top-up pack, DeepSeek's wallet) only to a caller that adds
`balances=currency` to the query, as the App and the CLI then do. Without it
a reply carries `credits` balances only, which is all a 1.6.0 client accepts;
a reading that consisted of currency balances alone is then "no data".

CLI examples:

```sh
tarobird engines quota --json
tarobird engines quota --bot BOT --json
tarobird engines quota --bot BOT --refresh --revision REV --json
```

Credential or worker changes discard cached observations. The caller receives
the new revision without old account values and must choose a new refresh.
Revocation, owner-role changes, deleted Bots and replaced worker connections are
checked across asynchronous reads. Internal execution workers are not listed.

Account IDs, emails, credentials, paths and private identity proofs never enter
the public DTO. Credential material is read with bounded buffers and retained
only in host-private identity hashing. Raw native failures are not forwarded.
Cancelling a quota read must not destroy a shared chatting worker; dedicated
helpers must actually exit before their reservation is released.

## Symbols in a conversation

In one conversation's own view the composer shows, left of the model control,
a ring for context and a battery for quota, each with a number. The drawn part
and the number are what is left. A symbol is there only while its value can be
read; there is no placeholder. A board pane (ADHD) shows neither and asks for
nothing. At a fifth left a symbol turns amber, at a twentieth red. Selecting
the symbols opens the details: context used against its window and where the
engine compacts by itself, and each quota window with its reset time.

On a phone nothing sits beside the composer and context is not shown or asked
for. The chat actions sheet has a "Quota" row with the number, opening the
same details. The header shows the battery alone, without a number, whenever
the quota can be read: under the computer's name when several computers are
paired, alone in that place otherwise. Its charge is what is left, amber and
red at the same marks as on the desktop; selecting it opens the details. When
the quota cannot be read there is no battery.

**Which quota counts.** A pool that names models counts only for a Bot on one
of them; a pool that names none counts for every Bot. Antigravity's groups all
name models, so one exhausted group does not alarm Bots on another. The number
is the tightest remaining window of the pools that count. Claude names a model
family ("Fable"): the Host counts its pool for a process whose stated model
contains that name and then no longer marks it as per-model, so it counts
whatever the Bot's configuration calls the model, including the default. Until
a process has stated its model, the App decides by the Bot's configured model.
Extra-usage windows are not counted. When the engine reports that ordinary use
is refused (blocked ordinary usage, a spending control, depleted credits, or
another native limit), nothing is left whatever the windows say, and the
details name the limit. An Antigravity group that names no models (an older
Host) is not counted. When the Bot's pool cannot be told, no battery is
shown: an Antigravity Bot on the engine's default model, or on a model no group
lists (in agy 1.5.14, "Orchestrator (Argon)"; "Orchestrator (Neon)" is listed
by its display name, which its id does not carry). A window past its reset
time is left out.

**When readings are taken.** A reading is taken when the
conversation opens, when its newest finished Bot message changes (a reply
has ended), about twenty seconds before the first window of the shown reading
resets, and right after that reset. While the conversation stays open and the
Host is online, the App also reads again in the background: five minutes
after a read that worked, and after one that did not, 1, 2, 5, 10 and then
every 15 minutes later. The engine itself is asked for quota again only once
the shown reading is five minutes old, or as little as one minute old when
the details are opened or a failed read is retried; in between, the App shows
what the Host holds. After "sign in first" the engine is left alone for
thirty minutes or until the login changes. The last reading of a Bot stays
shown when no newer one can be had: after thirty minutes it is marked old
(greyed, with its age) instead of being removed (the symbols' own limit, not
the 60 s rule above). It goes when its windows have reset (a window past its
reset is left out), and after seven days at the latest. An older answer never
replaces a newer one, and a Hub reply for a worker that did not answer changes
nothing. A reading is dropped when the Host answers that it cannot verify the
login (`scope_unverifiable`).

**Saved on the device.** The last reading per Host and Bot is also saved in
the App's local storage (`tarobird.quotaReadings.v1`), so the battery is there
when the App starts again. A saved reading is shown at once, in the
conversation and on the Settings page, marked old until the Bot's worker
answers with a reading of its own. An answer that carries another revision
(another login state) discards it, and so does one that reports a changed,
missing or unverifiable login or a login without quota; a Hub reply for an
absent worker leaves it shown as old. It holds percentages, balances, reset
times and pool names, no account identity, and is dropped once its windows
have reset, after seven days at the latest, or when the Host refuses this
user's quota read (401 or 403) or reports that the user is no longer the
owner.

**What a reading may start.** Nothing for context. For quota, only the readers
that already existed: Codex's temporary helper when its app-server is not
running (no thread, no prompt), and Antigravity's one-shot `/usage`. Claude is
asked only through a process that is already running.

**Context usage.** `GET /api/conversations/:id/context-usage?botId=` returns
`{ supported, usedTokens?, windowTokens?, autoCompactTokens? }` to a member of
that conversation; the Host and worker advertise
`conversations.context-usage.v1`. The worker reports the engine's own figures
for the session the conversation is bound to, as a passive reading: no session
is created or resumed, no engine process is started and nothing is reconciled:

| Engine | Source |
| --- | --- |
| Codex | The thread usage Codex pushes (`thread/tokenUsage/updated`); the compaction point is this adapter's own (80% of the window). Absent before the first turn of a worker process and after a compaction until the next turn. |
| Claude | `get_context_usage` on the conversation's running process, the figures of Claude's own `/context`; asked while the process is idle, and its last answer for the same session during a turn. Absent without a running process. |
| Antigravity | ACP runtime: the session's `usage_update`. Print runtime: none, because it reports token counts without a window. |
| Pi | `get_session_stats` of a process that is already running; absent otherwise. (`/context` itself still starts one.) |
| DeepSeek | The context pressure the adapter already holds for the session from the harness's events; the harness is not started or asked and no goal is reconciled. (`/context` itself still reads and reconciles.) |
| Kimi | None. |

## Validation boundary

Parser, cache, revision, cancellation, authenticated HTTP/Gateway and App UI
tests cover this contract. Real Codex and Claude executables were also checked
against isolated loopback providers with synthetic identities. This establishes
the native protocol and no-extra-prompt behavior, not subscription acceptance
against every real account or installed device. Unsupported sources remain
explicitly unsupported until that source has an implemented and verified path.

Checked on 2026-11-22 for the symbols:

- An isolated Claude Code 2.1.330 against a loopback model answered
  `get_context_usage` and `get_usage` while a turn was held open (within
  10 ms) and the turn then completed; it refused an unknown control subtype at
  once, and on an API key it answered `rate_limits_available: false`.
- The repository's Claude adapter and Gateway against a real Claude Code
  2.1.330 on a subscription, with a process started for the check and no
  prompt sent: every `get_usage` took 3.6 to 5.1 s (the CLI fetches the figures
  each time), which is why a read waits up to 7 s. Since 2026-11-23 the
  question is not dropped when that read gives up: it stays out for up to five
  minutes, one per process at a time, and an answer inside that time becomes the
  Bot's reading for the next read. On that day, with the machine heavily
  loaded, another Bot measured 69 to 90 s per `get_usage` and no reading was
  ever kept; how long it takes on an idle machine was not measured again. The
  2026-11-22 reply gave the
  shared weekly window and one `model_scoped` entry; a second refresh inside
  the cooldown was answered from the process's record. `get_context_usage`
  took 0.8 to 0.9 s with that user's full configuration.
- The repository's Antigravity reader against a real signed-in agy 1.5.14
  through the ACP adapter and the Gateway: three groups with their model
  lists, about five seconds for the two processes.
- Later the same day, in the installed App, a new Antigravity Bot on the ACP
  runtime answered "timeout" twice. The runtime was not the cause: six `agy -p
  /usage` reads in a row took 4.0 to 8.0 s, and the reader gave up after 7 s.
  An explicit refresh may now take 15 s inside the reader
  (`ENGINE_QUOTA_REFRESH_MS`), and stopping a process that did not finish may
  add up to 2 s more; the Gateway passes the limit on, the Hub waits 18 s
  (`ENGINE_QUOTA_HUB_REFRESH_MS`) and the Settings page 20 s, so the reader's
  own answer is the one shown.
  Codex and Claude Code keep their 7 s limits.

- In the evening the adapter was changed to ask a process on a turn when none
  is idle, and checked against the real Claude Code 2.1.330 on a subscription:
  `get_usage` asked 1.7 s into a streamed turn (model `haiku`) came back
  `ready` 3.8 s later, and the turn's reply was complete (700 numbered lines,
  in order).

Not checked: Codex context figures against a real session, and any of this in
an installed App on a device.
